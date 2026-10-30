import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEEN_CAPTURE_LEAGUES, latestSeenDeliveryReports, seenCaptureQueryUrl, validateSeenCaptureDetail, validateSeenCaptureResponse } from '../app/market-line-history/seen-capture-view.js';
import { buildReaderSeenCapture, listReaderSeenCaptures } from '../lib/reader-seen-capture.js';

const time = '2026-10-29T01:00:00.000Z';
const empty = { ok: true, status: 'PASS', schema: 'reader-seen-capture-inventory-v1', sourceTable: 'sports_reader_seen_captures_v1',
  countUnit: 'RAW_CAPTURE_OBSERVATIONS', archiveOnly: true, currentBoardUpdated: false, historicalAvailabilityVerified: false,
  executable: false, coverageComplete: false, leagues: SEEN_CAPTURE_LEAGUES.map(league => ({ league, captureCount: 0,
    tableCount: 0, rowCount: 0, lockedRowCount: 0, receivedPartGroups: 0, completePartGroups: 0, pendingPartGroups: 0, conflictingPartGroups: 0,
    firstObservedAt: null, lastObservedAt: null, lastReceivedAt: null, lastPersistedAt: null })), recent: [] };
assert.equal(validateSeenCaptureResponse(empty), empty, 'successful empty database can display zero with no inferred game counts');
assert.equal(seenCaptureQueryUrl('NBA'), '/api/reader/seen-captures?limit=20&league=NBA');
assert.equal(seenCaptureQueryUrl(), '/api/reader/seen-captures?limit=20');
assert.equal(seenCaptureQueryUrl('NHL'), '/api/reader/seen-captures?limit=20&league=NHL');
assert.throws(() => seenCaptureQueryUrl('NFL'));
const one = { ...empty, leagues: [empty.leagues.find(row => row.league === 'EPL')], recent: [{ captureId: 'a'.repeat(64), evidenceHash: 'b'.repeat(64), league: 'EPL',
  observedAt: time, pageActivityAt: null, readerVersion: '2.1.51', tableCount: 0, rowCount: 0, cellCount: 0, lockedRowCount: 0,
  captureReasons: ['BEFORE_SELECTION', 'SOURCE_PARTIAL'], completeCapture: false, receivedAt: time, persistedAt: time, status: 'EVIDENCE_UNVERIFIED',
  captureBatchId: 'c'.repeat(64), partIndex: 1, partCount: 3 }] };
assert.equal(validateSeenCaptureResponse(one, 'EPL'), one, 'zero rows and rejected/incomplete parsing still remain source evidence');
assert.ok(validateSeenCaptureResponse({ ...one, recent: [{ ...one.recent[0], captureBatchId: null, partIndex: null, partCount: null }] }, 'EPL'), 'nonchunked capture metadata can explicitly return null batch fields');
for (const payload of [
  { ...empty, ok: false, code: 'READER_SEEN_CAPTURE_TABLE_NOT_READY' },
  { ...empty, countUnit: 'GAMES' }, { ...empty, currentBoardUpdated: true }, { ...empty, coverageComplete: true },
  { ...empty, leagues: empty.leagues.slice(1) }, { ...empty, leagues: [empty.leagues[0], ...empty.leagues.slice(0, -1)] },
  { ...empty, leagues: empty.leagues.map((row, index) => index ? row : { ...row, captureCount: null }) },
  { ...empty, leagues: empty.leagues.map((row, index) => index ? row : { ...row, pendingPartGroups: null }) },
  { ...one, recent: [{ ...one.recent[0], partIndex: 3 }] },
  { ...one, recent: [{ ...one.recent[0], captureId: 'malformed' }] },
]) assert.throws(() => validateSeenCaptureResponse(payload, payload === one ? 'EPL' : ''), /回應不完整/);
assert.throws(() => validateSeenCaptureResponse(one, 'NBA'), /回應不完整/, 'previous league result cannot be accepted after filter changes');
assert.throws(() => validateSeenCaptureResponse({ ...one, recent: [{ ...one.recent[0], partIndex: 3 }] }, 'EPL'), /回應不完整/);
const evidence = { league: 'EPL', observedAt: time, pageLeagueLabel: '英格蘭超級聯賽', tables: [{ sectionTitle: '全場盤面', headers: ['球隊', '讓分'], rows: [{ cells: [{ pair: ['主隊', '客隊'] }, { pair: ['3+50 0.95', '  0.95'] }] }] }] };
const detail = { ...empty, schema: 'READER-SEEN-CAPTURE-v1', capture: { ...one.recent[0], evidence } };
assert.equal(validateSeenCaptureDetail(detail, one.recent[0]), evidence);
assert.equal(validateSeenCaptureDetail({ ...detail, capture: { ...detail.capture, evidence: { ...evidence, tables: [] } } }, one.recent[0]).tables.length, 0, 'heading-only source remains readable');
assert.throws(() => validateSeenCaptureDetail({ ...detail, capture: { ...detail.capture, captureId: 'd'.repeat(64) } }, one.recent[0]), /不一致/);
assert.throws(() => validateSeenCaptureDetail({ ...detail, capture: { ...detail.capture, evidence: { ...evidence, league: 'NBA' } } }, one.recent[0]), /不一致/);
assert.throws(() => validateSeenCaptureDetail({ ...detail, capture: { ...detail.capture, evidence: { ...evidence, tables: [{ rows: [{ cells: [{ pair: [null] }] }] }] } } }, one.recent[0]), /不一致/);
assert.equal(evidence.tables[0].rows[0].cells[1].pair[1], '  0.95', 'rendering does not rewrite stored odds text');

// Cross the actual server DTO/readback boundary, including NHL and nullable
// legacy batch metadata. These are synthetic sport-only fixtures, never uploads.
const rawEvidence = { version: 'TAI888-DOM-CAPTURE-v2.2.0', league: 'NHL', readerVersion: '2.1.51', sourceHost: 'us.tai888.in',
  pageUrl: 'https://us.tai888.in/#/BS', observedAt: time, pageActivityAt: null, pageLeagueLabel: '冰球',
  captureReasons: ['PRE_NORMALIZATION', 'SOURCE_PARTIAL'], completeCapture: false,
  tables: [{ sectionTitle: '冰球', headers: [], rows: [{ cells: [{ pair: ['尚未識別球隊', '盤口尚未解析'] }] }] }] };
const raw = buildReaderSeenCapture({ schema: 'READER-SEEN-CAPTURE-v1', evidence: rawEvidence }, { deviceId: 'synthetic-device-one', headerVersion: '2.1.51' });
const dbRow = { capture_id: raw.captureId, schema_version: 'READER-SEEN-CAPTURE-v1', league: 'NHL', source_observed_at: time,
  page_activity_at: null, evidence_hash: raw.evidenceHash, evidence_json: raw.evidenceJson, source_scope_hash: raw.sourceScopeHash, reader_version: '2.1.51',
  table_count: raw.tableCount, row_count: raw.rowCount, cell_count: raw.cellCount, locked_row_count: raw.lockedRowCount,
  capture_batch_id: null, part_index: null, part_count: null, received_at: time, persisted_at: time };
const sql = async parts => {
  const statement = parts.join('?');
  assert.doesNotMatch(statement, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  return statement.includes('WITH filtered') ? [{ leagues: [{ league: 'NHL', capture_count: '1', table_count: '1', row_count: '1', locked_row_count: '0',
    received_part_groups: '0', complete_part_groups: '0', pending_part_groups: '0', conflicting_part_groups: '0', first_observed_at: time,
    last_observed_at: time, last_received_at: time, last_persisted_at: time }], recent: [dbRow] }] : [dbRow];
};
const serverInventory = await listReaderSeenCaptures({ league: 'NHL', limit: 20 }, { sql });
assert.equal(validateSeenCaptureResponse(serverInventory, 'NHL').leagues[0].captureCount, 1);
assert.equal(serverInventory.recent[0].status, 'EVIDENCE_UNVERIFIED');
const serverDetail = await listReaderSeenCaptures({ captureId: raw.captureId }, { sql });
assert.equal(validateSeenCaptureDetail(serverDetail, serverInventory.recent[0]).tables[0].rows[0].cells[0].pair[1], '盤口尚未解析');

const report = (id, received, delivery, version = '2.1.51') => ({ device_id: id, received_at: received,
  payload: { createdAt: received, readerVersion: version, ...(delivery === undefined ? {} : { seenCaptureDelivery: delivery }) } });
const pending = { state: 'pending', pendingCount: 2, pendingBytes: 800, failedCaptureCount: 1, savedCaptureCount: 4, code: 'RETRY_PENDING', lastPersistedAt: time };
let reports = latestSeenDeliveryReports([report('device-one', '2026-10-29T00:00:00Z', pending), report('device-one', time, undefined), report('device-two', time, pending)]);
assert.equal(reports.length, 2);
assert.equal(reports.find(row => row.deviceId === 'device-one').delivery, null, 'latest report missing field cannot inherit stale queue success/failure');
assert.equal(reports.find(row => row.deviceId === 'device-two').delivery.pendingCount, 2);
assert.equal(reports.find(row => row.deviceId === 'device-two').delivery.failedCaptureCount, 1, 'local capture loss warning must remain visible');
reports = latestSeenDeliveryReports([report('device-one', time, { ...pending, pendingCount: null, failedCaptureCount: undefined })]);
assert.equal(reports[0].delivery.pendingCount, null); assert.equal(reports[0].delivery.failedCaptureCount, null, 'unknown counters never coerce to zero');
reports = latestSeenDeliveryReports([report('device-one', time, { ...pending, state: 'sent', pendingCount: 0, failedCaptureCount: 0 })]);
assert.equal(reports[0].delivery.pendingCount, 0, 'explicit zero remains distinguishable from missing telemetry');
assert.deepEqual(latestSeenDeliveryReports([]), []); assert.throws(() => latestSeenDeliveryReports(null));
assert.deepEqual(latestSeenDeliveryReports([{ device_id: 'bad', received_at: 'invalid', payload: {} }]), []);

const ui = readFileSync(new URL('../app/market-line-history/seen-capture-panel.js', import.meta.url), 'utf8');
const host = readFileSync(new URL('../app/market-line-history/history-browser.js', import.meta.url), 'utf8');
assert.match(host, /<SeenCapturePanel\/>\s*<CoveragePanel\/>/);
assert.match(ui, /Promise\.allSettled\(\[inventory\(\), diagnosticSnapshots\(\)\]\)/);
assert.match(ui, /setResult\(null\)/); assert.match(ui, /request\.current\.sequence === sequence/);
assert.match(ui, /不是場數、可分析盤口數或完整尾盤數/);
assert.match(ui, /並非電腦目前的即時佇列/);
assert.match(ui, /role="alert"/);
assert.doesNotMatch(ui, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i, 'inventory panel must only read data');
console.log('PASS seen-capture panel: eight-league raw-observation units, partial batches, strict empty/error/filter boundaries, independent diagnostics, explicit unknown/error queue counters and server snapshot timing; NOT Production');
