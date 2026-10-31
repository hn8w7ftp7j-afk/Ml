import { soccerJournalQuery, soccerJournalTransaction } from './journal.js';
import { ensureSoccerCalibrationShadowStore } from './calibration-shadow-store.js';
import { soccerCalibrationHash } from './calibration-research.js';

export const SOCCER_CALIBRATION_SHADOW_EVALUATION_VERSION = 'SOCCER-CALIBRATION-SHADOW-VALIDATION-v1';
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const statuses = ['PENDING', 'EVALUATED', 'QUARANTINED'];
const maxPayloadBytes = 4 * 1024 * 1024, maxHistoryBytes = 16 * 1024 * 1024;
const unavailable = () => Object.assign(Error('CALIBRATION_SHADOW_EVALUATION_STORAGE_UNAVAILABLE'), { status: 503 });
const schema = [
  `CREATE TABLE IF NOT EXISTS sports_soccer_calibration_checks_v1 (
    check_id TEXT PRIMARY KEY CHECK(check_id ~ '^[a-f0-9]{64}$'),
    capture_id TEXT NOT NULL REFERENCES sports_soccer_calibration_captures_v1(capture_id),
    league TEXT NOT NULL CHECK(league IN ('epl','ucl')), evidence_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PENDING','EVALUATED','QUARANTINED')),
    payload JSONB NOT NULL,payload_hash TEXT NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),UNIQUE(capture_id,evidence_hash))`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_calibration_check_scope_v1 ON sports_soccer_calibration_checks_v1(league,capture_id,checked_at)`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_calibration_check_attempts_v1 (
    attempt_sequence BIGSERIAL PRIMARY KEY,capture_id TEXT NOT NULL REFERENCES sports_soccer_calibration_captures_v1(capture_id),
    check_id TEXT NOT NULL REFERENCES sports_soccer_calibration_checks_v1(check_id),
    source_observations JSONB NOT NULL,source_observations_hash TEXT NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
  // Older attempt receipts remain immutable; missing historical fetch
  // metadata stays NULL rather than being backfilled as fabricated evidence.
  `ALTER TABLE sports_soccer_calibration_check_attempts_v1
    ADD COLUMN IF NOT EXISTS source_observations JSONB,
    ADD COLUMN IF NOT EXISTS source_observations_hash TEXT`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_calibration_attempt_capture_v1 ON sports_soccer_calibration_check_attempts_v1(capture_id,attempted_at)`,
  `CREATE OR REPLACE TRIGGER sports_soccer_calibration_checks_immutable_v1 BEFORE UPDATE OR DELETE
    ON sports_soccer_calibration_checks_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`,
  `CREATE OR REPLACE TRIGGER sports_soccer_calibration_attempts_immutable_v1 BEFORE UPDATE OR DELETE
    ON sports_soccer_calibration_check_attempts_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`,
];
let ready;
export async function ensureSoccerCalibrationShadowEvaluationStore() {
  return ready ||= (async () => {
    await ensureSoccerCalibrationShadowStore();
    await soccerJournalTransaction([['SELECT pg_advisory_xact_lock(221019,2312)'], ...schema.map(sql => [sql])]);
  })().catch(error => { ready = null; throw error; });
}

// Keep the first exact full provider document, then append each later fetch's
// source metadata to its attempt receipt. Identical JSON must not grow a new
// full-history copy every hour solely because fetchedAt/requestedAt changed.
// Every changed payload or other source field still creates a new check.
const documentProof = document => {
  if (!document?.source) return document;
  const { fetchedAt: _fetchedAt, requestedAt: _requestedAt, ...source } = document.source;
  return { ...document, source };
};
const identity = ({ resultDocuments, status, reason }) => soccerCalibrationHash({
  resultDocuments: resultDocuments ? { ...resultDocuments,
    scoreboard: documentProof(resultDocuments.scoreboard), summaries: resultDocuments.summaries?.map(documentProof) } : resultDocuments,
  status, reason,
});
function fromRow(row) {
  const payload = row.payload, checkedEpoch = new Date(row.checked_at).getTime();
  if (!sha(row.check_id) || !sha(row.capture_id) || !['epl', 'ucl'].includes(row.league) || !statuses.includes(row.status)
    || payload?.version !== SOCCER_CALIBRATION_SHADOW_EVALUATION_VERSION || payload.status !== row.status
    || soccerCalibrationHash(payload) !== row.payload_hash || identity(payload) !== row.evidence_hash
    || soccerCalibrationHash([SOCCER_CALIBRATION_SHADOW_EVALUATION_VERSION, row.capture_id, row.evidence_hash]) !== row.check_id
    || !Number.isFinite(checkedEpoch)) throw unavailable();
  const sources = [payload.resultDocuments?.scoreboard, ...(payload.resultDocuments?.summaries || [])].filter(Boolean);
  if (sources.some(value => !Number.isFinite(Date.parse(value.source?.fetchedAt)) || Date.parse(value.source.fetchedAt) > checkedEpoch)) throw unavailable();
  return { checkId: row.check_id, captureId: row.capture_id, league: row.league, checkedAt: new Date(row.checked_at).toISOString(), ...payload };
}

/** Append source documents and derived diagnostics. Read paths must recompute
 * the documents against real capture/freeze receipts; a stored report flag is
 * never an authority for validation sample admission. */
export async function archiveSoccerCalibrationShadowEvaluation({ league, captureId, resultDocuments = null,
  status, report = null, reason = null } = {}) {
  if (!['epl', 'ucl'].includes(league) || !sha(captureId) || !statuses.includes(status)
    || reason !== null && (typeof reason !== 'string' || reason.length > 200)) throw Error('CALIBRATION_SHADOW_EVALUATION_SCOPE_INVALID');
  const payload = { version: SOCCER_CALIBRATION_SHADOW_EVALUATION_VERSION, resultDocuments, status, report, reason,
    accepted: false, formalEligible: false, promotionEligible: false, executable: false };
  if (Buffer.byteLength(JSON.stringify(payload)) > maxPayloadBytes) throw Error('CALIBRATION_SHADOW_RESULT_DOCUMENT_BUDGET');
  const evidenceHash = identity(payload), checkId = soccerCalibrationHash([SOCCER_CALIBRATION_SHADOW_EVALUATION_VERSION, captureId, evidenceHash]);
  const sources = [resultDocuments?.scoreboard, ...(resultDocuments?.summaries || [])].filter(Boolean).map(value => Date.parse(value.source?.fetchedAt));
  if (sources.some(value => !Number.isFinite(value))) throw Error('CALIBRATION_SHADOW_RESULT_SOURCE_TIME_INVALID');
  await ensureSoccerCalibrationShadowEvaluationStore();
  await soccerJournalQuery(`INSERT INTO sports_soccer_calibration_checks_v1(check_id,capture_id,league,evidence_hash,status,payload,payload_hash)
    SELECT $1,c.capture_id,c.league,$3,$4,$5::jsonb,$6 FROM sports_soccer_calibration_captures_v1 c
    WHERE c.capture_id=$2 AND c.league=$7 AND $8::timestamptz<=clock_timestamp() ON CONFLICT DO NOTHING`,
  [checkId, captureId, evidenceHash, status, JSON.stringify(payload), soccerCalibrationHash(payload), league,
    new Date(sources.length ? Math.max(...sources) : 0).toISOString()]);
  const sourceCutoff = new Date(sources.length ? Math.max(...sources) : 0).toISOString();
  const rows = await soccerJournalQuery(`SELECT * FROM sports_soccer_calibration_checks_v1 WHERE check_id=$1
    AND $2::timestamptz<=clock_timestamp()`, [checkId, sourceCutoff]);
  if (rows.length !== 1) throw unavailable();
  const stored = fromRow(rows[0]);
  if (stored.captureId !== captureId || stored.league !== league || identity(stored) !== evidenceHash) throw unavailable();
  const observations = [resultDocuments?.scoreboard, ...(resultDocuments?.summaries || [])].filter(Boolean)
    .map(document => ({ ok: document.ok, code: document.code ?? null, source: document.source ?? null }));
  const attempt = await soccerJournalQuery(`INSERT INTO sports_soccer_calibration_check_attempts_v1
    (capture_id,check_id,source_observations,source_observations_hash)
    SELECT capture_id,check_id,$3::jsonb,$4 FROM sports_soccer_calibration_checks_v1
    WHERE check_id=$1 AND capture_id=$2 AND $5::timestamptz<=clock_timestamp() RETURNING attempted_at`,
  [checkId, captureId, JSON.stringify(observations), soccerCalibrationHash(observations), sourceCutoff]);
  if (attempt.length !== 1) throw unavailable();
  return { status: 'ARCHIVED', persisted: true, checkId, captureId, checkedAt: stored.checkedAt, attemptedAt: new Date(attempt[0].attempted_at).toISOString() };
}

/** Complete bounded history or an explicit error; never silently discard an
 * older conflicting result. Only metadata is read before the byte budget. */
export async function loadSoccerCalibrationShadowEvaluationHistory(league, { captureIds = null, limit = 2000 } = {}) {
  if (!['epl', 'ucl'].includes(league) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000
    || captureIds !== null && (!Array.isArray(captureIds) || captureIds.length > 1000 || captureIds.some(id => !sha(id))))
    throw Error('CALIBRATION_SHADOW_EVALUATION_READ_SCOPE_INVALID');
  await ensureSoccerCalibrationShadowEvaluationStore();
  const metadata = await soccerJournalQuery(`SELECT check_id,octet_length(payload::text)::bigint AS payload_bytes
    FROM sports_soccer_calibration_checks_v1 WHERE league=$1 AND ($2::text[] IS NULL OR capture_id=ANY($2::text[]))
    ORDER BY checked_at,check_id LIMIT $3`, [league, captureIds, limit + 1]);
  if (metadata.length > limit || metadata.reduce((total, row) => total + Number(row.payload_bytes), 0) > maxHistoryBytes)
    throw Object.assign(Error('CALIBRATION_SHADOW_COMPLETE_RESULT_HISTORY_EXCEEDS_READ_BUDGET'), { status: 503 });
  if (!metadata.length) return [];
  const rows = await soccerJournalQuery(`SELECT * FROM sports_soccer_calibration_checks_v1 WHERE check_id=ANY($1::text[])
    ORDER BY checked_at,check_id`, [metadata.map(row => row.check_id)]);
  if (rows.length !== metadata.length) throw unavailable();
  return rows.map(fromRow);
}

export async function listSoccerCalibrationShadowPendingCaptureIds(league, { limit = 3, freezeId = null } = {}) {
  if (!['epl', 'ucl'].includes(league) || !Number.isSafeInteger(limit) || limit < 1 || limit > 3)
    throw Error('CALIBRATION_SHADOW_EVALUATION_READ_SCOPE_INVALID');
  if (freezeId !== null && !sha(freezeId)) throw Error('CALIBRATION_SHADOW_EVALUATION_READ_SCOPE_INVALID');
  await ensureSoccerCalibrationShadowEvaluationStore();
  // Fair rechecks keep late/corrected results visible; a finished game does not
  // monopolize each small POST batch. No report flag suppresses future checks.
  const rows = await soccerJournalQuery(`SELECT c.capture_id,max(r.attempted_at) AS last_checked_at
    FROM sports_soccer_calibration_captures_v1 c LEFT JOIN sports_soccer_calibration_check_attempts_v1 r USING(capture_id)
    WHERE c.league=$1 AND ($3::text IS NULL OR c.freeze_id=$3) AND c.kickoff_at<clock_timestamp()
    GROUP BY c.capture_id,c.captured_at ORDER BY max(r.attempted_at) ASC NULLS FIRST,c.captured_at,c.capture_id LIMIT $2`, [league, limit, freezeId]);
  return rows.map(row => row.capture_id);
}
