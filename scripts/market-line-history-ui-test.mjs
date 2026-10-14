import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMPTY_HISTORY_FILTERS, HISTORY_LEAGUES, groupHistoryRows, historyFilterLabel, historyQueryUrl,
  historyRowKey, historyWater, mergeHistoryRows, taipeiHistoryTime, validateHistoryResponse } from '../app/market-line-history/history-view.js';

const first = { league: 'CPBL', boardDate: '2026-10-08', gameKey: '777', observedAt: '2026-10-08T10:00:00.000Z',
  stateHash: 'aaaaaaaaaaaaaaaa', gameLabel: '場次 777', integrity: { ok: true, issues: [] },
  rawMarkets: [['兄弟讓1+60', 0.98, '統一受讓1+60', 1.02], null, null, null],
  markets: [{ market: '全場讓分', status: 'AVAILABLE', directions: [{ pick: '兄弟讓1+60', water: 0.98 }, { pick: '統一受讓1+60', water: 1.02 }] },
    { market: '全場大小', status: 'NOT_CAPTURED', directions: [] }] };
const later = { ...first, observedAt: '2026-10-08T10:01:00.000Z', stateHash: 'bbbbbbbbbbbbbbbb',
  markets: [{ market: '全場讓分', status: 'AVAILABLE', directions: [{ pick: '兄弟讓1+80', water: 0.964 }, { pick: '統一受讓1+80', water: 1.02 }] }] };
const payload = { ok: true, schema: 'market-line-history-query-v1', sourceTable: 'tai888_market_line_history_v1',
  until: '2026-10-09T10:00:00.000Z', totals: { savedStates: 9, gameDateKeys: 3, boardDates: 2 },
  leagues: [{ league: 'CPBL', savedStates: 9, gameDateKeys: 3, boardDates: 2 }], rows: [first, later],
  hasMore: true, nextAfter: 'signed-cursor', productionWrites: false, coverageComplete: false };

assert.deepEqual(HISTORY_LEAGUES, ['MLB', 'NBA', 'NPB', 'KBO', 'CPBL']);
assert.equal(historyQueryUrl(EMPTY_HISTORY_FILTERS), '/api/market-line-history?limit=100');
const filtered = new URL(historyQueryUrl({ league: 'nba', from: '2026-10-08', through: '2026-10-09', gameKey: '19:30|LAL|GSW' }), 'https://example.test');
assert.equal(filtered.searchParams.get('league'), 'NBA');
assert.equal(filtered.searchParams.get('gameKey'), '19:30|LAL|GSW', 'game keys containing delimiters survive URL encoding');
assert.equal(filtered.searchParams.get('from'), '2026-10-08');
const next = new URL(historyQueryUrl(EMPTY_HISTORY_FILTERS, payload), 'https://example.test');
assert.equal(next.searchParams.get('until'), payload.until, 'paging keeps the original fixed cutoff');
assert.equal(next.searchParams.get('after'), payload.nextAfter);
assert.throws(() => historyQueryUrl({ ...EMPTY_HISTORY_FILTERS, from: '2026-02-30' }), /有效的盤日/);
assert.throws(() => historyQueryUrl({ ...EMPTY_HISTORY_FILTERS, from: '2026-10-09', through: '2026-10-08' }), /不能晚於/);
assert.throws(() => historyQueryUrl({ ...EMPTY_HISTORY_FILTERS, league: 'NHL' }), /支援的聯盟/);
assert.throws(() => historyQueryUrl(EMPTY_HISTORY_FILTERS, { until: payload.until }), /分頁資訊/);
assert.throws(() => historyQueryUrl({ ...EMPTY_HISTORY_FILTERS, gameKey: 'a'.repeat(81) }), /80/);
assert.equal(validateHistoryResponse(payload), payload);
assert.throws(() => validateHistoryResponse({ ...payload, totals: {} }), /未當成成功或零筆/);
assert.throws(() => validateHistoryResponse({ ...payload, nextAfter: null }), /格式不完整/);
assert.throws(() => validateHistoryResponse({ ...payload, leagues: [{ league: 'CPBL', savedStates: undefined }] }), /格式不完整/);
assert.throws(() => validateHistoryResponse({ ...payload, rows: [{ ...first, markets: [null] }] }), /格式不完整/);
assert.throws(() => validateHistoryResponse({ ...payload, rows: [{ ...first, gameLabel: {} }] }), /格式不完整/);
assert.throws(() => validateHistoryResponse({ ...payload, sourceTable: 'baseball_analysis_pit_snapshots' }), /格式不完整/, 'old analysis snapshots cannot masquerade as raw change archive');
assert.equal(validateHistoryResponse({ ...payload, rows: [], leagues: [], totals: { savedStates: 0, gameDateKeys: 0, boardDates: 0 }, hasMore: false, nextAfter: null }).totals.savedStates, 0);
assert.equal(validateHistoryResponse({ ...payload, rows: [{ ...first, integrity: { ok: false, issues: ['invalid'] }, markets: [{ market: '全場大小', status: 'INVALID' }] }] }).rows[0].integrity.ok, false, 'invalid saved state remains visibly identifiable');

const merged = mergeHistoryRows([later], [first, later]);
assert.equal(merged.length, 2, 'repeated page rows do not inflate loaded counts');
assert.equal(merged[0].observedAt, first.observedAt, 'timeline is chronological');
assert.notEqual(historyRowKey(first), historyRowKey({ ...first, boardDate: '2026-10-09' }));
assert.notEqual(historyRowKey(first), historyRowKey({ ...first, league: 'KBO' }));
const groups = groupHistoryRows([later, first, { ...first, boardDate: '2026-10-09' }, { ...first, league: 'KBO' }]);
assert.equal(groups.length, 3, 'same key on another league/date stays isolated');
assert.deepEqual(groups.find(group => group.league === 'CPBL' && group.boardDate === '2026-10-08').rows.map(row => row.observedAt), [first.observedAt, later.observedAt]);
assert.match(taipeiHistoryTime('2026-10-08T18:00:00.000Z'), /2026\/10\/09\s02:00:00/, 'Taipei timezone rolls over midnight explicitly');
assert.equal(historyWater(0.964), '0.964', 'do not round away saved water precision');
assert.equal(historyWater(0), '0');
assert.equal(historyWater(null), '未保存', 'missing water never turns into zero');
assert.equal(historyFilterLabel(EMPTY_HISTORY_FILTERS), '全部聯盟｜全部盤日');
assert.match(historyFilterLabel({ ...EMPTY_HISTORY_FILTERS, from: '2026-10-08', gameKey: '777' }), /不限迄日.*777/);

const ui = readFileSync(new URL('../app/market-line-history/history-browser.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const middleware = readFileSync(new URL('../middleware.js', import.meta.url), 'utf8');
assert.match(main, /href="\/market-line-history"/, 'main navigation exposes history page');
assert.match(ui, /目前已載入版本/);
assert.match(ui, /筆數不代表全部歷史都已收齊/);
assert.match(ui, /不是舊分析快照庫/);
assert.match(ui, /這不代表當時沒有比賽或沒有開盤/);
assert.match(ui, /載入下一頁/);
assert.match(ui, /row\.integrity\?\.ok === false/);
assert.match(ui, /cache: 'no-store'/);
assert.match(ui, /AbortController/);
assert.doesNotMatch(middleware, /PUBLIC_PATHS\.add\('\/(?:api\/)?market-line-history'\)/, 'history is not exempted from existing auth');
assert.doesNotMatch(ui, /method: 'POST'|\.expectedNet|\.score|勝率/, 'read-only browser neither writes nor recomputes scoring');
const formSource = readFileSync(new URL('../app/market-line-history/history-browser.js', import.meta.url), 'utf8');
assert.match(formSource, /new FormData\(event.currentTarget\)/, 'submit must use visible native date/input values, not stale React state');
for (const name of ['league', 'from', 'through', 'gameKey']) assert.ok(formSource.includes(`name="${name}"`), 'all filters must participate in native form submission');
const submitBody = formSource.match(/function submit\(event\) \{([\s\S]*?)\n  \}/)?.[1];
assert.ok(submitBody);
let submittedFilters, retainedFilters, prevented = false;
const submit = new Function('event', 'EMPTY_HISTORY_FILTERS', 'FormData', 'setDraft', 'load', submitBody);
const visible = { league: 'CPBL', from: '2026-10-11', through: '2026-10-12', gameKey: '2885069034028059' };
submit({ preventDefault() { prevented = true; }, currentTarget: visible }, EMPTY_HISTORY_FILTERS,
  class NativeFormFixture { constructor(form) { this.form = form; } get(key) { return this.form[key]; } },
  filters => { retainedFilters = filters; }, filters => { submittedFilters = filters; });
assert.equal(prevented, true);
assert.deepEqual(submittedFilters, visible, 'native date values participate even when the draft was not updated');
assert.deepEqual(retainedFilters, visible, 'submitted visible values remain displayed after the busy rerender');
console.log('historical market line UI: scoped totals, exact saved prices, Taipei chronology, native form values, pagination and integrity states PASS');
