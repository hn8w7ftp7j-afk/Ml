import { ensureSoccerJournal, soccerJournalQuery, soccerJournalTransaction } from './journal.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { soccerAnalysisHash } from './analysis.js';
import { normalizeSoccerPrematch } from './prematch.js';
import { loadSoccerSourceDocument } from './source-document-store.js';
import { soccerCalibrationHash, predictSoccerCalibrationResearch } from './calibration-research.js';
import { soccerCalibrationShadowArtifacts } from './calibration-frozen.js';

export const SOCCER_CALIBRATION_SHADOW_VERSION = 'SOCCER-CALIBRATION-SHADOW-v1';
const restrictions = { accepted: false, formalEligible: false, promotionEligible: false, baselineChanged: false,
  executable: false, W: null, R: null, S: null, empiricalErrorMargin: null };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const iso = value => new Date(value).toISOString();
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const storageHash = value => soccerAnalysisHash(canonical(value));
const gameScope = game => ({ id: game?.id, sourceId: game?.sourceId, league: game?.league, date: game?.date,
  startTime: game?.startTime, status: game?.status, neutralSite: game?.neutralSite,
  homeId: game?.home?.id, homeSourceId: game?.home?.sourceId, awayId: game?.away?.id, awaySourceId: game?.away?.sourceId });
const unavailable = reason => ({ version: SOCCER_CALIBRATION_SHADOW_VERSION, status: 'NOT_CAPTURED', persisted: false, reason, ...restrictions });
// Compare database timestamp columns before the JS driver reduces their
// precision to milliseconds. A rounded receipt must never backdate a source.
const captureSelection = `SELECT c.*,(s.receipt_id IS NOT NULL AND s.league=c.league AND s.game_id=c.game_id
  AND s.content_hash=c.source_content_hash AND s.recorded_at=c.source_recorded_at
  AND s.recorded_at<=c.original_analysis_cutoff AND s.recorded_at<=c.captured_at) AS source_time_bound
  FROM sports_soccer_calibration_captures_v1 c
  LEFT JOIN sports_soccer_source_document_observations_v1 s ON s.receipt_id=c.source_receipt_id`;
const schema = [
  `CREATE TABLE IF NOT EXISTS sports_soccer_calibration_freezes_v1 (
    freeze_id TEXT PRIMARY KEY CHECK (freeze_id ~ '^[a-f0-9]{64}$'),
    league TEXT NOT NULL CHECK (league IN ('epl','ucl')), candidate_hash TEXT NOT NULL, plan_hash TEXT NOT NULL,
    model_hash TEXT NOT NULL, half_time_model_hash TEXT NOT NULL, registry_hash TEXT NOT NULL,
    artifact_hash TEXT NOT NULL, artifacts JSONB NOT NULL,
    frozen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE(league,candidate_hash,plan_hash))`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_calibration_captures_v1 (
    capture_id TEXT PRIMARY KEY CHECK (capture_id ~ '^[a-f0-9]{64}$'), capture_sequence BIGSERIAL UNIQUE NOT NULL,
    freeze_id TEXT NOT NULL REFERENCES sports_soccer_calibration_freezes_v1(freeze_id),
    league TEXT NOT NULL CHECK (league IN ('epl','ucl')), game_id TEXT NOT NULL, board_date DATE NOT NULL,
    analysis_revision TEXT NOT NULL, original_analysis_cutoff TIMESTAMPTZ NOT NULL,
    source_receipt_id TEXT NOT NULL REFERENCES sports_soccer_source_document_observations_v1(receipt_id),
    source_content_hash TEXT NOT NULL, source_recorded_at TIMESTAMPTZ NOT NULL, kickoff_at TIMESTAMPTZ NOT NULL,
    prediction_body JSONB NOT NULL, prediction_body_hash TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(league,game_id,analysis_revision) REFERENCES sports_soccer_analysis_v1(league,game_id,analysis_hash),
    UNIQUE(freeze_id,league,game_id))`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_calibration_capture_scope_v1
    ON sports_soccer_calibration_captures_v1(league,board_date,captured_at)`,
  ...['freezes', 'captures'].map(name => `CREATE OR REPLACE TRIGGER sports_soccer_calibration_immutable_v1
    BEFORE UPDATE OR DELETE ON sports_soccer_calibration_${name}_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`),
];
let ready;
export async function ensureSoccerCalibrationShadowStore() {
  return ready ||= (async () => {
    await ensureSoccerJournal();
    // The source archive owns its referenced receipt table. Initializing it
    // does not claim that any source document has been captured.
    const { ensureSoccerSourceDocumentStore } = await import('./source-document-store.js');
    await ensureSoccerSourceDocumentStore();
    await soccerJournalTransaction([['SELECT pg_advisory_xact_lock(221019,2311)'], ...schema.map(sql => [sql])]);
  })().catch(error => { ready = null; throw error; });
}

function fixed(leagueValue) {
  const league = soccerLeague(leagueValue)?.id;
  if (!league) throw Error('CALIBRATION_SHADOW_LEAGUE_INVALID');
  const artifacts = soccerCalibrationShadowArtifacts(league);
  const { candidate, plan, model, halfTimeModel, registryHash } = artifacts;
  // A package update for the other league must not replace this league's
  // already frozen plan. Global registry hash is provenance, not its identity.
  const body = { version: SOCCER_CALIBRATION_SHADOW_VERSION, league, candidate, plan, model, halfTimeModel };
  const artifactHash = soccerCalibrationHash(body);
  return { league, candidate, plan, model, halfTimeModel, registryHash, body, artifactHash,
    freezeId: soccerCalibrationHash([SOCCER_CALIBRATION_SHADOW_VERSION, league, candidate.contentHash, plan.contentHash, artifactHash]) };
}
function freezeReceipt(row, artifacts) {
  const frozenAt = iso(row.frozen_at);
  if (row.freeze_id !== artifacts.freezeId || row.league !== artifacts.league
    || row.candidate_hash !== artifacts.candidate.contentHash || row.plan_hash !== artifacts.plan.contentHash
    || row.model_hash !== artifacts.candidate.modelHash || row.half_time_model_hash !== artifacts.candidate.halfTimeModelHash
    || !sha(row.registry_hash) || row.artifact_hash !== artifacts.artifactHash
    || soccerCalibrationHash(row.artifacts) !== artifacts.artifactHash
    || instant(frozenAt) < instant(artifacts.candidate.createdAt)) throw Error('CALIBRATION_SHADOW_FREEZE_READBACK_FAILED');
  return { version: SOCCER_CALIBRATION_SHADOW_VERSION, status: 'DATABASE_FROZEN', freezeId: row.freeze_id,
    league: row.league, frozenAt, candidateHash: row.candidate_hash, planHash: row.plan_hash,
    modelHash: row.model_hash, halfTimeModelHash: row.half_time_model_hash, registryHash: row.registry_hash,
    artifactHash: row.artifact_hash, ...restrictions };
}
async function readFreeze(artifacts) {
  const rows = await soccerJournalQuery('SELECT * FROM sports_soccer_calibration_freezes_v1 WHERE freeze_id=$1', [artifacts.freezeId]);
  if (rows.length > 1) throw Error('CALIBRATION_SHADOW_FREEZE_READBACK_FAILED');
  return rows.length === 1 ? freezeReceipt(rows[0], artifacts) : null;
}
export async function freezeSoccerCalibrationShadowCandidate(leagueValue) {
  const artifacts = fixed(leagueValue);
  await ensureSoccerCalibrationShadowStore();
  await soccerJournalQuery(`INSERT INTO sports_soccer_calibration_freezes_v1
    (freeze_id,league,candidate_hash,plan_hash,model_hash,half_time_model_hash,registry_hash,artifact_hash,artifacts)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb WHERE clock_timestamp()>=$10::timestamptz ON CONFLICT DO NOTHING`,
  [artifacts.freezeId, artifacts.league, artifacts.candidate.contentHash, artifacts.plan.contentHash,
    artifacts.candidate.modelHash, artifacts.candidate.halfTimeModelHash, artifacts.registryHash, artifacts.artifactHash,
    JSON.stringify(artifacts.body), artifacts.candidate.createdAt]);
  const receipt = await readFreeze(artifacts);
  if (!receipt) throw Error('CALIBRATION_SHADOW_FREEZE_NOT_AVAILABLE');
  return receipt;
}

function originalScope(original, revision, league, gameId, now) {
  const game = original?.evidence?.game, cutoff = instant(original?.analysisCutoff), kickoff = instant(game?.startTime);
  if (storageHash(original) !== revision || original.league !== league || original.gameId !== gameId
    || original.evidence?.ok !== true || original.evidence.phase !== 'PREMATCH_OBSERVATION'
    || original.status !== 'RESEARCH_ONLY' || original.analysisStatus !== 'COMPLETED'
    || game?.id !== gameId || game.id !== `soccer:${league}:${game.sourceId}` || game.league !== league || game.status !== 'scheduled' || !validSoccerDate(original.date)
    || game.date !== original.date || !['home', 'away'].every(side => /^\d{1,16}$/.test(game[side]?.sourceId || '')
      && game[side].id === `soccer:${league}:team:${game[side].sourceId}`) || game.home.id === game.away.id
    || typeof game.neutralSite !== 'boolean' || !Number.isFinite(cutoff) || !Number.isFinite(kickoff)
    || cutoff > now || cutoff >= kickoff || kickoff <= now
    || !(instant(original.evidence.source?.fetchedAt) <= cutoff)
    || now - instant(original.evidence.source?.fetchedAt) >= 180000) throw Error('CALIBRATION_SHADOW_ORIGINAL_ANALYSIS_INVALID');
  return { game, cutoff, kickoff };
}
async function verifyOriginalSource(original, now) {
  const evidence = original.evidence, source = evidence.source, receiptId = evidence.sourceDocumentArchive?.receiptId;
  if (!sha(receiptId)) throw Error('CALIBRATION_SHADOW_SOURCE_RECEIPT_MISSING');
  const retained = await loadSoccerSourceDocument(receiptId);
  const receipt = retained.receipt;
  if (receipt.prematchReceipt !== true || receipt.gameId !== evidence.game.id || receipt.league !== evidence.game.league
    || receipt.sourceUrl !== source.url || receipt.contentHash !== source.contentHash || receipt.fetchedAt !== source.fetchedAt
    || instant(receipt.recordedAt) > instant(original.analysisCutoff) || instant(receipt.recordedAt) > now)
    throw Error('CALIBRATION_SHADOW_SOURCE_RECEIPT_INVALID');
  const rebuilt = normalizeSoccerPrematch(retained.document, evidence.game, evidence.rawSource, now);
  if (!rebuilt.ok || soccerCalibrationHash(gameScope(rebuilt.game)) !== soccerCalibrationHash(gameScope(evidence.game))
    || ['source', 'sourceEvidence', 'rawSource', 'teams', 'referee'].some(field =>
    soccerCalibrationHash(rebuilt[field]) !== soccerCalibrationHash(evidence[field]))) throw Error('CALIBRATION_SHADOW_SOURCE_RECOMPUTE_FAILED');
  return receipt;
}
function captureFromRow(row, artifacts, freeze) {
  const capturedAt = iso(row.captured_at), body = row.prediction_body, game = body?.game;
  if (row.source_time_bound !== true || row.freeze_id !== artifacts.freezeId || row.league !== artifacts.league || body.candidateHash !== artifacts.candidate.contentHash
    || row.game_id !== game?.id || row.board_date !== game?.date && iso(row.board_date).slice(0, 10) !== game?.date
    || row.capture_id !== soccerCalibrationHash([SOCCER_CALIBRATION_SHADOW_VERSION, artifacts.freezeId, game?.id])
    || row.prediction_body_hash !== soccerCalibrationHash(body) || !sha(row.analysis_revision)
    || instant(capturedAt) <= instant(freeze.frozenAt) || instant(capturedAt) <= instant(artifacts.plan.beginsStrictlyAfter)
    || instant(capturedAt) >= instant(game.startTime) || iso(row.kickoff_at) !== game.startTime
    || instant(iso(row.original_analysis_cutoff)) > instant(capturedAt)
    || instant(iso(row.source_recorded_at)) > instant(iso(row.original_analysis_cutoff))) throw Error('CALIBRATION_SHADOW_CAPTURE_READBACK_FAILED');
  const predicted = predictSoccerCalibrationResearch({ ...artifacts, game, now: instant(capturedAt) });
  if (soccerCalibrationHash(predicted.fullTime) !== soccerCalibrationHash(body.fullTime)
    || soccerCalibrationHash(predicted.halfTime) !== soccerCalibrationHash(body.halfTime)) throw Error('CALIBRATION_SHADOW_PREDICTION_RECOMPUTE_FAILED');
  const prediction = { ...body, capturedAt };
  const receipt = { version: SOCCER_CALIBRATION_SHADOW_VERSION, status: 'DATABASE_PREGAME_CAPTURED', captureId: row.capture_id,
    captureSequence: String(row.capture_sequence), freezeId: row.freeze_id, league: row.league, gameId: row.game_id, analysisRevision: row.analysis_revision,
    originalAnalysisCutoff: iso(row.original_analysis_cutoff), sourceReceiptId: row.source_receipt_id,
    sourceContentHash: row.source_content_hash, sourceRecordedAt: iso(row.source_recorded_at), capturedAt,
    predictionHash: soccerCalibrationHash(prediction), ...restrictions };
  return { prediction, captureReceipt: receipt };
}

/** Scope/revision only: all source data and predictions come from immutable
 * server records and the fixed server artifact registry, never request flags. */
export async function captureSoccerCalibrationShadow(snapshot, revision) {
  if (!['epl', 'ucl'].includes(snapshot?.league) || !new RegExp(`^soccer:${snapshot.league}:\\d{1,16}$`).test(snapshot.gameId || '')
    || !sha(revision)) return unavailable('CALIBRATION_SHADOW_CAPTURE_SCOPE_INVALID');
  try {
    const artifacts = fixed(snapshot.league), freeze = await freezeSoccerCalibrationShadowCandidate(snapshot.league);
    const rows = await soccerJournalQuery(`SELECT payload,clock_timestamp() AS database_now FROM sports_soccer_analysis_v1
      WHERE league=$1 AND game_id=$2 AND analysis_hash=$3`, [snapshot.league, snapshot.gameId, revision]);
    if (rows.length !== 1) return unavailable('CALIBRATION_SHADOW_ORIGINAL_ANALYSIS_MISSING');
    const original = rows[0].payload, now = new Date(rows[0].database_now).getTime(), { game } = originalScope(original, revision, snapshot.league, snapshot.gameId, now);
    if (artifacts.plan.usedGamesExcluded.includes(`${game.league}:${game.sourceId}`)) return unavailable('CALIBRATION_SHADOW_GAME_ALREADY_USED');
    const source = await verifyOriginalSource(original, now);
    const forecast = predictSoccerCalibrationResearch({ ...artifacts, game, now });
    const predictionBody = { game, candidateHash: artifacts.candidate.contentHash, fullTime: forecast.fullTime, halfTime: forecast.halfTime };
    const captureId = soccerCalibrationHash([SOCCER_CALIBRATION_SHADOW_VERSION, artifacts.freezeId, game.id]);
    await soccerJournalQuery(`WITH receipt AS MATERIALIZED (SELECT clock_timestamp() AS captured_at)
      INSERT INTO sports_soccer_calibration_captures_v1
      (capture_id,freeze_id,league,game_id,board_date,analysis_revision,original_analysis_cutoff,source_receipt_id,
       source_content_hash,source_recorded_at,kickoff_at,prediction_body,prediction_body_hash,captured_at)
      SELECT $1,f.freeze_id,a.league,a.game_id,(a.payload->>'date')::date,a.analysis_hash,$2::timestamptz,s.receipt_id,s.content_hash,s.recorded_at,
        $6::timestamptz,$7::jsonb,$8,r.captured_at
      FROM sports_soccer_analysis_v1 a CROSS JOIN receipt r JOIN sports_soccer_calibration_freezes_v1 f ON f.freeze_id=$9
      JOIN sports_soccer_source_document_observations_v1 s ON s.receipt_id=$3
      WHERE a.league=$10 AND a.game_id=$11 AND a.analysis_hash=$12
        AND date_trunc('milliseconds',f.frozen_at)<date_trunc('milliseconds',r.captured_at)
        AND r.captured_at>$13::timestamptz AND r.captured_at<$6::timestamptz
        AND s.league=a.league AND s.game_id=a.game_id AND s.content_hash=$4
        AND date_trunc('milliseconds',s.recorded_at)=$5::timestamptz
        AND $2::timestamptz<=r.captured_at AND s.recorded_at<=$2::timestamptz AND s.recorded_at<=r.captured_at
        AND r.captured_at<$14::timestamptz ON CONFLICT DO NOTHING`,
    [captureId, original.analysisCutoff, source.receiptId, source.contentHash, source.recordedAt, game.startTime,
      JSON.stringify(predictionBody), soccerCalibrationHash(predictionBody), artifacts.freezeId, game.league, game.id,
      revision, artifacts.plan.beginsStrictlyAfter, iso(instant(original.evidence.source.fetchedAt) + 180000)]);
    const captured = await soccerJournalQuery(`${captureSelection} WHERE c.capture_id=$1`, [captureId]);
    if (captured.length !== 1) return unavailable('CALIBRATION_SHADOW_DATABASE_CAPTURE_TIME_INVALID');
    const verified = captureFromRow(captured[0], artifacts, freeze);
    return { version: SOCCER_CALIBRATION_SHADOW_VERSION, status: 'SHADOW_PREDICTION_SAVED', persisted: true,
      freeze, capture: verified.captureReceipt, fullTimeCaptured: true, halfTimeCaptured: true, ...restrictions };
  } catch (error) {
    return unavailable(typeof error?.message === 'string' && /^CALIBRATION_/.test(error.message)
      ? error.message : 'CALIBRATION_SHADOW_STORAGE_UNAVAILABLE');
  }
}

export async function getSoccerCalibrationShadowReport(leagueValue) {
  const artifacts = fixed(leagueValue);
  await ensureSoccerCalibrationShadowStore();
  const freeze = await readFreeze(artifacts);
  const rows = freeze ? await soccerJournalQuery(`SELECT count(*)::int AS games,min(captured_at) AS first_at,max(captured_at) AS last_at
    FROM sports_soccer_calibration_captures_v1 WHERE freeze_id=$1 AND league=$2`, [artifacts.freezeId, artifacts.league]) : [];
  if (freeze && (rows.length !== 1 || !Number.isSafeInteger(rows[0].games) || rows[0].games < 0
    || rows[0].games > 0 && (![rows[0].first_at, rows[0].last_at].every(value => value != null && Number.isFinite(new Date(value).getTime()))
      || new Date(rows[0].first_at).getTime() > new Date(rows[0].last_at).getTime())
    || rows[0].games === 0 && (rows[0].first_at != null || rows[0].last_at != null)))
    throw Error('CALIBRATION_SHADOW_COUNT_READBACK_FAILED');
  const games = freeze ? rows[0].games : 0;
  return { version: SOCCER_CALIBRATION_SHADOW_VERSION, league: artifacts.league,
    status: freeze ? 'SHADOW_COLLECTION_ACTIVE' : 'AWAITING_FIRST_ANALYSIS', freeze, captureGames: games,
    fullTimeCaptures: games, halfTimeCaptures: games, earliestCapturedAt: rows[0]?.first_at ? iso(rows[0].first_at) : null,
    latestCapturedAt: rows[0]?.last_at ? iso(rows[0].last_at) : null, validationStatus: 'NOT_EVALUATED', untouchedValidatedGames: 0, ...restrictions };
}

// Future result validation receives synchronous adapters over data that this
// function has just read from the real immutable store. No callback or custom
// query transport supplied by an HTTP caller can manufacture these receipts.
export async function loadSoccerCalibrationShadowValidationEvidence(leagueValue, { limit = 100, captureIds = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('CALIBRATION_SHADOW_READ_BUDGET_INVALID');
  if (captureIds !== null && (!Array.isArray(captureIds) || captureIds.length > 1000 || !captureIds.every(sha)))
    throw Error('CALIBRATION_SHADOW_CAPTURE_IDS_INVALID');
  const artifacts = fixed(leagueValue);
  await ensureSoccerCalibrationShadowStore();
  const freeze = await readFreeze(artifacts);
  if (!freeze) return { ...artifacts, freezeReceipt: null, records: [], verifyFreezeReceipt: () => false, verifyCaptureReceipt: () => false };
  const rows = await soccerJournalQuery(`${captureSelection}
    WHERE c.freeze_id=$1 AND c.league=$2 AND ($4::text[] IS NULL OR c.capture_id=ANY($4::text[]))
    ORDER BY c.capture_sequence LIMIT $3`, [artifacts.freezeId, artifacts.league, limit, captureIds]);
  const records = [];
  for (const row of rows) {
    const original = await soccerJournalQuery(`SELECT payload FROM sports_soccer_analysis_v1
      WHERE league=$1 AND game_id=$2 AND analysis_hash=$3`, [row.league, row.game_id, row.analysis_revision]);
    if (original.length !== 1 || storageHash(original[0].payload) !== row.analysis_revision
      || soccerCalibrationHash(original[0].payload.evidence?.game) !== soccerCalibrationHash(row.prediction_body?.game)
      || original[0].payload.analysisCutoff !== iso(row.original_analysis_cutoff)
      || original[0].payload.evidence?.sourceDocumentArchive?.receiptId !== row.source_receipt_id
      || original[0].payload.evidence?.source?.contentHash !== row.source_content_hash)
      throw Error('CALIBRATION_SHADOW_ORIGINAL_ANALYSIS_READBACK_FAILED');
    originalScope(original[0].payload, row.analysis_revision, row.league, row.game_id, new Date(row.captured_at).getTime());
    const source = await verifyOriginalSource(original[0].payload, new Date(row.captured_at).getTime());
    if (source.receiptId !== row.source_receipt_id || source.contentHash !== row.source_content_hash
      || source.recordedAt !== iso(row.source_recorded_at)) throw Error('CALIBRATION_SHADOW_SOURCE_READBACK_FAILED');
    records.push(captureFromRow(row, artifacts, freeze));
  }
  const frozenSignature = soccerCalibrationHash(freeze), trustedCandidateHash = artifacts.candidate.contentHash,
    trustedPlanHash = artifacts.plan.contentHash, captures = new Map(records.map(record => [record.captureReceipt.captureId,
    { receiptHash: soccerCalibrationHash(record.captureReceipt), predictionHash: soccerCalibrationHash(record.prediction), capturedAt: record.prediction.capturedAt }]));
  return { ...artifacts, freezeReceipt: freeze, records,
    verifyFreezeReceipt: ({ receipt, candidateHash, planHash }) => candidateHash === trustedCandidateHash
      && planHash === trustedPlanHash && soccerCalibrationHash(receipt) === frozenSignature,
    verifyCaptureReceipt: ({ receipt, predictionHash, capturedAt }) => {
      const trusted = captures.get(receipt?.captureId);
      return Boolean(trusted && trusted.receiptHash === soccerCalibrationHash(receipt)
        && trusted.predictionHash === predictionHash && trusted.capturedAt === capturedAt);
    } };
}

export async function listSoccerCalibrationShadowCaptureIds(leagueValue, { afterSequence = '0', limit = 100 } = {}) {
  if (!/^\d{1,18}$/.test(afterSequence) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw Error('CALIBRATION_SHADOW_CURSOR_INVALID');
  const artifacts = fixed(leagueValue);
  await ensureSoccerCalibrationShadowStore();
  const rows = await soccerJournalQuery(`SELECT capture_id,capture_sequence FROM sports_soccer_calibration_captures_v1
    WHERE freeze_id=$1 AND league=$2 AND capture_sequence>$3::bigint ORDER BY capture_sequence LIMIT $4`,
  [artifacts.freezeId, artifacts.league, afterSequence, limit + 1]);
  const selected = rows.slice(0, limit), complete = rows.length <= limit;
  return { captureIds: selected.map(row => row.capture_id), nextSequence: complete ? null : String(selected.at(-1).capture_sequence),
    completeWithinRequestedScope: complete, ...restrictions };
}
