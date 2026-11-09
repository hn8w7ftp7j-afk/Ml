import { randomUUID } from 'node:crypto';
import { soccerDate, shiftSoccerDate } from './contracts.js';
import { fetchSoccerSchedule } from './data.js';
import { analyzeSoccerGame } from './analysis-service.js';
import { ensureSoccerMinutesForwardProtocol } from './minutes-forward-validation.js';
import { hasSoccerMinutesForwardCapture } from './minutes-forward-store.js';
import { soccerJournalQuery, soccerJournalTransaction } from './journal.js';
import { orderSoccerCollectionGames } from './collection-order.js';

const schema = `CREATE TABLE IF NOT EXISTS sports_soccer_minutes_forward_collection_v1 (
  protocol_id text NOT NULL, league text NOT NULL CHECK(league IN ('epl','ucl')), game_id text NOT NULL,
  lease_token text, lease_until timestamptz, last_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_status text NOT NULL, last_reason text, PRIMARY KEY(protocol_id,league,game_id))`;
let ready;
async function ensure(query) {
  if (query !== soccerJournalQuery) return query(schema, []);
  return ready ||= soccerJournalTransaction([
    ['SELECT pg_advisory_xact_lock(221019,2347)', []], [schema, []],
  ]).catch(error => { ready = null; throw error; });
}
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Separate from score-calibration collection: an existing score forecast must
// not prevent the new, later-registered minutes protocol from collecting its
// own genuinely prospective source. Every capture uses the normal analysis.
export async function collectSoccerMinutesForward({ league, limit = 1, timeBudgetMs = 50000 } = {}, overrides = {}) {
  if (!['epl','ucl'].includes(league) || !Number.isSafeInteger(limit) || limit < 1 || limit > 2
    || !Number.isFinite(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 50000)
    throw Error('MINUTES_FORWARD_COLLECTION_SCOPE_INVALID');
  const deps = { now: Date.now, query: soccerJournalQuery, schedule: fetchSoccerSchedule, analyze: analyzeSoccerGame,
    freeze: ensureSoccerMinutesForwardProtocol, hasCapture: hasSoccerMinutesForwardCapture, ...overrides };
  const started = deps.now(), deadline = started + timeBudgetMs;
  const summary = { league, status: 'NO_PENDING_GAMES', capturedGames: 0, alreadyCapturedGames: 0,
    deferredGames: 0, failedGames: 0, scheduleFailures: 0, reasons: {}, persisted: true,
    budgetKind: 'SOFT_DEADLINE', hardDeadlineEnforced: false, accepted: false, formalEligible: false, executable: false };
  const reason = value => { summary.reasons[value] = (summary.reasons[value] || 0) + 1; };
  const protocol = await deps.freeze(league);
  if (protocol?.status !== 'DATABASE_FROZEN' || protocol.protocol?.league !== league || !hash(protocol.protocolId) || !hash(protocol.protocolHash)
    || !Number.isFinite(Date.parse(protocol.registeredAt)) || Date.parse(protocol.registeredAt) > deps.now())
    throw Error('MINUTES_FORWARD_COLLECTION_PROTOCOL_INVALID');
  await ensure(deps.query);
  const dates = [soccerDate(started), shiftSoccerDate(soccerDate(started), 1)];
  const boards = await Promise.allSettled(dates.map(date => deps.schedule(league, date)));
  const games = new Map();
  for (let i = 0; i < boards.length; i++) {
    const board = boards[i].status === 'fulfilled' ? boards[i].value : null;
    if (!board?.ok || !Array.isArray(board.games)) { summary.scheduleFailures++; reason('SCHEDULE_UNAVAILABLE'); continue; }
    for (const game of board.games) {
      const at = Date.parse(game.startTime);
      if (game.league === league && game.date === dates[i] && /^[1-9]\d{0,15}$/.test(game.sourceId)
        && game.id === `soccer:${league}:${game.sourceId}` && game.status === 'scheduled'
        && at > started && at <= started + 86400000) games.set(game.id, game);
    }
  }
  const attempts = games.size ? await deps.query(`SELECT game_id,last_attempt_at
    FROM sports_soccer_minutes_forward_collection_v1 WHERE protocol_id=$1 AND league=$2 AND game_id=ANY($3::text[])`,
    [protocol.protocolId, league, [...games.keys()]]) : [];
  const previous = new Map(attempts.map(row => [row.game_id, Date.parse(row.last_attempt_at)]));
  const ordered = orderSoccerCollectionGames(games.values(), previous);
  let attempted = 0;
  for (const game of ordered) {
    if (await deps.hasCapture(league, game.id)) { summary.alreadyCapturedGames++; continue; }
    if (attempted >= limit || deps.now() >= deadline) { summary.deferredGames++; continue; }
    if (Date.parse(game.startTime) <= deps.now()) { reason('KICKOFF_REACHED'); continue; }
    const token = randomUUID();
    const rows = await deps.query(`INSERT INTO sports_soccer_minutes_forward_collection_v1
      (protocol_id,league,game_id,lease_token,lease_until,last_status) VALUES($1,$2,$3,$4,clock_timestamp()+interval '90 seconds','RUNNING')
      ON CONFLICT(protocol_id,league,game_id) DO UPDATE SET lease_token=$4,lease_until=clock_timestamp()+interval '90 seconds',
        last_attempt_at=clock_timestamp(),last_status='RUNNING',last_reason=NULL
      WHERE sports_soccer_minutes_forward_collection_v1.lease_until<=clock_timestamp() RETURNING game_id`,
      [protocol.protocolId, league, game.id, token]);
    if (!rows.length) { summary.deferredGames++; continue; }
    attempted++;
    let captured = false, code = 'ANALYSIS_OR_CAPTURE_UNAVAILABLE';
    try {
      const analyzed = await deps.analyze({ league, date: game.date, eventId: game.sourceId });
      const payload = analyzed?.payload, value = payload?.minutesForwardCapture, receipt = value?.receipt;
      captured = analyzed?.status === 200 && payload?.persisted === true && payload.journalPersisted === true
        && payload.gameId === game.id && payload.league === league && payload.date === game.date
        && payload.formalScoringEnabled === false && payload.executable === false
        && value?.status === 'PREDICTION_SAVED' && value.persisted === true
        && receipt?.status === 'DATABASE_PREGAME_CAPTURED' && receipt.protocolId === protocol.protocolId
        && receipt.protocolHash === protocol.protocolHash && hash(receipt.analysisRevision)
        && receipt.league === league && receipt.gameId === game.id && hash(receipt.captureId)
        && Date.parse(receipt.capturedAt) < Date.parse(game.startTime) && Date.parse(receipt.capturedAt) <= deps.now();
      if (!captured && /^MINUTES_[A-Z0-9_]+$/.test(value?.reason || '')) code = value.reason;
    } catch { /* A source failure leaves the fair queue retryable. */ }
    const acknowledged = await deps.query(`UPDATE sports_soccer_minutes_forward_collection_v1
      SET lease_token=NULL,lease_until=clock_timestamp()+interval '5 minutes',last_status=$5,last_reason=$6
      WHERE protocol_id=$1 AND league=$2 AND game_id=$3 AND lease_token=$4 AND lease_until>clock_timestamp()
      RETURNING game_id`, [protocol.protocolId, league, game.id, token, captured ? 'CAPTURED' : 'RETRYABLE', captured ? null : code]);
    if (captured && acknowledged.length === 1) summary.capturedGames++;
    else { summary.failedGames++; reason(acknowledged.length ? code : 'COLLECTION_LEASE_EXPIRED'); }
  }
  summary.status = summary.failedGames || summary.scheduleFailures ? 'PARTIAL' : summary.deferredGames ? 'MORE_PENDING'
    : summary.capturedGames ? 'CAPTURED' : 'NO_PENDING_GAMES';
  return summary;
}

