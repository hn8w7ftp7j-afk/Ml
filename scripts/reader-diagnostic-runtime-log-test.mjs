import assert from 'node:assert/strict';
import { logReaderDiagnosticReceipt } from '../lib/reader-diagnostic-runtime-log.js';
import { buildNbaAuthorityDiagnostics } from '../reader/nba-authority-diagnostics.js';

const source = water => ({ tabId: 987654, frameId: 123456, parsed: { league: 'NBA', games: [{
  boardDate: '2026-11-07', boardTime: '08:00', awayCode: 'BOS', homeCode: 'NY',
  fullTotal: { line: '220.5', overWater: water, underWater: .94 },
}] } });
const report = {
  schema: 'READER-DIAGNOSTICS-v1', reportId: '11111111-1111-4111-8111-111111111111',
  readerVersion: '2.1.56', extensionManifestVersion: '2.1.56', createdAt: '2026-11-06T19:18:00Z',
  tabCount: 2, leagues: { NBA: { state: 'error', errorCode: 'conflicting-duplicate-tabs',
    authority: buildNbaAuthorityDiagnostics([source(.94), source(.96)]) } },
};
const receipt = { ok: true, durable: true, reportId: report.reportId, receivedAt: '2026-11-06T19:18:01Z' };
const poison = 'password=secret-cookie-token';
report.deviceId = poison; report.leagues.NBA.message = poison;
report.leagues.NBA.authority.url = poison;
const before = structuredClone(report), emitted = [];
const emit = (...args) => emitted.push(args);
assert.equal(logReaderDiagnosticReceipt(report, receipt, emit), true);
const event = JSON.parse(emitted[0][1]);
assert.equal(event.code, 'NBA_READER_DIAGNOSTIC_SAVED');
assert.equal(event.createdAt, '2026-11-06T19:18:00.000Z');
assert.equal(event.receivedAt, '2026-11-06T19:18:01.000Z');
assert.equal(event.diagnostic.errorCode, 'conflicting-duplicate-tabs');
assert.deepEqual(event.diagnostic.authority.differences[0].fields, [{ field: 'overWater', left: .94, right: .96 }]);
assert.doesNotMatch(JSON.stringify(emitted), /password=|987654|123456|deviceId|executable/);
assert.deepEqual(report, before, 'observability must not rewrite captured evidence');
for (const invalid of [null, { ...receipt, ok: false }, { ...receipt, durable: false },
  { ...receipt, reportId: '22222222-2222-4222-8222-222222222222' }, { ...receipt, receivedAt: 'bad' }]) {
  assert.equal(logReaderDiagnosticReceipt(report, invalid, emit), false);
}
assert.equal(logReaderDiagnosticReceipt({ ...report, reportId: 'bad' }, receipt, emit), false);
assert.equal(logReaderDiagnosticReceipt({ ...report, leagues: { EPL: report.leagues.NBA } }, receipt, emit), false,
  'football reports cannot be labeled as NBA');
assert.equal(emitted.length, 1, 'invalid receipts and other leagues must not produce a success event');
assert.equal(logReaderDiagnosticReceipt(report, receipt, () => { throw Error('logger unavailable'); }), false);
assert.equal(logReaderDiagnosticReceipt({ ...report, leagues: { NBA: { state: 'synced', rawGameCount: 9, marketCount: 36 } } }, receipt, emit), true);
assert.equal(JSON.parse(emitted.at(-1)[1]).diagnostic.state, 'synced', 'a later recovery remains distinguishable from a failure');
console.log('PASS Reader runtime diagnostics: durable ACK, exact typed conflicts, recovery states, redaction, immutability, league isolation and nonfatal logging');
