import { readFileSync as readNbaRecoverySource } from 'node:fs';
// Actual worker + actual raw-evidence storage/outbox, with synthetic Chrome
// transport and backend-validated receipts. This is not live desktop evidence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as parser from '../reader/parser.js';
import * as selector from '../reader/board-selector.js';
import { createMarketOutbox, MARKET_ARCHIVE_ALARM } from '../reader/market-outbox.js';
import { createDiagnosticOutbox, DIAGNOSTIC_ALARM } from '../reader/diagnostic-outbox.js';
import { DIAGNOSTIC_SCHEMA, sanitizeDiagnosticReport } from '../reader/diagnostic-schema.js';
import { buildReaderSeenCapture, READER_SEEN_CAPTURE_SCHEMA as SCHEMA } from '../lib/reader-seen-capture.js';

const host = 'www1.tai888.in', pageUrl = `https://${host}/newapp/#/BS`;
const deviceId = 'real-seen-worker-fixture-device';
const observedAt = '2026-10-30T00:00:01.000Z';
const clone = value => structuredClone(value);
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
function evidence(league = 'NBA') {
  return { version: 'TAI888-DOM-CAPTURE-v2.2.0', league, readerVersion: '2.1.52',
    sourceHost: host, pageUrl, observedAt, pageActivityAt: observedAt,
    captureReasons: ['PRE_NORMALIZATION', 'SOURCE_PARTIAL'], completeCapture: false,
    tables: [{ sectionTitle: `聯盟：${league}`, headers: ['時間', '主客隊伍', '讓分', '大小盤'], rows: [
      { marketLocked: false, cells: [{ pair: ['not-yet-known-date', '08:00'] }, { pair: ['未配對新隊名', 'LAL 湖人[主]'] }, { pair: ['3+50 0.95', '0.93'] }] },
      { marketLocked: false, cells: [{ pair: ['not-yet-known-date', '08:00'] }, { pair: ['未配對新隊名', 'LAL 湖人[主]'] }, { pair: ['3+75 0.91', '0.97'] }] },
      { marketLocked: true, cells: [{ pair: ['封盤', ''] }] },
    ] }] };
}
function setup({ capture = null, captureVersion = '2.1.52', autoEnabled = true, parseThrows = false, tabs = [1] } = {}) {
  const state = { readerToken: 'synthetic-signed-token', deviceId, pairedAt: Date.now(), autoEnabled };
  const writes = [], uploads = [], diagnostics = [], listeners = [];
  const flags = { online: false, statusReadFails: false };
  const storage = {
    async get(keys) {
      if (keys == null && flags.statusReadFails) throw Error('synthetic storage read failure');
      if (keys == null) return ordered(clone(state));
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return ordered(Object.fromEntries(names.filter(key => Object.hasOwn(state, key)).map(key => [key, clone(state[key])])));
    },
    async set(values) { for (const [key, value] of Object.entries(values)) { state[key] = ordered(clone(value)); writes.push({ action: 'set', key }); } },
    async remove(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) { delete state[key]; writes.push({ action: 'remove', key }); } },
  };
  const event = { addListener() {} };
  const chrome = {
    runtime: { id: 'seen-worker-test-extension', onMessage: { addListener(listener) { listeners.push(listener); } },
      onInstalled: event, onStartup: event, getManifest: () => ({ version: '2.1.52' }) },
    storage: { local: storage }, alarms: { onAlarm: event, create: async () => {}, clear: async () => {} },
    tabs: { onUpdated: event, reload: async () => {}, query: async () => tabs.map(id => ({ id, url: pageUrl })),
      sendMessage: async () => ({ ok: true, capture: { readerVersion: captureVersion, captures: capture ? [clone(capture)] : [] } }) },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, url: pageUrl }] },
  };
  const context = vm.createContext({ chrome, ...parser, ...selector, createMarketOutbox, MARKET_ARCHIVE_ALARM,
    createDiagnosticOutbox, DIAGNOSTIC_ALARM, DIAGNOSTIC_SCHEMA, crypto: webcrypto, Date, URL, TextEncoder,
    AbortController, setTimeout, clearTimeout, queueMicrotask,
    parseTai888Capture: (...args) => { if (parseThrows) throw Error('synthetic parser rejection'); return parser.parseTai888Capture(...args); },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/api/reader/seen-captures')) {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-Device-Id'], deviceId);
        assert.equal(options.headers.Authorization, 'Bearer synthetic-signed-token');
        assert.ok(Object.keys(state).some(key => key.startsWith('tai888SeenV1:')), 'raw must be locally durable before upload');
        uploads.push(body);
        if (!flags.online) throw new TypeError('synthetic offline');
        const built = buildReaderSeenCapture(body, { deviceId, headerVersion: options.headers['X-Reader-Version'] });
        const now = new Date().toISOString();
        const receipt = { ok: true, durable: true, schema: SCHEMA, status: 'EVIDENCE_UNVERIFIED', evidenceStatus: 'EVIDENCE_UNVERIFIED',
          captureId: built.captureId, evidenceHash: built.evidenceHash, league: body.evidence.league,
          readerVersion: body.evidence.readerVersion, observedAt: body.evidence.observedAt, pageActivityAt: body.evidence.pageActivityAt || null,
          receivedAt: now, persistedAt: now, archiveOnly: true, currentBoardUpdated: false,
          executable: false, historicalAvailabilityVerified: false, coverageComplete: false };
        return { ok: true, status: 200, text: async () => JSON.stringify(receipt) };
      }
      if (url.endsWith('/api/reader/diagnostics')) {
        const report = sanitizeDiagnosticReport(body); diagnostics.push(report);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, durable: true, reportId: report.reportId, receivedAt: new Date().toISOString() }) };
      }
      throw Error(`Raw archive tests must not call a live-ingest endpoint: ${url}`);
    },
  });
  vm.runInContext(readFileSync('reader/seen-local.js', 'utf8'), context);
  vm.runInContext(readFileSync('reader/seen-outbox.js', 'utf8').replace(/^import .*?;\n/gm, line => line.includes('./nba-conflict-recovery.js') ? readNbaRecoverySource('reader/nba-conflict-recovery.js', 'utf8').replace(/^export /gm, '') + '\n' : '').replace(/^export /gm, ''), context);
  vm.runInContext(readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, line => line.includes('./nba-conflict-recovery.js') ? readNbaRecoverySource('reader/nba-conflict-recovery.js', 'utf8').replace(/^export /gm, '') + '\n' : ''), context);
  return { state, writes, uploads, diagnostics, flags, context,
    run: source => vm.runInContext(source, context),
    async message(message, sender = { id: chrome.runtime.id, url: pageUrl, tab: { id: 1, url: pageUrl } }) {
      // Chrome deserializes runtime messages into the receiving worker realm.
      context.serializedMessage = JSON.stringify(message); context.serializedSender = JSON.stringify(sender);
      context.dispatchListener = listeners[0];
      return vm.runInContext('new Promise(resolve => dispatchListener(JSON.parse(serializedMessage), JSON.parse(serializedSender), resolve))', context);
    },
    pending: () => Object.entries(state).filter(([key]) => key.startsWith('tai888SeenV1:')),
    receipts: () => Object.entries(state).filter(([key]) => key.startsWith('tai888SeenAckV1:')),
  };
}

// Direct content notification persists even when live auto-sync is disabled.
const direct = setup({ autoEnabled: false });
const directEvidence = evidence();
const queued = await direct.message({ type: 'TAI888_SEEN_CAPTURE', evidence: directEvidence });
assert.equal(queued.durable, true); assert.equal(queued.queued, true); assert.equal(queued.captureIds.length, 1);
await direct.run('getSeenOutbox().flush()');
assert.equal(direct.pending().length, 1, 'offline data remains queued');
const heldWire = JSON.parse(direct.pending()[0][1].wireText);
assert.deepEqual(heldWire.evidence.tables, directEvidence.tables, 'duplicates, partial identity/date and locks survive exactly');
assert.equal(direct.state.autoEnabled, false);
direct.flags.online = true;
await direct.run('getSeenOutbox().flush({force:true})');
assert.equal(direct.pending().length, 0); assert.equal(direct.receipts().length, 1);
const ackWrite = direct.writes.findIndex(row => row.action === 'set' && row.key.startsWith('tai888SeenAckV1:'));
const queueDelete = direct.writes.findIndex(row => row.action === 'remove' && row.key.startsWith('tai888SeenV1:'));
assert.ok(ackWrite >= 0 && queueDelete > ackWrite, 'local immutable ACK must be saved before deleting queued evidence');
assert.equal((await direct.run('getSeenOutbox().status()')).savedCaptureCount, 1);
assert.equal((await direct.run("performSync('alarm')")).skipped, true);

// Both an obsolete content version and parser failure archive before rejection.
const oldEvidence = evidence('EPL'); oldEvidence.readerVersion = '2.1.26';
const old = setup({ capture: oldEvidence, captureVersion: '2.1.26' });
assert.equal((await old.run('collectCandidates([{id:1}])')).candidates.length, 0);
assert.equal(old.pending().length, 1, 'stale reader version cannot bypass raw preservation');
assert.deepEqual(JSON.parse(old.pending()[0][1].wireText).evidence.tables, oldEvidence.tables);
old.flags.online = true; await old.run('getSeenOutbox().flush({force:true})');
assert.equal(old.receipts().length, 1); assert.equal(old.uploads[0].evidence.readerVersion, '2.1.26');

const broken = setup({ capture: evidence('NHL'), parseThrows: true });
assert.equal((await broken.run('collectCandidates([{id:1}])')).candidates.length, 0);
assert.equal(broken.pending().length, 1, 'parser exceptions cannot discard previously saved raw sport rows');
broken.flags.online = true; await broken.run('getSeenOutbox().flush({force:true})');
assert.equal(broken.receipts().length, 1);

// Reject foreign and insecure senders before writing any source evidence.
for (const url of ['https://tai888.in.attacker.test/newapp/', 'http://tai888.in/newapp/', 'https://user:pass@tai888.in/newapp/', 'https://tai888.in:444/newapp/']) {
  const worker = setup();
  const result = await worker.message({ type: 'TAI888_SEEN_CAPTURE', evidence: evidence() }, { id: 'seen-worker-test-extension', url });
  assert.equal(result.durable, false, `sender must be rejected: ${url}`);
  assert.equal(worker.pending().length, 0); assert.equal(worker.uploads.length, 0);
}
const foreignExtension = setup();
assert.equal((await foreignExtension.message({ type: 'TAI888_SEEN_CAPTURE', evidence: evidence() }, { id: 'another-extension', url: pageUrl })).durable, false);
assert.equal(foreignExtension.pending().length, 0);
for (const url of ['about:blank', 'about:srcdoc']) {
  const inherited = setup();
  // A same-site blank frame can inherit a distinct Tai888 source subdomain.
  const source = evidence('CPBL'); source.sourceHost = 'www2.tai888.in'; source.pageUrl = 'https://www2.tai888.in/newapp/#/BS';
  const result = await inherited.message({ type: 'TAI888_SEEN_CAPTURE', evidence: source },
    { id: 'seen-worker-test-extension', url, tab: { id: 1, url: pageUrl } });
  assert.equal(result.durable, true, 'inherited Tai888 blank frame preserves evidence');
  await inherited.run('getSeenOutbox().flush()'); assert.equal(inherited.pending().length, 1);
  assert.equal(JSON.parse(inherited.pending()[0][1].wireText).evidence.sourceHost, 'www2.tai888.in');
  const unknownParent = setup();
  assert.equal((await unknownParent.message({ type: 'TAI888_SEEN_CAPTURE', evidence: source },
    { id: 'seen-worker-test-extension', url, tab: { id: 1, url: 'https://attacker.test/' } })).durable, false);
}
const wrongEvidence = setup(), foreignSource = evidence(); foreignSource.sourceHost = 'attacker.test'; foreignSource.pageUrl = 'https://attacker.test/';
assert.equal((await wrongEvidence.message({ type: 'TAI888_SEEN_CAPTURE', evidence: foreignSource })).durable, false);
assert.equal(wrongEvidence.pending().length, 0);

// A read failure remains unknown through actual automatic diagnostic transport.
const reporting = setup({ tabs: [] }); reporting.flags.statusReadFails = true;
assert.equal((await reporting.run("performSync('manual')")).ok, false);
assert.equal(reporting.diagnostics.length, 1);
const delivery = reporting.diagnostics[0].seenCaptureDelivery;
assert.equal(delivery.state, 'error'); assert.equal(delivery.code, 'SEEN_STORAGE_UNAVAILABLE');
for (const field of ['pendingCount', 'pendingBytes', 'savedCaptureCount', 'failedCaptureCount']) assert.equal(delivery[field], null, `${field} is unknown, never a fabricated zero`);
assert.equal(JSON.stringify(reporting.diagnostics).includes('synthetic-signed-token'), false);

console.log('PASS actual Reader worker + raw outbox: direct disabled-auto capture, local-before-upload, strict receipt-before-delete, offline retry, pre-version/parser archive, origin rejection and nullable automatic diagnostics; desktop/Production NOT VERIFIED');
