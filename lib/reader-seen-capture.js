import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';

export const READER_SEEN_CAPTURE_SCHEMA = 'READER-SEEN-CAPTURE-v1';
export const READER_SEEN_CAPTURE_TABLE = 'sports_reader_seen_captures_v1';
export const READER_SEEN_CAPTURE_LEAGUES = Object.freeze(['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL', 'EPL', 'UCL']);
export const READER_SEEN_CAPTURE_MAX_BYTES = 600_000;
export const READER_SEEN_CAPTURE_REASONS = Object.freeze(['PRE_NORMALIZATION', 'MUTATION', 'SCAN', 'BEFORE_SELECTION', 'SOURCE_PARTIAL']);
const FLAGS = Object.freeze({ archiveOnly: true, currentBoardUpdated: false,
  historicalAvailabilityVerified: false, executable: false, coverageComplete: false });
const HASH = /^[a-f0-9]{64}$/;
const PRIVATE = /(?:password|passwd|cookie|session|secret|authorization|bearer|account|balance|username|user[ _-]?id|private[ _-]?key|\bmember\b|\bcredit\b|帳號|账号|帳戶|账户|餘額|余额|額度|额度|登入|登录|密碼|密码|會員|会员|用戶名|用户名|(?:^|[^a-z])token(?:[^a-z]|$)|https?:|[<>=@\\]|[A-Za-z0-9_-]{40,})/i;
const COUNT_FIELDS = ['recordCount', 'headerCount', 'candidateRows', 'gameCount', 'pairedRows', 'singleRows',
  'expectedGameCount', 'rootCount', 'candidateElementCount', 'acceptedRecordCount', 'skippedAlternativeCount', 'sectionCount', 'mutationAgeSeconds'];
const BOOL_FIELDS = ['sawLeagueMarker', 'wrongPeriodHeader'];
const TIME_FIELDS = ['lastMutationAt', 'activityAt'];
const schemas = new WeakMap();
let sqlClient;
const error = (code, status = 422) => Object.assign(new Error(code), { code, status });
const assert = (condition, code, status) => { if (!condition) throw error(code, status); };
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
const digest = value => createHash('sha256').update(value).digest('hex');
const stamp = value => value == null || !Number.isFinite(new Date(value).getTime()) ? null : new Date(value).toISOString();
function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/.test(value)
    && date(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function keys(value, allowed, code = 'READER_SEEN_CAPTURE_FIELDS_INVALID') {
  assert(object(value) && Object.keys(value).every(key => allowed.includes(key)), code);
}
function array(value, max, code = 'READER_SEEN_CAPTURE_TOO_LARGE') {
  assert(Array.isArray(value), 'READER_SEEN_CAPTURE_SHAPE_INVALID');
  assert(value.length <= max, code, 413);
}
function sportText(value, max = 65536) {
  assert(typeof value === 'string', 'READER_SEEN_CAPTURE_TEXT_INVALID');
  assert(value.length <= max, 'READER_SEEN_CAPTURE_TOO_LARGE', 413);
  // Fields are already sport-scoped by the content script. Refuse account or
  // DOM/export text instead of dropping or rewriting a captured cell silently.
  assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !PRIVATE.test(privacyScan(value)), 'READER_SEEN_CAPTURE_PRIVATE_TEXT');
}
function privacyScan(value) {
  let scan = value.normalize('NFKC').replace(/\p{Cf}/gu, '');
  for (let attempt = 0; attempt < 4 && /%[a-f0-9]{2}/i.test(scan); attempt += 1) {
    try { scan = decodeURIComponent(scan).normalize('NFKC').replace(/\p{Cf}/gu, ''); }
    catch { throw error('READER_SEEN_CAPTURE_PRIVATE_TEXT'); }
  }
  assert(!/%[a-f0-9]{2}/i.test(scan), 'READER_SEEN_CAPTURE_PRIVATE_TEXT');
  return scan;
}
function safeSource(evidence) {
  assert(typeof evidence.sourceHost === 'string' && /^(?:[a-z0-9-]+\.)*tai888\.in$/.test(evidence.sourceHost), 'READER_SEEN_CAPTURE_SOURCE_INVALID');
  for (const field of ['pageUrl', 'frameUrl']) {
    if (field === 'frameUrl' && !Object.hasOwn(evidence, field)) continue;
    const value = evidence[field];
    assert(typeof value === 'string' && value.length <= 500, 'READER_SEEN_CAPTURE_SOURCE_INVALID');
    let url;
    try { url = new URL(value); } catch { throw error('READER_SEEN_CAPTURE_SOURCE_INVALID'); }
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search
      && /^(?:[a-z0-9-]+\.)*tai888\.in$/.test(url.hostname)
      && (field !== 'pageUrl' || url.hostname === evidence.sourceHost)
      && (!url.hash || /^#\/(?:BS|BB|FT)$/.test(url.hash))
      && !PRIVATE.test(privacyScan(url.pathname)),
    'READER_SEEN_CAPTURE_SOURCE_INVALID');
  }
}

// JSON dictionary key order is not evidence. Array order, whitespace inside
// sport strings, numeric values and every allow-listed field are evidence.
export function canonicalReaderSeenCapture(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalReaderSeenCapture).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalReaderSeenCapture(value[key])}`).join(',')}}`;
  assert(value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value),
    'READER_SEEN_CAPTURE_JSON_INVALID');
  return JSON.stringify(value);
}

function validateEvidence(evidence) {
  keys(evidence, ['version', 'league', 'readerVersion', 'sourceHost', 'pageUrl', 'frameUrl', 'observedAt', 'pageActivityAt',
    'pageLeagueLabel', 'tables', 'captureReasons', 'completeCapture', 'diagnostics', 'captureBatchId', 'partIndex', 'partCount']);
  assert(READER_SEEN_CAPTURE_LEAGUES.includes(evidence.league), 'READER_SEEN_CAPTURE_LEAGUE_INVALID');
  assert(/^TAI888-DOM-CAPTURE-v2\.[12]\.0$/.test(evidence.version || ''), 'READER_SEEN_CAPTURE_VERSION_INVALID', 426);
  assert(typeof evidence.readerVersion === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(evidence.readerVersion), 'READER_SEEN_CAPTURE_VERSION_INVALID', 426);
  assert(timestamp(evidence.observedAt) && (!Object.hasOwn(evidence, 'pageActivityAt') || evidence.pageActivityAt === null || timestamp(evidence.pageActivityAt)), 'READER_SEEN_CAPTURE_TIME_INVALID');
  // No freshness, date, unique-game or valid-price gate: rejected, old, locked,
  // conflicting and partially parsed sport evidence belongs in this archive.
  safeSource(evidence);
  if (Object.hasOwn(evidence, 'pageLeagueLabel')) sportText(evidence.pageLeagueLabel);
  if (Object.hasOwn(evidence, 'completeCapture')) assert(typeof evidence.completeCapture === 'boolean', 'READER_SEEN_CAPTURE_SHAPE_INVALID');
  if (Object.hasOwn(evidence, 'captureReasons')) {
    array(evidence.captureReasons, READER_SEEN_CAPTURE_REASONS.length);
    assert(evidence.captureReasons.every(reason => READER_SEEN_CAPTURE_REASONS.includes(reason))
      && new Set(evidence.captureReasons).size === evidence.captureReasons.length, 'READER_SEEN_CAPTURE_REASONS_INVALID');
  }
  const partFields = ['captureBatchId', 'partIndex', 'partCount'];
  if (partFields.some(field => Object.hasOwn(evidence, field))) assert(partFields.every(field => Object.hasOwn(evidence, field))
    && typeof evidence.captureBatchId === 'string' && HASH.test(evidence.captureBatchId)
    && Number.isInteger(evidence.partCount) && evidence.partCount >= 1 && evidence.partCount <= 10000
    && Number.isInteger(evidence.partIndex) && evidence.partIndex >= 0 && evidence.partIndex < evidence.partCount,
  'READER_SEEN_CAPTURE_PART_INVALID');
  array(evidence.tables, 128);
  let rowCount = 0, cellCount = 0, lockedRowCount = 0;
  for (const table of evidence.tables) {
    keys(table, ['sectionTitle', 'headers', 'periodEvidenceTruncated', 'rows']);
    if (Object.hasOwn(table, 'sectionTitle')) sportText(table.sectionTitle);
    if (Object.hasOwn(table, 'headers')) { array(table.headers, 128); table.headers.forEach(header => sportText(header)); }
    if (Object.hasOwn(table, 'periodEvidenceTruncated')) assert(typeof table.periodEvidenceTruncated === 'boolean', 'READER_SEEN_CAPTURE_SHAPE_INVALID');
    array(table.rows, 1000);
    rowCount += table.rows.length;
    for (const row of table.rows) {
      keys(row, ['marketLocked', 'cells']);
      if (Object.hasOwn(row, 'marketLocked')) assert(typeof row.marketLocked === 'boolean', 'READER_SEEN_CAPTURE_SHAPE_INVALID');
      if (row.marketLocked === true) lockedRowCount += 1;
      array(row.cells, 128); cellCount += row.cells.length;
      for (const cell of row.cells) { keys(cell, ['pair']); array(cell.pair, 4096); cell.pair.forEach(value => sportText(value)); }
    }
  }
  if (Object.hasOwn(evidence, 'diagnostics')) {
    keys(evidence.diagnostics, [...COUNT_FIELDS, ...BOOL_FIELDS, ...TIME_FIELDS, 'tableIssues', 'conflictingGameKeys']);
    for (const field of COUNT_FIELDS) if (Object.hasOwn(evidence.diagnostics, field)) assert(evidence.diagnostics[field] === null
      || Number.isSafeInteger(evidence.diagnostics[field]) && evidence.diagnostics[field] >= 0 && evidence.diagnostics[field] <= 10_000_000, 'READER_SEEN_CAPTURE_DIAGNOSTICS_INVALID');
    for (const field of BOOL_FIELDS) if (Object.hasOwn(evidence.diagnostics, field)) assert(typeof evidence.diagnostics[field] === 'boolean', 'READER_SEEN_CAPTURE_DIAGNOSTICS_INVALID');
    for (const field of TIME_FIELDS) if (Object.hasOwn(evidence.diagnostics, field)) assert(evidence.diagnostics[field] === null
      || evidence.diagnostics[field] === '' || timestamp(evidence.diagnostics[field]), 'READER_SEEN_CAPTURE_DIAGNOSTICS_INVALID');
    for (const field of ['tableIssues', 'conflictingGameKeys']) if (Object.hasOwn(evidence.diagnostics, field)) {
      array(evidence.diagnostics[field], 1000); evidence.diagnostics[field].forEach(value => sportText(value, 1024));
    }
  }
  return { tableCount: evidence.tables.length, rowCount, cellCount, lockedRowCount };
}

export function buildReaderSeenCapture(input, { deviceId, headerVersion } = {}) {
  keys(input, ['schema', 'evidence', 'captureId', 'evidenceHash']);
  assert(input.schema === READER_SEEN_CAPTURE_SCHEMA, 'READER_SEEN_CAPTURE_SCHEMA_INVALID');
  assert(/^[a-zA-Z0-9._:-]{8,100}$/.test(deviceId || ''), 'READER_SEEN_CAPTURE_AUTH_INVALID', 401);
  assert(object(input.evidence), 'READER_SEEN_CAPTURE_SHAPE_INVALID');
  assert(Buffer.byteLength(JSON.stringify(input.evidence), 'utf8') <= READER_SEEN_CAPTURE_MAX_BYTES, 'READER_SEEN_CAPTURE_TOO_LARGE', 413);
  const counts = validateEvidence(input.evidence);
  assert(input.evidence.readerVersion === headerVersion, 'READER_SEEN_CAPTURE_VERSION_INVALID', 426);
  const evidenceJson = canonicalReaderSeenCapture(input.evidence);
  assert(Buffer.byteLength(evidenceJson, 'utf8') <= READER_SEEN_CAPTURE_MAX_BYTES, 'READER_SEEN_CAPTURE_TOO_LARGE', 413);
  const evidenceHash = digest(evidenceJson), captureId = digest(canonicalReaderSeenCapture({ schema: READER_SEEN_CAPTURE_SCHEMA, evidence: input.evidence }));
  if (Object.hasOwn(input, 'evidenceHash')) assert(input.evidenceHash === evidenceHash, 'READER_SEEN_CAPTURE_HASH_MISMATCH');
  if (Object.hasOwn(input, 'captureId')) assert(input.captureId === captureId, 'READER_SEEN_CAPTURE_ID_MISMATCH');
  return { captureId, evidenceHash, evidenceJson, sourceScopeHash: sourceScopeHash(input.evidence), evidence: JSON.parse(evidenceJson), ...counts };
}
function sourceScopeHash(evidence) {
  return digest(canonicalReaderSeenCapture({ league: evidence.league, version: evidence.version, readerVersion: evidence.readerVersion,
    sourceHost: evidence.sourceHost, pageUrl: evidence.pageUrl, frameUrl: evidence.frameUrl ?? null,
    observedAt: evidence.observedAt, pageActivityAt: evidence.pageActivityAt ?? null }));
}

async function database(options) {
  if (options.sql) return options.sql;
  const env = options.env ?? process.env;
  if (!durableDatabaseConfigured(env)) throw error('READER_SEEN_CAPTURE_DATABASE_UNAVAILABLE', 503);
  return sqlClient ||= neon(durableDatabaseUrl(env));
}
async function ensureSchema(sql) {
  if (!schemas.has(sql)) {
    const pending = sql.transaction([
      sql`SELECT pg_advisory_xact_lock(hashtextextended('reader-seen-capture-schema-v1', 0))`,
      sql`CREATE TABLE IF NOT EXISTS sports_reader_seen_captures_v1 (
        capture_id CHAR(64) PRIMARY KEY, schema_version VARCHAR(40) NOT NULL CHECK(schema_version='READER-SEEN-CAPTURE-v1'),
        league VARCHAR(5) NOT NULL CHECK(league IN ('MLB','NPB','KBO','CPBL','NBA','NHL','EPL','UCL')),
        source_observed_at TIMESTAMPTZ NOT NULL, page_activity_at TIMESTAMPTZ,
        evidence_hash CHAR(64) NOT NULL, evidence_json TEXT NOT NULL, source_scope_hash CHAR(64) NOT NULL, reader_version VARCHAR(30) NOT NULL,
        table_count INTEGER NOT NULL, row_count INTEGER NOT NULL, cell_count INTEGER NOT NULL, locked_row_count INTEGER NOT NULL,
        capture_batch_id CHAR(64), part_index INTEGER, part_count INTEGER,
        received_at TIMESTAMPTZ NOT NULL, persisted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CHECK(octet_length(evidence_json)<=600000), CHECK(jsonb_typeof(evidence_json::jsonb)='object'),
        CHECK(table_count>=0 AND row_count>=0 AND cell_count>=0 AND locked_row_count>=0),
        CHECK((capture_batch_id IS NULL AND part_index IS NULL AND part_count IS NULL) OR
          (capture_batch_id IS NOT NULL AND part_count BETWEEN 1 AND 10000 AND part_index>=0 AND part_index<part_count))
      )`,
      sql`CREATE INDEX IF NOT EXISTS sports_reader_seen_captures_scope_v1 ON sports_reader_seen_captures_v1(league,source_observed_at DESC)`,
      sql`CREATE INDEX IF NOT EXISTS sports_reader_seen_captures_batch_v1 ON sports_reader_seen_captures_v1(league,capture_batch_id,part_index) WHERE capture_batch_id IS NOT NULL`,
      sql`CREATE INDEX IF NOT EXISTS sports_reader_seen_captures_persisted_v1 ON sports_reader_seen_captures_v1(persisted_at DESC)`,
      sql`CREATE OR REPLACE FUNCTION reject_reader_seen_capture_mutation_v1() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'READER_SEEN_CAPTURE_IMMUTABLE'; END $$`,
      sql`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='sports_reader_seen_captures_immutable_v1'
        AND tgrelid='sports_reader_seen_captures_v1'::regclass) THEN
        CREATE TRIGGER sports_reader_seen_captures_immutable_v1 BEFORE UPDATE OR DELETE ON sports_reader_seen_captures_v1
        FOR EACH ROW EXECUTE FUNCTION reject_reader_seen_capture_mutation_v1(); END IF; END $$`,
    ], { isolationLevel: 'ReadCommitted' }).catch(cause => { schemas.delete(sql); throw cause; });
    schemas.set(sql, pending);
  }
  await schemas.get(sql);
}
function verifyRow(row, expected = null) {
  let evidence;
  try { evidence = JSON.parse(row?.evidence_json); } catch { throw error('READER_SEEN_CAPTURE_READBACK_FAILED', 503); }
  let counts;
  try { counts = validateEvidence(evidence); } catch { throw error('READER_SEEN_CAPTURE_READBACK_FAILED', 503); }
  const evidenceHash = digest(canonicalReaderSeenCapture(evidence));
  const captureId = digest(canonicalReaderSeenCapture({ schema: READER_SEEN_CAPTURE_SCHEMA, evidence }));
  assert(row.schema_version === READER_SEEN_CAPTURE_SCHEMA && row.capture_id?.trim() === captureId
    && row.evidence_hash?.trim() === evidenceHash && row.evidence_json === canonicalReaderSeenCapture(evidence)
    && row.source_scope_hash?.trim() === sourceScopeHash(evidence)
    && row.league === evidence.league && stamp(row.source_observed_at) === evidence.observedAt
    && stamp(row.page_activity_at) === (evidence.pageActivityAt || null) && row.reader_version === evidence.readerVersion
    && Object.entries(counts).every(([field, value]) => row[{ tableCount: 'table_count', rowCount: 'row_count', cellCount: 'cell_count', lockedRowCount: 'locked_row_count' }[field]] === value)
    && (row.capture_batch_id?.trim() || null) === (evidence.captureBatchId || null)
    && row.part_index === (evidence.partIndex ?? null) && row.part_count === (evidence.partCount ?? null)
    && timestamp(stamp(row.received_at)) && timestamp(stamp(row.persisted_at))
    && (!expected || expected.captureId === captureId && expected.evidenceHash === evidenceHash), 'READER_SEEN_CAPTURE_READBACK_FAILED', 503);
  return { captureId, evidenceHash, league: evidence.league, observedAt: evidence.observedAt,
    pageActivityAt: evidence.pageActivityAt || null, readerVersion: evidence.readerVersion, ...counts,
    captureReasons: evidence.captureReasons || [], completeCapture: evidence.completeCapture === true,
    captureBatchId: evidence.captureBatchId || null, partIndex: evidence.partIndex ?? null, partCount: evidence.partCount ?? null,
    receivedAt: stamp(row.received_at), persistedAt: stamp(row.persisted_at), status: 'EVIDENCE_UNVERIFIED', evidenceStatus: 'EVIDENCE_UNVERIFIED', evidence };
}
// Initialize storage without inventing an observed capture. The authenticated
// inventory route can activate a fresh deployment before its first Reader POST.
export async function initializeReaderSeenCaptureStore(options = {}) {
  await ensureSchema(await database(options));
}
export async function saveReaderSeenCapture(input, options = {}) {
  const capture = buildReaderSeenCapture(input, options), sql = await database(options);
  const receivedAt = new Date(options.now ?? Date.now()).toISOString();
  assert(timestamp(receivedAt), 'READER_SEEN_CAPTURE_TIME_INVALID');
  await ensureSchema(sql);
  const evidence = capture.evidence;
  await sql`INSERT INTO sports_reader_seen_captures_v1
    (capture_id,schema_version,league,source_observed_at,page_activity_at,evidence_hash,evidence_json,source_scope_hash,reader_version,
      table_count,row_count,cell_count,locked_row_count,capture_batch_id,part_index,part_count,received_at)
    VALUES(${capture.captureId},${READER_SEEN_CAPTURE_SCHEMA},${evidence.league},${evidence.observedAt}::timestamptz,
      ${evidence.pageActivityAt || null}::timestamptz,${capture.evidenceHash},${capture.evidenceJson},${capture.sourceScopeHash},${evidence.readerVersion},
      ${capture.tableCount},${capture.rowCount},${capture.cellCount},${capture.lockedRowCount},${evidence.captureBatchId || null},
      ${evidence.partIndex ?? null},${evidence.partCount ?? null},${receivedAt}::timestamptz) ON CONFLICT(capture_id) DO NOTHING`;
  const rows = await sql`SELECT capture_id,schema_version,league,source_observed_at,page_activity_at,evidence_hash,evidence_json,source_scope_hash,reader_version,
    table_count,row_count,cell_count,locked_row_count,capture_batch_id,part_index,part_count,received_at,persisted_at
    FROM sports_reader_seen_captures_v1 WHERE capture_id=${capture.captureId}`;
  const { evidence: ignored, ...receipt } = verifyRow(rows?.[0], capture);
  return { ok: true, durable: true, schema: READER_SEEN_CAPTURE_SCHEMA, ...FLAGS, ...receipt };
}

export function parseReaderSeenCaptureQuery(params) {
  for (const key of params.keys()) assert(['league', 'limit', 'captureId'].includes(key) && params.getAll(key).length === 1, 'READER_SEEN_CAPTURE_QUERY_INVALID', 400);
  const league = params.get('league'), captureId = params.get('captureId'), limit = params.get('limit') ?? '20';
  assert((league === null || READER_SEEN_CAPTURE_LEAGUES.includes(league)) && /^[1-9]\d{0,2}$/.test(limit) && Number(limit) <= 100
    && (captureId === null || HASH.test(captureId)) && (!captureId || league === null && !params.has('limit')), 'READER_SEEN_CAPTURE_QUERY_INVALID', 400);
  return { league, captureId, limit: Number(limit) };
}
function number(value) { const parsed = Number(value); assert(value !== null && Number.isSafeInteger(parsed) && parsed >= 0, 'READER_SEEN_CAPTURE_SUMMARY_INVALID', 503); return parsed; }
export async function listReaderSeenCaptures(query = {}, options = {}) {
  const sql = await database(options);
  try {
    if (query.captureId) {
      const rows = await sql`SELECT capture_id,schema_version,league,source_observed_at,page_activity_at,evidence_hash,evidence_json,source_scope_hash,reader_version,
        table_count,row_count,cell_count,locked_row_count,capture_batch_id,part_index,part_count,received_at,persisted_at
        FROM sports_reader_seen_captures_v1 WHERE capture_id=${query.captureId}`;
      assert(rows?.[0], 'READER_SEEN_CAPTURE_NOT_FOUND', 404);
      return { ok: true, durable: true, schema: READER_SEEN_CAPTURE_SCHEMA, ...FLAGS, capture: verifyRow(rows[0]) };
    }
    const league = query.league || null, limit = query.limit || 20;
    const results = await sql`WITH filtered AS MATERIALIZED (
      SELECT capture_id,league,source_observed_at,persisted_at,received_at,table_count,row_count,locked_row_count,
        capture_batch_id,part_index,part_count,source_scope_hash
      FROM sports_reader_seen_captures_v1 WHERE (${league}::text IS NULL OR league=${league})
    ), batches AS (
      SELECT league,capture_batch_id,count(*) AS observations,count(DISTINCT part_index) AS received_parts,
        min(part_count) AS min_parts,max(part_count) AS max_parts,count(DISTINCT source_scope_hash) AS source_scopes
      FROM filtered WHERE capture_batch_id IS NOT NULL GROUP BY league,capture_batch_id
    ), batch_summary AS (
      SELECT league,count(*) AS received_part_groups,
        count(*) FILTER(WHERE min_parts=max_parts AND received_parts=max_parts AND observations=received_parts AND source_scopes=1) AS complete_part_groups,
        count(*) FILTER(WHERE min_parts=max_parts AND received_parts<max_parts AND observations=received_parts AND source_scopes=1) AS pending_part_groups,
        count(*) FILTER(WHERE min_parts<>max_parts OR observations<>received_parts OR source_scopes<>1) AS conflicting_part_groups
      FROM batches GROUP BY league
    ), summary AS (
      SELECT league,count(*) AS capture_count,sum(table_count) AS table_count,sum(row_count) AS row_count,sum(locked_row_count) AS locked_row_count,
        min(source_observed_at) AS first_observed_at,max(source_observed_at) AS last_observed_at,max(received_at) AS last_received_at,
        max(persisted_at) AS last_persisted_at FROM filtered GROUP BY league
    ), recent_keys AS (
      SELECT capture_id FROM filtered ORDER BY source_observed_at DESC,persisted_at DESC,capture_id LIMIT ${limit}
    ), recent AS (
      SELECT archive.* FROM sports_reader_seen_captures_v1 AS archive JOIN recent_keys USING(capture_id)
    ) SELECT
      (SELECT coalesce(jsonb_agg(to_jsonb(summary)||jsonb_build_object(
        'received_part_groups',coalesce(b.received_part_groups,0),'complete_part_groups',coalesce(b.complete_part_groups,0),
        'pending_part_groups',coalesce(b.pending_part_groups,0),'conflicting_part_groups',coalesce(b.conflicting_part_groups,0)) ORDER BY summary.league),'[]'::jsonb)
        FROM summary LEFT JOIN batch_summary b USING(league)) AS leagues,
      (SELECT coalesce(jsonb_agg(to_jsonb(recent) ORDER BY source_observed_at DESC,persisted_at DESC,capture_id),'[]'::jsonb) FROM recent) AS recent`;
    const envelope = results?.[0];
    assert(envelope && Array.isArray(envelope.leagues) && Array.isArray(envelope.recent), 'READER_SEEN_CAPTURE_SUMMARY_INVALID', 503);
    const indexed = new Map(envelope.leagues.map(row => [row.league, row]));
    assert(indexed.size === envelope.leagues.length && envelope.leagues.every(row => READER_SEEN_CAPTURE_LEAGUES.includes(row.league)), 'READER_SEEN_CAPTURE_SUMMARY_INVALID', 503);
    const leagues = (league ? [league] : READER_SEEN_CAPTURE_LEAGUES).map(id => {
      const row = indexed.get(id);
      if (!row) return { league: id, captureCount: 0, tableCount: 0, rowCount: 0, lockedRowCount: 0,
        receivedPartGroups: 0, completePartGroups: 0, pendingPartGroups: 0, conflictingPartGroups: 0,
        firstObservedAt: null, lastObservedAt: null, lastReceivedAt: null, lastPersistedAt: null };
      return { league: id, captureCount: number(row.capture_count), tableCount: number(row.table_count), rowCount: number(row.row_count), lockedRowCount: number(row.locked_row_count),
        receivedPartGroups: number(row.received_part_groups), completePartGroups: number(row.complete_part_groups), pendingPartGroups: number(row.pending_part_groups), conflictingPartGroups: number(row.conflicting_part_groups),
        firstObservedAt: stamp(row.first_observed_at), lastObservedAt: stamp(row.last_observed_at), lastReceivedAt: stamp(row.last_received_at), lastPersistedAt: stamp(row.last_persisted_at) };
    });
    const recent = envelope.recent.map(row => { const { evidence: ignored, ...receipt } = verifyRow(row); return receipt; });
    return { ok: true, durable: true, status: 'PASS', schema: 'reader-seen-capture-inventory-v1', sourceTable: READER_SEEN_CAPTURE_TABLE,
      countUnit: 'RAW_CAPTURE_OBSERVATIONS', ...FLAGS, leagues, recent };
  } catch (cause) {
    if (cause?.code === '42P01') throw error('READER_SEEN_CAPTURE_TABLE_NOT_READY', 503);
    if (String(cause?.code || '').startsWith('READER_SEEN_CAPTURE_')) throw cause;
    throw error('READER_SEEN_CAPTURE_READ_FAILED', 503);
  }
}
