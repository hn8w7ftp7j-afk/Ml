import { createHash } from 'node:crypto';
import '../../reader/league-registry.js';
import '../../reader/soccer-teams.js';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { buildReaderSeenCapture, canonicalReaderSeenCapture } from '../reader-seen-capture.js';
import { deriveRawSeenSoccerHistory, reassembleRawSeenBatch, RAW_SEEN_DERIVATION_VERSION, RAW_SEEN_HISTORY_FLAGS } from './raw-seen-history.js';
import { compatibleRawHistoryAttemptSql } from './raw-seen-history-attempt-policy.js';

export const RAW_HISTORY_AUDIT_SCHEMA = 'soccer-raw-history-audit-v1';
export const RAW_HISTORY_AUDIT_FLAGS = Object.freeze({ ...RAW_SEEN_HISTORY_FLAGS, formalEligible: false,
  calibrationEligible: false, indexCoverage: 'NOT_VERIFIED' });
const MAX_BYTES = 10 * 1024 * 1024, TIME_MS = 25000, HASH = /^[a-f0-9]{64}$/;
const flags = RAW_HISTORY_AUDIT_FLAGS;
const failure = (code, status = 503) => Object.assign(Error(code), { code, status });
const check = (condition, code) => { if (!condition) throw failure(code); };
const sha = value => createHash('sha256').update(canonicalReaderSeenCapture(value)).digest('hex');
const exactTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(value) && Number.isFinite(Date.parse(value));
const integer = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const partNumbers = row => row.part_count === null && row.part_index === null || Number.isInteger(row.part_count)
  && row.part_count >= 1 && row.part_count <= 10000 && Number.isInteger(row.part_index) && row.part_index >= 0 && row.part_index < row.part_count;
const code = error => /^(?:RAW_HISTORY_AUDIT_|RAW_SEEN_RECOVERY_|READER_SEEN_CAPTURE_)[A-Z0-9_]+$/.test(error?.code || '')
  ? error.code : 'RAW_HISTORY_AUDIT_UNAVAILABLE';
let client;

export function parseRawSeenHistoryAuditQuery(params) {
  if ([...params.keys()].some(key => !['league', 'limit'].includes(key) || params.getAll(key).length !== 1))
    throw failure('RAW_HISTORY_AUDIT_QUERY_INVALID', 400);
  const league = params.get('league'), limit = params.get('limit') ?? '2';
  if (league !== null && !['EPL', 'UCL'].includes(league) || !/^[1-4]$/.test(limit))
    throw failure('RAW_HISTORY_AUDIT_QUERY_INVALID', 400);
  return { league, limit: Number(limit) };
}

function database(options) {
  if (options.db) return options.db;
  const url = durableDatabaseUrl();
  if (!url) throw failure('RAW_HISTORY_AUDIT_STORAGE_UNAVAILABLE');
  return client ||= neon(url);
}

// Every GET operation is SELECT-only. Server statement/lock limits and the
// HTTP AbortSignal bound each wait, without claiming server-side cancellation.
function reader(db, deadline, clock) {
  return async (sql, params = []) => {
    const remaining = deadline - clock();
    if (remaining <= 0) throw failure('RAW_HISTORY_AUDIT_TIME_BUDGET');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
    try {
      const timeout = String(Math.max(1, Math.min(5000, Math.floor(remaining / 3))));
      const rows = await db.transaction([
        db`SELECT set_config('statement_timeout',${timeout},true)`,
        db`SELECT set_config('lock_timeout',${timeout},true)`,
        db.query(sql, params),
      ], { fetchOptions: { signal: controller.signal } });
      if (clock() >= deadline) throw failure('RAW_HISTORY_AUDIT_TIME_BUDGET');
      return rows[2];
    } finally { clearTimeout(timer); }
  };
}

const sourceWhere = `r.league=$1 AND (r.capture_batch_id=$2::char(64) OR (r.capture_batch_id IS NULL AND r.capture_id=$2::char(64))) AND r.persisted_at<=$3::timestamptz`;
const metadataSql = `SELECT r.capture_id,r.evidence_hash,r.capture_batch_id,r.part_index,r.part_count,r.source_scope_hash,
  octet_length(r.evidence_json)::text AS source_bytes FROM sports_reader_seen_captures_v1 r
  WHERE ${sourceWhere} ORDER BY r.part_index NULLS FIRST,r.capture_id LIMIT 9`;

function expectedMetadata(rows) {
  check(Array.isArray(rows) && rows.length > 0 && rows.length <= 8, 'RAW_HISTORY_AUDIT_SOURCE_PARTS_UNAVAILABLE');
  const ids = [], sizes = [];
  for (const row of rows) {
    const id = row.capture_id?.trim(), hash = row.evidence_hash?.trim(), size = integer(row.source_bytes);
    check(HASH.test(id || '') && HASH.test(hash || '') && HASH.test(row.source_scope_hash?.trim() || '') && size !== null && size > 0 && size <= 600000,
      'RAW_HISTORY_AUDIT_METADATA_INVALID');
    ids.push(id); sizes.push(size);
  }
  check(new Set(ids).size === ids.length, 'RAW_HISTORY_AUDIT_METADATA_INVALID');
  return { ids: ids.sort(), bytes: sizes.reduce((a, b) => a + b, 0) };
}

function originalPart(row, selected) {
  let evidence;
  try { evidence = JSON.parse(row.evidence_json); } catch { throw failure('RAW_HISTORY_AUDIT_SOURCE_INTEGRITY'); }
  const built = buildReaderSeenCapture({ schema: 'READER-SEEN-CAPTURE-v1', captureId: row.capture_id?.trim(),
    evidenceHash: row.evidence_hash?.trim(), evidence }, { deviceId: 'readonly-source-audit', headerVersion: row.reader_version });
  const captureId = row.capture_id?.trim(), scopeHash = row.source_scope_hash?.trim();
  check(row.schema_version === 'READER-SEEN-CAPTURE-v1' && built.evidenceJson === row.evidence_json && built.sourceScopeHash === scopeHash
    && row.league === selected.league && evidence.league === selected.league && evidence.readerVersion === row.reader_version
    && exactTime(row.source_observed_at_exact) && new Date(row.source_observed_at_exact).toISOString() === evidence.observedAt
    && (row.page_activity_at_exact === null || exactTime(row.page_activity_at_exact))
    && (row.page_activity_at_exact === null ? null : new Date(row.page_activity_at_exact).toISOString()) === (evidence.pageActivityAt || null)
    && exactTime(row.received_at_exact) && exactTime(row.persisted_at_exact)
    && (row.capture_batch_id?.trim() || captureId) === selected.batch_hash.trim()
    && (row.capture_batch_id?.trim() || null) === (evidence.captureBatchId || null)
    && row.part_index === (evidence.partIndex ?? null) && row.part_count === (evidence.partCount ?? null)
    && ['tableCount', 'rowCount', 'cellCount', 'lockedRowCount'].every(field => built[field] === row[{
      tableCount: 'table_count', rowCount: 'row_count', cellCount: 'cell_count', lockedRowCount: 'locked_row_count' }[field]]),
  'RAW_HISTORY_AUDIT_SOURCE_INTEGRITY');
  return { captureId, evidenceHash: built.evidenceHash, evidence, league: evidence.league, readerVersion: evidence.readerVersion,
    observedAt: evidence.observedAt, captureBatchId: evidence.captureBatchId || null,
    partIndex: evidence.partIndex ?? null, partCount: evidence.partCount ?? null,
    receivedAt: row.received_at_exact, persistedAt: row.persisted_at_exact };
}

function sectionScopeSummary(evidence) {
  const registry = globalThis.Tai888LeagueRegistry;
  const summary = { basis: 'SOURCE_SECTION_LABELS_NOT_OFFICIAL_IDENTITY', matchingStandardTables: 0,
    matchingStandardRows: 0, excludedTables: 0, excludedRows: 0, unknownTables: 0, unknownRows: 0 };
  for (const table of evidence.tables) {
    const title = table.sectionTitle || '';
    const period = registry.soccerPeriodEvidence({ sectionTitle: title, headers: [], marketHeader: '',
      truncated: table.periodEvidenceTruncated === true });
    const identified = registry.identify(title);
    // A matching prefix cannot establish the complete scope of a truncated
    // title. Classify source labels only, never official match identity or
    // quote eligibility, and do not infer scope from a structured row shape.
    const key = table.periodEvidenceTruncated || title.length > 240 || ['TRUNCATED', 'CONFLICT'].includes(period.status) ? 'unknown'
      : registry.standardMarker(title, evidence.league) ? 'matchingStandard'
        : registry.excludedSoccerCompetition(title) || period.status === 'EXCLUDED'
          || identified && identified !== evidence.league ? 'excluded' : 'unknown';
    summary[`${key}Tables`]++;
    summary[`${key}Rows`] += table.rows.length;
  }
  return summary;
}

function layout(evidence) {
  const headers = new Map(), widths = new Map();
  let rowCount = 0, cellCount = 0, allSingle = true, anyHeaders = false;
  for (const table of evidence.tables) {
    const values = table.headers || [], key = canonicalReaderSeenCapture(values);
    headers.set(key, { values, tables: (headers.get(key)?.tables || 0) + 1 });
    anyHeaders ||= values.length > 0;
    for (const row of table.rows) {
      const width = row.cells.length; rowCount++; cellCount += width; allSingle &&= width === 1;
      widths.set(width, (widths.get(width) || 0) + 1);
    }
  }
  const allHeaders = [...headers.values()];
  const exposed = allHeaders.slice(0, 16).map(item => ({ values: item.values.slice(0, 16).map(value => value.slice(0, 120)),
    tables: item.tables, contentHash: sha(item.values), truncated: item.values.length > 16 || item.values.some(value => value.length > 120) }));
  return { classification: rowCount && allSingle && !anyHeaders ? 'FLAT_TEXT_ONLY'
    : anyHeaders || [...widths.keys()].some(value => value > 1) ? 'STRUCTURED_ROWS' : 'UNKNOWN',
  headers: exposed, headersTruncated: allHeaders.length > 16 || exposed.some(item => item.truncated),
  rowWidths: [...widths].sort((a, b) => a[0] - b[0]).map(([cells, rows]) => ({ cells, rows })), rowCount, cellCount,
  sectionScopeSummary: sectionScopeSummary(evidence) };
}

function unknownSample(selected, reason) {
  return { league: selected.league, captureId: selected.capture_id.trim(), captureBatchId: selected.batch_hash.trim(),
    sourceObservedAt: selected.source_observed_at, attemptReason: selected.reason, sampleEdge: selected.sample_edge,
    status: 'UNKNOWN', reason, classification: 'UNKNOWN', fragmentCount: null, fragmentManifest: [],
    headers: [], headersTruncated: false, rowWidths: [], rowCount: null, cellCount: null, sectionScopeSummary: null,
    replay: { status: 'UNKNOWN', reason, gameCount: null, marketCount: null }, siblings: [], siblingStatus: 'UNKNOWN',
    siblingScopeBasis: 'NEARBY_SAME_LEAGUE_READER_TIME_WINDOW', pageFrameVerified: false, sameCaptureVerified: false, ...flags };
}

export async function readRawSeenHistoryAudit(input, options = {}) {
  const filters = parseRawSeenHistoryAuditQuery(new URLSearchParams(Object.entries(input || {}).filter(([, value]) => value !== null).map(([key, value]) => [key, String(value)])));
  const now = options.now ?? Date.now(), until = new Date(now).toISOString(), clock = options.clock || Date.now;
  const timeBudgetMs = Math.min(TIME_MS, options.timeBudgetMs ?? TIME_MS), maxSourceBytes = Math.min(MAX_BYTES, options.maxSourceBytes ?? MAX_BYTES);
  check(Number.isSafeInteger(timeBudgetMs) && timeBudgetMs > 0 && Number.isSafeInteger(maxSourceBytes) && maxSourceBytes > 0, 'RAW_HISTORY_AUDIT_LIMIT_INVALID');
  const budget = { sourceBytesRead: 0, sourceBytesReserved: 0, maxSourceBytes, timeBudgetMs,
    sourceByteBasis: 'ORIGINAL_EVIDENCE_JSON_UTF8', budgetKind: 'SOFT_DEADLINE', hardDeadlineEnforced: false };
  const result = { ok: true, schema: RAW_HISTORY_AUDIT_SCHEMA, status: 'BOUNDED_SAMPLE', until, filters,
    selectionBasis: 'LEAGUE_REASON_OLDEST_NEWEST_SAMPLES', derivationVersion: RAW_SEEN_DERIVATION_VERSION,
    samples: [], budget, sampleCompletenessVerified: false, siblingCoverageVerified: false, ...flags };
  try {
    const read = reader(database(options), clock() + timeBudgetMs, clock);
    const selected = await read(`WITH attempts AS MATERIALIZED (
      SELECT DISTINCT ON (a.league,a.batch_hash) a.league,a.batch_hash,a.capture_id,a.reason,a.attempted_at
      FROM soccer_raw_seen_history_attempts_v1 a WHERE ${compatibleRawHistoryAttemptSql('a')} AND a.attempted_at<=$2::timestamptz
        AND a.status='SOURCE_UNINDEXED' AND a.league IN ('EPL','UCL') AND ($1::text IS NULL OR a.league=$1)
      ORDER BY a.league,a.batch_hash,(a.derivation_version=$3) DESC,a.attempted_at DESC,a.capture_id DESC
    ), candidates AS (
      SELECT a.*,r.source_observed_at FROM attempts a JOIN sports_reader_seen_captures_v1 r ON r.capture_id=a.capture_id AND r.league=a.league
        AND coalesce(r.capture_batch_id,r.capture_id)=a.batch_hash
      WHERE r.persisted_at<=$2::timestamptz AND NOT EXISTS (
        SELECT 1 FROM soccer_raw_seen_history_batches_v1 b WHERE b.league=a.league AND b.batch_hash=a.batch_hash
          AND b.derivation_version=$3 AND b.indexed_at<=$2::timestamptz AND NOT EXISTS (
            SELECT 1 FROM sports_reader_seen_captures_v1 fragment WHERE fragment.league=a.league
              AND coalesce(fragment.capture_batch_id,fragment.capture_id)=a.batch_hash AND fragment.persisted_at<=$2::timestamptz
              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.metadata->'parts')='array' THEN b.metadata->'parts' ELSE '[]'::jsonb END) p
                WHERE p->>'captureId'=btrim(fragment.capture_id))))
    ), ranked AS (SELECT *,row_number() OVER(PARTITION BY league,reason ORDER BY source_observed_at,batch_hash) AS oldest,
      row_number() OVER(PARTITION BY league,reason ORDER BY source_observed_at DESC,batch_hash DESC) AS newest FROM candidates),
    strata AS (SELECT *,CASE WHEN oldest=1 THEN 'OLDEST' ELSE 'NEWEST' END AS sample_edge,
      row_number() OVER(PARTITION BY league ORDER BY CASE WHEN oldest=1 THEN 0 ELSE 1 END,reason,batch_hash) AS league_rank
      FROM ranked WHERE oldest=1 OR newest=1)
    SELECT league,btrim(batch_hash) AS batch_hash,btrim(capture_id) AS capture_id,reason,sample_edge,
      to_char(source_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_observed_at
      FROM strata ORDER BY league_rank,league,reason,batch_hash LIMIT $4`, [filters.league, until, RAW_SEEN_DERIVATION_VERSION, filters.limit]);
    check(Array.isArray(selected) && selected.length <= filters.limit, 'RAW_HISTORY_AUDIT_METADATA_INVALID');
    for (const item of selected) {
      check(['EPL', 'UCL'].includes(item.league) && (!filters.league || filters.league === item.league)
        && HASH.test(item.capture_id || '') && HASH.test(item.batch_hash || '') && exactTime(item.source_observed_at)
        && /^(?:RAW_HISTORY_INDEX_|RAW_SEEN_RECOVERY_)[A-Z0-9_]+$/.test(item.reason || '') && ['OLDEST', 'NEWEST'].includes(item.sample_edge),
      'RAW_HISTORY_AUDIT_METADATA_INVALID');
      const sample = unknownSample(item, 'RAW_HISTORY_AUDIT_UNAVAILABLE'); result.samples.push(sample);
      try {
        const metaRows = await read(metadataSql, [item.league, item.batch_hash, until]);
        const meta = expectedMetadata(metaRows), remaining = maxSourceBytes - budget.sourceBytesReserved;
        check(meta.bytes <= remaining, 'RAW_HISTORY_AUDIT_BYTE_BUDGET');
        // Reserve the complete source request before dispatch. A timed-out SQL
        // response may still have loaded data server-side; later samples cannot
        // reuse that allowance or claim cancellation of the original read.
        budget.sourceBytesReserved += meta.bytes;
        // Recheck the exact manifest and total bytes in the payload statement.
        // A concurrent late fragment cannot bypass the metadata-first budget.
        const envelope = (await read(`WITH eligible AS MATERIALIZED (
          SELECT r.capture_id,octet_length(r.evidence_json)::bigint AS bytes FROM sports_reader_seen_captures_v1 r WHERE ${sourceWhere}
        ), bounds AS (SELECT count(*)::int AS n,coalesce(sum(bytes),0)::bigint AS bytes,
          coalesce(jsonb_agg(btrim(capture_id) ORDER BY capture_id),'[]'::jsonb) AS ids FROM eligible)
        SELECT n,bytes::text,ids,CASE WHEN n BETWEEN 1 AND 8 AND bytes=$4::bigint AND ids=$5::jsonb THEN (
          SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object(
            'source_observed_at_exact',to_char(r.source_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'page_activity_at_exact',CASE WHEN r.page_activity_at IS NULL THEN NULL ELSE to_char(r.page_activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
            'received_at_exact',to_char(r.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'persisted_at_exact',to_char(r.persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY r.part_index NULLS FIRST,r.capture_id)
          FROM sports_reader_seen_captures_v1 r JOIN eligible e USING(capture_id)) ELSE NULL END AS items FROM bounds`,
        [item.league, item.batch_hash, until, meta.bytes, JSON.stringify(meta.ids)]))[0];
        check(envelope && integer(envelope.bytes) !== null && Array.isArray(envelope.ids), 'RAW_HISTORY_AUDIT_METADATA_INVALID');
        check(envelope.bytes <= remaining, 'RAW_HISTORY_AUDIT_BYTE_BUDGET');
        check(Array.isArray(envelope.items) && envelope.n === meta.ids.length && canonicalReaderSeenCapture(envelope.ids) === canonicalReaderSeenCapture(meta.ids),
          'RAW_HISTORY_AUDIT_SOURCE_CHANGED');
        budget.sourceBytesRead += Number(envelope.bytes);
        const rawBytes = envelope.items.reduce((n, row) => n + Buffer.byteLength(row.evidence_json || ''), 0);
        check(rawBytes === Number(envelope.bytes) && Number(envelope.bytes) === meta.bytes, 'RAW_HISTORY_AUDIT_SOURCE_CHANGED');
        const parts = envelope.items.map(row => originalPart(row, item)), restored = reassembleRawSeenBatch(parts);
        Object.assign(sample, layout(restored.evidence), { status: 'VERIFIED_SOURCE', reason: null, fragmentCount: parts.length,
          fragmentManifest: parts.map(({ captureId, evidenceHash, partIndex, partCount, receivedAt, persistedAt }) => ({
            captureId, evidenceHash, partIndex: partIndex ?? 0, partCount: partCount ?? 1, receivedAt, persistedAt })) });
        try {
          const replay = deriveRawSeenSoccerHistory(parts, { now });
          sample.replay = { status: 'RECOVERABLE', reason: null, gameCount: replay.games.length,
            marketCount: replay.games.reduce((n, game) => n + game.markets.length, 0) };
        } catch (error) {
          sample.replay = { status: [422, 413].includes(error?.status) ? 'SOURCE_UNINDEXED' : 'UNKNOWN', reason: code(error), gameCount: null, marketCount: null };
        }
        try {
          const siblings = await read(`SELECT btrim(r.capture_id) AS capture_id,
            to_char(r.source_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
            r.row_count,r.cell_count,r.part_index,r.part_count FROM sports_reader_seen_captures_v1 r
            WHERE r.league=$1 AND r.reader_version=$2 AND r.source_observed_at BETWEEN $3::timestamptz-interval '2 seconds' AND $3::timestamptz+interval '2 seconds'
              AND r.persisted_at<=$4::timestamptz AND coalesce(r.capture_batch_id,r.capture_id)<>$5::char(64)
            ORDER BY abs(extract(epoch FROM r.source_observed_at-$3::timestamptz)),r.source_observed_at,r.capture_id LIMIT 2`,
          [item.league, restored.evidence.readerVersion, item.source_observed_at, until, item.batch_hash]);
          check(Array.isArray(siblings) && siblings.length <= 2 && siblings.every(row => HASH.test(row.capture_id) && exactTime(row.observed_at)
            && integer(row.row_count) !== null && integer(row.cell_count) !== null && partNumbers(row)
            && !meta.ids.includes(row.capture_id)), 'RAW_HISTORY_AUDIT_METADATA_INVALID');
          sample.siblings = siblings.map(row => ({ captureId: row.capture_id, observedAt: row.observed_at,
            rowCount: Number(row.row_count), cellCount: Number(row.cell_count), partIndex: row.part_index, partCount: row.part_count }));
          sample.siblingStatus = 'VERIFIED_METADATA_ONLY';
        } catch (error) { sample.siblingReason = code(error); }
      } catch (error) { Object.assign(sample, unknownSample(item, code(error))); }
    }
    return result;
  } catch (error) {
    return { ...result, ok: false, status: 'UNKNOWN', reason: error?.code === '42P01' ? 'RAW_HISTORY_AUDIT_NOT_INITIALIZED' : code(error) };
  }
}
