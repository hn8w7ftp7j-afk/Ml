import { ensureSoccerJournal, soccerJournalQuery, soccerJournalTransaction } from './journal.js';
import { fetchSoccerSettlementResult } from './settlement-result.js';
import { evaluateSoccerMarketReturnCapture, buildSoccerMarketReturnReport, canonicalSoccerMarketReturnCaptures } from './market-return-validation.js';
import { SOCCER_FORWARD_VERSION, SOCCER_FORWARD_POLICY, soccerForwardHash, soccerForwardModelDescriptor,
  normalizeSoccerForwardScope, canonicalSoccerForwardCaptures, evaluateSoccerForwardCapture, buildSoccerForwardReport } from './forward-validation.js';

export const SOCCER_FORWARD_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sports_soccer_forward_protocol_v1 (
    protocol_version TEXT PRIMARY KEY, policy_hash TEXT NOT NULL, policy JSONB NOT NULL,
    activated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_forward_captures_v1 (
    capture_id TEXT PRIMARY KEY, capture_sequence BIGSERIAL UNIQUE NOT NULL,
    protocol_version TEXT NOT NULL REFERENCES sports_soccer_forward_protocol_v1(protocol_version),
    league TEXT NOT NULL CHECK (league IN ('epl','ucl')), game_id TEXT NOT NULL,
    board_date DATE NOT NULL, period TEXT NOT NULL CHECK (period IN ('REGULATION_FT','REGULATION_HT')),
    variant TEXT NOT NULL CHECK (variant IN ('BASELINE','PERSONNEL_CHALLENGER')),
    model_hash TEXT NOT NULL, analysis_revision TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (league,game_id,analysis_revision) REFERENCES sports_soccer_analysis_v1(league,game_id,analysis_hash),
    UNIQUE (league,game_id,period,variant,analysis_revision))`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_forward_scope_v1 ON sports_soccer_forward_captures_v1
    (league,board_date,capture_sequence)`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_forward_result_checks_v1 (
    check_id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES sports_soccer_forward_captures_v1(capture_id),
    checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), payload JSONB NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_forward_checks_v1 ON sports_soccer_forward_result_checks_v1 (capture_id,checked_at)`,
  ...['protocol','captures','result_checks'].map(name =>
    `CREATE OR REPLACE TRIGGER sports_soccer_forward_immutable_v1 BEFORE UPDATE OR DELETE ON sports_soccer_forward_${name}_v1
      FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`),
];
let ready;
export async function ensureSoccerForwardProtocol() {
  return ready ||= (async () => {
    await ensureSoccerJournal();
    await soccerJournalTransaction([
      ['SELECT pg_advisory_xact_lock(221019,2203)'],
      ...SOCCER_FORWARD_SCHEMA.map(statement => [statement]),
      [`INSERT INTO sports_soccer_forward_protocol_v1 (protocol_version,policy_hash,policy)
        VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`, [SOCCER_FORWARD_VERSION, soccerForwardHash(SOCCER_FORWARD_POLICY), JSON.stringify(SOCCER_FORWARD_POLICY)]],
    ]);
    return readSoccerForwardProtocol();
  })().catch(error => { ready = null; throw error; });
}
export async function readSoccerForwardProtocol(query = soccerJournalQuery) {
  const rows = await query(`SELECT protocol_version,policy_hash,policy,activated_at FROM sports_soccer_forward_protocol_v1 WHERE protocol_version=$1`, [SOCCER_FORWARD_VERSION]);
  const row = rows[0];
  if (!row || row.policy_hash !== soccerForwardHash(SOCCER_FORWARD_POLICY) || soccerForwardHash(row.policy) !== row.policy_hash) throw Error('SOCCER_FORWARD_PROTOCOL_CONFLICT');
  return { version: row.protocol_version, policy: row.policy, policyHash: row.policy_hash, activatedAt: new Date(row.activated_at).toISOString() };
}

// Server callers supply scope/revision only. Prediction content always comes
// from the immutable DB revision, never an HTTP body or a rebuilt old model.
export async function captureSoccerForwardSnapshot(snapshot, revision, { query = soccerJournalQuery, ensure = ensureSoccerForwardProtocol } = {}) {
  if (!['epl','ucl'].includes(snapshot?.league) || !new RegExp(`^soccer:${snapshot.league}:\\d{1,16}$`).test(snapshot.gameId || '') || !/^[a-f0-9]{64}$/.test(revision || '')) throw Error('SOCCER_FORWARD_CAPTURE_SCOPE_INVALID');
  await ensure();
  const rows = await query(`SELECT payload FROM sports_soccer_analysis_v1 WHERE league=$1 AND game_id=$2 AND analysis_hash=$3`, [snapshot.league, snapshot.gameId, revision]);
  if (rows.length !== 1) throw Error('SOCCER_FORWARD_ORIGINAL_SNAPSHOT_MISSING');
  const original = rows[0].payload;
  // One INSERT statement is atomic across all three periods/variants. A lost
  // response can be retried idempotently and cannot strand a partial bundle.
  const records = [['REGULATION_FT','BASELINE'],['REGULATION_HT','BASELINE'],['REGULATION_FT','PERSONNEL_CHALLENGER']].map(([period, variant]) => ({
    capture_id: soccerForwardHash([SOCCER_FORWARD_VERSION, snapshot.league, snapshot.gameId, period, variant, revision]),
    period, variant, model_hash: soccerForwardHash(soccerForwardModelDescriptor(original, period, variant)),
  }));
  await query(`INSERT INTO sports_soccer_forward_captures_v1
    (capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision)
    SELECT r.capture_id,$1,a.league,a.game_id,(a.payload->>'date')::date,r.period,r.variant,r.model_hash,a.analysis_hash
    FROM sports_soccer_analysis_v1 a CROSS JOIN jsonb_to_recordset($2::jsonb)
      AS r(capture_id text,period text,variant text,model_hash text)
    WHERE a.league=$3 AND a.game_id=$4 AND a.analysis_hash=$5 ON CONFLICT DO NOTHING`,
    [SOCCER_FORWARD_VERSION, JSON.stringify(records), snapshot.league, snapshot.gameId, revision]);
  const receipts = await query(`SELECT capture_id,capture_sequence,captured_at FROM sports_soccer_forward_captures_v1
    WHERE capture_id=ANY($1::text[])`, [records.map(record => record.capture_id)]);
  if (receipts.length !== records.length) throw Error('SOCCER_FORWARD_CAPTURE_READBACK_FAILED');
  const output = records.map(record => {
    const receipt = receipts.find(row => row.capture_id === record.capture_id);
    if (!receipt) throw Error('SOCCER_FORWARD_CAPTURE_READBACK_FAILED');
    return { captureId: record.capture_id, captureSequence: String(receipt.capture_sequence), period: record.period,
      variant: record.variant, modelHash: record.model_hash, capturedAt: new Date(receipt.captured_at).toISOString() };
  });
  return { status: 'DATABASE_RECEIPT_SAVED_NOT_MODEL_APPROVAL', persisted: true, captures: output, formalEligible: false, executable: false };
}

// Operational read budgets do not change the frozen model admission protocol.
// JSONB's on-disk size may be TOAST-compressed; measure its uncompressed text
// before selecting any payload so a long date range cannot allocate gigabytes.
export const SOCCER_FORWARD_READ_LIMITS = Object.freeze({
  captureRows: 5000, capturePayloadBytes: 24 * 1024 * 1024,
  resultCheckRows: 25000, resultCheckPayloadBytes: 8 * 1024 * 1024,
});
export async function loadSoccerForwardEvidence(scope, { query = soccerJournalQuery, ensure = ensureSoccerForwardProtocol,
  limit = SOCCER_FORWARD_READ_LIMITS.captureRows, capturePayloadBytes = SOCCER_FORWARD_READ_LIMITS.capturePayloadBytes,
  resultCheckRows = SOCCER_FORWARD_READ_LIMITS.resultCheckRows, resultCheckPayloadBytes = SOCCER_FORWARD_READ_LIMITS.resultCheckPayloadBytes } = {}) {
  for (const [value, maximum] of [[limit, SOCCER_FORWARD_READ_LIMITS.captureRows],
    [capturePayloadBytes, SOCCER_FORWARD_READ_LIMITS.capturePayloadBytes], [resultCheckRows, SOCCER_FORWARD_READ_LIMITS.resultCheckRows],
    [resultCheckPayloadBytes, SOCCER_FORWARD_READ_LIMITS.resultCheckPayloadBytes]])
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw Error('SOCCER_FORWARD_READ_BUDGET_INVALID');
  const { league, from, through } = normalizeSoccerForwardScope(scope);
  await ensure();
  const protocol = await readSoccerForwardProtocol(query);
  const metadata = await query(`WITH candidates AS MATERIALIZED (
      SELECT c.capture_id,c.capture_sequence,c.league,c.game_id,c.board_date::text,c.period,c.variant,c.model_hash,
        c.analysis_revision,c.captured_at,octet_length(a.payload::text)::bigint AS payload_bytes
      FROM sports_soccer_forward_captures_v1 c
      JOIN sports_soccer_analysis_v1 a ON a.league=c.league AND a.game_id=c.game_id AND a.analysis_hash=c.analysis_revision
      WHERE c.protocol_version=$1 AND ($2::text IS NULL OR c.league=$2) AND c.board_date BETWEEN $3::date AND $4::date
      ORDER BY c.capture_sequence ASC LIMIT $5
    ), revisions AS MATERIALIZED (
      SELECT *,row_number() OVER (PARTITION BY league,game_id,analysis_revision ORDER BY capture_sequence) AS revision_ordinal
      FROM candidates
    ), charged AS MATERIALIZED (
      SELECT *,CASE WHEN revision_ordinal=1 THEN payload_bytes ELSE 0 END AS charged_payload_bytes FROM revisions
    ) SELECT *,sum(charged_payload_bytes) OVER (ORDER BY capture_sequence ROWS UNBOUNDED PRECEDING) AS cumulative_payload_bytes
      FROM charged ORDER BY capture_sequence ASC`, [SOCCER_FORWARD_VERSION, league, from, through, limit + 1]);
  const selected = metadata.slice(0, limit).filter(row => Number(row.cumulative_payload_bytes) <= capturePayloadBytes);
  const captureIds = selected.map(row => row.capture_id);
  // FT, HT and personnel receipts point to the same immutable full analysis.
  // Charge and transfer that analysis once, while retaining every receipt and
  // its sequence. Do not strip fields: revision/hash verification still sees the
  // original payload. The composite key prevents cross-game or league aliasing.
  const snapshotKey = row => JSON.stringify([row.league,row.game_id,row.analysis_revision]);
  const expectedSnapshotKeys = new Set(selected.map(snapshotKey));
  const payloads = captureIds.length ? await query(`SELECT DISTINCT ON (c.league,c.game_id,c.analysis_revision)
      c.league,c.game_id,c.analysis_revision,a.payload FROM sports_soccer_forward_captures_v1 c
    JOIN sports_soccer_analysis_v1 a ON a.league=c.league AND a.game_id=c.game_id AND a.analysis_hash=c.analysis_revision
    WHERE c.capture_id=ANY($1::text[]) ORDER BY c.league,c.game_id,c.analysis_revision,c.capture_sequence ASC`, [captureIds]) : [];
  const snapshots = new Map(payloads.map(row => [snapshotKey(row), row.payload]));
  if (payloads.length !== expectedSnapshotKeys.size || snapshots.size !== expectedSnapshotKeys.size
    || [...expectedSnapshotKeys].some(key => !snapshots.has(key))) throw Error('SOCCER_FORWARD_BOUNDED_READ_INCOMPLETE');
  const captures = selected.map(row => ({ captureId: row.capture_id, captureSequence: String(row.capture_sequence), league: row.league,
    gameId: row.game_id, date: row.board_date, period: row.period, variant: row.variant, modelHash: row.model_hash,
    revision: row.analysis_revision, capturedAt: new Date(row.captured_at).toISOString(), snapshot: snapshots.get(snapshotKey(row)) }));
  // Read a capture's entire result history or none of it. A newest-N check
  // limit could hide an older conflicting correction and wrongly restore a
  // previously quarantined score. Both row count and bytes are budgeted in SQL.
  const historyRows = captureIds.length ? await query(`WITH histories AS MATERIALIZED (
      SELECT c.capture_id,f.capture_sequence,count(*)::bigint AS check_rows,
        sum(octet_length(c.payload::text))::bigint AS payload_bytes
      FROM sports_soccer_forward_result_checks_v1 c
      JOIN sports_soccer_forward_captures_v1 f ON f.capture_id=c.capture_id
      WHERE c.capture_id=ANY($1::text[]) GROUP BY c.capture_id,f.capture_sequence
    ), budgeted AS MATERIALIZED (
      SELECT *,sum(check_rows) OVER (ORDER BY capture_sequence ROWS UNBOUNDED PRECEDING) AS cumulative_check_rows,
        sum(payload_bytes) OVER (ORDER BY capture_sequence ROWS UNBOUNDED PRECEDING) AS cumulative_payload_bytes FROM histories
    ) SELECT h.*,c.check_id,c.checked_at,c.payload FROM budgeted h
      LEFT JOIN sports_soccer_forward_result_checks_v1 c ON c.capture_id=h.capture_id
        AND h.cumulative_check_rows<=$2 AND h.cumulative_payload_bytes<=$3
      ORDER BY h.capture_sequence ASC,c.checked_at DESC,c.check_id ASC`, [captureIds, resultCheckRows, resultCheckPayloadBytes]) : [];
  // Budgeting and reading checks share one MVCC statement: a concurrent append
  // cannot slip extra payloads into a history that was sized by an earlier read.
  const checkMetadata = [...new Map(historyRows.map(row => [row.capture_id, row])).values()];
  const selectedHistories = checkMetadata.filter(row => Number(row.cumulative_check_rows) <= resultCheckRows
    && Number(row.cumulative_payload_bytes) <= resultCheckPayloadBytes);
  const completeHistoryIds = new Set(selectedHistories.map(row => row.capture_id));
  const incompleteResultCaptureIds = checkMetadata.filter(row => !completeHistoryIds.has(row.capture_id)).map(row => row.capture_id);
  const checks = historyRows.filter(row => row.check_id != null);
  if (checks.length !== selectedHistories.reduce((sum, row) => sum + Number(row.check_rows), 0)) throw Error('SOCCER_FORWARD_BOUNDED_CHECK_READ_INCOMPLETE');
  const reasons = [];
  if (metadata.length > limit) reasons.push('CAPTURE_ROW_BUDGET');
  if (metadata.slice(0, limit).some(row => Number(row.cumulative_payload_bytes) > capturePayloadBytes)) reasons.push('CAPTURE_PAYLOAD_BYTE_BUDGET');
  if (checkMetadata.some(row => Number(row.cumulative_check_rows) > resultCheckRows)) reasons.push('RESULT_CHECK_ROW_BUDGET');
  if (checkMetadata.some(row => Number(row.cumulative_payload_bytes) > resultCheckPayloadBytes)) reasons.push('RESULT_CHECK_PAYLOAD_BYTE_BUDGET');
  const truncated = reasons.length > 0;
  const readCoverage = { status: truncated ? 'PARTIAL_BOUNDED_READ' : 'COMPLETE_WITHIN_REQUESTED_SCOPE', requestedScope: { league, from, through },
    limits: { captureRows: limit, capturePayloadBytes, resultCheckRows, resultCheckPayloadBytes },
    loadedCaptureRows: captures.length, loadedUniqueAnalysisRows: payloads.length,
    loadedCapturePayloadBytes: selected.reduce((sum, row) => sum + Number(row.charged_payload_bytes), 0),
    loadedResultCheckRows: checks.length, loadedResultCheckPayloadBytes: selectedHistories.reduce((sum, row) => sum + Number(row.payload_bytes), 0),
    incompleteResultHistories: incompleteResultCaptureIds.length, reasons,
    guidance: truncated ? '請縮小聯盟或日期範圍重新查詢；本次只涵蓋已完整載入的前綴，不能當成完整驗收。' : null };
  return { protocol, captures, evaluations: checks.map(row => row.payload.evaluation).filter(Boolean),
    checks: checks.map(row => ({ captureId: row.capture_id, checkedAt: new Date(row.checked_at).toISOString(), reason: row.payload.reason || row.payload.evaluation?.reason || null })),
    incompleteResultCaptureIds, readCoverage, truncated };
}
export async function readSoccerForwardValidation(scope, deps = {}) {
  const evidence = await loadSoccerForwardEvidence(scope, deps), now = deps.now?.() ?? Date.now();
  return { ...buildSoccerForwardReport({ ...evidence, now }), marketReturnValidation: buildSoccerMarketReturnReport(evidence, now) };
}
export async function archiveSoccerForwardCheck(capture, evaluation, result, { query = soccerJournalQuery, now = Date.now() } = {}) {
  const payload = { version: SOCCER_FORWARD_VERSION, status: evaluation.status, reason: evaluation.reason || null,
    evaluation, resultEvidence: result?.ok === true && result?.verified === true ? result : null };
  // Same evidence is idempotent; new result hashes are appended, never overwrite
  // a once-scored result. Reports quarantine conflicts rather than pick a winner.
  const stable = { captureId: capture.captureId, status: evaluation.status, reason: evaluation.reason || null,
    resultHash: result?.resultHash || null, checkWindow: Math.floor(now / SOCCER_FORWARD_POLICY.resultCheckDedupWindowMs) };
  if (evaluation.marketReturnValidation?.evidenceHash) stable.marketReturnEvidenceHash = evaluation.marketReturnValidation.evidenceHash;
  const checkId = soccerForwardHash(stable);
  await query(`INSERT INTO sports_soccer_forward_result_checks_v1 (check_id,capture_id,payload)
    VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`, [checkId, capture.captureId, JSON.stringify(payload)]);
  const rows = await query(`SELECT payload FROM sports_soccer_forward_result_checks_v1 WHERE check_id=$1 AND capture_id=$2`, [checkId, capture.captureId]);
  if (!rows[0] || rows[0].payload.status !== evaluation.status || rows[0].payload.evaluation?.revision !== evaluation.revision && evaluation.status === 'EVALUATED') throw Error('SOCCER_FORWARD_CHECK_READBACK_FAILED');
  return { persisted: true, checkId };
}

export async function runSoccerForwardValidation(scope, { limit = 25, timeBudgetMs = 18000, now = Date.now,
  loadEvidence = loadSoccerForwardEvidence, fetchResult = fetchSoccerSettlementResult, archive = archiveSoccerForwardCheck,
  query = soccerJournalQuery, capture = captureSoccerForwardSnapshot } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 || !Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0 || timeBudgetMs > 25000) throw Object.assign(Error('前瞻驗證執行範圍不正確。'), { status: 400 });
  const range = normalizeSoccerForwardScope(scope, now()), started = now(), deadline = started + timeBudgetMs;
  const initial = await loadEvidence(range);
  const summary = { capturedRevisions: 0, checkedGameModelPeriods: 0, evaluated: 0, pending: 0, deferred: 0, reasons: {},
    marketReturnCheckedPredictionPeriods: 0, marketReturnObservedQuoteReturns: 0, marketReturnPendingQuoteReturns: 0, marketReturnDeferredPredictionPeriods: 0,
    recheckedGameModelPeriods: 0, persistence: 'DURABLE_APPEND_ONLY_DATABASE', budgetExhausted: false, formalEligible: false, executable: false };
  // This convenience pass registers still-upcoming saved analyses only. It
  // never creates pregame receipts for completed historical predictions.
  const upcoming = await query(`SELECT a.league,a.game_id,a.analysis_hash FROM sports_soccer_analysis_v1 a
    WHERE ($1::text IS NULL OR a.league=$1) AND a.payload->>'date' BETWEEN $2 AND $3
      AND a.payload->>'status'='RESEARCH_ONLY' AND (a.payload->'evidence'->'game'->>'startTime')::timestamptz>clock_timestamp()
      AND (SELECT count(*) FROM sports_soccer_forward_captures_v1 c WHERE c.league=a.league AND c.game_id=a.game_id AND c.analysis_revision=a.analysis_hash)<3
    ORDER BY a.observed_at,a.analysis_hash LIMIT $4`, [range.league, range.from, range.through, Math.min(limit * 3, 75)]);
  for (const row of upcoming) {
    if (now() >= deadline) { summary.budgetExhausted = true; break; }
    try { await capture({ league: row.league, gameId: row.game_id }, row.analysis_hash); summary.capturedRevisions++; }
    catch { summary.reasons.FORWARD_CAPTURE_PERSISTENCE_FAILED = (summary.reasons.FORWARD_CAPTURE_PERSISTENCE_FAILED || 0) + 1; }
  }
  const evidence = upcoming.length ? await loadEvidence(range) : initial;
  summary.evidenceTruncated = evidence.truncated === true;
  summary.readCoverage = evidence.readCoverage || null;
  const goalChosen = canonicalSoccerForwardCaptures(evidence.captures, evidence.protocol, now()).chosen;
  const marketSelection = canonicalSoccerMarketReturnCaptures(evidence.captures, evidence.protocol, now()), marketChosen = marketSelection.chosen;
  const marketRows = new Set(marketSelection.observations.map(row => `${row.captureId}:${row.observationId}`));
  const goalIds = new Set(goalChosen.map(row => row.captureId)), marketIds = new Set(marketChosen.map(row => row.captureId));
  const chosen = [...new Map([...goalChosen, ...marketChosen].map(row => [row.captureId, row])).values()];
  const marketChecked = new Set(evidence.evaluations.map(row => row.marketReturnValidation?.captureId).filter(Boolean));
  const evaluated = new Set(evidence.evaluations.map(value => value.captureId));
  const lastChecked = new Map();
  for (const check of evidence.checks || []) {
    const time = Date.parse(check.checkedAt);
    if (Number.isFinite(time)) lastChecked.set(check.captureId, Math.max(lastChecked.get(check.captureId) || 0, time));
  }
  const groups = new Map();
  for (const item of chosen) {
    const checkedAt = lastChecked.get(item.captureId) || 0;
    if (evaluated.has(item.captureId) && now() - checkedAt < SOCCER_FORWARD_POLICY.settledResultRecheckIntervalMs
      && (!marketIds.has(item.captureId) || marketChecked.has(item.captureId))) continue;
    if (Date.parse(item.snapshot.evidence.game.startTime) >= now()) continue;
    const key = `${item.league}|${item.gameId}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  // Failures and already-scored games both rotate by durable last-check time.
  // Never let a fixed first batch of unavailable providers starve later games.
  const queue = [...groups.values()].sort((a, b) => Math.min(...a.map(item => lastChecked.get(item.captureId) || 0))
    - Math.min(...b.map(item => lastChecked.get(item.captureId) || 0))
    || (BigInt(a[0].captureSequence) < BigInt(b[0].captureSequence) ? -1 : 1));
  let fetched = 0;
  for (const group of queue) {
    if (now() >= deadline || fetched >= limit) {
      summary.deferred += group.filter(row => goalIds.has(row.captureId)).length;
      summary.marketReturnDeferredPredictionPeriods += group.filter(row => marketIds.has(row.captureId)).length;
      summary.budgetExhausted ||= now() >= deadline; continue;
    }
    const original = group[0], game = original.snapshot.evidence.game;
    let result;
    try { result = await fetchResult({ league: original.league, gameId: original.gameId, date: original.date,
      startTime: game.startTime, teamIds: { home: game.home.id, away: game.away.id } }, { now, timeoutMs: Math.max(1, Math.min(6000, deadline - now())) }); }
    catch { result = { ok: false, reason: 'FORWARD_RESULT_SOURCE_UNAVAILABLE' }; }
    fetched++;
    for (const member of group) {
      const goalMember = goalIds.has(member.captureId), marketMember = marketIds.has(member.captureId);
      if (now() >= deadline) { summary.deferred += Number(goalMember); summary.marketReturnDeferredPredictionPeriods += Number(marketMember); summary.budgetExhausted = true; continue; }
      const evaluation = evaluateSoccerForwardCapture(member, evidence.protocol, result, now());
      evaluation.marketReturnValidation = evaluateSoccerMarketReturnCapture({ capture: member, protocol: evidence.protocol, result, now: now() });
      summary.checkedGameModelPeriods += Number(goalMember);
      summary.marketReturnCheckedPredictionPeriods += Number(marketMember);
      try { await archive(member, evaluation, result, { now: now() }); }
      catch { summary.pending += Number(goalMember); summary.reasons.FORWARD_RESULT_PERSISTENCE_FAILED = (summary.reasons.FORWARD_RESULT_PERSISTENCE_FAILED || 0) + 1; continue; }
      if (marketMember) {
        const rows = evaluation.marketReturnValidation.observations.filter(row => marketRows.has(`${member.captureId}:${row.observationId}`));
        summary.marketReturnObservedQuoteReturns += rows.filter(row => row.status === 'OBSERVED').length;
        summary.marketReturnPendingQuoteReturns += rows.filter(row => row.status !== 'OBSERVED').length;
      }
      if (goalMember && evaluation.status === 'EVALUATED') { summary.evaluated++; if (evaluated.has(member.captureId)) summary.recheckedGameModelPeriods++; }
      else if (goalMember) { summary.pending++; summary.reasons[evaluation.reason] = (summary.reasons[evaluation.reason] || 0) + 1; }
    }
  }
  return summary;
}
