import { readFileSync as readNbaRecoverySource } from 'node:fs';
import { installArchiveWorkerFixture } from './reader-archive-receipt-fixture.mjs';
import assert from 'node:assert/strict';
import { readerSaveReceiptFixture } from './reader-save-receipt-fixture.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseTai888Capture, canonicalReaderPayload } from '../reader/parser.js';
import { assessBoardCandidate, selectAuthoritativeBoard, readerPayloadsByDate } from '../reader/board-selector.js';
import { normalizeNbaReaderPayload } from '../lib/nba/reader.js';
import { storeNbaReaderSnapshot, loadNbaReaderSnapshot } from '../lib/nba/reader-store.js';
process.env.READER_STORE_MEMORY_ONLY = 'true';
const readerVersion = JSON.parse(readFileSync(new URL('../reader/manifest.json', import.meta.url), 'utf8')).version;
const now = new Date('2026-10-09T07:44:00Z');
const cell = pair => ({ pair, lines: pair });
const row = (date, time, teams, spread, total) => ({ cells: [cell([date, time]), cell(teams), cell([`${spread} 0.950`, '0.950']), cell([`${total} 大 0.940`, '小 0.940']), cell(['','']), cell(['',''])] });
const capture = { version: 'TAI888-DOM-CAPTURE-v2.2.0', league: 'NBA', sourceHost: 'tai888.in', pageUrl: 'https://tai888.in/newapp/#/BK', observedAt: now.toISOString(),
  tables: [{ headers: ['時間','主客隊伍','全場讓分','全場大小','上半場讓分','上半場大小'], rows: [row('10-09','20:05',['HOU-火箭','DAL-獨行俠[主]'],'2平','225+50'),row('10-10','08:05',['MEM-灰熊','CHI-公牛[主]'],'3平','239+50')] }],
  diagnostics: { gameCount: 2, expectedGameCount: 2, lastMutationAt: now.toISOString() } };
const parsed = parseTai888Capture(capture, now);
const candidate = { capture, parsed, tabId: 1, frameId: 0, active: true };
assert.equal(assessBoardCandidate(candidate, +now).ok, true);
assert.equal(selectAuthoritativeBoard([candidate], { now: +now, league: 'NBA' }).ok, true);
const payload = { ...parsed, readerVersion, deviceId: 'device-multi-date-test', pageActivityAt: now.toISOString(), expectedGameCount: 2, detectedGameCount: 2 };
const daily = readerPayloadsByDate(payload);
assert.deepEqual(daily.map(p => p.boardDate), ['2026-10-09', '2026-10-10']);
assert.deepEqual(daily.flatMap(p => p.games), parsed.games);
for (const p of daily) {
  assert.equal(p.expectedGameCount, 1); assert.equal(p.detectedGameCount, 1);
  p.payloadHash = createHash('sha256').update(canonicalReaderPayload(p)).digest('hex');
  const snapshot = normalizeNbaReaderPayload(p, { deviceId: p.deviceId, headerVersion: p.readerVersion, now: +now });
  await storeNbaReaderSnapshot(snapshot);
  const stored = await loadNbaReaderSnapshot(p.boardDate);
  assert.equal(stored.boardDate, p.boardDate);
  assert.deepEqual(stored.games.map(g => g.fullTotal.line), p.games.map(g => g.fullTotal.line));
}
assert.equal((await loadNbaReaderSnapshot('2026-10-09')).games[0].fullTotal.line, '225+50');
assert.equal((await loadNbaReaderSnapshot('2026-10-10')).games[0].fullTotal.line, '239+50');
const single = { ...payload, games: [payload.games[0]], expectedGameCount: 1, detectedGameCount: 1 };
assert.deepEqual(readerPayloadsByDate(single), [single]);
const baseball = { ...single, league: 'MLB' };
assert.equal(readerPayloadsByDate(baseball)[0], baseball);
assert.equal(assessBoardCandidate({ ...candidate, parsed: { ...parsed, league: 'MLB' } }, +now).ok, false);
const conflicting = structuredClone(candidate); conflicting.parsed.games[1].fullTotal.line = '240平';
assert.equal(selectAuthoritativeBoard([candidate, { ...conflicting, frameId: 1 }], { now: +now, league: 'NBA' }).ok, false);
// Different dated tabs can expose different prices without contradicting each
// other. Select an intact source for each stored date, never relabel a slate.
function datedCandidate(index, tabId) {
  const ownCapture = structuredClone(capture);
  ownCapture.tables[0].rows = [ownCapture.tables[0].rows[index]];
  ownCapture.diagnostics.gameCount = ownCapture.diagnostics.expectedGameCount = 1;
  return { ...candidate, tabId, capture: ownCapture, parsed: parseTai888Capture(ownCapture, now) };
}
const todayTab = datedCandidate(0, 11), tomorrowTab = datedCandidate(1, 12);
for (const tabs of [[todayTab, tomorrowTab], [tomorrowTab, todayTab], [todayTab, candidate], [candidate, tomorrowTab]]) {
  const selected = selectAuthoritativeBoard(tabs, { now: +now, league: 'NBA' });
  assert.equal(selected.ok, true, 'disjoint dates and identical shared dated boards are not quote conflicts');
  assert.deepEqual(selected.selections.map(item => item.boardDate), ['2026-10-09', '2026-10-10']);
  const selectedGames = selected.selections.flatMap(item => item.selected.candidate.parsed.games);
  assert.deepEqual(selectedGames, parsed.games, 'preserve exact quotes, lock state, and raw evidence for both dates');
}
const sameDayCapture = structuredClone(capture);
sameDayCapture.tables[0].rows[1].cells[0] = cell(['10-09', '21:05']);
const sameDay = { ...candidate, tabId: 21, capture: sameDayCapture, parsed: parseTai888Capture(sameDayCapture, now) };
const sameDaySubset = { ...todayTab, active: true, tabId: 22 };
for (const tabs of [[sameDay, sameDaySubset], [sameDaySubset, sameDay]]) {
  const selected = selectAuthoritativeBoard(tabs, { now: +now, league: 'NBA', preferredTabId: sameDaySubset.tabId });
  assert.equal(selected.ok, true, 'a non-conflicting subset cannot block a complete intact source');
  assert.equal(selected.authorityTabId, sameDay.tabId, 'coverage must take precedence over focus');
  assert.deepEqual(selected.selected.candidate.parsed.games, sameDay.parsed.games);
}
const partialMarkets = structuredClone(sameDay);
partialMarkets.tabId = 23;
partialMarkets.parsed.games.forEach(game => { game.fullRunline = null; });
assert.equal(selectAuthoritativeBoard([partialMarkets, sameDay], { now: +now, league: 'NBA' }).authorityTabId, sameDay.tabId,
  'a complete source also covers non-conflicting partial markets');
const sameDayDisjoint = structuredClone(sameDay);
sameDayDisjoint.tabId = 24;
sameDayDisjoint.parsed.games = [sameDayDisjoint.parsed.games[1]];
const uncovered = selectAuthoritativeBoard([sameDaySubset, sameDayDisjoint], { now: +now, league: 'NBA' });
assert.equal(uncovered.ok, false, 'no intact source covers disjoint same-date fragments; never union quotes');
assert.equal(uncovered.error, 'no-complete-tab', 'missing full coverage is not mislabeled as contradictory prices');
const changedSubset = structuredClone(sameDaySubset);
changedSubset.parsed.games[0].fullTotal.overWater = 0.99;
for (const tabs of [[sameDay, changedSubset], [changedSubset, sameDay]]) {
  const selected = selectAuthoritativeBoard(tabs, { now: +now, league: 'NBA', preferredTabId: sameDay.tabId });
  assert.equal(selected.ok, false, 'a newer/larger/active board never overrides a genuinely changed quote');
  assert.equal(selected.error, 'conflicting-duplicate-tabs');
}
const lockedSubset = structuredClone(sameDaySubset);
lockedSubset.parsed.games[0].marketStatus = 'locked';
for (const key of ['fullRunline', 'fullTotal']) delete lockedSubset.parsed.games[0][key];
assert.equal(selectAuthoritativeBoard([lockedSubset, sameDay], { now: +now, league: 'NBA' }).ok, false,
  'open versus explicitly locked evidence remains a conflict');
const changedTomorrow = structuredClone(tomorrowTab);
changedTomorrow.parsed.games[0].fullTotal.line = '240平';
for (const tabs of [[todayTab, candidate, changedTomorrow], [changedTomorrow, candidate, todayTab]]) {
  const selected = selectAuthoritativeBoard(tabs, { now: +now, league: 'NBA' });
  assert.equal(selected.ok, false, 'one real same-date conflict stops the entire league');
  assert.equal(selected.error, 'conflicting-duplicate-tabs');
  assert.deepEqual(selected.selections, []);
}
const internallyConflicting = structuredClone(candidate);
internallyConflicting.parsed.parseIssues = ['conflicting-duplicate:tomorrow'];
assert.equal(selectAuthoritativeBoard([todayTab, internallyConflicting], { now: +now, league: 'NBA' }).ok, false,
  'validate all original rows before projecting dates');
const invalid = structuredClone(candidate); invalid.parsed.games[1].boardDate = 'bad-date';
assert.equal(assessBoardCandidate(invalid, +now).ok, false);
console.log('NBA multi-date capture → authority → date payload/hash → backend normalization → isolated storage PASS');
// Execute the actual service-worker flow, including two HTTP uploads and a
// partial failure retry. Never count one accepted day as a complete league.
const { default: fs } = await import('node:fs');
const { default: vm } = await import('node:vm');
const { webcrypto } = await import('node:crypto');
const { readerMarketProperties } = await import('../reader/parser.js');
const { shouldSkipSuccessfulPayload } = await import('../reader/board-selector.js');
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [+now])); } static now() { return +now; } }
const event = { addListener() {} };
const state = { readerToken: 'synthetic-token', deviceId: payload.deviceId, autoEnabled: true };
const uploads = []; let failTomorrow = true; let syncCaptures = [capture];
const fakeChrome = {
  runtime: { onInstalled: event, onStartup: event, onMessage: event }, alarms: { onAlarm: event },
  storage: { local: { get: async () => structuredClone(state), set: async value => Object.assign(state, value), remove: async key => { delete state[key]; } } },
  tabs: { onUpdated: event, query: async () => [{ id: 7, active: true }], sendMessage: async () => ({ ok: true, capture: { readerVersion, captures: syncCaptures } }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
};
const ctx = { chrome: fakeChrome, parseTai888Capture, canonicalReaderPayload, readerMarketProperties, selectAuthoritativeBoard, shouldSkipSuccessfulPayload, readerPayloadsByDate,
  Date: Clock, crypto: webcrypto, TextEncoder, AbortController, URL, setTimeout, clearTimeout, queueMicrotask,
  fetch: async (url, options) => {
    const body = JSON.parse(options.body); uploads.push(body.boardDate);
    assert.equal(url, 'https://mlb-positive-ev.vercel.app/api/nba/reader');
    const normalized = normalizeNbaReaderPayload(body, { deviceId: state.deviceId, headerVersion: readerVersion, now: +now });
    if (body.boardDate === '2026-10-10' && failTomorrow) return { status: 503, ok: false, text: async () => JSON.stringify({ ok: false, error: 'synthetic temporary failure' }) };
    return { status: 200, ok: true, text: async () => JSON.stringify(readerSaveReceiptFixture(body, { rawGameCount: normalized.gameCount, marketCount: normalized.marketCount })) };
  } };
vm.createContext(ctx);
installArchiveWorkerFixture(ctx);
vm.runInContext(fs.readFileSync(new URL('../reader/background.js', import.meta.url), 'utf8').replace(/^import .*?;\n/gm, line => line.includes('./nba-conflict-recovery.js') ? readNbaRecoverySource('reader/nba-conflict-recovery.js', 'utf8').replace(/^export /gm, '') + '\n' : ''), ctx);
await vm.runInContext("performSync('manual')", ctx);
assert.deepEqual(uploads, ['2026-10-09','2026-10-10']);
assert.equal(state.readerStatuses.NBA.ok, false);
assert.equal(state.readerStatuses.NBA.dateStatuses.length, 1);
assert.equal(state.readerStatuses.NBA.dateErrors[0].boardDate, '2026-10-10');
failTomorrow = false; uploads.length = 0;
await vm.runInContext("performSync('alarm')", ctx);
assert.deepEqual(uploads, ['2026-10-10'], 'retry only the failed date within the heartbeat window');
assert.equal(state.readerStatuses.NBA.ok, true);
assert.equal(state.readerStatuses.NBA.dateStatuses.length, 2);
assert.equal(state.readerStatuses.NBA.marketCount, 4);
assert.equal(state.readerStatuses.NBA.rawGameCount, 2);
assert.deepEqual(Object.keys(state.lastSuccessfulSyncAts).sort(), ['NBA:2026-10-09','NBA:2026-10-10']);
uploads.length = 0;
await vm.runInContext("performSync('alarm')", ctx);
assert.deepEqual(uploads, []);
assert.equal(state.readerStatuses.NBA.ok, true);
console.log('Actual Reader service worker: date uploads, partial failure, isolated retry, receipts and heartbeat PASS');

// Repeat the real worker using independent today/tomorrow tabs/frames. This
// verifies both dated sources reach backend normalization and save receipts.
syncCaptures = [todayTab.capture, tomorrowTab.capture];
uploads.length = 0;
await vm.runInContext("performSync('manual')", ctx);
assert.deepEqual(uploads, ['2026-10-09', '2026-10-10']);
assert.equal(state.readerStatuses.NBA.ok, true);
assert.equal(state.readerStatuses.NBA.dateStatuses.length, 2);
assert.equal(state.readerStatuses.NBA.rawGameCount, 2);
assert.deepEqual([...state.readerStatuses.NBA.boardDates], ['2026-10-09', '2026-10-10']);
console.log('NBA independent dated sources: scoped authority, intact quotes, whole-league conflict rejection and actual worker uploads PASS');

// Real worker incident: conflicting intact tabs -> bounded source refresh ->
// a new, unanimously matching capture carries both full and half markets.
const completeSource = structuredClone(sameDayCapture);
for (const record of completeSource.tables[0].rows) {
  record.cells[4] = cell(['1平 0.940', '0.940']);
  record.cells[5] = cell(['112.5 大 0.930', '小 0.930']);
}
const oldSource = structuredClone(completeSource);
oldSource.tables[0].rows[0].cells[3] = cell(['226平 大 0.940','小 0.940']);
let recovered = false;
const refreshedTabs = [];
fakeChrome.tabs.query = async () => [71,72].map(id => ({id,url:'https://tai888.in/newapp/#/BK'}));
fakeChrome.tabs.reload = async id => { refreshedTabs.push(id); recovered = true; };
fakeChrome.tabs.sendMessage = async id => ({ok:true,capture:{readerVersion,captures:[recovered || id === 72 ? completeSource : oldSource]}});
uploads.length = 0;
await vm.runInContext("performSync('alarm')", ctx);
assert.deepEqual(uploads, [], 'conflicting capture cannot reach live ingest, even after initiating reload');
assert.deepEqual(refreshedTabs, [71,72]);
assert.equal(state.readerStatuses.NBA.diagnosticCode, 'conflicting-duplicate-tabs');
assert.ok(state.nbaConflictRecoveryV1, 'incident budget survives service worker restart');
await vm.runInContext("performSync('alarm')", ctx);
assert.deepEqual(uploads, ['2026-10-09']);
assert.equal(state.readerStatuses.NBA.ok, true);
assert.equal(state.readerStatuses.NBA.marketCount, 8, 'both full and both half markets per game reach backend normalization');
assert.equal(state.nbaConflictRecoveryV1, undefined, 'only confirmed live receipt resets the incident budget');
console.log('PASS actual NBA worker: duplicate-price rejection -> source reload -> fresh full/half capture -> strict backend normalization/save receipt; no conflicting-price upload');
