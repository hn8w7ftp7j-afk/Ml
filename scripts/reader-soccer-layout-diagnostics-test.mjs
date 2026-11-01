import { readFileSync as readNbaRecoverySource } from 'node:fs';
import { installArchiveWorkerFixture } from './reader-archive-receipt-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as parser from '../reader/parser.js';
import * as selector from '../reader/board-selector.js';
import '../reader/league-registry.js';
import '../reader/soccer-teams.js';

const version = JSON.parse(fs.readFileSync('reader/manifest.json', 'utf8')).version;
const privateValue = 'PRIVATE_DIAGNOSTIC_VALUE_DO_NOT_EXPORT';
const pollution = JSON.parse(`{"__proto__":{"polluted":"${privateValue}"},"constructor":"${privateValue}","password":"${privateValue}","url":"https://private.invalid/${privateValue}"}`);
const sample = { ...pollution, tag: 'DIV', top: 20.126, left: 0, right: 1000, cells: [
  { ...pollution, left: 0, right: 70, lines: ['時間', '10-20', '03:00', privateValue] },
  { ...pollution, left: 70, right: 250, lines: ['主客隊伍', '熱刺[主]', '高雲地利', `password ${privateValue}`] },
  { left: 250, right: 400, lines: ['讓球', '1-50 1.070', '0.810'] },
  { left: 400, right: 550, lines: ['大小盤', '3平 大 0.920', '小 0.940'] },
  { left: 550, right: 700, lines: ['unrelated arbitrary body text', 'https://private.invalid/', `Bearer ${privateValue}`, '0123456789abcdef0123456789abcdef'] },
  { left: Infinity, right: 800, lines: ['1.070'] },
] };
const layout = { ...pollution, league: 'EPL', label: '聯盟: 英格蘭超級聯賽(5)',
  modules: { ...pollution, registry: true, table: false, card: 'yes' },
  counts: { ...pollution, records: 81, headers: 2, markers: 2, physicalGroups: -1, geometryGroups: '4' },
  paths: {
    ...pollution,
    physical: { ...pollution, tableCount: 0, sawLeagueMarker: false, issues: ['SOCCER_TABLE_IDENTITY_INVALID', 'SOCCER_TABLE_IDENTITY_INVALID', privateValue, 'SOCCER_UNKNOWN_SECRET'] },
    geometry: { tableCount: 1, sawLeagueMarker: true, issues: [] },
    cards: { tableCount: 1001, sawLeagueMarker: true, issues: ['SOCCER_CARD_QUOTES_AMBIGUOUS'] },
    arbitrary: { password: privateValue },
  }, samples: [sample, { ...sample, tag: 'INPUT' }, { ...sample, top: NaN }],
};
const requests = [], writes = [], event = { addListener() {} };
const chrome = {
  runtime: { onInstalled: event, onStartup: event, onMessage: event, getManifest: () => ({ version }) },
  alarms: { onAlarm: event }, tabs: { onUpdated: event, query: async () => [{ id: 91, active: true }], sendMessage: async () => ({ ok: true, capture: { readerVersion: version, captures: [], sectionDiagnostics: [], soccerLayouts: [layout, { ...layout, league: 'NFL' }, { ...layout, league: 'UCL', label: '聯盟：歐洲冠軍聯賽' }] } }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 2 }] },
  storage: { local: { get: async () => ({}), set: async value => writes.push(value), remove: async value => writes.push(value) } },
};
const context = vm.createContext({ chrome, ...parser, ...selector, Date, URL, setTimeout, clearTimeout, TextEncoder, AbortController,
  Tai888LeagueRegistry: globalThis.Tai888LeagueRegistry, Tai888SoccerTeams: globalThis.Tai888SoccerTeams,
  fetch: async (...args) => { requests.push(args); throw new Error('layout diagnostics must not upload'); } });
installArchiveWorkerFixture(context);
vm.runInContext(fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, line => line.includes('./nba-conflict-recovery.js') ? readNbaRecoverySource('reader/nba-conflict-recovery.js', 'utf8').replace(/^export /gm, '') + '\n' : ''), context);
const plain = value => JSON.parse(JSON.stringify(value));
context.rawIssueCapture = { league: 'UCL', diagnostics: { tableIssues: [
  'SOCCER_TABLE_QUOTES_AMBIGUOUS', privateValue, 'SOCCER_TABLE_QUOTES_AMBIGUOUS',
] } };
assert.deepEqual(plain(vm.runInContext('sanitizeCapture(rawIssueCapture)', context)).diagnostics.tableIssues,
  ['SOCCER_TABLE_QUOTES_AMBIGUOUS'], 'worker preserves only allowlisted table failure reasons');
const scan = plain(await vm.runInContext('collectCandidates([{id:91,active:true}])', context));
assert.deepEqual(scan.silentTabIds, []);
assert.equal(scan.soccerLayouts.length, 1, 'only EPL/UCL layouts from the first two entries are considered');
const clean = scan.soccerLayouts[0];
assert.deepEqual(Object.keys(clean), ['tabId', 'frameId', 'league', 'label', 'modules', 'counts', 'paths', 'samples']);
assert.equal(clean.tabId, 91); assert.equal(clean.frameId, 2);
assert.deepEqual(clean.modules, { registry: true, table: false, card: false });
assert.deepEqual(clean.counts, { records: 81, headers: 2, markers: 2, physicalGroups: 0, geometryGroups: 0 });
assert.deepEqual(Object.keys(clean.paths), ['physical', 'geometry', 'cards']);
assert.deepEqual(clean.paths.physical.issues, ['SOCCER_TABLE_IDENTITY_INVALID']);
assert.equal(clean.paths.cards.tableCount, 0);
assert.equal(clean.samples.length, 1); assert.equal(clean.samples[0].top, 20.13);
assert.equal(clean.samples[0].cells.length, 4);
assert.deepEqual(clean.samples[0].cells[0].lines, ['時間', '10-20', '03:00']);
assert.deepEqual(clean.samples[0].cells[1].lines, ['主客隊伍', '熱刺[主]', '高雲地利']);
assert.ok(!JSON.stringify(scan).includes(privateValue));
assert.ok(!JSON.stringify(scan).includes('unrelated arbitrary body text'));
assert.ok(!JSON.stringify(scan).includes('__proto__')); assert.ok(!JSON.stringify(scan).includes('polluted'));
assert.ok(!JSON.stringify(scan).includes('private.invalid')); assert.equal({}.polluted, undefined);
const result = plain(await vm.runInContext('readerDiagnostics()', context));
assert.equal(result.ok, true); assert.equal(result.report.readerVersion, version);
assert.equal(result.report.extensionManifestVersion, version);
assert.deepEqual(result.report.soccerLayouts, scan.soccerLayouts);
assert.deepEqual(requests, [], 'no diagnostic network uploads');
assert.deepEqual(writes, [], 'no layout persistence to extension storage');
delete chrome.runtime.getManifest;
assert.equal(plain(await vm.runInContext('readerDiagnostics()', context)).report.extensionManifestVersion, null, 'existing mocks without getManifest stay compatible');
chrome.runtime.getManifest = () => { throw new Error('unavailable manifest'); };
assert.equal(plain(await vm.runInContext('readerDiagnostics()', context)).report.extensionManifestVersion, null);
context.layout = { ...layout, samples: Array.from({ length: 10 }, () => ({ ...sample, cells: Array.from({ length: 14 }, () => ({ left: 0, right: 100, lines: ['1.070', '0.810', '1-50', '小 0.940', '0.390'] })) })) };
const bounded = plain(vm.runInContext('sanitizeSoccerLayout(layout)', context));
assert.equal(bounded.samples.length, 8); assert.equal(bounded.samples[0].cells.length, 12); assert.equal(bounded.samples[0].cells[0].lines.length, 4);
for (const label of ['聯盟: 英格蘭超級聯賽 token=abc', '聯盟: 英格蘭超級聯賽 arbitrary', '聯盟: 歐洲冠軍聯賽', 'x'.repeat(101)]) {
  context.layout = { ...layout, label };
  assert.equal(vm.runInContext('sanitizeSoccerLayout(layout)', context), null, 'only the matching bounded league heading may label a layout');
}
context.line = 'arbitrary unmarked user message';
assert.equal(vm.runInContext("soccerDiagnosticLine(line, 'EPL')", context), '');

// Downloaded diagnostics must retain the actual parser inputs. The historical
// report dropped table headers and period evidence, so even a valid NBA board
// replayed as zero games and football FT/HT authority could not be reproduced.
const now = Date.parse('2026-10-24T22:00:00Z'), at = new Date(now).toISOString();
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
context.Date = Clock;
const cell = pair => ({ pair });
const soccer = (league = 'EPL', period = 'FT', water = '0.95') => {
  const label = league === 'EPL' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽';
  const prefix = period === 'FT' ? '全場' : '上半場';
  return { version: 'TAI888-DOM-CAPTURE-v2.2.0', league, pageLeagueLabel: label,
    sourceHost: 'www.tai888.in', observedAt: at,
    tables: [{ sectionTitle: `${label} ${prefix}`, headers: ['時間', '主客隊伍', `${prefix}讓球`, `${prefix}大小`, `${prefix}獨贏`],
      rows: [{ marketLocked: false, cells: [cell(['10-25', '22:00']), cell(['布倫特福德', '侯城[主]']),
        cell([`1平 ${water}`, '0.91']), cell(['大3+50 0.95', '小 0.89']), cell(['主勝 -', '和 -', '客勝 -'])] }] }],
    diagnostics: { expectedGameCount: 1, gameCount: 1, lastMutationAt: at } };
};
const nba = { version: 'TAI888-DOM-CAPTURE-v2.2.0', league: 'NBA', sourceHost: 'www.tai888.in', observedAt: at,
  tables: [{ headers: ['時間', '主客隊伍', '全場讓分', '全場大小', '獨贏', '單雙', '上半場讓分', '上半場大小'],
    rows: [{ marketLocked: false, cells: [cell(['10-25', '08:00']), cell(['WSH-巫師', 'CHA-黃蜂[主]']),
      cell(['2+50 0.950', '0.950']), cell(['224平 大 0.940', '小 0.940']), cell(['', '']), cell(['', '']),
      cell(['1平 0.940', '0.940']), cell(['112.5 大 0.930', '小 0.930'])] }] }],
  diagnostics: { expectedGameCount: 1, gameCount: 1, lastMutationAt: at } };
const candidate = (capture, tabId) => ({ capture, parsed: parser.parseTai888Capture(capture, new Date(now)),
  tabId, frameId: 0, active: tabId === 1, lastAccessed: tabId });
const diagnosticReport = async candidates => {
  context.testScan = { candidates, silentTabIds: [], sections: [], emptyCaptures: [], soccerLayouts: [] };
  vm.runInContext('collectCandidates = async () => testScan', context);
  return plain((await vm.runInContext('readerDiagnostics()', context)).report);
};
const sources = [candidate(nba, 1), candidate(soccer(), 2), candidate(soccer(), 3),
  candidate(soccer('EPL', 'HT'), 4), candidate(soccer('UCL'), 5)];
const original = JSON.stringify(sources);
const replayReport = await diagnosticReport(sources);
for (const [index, board] of replayReport.boards.entries()) {
  assert.equal(board.replayComplete, true, 'valid normalized sport inputs stay replayable');
  assert.deepEqual(board.tables, sources[index].capture.tables, 'preserve exact headers, section and indexed sport pairs');
  const replay = parser.parseTai888Capture({ ...board, version: board.captureVersion }, new Date(replayReport.createdAt));
  assert.deepEqual(replay.games, sources[index].parsed.games, 'actual parser reconstructs unchanged NBA/football contracts and periods');
}
assert.equal(replayReport.boards[0].tables[0].headers[6], '上半場讓分');
assert.equal(replayReport.authority.NBA.ok, true);
assert.equal(replayReport.authority.EPL.ok, true, 'identical tabs and separate periods are not reported as a source conflict');
assert.deepEqual(replayReport.authority.EPL.scopes.map(row => row.period), ['FT', 'HT']);
assert.equal(replayReport.authority.UCL.ok, true);
assert.equal(JSON.stringify(sources), original, 'diagnostic construction cannot change source contracts');
assert.deepEqual(requests, []); assert.deepEqual(writes, [], 'downloaded report neither uploads nor saves diagnostic page text');

const conflict = await diagnosticReport([candidate(soccer(), 2), candidate(soccer('EPL', 'FT', '0.96'), 3)]);
assert.ok(conflict.boards.every(board => board.error === ''), 'both isolated pages pass their own checks');
assert.equal(conflict.authority.EPL.ok, false, 'the actual joint selector rejects contradictory source prices');
assert.equal(conflict.authority.EPL.error, 'conflicting-duplicate-tabs');
assert.equal(conflict.authority.EPL.boardDate, '2026-10-25');
assert.equal(conflict.authority.EPL.period, 'FT');
assert.deepEqual([...conflict.authority.EPL.conflictingTabIds].sort(), [2, 3]);

const truncated = soccer(); truncated.tables[0].periodEvidenceTruncated = true;
const unknownPeriod = (await diagnosticReport([candidate(truncated, 2)])).boards[0];
assert.equal(unknownPeriod.tables[0].periodEvidenceTruncated, true);
assert.deepEqual(parser.parseTai888Capture({ ...unknownPeriod, version: unknownPeriod.captureVersion }, new Date(now)).games,
  parser.parseTai888Capture(truncated, new Date(now)).games, 'truncated period evidence must remain UNKNOWN when replayed');
context.periodOnly = '上半場';
assert.equal(vm.runInContext("diagnosticTableText(periodOnly, 'EPL')", context), '上半場', 'standalone period headings remain evidence');

const dirtyCapture = soccer();
dirtyCapture.tables[0].sectionTitle = `英格蘭超級聯賽 token=${privateValue}`;
dirtyCapture.tables[0].headers[0] = privateValue;
dirtyCapture.tables[0].rows[0].cells[0].pair.push(`password=${privateValue}`);
dirtyCapture.tables[0].rawHtml = `<input value="${privateValue}">`;
dirtyCapture.tables[0].rows[0].password = privateValue;
context.dirtyCapture = dirtyCapture;
const dirtyTables = plain(vm.runInContext('diagnosticTables(dirtyCapture)', context));
assert.equal(dirtyTables.replayComplete, false, 'redaction cannot be presented as a complete replay');
assert.equal(dirtyTables.tables[0].headers[0], '', 'header redaction preserves column indexes');
assert.doesNotMatch(JSON.stringify(dirtyTables), new RegExp(`${privateValue}|rawHtml|password|input`));
const oversized = soccer(); oversized.tables[0].headers = Array(13).fill('全場讓球');
oversized.tables[0].rows = Array(101).fill({ cells: Array(13).fill(cell(['1平 0.95', '0.91', '-', '-'])) });
context.oversized = oversized;
const limited = plain(vm.runInContext('diagnosticTables(oversized)', context));
assert.equal(limited.replayComplete, false); assert.equal(limited.tables[0].headers.length, 12);
assert.equal(limited.tables[0].rows.length, 100); assert.equal(limited.tables[0].rows[0].cells.length, 12);
assert.equal(limited.tables[0].rows[0].cells[0].pair.length, 3);
console.log('PASS bounded Reader diagnostics: exact NBA and football parser replay, FT/HT evidence, actual cross-tab selector outcomes, immutable quotes, explicit incomplete/redacted evidence and no secret/raw HTML export or diagnostic uploads.');
