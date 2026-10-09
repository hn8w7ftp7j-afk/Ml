import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseTai888Capture, canonicalReaderPayload } from '../reader/parser.js';
import { assessBoardCandidate, selectAuthoritativeBoard, readerPayloadsByDate } from '../reader/board-selector.js';
import { normalizeNbaReaderPayload } from '../lib/nba/reader.js';
import { storeNbaReaderSnapshot, loadNbaReaderSnapshot } from '../lib/nba/reader-store.js';
process.env.READER_STORE_MEMORY_ONLY = 'true';
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
const payload = { ...parsed, readerVersion: '2.1.30', deviceId: 'device-multi-date-test', pageActivityAt: now.toISOString(), expectedGameCount: 2, detectedGameCount: 2 };
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
const uploads = []; let failTomorrow = true;
const fakeChrome = {
  runtime: { onInstalled: event, onStartup: event, onMessage: event }, alarms: { onAlarm: event },
  storage: { local: { get: async () => structuredClone(state), set: async value => Object.assign(state, value), remove: async key => { delete state[key]; } } },
  tabs: { onUpdated: event, query: async () => [{ id: 7, active: true }], sendMessage: async () => ({ ok: true, capture: { readerVersion: '2.1.30', captures: [capture] } }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
};
const ctx = { chrome: fakeChrome, parseTai888Capture, canonicalReaderPayload, readerMarketProperties, selectAuthoritativeBoard, shouldSkipSuccessfulPayload, readerPayloadsByDate,
  Date: Clock, crypto: webcrypto, TextEncoder, AbortController, URL, setTimeout, clearTimeout, queueMicrotask,
  fetch: async (url, options) => {
    const body = JSON.parse(options.body); uploads.push(body.boardDate);
    assert.equal(url, 'https://mlb-positive-ev.vercel.app/api/nba/reader');
    const normalized = normalizeNbaReaderPayload(body, { deviceId: state.deviceId, headerVersion: '2.1.30', now: +now });
    if (body.boardDate === '2026-10-10' && failTomorrow) return { status: 503, ok: false, text: async () => JSON.stringify({ ok: false, error: 'synthetic temporary failure' }) };
    return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, boardDate: body.boardDate, rawGameCount: normalized.gameCount, marketCount: normalized.marketCount }) };
  } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../reader/background.js', import.meta.url), 'utf8').replace(/^import .*?;\n/gm, ''), ctx);
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
