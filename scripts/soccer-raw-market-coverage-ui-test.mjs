import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuditHarness } from './lib/history-audit-ui-harness.mjs';

const componentPath = 'app/market-line-history/raw-market-coverage-panel.js';
const factory = await createAuditHarness(componentPath, 'RawMarketCoveragePanel');
const instant = '2026-11-06T15:59:43.148Z', until = '2026-11-10T04:00:00.000Z';
const scope = { league: 'EPL', date: '2026-11-07' };
const hash = letter => letter.repeat(64);
const flags = { archiveOnly: true, currentBoardUpdated: false, historicalAvailabilityVerified: false, executable: false,
  formalEligible: false, calibrationEligible: false, coverageComplete: false, closingCoverage: 'NOT_VERIFIED', completeHistory: false, identityVerified: false, simultaneousCoverageVerified: false };
const keys = ['FT:HANDICAP', 'FT:TOTAL', 'HT:HANDICAP', 'HT:TOTAL'];
function fixture() {
  const source = { captureId: hash('a'), batchHash: hash('b'), derivedHash: hash('c'), status: 'VERIFIED', reason: null,
    observedAt: instant, receivedAt: instant, persistedAt: instant,
    fragments: [{ captureId: hash('a'), evidenceHash: hash('d'), partIndex: 0, partCount: 1, receivedAt: instant, persistedAt: instant }] };
  return { ok: true, schema: 'soccer-raw-market-coverage-v1', ...flags, ...scope, until, status: 'WITNESSES_FOUND',
    schedule: { fingerprint: hash('e'), officialGameCount: 1, sourceScope: 'RETURNED_PROVIDER_PAGES_ONLY', providerCompletenessVerified: false },
    inventory: { status: 'READ', candidateRows: 1, candidatesTruncated: false, candidateScanComplete: true, matchedGameCount: 1, unmatchedCandidates: 0 },
    sources: [source], budget: { maxBatchReads: 8, batchReads: 1, sourceBytesReserved: 2048, sourceBytesRead: 2048, maxSourceBytes: 10485760,
      maxMetadataBytes: 2097152, metadataBytesRead: 512, metadataByteBasis: 'SERIALIZED_CANDIDATE_ROWS_JSONB_TEXT',
      timeBudgetMs: 25000, budgetKind: 'SOFT_DEADLINE', hardDeadlineEnforced: false }, reasonCodes: [],
    games: [{ gameId: 'soccer:epl:401879242', label: '高雲地利 @ 愛華頓', startTime: '2026-11-06T20:00:00.000Z', status: 'final',
      identityBasis: 'DISPLAY_MATCH_TO_CURRENT_PROVIDER_SCHEDULE', rawGameKeys: [hash('f')], witnessStatus: 'FOUR_CELLS_WITNESSED',
      cells: Object.fromEntries(keys.map((key, index) => { const [period, kind] = key.split(':'); return [key, { status: 'WITNESSED', witnesses: [{
        gameId: 'soccer:epl:401879242', rawGameKey: hash('f'), batchHash: source.batchHash, derivedHash: source.derivedHash, sourceObservedAt: instant, sourceReceivedAt: instant, sourcePersistedAt: instant,
        period, originalPeriod: period === 'FT' ? 'UNKNOWN' : 'HT', periodBasis: 'SAME_ROW_PRIMARY_AND_EXPLICIT_HT_COLUMNS', isAlternative: index % 2 === 1, kind,
        line: kind === 'HANDICAP' ? '1+50' : '3+50', lineSide: kind === 'HANDICAP' ? 'home' : null,
        homeWater: kind === 'HANDICAP' ? 0.76 : null, awayWater: kind === 'HANDICAP' ? 1.13 : null,
        overWater: kind === 'TOTAL' ? 1.02 : null, underWater: kind === 'TOTAL' ? 0.84 : null,
        source: { tableIndex: 36, rowIndex: index % 2 === 1 ? 32 : 3, columnIndex: [3, 3, 6, 5][index] },
      }] }]; })) }] };
}
function unknownFixture() {
  const value = fixture(); value.status = 'UNKNOWN'; value.reasonCodes = ['RAW_SEEN_RECOVERY_BUDGET_EXCEEDED'];
  Object.assign(value.sources[0], { status: 'UNKNOWN', reason: 'RAW_SEEN_RECOVERY_BUDGET_EXCEEDED', derivedHash: null, observedAt: null,
    receivedAt: null, persistedAt: null, fragments: [] });
  value.games[0].witnessStatus = 'NOT_CHECKED'; value.games[0].rawGameKeys = [];
  for (const key of keys) value.games[0].cells[key] = { status: 'NOT_CHECKED', witnesses: [] };
  return value;
}
function emptyFixture() {
  const value = fixture(); value.status = 'PARTIAL'; value.reasonCodes = ['NO_OFFICIAL_GAMES_RETURNED']; value.schedule.officialGameCount = 0;
  value.games = []; value.sources = []; value.inventory = { status: 'READ', candidateRows: 0, candidatesTruncated: false, candidateScanComplete: true, matchedGameCount: 0, unmatchedCandidates: 0 };
  Object.assign(value.budget, { batchReads: 0, sourceBytesRead: 0, sourceBytesReserved: 0 }); return value;
}
function setScope(h, target = scope) { h.change('原始逐場核對聯盟', target.league); h.change('原始逐場核對盤日', target.date); }

const h = factory(); h.render();
assert.equal(h.calls.length, 0, 'no automatic requests on mount');
assert.match(h.markup, /逐場核對結果：未確認/);
assert.equal(h.scope.rawMarketCoverageToday(Date.parse('2026-11-06T16:00:00Z')), '2026-11-07', 'default date uses Taipei');
assert.equal(h.scope.validateRawMarketCoverage(fixture(), scope).games.length, 1);
assert.equal(h.scope.validateRawMarketCoverage(unknownFixture(), scope).sources[0].observedAt, null);
assert.equal(h.scope.validateRawMarketCoverage(emptyFixture(), scope).games.length, 0);
for (const mutate of [
  value => { value.ok = false; }, value => { value.schema = 'wrong'; }, value => { value.league = 'UCL'; }, value => { value.date = '2026-11-08'; },
  value => { value.until = '2026-02-30T04:00:00Z'; }, value => { value.status = 'COMPLETE'; },
  value => { value.schedule.fingerprint = 'fake'; }, value => { value.schedule.officialGameCount = 2; },
  value => { value.schedule.providerCompletenessVerified = true; }, value => { value.schedule.sourceScope = 'ALL_OFFICIAL_GAMES'; },
  value => { value.inventory.status = 'NOT_VERIFIED'; }, value => { value.inventory.candidateScanComplete = false; }, value => { value.inventory.candidateRows = null; }, value => { value.inventory.matchedGameCount = 2; },
  value => { value.budget.sourceBytesRead = 0; }, value => { value.budget.metadataBytesRead = 0; },
  value => { value.sources[0].fragments[0].persistedAt = '2026-11-06T15:59:42Z'; },
  value => { value.budget.batchReads = 0; }, value => { value.budget.batchReads = 9; }, value => { value.budget.sourceBytesRead = 2049; },
  value => { value.budget.sourceBytesReserved = 10485761; }, value => { value.budget.maxSourceBytes = 999999999; },
  value => { value.budget.metadataBytesRead = 2097153; }, value => { value.budget.maxMetadataBytes = 999999999; },
  value => { value.budget.metadataByteBasis = 'NORMALIZED_OUTPUT'; }, value => { value.budget.hardDeadlineEnforced = true; }, value => { value.budget.timeBudgetMs = 60000; },
  value => { value.sources[0].derivedHash = hash('f'); }, value => { value.sources[0].observedAt = null; },
  value => { value.sources[0].fragments[0].partCount = 2; }, value => { value.sources[0].fragments[0].evidenceHash = 'fake'; }, value => { value.sources[0].fragments[0].captureId = hash('f'); },
  value => { value.sources.push(structuredClone(value.sources[0])); value.budget.batchReads++; },
  value => { value.games[0].gameId = 'soccer:epl:999999'; },
  value => { value.games[0].rawGameKeys = []; }, value => { value.games[0].rawGameKeys = [hash('f'), hash('f')]; },
  value => { value.games[0].cells['FT:HANDICAP'].witnesses[0].rawGameKey = hash('e'); },
  value => { value.games[0].cells['HT:TOTAL'].witnesses[0].source.columnIndex = 3; },
  value => { value.games[0].cells['FT:HANDICAP'].witnesses[0].isAlternative = true; },
  value => { value.games[0].cells['FT:TOTAL'].witnesses[0].line = 'not-a-line'; },
  value => { value.games[0].gameId = 'soccer:ucl:401879242'; }, value => { value.games[0].identityBasis = 'PREGAME_VERIFIED'; },
  value => { value.games[0].witnessStatus = 'NOT_CHECKED'; value.games[0].rawGameKeys = []; }, value => { value.games[0].witnessStatus = 'PARTIAL'; },
  value => { value.games[0].cells['FT:HANDICAP'].status = 'NOT_WITNESSED'; },
  value => { delete value.games[0].cells['FT:HANDICAP'].witnesses[0].gameId; },
  value => { value.games[0].cells['FT:HANDICAP'].witnesses[0].gameId = 'soccer:epl:401879243'; },
  value => { value.games[0].cells['FT:HANDICAP'].witnesses[0].line = '任意文字'; },
  value => { value.games[0].cells['FT:HANDICAP'].witnesses[0].line = '1+50garbage'; },
  value => { value.games[0].cells['FT:HANDICAP'].witnesses[0].batchHash = hash('f'); },
  value => { value.games[0].cells['FT:HANDICAP'].witnesses[0].sourceObservedAt = '2026-11-06T15:59:44Z'; },
  value => { value.games[0].cells['FT:HANDICAP'].witnesses[0].originalPeriod = 'FT'; },
  value => { value.games[0].cells['HT:TOTAL'].witnesses[0].originalPeriod = 'UNKNOWN'; },
  value => { delete value.games[0].cells['FT:TOTAL'].witnesses[0].isAlternative; },
  value => { value.games[0].cells['FT:TOTAL'].witnesses[0].isAlternative = 'false'; },
  value => { value.games[0].cells['FT:TOTAL'].witnesses[0].periodBasis = 'OFFICIAL_VERIFIED'; },
  value => { value.games[0].cells['FT:TOTAL'].witnesses[0].underWater = null; },
  value => { value.games[0].cells['FT:HANDICAP'].witnesses[0].awayWater = 0; },
  value => { value.games[0].cells['FT:HANDICAP'].witnesses[0].overWater = 1; },
  value => { value.games[0].cells['HT:TOTAL'].witnesses[0].source.rowIndex = -1; },
  ...Object.keys(flags).map(key => value => { value[key] = typeof flags[key] === 'boolean' ? !flags[key] : 'COMPLETE'; }),
]) { const value = fixture(); mutate(value); assert.throws(() => h.scope.validateRawMarketCoverage(value, scope), /未通過驗證/); }
const bounded = fixture(); Object.assign(bounded.budget, { maxBatchReads: 1, maxSourceBytes: 4096, timeBudgetMs: 1000 });
assert.equal(h.scope.validateRawMarketCoverage(bounded, scope).budget.maxBatchReads, 1, 'smaller safe budgets are accepted');
for (const [index, key] of keys.entries()) {
  for (const column of [0, 2, 3, 4, 5, 6, 7, 8].filter(column => column !== [3, 3, 6, 5][index])) {
    const wrongColumn = fixture(); wrongColumn.games[0].cells[key].witnesses[0].source.columnIndex = column;
    assert.throws(() => h.scope.validateRawMarketCoverage(wrongColumn, scope), /未通過驗證/, key + ' rejects column ' + column);
  }
}
const falseZero = unknownFixture(); falseZero.sources[0].observedAt = instant;
assert.throws(() => h.scope.validateRawMarketCoverage(falseZero, scope), /未通過驗證/);
const falseEmpty = emptyFixture(); falseEmpty.status = 'WITNESSES_FOUND';
assert.throws(() => h.scope.validateRawMarketCoverage(falseEmpty, scope), /未通過驗證/);
const partial = fixture(); partial.status = 'PARTIAL'; partial.games[0].witnessStatus = 'PARTIAL';
partial.games[0].cells['HT:TOTAL'] = { status: 'NOT_WITNESSED', witnesses: [] };
assert.equal(h.scope.validateRawMarketCoverage(partial, scope).games[0].witnessStatus, 'PARTIAL');

setScope(h); const first = h.click('核對原始盤口場次'); h.click('核對原始盤口場次');
assert.equal(h.calls.length, 1, 'double click is bounded synchronously');
assert.equal(h.calls[0].url, '/api/soccer/raw-market-coverage?league=EPL&date=2026-11-07');
assert.equal(h.calls[0].options.method, 'GET'); assert.equal(h.calls[0].options.cache, 'no-store');
h.calls[0].respond(fixture()); await first; await h.settle();
assert.match(h.markup, /本次回傳場次的四類市場均找到至少一條雙邊價格見證/); assert.match(h.markup, /非同時盤/);
assert.match(h.markup, /全場為歷史辨識；原文未標全場/); assert.match(h.markup, /原文明示上半場/);
assert.match(h.markup, /主盤：/); assert.match(h.markup, /替代盤：/); assert.match(h.markup, /主盤與所有替代盤/);
assert.match(h.markup, /主讓1\+50/); assert.match(h.markup, /客 1.13／主 0.76/);
assert.match(h.markup, /大 1.02／小 0.84/); assert.match(h.markup, /保存識別/);
assert.doesNotMatch(h.markup, /已完整保存全部盤口|全部尾盤完整|可下注成功/);

h.change('原始逐場核對盤日', '2026-11-08');
assert.doesNotMatch(h.markup, /高雲地利/, 'changing scope clears an already displayed report');
assert.equal(h.calls.length, 1, 'scope changes stay on-demand');
const invalidInput = factory(); invalidInput.render(); invalidInput.change('原始逐場核對盤日', '2026-02-30');
invalidInput.click('核對原始盤口場次'); await invalidInput.settle(); assert.equal(invalidInput.calls.length, 0); assert.match(invalidInput.markup, /請選擇有效聯盟與盤日/);
const network = factory(); network.render(); setScope(network); const nq = network.click('核對原始盤口場次');
network.calls[0].reject(Error('network failed')); await nq; await network.settle(); assert.match(network.markup, /仍未確認/);
const delayedJson = factory(); delayedJson.render(); setScope(delayedJson); let resolveJson;
const json = new Promise(resolve => { resolveJson = resolve; }); const jq = delayedJson.click('核對原始盤口場次');
delayedJson.calls[0].respond(json); await delayedJson.settle(); delayedJson.change('原始逐場核對聯盟', 'UCL');
resolveJson(fixture()); await jq; await delayedJson.settle(); assert.doesNotMatch(delayedJson.markup, /高雲地利/, 'late JSON cannot publish after league switch');

const empty = factory(); empty.render(); setScope(empty); const eq = empty.click('核對原始盤口場次'); empty.calls[0].respond(emptyFixture()); await eq; await empty.settle();
assert.match(empty.markup, /本次官方來源沒有回傳場次/); assert.doesNotMatch(empty.markup, /本次回傳場次的四類市場均找到/);
const unknown = factory(); unknown.render(); setScope(unknown); const uq = unknown.click('核對原始盤口場次'); unknown.calls[0].respond(unknownFixture()); await uq; await unknown.settle();
assert.match(unknown.markup, /尚未完成檢查/); assert.doesNotMatch(unknown.markup, /已找到雙邊價格|本次回傳場次的四類市場均找到/);
const missing = factory(); missing.render(); setScope(missing); const mq = missing.click('核對原始盤口場次'); missing.calls[0].respond(partial); await mq; await missing.settle();
assert.match(missing.markup, /已讀來源未見有效雙邊價格/); assert.match(missing.markup, /仍有市場缺少見證/);

for (const status of [401, 403, 429, 503]) {
  const failed = factory(); failed.render(); setScope(failed); const query = failed.click('核對原始盤口場次'); failed.calls[0].respond({ ok: false }, status); await query; await failed.settle();
  assert.match(failed.markup, /仍未確認/); assert.doesNotMatch(failed.markup, /本次回傳場次的四類市場均找到/);
}
const late = factory(); late.render(); setScope(late); const lq = late.click('核對原始盤口場次');
late.change('原始逐場核對盤日', '2026-11-08'); assert.equal(late.calls[0].options.signal.aborted, true);
late.calls[0].respond(fixture()); await lq; await late.settle(); assert.match(late.markup, /逐場核對結果：未確認/);
assert.doesNotMatch(late.markup, /高雲地利/);
const timeout = factory(); timeout.render(); setScope(timeout); const tq = timeout.click('核對原始盤口場次'); timeout.expire(); await timeout.settle();
assert.equal(timeout.calls[0].options.signal.aborted, true); assert.match(timeout.markup, /查詢逾時/);
timeout.calls[0].respond(fixture()); await tq; await timeout.settle(); assert.doesNotMatch(timeout.markup, /高雲地利/);
const unmount = factory(); unmount.render(); setScope(unmount); const um = unmount.click('核對原始盤口場次'); unmount.unmount();
unmount.calls[0].respond(fixture()); await um; await unmount.settle(); assert.equal(unmount.afterUnmountMutations, 0);
const html = fixture(); html.games[0].label = '<script>untrusted team</script>';
const escaped = factory(); escaped.render(); setScope(escaped); const xq = escaped.click('核對原始盤口場次'); escaped.calls[0].respond(html); await xq; await escaped.settle();
assert.match(escaped.markup, /&lt;script&gt;untrusted team&lt;\/script&gt;/); assert.doesNotMatch(escaped.markup, /<script>untrusted/);

if (process.argv.includes('--contract-fixture')) {
  const path = join(tmpdir(), 'raw-market-coverage-contract-fixtures.json');
  const produced = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.ok(Array.isArray(produced.cases) && produced.cases.length > 0, 'actual backend fixture cases must exist');
  for (const entry of produced.cases) {
    assert.ok(entry.name); assert.equal(entry.httpStatus, entry.body.ok ? 200 : 503, entry.name);
    if (entry.body.ok) h.scope.validateRawMarketCoverage(entry.body, entry.scope);
    else assert.throws(() => h.scope.validateRawMarketCoverage(entry.body, entry.scope), /未通過驗證/, entry.name);
    const ui = factory(); ui.render(); setScope(ui, entry.scope); const result = ui.click('核對原始盤口場次'); ui.calls[0].respond(entry.body, entry.httpStatus); await result; await ui.settle();
    if (entry.body.ok) {
      assert.doesNotMatch(ui.markup, /回應未通過核對/, entry.name);
      assert.match(ui.markup, entry.body.games.length ? /四類市場的價格見證/ : /沒有回傳場次/, entry.name);
    } else {
      assert.match(ui.markup, /仍未確認/, entry.name); assert.doesNotMatch(ui.markup, /已找到雙邊價格|本次回傳場次的四類市場均找到/, entry.name);
    }
  }
}
const page = fs.readFileSync('app/market-line-history/page.js', 'utf8');
assert.match(page, /import RawMarketCoveragePanel/); assert.match(page, /<RawMarketCoveragePanel\/>/);
for (const name of ['RawHistoryMaintenancePanel', 'RawSeenHistoryAuditPanel', 'RawSeenHistoryIndexPanel', 'LegacyHistoryPanel', 'ArchivePanel']) assert.match(page, new RegExp(`<${name}\\/>`));
console.log('PASS raw market coverage UI: readonly official display witnesses, strict source/price/period contracts, empty/partial/unknown, abort/timeout/scope fences; Production NOT VERIFIED');
