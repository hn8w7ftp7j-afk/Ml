import { randomUUID } from 'node:crypto';
import { soccerDate, shiftSoccerDate, soccerLeague } from './contracts.js';
import { fetchSoccerSchedule } from './data.js';
import { analyzeSoccerGame } from './analysis-service.js';
import { freezeSoccerCalibrationShadowCandidate } from './calibration-shadow-store.js';
import { soccerCalibrationShadowArtifacts } from './calibration-frozen.js';
import { soccerJournalQuery, soccerJournalTransaction } from './journal.js';

export const SOCCER_CALIBRATION_COLLECTION_SCHEMA = `CREATE TABLE IF NOT EXISTS sports_soccer_calibration_collection_v1 (
  freeze_id text NOT NULL, league text NOT NULL CHECK(league IN ('epl','ucl')), game_id text NOT NULL,
  lease_token text, lease_until timestamptz, last_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_status text NOT NULL, last_reason text, PRIMARY KEY(freeze_id,league,game_id))`;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
let schemaReady;
async function ensureCollection(query) {
  if (query !== soccerJournalQuery) return query(SOCCER_CALIBRATION_COLLECTION_SCHEMA, []);
  return schemaReady ||= soccerJournalTransaction([
    ['SELECT pg_advisory_xact_lock(221019,2329)', []], [SOCCER_CALIBRATION_COLLECTION_SCHEMA, []],
  ]).catch(error => { schemaReady = null; throw error; });
}

// This collector fills the prospective cohort even when nobody opens the site
// and no Reader price arrives. It uses the existing analysis/archive pipeline;
// no reconstructed historical forecast, price or acceptance flag is supplied.
export async function collectSoccerCalibrationPredictions({ league, limit = 2, timeBudgetMs = 50000 } = {}, overrides = {}) {
  if (!soccerLeague(league) || soccerLeague(league).id !== league || !Number.isInteger(limit) || limit < 1 || limit > 4
    || !Number.isFinite(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 50000) throw Error('CALIBRATION_COLLECTION_SCOPE_INVALID');
  const deps = { now: Date.now, query: soccerJournalQuery, schedule: fetchSoccerSchedule, analyze: analyzeSoccerGame,
    freeze: freezeSoccerCalibrationShadowCandidate, artifacts: soccerCalibrationShadowArtifacts, ...overrides };
  const started = deps.now(), deadline = started + timeBudgetMs, today = soccerDate(started);
  const summary = { league, status: 'NO_PENDING_GAMES', checkedGames: 0, capturedGames: 0, alreadyCapturedGames: 0,
    deferredGames: 0, failedGames: 0, scheduleFailures: 0, reasons: {}, persisted: true, formalEligible: false, executable: false };
  const reason = code => { summary.reasons[code] = (summary.reasons[code] || 0) + 1; };
  const freeze = await deps.freeze(league), artifacts = deps.artifacts(league);
  if (freeze?.status !== 'DATABASE_FROZEN' || freeze.league !== league || !hash(freeze.freezeId)
    || freeze.candidateHash !== artifacts.candidate.contentHash || freeze.planHash !== artifacts.plan.contentHash)
    throw Error('CALIBRATION_COLLECTION_FREEZE_INVALID');
  await ensureCollection(deps.query);
  const dates = [today, shiftSoccerDate(today, 1)];
  const boards = await Promise.allSettled(dates.map(date => deps.schedule(league, date)));
  const games = new Map();
  for (let i = 0; i < boards.length; i++) {
    const board = boards[i].status === 'fulfilled' ? boards[i].value : null;
    if (!board?.ok || !Array.isArray(board.games)) { summary.scheduleFailures++; reason('CALIBRATION_COLLECTION_SCHEDULE_UNAVAILABLE'); continue; }
    for (const game of board.games) {
      const kickoff = Date.parse(game.startTime);
      if (game.league !== league || game.date !== dates[i] || game.id !== `soccer:${league}:${game.sourceId}`
        || !/^[1-9]\d{0,15}$/.test(game.sourceId) || game.status !== 'scheduled' || !(kickoff > started)
        || kickoff > started + 86400000 || kickoff <= Date.parse(artifacts.plan.beginsStrictlyAfter)
        || artifacts.plan.usedGamesExcluded.includes(`${league}:${game.sourceId}`)) continue;
      if (!['home','away'].every(side => game[side]?.id === `soccer:${league}:team:${game[side]?.sourceId}`
        && /^[1-9]\d{0,15}$/.test(game[side]?.sourceId)) || game.home.id === game.away.id) continue;
      games.set(game.id, game);
    }
  }
  const saved = await deps.query(`SELECT game_id FROM sports_soccer_calibration_captures_v1
    WHERE freeze_id=$1 AND league=$2 AND game_id=ANY($3::text[])`, [freeze.freezeId, league, [...games.keys()]]);
  const captured = new Set(saved.map(row => row.game_id));
  summary.alreadyCapturedGames = captured.size;
  const attempts = await deps.query(`SELECT game_id,last_attempt_at FROM sports_soccer_calibration_collection_v1
    WHERE freeze_id=$1 AND league=$2 AND game_id=ANY($3::text[])`, [freeze.freezeId, league, [...games.keys()]]);
  const lastAttempt = new Map(attempts.map(row => [row.game_id, new Date(row.last_attempt_at).getTime()]));
  // Untouched games precede retries, so one broken source cannot consume every
  // batch before the rest of the same kickoff group has been captured.
  const pending = [...games.values()].filter(game => !captured.has(game.id)).sort((a,b) =>
    Number(lastAttempt.has(a.id)) - Number(lastAttempt.has(b.id))
    || Date.parse(a.startTime) - Date.parse(b.startTime)
    || (lastAttempt.get(a.id) || 0) - (lastAttempt.get(b.id) || 0) || a.id.localeCompare(b.id));
  for (const game of pending) {
    if (deps.now() >= Date.parse(game.startTime)) { reason('CALIBRATION_COLLECTION_GAME_STARTED'); continue; }
    if (deps.now() >= deadline || summary.checkedGames >= limit) { summary.deferredGames++; continue; }
    const token = randomUUID();
    const claim = await deps.query(`INSERT INTO sports_soccer_calibration_collection_v1
      (freeze_id,league,game_id,lease_token,lease_until,last_status)
      SELECT $1,$2,$3,$4,clock_timestamp()+interval '120 seconds','RUNNING'
      WHERE NOT EXISTS (SELECT 1 FROM sports_soccer_calibration_captures_v1 WHERE freeze_id=$1 AND league=$2 AND game_id=$3)
      ON CONFLICT(freeze_id,league,game_id) DO UPDATE SET lease_token=EXCLUDED.lease_token,
        lease_until=EXCLUDED.lease_until,last_attempt_at=clock_timestamp(),last_status='RUNNING',last_reason=NULL
      WHERE sports_soccer_calibration_collection_v1.lease_until<=clock_timestamp()
      RETURNING game_id`, [freeze.freezeId, league, game.id, token]);
    if (!claim.length) { summary.deferredGames++; continue; }
    summary.checkedGames++;
    let capturedOk = false, failure = 'CALIBRATION_COLLECTION_CAPTURE_UNCONFIRMED';
    try {
      const result = await deps.analyze({ league, date: game.date, eventId: game.sourceId });
      const payload = result?.payload, capture = payload?.calibrationShadowCapture, receipt = capture?.capture;
      capturedOk = result?.status === 200 && payload?.persisted === true && payload.journalPersisted === true
        && payload.gameId === game.id && payload.league === league && payload.date === game.date
        && payload.executable === false && payload.formalScoringEnabled === false
        && capture?.status === 'SHADOW_PREDICTION_SAVED' && capture.persisted === true
        && capture.fullTimeCaptured === true && capture.halfTimeCaptured === true
        && receipt?.status === 'DATABASE_PREGAME_CAPTURED' && receipt.freezeId === freeze.freezeId
        && receipt.league === league && receipt.gameId === game.id && hash(receipt.captureId)
        && hash(receipt.sourceReceiptId) && hash(receipt.predictionHash) && hash(receipt.analysisRevision)
        && Date.parse(receipt.capturedAt) < Date.parse(game.startTime) && Date.parse(receipt.capturedAt) <= deps.now();
      if (!capturedOk && /^CALIBRATION_[A-Z0-9_]+$/.test(capture?.reason || '')) failure = capture.reason;
    } catch { failure = 'CALIBRATION_COLLECTION_ANALYSIS_UNAVAILABLE'; }
    // Token fencing prevents an expired worker from acknowledging a newer run.
    const acknowledged = await deps.query(`UPDATE sports_soccer_calibration_collection_v1 SET
      lease_token=NULL,lease_until=clock_timestamp()+interval '5 minutes',last_status=$5,last_reason=$6
      WHERE freeze_id=$1 AND league=$2 AND game_id=$3 AND lease_token=$4 AND lease_until>clock_timestamp()
      RETURNING game_id`, [freeze.freezeId, league, game.id, token, capturedOk ? 'CAPTURED' : 'RETRYABLE', capturedOk ? null : failure]);
    if (capturedOk && acknowledged.length === 1) summary.capturedGames++;
    else { summary.failedGames++; reason(acknowledged.length ? failure : 'CALIBRATION_COLLECTION_LEASE_EXPIRED'); }
  }
  summary.status = summary.failedGames || summary.scheduleFailures ? 'PARTIAL' : summary.deferredGames ? 'MORE_PENDING'
    : summary.capturedGames ? 'CAPTURED' : 'NO_PENDING_GAMES';
  return summary;
}
