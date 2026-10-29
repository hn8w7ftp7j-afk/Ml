import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import * as parser from '../reader/parser.js';
import * as selector from '../reader/board-selector.js';
import { createMarketOutbox, MARKET_ARCHIVE_ALARM, MARKET_ARCHIVE_SCHEMA, marketArchivePayload, marketArchiveCaptureId } from '../reader/market-outbox.js';
import { createDiagnosticOutbox, DIAGNOSTIC_ALARM } from '../reader/diagnostic-outbox.js';
import { DIAGNOSTIC_SCHEMA } from '../reader/diagnostic-schema.js';
import { readerSaveReceiptFixture } from './reader-save-receipt-fixture.mjs';
import { buildReaderCaptureArchive } from '../lib/reader-capture-archive.js';

// These are synthetic source boards, not proof of the user's external PC or
// bookmaker coverage. Execute the actual selected-board worker and real outbox.
let clock = Date.parse('2026-10-30T00:00:00.000Z');
const observedAt = new Date(clock).toISOString();
const readerVersion = JSON.parse(fs.readFileSync('reader/manifest.json')).version;
const sha = value => createHash('sha256').update(value).digest('hex');
const teams = { MLB: ['NYY-洋基', 'BOS-紅襪[主]'], NPB: ['SOF-軟銀鷹', 'NIP-日本火腿[主]'],
  KBO: ['LOG-樂天巨人', 'DOO-斗山熊[主]'], CPBL: ['CTB-中信兄弟', 'UNI-統一獅[主]'], NBA: ['HOU-火箭', 'DAL-獨行俠[主]'] };
const cell = pair => ({ pair, lines: pair });
function board(league, line = '2平') {
  if (['EPL', 'UCL'].includes(league)) return { league, pageLeagueLabel: league === 'EPL' ? '英超英格蘭超級聯賽' : '歐冠歐洲冠軍聯賽',
    sourceHost: 'tai888.in', pageUrl: 'https://tai888.in/newapp/', observedAt,
    tables: [{ sectionTitle: league === 'EPL' ? '英超英格蘭超級聯賽 全場' : '歐冠歐洲冠軍聯賽 全場',
      headers: ['時間', '主客隊伍', '讓球', '大小', '獨贏'], rows: [{ cells: [cell(['10-30', '20:05']),
        cell(league === 'EPL' ? ['利物浦', '兵工廠[主]'] : ['皇家馬德里', '巴塞隆納[主]']),
        cell([`${line} 0.950`, '0.950']), cell(['大2.5 0.940', '小 0.940']), cell(['主勝 1.200', '和 2.200', '客勝 1.800'])] }] }],
    diagnostics: { gameCount: 1, expectedGameCount: 1, lastMutationAt: observedAt } };
  return { league, sourceHost: 'tai888.in', pageUrl: 'https://tai888.in/newapp/', observedAt,
    tables: [{ headers: ['時間', '主客隊伍', '全場讓分', '全場大小', '獨贏', '一輸二贏', '上半場讓分', '上半場大小'],
      rows: [{ cells: [cell(['10-30', '20:05']), cell(teams[league]), cell([`${line} 0.950`, '0.950']),
        cell([`${league === 'NBA' ? '225+50' : '7+50'} 大 0.940`, '小 0.940']), cell([]), cell([]),
        cell(['1平 0.930', '0.930']), cell([`${league === 'NBA' ? '115.5' : '3.5'} 大 0.920`, '小 0.920'])] }] }],
    diagnostics: { gameCount: 1, expectedGameCount: 1, lastMutationAt: observedAt } };
}
function payload(league = 'MLB', line = '2平') {
  const result = { ...parser.parseTai888Capture(board(league, line), new Date(clock)), readerVersion,
    pageActivityAt: observedAt, expectedGameCount: 1, detectedGameCount: 1, deviceId: 'fixture-device' };
  assert.deepEqual(result.parseIssues, [], league);
  result.payloadHash = sha(parser.canonicalReaderPayload(result)); return result;
}
const receipt = async p => {
  const checked = buildReaderCaptureArchive({ schema: MARKET_ARCHIVE_SCHEMA, payload: { ...p, deviceId: 'fixture-device' } },
    { deviceId: 'fixture-device', headerVersion: p.readerVersion, now: clock });
  assert.equal(checked.captureId, await marketArchiveCaptureId(p, sha), 'actual server intake derives the same exact capture identity');
  return { ok: true, durable: true, archiveOnly: true, currentBoardUpdated: false,
    historicalAvailabilityVerified: false, executable: false, captureId: checked.captureId,
    payloadHash: p.payloadHash, league: p.league, boardDate: p.boardDate, observedAt: p.observedAt,
    pageActivityAt: p.pageActivityAt, receivedAt: new Date(clock).toISOString(), persistedAt: new Date(clock + 1).toISOString() };
};
function memory(seed = {}) {
  const state = { readerToken: 'private-pair-token', deviceId: 'fixture-device', ...seed };
  return { state, storage: { get: async () => structuredClone(state), set: async value => Object.assign(state, structuredClone(value)) } };
}
const seven = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL'];
for (const league of seven) {
  const original = payload(league), dirty = structuredClone(original);
  dirty.readerToken = 'never-store-token'; dirty.account = 'never-store-account';
  if (!['EPL', 'UCL'].includes(league)) dirty.games[0].session = 'never-store-session';
  const sanitized = marketArchivePayload(dirty);
  assert.equal(parser.canonicalReaderPayload(sanitized), parser.canonicalReaderPayload(original));
  assert.equal(JSON.stringify(sanitized).includes('never-store'), false);
  assert.equal(sanitized.deviceId, undefined);
  assert.equal(sanitized.observedAt, observedAt); assert.equal(sanitized.pageActivityAt, observedAt);
  await receipt(sanitized);
}
for (const league of seven.slice(0, 4)) {
  const partial = board(league); partial.tables[0].rows[0].cells[2] = cell(['unrecognized', '0.950']);
  const capture = { ...parser.parseTai888Capture(partial, new Date(clock)), readerVersion, pageActivityAt: observedAt,
    expectedGameCount: 1, detectedGameCount: 1, deviceId: 'fixture-device' };
  capture.payloadHash = sha(parser.canonicalReaderPayload(capture));
  assert.equal(capture.games[0].fullRunline, null);
  assert.equal(capture.games[0].marketStates.FULL_HANDICAP, 'BLOCKED');
  await receipt(marketArchivePayload(capture));
}

const mem = memory(); let offline = true, badReceipt = false, attempts = 0;
const upload = async p => { attempts++; if (offline) throw new TypeError('offline');
  return { ...await receipt(p), ...(badReceipt ? { observedAt: new Date(clock + 1000).toISOString() } : {}) }; };
const options = { storage: mem.storage, upload, sha, now: () => clock };
let outbox = createMarketOutbox(options);
const first = payload(); assert.equal((await outbox.enqueue(first, mem.state.deviceId)).queued, true);
await outbox.enqueue(first, mem.state.deviceId); assert.equal(mem.state.marketArchiveOutbox.length, 1, 'consecutive identical pending prices deduplicate');
await outbox.flush(); assert.equal(mem.state.marketArchiveOutbox.length, 1);
await outbox.flush(); assert.equal(attempts, 1, 'backoff prevents immediate retry loops');
outbox = createMarketOutbox(options); offline = false; badReceipt = true; clock += 60001; await outbox.flush();
assert.equal(mem.state.marketArchiveOutbox.length, 1, 'an ACK with rewritten observation time cannot delete a capture');
badReceipt = false; clock += 120001; await outbox.flush();
assert.equal(mem.state.marketArchiveOutbox.length, 0); assert.equal(mem.state.marketArchiveDelivery.savedCaptureCount, 1);
assert.equal(mem.state.marketArchiveDelivery.lastReceivedAt, new Date(clock).toISOString());

const bounded = memory();
const small = createMarketOutbox({ storage: bounded.storage, upload, sha, now: () => clock, maxBytes: 3000 });
await small.enqueue(payload(), bounded.state.deviceId);
const originalQueue = structuredClone(bounded.state.marketArchiveOutbox);
let full = false;
for (let i = 3; i < 20 && !full; i++) full = !(await small.enqueue(payload('MLB', `${i}平`), bounded.state.deviceId)).queued;
assert.equal(full, true); assert.equal(bounded.state.marketArchiveDelivery.code, 'QUEUE_FULL');
assert.deepEqual(bounded.state.marketArchiveOutbox[0], originalQueue[0], 'queue overflow preserves old evidence');
assert.equal(bounded.state.marketArchiveDelivery.failedCaptureCount, 1);

const change = memory(), changes = createMarketOutbox({ storage: change.storage, upload, sha, now: () => clock });
await changes.enqueue(payload('MLB', '2平'), change.state.deviceId);
const moved = payload('MLB', '3平'); moved.observedAt = new Date(clock + 1000).toISOString(); moved.pageActivityAt = moved.observedAt;
await changes.enqueue(moved, change.state.deviceId);
const returned = payload('MLB', '2平'); returned.observedAt = new Date(clock + 2000).toISOString(); returned.pageActivityAt = returned.observedAt;
await changes.enqueue(returned, change.state.deviceId);
assert.equal(change.state.marketArchiveOutbox.length, 3, 'a price returning after a different state is a retained event');
delete change.state.readerToken; clock += 60 * 86400000; await changes.flush();
assert.equal(change.state.marketArchiveOutbox.length, 3, 'no age-based deletion and no unpaired upload');
change.state.readerToken = 'new-pair-token'; change.state.deviceId = 'another-device'; await changes.flush();
assert.equal(change.state.marketArchiveOutbox.length, 3, 'different device cannot replay another device evidence');
assert.equal(change.state.marketArchiveDelivery.code, 'DEVICE_MISMATCH');

const concurrent = memory(); let release;
const slow = createMarketOutbox({ storage: concurrent.storage, sha, now: () => clock,
  upload: p => new Promise(resolve => { release = async () => resolve(await receipt(p)); }) });
await slow.enqueue(payload('MLB', '2平'), concurrent.state.deviceId);
const flushing = slow.flush();
while (!release) await new Promise(resolve => setTimeout(resolve, 0));
await slow.enqueue(payload('MLB', '3平'), concurrent.state.deviceId);
await release(); await flushing;
assert.equal(concurrent.state.marketArchiveOutbox.length, 1, 'late ACK cannot erase newly queued price');
assert.equal(concurrent.state.marketArchiveOutbox[0].payload.games[0].fullRunline.line, '3平');

// Archive outage must leave live acceptance unchanged. Afterwards source pages
// may close, yet the startup/alarm path still drains all seven original captures.
clock = Date.parse(observedAt);
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
const workerMemory = memory({ autoEnabled: true, pairedAt: clock }), live = [], archived = [], alarmListeners = [], startupListeners = [];
let pages = seven.map(board), archiveOffline = true;
const event = { addListener() {} };
const chrome = { runtime: { onInstalled: event, onStartup: { addListener: fn => startupListeners.push(fn) }, onMessage: event,
  getManifest: () => ({ version: readerVersion }) }, alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener: fn => alarmListeners.push(fn) } },
  storage: { local: { ...workerMemory.storage, remove: async key => { delete workerMemory.state[key]; } } },
  tabs: { onUpdated: event, query: async () => pages.map((_, i) => ({ id: i + 1, active: i === 0 })),
    sendMessage: async id => ({ ok: true, capture: { readerVersion, captures: [pages[id - 1]] } }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] } };
const worker = vm.createContext({ chrome, ...parser, ...selector, Date: Clock, URL, TextEncoder, crypto: webcrypto,
  AbortController, setTimeout, clearTimeout, queueMicrotask, DIAGNOSTIC_SCHEMA, DIAGNOSTIC_ALARM, MARKET_ARCHIVE_ALARM,
  createDiagnosticOutbox, createMarketOutbox: options => createMarketOutbox({ ...options, now: () => clock }),
  fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/api/reader/diagnostics')) return Response.json({ ok: true, durable: true, reportId: body.reportId, receivedAt: new Date(clock).toISOString() });
    if (url.endsWith('/api/reader/archive')) {
      assert.equal(body.schema, MARKET_ARCHIVE_SCHEMA); assert.equal(body.payload.deviceId, workerMemory.state.deviceId);
      if (archiveOffline) throw new TypeError('offline');
      archived.push(body.payload); return Response.json(await receipt(body.payload));
    }
    live.push(body); return Response.json({ ok: false, error: 'Synthetic live-service outage' }, { status: 503 });
  } });
vm.runInContext(fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, ''), worker);
await vm.runInContext("performSync('manual')", worker);
assert.equal(live.length, seven.length, 'all seven live requests still execute during archive outage');
assert.equal(workerMemory.state.marketArchiveOutbox.length, seven.length);
assert.deepEqual(Object.keys(workerMemory.state.lastSuccessfulPayloadHashes), [], 'archive enqueue cannot authorize live acceptance');
pages = []; archiveOffline = false; clock += 120001; workerMemory.state.autoEnabled = false;
await vm.runInContext("performSync('alarm')", worker);
assert.equal(live.length, seven.length, 'historical catch-up never calls a live ingest endpoint');
assert.equal(workerMemory.state.marketArchiveOutbox.length, 0);
assert.equal(workerMemory.state.marketArchiveDelivery.savedCaptureCount, seven.length);
assert.deepEqual(archived.map(p => p.league).sort(), [...seven].sort());
assert.ok(archived.every(p => p.observedAt === observedAt && p.pageActivityAt === observedAt), 'catch-up preserves the original source clocks');
assert.ok(Object.values(workerMemory.state.readerStatuses).every(status => status.state !== 'synced'), 'archive catch-up does not turn failed live boards into synced boards');
assert.ok(startupListeners.length >= 3 && alarmListeners.length >= 3, 'dedicated retry survives source-tab closure and disabled live polling');
worker.extraArchive = payload('MLB', '4平');
await vm.runInContext("getMarketOutbox().enqueue(extraArchive,'fixture-device')", worker);
for (const handler of startupListeners) await handler();
assert.equal(workerMemory.state.marketArchiveOutbox.length, 0, 'startup drains queued history with no source pages and live auto-sync paused');
assert.equal(workerMemory.state.marketArchiveDelivery.savedCaptureCount, seven.length + 1);
assert.equal(live.length, seven.length);

clock = Date.parse(observedAt);
const quotaMemory = memory({ autoEnabled: true, pairedAt: clock }), quotaLive = [];
const quotaChrome = { ...chrome, storage: { local: { ...quotaMemory.storage, remove: async () => {} } },
  tabs: { ...chrome.tabs, query: async () => [{ id: 1 }],
    sendMessage: async () => ({ ok: true, capture: { readerVersion, captures: [board('MLB')] } }) } };
const quotaWorker = vm.createContext({ chrome: quotaChrome, ...parser, ...selector, Date: Clock, URL, TextEncoder, crypto: webcrypto,
  AbortController, setTimeout, clearTimeout, queueMicrotask, DIAGNOSTIC_SCHEMA, DIAGNOSTIC_ALARM, MARKET_ARCHIVE_ALARM,
  createDiagnosticOutbox, createMarketOutbox: options => createMarketOutbox({ ...options, now: () => clock, maxBytes: 1 }),
  fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/api/reader/diagnostics')) return Response.json({ ok: true, durable: true, reportId: body.reportId, receivedAt: new Date(clock).toISOString() });
    assert.ok(url.endsWith('/api/reader/ingest')); quotaLive.push(body); return Response.json(readerSaveReceiptFixture(body));
  } });
vm.runInContext(fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, ''), quotaWorker);
await vm.runInContext("performSync('manual')", quotaWorker);
assert.equal(quotaLive.length, 1, 'full archive queue cannot block live sync');
assert.equal(quotaMemory.state.readerStatuses.MLB.state, 'synced');
assert.equal(quotaMemory.state.marketArchiveDelivery.code, 'QUEUE_FULL');
assert.equal(Object.keys(quotaMemory.state.lastSuccessfulPayloadHashes).length, 1);
console.log('Reader market outbox: seven-league worker capture, offline/restart catch-up, exact ACKs, no eviction, quota warning, device isolation, A/B/A events, late-ACK concurrency, no live authority promotion PASS');
