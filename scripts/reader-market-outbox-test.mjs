import { readFileSync as readNbaRecoverySource } from 'node:fs';
import { installSeenWorkerFixture } from './reader-archive-receipt-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import * as parser from '../reader/parser.js';
import * as selector from '../reader/board-selector.js';
import { createMarketOutbox, MARKET_ARCHIVE_ALARM, MARKET_ARCHIVE_SCHEMA, marketArchivePayload, marketArchiveCaptureId, MARKET_ARCHIVE_ITEM_PREFIX } from '../reader/market-outbox.js';
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
function pending(state) {
  const all = new Map((state.marketArchiveOutbox || []).map(item => [item.ownerDeviceId + ':' + item.captureId, item]));
  for (const [key, item] of Object.entries(state)) if (key.startsWith(MARKET_ARCHIVE_ITEM_PREFIX) && item) all.set(item.ownerDeviceId + ':' + item.captureId, item);
  return [...all.values()];
}
function memory(seed = {}) {
  const state = { readerToken: 'private-pair-token', deviceId: 'fixture-device', ...seed };
  return { state, storage: { get: async keys => structuredClone(keys == null ? state : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, state[key]]))), set: async value => Object.assign(state, structuredClone(value)), remove: async key => { delete state[key]; } } };
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
await outbox.enqueue(first, mem.state.deviceId); assert.equal(pending(mem.state).length, 1, 'consecutive identical pending prices deduplicate');
await outbox.flush(); assert.equal(pending(mem.state).length, 1);
await outbox.flush(); assert.equal(attempts, 1, 'backoff prevents immediate retry loops');
outbox = createMarketOutbox(options); offline = false; badReceipt = true; clock += 60001; await outbox.flush();
assert.equal(pending(mem.state).length, 1, 'an ACK with rewritten observation time cannot delete a capture');
badReceipt = false; clock += 120001; await outbox.flush();
assert.equal(pending(mem.state).length, 0); assert.equal(mem.state.marketArchiveDelivery.savedCaptureCount, 1);
assert.equal(mem.state.marketArchiveDelivery.lastReceivedAt, new Date(clock).toISOString());

const bounded = memory();
const blockedStorage = { ...bounded.storage, set: async value => {
  if (Object.keys(value).some(key => key.startsWith(MARKET_ARCHIVE_ITEM_PREFIX))) throw new Error('browser storage quota exceeded');
  return bounded.storage.set(value);
} };
const small = createMarketOutbox({ storage: blockedStorage, upload, sha, now: () => clock });
const failedLocal = await small.enqueue(payload(), bounded.state.deviceId);
assert.equal(failedLocal.queued, false); assert.equal(failedLocal.durable, false);
assert.equal(bounded.state.marketArchiveDelivery.code, 'LOCAL_SAVE_FAILED');
assert.equal(bounded.state.marketArchiveDelivery.failedCaptureCount, 1);

// A pre-existing backlog beyond the old 6 MB application cap cannot refuse a
// newly observed capture. Each new record is written/read back independently.
const backlog = memory();
for (let i = 0; i < 8000; i++) {
  const p = payload('MLB', `${i + 10}平`), captureId = String(i).padStart(64, '0');
  const item = { captureId, ownerDeviceId: backlog.state.deviceId, payload: marketArchivePayload(p), queuedAt: i, attempts: 0, nextAttemptAt: 0 };
  backlog.state[MARKET_ARCHIVE_ITEM_PREFIX + item.ownerDeviceId + ':' + captureId] = item;
}
assert.ok(new TextEncoder().encode(JSON.stringify(pending(backlog.state))).length > 6 * 1024 * 1024);
const unlimited = createMarketOutbox({ storage: backlog.storage, upload, sha, now: () => clock });
assert.equal((await unlimited.enqueue(payload('MLB', '9999平'), backlog.state.deviceId)).durable, true);
assert.equal(pending(backlog.state).length, 8001);

// A storage API that resolves but fails to retain the payload is not a durable
// enqueue; source evidence is not treated as saved merely because set returned.
const silent = memory();
const lying = createMarketOutbox({ storage: { ...silent.storage, set: async value => {
  if (!Object.keys(value).some(key => key.startsWith(MARKET_ARCHIVE_ITEM_PREFIX))) await silent.storage.set(value);
} }, upload, sha, now: () => clock });
assert.equal((await lying.enqueue(payload(), silent.state.deviceId)).queued, false);
assert.equal(silent.state.marketArchiveDelivery.code, 'LOCAL_SAVE_FAILED');

// Legacy pending captures survive an upgrade and restart. A failed ACK keeps
// the exact legacy evidence; successful read-back ACK removes only that entry.
const oldPayload = marketArchivePayload(payload()), oldId = await marketArchiveCaptureId(oldPayload, sha);
const old = memory({ marketArchiveOutbox: [{ captureId: oldId, ownerDeviceId: 'fixture-device', payload: oldPayload, queuedAt: clock, attempts: 0, nextAttemptAt: 0 }] });
offline = true;
let upgraded = createMarketOutbox({ storage: old.storage, upload, sha, now: () => clock });
await upgraded.flush(); assert.equal(pending(old.state).length, 1);
offline = false; clock += 60001;
upgraded = createMarketOutbox({ storage: old.storage, upload, sha, now: () => clock });
await upgraded.flush(); assert.equal(pending(old.state).length, 0); assert.equal(old.state.marketArchiveOutbox.length, 0);

const change = memory(), changes = createMarketOutbox({ storage: change.storage, upload, sha, now: () => clock });
await changes.enqueue(payload('MLB', '2平'), change.state.deviceId);
const moved = payload('MLB', '3平'); moved.observedAt = new Date(clock + 1000).toISOString(); moved.pageActivityAt = moved.observedAt;
await changes.enqueue(moved, change.state.deviceId);
const returned = payload('MLB', '2平'); returned.observedAt = new Date(clock + 2000).toISOString(); returned.pageActivityAt = returned.observedAt;
await changes.enqueue(returned, change.state.deviceId);
assert.equal(pending(change.state).length, 3, 'a price returning after a different state is a retained event');
delete change.state.readerToken; clock += 60 * 86400000; await changes.flush();
assert.equal(pending(change.state).length, 3, 'no age-based deletion and no unpaired upload');
change.state.readerToken = 'new-pair-token'; change.state.deviceId = 'another-device'; await changes.flush();
assert.equal(pending(change.state).length, 3, 'different device cannot replay another device evidence');
assert.equal(change.state.marketArchiveDelivery.code, 'DEVICE_MISMATCH');

const concurrent = memory(); let release;
const slow = createMarketOutbox({ storage: concurrent.storage, sha, now: () => clock,
  upload: p => new Promise(resolve => { release = async () => resolve(await receipt(p)); }) });
await slow.enqueue(payload('MLB', '2平'), concurrent.state.deviceId);
const flushing = slow.flush();
while (!release) await new Promise(resolve => setTimeout(resolve, 0));
await slow.enqueue(payload('MLB', '3平'), concurrent.state.deviceId);
await release(); await flushing;
assert.equal(pending(concurrent.state).length, 1, 'late ACK cannot erase newly queued price');
assert.equal(pending(concurrent.state)[0].payload.games[0].fullRunline.line, '3平');

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
      assert.equal(options.headers['X-Reader-Version'], body.payload.readerVersion, 'historical replay header must use the original payload version, not the upgraded worker version');
      if (archiveOffline) throw new TypeError('offline');
      archived.push(body.payload); return Response.json(await receipt(body.payload));
    }
    live.push(body); return Response.json({ ok: false, error: 'Synthetic live-service outage' }, { status: 503 });
  } });
installSeenWorkerFixture(worker);
vm.runInContext(fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, line => line.includes('./nba-conflict-recovery.js') ? readNbaRecoverySource('reader/nba-conflict-recovery.js', 'utf8').replace(/^export /gm, '') + '\n' : ''), worker);
await vm.runInContext("performSync('manual')", worker);
assert.equal(live.length, seven.length, 'all seven live requests still execute during archive outage');
assert.equal(pending(workerMemory.state).length, seven.length);
assert.deepEqual(Object.keys(workerMemory.state.lastSuccessfulPayloadHashes), [], 'archive enqueue cannot authorize live acceptance');
pages = []; archiveOffline = false; clock += 120001; workerMemory.state.autoEnabled = false;
await vm.runInContext("performSync('alarm')", worker);
assert.equal(live.length, seven.length, 'historical catch-up never calls a live ingest endpoint');
assert.equal(pending(workerMemory.state).length, 0);
assert.equal(workerMemory.state.marketArchiveDelivery.savedCaptureCount, seven.length);
assert.deepEqual(archived.map(p => p.league).sort(), [...seven].sort());
assert.ok(archived.every(p => p.observedAt === observedAt && p.pageActivityAt === observedAt), 'catch-up preserves the original source clocks');
assert.ok(Object.values(workerMemory.state.readerStatuses).every(status => status.state !== 'synced'), 'archive catch-up does not turn failed live boards into synced boards');
assert.ok(startupListeners.length >= 3 && alarmListeners.length >= 3, 'dedicated retry survives source-tab closure and disabled live polling');
worker.extraArchive = payload('MLB', '4平');
await vm.runInContext("getMarketOutbox().enqueue(extraArchive,'fixture-device')", worker);
for (const handler of startupListeners) await handler();
assert.equal(pending(workerMemory.state).length, 0, 'startup drains queued history with no source pages and live auto-sync paused');
assert.equal(workerMemory.state.marketArchiveDelivery.savedCaptureCount, seven.length + 1);
assert.equal(live.length, seven.length);

// Upgrade counterexample: the v55 worker must drain the original seven-league
// v54 queue using v54 headers, rather than rewriting the immutable payload or
// rejecting it with a worker/payload version mismatch after extension upgrade.
const legacy54 = [];
for (const league of seven) {
  const original54 = marketArchivePayload(payload(league, '5平'));
  original54.readerVersion = '2.1.54';
  original54.payloadHash = sha(parser.canonicalReaderPayload(original54));
  legacy54.push({ captureId: await marketArchiveCaptureId(original54, sha), ownerDeviceId: workerMemory.state.deviceId,
    payload: original54, queuedAt: clock, attempts: 0, nextAttemptAt: 0 });
}
const original54Text = JSON.stringify(legacy54);
workerMemory.state.marketArchiveOutbox = structuredClone(legacy54);
await vm.runInContext("performSync('alarm')", worker);
assert.equal(pending(workerMemory.state).length, 0, 'upgraded worker drains old array captures after source pages close');
assert.equal(live.length, seven.length, 'legacy retry must never freshen a live board');
assert.deepEqual(archived.slice(-seven.length).map(p => p.readerVersion), seven.map(() => '2.1.54'));
assert.ok(archived.slice(-seven.length).every(p => p.observedAt === observedAt && p.pageActivityAt === observedAt));
assert.equal(JSON.stringify(legacy54), original54Text, 'worker does not rewrite original v54 times/hash/version');

clock = Date.parse(observedAt);
const quotaMemory = memory({ autoEnabled: true, pairedAt: clock }), quotaLive = [];
let quotaLiveFails = false;
const quotaChrome = { ...chrome, storage: { local: { ...quotaMemory.storage, remove: async () => {} } },
  tabs: { ...chrome.tabs, query: async () => [{ id: 1 }],
    sendMessage: async () => ({ ok: true, capture: { readerVersion, captures: [board('MLB')] } }) } };
const quotaWorker = vm.createContext({ chrome: quotaChrome, ...parser, ...selector, Date: Clock, URL, TextEncoder, crypto: webcrypto,
  AbortController, setTimeout, clearTimeout, queueMicrotask, DIAGNOSTIC_SCHEMA, DIAGNOSTIC_ALARM, MARKET_ARCHIVE_ALARM,
  createDiagnosticOutbox, createMarketOutbox: options => createMarketOutbox({ ...options, storage: { ...options.storage, set: async value => { if (Object.keys(value).some(key => key.startsWith(MARKET_ARCHIVE_ITEM_PREFIX))) throw new Error('browser quota'); return options.storage.set(value); } }, now: () => clock }),
  fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/api/reader/diagnostics')) return Response.json({ ok: true, durable: true, reportId: body.reportId, receivedAt: new Date(clock).toISOString() });
    assert.ok(url.endsWith('/api/reader/ingest')); quotaLive.push(body);
    if (quotaLiveFails) return Response.json({ ok: false, error: 'fixture live service offline' }, { status: 503 });
    return Response.json(readerSaveReceiptFixture(body));
  } });
installSeenWorkerFixture(quotaWorker);
vm.runInContext(fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, line => line.includes('./nba-conflict-recovery.js') ? readNbaRecoverySource('reader/nba-conflict-recovery.js', 'utf8').replace(/^export /gm, '') + '\n' : ''), quotaWorker);
await vm.runInContext("performSync('manual')", quotaWorker);
assert.equal(quotaLive.length, 1, 'full archive queue cannot block live sync');
assert.equal(quotaMemory.state.readerStatuses.MLB.state, 'synced');
assert.equal(quotaMemory.state.marketArchiveDelivery.code, 'LOCAL_SAVE_FAILED');
assert.equal(quotaMemory.state.readerStatuses.MLB.archiveWarnings.length, 1, 'local archive failure is not silently ignored after live success');
assert.match(quotaMemory.state.readerStatuses.MLB.message, /本機歷史補傳備份未確認/);
assert.equal(Object.keys(quotaMemory.state.lastSuccessfulPayloadHashes).length, 1);
quotaLiveFails = true;
await vm.runInContext("performSync('manual')", quotaWorker);
assert.equal(quotaMemory.state.readerStatuses.MLB.state, 'error');
assert.match(quotaMemory.state.readerStatuses.MLB.message, /本機歷史補傳備份也未確認，不能視為已保存/);

// The fast enumeration path must never clone unrelated raw DOM fragments.
const scopedMemory = memory({ 'tai888SeenV1:large-unrelated-source': { wireText: 'x'.repeat(1000000) } });
const readKeys = [];
const scoped = createMarketOutbox({ storage: { ...scopedMemory.storage,
  getKeys: async () => Object.keys(scopedMemory.state),
  get: async keys => { readKeys.push(keys); return scopedMemory.storage.get(keys); },
}, upload, sha, now: () => clock });
assert.equal((await scoped.enqueue(payload(), scopedMemory.state.deviceId)).durable, true);
assert.ok(readKeys.every(keys => Array.isArray(keys) && !keys.includes('tai888SeenV1:large-unrelated-source')));

console.log('Reader market outbox: seven-league worker capture, offline/restart catch-up, exact ACKs, per-capture durable storage beyond 6MB, legacy upgrade, exact local readback, no eviction, quota warning, device isolation, A/B/A events, late-ACK concurrency, no live authority promotion PASS');
