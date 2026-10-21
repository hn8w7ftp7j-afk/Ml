import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { canonicalReaderPayload, parseTai888Capture, readerMarketProperties } from '../reader/parser.js';
import { assessBoardCandidate, selectAuthoritativeBoard } from '../reader/board-selector.js';
import { normalizeNbaReaderPayload } from '../lib/nba/reader.js';

const context = { globalThis: {} };
vm.createContext(context);
for (const file of ['capture-policy.js', 'league-registry.js', 'row-normalizer.js']) {
  vm.runInContext(fs.readFileSync(new URL(`../reader/${file}`, import.meta.url), 'utf8'), context);
}
const { Tai888LeagueRegistry: registry, Tai888CapturePolicy: policy, Tai888RowNormalizer: normalizer } = context.globalThis;
for (const label of ['美國職籃', '美国职篮', '美國職業籃球', '美國職業籃球聯賽', '美国职业篮球联赛']) {
  assert.equal(registry.identify(`聯盟：NBA ${label} 季前賽（1）`), 'NBA');
  for (const special of ['走地', 'LIVE', '主隊總得分', '特殊']) assert.equal(registry.standardMarker(`聯盟：NBA ${label} ${special}`, 'NBA'), false);
}
assert.equal(registry.identify('NBA 美籃導覽'), null, 'navigation is not a league section');
assert.equal(registry.identify('聯盟：WNBA 美國女子職籃（1）'), null);
for (const description of ['美國職業籃球-熱身賽(2)', '美國職籃 季前賽(2)', 'NBA Cup(2)', '另一個賽季名稱(2)', '(2)']) {
  assert.equal(registry.standardMarker(`聯盟：NBA ${description}`, 'NBA'), true, 'NBA identity must survive competition display-name changes');
}
assert.equal(registry.identify('聯盟：NBA2 另一個聯盟'), null);
assert.equal(registry.identify('聯盟：WNBA 熱身賽(2)'), null);
assert.equal(registry.identify('聯盟：NBA 美國職籃 聯盟：MLB 美國職棒'), null);
for (const suffix of ['第一節', '前五局', '特殊分數', '新合約']) {
  assert.equal(registry.standardMarker(`聯盟：NBA 美國職籃 ${suffix}（1）`, 'NBA'), false);
  assert.equal(registry.standardMarker(`聯盟：MLB 美國職棒 ${suffix}（1）`, 'MLB'), false, 'preserve v2.1.26 unknown-contract rejection');
}
assert.equal(policy.shouldKeepRecord(4, '時間 主客隊伍 讓分 大小盤'), true);
assert.equal(policy.shouldKeepRecord(4, '08:00 湖人[主] 5+50 0.940 小 0.950'), true, 'name-only home rows must reach the normalizer');

const now = new Date('2026-10-04T23:00:00Z');
const headers = ['時間', '主客隊伍', '全場讓分', '全場大小', '上半場讓分', '上半場大小'];
const cell = pair => ({ pair, lines: pair });
function capture({ homeFirst = false, half = true, locked = false, league = 'NBA', total = '220+50', halfTotal = '110-20' } = {}) {
  const teams = ['BOS-塞爾提克', 'LAL-湖人[主]'];
  const spread = locked ? ['', ''] : ['5+90 0.970', '0.930'];
  const halfSpread = half && !locked ? ['0.950', '2-20 0.910'] : ['', ''];
  if (homeFirst) { teams.reverse(); spread.reverse(); halfSpread.reverse(); }
  return {
    version: 'TAI888-DOM-CAPTURE-v2.2.0', league, sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/#/BS', observedAt: now.toISOString(),
    tables: [{ headers, rows: [{ marketLocked: locked, cells: [cell(['10-05', '08:00']), cell(teams), cell(spread), cell(locked ? ['', ''] : [`${total} 大 0.980`, '小 0.920']), cell(halfSpread), cell(half && !locked ? ['小 0.940', `${halfTotal} 大 0.960`] : ['', ''])] }] }],
    diagnostics: { gameCount: 1, expectedGameCount: 1, lastMutationAt: now.toISOString() },
  };
}
const complete = parseTai888Capture(capture(), now);
const homeFirst = parseTai888Capture(capture({ homeFirst: true }), now);
assert.equal(complete.version, 'TAI888-READER-DOM-v2.2.0');
assert.equal(complete.league, 'NBA');
assert.equal(complete.games.length, 1);
const game = complete.games[0];
assert.deepEqual(game, homeFirst.games[0], 'visual team order cannot invert the spread');
assert.deepEqual([game.awayCode, game.homeCode, game.boardDate, game.boardTime], ['BOS', 'LAL', '2026-10-05', '08:00']);
assert.equal(game.fullRunline.lineSide, 'away');
assert.equal(game.fullRunline.line, '5+90');
assert.deepEqual([game.fullRunline.awayWater, game.fullRunline.homeWater], [0.97, 0.93]);
assert.equal(game.firstHalfRunline.lineSide, 'home');
assert.equal(game.firstHalfRunline.line, '2-20');
assert.equal(game.fullTotal.line, '220+50');
assert.deepEqual([game.firstHalfTotal.line, game.firstHalfTotal.overWater, game.firstHalfTotal.underWater], ['110-20', 0.96, 0.94]);
assert.equal(Object.hasOwn(game, 'first5Runline'), false);
assert.equal(Object.hasOwn(game, 'first5Total'), false);
assert.deepEqual(Object.keys(game.marketStates), ['fullRunline', 'fullTotal', 'firstHalfRunline', 'firstHalfTotal']);
const wire = JSON.parse(canonicalReaderPayload(complete));
assert.equal(Object.hasOwn(wire.games[0], 'first5Runline'), false);
assert.equal(Object.hasOwn(wire.games[0], 'first5Total'), false);
assert.equal(wire.games[0].firstHalfTotal.line, '110-20');

function candidate(input = capture(), frameId = 0, tabId = 1) { return { tabId, frameId, active: true, lastAccessed: +now, capture: input, parsed: parseTai888Capture(input, now) }; }
assert.equal(assessBoardCandidate(candidate(), +now).ok, true);
assert.equal(selectAuthoritativeBoard([candidate()], { league: 'NBA', now: +now }).ok, true);
const partial = candidate(capture({ half: false }));
assert.equal(partial.parsed.games[0].firstHalfRunline, null);
assert.equal(partial.parsed.games[0].firstHalfTotal, null);
assert.equal(assessBoardCandidate(partial, +now).ok, true, 'unopened halves do not discard valid full-game odds');
assert.equal(selectAuthoritativeBoard([partial], { league: 'NBA', now: +now }).ok, true);
const lock = candidate(capture({ locked: true }));
assert.equal(lock.parsed.games[0].marketStatus, 'locked');
assert.equal(assessBoardCandidate(lock, +now).ok, true);
const conflicting = candidate(capture({ halfTotal: '111-20' }), 1);
assert.equal(selectAuthoritativeBoard([candidate(), conflicting], { league: 'NBA', now: +now }).error, 'conflicting-duplicate-frames', 'NBA half odds participate in conflict detection');
const conflictingPartial = candidate(capture({ half: false, total: '221+50' }), 1);
assert.equal(selectAuthoritativeBoard([candidate(), conflictingPartial], { league: 'NBA', now: +now }).error, 'conflicting-duplicate-frames');
const duplicate = capture(); duplicate.tables[0].rows.push(...capture({ halfTotal: '111-20' }).tables[0].rows);
assert.ok(parseTai888Capture(duplicate, now).parseIssues.some(value => value.startsWith('conflicting-duplicate:')));
assert.equal(selectAuthoritativeBoard([candidate(capture({ league: 'MLB' }))], { league: 'NBA', now: +now }).ok, false, 'NBA cannot select a baseball frame with overlapping codes');
for (const period of ['前5', '前五']) {
  const wrongPeriod = capture();
  wrongPeriod.tables[0].headers[4] = `${period}讓球`;
  wrongPeriod.tables[0].headers[5] = `${period}大小`;
  const parsed = parseTai888Capture(wrongPeriod, now);
  assert.equal(parsed.games[0].firstHalfRunline, null, 'NBA cannot rename first-five innings into halves');
  assert.equal(parsed.games[0].firstHalfTotal, null);
  assert.ok(parsed.parseIssues.includes('wrong-period-header:NBA:first-five'));
  assert.equal(selectAuthoritativeBoard([candidate(wrongPeriod)], { league: 'NBA', now: +now }).ok, false);
}

const normalizerHeaders = ['時間', '主客隊伍', '讓分', '大小盤', '獨贏', '一輸二贏', '上半讓分', '上半大小'];
const spans = normalizerHeaders.map((_, index) => [index * 100, (index + 1) * 100]);
const rectCell = (text, index, top) => ({ text, lines: text ? [text] : [], rows: text ? [{ text, top, left: spans[index][0] }] : [], left: spans[index][0], right: spans[index][1] });
const record = (order, top, values) => ({ order, top, bottom: top + 20, text: values.filter(Boolean).join(' '), cells: values.map((text, index) => rectCell(text, index, top)).filter(value => value.text) });
// Reproduce the user's Tai888 NBA warm-up board, including the actual heading,
// space-separated team codes, swapped unsupported columns and empty halves.
const warmupRecords = [
  record(0, 0, ['時間', '主客隊伍', '讓球', '大小盤', '單雙', '獨贏', '上半讓球', '上半大小']),
  record(1, 30, ['聯盟： NBA 美國職業籃球-熱身賽(2)']),
  record(2, 60, ['10-05', 'UTA 爵士', '0.950', '236.5 大 0.940', '單 0.930', '1.430', '', '']),
  record(3, 82, ['07:05', 'DEN 金塊[主]', '5+50 0.950', '小 0.940', '雙 0.950', '0.530', '', '']),
  record(4, 105, ['10-05', 'GSW 勇士', '3+25 0.950', '222.5 大 0.940', '單 0.930', '0.560', '', '']),
  record(5, 127, ['07:05', 'LAC 快艇[主]', '0.950', '小 0.940', '雙 0.950', '1.360', '', '']),
];
const warmupNormalized = normalizer.normalizeRowRecords(warmupRecords, { expectedLeague: 'NBA' });
assert.equal(warmupNormalized.diagnostics.gameCount, 2, 'actual warm-up heading must not discard both NBA games');
const warmupParsed = parseTai888Capture({ ...capture({ half: false }), tables: warmupNormalized.tables, diagnostics: warmupNormalized.diagnostics }, now);
assert.equal(warmupParsed.games.length, 2);
assert.deepEqual(warmupParsed.games.map(game => [game.awayCode, game.homeCode, game.boardTime, game.fullRunline.lineSide, game.fullRunline.line, game.fullTotal.line]), [
  ['UTAH', 'DEN', '07:05', 'home', '5+50', '236.5'],
  ['GS', 'LAC', '07:05', 'away', '3+25', '222.5'],
]);
assert.ok(warmupParsed.games.every(game => !game.firstHalfRunline && !game.firstHalfTotal));
assert.equal(normalizer.normalizeRowRecords(warmupRecords, { expectedLeague: 'MLB' }).diagnostics.gameCount, 0);

// The 10/22 desktop NBA page contains an 11-game standard board followed by
// another 11-game 「主推過關」 board. They share event identities but are
// different contracts. Synthetic prices make any cross-section leak visible.
// The alternate section must not enter the standard
// board's count, prices, half markets or duplicate-conflict checks.
const desktopSlate = [
  ['ATL 老鷹', 'ORL 魔術[主]'], ['MIL 公鹿', 'WAS 巫師[主]'],
  ['CHA 黃蜂', 'BKN 籃網[主]'], ['MIN 灰狼', 'MIA 熱火[主]'],
  ['CHI 公牛', 'TOR 暴龍[主]'], ['UTA 爵士', 'MEM 灰熊[主]'],
  ['IND 溜馬', 'NO 鵜鶘[主]'], ['DAL 獨行俠', 'HOU 火箭[主]'],
  ['GSW 勇士', 'LAL 湖人[主]'], ['PHO 太陽', 'POR 拓荒者[主]'],
  ['SAC 國王', 'LAC 快艇[主]'],
];
function desktopSection(label, { alternative = false, missingHalf = false } = {}) {
  return [normalizerHeaders, [label], ...desktopSlate.flatMap(([away, home], index) => [
    ['10-22', away, '0.950', `${234 + index + (alternative ? 10 : 0)}平 大 0.940`, '', '', missingHalf ? '' : '0.940', missingHalf ? '' : `${110 + index}平 大 0.930`],
    ['07:05', home, `${alternative ? '5+50' : '2-50'} 0.950`, '小 0.940', '', '', missingHalf ? '' : '1平 0.940', missingHalf ? '' : '小 0.930'],
  ])];
}
function desktopCapture(sections) {
  const records = sections.flat().map((values, order) => record(order, order * 24, values));
  const normalized = normalizer.normalizeRowRecords(records, { expectedLeague: 'NBA' });
  return { ...capture(), tables: normalized.tables, diagnostics: { ...normalized.diagnostics, lastMutationAt: now.toISOString() } };
}
const standardDesktop = desktopSection('聯盟：NBA 美國職業籃球(11)');
const standardDesktopParsed = parseTai888Capture(desktopCapture([standardDesktop]), now);
for (const label of ['聯盟：NBA 美國職業籃球-主推過關(11)', '联盟：NBA 美国职业篮球－主推过关（11）']) {
  const alternateDesktop = desktopSection(label, { alternative: true });
  assert.equal(registry.identify(label), 'NBA', 'keep the NBA section diagnostic identity');
  for (const sections of [[standardDesktop, alternateDesktop], [alternateDesktop, standardDesktop]]) {
    const mixed = desktopCapture(sections);
    const parsed = parseTai888Capture(mixed, now);
    assert.equal(mixed.diagnostics.sectionCount, 1, 'only the standard NBA section is admitted');
    assert.equal(mixed.diagnostics.expectedGameCount, 11);
    assert.equal(mixed.diagnostics.gameCount, 11);
    assert.deepEqual(parsed.games, standardDesktopParsed.games, 'all four standard markets survive either section order');
    assert.deepEqual(parsed.parseIssues, []);
    assert.equal(selectAuthoritativeBoard([candidate(mixed)], { league: 'NBA', now: +now }).ok, true);
  }
  const alternateOnly = desktopCapture([alternateDesktop]);
  assert.equal(alternateOnly.tables.length, 0, 'an alternate-only page cannot supply standard quotes');
  assert.equal(parseTai888Capture(alternateOnly, now).games.length, 0);
  const partial = desktopCapture([desktopSection('聯盟：NBA 美國職業籃球(11)', { missingHalf: true }), alternateDesktop]);
  assert.ok(parseTai888Capture(partial, now).games.every(game => !game.firstHalfRunline && !game.firstHalfTotal), 'never fill missing standard halves from the parlay section');
}
const realDesktopConflict = desktopCapture([standardDesktop, desktopSection('聯盟：NBA 美國職業籃球(11)', { alternative: true })]);
assert.equal(selectAuthoritativeBoard([candidate(realDesktopConflict)], { league: 'NBA', now: +now }).error, 'conflicting-duplicate-rows', 'conflicting standard quotes still stop upload');

// Actual v2.1.40 diagnostic retained 66 rows: 22 standard rows (including
// empty display clones), then 22 last-score and 22 first-score rows. Rebuild
// scoped records from only the sanitized quote cells; never store tab/account IDs.
const specialFixture = JSON.parse(fs.readFileSync(new URL('../fixtures/reader-nba-special-sections-v2141.json', import.meta.url), 'utf8'));
function diagnosticCapture(sections) {
  let order = 0;
  const records = sections.flatMap(section => {
    const output = [record(order++, order * 24, normalizerHeaders), record(order++, order * 24, [section.label])];
    for (const pairs of section.rows) {
      const top = order * 24;
      const cells = pairs.map((pair, index) => ({ text: pair.filter(Boolean).join(' '), lines: pair,
        rows: pair.map((text, line) => ({ text, top: top + line * 8, left: spans[index][0] })), left: spans[index][0], right: spans[index][1] }));
      output.push({ order: order++, top, bottom: top + 20, text: cells.map(c => c.text).join(' '), cells });
    }
    return output;
  });
  const normalized = normalizer.normalizeRowRecords(records, { expectedLeague: 'NBA' });
  return { ...capture(), tables: normalized.tables, diagnostics: { ...normalized.diagnostics, lastMutationAt: now.toISOString() } };
}
const standardDiagnostic = diagnosticCapture(specialFixture.sections.slice(0, 1));
const expectedDiagnostic = parseTai888Capture(standardDiagnostic, now);
assert.equal(expectedDiagnostic.games.length, 11);
assert.ok(expectedDiagnostic.games.every(g => readerMarketProperties('NBA').every(key => g[key])), 'all 44 standard markets exist in the diagnostic');
for (const sections of [specialFixture.sections, [...specialFixture.sections].reverse()]) {
  const input = diagnosticCapture(sections), parsed = parseTai888Capture(input, now);
  assert.equal(input.diagnostics.sectionCount, 1, 'first/last score sections must be excluded before row aggregation');
  assert.equal(input.diagnostics.gameCount, standardDiagnostic.diagnostics.gameCount, 'only standard rows and their empty display clones remain');
  assert.equal(input.diagnostics.expectedGameCount, 11);
  assert.deepEqual(parsed.games, expectedDiagnostic.games, 'preserve every original standard quote and water');
  assert.deepEqual(parsed.parseIssues, []);
  const selection = selectAuthoritativeBoard([candidate(input)], { league: 'NBA', now: +now });
  assert.equal(selection.ok, true);
  assert.equal(selection.selected.detectedGameCount, 11, 'upload count uses deduplicated parsed event identities');
  const payload = { ...parsed, readerVersion: '2.1.42', deviceId: 'nba-diagnostic-fixture', pageActivityAt: now.toISOString(), expectedGameCount: 11, detectedGameCount: 11 };
  payload.payloadHash = createHash('sha256').update(canonicalReaderPayload(payload)).digest('hex');
  const received = normalizeNbaReaderPayload(payload, { deviceId: payload.deviceId, headerVersion: payload.readerVersion, now: +now });
  assert.equal(received.gameCount, 11);
  assert.equal(received.marketCount, 44, 'all original standard markets pass independent server intake');
}
assert.equal(diagnosticCapture(specialFixture.sections.slice(1)).tables.length, 0);
for (const suffix of ['全場搶首分', '全場搶尾分', '全场抢首分', '全场抢尾分', '搶先得分', '抢先得分', '搶分', '抢分']) {
  assert.equal(registry.standardMarker(`聯盟：NBA 美國職業籃球-${suffix}(11)`, 'NBA'), false);
}

for (const heading of ['聯盟：NBA 美國職業籃球－熱身賽（2）', '聯盟：NBA 美國職業籃球-热身赛(2)', '聯盟：NBA 美國職業籃球 - 季前賽 (2)']) assert.equal(registry.standardMarker(heading, 'NBA'), true);
for (const suffix of ['-熱身賽 第一節(2)', '-熱身賽 主隊總得分(2)', '-熱身賽 LIVE(2)', '-熱身賽 新合約(2)']) assert.equal(registry.standardMarker(`聯盟：NBA 美國職業籃球${suffix}`, 'NBA'), false);
for (const [away, home, awayCode, homeCode] of [
  ['波士頓塞爾提克', '洛杉磯湖人', 'BOS', 'LAL'],
  ['金州勇士', '明尼蘇達灰狼', 'GS', 'MIN'],
  ['纽约尼克斯', '华盛顿奇才', 'NY', 'WSH'],
]) {
  const records = [record(0, 0, normalizerHeaders), record(1, 30, ['聯盟：NBA 美國職業籃球 季前賽（1）']), record(2, 60, ['10-05', away, '5+90 0.970', '220+50 大 0.980', '', '', '', '']), record(3, 82, ['08:00', `${home}[主]`, '0.930', '小 0.920', '', '', '', ''])];
  const normalized = normalizer.normalizeRowRecords(records, { expectedLeague: 'NBA' });
  assert.equal(normalized.diagnostics.gameCount, 1, `${away}@${home} name-only fixture must capture`);
  const parsed = parseTai888Capture({ ...capture(), tables: normalized.tables }, now);
  assert.deepEqual([parsed.games[0].awayCode, parsed.games[0].homeCode], [awayCode, homeCode]);
  assert.equal(parsed.games[0].fullRunline.line, '5+90');
  assert.equal(normalizer.normalizeRowRecords(records, { expectedLeague: 'MLB' }).diagnostics.gameCount, 0);
  const moneylineDuplicate = [...records, record(4, 105, ['10-05', away, '5+90 0.970', '220+50 大 0.980', '1.100', '', '', '']), record(5, 127, ['08:00', `${home}[主]`, '0.930', '小 0.920', '1.200', '', '', ''])];
  const duplicateNormalized = normalizer.normalizeRowRecords(moneylineDuplicate, { expectedLeague: 'NBA' });
  assert.equal(duplicateNormalized.diagnostics.gameCount, 1);
  assert.equal(duplicateNormalized.diagnostics.conflictingGameKeys.length, 0, 'unsupported moneyline fields cannot create a spread/total conflict');
  const specialRecords = [records[0], record(1, 30, ['聯盟：NBA 美國職業籃球 第一節（1）']), ...records.slice(2)];
  assert.equal(normalizer.normalizeRowRecords(specialRecords, { expectedLeague: 'NBA' }).diagnostics.gameCount, 0);
  records[0] = record(0, 0, normalizerHeaders.map(value => value.replace('上半', '前五')));
  const wrongPeriod = normalizer.normalizeRowRecords(records, { expectedLeague: 'NBA' });
  assert.equal(wrongPeriod.diagnostics.wrongPeriodHeader, true, 'normalization must preserve wrong-period diagnostics');
  const wrongParsed = parseTai888Capture({ ...capture(), tables: wrongPeriod.tables, diagnostics: wrongPeriod.diagnostics }, now);
  assert.equal(wrongParsed.games[0].firstHalfRunline, null);
  assert.ok(wrongParsed.parseIssues.includes('wrong-period-header:NBA:first-five'));
}

// Freeze the pre-existing baseball hash shape: no NBA-only property may enter it.
const baseball = { version: 'TAI888-READER-DOM-v2.1.0', league: 'MLB', sourceHost: 'www.tai888.in', boardDate: '2026-10-05', games: [{ awayCode: 'BOS', homeCode: 'MIN', boardDate: '2026-10-05', boardTime: '08:00', marketStatus: 'open', fullRunline: { lineSide: 'away', line: '1+50', awayWater: 0.97, homeWater: 0.93 }, fullTotal: { line: '8平', overWater: 0.98, underWater: 0.92 }, first5Runline: null, first5Total: null }] };
const originalWire = JSON.stringify(baseball);
assert.equal(canonicalReaderPayload(baseball), originalWire);
assert.equal(createHash('sha256').update(canonicalReaderPayload(baseball)).digest('hex'), createHash('sha256').update(originalWire).digest('hex'));
assert.deepEqual(readerMarketProperties('NBA'), ['fullRunline', 'fullTotal', 'firstHalfRunline', 'firstHalfTotal']);
const background = fs.readFileSync(new URL('../reader/background.js', import.meta.url), 'utf8');
assert.match(background, /league === 'NHL' \? '\/api\/nhl\/reader' : league === 'NBA' \? '\/api\/nba\/reader' : '\/api\/reader\/ingest'/);
assert.match(background, /const VERSION = '2\.1\.42'/);
// Execute v2.1.26 recovery behaviors against a stale and then current tab.
let contentVersion = '2.1.26';
const reloaded = [];
const event = { addListener() {} };
const fakeChrome = {
  runtime: { onInstalled: event, onStartup: event, onMessage: event },
  alarms: { onAlarm: event },
  tabs: { onUpdated: event, query: async () => [{ id: 7 }], reload: async id => reloaded.push(id), sendMessage: async () => ({ ok: true, capture: { readerVersion: contentVersion, captures: [capture()] } }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
};
const backgroundContext = { chrome: fakeChrome, parseTai888Capture, canonicalReaderPayload, readerMarketProperties, selectAuthoritativeBoard, Date, setTimeout, clearTimeout, queueMicrotask };
vm.createContext(backgroundContext);
vm.runInContext(background.replace(/^import .*?;\n/gm, ''), backgroundContext);
let scanned = await vm.runInContext('collectCandidates([{ id: 7 }])', backgroundContext);
assert.equal(scanned.candidates.length, 0, 'stale content scripts cannot masquerade as the new installed Reader');
assert.deepEqual([...scanned.silentTabIds], [7]);
contentVersion = '2.1.42';
scanned = await vm.runInContext('collectCandidates([{ id: 7 }])', backgroundContext);
assert.equal(scanned.candidates.length, 1);
const report = await vm.runInContext('readerDiagnostics()', backgroundContext);
assert.equal(report.report.readerVersion, '2.1.42');
assert.equal(report.report.boards[0].league, 'NBA');
assert.equal(Object.hasOwn(report.report, 'readerToken'), false);
assert.equal(Object.hasOwn(report.report.boards[0], 'pageUrl'), false);

const content = fs.readFileSync(new URL('../reader/tai888-content.js', import.meta.url), 'utf8');
const notifyCode = content.slice(content.indexOf('  function notifyBackground'), content.indexOf('  // This timestamp'));
const invalidated = { chrome: { runtime: { id: 'reader', sendMessage() { throw new Error('Extension context invalidated'); } } }, Promise };
vm.createContext(invalidated);
vm.runInContext(notifyCode, invalidated);
assert.doesNotThrow(() => vm.runInContext("notifyBackground({ type: 'TAI888_FRAME_READY' })", invalidated));
invalidated.chrome.runtime.sendMessage = async () => { throw new Error('Disconnected'); };
vm.runInContext("notifyBackground({ type: 'TAI888_FRAME_READY' })", invalidated);
await Promise.resolve();
await Promise.resolve();
process.stdout.write('NBA Reader: standard/parlay section isolation, scoped preseason markers, name-only rows, explicit basketball halves, high lines, partial boards, conflict checks and baseball hash isolation PASS\n');
