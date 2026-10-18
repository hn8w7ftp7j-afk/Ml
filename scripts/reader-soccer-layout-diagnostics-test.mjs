import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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
const context = vm.createContext({ chrome, Date, URL, setTimeout, clearTimeout, TextEncoder, AbortController,
  Tai888LeagueRegistry: globalThis.Tai888LeagueRegistry, Tai888SoccerTeams: globalThis.Tai888SoccerTeams,
  fetch: async (...args) => { requests.push(args); throw new Error('layout diagnostics must not upload'); } });
vm.runInContext(fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, ''), context);
const plain = value => JSON.parse(JSON.stringify(value));
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
console.log('PASS bounded soccer layout diagnostics: explicit paths/modules/counts, sport-only geometry cells, unknown/prototype/secret filtering, manifest fallback and report-only/no-upload/no-storage behavior.');
