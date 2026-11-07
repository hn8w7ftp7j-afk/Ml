import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMPTY_HISTORY_FILTERS, HISTORY_LEAGUES, groupHistoryRows, historyFilterLabel, historyQueryUrl,
  historyFiltersFromSearch, historyGameFilters, historyGameKeyLimit, historyMarketStatusText, historyRecordLabel,
  historyRowKey, historyWater, mergeHistoryRows, taipeiHistoryTime, validateHistoryResponse,
  historyDisplayMarkets, historyIntegrityNotice, historyInterpretationSummary, historyMarketHasDirections } from '../app/market-line-history/history-view.js';

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

assert.deepEqual(HISTORY_LEAGUES, ['MLB', 'NBA', 'NPB', 'KBO', 'CPBL', 'EPL', 'UCL']);
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
assert.throws(() => historyQueryUrl({ ...EMPTY_HISTORY_FILTERS, league: 'NBA', gameKey: 'a'.repeat(81) }), /80/);
assert.throws(() => historyQueryUrl({ ...EMPTY_HISTORY_FILTERS, league: 'EPL', gameKey: 'a'.repeat(201) }), /200/);
assert.equal(validateHistoryResponse(payload), payload);
assert.throws(() => validateHistoryResponse({ ...payload, totals: {} }), /未當成成功或零筆/);
assert.throws(() => validateHistoryResponse({ ...payload, nextAfter: null }), /格式不完整/);
assert.throws(() => validateHistoryResponse({ ...payload, leagues: [{ league: 'CPBL', savedStates: undefined }] }), /格式不完整/);
assert.throws(() => validateHistoryResponse({ ...payload, rows: [{ ...first, markets: [null] }] }), /格式不完整/);
assert.throws(() => validateHistoryResponse({ ...payload, rows: [{ ...first, gameLabel: {} }] }), /格式不完整/);
assert.throws(() => validateHistoryResponse({ ...payload, sourceTable: 'baseball_analysis_pit_snapshots' }), /格式不完整/, 'old analysis snapshots cannot masquerade as raw change archive');
assert.equal(validateHistoryResponse({ ...payload, rows: [], leagues: [], totals: { savedStates: 0, gameDateKeys: 0, boardDates: 0 }, hasMore: false, nextAfter: null }).totals.savedStates, 0);
assert.equal(validateHistoryResponse({ ...payload, rows: [{ ...first, integrity: { ok: false, issues: ['invalid'] }, markets: [{ market: '全場大小', status: 'INVALID' }] }] }).rows[0].integrity.ok, false, 'invalid saved state remains visibly identifiable');

const soccer = { ...first, league: 'EPL', gameKey: '03:00|arsenal|manchester-city', gameLabel: 'Arsenal @ Manchester City 03:00',
  recordKind: 'READER_OBSERVATION', recordId: `${'a'.repeat(64)}:0`, sourceTable: 'sports_soccer_reader_observations_v2',
  observationId: 'a'.repeat(64), receivedAt: '2026-10-08T10:00:01.000Z', persistedAt: '2026-10-08T10:00:02.000Z',
  identityBasis: 'READER_BOARD_TIME_AND_TEAM_KEYS',
  markets: [{ market: '全場讓分', status: 'AVAILABLE', directions: [
    { pick: 'Arsenal讓1+50', water: 0.964, contractIndex: 0 }, { pick: 'Manchester City受讓1+50', water: 1.02, contractIndex: 0 },
    { pick: 'Arsenal讓1.5', water: 1.05, contractIndex: 1 }, { pick: 'Manchester City受讓1.5', water: 0.85, contractIndex: 1 },
  ] }, { market: '全場大小', status: 'LOCKED', directions: [] },
  { market: '上半讓分', status: 'PERIOD_UNKNOWN', directions: [] }, { market: '上半大小', status: 'NOT_CAPTURED', directions: [] }] };
const soccerPayload = { ...payload, sourceTables: ['tai888_market_line_history_v1', 'sports_soccer_reader_observations_v2'],
  leagues: [{ league: 'EPL', savedStates: 1, gameDateKeys: 1, boardDates: 1, countUnit: 'READER_GAME_OBSERVATIONS' }], rows: [soccer] };
assert.equal(validateHistoryResponse(soccerPayload), soccerPayload, 'seven-league responses preserve multiple contracts and unknown/locked states');
assert.throws(() => validateHistoryResponse({ ...soccerPayload, rows: [{ ...soccer, markets: [{ ...soccer.markets[0], directions: soccer.markets[0].directions.slice(0, 3) }] }] }), /格式不完整/, 'unpaired market direction cannot look available');
assert.throws(() => validateHistoryResponse({ ...soccerPayload, sourceTables: ['arbitrary_table'] }), /格式不完整/);
assert.throws(() => validateHistoryResponse({ ...soccerPayload, rows: [{ ...soccer, sourceTable: 'bet_ledger' }] }), /格式不完整/);
assert.throws(() => validateHistoryResponse({ ...soccerPayload, rows: [{ ...soccer, recordId: '' }] }), /格式不完整/, 'missing observation identity must not silently collapse saved observations');
assert.equal(historyRecordLabel(soccer), '讀盤觀測');
assert.equal(historyRecordLabel(first), '變盤版本');
const interpretation = { version: 'SOCCER-HISTORY-PERIOD-INTERPRETATION-v1',
  basis: 'SAME_OBSERVATION_PRIMARY_AND_EXPLICIT_HT', interpretedAt: '2026-11-08T00:00:00.000Z',
  observationId: soccer.observationId, historicalAvailabilityVerified: false, executable: false };
const interpreted = { ...soccer, integrity: { ok: false, issues: ['PERIOD_UNKNOWN'] },
  markets: [{ market: '全場讓分', period: 'FT', kind: 'HANDICAP', status: 'PERIOD_UNKNOWN', directions: [], contracts: [] }],
  historyInterpretation: { ...interpretation, status: 'RETROSPECTIVE_INTERPRETATION', interpretedContractCount: 2,
    originalPeriods: ['UNKNOWN'], displayPeriods: ['FT'] },
  displayMarkets: [{ market: '全場讓分', period: 'FT', kind: 'HANDICAP', status: 'RETROSPECTIVE_INTERPRETATION',
    directions: soccer.markets[0].directions,
    contracts: [{ period: 'FT', line: '1+50', historyPeriodInterpretation: { ...interpretation, originalPeriod: 'UNKNOWN', displayPeriod: 'FT' } },
      { period: 'FT', line: '1.5' }] },
  { market: '全場勝平負', period: 'FT', kind: 'MONEYLINE', status: 'RETROSPECTIVE_INTERPRETATION',
    directions: [{ side: 'away', pick: 'Arsenal勝', water: 1.5 }, { side: 'draw', pick: '和局', water: 2.5 }, { side: 'home', pick: 'Manchester City勝', water: 1.2 }],
    contracts: [{ period: 'FT', historyPeriodInterpretation: { ...interpretation, originalPeriod: 'UNKNOWN', displayPeriod: 'FT' } }] }] };
const originalBeforeDisplay = JSON.stringify(interpreted.markets);
assert.equal(validateHistoryResponse({ ...soccerPayload, rows: [interpreted] }).rows[0], interpreted,
  'a retrospective display can include both derived and originally explicit contracts without replacing saved market states');
assert.equal(historyDisplayMarkets(interpreted), interpreted.displayMarkets);
assert.equal(historyDisplayMarkets(soccer), soccer.markets, 'older responses remain readable');
assert.equal(JSON.stringify(interpreted.markets), originalBeforeDisplay, 'display selection does not mutate original saved markets');
assert.equal(historyMarketHasDirections(interpreted.displayMarkets[1]), true, 'three-way prices are displayed without being rejected as an unpaired two-way market');
assert.equal(historyMarketHasDirections({ ...interpreted.displayMarkets[1], directions: interpreted.displayMarkets[1].directions.slice(0, 2) }), false);
assert.equal(historyIntegrityNotice(interpreted), '', 'a retained original UNKNOWN marker does not become a blanket data-integrity warning after display recognition');
assert.match(historyInterpretationSummary(interpreted), /UNKNOWN.*查閱時辨識.*不代表當時已可分析或下注/);
assert.match(historyInterpretationSummary(interpreted), /2026\/11\/08\s08:00:00/, 'interpretation timestamp uses Taipei separately from observation time');
assert.match(historyIntegrityNotice({ ...interpreted, integrity: { ok: false, issues: ['SOURCE_PAYLOAD_HASH_MISMATCH'] } }), /完整性核對/);
assert.match(historyIntegrityNotice({ ...interpreted, historyInterpretation: null, displayMarkets: undefined }), /部分市場/);
for (const change of [{ executable: true }, { historicalAvailabilityVerified: true }, { observationId: 'b'.repeat(64) },
  { interpretedAt: '2026-10-08T10:00:00.000Z' }, { version: 'caller-approved' }]) {
  const invalid = structuredClone(interpreted);
  Object.assign(invalid.displayMarkets[0].contracts[0].historyPeriodInterpretation, change);
  assert.throws(() => validateHistoryResponse({ ...soccerPayload, rows: [invalid] }), /格式不完整/,
    `invalid retrospective provenance must be rejected: ${JSON.stringify(change)}`);
}
assert.throws(() => validateHistoryResponse({ ...soccerPayload, rows: [{ ...interpreted, historyInterpretation: { ...interpreted.historyInterpretation, interpretedContractCount: 99 } }] }), /格式不完整/);
assert.throws(() => validateHistoryResponse({ ...payload, rows: [{ ...first, displayMarkets: interpreted.displayMarkets, historyInterpretation: interpreted.historyInterpretation }] }), /格式不完整/,
  'soccer interpretation cannot leak into another league');
assert.match(historyMarketStatusText('PERIOD_UNKNOWN'), /期間未確認/);
assert.match(historyMarketStatusText('LOCKED'), /鎖盤/);
assert.match(historyMarketStatusText('NOT_CAPTURED'), /未保存/);
assert.equal(historyGameKeyLimit('UCL'), 200);
assert.equal(historyGameKeyLimit('NBA'), 80);
const deepFilters = historyGameFilters(soccer);
assert.deepEqual(deepFilters, { league: 'EPL', from: soccer.boardDate, through: soccer.boardDate, gameKey: soccer.gameKey });
const pageSearch = new URL(historyQueryUrl(deepFilters), 'https://example.test').search;
assert.deepEqual(historyFiltersFromSearch(pageSearch), deepFilters, 'coverage/per-game deep links preserve league, day and exact source identity');
assert.deepEqual(historyFiltersFromSearch(''), EMPTY_HISTORY_FILTERS);

const merged = mergeHistoryRows([later], [first, later]);
assert.equal(merged.length, 2, 'repeated page rows do not inflate loaded counts');
assert.equal(merged[0].observedAt, first.observedAt, 'timeline is chronological');
assert.notEqual(historyRowKey(first), historyRowKey({ ...first, boardDate: '2026-10-09' }));
assert.notEqual(historyRowKey(first), historyRowKey({ ...first, league: 'KBO' }));
assert.notEqual(historyRowKey(soccer), historyRowKey({ ...soccer, recordId: `${'b'.repeat(64)}:0` }));
assert.equal(mergeHistoryRows([soccer], [{ ...soccer, recordId: `${'b'.repeat(64)}:0` }, soccer]).length, 2,
  'two source observations at the same time survive pagination while repeated rows are deduplicated');
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
assert.match(ui, /目前已載入紀錄/);
assert.match(ui, /筆數不代表全部歷史都已收齊/);
assert.match(ui, /不是舊分析快照庫/);
assert.match(ui, /這不代表當時沒有比賽或沒有開盤/);
assert.match(ui, /載入下一頁/);
assert.match(ui, /row\.integrity\?\.ok === false/);
assert.match(ui, /historyDisplayMarkets\(row\)\.map/);
assert.match(ui, /查閱時辨識/);
assert.match(ui, /historyInterpretation: row.historyInterpretation/);
assert.match(ui, /cache: 'no-store'/);
assert.match(ui, /AbortController/);
assert.match(ui, /只查這一場/);
assert.match(ui, /historyFiltersFromSearch\(window.location.search\)/);
assert.match(ui, /保存與查詢不依賴下注狀態/);
assert.match(ui, /觀測筆數不等於變盤次數/);
assert.match(ui, /identityBasis: row.identityBasis/);
assert.match(ui, /persistedAt: row.persistedAt/);
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
