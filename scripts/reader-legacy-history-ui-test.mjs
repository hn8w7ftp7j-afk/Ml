import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditHarness, auditNodes } from './lib/history-audit-ui-harness.mjs';

const component = 'app/market-line-history/legacy-history-panel.js';
const harness = await createAuditHarness(component, 'LegacyHistoryPanel');
const flags = { sourceKind: 'NORMALIZED_READER_CACHE', archiveOnly: true, currentBoardUpdated: false, executable: false,
  historicalAvailabilityVerified: false, coverageComplete: false, firstObservedAtVerified: false, formalEligible: false,
  calibrationEligible: false, closingCoverage: 'NOT_VERIFIED', mutableSnapshot: true, completeHistory: false,
  concurrentSourceCommitsVerified: false, timeBasis: 'LAST_RETAINED_READER_SNAPSHOT_NOT_FIRST_PRICE_OBSERVATION' };
const scope = { league: 'MLB', from: '2026-11-01', through: '2026-11-30' };
const meta = () => ({ league: 'MLB', boardDate: '2026-11-07', observedAt: '2026-11-07T01:00:00.123000Z',
  pageActivityAt: '2026-11-07T00:59:58.123000Z', expiresAt: '2026-11-07T01:30:00.123000Z', expired: true,
  payloadBytes: 4000, checksum: 'a'.repeat(64), storedSchema: 'TAI888-READER-PARSER-v2.2.1', detailAvailable: true, integrity: { status: 'NOT_CHECKED' } });
function inventory({ empty = false, blocked = false } = {}) {
  return { ok: true, schema: 'reader-legacy-history-v1', ...flags, view: 'inventory', filters: { view: 'inventory', ...scope },
    readAt: '2026-11-09T04:00:00.000Z', status: empty ? 'NO_RETAINED_ROWS' : 'RETAINED_MUTABLE_SNAPSHOTS', count: empty ? 0 : 1,
    ...(empty ? { code: 'LEGACY_READER_SNAPSHOT_NOT_FOUND' } : {}), records: empty ? [] : [{ ...meta(), ...(blocked ? { detailAvailable: false, payloadBytes: 650001 } : {}) }] };
}
function detail({ empty = false } = {}) {
  const record = { ...meta(), receivedAt: '2026-11-07T01:00:01Z', readerVersion: '2.2.1', payloadHash: 'b'.repeat(64), rawBoardHash: 'c'.repeat(64),
    integrity: { status: 'PASS', scope: 'CACHE_CHECKSUM_IDENTITY_SCHEMA_NOT_SOURCE_TIME_AUTHORITY' }, games: [] };
  const source = { observedAt: '2026-11-07T01:00:00.123Z', receivedAt: record.receivedAt, pageActivityAt: '2026-11-07T00:59:58.123Z' };
  const markets = ['全場讓分', '全場大小', '上半讓分', '上半大小'].flatMap(market => [
    { market, pick: '主讓1+50', water: 1.05, lineAsOf: source.pageActivityAt, rawText: '  原盤 1+50（1.05／0.75）  ' },
    { market, pick: '客受1+50', water: 0.75, lineAsOf: source.pageActivityAt, rawText: '<script>原始文字</script>' },
  ]);
  record.games = [{ gamePk: 42, away: '客隊', home: '主隊', boardTime: '09:00', marketStatus: 'open', source, markets },
    { gamePk: 43, away: '客隊二', home: '主隊二', boardTime: null, marketStatus: 'locked', source, markets: [] }];
  return { ok: true, schema: 'reader-legacy-history-v1', ...flags, view: 'detail', filters: { view: 'detail', league: 'MLB', date: '2026-11-07' },
    readAt: '2026-11-09T04:00:00.000Z', status: empty ? 'NO_RETAINED_ROWS' : 'RETAINED_MUTABLE_SNAPSHOT', count: empty ? 0 : 1,
    ...(empty ? { code: 'LEGACY_READER_SNAPSHOT_NOT_FOUND' } : {}), record: empty ? null : record };
}
function setScope(h) { h.change('舊 Reader 開始日期', scope.from); h.change('舊 Reader 結束日期', scope.through); }
const h = harness(); h.render();
assert.equal(h.calls.length, 0, 'the readonly audit must remain idle on mount');
assert.match(h.markup, /舊快照留存數量：未確認/);
assert.equal(h.scope.readerLegacyCurrentMonth(Date.parse('2026-10-31T16:30:00Z')).from, '2026-11-01');
assert.equal(h.scope.readerLegacyCurrentMonth(Date.parse('2024-02-01T00:00:00Z')).through, '2024-02-29');
assert.equal(h.scope.validateReaderLegacyHistoryInventory(inventory(), scope).count, 1);
assert.equal(h.scope.validateReaderLegacyHistoryInventory(inventory({ empty: true }), scope).count, 0);
assert.equal(h.scope.validateReaderLegacyHistoryDetail(detail(), meta()).record.games.length, 2);
assert.equal(h.scope.validateReaderLegacyHistoryDetail(detail({ empty: true }), meta()).count, 0);
for (const mutate of [
  v => { v.ok = false; }, v => { v.schema = 'wrong'; }, v => { v.view = 'detail'; }, v => { v.readAt = '2026-02-30T04:00:00Z'; },
  v => { v.readAt = '2026-11-09T24:00:00Z'; }, v => { v.filters.league = 'NPB'; }, v => { v.filters.through = '2026-11-29'; },
  v => { v.count = null; }, v => { v.count = 0; }, v => { v.status = 'NOT_VERIFIED'; }, v => { v.records[0].league = 'NPB'; },
  v => { v.records[0].boardDate = '2026-12-01'; }, v => { v.records[0].observedAt = '2026-11-07T23:60:00Z'; },
  v => { v.records[0].checksum = 'oops'; }, v => { v.records[0].integrity.status = 'PASS'; }, v => { v.records[0].games = []; },
  v => { v.records[0].deviceId = 'private'; }, v => { v.records.push(structuredClone(v.records[0])); v.count++; },
  ...Object.keys(flags).map(key => v => { v[key] = typeof flags[key] === 'boolean' ? !flags[key] : 'WRONG'; }),
]) { const v = inventory(); mutate(v); assert.throws(() => h.scope.validateReaderLegacyHistoryInventory(v, scope), /未通過核對/); }
for (const league of ['constructor', '__proto__', 'toString', 'EPL']) assert.throws(() => h.scope.validateReaderLegacyHistoryInventory(inventory(), { ...scope, league }), /未通過核對/);
for (const mutate of [
  v => { v.record.league = 'NPB'; }, v => { v.record.boardDate = '2026-11-08'; }, v => { v.record.integrity.scope = 'SOURCE_AUTHORITY'; },
  v => { v.record.integrity.status = 'NOT_CHECKED'; }, v => { v.record.games[0].gamePk = 0; }, v => { v.record.games[1].gamePk = 42; },
  v => { v.record.games[0].markets[0].market = '上半大小球'; }, v => { v.record.games[0].markets[0].market = 'constructor'; },
  v => { v.record.games[0].markets[0].water = null; }, v => { v.record.games[0].markets[0].rawText = null; },
  v => { v.record.games[0].source.observedAt = '2026-11-08T01:00:00Z'; }, v => { v.record.games[0].markets[0].lineAsOf = '2026-11-08T01:00:00Z'; },
  v => { v.record.games[0].markets.pop(); }, v => { v.record.games[0].executable = true; }, v => { v.firstObservedAtVerified = true; },
]) { const v = detail(); mutate(v); assert.throws(() => h.scope.validateReaderLegacyHistoryDetail(v, meta()), /未通過核對/); }
assert.throws(() => h.scope.validateReaderLegacyHistoryDetail(detail(), { ...meta(), detailAvailable: false }), /未通過核對/);
const wrongEmpty = inventory({ empty: true }); wrongEmpty.count = null;
assert.throws(() => h.scope.validateReaderLegacyHistoryInventory(wrongEmpty, scope), /未通過核對/);

setScope(h);
const query = h.click('查舊 Reader 保存'); h.click('查舊 Reader 保存'); await h.settle();
assert.equal(h.calls.length, 1, 'double click cannot start two list reads');
const url = new URL(h.calls[0].url, 'https://example.test');
assert.equal(url.pathname, '/api/reader/legacy-history'); assert.equal(url.searchParams.get('view'), 'inventory');
assert.equal(url.searchParams.get('league'), 'MLB'); assert.equal(url.searchParams.get('from'), scope.from); assert.equal(url.searchParams.get('through'), scope.through);
assert.equal([...url.searchParams].length, 4); assert.equal(h.calls[0].options.method, 'GET'); assert.equal(h.calls[0].options.cache, 'no-store'); assert.equal(h.calls[0].options.credentials, 'same-origin');
h.calls[0].respond(inventory()); await query; await h.settle();
assert.match(h.markup, /留存 1 筆日期快照/); assert.match(h.markup, /尚未核對盤口內容/); assert.equal(h.calls.length, 1);
const see = h.click('查看 2026-11-07 盤口'); h.click('查看 2026-11-07 盤口'); await h.settle();
assert.equal(h.calls.length, 2, 'detail is a separate explicit single GET');
const detailUrl = new URL(h.calls[1].url, 'https://example.test');
assert.deepEqual([...detailUrl.searchParams], [['view', 'detail'], ['league', 'MLB'], ['date', '2026-11-07']], 'detail uses only the listed exact league/date key');
h.calls[1].respond(detail()); await see; await h.settle();
assert.match(h.markup, /前五局讓分/); assert.match(h.markup, /前五局大小/); assert.match(h.markup, /已過期留存快照/);
assert.match(h.markup, /舊快照標記鎖盤（實際來源鎖盤未確認）/); assert.match(h.markup, /不能證明首次觀察時間、尾盤或完整覆蓋/);
const cells = auditNodes(h.tree).filter(node => node.type === 'td').map(node => node.props.children);
assert.ok(cells.includes('主讓1+50')); assert.ok(cells.includes('  原盤 1+50（1.05／0.75）  ')); assert.ok(cells.includes('<script>原始文字</script>'));
assert.doesNotMatch(h.markup, /<script>/); assert.equal(h.calls.length, 2, 'reading one detail must not traverse other dates');

// A filter edit invalidates both the list and detail, even when a prior fetch
// ignores abort and returns after the new scope has finished loading.
const savedDetailHandler = h.button('查看 2026-11-07 盤口').props.onClick;
const savedInventoryHandler = h.button('查舊 Reader 保存').props.onClick;
const old = savedDetailHandler(); await h.settle(); const stale = h.calls[2];
h.change('舊 Reader 聯盟', 'NPB'); assert.equal(stale.options.signal.aborted, true); assert.doesNotMatch(h.markup, /客隊 → 主隊/);
savedDetailHandler(); assert.equal(h.calls.length, 3, 'a retained old detail callback cannot query an entry removed by filter change');
const fresh = savedInventoryHandler(); await h.settle(); const npb = inventory({ empty: true }); npb.filters.league = 'NPB';
assert.equal(new URL(h.calls[3].url, 'https://example.test').searchParams.get('league'), 'NPB', 'an old list callback reads the latest scope reference');
h.calls[3].respond(npb); await fresh; await h.settle(); const clean = h.markup;
stale.respond(detail()); await old; await h.settle(); assert.equal(h.markup, clean); assert.match(h.markup, /目前此範圍沒有留存的舊快照（0 筆）/);
assert.equal(h.calls.length, 4);
const denied = h.click('查舊 Reader 保存'); await h.settle(); h.calls[4].respond({ private: 'auth-private' }, 403); await denied; await h.settle();
assert.match(h.markup, /目前沒有查閱權限，結果仍未確認/); assert.doesNotMatch(h.markup, /auth-private|0 筆/);
const outage = h.click('查舊 Reader 保存'); await h.settle(); h.calls[5].respond({ error: 'db-private', count: null }, 503); await outage; await h.settle();
assert.match(h.markup, /結果仍未確認/); assert.doesNotMatch(h.markup, /db-private|0 筆/);
const timed = h.click('查舊 Reader 保存'); await h.settle(); const late = h.calls[6]; h.expire(); await h.settle();
assert.equal(late.options.signal.aborted, true); assert.match(h.markup, /查詢逾時/);
const retry = h.click('查舊 Reader 保存'); await h.settle(); h.calls[7].respond(npb); await retry; await h.settle(); const retryMarkup = h.markup;
late.respond(npb); await timed; await h.settle(); assert.equal(h.markup, retryMarkup);
const last = h.click('查舊 Reader 保存'); await h.settle(); h.unmount(); assert.equal(h.calls[8].options.signal.aborted, true);
h.calls[8].respond(npb); await last; await h.settle(); assert.equal(h.afterUnmountMutations, 0); assert.equal(h.timers.size, 0);

const blocked = harness(); blocked.render(); setScope(blocked);
const tooLarge = blocked.click('查舊 Reader 保存'); await blocked.settle(); blocked.calls[0].respond(inventory({ blocked: true })); await tooLarge; await blocked.settle();
assert.match(blocked.markup, /明細暫不可讀取/); assert.equal(auditNodes(blocked.tree).filter(node => node.type === 'button').length, 1);
blocked.change('舊 Reader 結束日期', '2026-12-02'); blocked.click('查舊 Reader 保存'); await blocked.settle();
assert.match(blocked.markup, /每次最多查詢 31 天/); assert.equal(blocked.calls.length, 1); blocked.unmount();

for (const path of process.argv.slice(2).map(value => value === '--contract-fixture' ? join(tmpdir(), 'reader-legacy-history-contract-fixtures.json') : value)) {
  const actual = JSON.parse(fs.readFileSync(path, 'utf8'));
  const actualScope = actual.inventory.filters;
  h.scope.validateReaderLegacyHistoryInventory(actual.inventory, actualScope);
  h.scope.validateReaderLegacyHistoryInventory(actual.empty, actual.empty.filters);
  const entry = actual.inventory.records.find(row => row.boardDate === actual.detail.filters.date && row.league === actual.detail.filters.league);
  const immutableDetail = JSON.stringify(actual.detail);
  assert.ok(entry); h.scope.validateReaderLegacyHistoryDetail(actual.detail, entry);
  assert.equal(JSON.stringify(actual.detail), immutableDetail, 'validation preserves every original line, water and raw string');
  if (actual.emptyDetail) {
    // This independent empty-PK fixture may use another league; it cannot be
    // substituted for the listed entry. Only validate its own requested key.
    const expectedKey = { league: actual.emptyDetail.filters.league, boardDate: actual.emptyDetail.filters.date, detailAvailable: true };
    h.scope.validateReaderLegacyHistoryDetail(actual.emptyDetail, expectedKey);
    if (expectedKey.league !== entry.league || expectedKey.boardDate !== entry.boardDate) {
      assert.throws(() => h.scope.validateReaderLegacyHistoryDetail(actual.emptyDetail, entry), /未通過核對/);
    }
  }
  console.log('PASS legacy UI validates actual database inventory/detail/empty contracts');
}
assert.doesNotMatch(fs.readFileSync(component, 'utf8'), /dangerouslySetInnerHTML|method:\s*['"]POST/);
console.log('PASS readonly legacy Reader UI: idle mount, bounded metadata list, exact league/date detail, immutable original picks/text, first-five market labels, mutable/expired/unknown semantics, permissions/errors, double-click, timeout/abort/unmount/late-response fencing; Production NOT VERIFIED');
