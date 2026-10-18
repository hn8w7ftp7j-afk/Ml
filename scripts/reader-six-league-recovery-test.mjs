import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload } from '../reader/parser.js';
import { selectAuthoritativeBoard, readerPayloadsByDate, shouldSkipSuccessfulPayload } from '../reader/board-selector.js';
import { validateNhlCapture } from '../lib/nhl/reader.js';

// Synthetic transport regression, not a claim of live six-league capture.
const version = JSON.parse(fs.readFileSync('reader/manifest.json')).version;
const context = { globalThis: {} }; vm.createContext(context);
for (const name of ['league-registry.js', 'nhl-teams.js', 'row-normalizer.js']) vm.runInContext(fs.readFileSync(`reader/${name}`, 'utf8'), context);
const registry = context.globalThis.Tai888LeagueRegistry;
const normalizer = context.globalThis.Tai888RowNormalizer;
const definitions = [
  ['MLB', '聯盟：MLB美國職棒(1)', 'NYY-洋基', 'BOS-紅襪[主]'],
  ['NPB', '聯盟：NPB日本職棒(1)', 'SOF-軟銀鷹', 'NIP-日本火腿[主]'],
  ['KBO', '聯盟：KBO韓國職棒(1)', 'LOG-樂天巨人', 'DOO-斗山熊[主]'],
  ['CPBL', '聯盟：CPBL中華職棒(1)', 'CTB-中信兄弟', 'UNI-統一獅[主]'],
  ['NBA', '聯盟：NBA美國職業籃球-熱身賽(1)', 'NY-尼克', 'TOR-暴龍[主]'],
  ['NHL', '聯盟：NHL美式冰球--包括加時與點球(1)', 'WSH-華盛頓首都', 'WPG-溫尼伯噴射機[主]'],
];
assert.equal(registry.identify('聯盟：NBAX美國職業籃球(1)'), null);
const now = new Date();
const tomorrow = new Date(+now + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const monthDay = tomorrow.slice(5);
const record = (order, values) => ({ order, top: order * 25, bottom: order * 25 + 20, text: values.join(' '), cells: values.map((text, i) => ({ text, left: i * 100, right: (i + 1) * 100, rows: text ? [{ text, top: order * 25, left: i * 100 }] : [] })) });
const captures = definitions.map(([league, heading, away, home]) => {
  assert.equal(registry.standardMarker(heading, league), true, heading);
  const normalized = normalizer.normalizeRowRecords([
    record(0, ['時間', '主客隊伍', '讓球', '大小盤']), record(1, [heading]),
    record(2, [monthDay, away, '1+50 0.950', `${league === 'NBA' ? '225.5' : '6.5'} 大 0.940`]),
    record(3, ['19:00', home, '0.950', '小 0.940']),
  ], { expectedLeague: league });
  assert.equal(normalized.diagnostics.gameCount, 1, league);
  return { league, sourceHost: 'tai888.in', pageUrl: 'https://tai888.in/newapp/', observedAt: now.toISOString(), pageLeagueLabel: heading,
    tables: normalized.tables, diagnostics: { ...normalized.diagnostics, lastMutationAt: now.toISOString() } };
});
const event = { addListener() {} }, uploaded = [];
const state = { deviceId: 'synthetic-device', readerToken: 'synthetic-token' };
let mode = 'all';
const chrome = {
  runtime: { onInstalled: event, onStartup: event, onMessage: event }, alarms: { onAlarm: event },
  tabs: { onUpdated: event, query: async () => [{ id: 1, active: true }], sendMessage: async () => ({ ok: true, capture: { readerVersion: version,
    captures: mode === 'all' ? captures : mode === 'empty' ? [{ ...captures[0], tables: [] }] : [],
    sectionDiagnostics: mode === 'rejected' ? [{ league: 'MLB', label: '聯盟：MLB美國職棒-特殊(1)', accepted: false }] : [],
  } }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
  storage: { local: { get: async () => state, set: async values => Object.assign(state, values), remove: async () => {} } },
};
const worker = { chrome, Date, URL, setTimeout, clearTimeout, queueMicrotask, TextEncoder, AbortController, crypto: webcrypto,
  parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload, selectAuthoritativeBoard, readerPayloadsByDate, shouldSkipSuccessfulPayload,
  fetch: async (url, options) => {
    const input = JSON.parse(options.body); uploaded.push(input.league);
    assert.equal(options.headers['X-Reader-Version'], version);
    assert.equal(input.games.length, 1);
    if (input.league === 'NHL') assert.equal(validateNhlCapture(input, { headerVersion: version }).ok, true);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, rawGameCount: 1, matchedGameCount: 1, marketCount: 2 }) };
  },
};
vm.createContext(worker);
vm.runInContext(fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, ''), worker);
assert.equal((await vm.runInContext("performSync('manual')", worker)).ok, true);
assert.deepEqual(uploaded.sort(), definitions.map(row => row[0]).sort());
for (const [league] of definitions) assert.equal(state.readerStatuses[league].state, 'synced', league);
mode = 'empty'; await vm.runInContext("performSync('manual')", worker);
assert.equal(state.readerStatuses.MLB.state, 'error');
assert.match(state.readerStatuses.MLB.message, /無法組成賽事列/);
const emptyReport = await vm.runInContext('readerDiagnostics()', worker);
assert.equal(emptyReport.report.emptyCaptures[0].league, 'MLB');
mode = 'rejected'; await vm.runInContext("performSync('manual')", worker);
assert.match(state.readerStatuses.MLB.message, /區段未通過辨識/);
const rejectedReport = await vm.runInContext('readerDiagnostics()', worker);
assert.equal(rejectedReport.report.sections[0].accepted, false);
assert.equal(JSON.stringify(rejectedReport).includes('synthetic-token'), false);
assert.equal(JSON.stringify(rejectedReport).includes('synthetic-device'), false);
console.log('Six-league synthetic DOM → worker upload PASS; rejected/empty sections remain diagnostic errors, no unproven no-odds claim or token leak; live PC NOT VERIFIED');
