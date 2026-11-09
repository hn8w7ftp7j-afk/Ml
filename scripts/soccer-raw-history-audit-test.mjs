import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildReaderSeenCapture, initializeReaderSeenCaptureStore, canonicalReaderSeenCapture } from '../lib/reader-seen-capture.js';
import { reassembleRawSeenBatch, RAW_SEEN_DERIVATION_VERSION } from '../lib/soccer/raw-seen-history.js';
import { initializeRawHistoryIndexStore, indexRawSeenHistoryCapture } from '../lib/soccer/raw-seen-history-index.js';
import { parseRawSeenHistoryAuditQuery, readRawSeenHistoryAudit } from '../lib/soccer/raw-seen-history-audit.js';

// Retained originals and synthetic counterexamples stay in this isolated SQL
// engine. The read-only audit is tested against real PostgreSQL expressions.
const parts = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/soccer/ucl-seen-pregame-20261105.json.gz', import.meta.url))));
const original = reassembleRawSeenBatch(parts).evidence, db = new PGlite(), statements = [], fixtures = [];
let afterQuery = null, failPayloadOnce = false, payloadAttempts = 0;
const query = (text, params = []) => ({ query: text, params,
  then(resolve, reject) { return execute([{ query: text, params }]).then(rows => rows[0]).then(resolve, reject); } });
const sql = (strings, ...params) => query(strings.reduce((s, part, i) => s + (i ? '$' + i : '') + part, ''), params);
sql.query = query;
async function execute(queries, transaction = false, options = {}) {
  const run = async connection => {
    const rows = [];
    for (const item of queries) {
      statements.push({ query: item.query, params: item.params, options });
      if (/AS items FROM bounds/.test(item.query)) {
        payloadAttempts++;
        if (failPayloadOnce) { failPayloadOnce = false; throw Object.assign(Error('isolated source read unavailable'), { code: '08006' }); }
      }
      rows.push((await connection.query(item.query, item.params)).rows);
    }
    return rows;
  };
  const rows = await (transaction ? db.transaction(run) : run(db));
  for (const item of queries) await afterQuery?.(item.query, item.params);
  return rows;
}
sql.transaction = (queries, options = {}) => execute(queries, true, options);
const now = Math.max(Date.now(), Date.parse('2026-11-10T12:00:00Z')) + 86400000;
async function reset() {
  afterQuery = null; failPayloadOnce = false;
  await db.query('TRUNCATE sports_reader_seen_captures_v1,soccer_raw_seen_history_batches_v1,soccer_raw_seen_history_games_v1,soccer_raw_seen_history_attempts_v1 CASCADE');
}
async function insert(part, { corrupt = false, batchOverride = null } = {}) {
  const built = buildReaderSeenCapture({ schema: 'READER-SEEN-CAPTURE-v1', evidence: part.evidence }, { deviceId: 'readonly-audit-test', headerVersion: part.evidence.readerVersion });
  const evidenceJson = corrupt ? built.evidenceJson.replace('0.820', '0.821') : built.evidenceJson;
  await db.query(`INSERT INTO sports_reader_seen_captures_v1(capture_id,schema_version,league,source_observed_at,page_activity_at,evidence_hash,evidence_json,
    source_scope_hash,reader_version,table_count,row_count,cell_count,locked_row_count,capture_batch_id,part_index,part_count,received_at,persisted_at)
    VALUES($1,'READER-SEEN-CAPTURE-v1',$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::timestamptz)`,
  [built.captureId, part.evidence.league, part.evidence.observedAt, part.evidence.pageActivityAt || null, built.evidenceHash, evidenceJson, built.sourceScopeHash,
    part.evidence.readerVersion, built.tableCount, built.rowCount, built.cellCount, built.lockedRowCount, batchOverride || part.evidence.captureBatchId || null,
    part.evidence.partIndex ?? null, part.evidence.partCount ?? null, part.receivedAt || new Date(now - 10000).toISOString(), part.persistedAt || new Date(now - 9000).toISOString()]);
  return { ...part, ...built, captureId: built.captureId, storedBatch: batchOverride };
}
async function attempt(part, reason = 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT') {
  const batch = part.storedBatch || part.evidence.captureBatchId || part.captureId;
  await db.query(`INSERT INTO soccer_raw_seen_history_attempts_v1(capture_id,derivation_version,batch_hash,league,source_capture_ids,source_watermark_hash,status,reason,attempted_at)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,'SOURCE_UNINDEXED',$7,$8::timestamptz) ON CONFLICT DO NOTHING`,
  [part.captureId, RAW_SEEN_DERIVATION_VERSION, batch, part.evidence.league, JSON.stringify([part.captureId]), 'a'.repeat(64), reason, new Date(now - 1000).toISOString()]);
}
function synthetic({ league = 'UCL', at = '2026-11-08T00:00:00.000Z', flat = false, unsupported = false } = {}) {
  const evidence = { ...structuredClone(original), league, observedAt: at,
    tables: [{ ...structuredClone(original.tables[171]), rows: [structuredClone(original.tables[171].rows[758])] }] };
  if (league === 'EPL') {
    evidence.tables[0].sectionTitle = '聯盟: 英格蘭超級聯賽(1)';
    evidence.tables[0].rows[0].cells[1].pair = ['愛華頓[主]', '阿仙奴', 'grade'];
  }
  if (flat) evidence.tables = [{ sectionTitle: evidence.tables[0].sectionTitle, headers: [], rows: [
    { marketLocked: false, cells: [{ pair: ['讓球'] }] }, { marketLocked: false, cells: [{ pair: ['1+50'] }] }] }];
  else if (unsupported) evidence.tables[0].headers = [];
  return { evidence };
}
const snapshot = async () => canonicalReaderSeenCapture(JSON.parse(JSON.stringify((await db.query('SELECT * FROM sports_reader_seen_captures_v1 ORDER BY capture_id')).rows)));
async function audit(input = { limit: 4 }, options = {}) {
  const { allowLateAppend = false, ...serviceOptions } = options;
  const before = await snapshot(), start = statements.length, value = await readRawSeenHistoryAudit(input, { db: sql, now, ...serviceOptions });
  const after = await snapshot(), hash = value => createHash('sha256').update(value).digest('hex');
  if (allowLateAppend) {
    const rows = new Map(JSON.parse(after).map(row => [row.capture_id, canonicalReaderSeenCapture(row)]));
    assert.ok(JSON.parse(before).every(row => rows.get(row.capture_id) === canonicalReaderSeenCapture(row)), 'a concurrent append cannot change an old source');
  } else assert.equal(hash(after), hash(before), 'audit cannot mutate originals, prices or clocks');
  assert.ok(statements.slice(start).every(item => /^\s*(?:SELECT|WITH)\b/.test(item.query)), 'all audit SQL including first GET is SELECT-only');
  assert.equal(value.archiveOnly, true);
  for (const flag of ['currentBoardUpdated', 'historicalAvailabilityVerified', 'executable', 'formalEligible', 'calibrationEligible', 'coverageComplete']) assert.equal(value[flag], false);
  assert.ok(value.budget.sourceBytesRead <= value.budget.maxSourceBytes);
  assert.ok(value.budget.sourceBytesReserved <= value.budget.maxSourceBytes);
  assert.ok(value.budget.sourceBytesRead <= value.budget.sourceBytesReserved);
  assert.ok(value.samples.length <= (input.limit || 2));
  assert.equal(value.sampleCompletenessVerified, false); assert.equal(value.siblingCoverageVerified, false);
  for (const sample of value.samples) {
    const scope = sample.sectionScopeSummary;
    if (sample.status === 'UNKNOWN') { assert.equal(scope, null, 'unknown source cannot establish section scope'); continue; }
    assert.deepEqual(Object.keys(scope).sort(), ['basis', 'matchingStandardTables', 'matchingStandardRows', 'excludedTables', 'excludedRows', 'unknownTables', 'unknownRows'].sort());
    assert.equal(scope.basis, 'SOURCE_SECTION_LABELS_NOT_OFFICIAL_IDENTITY');
    for (const category of ['matchingStandard', 'excluded', 'unknown']) {
      assert.ok(Number.isSafeInteger(scope[`${category}Tables`]) && scope[`${category}Tables`] >= 0);
      assert.ok(Number.isSafeInteger(scope[`${category}Rows`]) && scope[`${category}Rows`] >= 0);
      assert.ok(scope[`${category}Rows`] === 0 || scope[`${category}Tables`] > 0);
    }
    assert.equal(scope.matchingStandardRows + scope.excludedRows + scope.unknownRows, sample.rowCount);
    const tables = scope.matchingStandardTables + scope.excludedTables + scope.unknownTables;
    const exposedTables = sample.headers.reduce((sum, header) => sum + header.tables, 0);
    if (sample.headersTruncated) assert.ok(tables >= exposedTables);
    else assert.equal(tables, exposedTables);
  }
  return value;
}

try {
  const missing = await readRawSeenHistoryAudit({}, { db: sql, now });
  assert.equal(missing.ok, false); assert.equal(missing.status, 'UNKNOWN'); assert.equal(missing.reason, 'RAW_HISTORY_AUDIT_NOT_INITIALIZED');
  assert.deepEqual(missing.samples, []); fixtures.push({ name: 'unknown', value: missing });
  await initializeReaderSeenCaptureStore({ sql }); await initializeRawHistoryIndexStore({ db: sql });
  await db.query(`CREATE TABLE soccer_raw_seen_history_attempts_v1(capture_id CHAR(64),derivation_version TEXT,batch_hash CHAR(64),league TEXT,
    source_capture_ids JSONB,source_watermark_hash CHAR(64),status TEXT,reason TEXT,attempted_at TIMESTAMPTZ,PRIMARY KEY(capture_id,derivation_version))`);
  for (const query of ['limit=0', 'limit=5', 'limit=04', 'league=epl', 'league=NBA', 'league=', 'captureId=x', 'limit=2&limit=2', 'league=EPL&league=UCL'])
    assert.throws(() => parseRawSeenHistoryAuditQuery(new URLSearchParams(query)), error => error.status === 400);
  assert.deepEqual(parseRawSeenHistoryAuditQuery(new URLSearchParams()), { league: null, limit: 2 });
  assert.deepEqual((await audit()).samples, []);

  // A known failed partial becomes recoverable after its other original parts
  // arrive; the old attempt is not edited and the whole batch is hash checked.
  const first = await insert(parts[0]); await attempt(first, 'RAW_SEEN_RECOVERY_INCOMPLETE');
  let value = await audit({ league: 'UCL', limit: 4 });
  assert.equal(value.samples[0].status, 'UNKNOWN'); assert.equal(value.samples[0].reason, 'RAW_SEEN_RECOVERY_INCOMPLETE');
  assert.equal(value.samples[0].rowCount, null); assert.equal(value.samples[0].fragmentCount, null);
  for (const part of parts.slice(1)) await insert(part);
  value = await audit({ league: 'UCL', limit: 4 });
  assert.equal(value.samples.length, 1); assert.equal(value.samples[0].status, 'VERIFIED_SOURCE');
  assert.equal(value.samples[0].classification, 'STRUCTURED_ROWS'); assert.equal(value.samples[0].fragmentCount, parts.length);
  assert.equal(value.samples[0].replay.status, 'RECOVERABLE'); assert.equal(value.samples[0].replay.gameCount, 16);
  assert.ok(value.samples[0].replay.marketCount > 0); assert.ok(value.samples[0].rowWidths.some(row => row.cells === 8));
  assert.ok(value.samples[0].fragmentManifest.every(part => exact(part.receivedAt) && exact(part.persistedAt)));
  fixtures.push({ name: 'recoverable', value });
  await indexRawSeenHistoryCapture(first.captureId, { db: sql, now });
  assert.equal((await audit({ league: 'UCL', limit: 4 })).samples.length, 0, 'exactly indexed manifests are excluded');
  const extraEvidence = { ...structuredClone(parts[0].evidence), partIndex: parts.length, partCount: parts.length + 1 };
  await insert({ evidence: extraEvidence });
  value = await audit({ league: 'UCL', limit: 4 });
  assert.equal(value.samples.length, 1, 'a late fragment cannot hide behind the old indexed manifest');
  assert.equal(value.samples[0].status, 'UNKNOWN');

  await reset();
  const flat = await insert(synthetic({ flat: true })); await attempt(flat);
  const nearby = await insert(synthetic({ at: '2026-11-08T00:00:00.630Z' }));
  const foreign = await insert(synthetic({ league: 'EPL', at: '2026-11-08T00:00:00.100Z' }));
  value = await audit({ league: 'UCL', limit: 4 });
  assert.equal(value.samples[0].status, 'VERIFIED_SOURCE'); assert.equal(value.samples[0].classification, 'FLAT_TEXT_ONLY');
  assert.equal(value.samples[0].replay.status, 'SOURCE_UNINDEXED'); assert.equal(value.samples[0].replay.reason, 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT');
  assert.equal(value.samples[0].replay.gameCount, null); assert.equal(value.samples[0].replay.marketCount, null);
  assert.deepEqual(value.samples[0].rowWidths, [{ cells: 1, rows: 2 }]);
  assert.deepEqual(value.samples[0].siblings.map(row => row.captureId), [nearby.captureId]);
  assert.equal(value.samples[0].siblings.some(row => row.captureId === foreign.captureId), false);
  assert.equal(value.samples[0].pageFrameVerified, false); assert.equal(value.samples[0].sameCaptureVerified, false);
  assert.equal(value.samples[0].siblingScopeBasis, 'NEARBY_SAME_LEAGUE_READER_TIME_WINDOW');
  assert.equal(JSON.stringify(value).includes('source_scope_hash'), false); assert.equal(JSON.stringify(value).includes('evidence_json'), false);
  assert.equal(value.samples[0].sectionScopeSummary.matchingStandardTables, 1);
  assert.equal(value.samples[0].sectionScopeSummary.matchingStandardRows, 2,
    'matching source labels do not imply structured rows or replay eligibility');
  fixtures.push({ name: 'flat', value });

  // Failed HTTP/SQL reads retain their reserved allowance: an unconfirmed
  // server-side load cannot be cancelled on paper and funded a second time.
  await attempt(nearby);
  payloadAttempts = 0; failPayloadOnce = true;
  value = await audit({ league: 'UCL', limit: 4 }, { maxSourceBytes: Buffer.byteLength(flat.evidenceJson) });
  assert.equal(value.samples.length, 2); assert.equal(payloadAttempts, 1);
  assert.equal(value.budget.sourceBytesRead, 0); assert.equal(value.budget.sourceBytesReserved, Buffer.byteLength(flat.evidenceJson));
  assert.equal(value.samples[1].reason, 'RAW_HISTORY_AUDIT_BYTE_BUDGET');

  const start = statements.length;
  value = await audit({ league: 'UCL', limit: 4 }, { maxSourceBytes: 1 });
  assert.equal(value.samples[0].reason, 'RAW_HISTORY_AUDIT_BYTE_BUDGET'); assert.equal(value.budget.sourceBytesRead, 0);
  assert.equal(statements.slice(start).some(row => /AS items FROM bounds/.test(row.query)), false, 'oversized source is rejected before payload hydration');
  let clock = 0; afterQuery = text => { if (/WITH attempts AS/.test(text)) clock = 101; };
  value = await audit({ league: 'UCL', limit: 4 }, { clock: () => clock, timeBudgetMs: 100 });
  assert.equal(value.status, 'UNKNOWN'); assert.equal(value.reason, 'RAW_HISTORY_AUDIT_TIME_BUDGET');
  afterQuery = null;

  await reset();
  const corrupt = await insert(synthetic(), { corrupt: true }); await attempt(corrupt);
  value = await audit({ league: 'UCL', limit: 4 });
  assert.equal(value.samples[0].status, 'UNKNOWN'); assert.match(value.samples[0].reason, /HASH_MISMATCH|ID_MISMATCH|SOURCE_INTEGRITY/);
  assert.equal(value.samples[0].fragmentCount, null); assert.equal(value.samples[0].replay.marketCount, null);

  await reset();
  const wronglyBound = [];
  for (const part of parts) wronglyBound.push(await insert(part, { batchOverride: 'c'.repeat(64) }));
  await attempt(wronglyBound[0]);
  value = await audit({ league: 'UCL', limit: 4 });
  assert.equal(value.samples[0].status, 'UNKNOWN'); assert.equal(value.samples[0].reason, 'RAW_HISTORY_AUDIT_SOURCE_INTEGRITY',
    'hash-valid original fragments cannot verify metadata that binds them to another batch');

  // New same-cutoff source between metadata and payload must not cross the
  // byte budget or be silently omitted from a supposed complete batch.
  await reset();
  await insert(parts[0]); await attempt(first, 'RAW_SEEN_RECOVERY_INCOMPLETE');
  let inserted = false;
  afterQuery = async text => {
    if (!inserted && /AS source_bytes FROM sports_reader_seen_captures_v1/.test(text)) {
      inserted = true; for (const part of parts.slice(1)) await insert(part);
    }
  };
  value = await audit({ league: 'UCL', limit: 4 }, { allowLateAppend: true });
  assert.equal(value.samples[0].status, 'UNKNOWN'); assert.equal(value.samples[0].reason, 'RAW_HISTORY_AUDIT_SOURCE_CHANGED');
  assert.equal(value.budget.sourceBytesRead, 0);
  afterQuery = null;

  await reset();
  const mixed = synthetic(), baseTable = structuredClone(mixed.evidence.tables[0]);
  const copy = (sectionTitle, extra = {}) => ({ ...structuredClone(baseTable), sectionTitle, ...extra });
  mixed.evidence.tables = [baseTable,
    copy('聯盟: 歐洲冠軍聯賽 U21'), copy('聯盟: 英格蘭超級聯賽(1)'), copy('歐洲冠軍聯賽 角球'),
    copy('來源範圍未知'), copy('歐洲冠軍聯賽' + '備註'.repeat(130)),
    copy('歐洲冠軍聯賽', { periodEvidenceTruncated: true }), copy('歐洲冠軍聯賽 全場 上半場')];
  const mixedPart = await insert(mixed); await attempt(mixedPart);
  value = await audit({ league: 'UCL', limit: 4 });
  assert.deepEqual(value.samples[0].sectionScopeSummary, { basis: 'SOURCE_SECTION_LABELS_NOT_OFFICIAL_IDENTITY',
    matchingStandardTables: 1, matchingStandardRows: 1, excludedTables: 3, excludedRows: 3, unknownTables: 4, unknownRows: 4 });
  assert.equal(value.samples[0].classification, 'STRUCTURED_ROWS');
  assert.equal(value.samples[0].replay.status, 'RECOVERABLE');
  assert.doesNotMatch(JSON.stringify(value), /來源範圍未知|備註備註|U21/,
    'scope diagnostics expose only bounded counts, never raw titles or body text');
  fixtures.push({ name: 'mixed-section-scopes', value });

  await reset();
  const youth = synthetic({ league: 'EPL' }); youth.evidence.tables[0].sectionTitle = '聯盟: 英格蘭超級聯賽盃U21(12)';
  const youthPart = await insert(youth); await attempt(youthPart);
  value = await audit({ league: 'EPL', limit: 4 });
  assert.equal(value.samples[0].classification, 'STRUCTURED_ROWS');
  assert.equal(value.samples[0].sectionScopeSummary.matchingStandardTables, 0);
  assert.equal(value.samples[0].sectionScopeSummary.excludedTables, 1);
  assert.equal(value.samples[0].replay.status, 'SOURCE_UNINDEXED');
  assert.equal(value.samples[0].replay.reason, 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT');
  fixtures.push({ name: 'excluded-youth-structure', value });

  await reset();
  const emptySource = synthetic(); emptySource.evidence.tables = [];
  const emptyPart = await insert(emptySource); await attempt(emptyPart);
  value = await audit({ league: 'UCL', limit: 4 });
  assert.equal(value.samples[0].status, 'VERIFIED_SOURCE'); assert.equal(value.samples[0].rowCount, 0);
  assert.deepEqual(value.samples[0].sectionScopeSummary, { basis: 'SOURCE_SECTION_LABELS_NOT_OFFICIAL_IDENTITY',
    matchingStandardTables: 0, matchingStandardRows: 0, excludedTables: 0, excludedRows: 0, unknownTables: 0, unknownRows: 0 });
  assert.equal(value.samples[0].replay.status, 'SOURCE_UNINDEXED');
  fixtures.push({ name: 'verified-empty-source', value });

  await reset();
  // Sampling is bounded and balances league first; both source-time edges of
  // each reason are candidates, rather than loading every failed payload.
  for (const league of ['EPL', 'UCL']) for (let i = 0; i < 5; i++) {
    const item = await insert(synthetic({ league, flat: true, at: `2026-11-0${i + 1}T00:00:00.000Z` })); await attempt(item);
  }
  value = await audit(); assert.equal(value.samples.length, 4);
  for (const league of ['EPL', 'UCL']) assert.deepEqual(value.samples.filter(row => row.league === league).map(row => row.sourceObservedAt.slice(0, 10)).sort(), ['2026-11-01', '2026-11-05']);

  await reset();
  for (const [league, reason, days] of [
    ['EPL', 'RAW_SEEN_RECOVERY_BUDGET_EXCEEDED', [1, 8]],
    ['EPL', 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT', [2, 9]],
    ['UCL', 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT', [3, 10]],
  ]) for (const day of days) {
    const item = await insert(synthetic({ league, flat: true, at: `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z` }));
    await attempt(item, reason);
  }
  value = await audit();
  assert.equal(value.samples.length, 4);
  assert.deepEqual(value.samples.filter(row => row.league === 'EPL').map(row => [row.attemptReason, row.sampleEdge]), [
    ['RAW_SEEN_RECOVERY_BUDGET_EXCEEDED', 'OLDEST'], ['RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT', 'OLDEST'],
  ], 'default four-sample audit cannot let both edges of a budget stratum hide another reason');
  value = await audit({ league: 'EPL', limit: 4 });
  assert.deepEqual(value.samples.map(row => row.sampleEdge), ['OLDEST', 'OLDEST', 'NEWEST', 'NEWEST']);
  for (const reason of ['RAW_SEEN_RECOVERY_BUDGET_EXCEEDED', 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT'])
    assert.deepEqual(value.samples.filter(row => row.attemptReason === reason).map(row => row.sampleEdge), ['OLDEST', 'NEWEST']);
  assert.ok(statements.filter(row => /WITH attempts AS/.test(row.query)).every(row => !/evidence_json|payload_json/.test(row.query)), 'selection never scans source JSON');
  const file = join(tmpdir(), 'raw-history-audit-contract-fixtures.json'); writeFileSync(file, JSON.stringify({ cases: fixtures }));
  console.log('PASS raw-history read-only audit: real PostgreSQL stratified bounds, original multipart/hash/clock verification, metadata-first byte limits, late-fragment/index exclusion, nearby metadata without coverage claims, missing schema/deadline UNKNOWN and immutable sources; NOT Production');
} finally { afterQuery = null; await db.close(); }
function exact(value) { return typeof value === 'string' && /\.\d{3,6}Z$/.test(value); }
