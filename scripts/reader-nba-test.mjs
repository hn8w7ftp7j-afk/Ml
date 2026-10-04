import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { canonicalReaderPayload, parseTai888Capture, readerMarketProperties } from '../reader/parser.js';
import { assessBoardCandidate, selectAuthoritativeBoard } from '../reader/board-selector.js';

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
assert.match(background, /const endpoint = league === 'NBA' \? '\/api\/nba\/reader' : '\/api\/reader\/ingest'/);
assert.match(background, /const VERSION = '2\.1\.27'/);
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
contentVersion = '2.1.27';
scanned = await vm.runInContext('collectCandidates([{ id: 7 }])', backgroundContext);
assert.equal(scanned.candidates.length, 1);
const report = await vm.runInContext('readerDiagnostics()', backgroundContext);
assert.equal(report.report.readerVersion, '2.1.27');
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
process.stdout.write('NBA Reader: scoped preseason markers, name-only rows, explicit basketball halves, high lines, partial boards, conflict checks and baseball hash isolation PASS\n');
