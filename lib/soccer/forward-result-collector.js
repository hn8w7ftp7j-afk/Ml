import { soccerJournalQuery } from './journal.js';
import { ensureSoccerForwardProtocol, readSoccerForwardProtocol, archiveSoccerForwardCheck,
  SOCCER_FORWARD_READ_LIMITS } from './forward-validation-service.js';
import { normalizeSoccerForwardScope, validateSoccerForwardCapture, evaluateSoccerForwardCapture,
  soccerForwardHash, SOCCER_FORWARD_VERSION, SOCCER_FORWARD_POLICY } from './forward-validation.js';
import { evaluateSoccerMarketReturnCapture } from './market-return-validation.js';
import { fetchSoccerSettlementResult } from './settlement-result.js';
import { soccerDate, validSoccerDate } from './contracts.js';

export const SOCCER_FORWARD_COLLECTOR_VERSION = 'SOCCER-FORWARD-CAPTURE-RESULT-COLLECTOR-v1';

// Trusted background callers collect the entire activated protocol backlog.
// A rolling date window would permanently lose unchecked receipts as they age.
export async function collectSoccerForwardBacklog(options = {}) {
  return collectSoccerForwardResults(null, options);
}

function captureFrom(row, snapshot) {
  return { captureId: row.capture_id, captureSequence: String(row.capture_sequence), league: row.league,
    gameId: row.game_id, date: row.board_date, period: row.period, variant: row.variant,
    modelHash: row.model_hash, revision: row.analysis_revision,
    capturedAt: new Date(row.captured_at).toISOString(), snapshot };
}

// This collects individual physical receipts, NOT selected samples. Loading all
// reanalyses for a game before the first append can exceed every cron budget and
// restart the same game forever. Each append below is independently durable;
// canonical first-valid selection and conflicting-result quarantine still run
// over the complete immutable history in the existing report scanner.
export async function collectSoccerForwardResults(scope, { receiptLimit = 12, timeBudgetMs = 8000,
  capturePayloadBytes = SOCCER_FORWARD_READ_LIMITS.capturePayloadBytes, now = Date.now,
  query = soccerJournalQuery, ensure = ensureSoccerForwardProtocol,
  fetchResult = fetchSoccerSettlementResult, archive = archiveSoccerForwardCheck } = {}) {
  if (!Number.isInteger(receiptLimit) || receiptLimit < 1 || receiptLimit > 25
    || !Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0 || timeBudgetMs > 25000
    || !Number.isSafeInteger(capturePayloadBytes) || capturePayloadBytes < 1
    || capturePayloadBytes > SOCCER_FORWARD_READ_LIMITS.capturePayloadBytes) throw Error('SOCCER_FORWARD_COLLECTOR_BUDGET_INVALID');
  const started = now(), deadline = started + timeBudgetMs;
  let range = scope == null ? null : normalizeSoccerForwardScope(scope, started);
  const summary = { version: SOCCER_FORWARD_COLLECTOR_VERSION,
    sampleCountScope: 'PHYSICAL_ORIGINAL_CAPTURE_RECEIPTS_NOT_CANONICAL_GAMES',
    checkedCaptureReceipts: 0, evaluatedCaptureReceipts: 0, pendingCaptureReceipts: 0, failedCaptureReceipts: 0,
    sourceRequests: 0, loadedUniqueOriginals: 0, loadedOriginalPayloadBytes: 0,
    reasons: {}, persistence: 'DURABLE_APPEND_ONLY_DATABASE', budgetExhausted: false,
    receiptLimitReached: false, originalPayloadBudgetExhausted: false,
    complete: false, formalEligible: false, executable: false };
  const reason = value => { summary.reasons[value] = (summary.reasons[value] || 0) + 1; };
  await ensure();
  const protocol = await readSoccerForwardProtocol(query);
  if (!range) {
    range = { league: null, from: soccerDate(protocol.activatedAt), through: soccerDate(started) };
    if (!validSoccerDate(range.from) || range.through < range.from) throw Error('SOCCER_FORWARD_COLLECTOR_PROTOCOL_DATE_INVALID');
  }
  summary.requestedScope = range;
  if (now() >= deadline) { summary.budgetExhausted = true; return summary; }
  // Latest-check timestamps are a durable fair queue, never result authority.
  // Only metadata crosses this boundary. Original payloads are fetched one at a
  // time below, and each must pass the full revision/model/time/identity checks.
  // The canonical ISO comparison avoids casting corrupt JSON dates in SQL.
  const rows = await query(`SELECT c.capture_id,c.capture_sequence,c.league,c.game_id,c.board_date::text,
      c.period,c.variant,c.model_hash,c.analysis_revision,c.captured_at,
      octet_length(a.payload::text)::bigint AS payload_bytes
    FROM sports_soccer_forward_captures_v1 c
    LEFT JOIN sports_soccer_analysis_v1 a ON a.league=c.league AND a.game_id=c.game_id AND a.analysis_hash=c.analysis_revision
    LEFT JOIN LATERAL (SELECT checked_at,payload->>'status' AS status
      FROM sports_soccer_forward_result_checks_v1 k WHERE k.capture_id=c.capture_id
      ORDER BY checked_at DESC,check_id DESC LIMIT 1) latest ON true
    WHERE c.protocol_version=$1 AND ($2::text IS NULL OR c.league=$2)
      AND c.board_date BETWEEN $3::date AND $4::date
      AND (a.payload#>>'{evidence,game,startTime}' IS NULL
        OR a.payload#>>'{evidence,game,startTime}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        OR a.payload#>>'{evidence,game,startTime}'<$5)
      AND (latest.checked_at IS NULL OR latest.checked_at<=
        $6::timestamptz-CASE WHEN latest.status='EVALUATED' THEN $7::bigint ELSE $8::bigint END*interval '1 millisecond')
    ORDER BY latest.checked_at ASC NULLS FIRST,c.capture_sequence ASC LIMIT $9`,
  [SOCCER_FORWARD_VERSION, range.league, range.from, range.through, new Date(started).toISOString(), new Date(started).toISOString(),
    SOCCER_FORWARD_POLICY.settledResultRecheckIntervalMs, SOCCER_FORWARD_POLICY.resultCheckDedupWindowMs, receiptLimit + 1]);
  summary.receiptLimitReached = rows.length > receiptLimit;
  const originals = new Map(), results = new Map();
  for (const row of rows.slice(0, receiptLimit)) {
    if (now() >= deadline) { summary.budgetExhausted = true; break; }
    let capture = captureFrom(row), result = null, evaluation;
    const bytes = Number(row.payload_bytes), originalKey = JSON.stringify([row.league, row.game_id, row.analysis_revision]);
    if (!Number.isSafeInteger(bytes) || bytes < 1) evaluation = { status: 'PENDING', reason: 'FORWARD_ORIGINAL_SNAPSHOT_MISSING' };
    else if (bytes > capturePayloadBytes) evaluation = { status: 'PENDING', reason: 'FORWARD_ORIGINAL_PAYLOAD_BYTE_BUDGET' };
    else {
      if (!originals.has(originalKey)) {
        if (summary.loadedOriginalPayloadBytes + bytes > capturePayloadBytes) {
          summary.originalPayloadBudgetExhausted = true; break;
        }
        const loaded = await query(`SELECT payload FROM sports_soccer_analysis_v1
          WHERE league=$1 AND game_id=$2 AND analysis_hash=$3 AND octet_length(payload::text)<=$4`,
        [row.league, row.game_id, row.analysis_revision, capturePayloadBytes]);
        if (loaded.length !== 1) throw Error('SOCCER_FORWARD_COLLECTOR_ORIGINAL_READ_INCOMPLETE');
        originals.set(originalKey, loaded[0].payload);
        summary.loadedUniqueOriginals++;
        summary.loadedOriginalPayloadBytes += bytes;
      }
      capture = captureFrom(row, originals.get(originalKey));
      const verified = validateSoccerForwardCapture(capture, protocol, now());
      if (!verified.ok) evaluation = { status: 'PENDING', reason: verified.reason };
      else if (Date.parse(capture.snapshot.evidence.game.startTime) >= now())
        evaluation = { status: 'PENDING', reason: 'FORWARD_MATCH_NOT_STARTED' };
      else {
        // Never start a provider call after the budget. A completed call may
        // use the final milliseconds to archive its result before returning.
        if (now() >= deadline) { summary.budgetExhausted = true; break; }
        const game = capture.snapshot.evidence.game, context = { league: capture.league, gameId: capture.gameId,
          date: capture.date, startTime: game.startTime, teamIds: { home: game.home.id, away: game.away.id } }, key = soccerForwardHash(context);
        if (!results.has(key)) {
          try { result = await fetchResult(context, { now, timeoutMs: Math.max(1, Math.min(6000, deadline - now())) }); }
          catch { result = { ok: false, reason: 'FORWARD_RESULT_SOURCE_UNAVAILABLE' }; }
          results.set(key, result); summary.sourceRequests++;
        }
        result = results.get(key);
        evaluation = evaluateSoccerForwardCapture(capture, protocol, result, now());
        evaluation.marketReturnValidation = evaluateSoccerMarketReturnCapture({ capture, protocol, result, now: now() });
      }
    }
    // Invalid originals and unavailable sources append explicit pending
    // diagnostics too, so one bad receipt cannot starve every later receipt.
    // No result/sample is manufactured; a later report revalidates originals.
    try { await archive(capture, evaluation, result, { query, now: now() }); }
    catch { summary.failedCaptureReceipts++; reason('FORWARD_RESULT_PERSISTENCE_FAILED'); continue; }
    summary.checkedCaptureReceipts++;
    if (evaluation.status === 'EVALUATED') summary.evaluatedCaptureReceipts++;
    else { summary.pendingCaptureReceipts++; reason(evaluation.reason); }
  }
  summary.budgetExhausted ||= now() >= deadline;
  // A bounded collector cannot assert that a game, frozen report, or scope is
  // complete, even when this invocation found no due receipts.
  return summary;
}
