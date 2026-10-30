import { readFileSync as readNbaRecoverySource } from 'node:fs';
import { installArchiveWorkerFixture } from './reader-archive-receipt-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DIAGNOSTIC_SCHEMA, diagnosticCode, sanitizeDiagnosticReport } from '../reader/diagnostic-schema.js';
import { createDiagnosticOutbox, DIAGNOSTIC_ALARM } from '../reader/diagnostic-outbox.js';
import { saveReaderDiagnostic, listReaderDiagnostics } from '../lib/reader-diagnostic-store.js';
import * as parser from '../reader/parser.js';
import * as selector from '../reader/board-selector.js';

let clock = Date.now();
const makeReport = (state = 'error') => ({ schema: DIAGNOSTIC_SCHEMA, reportId: randomUUID(),
  readerVersion: '2.1.52', extensionManifestVersion: '2.1.52', createdAt: new Date(clock).toISOString(),
  silentTabCount: 0, tabCount: 1, leagues: { NBA: { state, errorCode: 'no-complete-tab',
    issues: ['game-1:full-total:invalid-line'], boards: [{ parsedGameCount: 1, diagnostics: { expectedGameCount: 2, gameCount: 1 }, issues: ['expected-2-parsed-1'] }] } } });
const poison = 'password=secret-cookie-token';
const dirty = makeReport(); dirty.password = poison; dirty.leagues.NBA.message = poison;
dirty.leagues.NBA.issues.push(poison, `duplicate-game:${poison}`);
dirty.leagues.NBA.boards[0].diagnostics.session = poison;
dirty.leagues.NBA.boards[0].tables = [{ raw: poison }];
const clean = sanitizeDiagnosticReport(dirty);
assert.ok(!JSON.stringify(clean).includes(poison));
assert.equal(clean.leagues.NBA.issues[0], 'game-1:full-total:invalid-line');
assert.equal(diagnosticCode('parser:wrong-period-header:NBA:first-five'), 'parser:wrong-period-header:NBA:first-five');
assert.equal(diagnosticCode(`parser:conflicting-duplicate:${poison}`), 'parser:conflicting-duplicate');
assert.throws(() => sanitizeDiagnosticReport({ ...dirty, reportId: 'not-an-id' }));

const state = { readerToken: 'synthetic-token', deviceId: 'device-test-123456' };
const storage = { get: async () => structuredClone(state), set: async value => Object.assign(state, structuredClone(value)) };
let offline = true, mismatched = false, calls = 0;
const received = [];
const upload = async report => {
  calls++;
  if (offline) throw new TypeError('offline');
  if (mismatched) return { ok: true, durable: true, reportId: randomUUID(), receivedAt: new Date(clock).toISOString() };
  received.push(report);
  return { ok: true, durable: true, reportId: report.reportId, receivedAt: new Date(clock).toISOString() };
};
let outbox = createDiagnosticOutbox({ storage, upload, now: () => clock });
await outbox.enqueue(clean); await outbox.flush();
assert.equal(state.diagnosticDelivery.state, 'pending'); assert.equal(state.diagnosticOutbox.length, 1);
await outbox.flush(); assert.equal(calls, 1, 'backoff must prevent immediate retry storms');
outbox = createDiagnosticOutbox({ storage, upload, now: () => clock });
offline = false; mismatched = true; clock += 60001; await outbox.flush();
assert.equal(state.diagnosticOutbox.length, 1, 'a wrong receipt cannot discard evidence');
mismatched = false; clock += 120001; await outbox.flush();
assert.equal(state.diagnosticOutbox.length, 0); assert.equal(state.diagnosticDelivery.state, 'sent');
assert.equal(received[0].reportId, clean.reportId, 'worker restart must retain the original ID');
const repeat = makeReport(); await outbox.enqueue(repeat); await outbox.enqueue(makeReport());
assert.equal(state.diagnosticOutbox.length, 1, 'identical snapshots are sampled');
await outbox.enqueue(makeReport('synced')); assert.equal(state.diagnosticOutbox.length, 2, 'state transitions are retained immediately');
for (let i = 0; i < 25; i++) { clock += 60001; await outbox.enqueue(makeReport()); }
assert.equal(state.diagnosticOutbox.length, 20, 'local queue is bounded');
delete state.readerToken; await outbox.flush(); assert.equal(state.diagnosticOutbox.length, 20, 'unpaired reports wait for valid pairing');
state.readerToken = 'new-synthetic-token';

const dbRows = new Map();
const statements = [];
const sql = async (strings, ...values) => {
  const query = strings.join('?'); statements.push(query);
  if (/CREATE TABLE|DELETE FROM/.test(query)) return [];
  if (/INSERT INTO/.test(query)) {
    const [id, device, checksum, payload] = values;
    const previous = dbRows.get(id);
    if (previous && (previous.device_id !== device || previous.checksum !== checksum)) return [];
    const row = previous || { report_id: id, device_id: device, checksum, payload: JSON.parse(payload), received_at: new Date(clock).toISOString() };
    dbRows.set(id, row); return [row];
  }
  if (/SELECT report_id, device_id/.test(query)) return [...dbRows.values()].filter(row => (!values[0] || row.device_id === values[0]) && (!values[2] || row.payload.leagues[values[2]]));
  throw new Error(`Unexpected SQL: ${query}`);
};
const report = makeReport();
const receipt = await saveReaderDiagnostic(report, state.deviceId, { sql });
assert.equal(receipt.durable, true); assert.equal(receipt.reportId, report.reportId);
assert.deepEqual(await saveReaderDiagnostic(report, state.deviceId, { sql }), receipt);
await assert.rejects(saveReaderDiagnostic(report, 'other-device-12345', { sql }), error => error.status === 409);
await assert.rejects(saveReaderDiagnostic({ ...report, readerVersion: '2.1.44' }, state.deviceId, { sql }), error => error.status === 409);
assert.equal((await listReaderDiagnostics({ league: 'NBA' }, { sql })).length, 1);
assert.equal((await listReaderDiagnostics({ league: 'EPL' }, { sql })).length, 0);
assert.ok(statements.every(query => !/sports_baseball_reader|nba_reader|analysis_result/.test(query)), 'diagnostics cannot mutate market or analysis tables');

// Run the actual service-worker scan: a locally rejected NBA capture must
// send diagnostics and must never hit any market-ingest endpoint.
const events = { addListener() {} }, requests = [];
const workerState = { readerToken: 'test-token', deviceId: 'worker-device-12345', pairedAt: clock, autoEnabled: true };
const fakeChrome = {
  runtime: { onInstalled: events, onStartup: events, onMessage: events, getManifest: () => ({ version: '2.1.52' }) },
  alarms: { onAlarm: events },
  storage: { local: { get: async () => structuredClone(workerState), set: async values => Object.assign(workerState, structuredClone(values)) } },
  tabs: { onUpdated: events, query: async () => [{ id: 1 }], sendMessage: async () => ({ ok: true,
    capture: { readerVersion: '2.1.52', captures: [{ league: 'NBA', observedAt: new Date().toISOString(), sourceHost: 'www.tai888.in', tables: [{ rows: [] }], diagnostics: { gameCount: 1, expectedGameCount: 1 } }] } }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
};
const context = vm.createContext({ chrome: fakeChrome, ...parser, ...selector, createDiagnosticOutbox,
  DIAGNOSTIC_SCHEMA, DIAGNOSTIC_ALARM, diagnosticCode, Date, crypto, TextEncoder, AbortController, URL,
  setTimeout, clearTimeout, queueMicrotask, fetch: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    assert.ok(url.endsWith('/api/reader/diagnostics'), 'rejected boards cannot be ingested');
    const body = JSON.parse(options.body);
    return Response.json({ ok: true, durable: true, reportId: body.reportId, receivedAt: new Date().toISOString() });
  } });
installArchiveWorkerFixture(context);
vm.runInContext(readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, line => line.includes('./nba-conflict-recovery.js') ? readNbaRecoverySource('reader/nba-conflict-recovery.js', 'utf8').replace(/^export /gm, '') + '\n' : ''), context);
const scan = await vm.runInContext("performSync('manual')", context);
assert.equal(scan.ok, false); assert.equal(requests.length, 1);
assert.equal(requests[0].body.leagues.NBA.state, 'error');
assert.ok(requests[0].body.leagues.NBA.boards[0].issues.includes('no-parsed-games'));
assert.equal(workerState.diagnosticDelivery.state, 'sent');
assert.equal(JSON.stringify(requests).includes('test-token'), false);
console.log('Automatic Reader diagnostics: redaction, rejection-to-report, no market bypass, offline/restart retry, bounded queue, receipts, idempotency and league/device isolation PASS');
