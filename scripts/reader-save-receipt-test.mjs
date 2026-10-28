import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { canonicalReaderPayload, readerMarketProperties } from '../reader/parser.js';
import { readerPayloadsByDate, shouldSkipSuccessfulPayload } from '../reader/board-selector.js';
import { readerSaveReceiptFixture } from './reader-save-receipt-fixture.mjs';

// Exercise the actual worker's receipt boundary and upload loop. DOM parsing
// and source selection have their own real-DOM regressions; only those inputs
// and HTTP persistence responses are synthetic here. No Production requests.
const source = readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, '');
const leagues = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL', 'EPL', 'UCL'];
const clock = Date.parse('2026-10-27T00:00:00.000Z'), at = new Date(clock).toISOString();
const poison = 'private-cookie-and-password';
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}
const plain = value => JSON.parse(JSON.stringify(value));
const digest = payload => createHash('sha256').update(canonicalReaderPayload(payload)).digest('hex');
function board(league, dates = ['2026-10-27']) {
  return { league, boardDate: dates[0], observedAt: at, sourceHost: 'tai888.in', games: dates.map(boardDate => ({
    boardDate, boardTime: '20:00', awayCode: 'AAA', homeCode: 'BBB', marketStatus: 'open',
    fullTotal: { line: '3+50', overWater: 0.95, underWater: 0.95 },
    ...(league === 'EPL' || league === 'UCL' ? { periodsCovered: ['FT'], periodStates: { FT: 'open' }, markets: [
      { period: 'FT', kind: 'TOTAL', line: '3+50', overWater: 0.95, underWater: 0.95 },
    ] } : {}),
  })) };
}
function harness(payload, respond = input => readerSaveReceiptFixture(input)) {
  const event = { addListener() {} }, uploads = [];
  const state = { deviceId: 'receipt-worker-fixture', readerToken: 'synthetic-receipt-token' };
  const candidate = { parsed: payload, capture: { tables: [], diagnostics: {} } };
  const selected = items => ({ candidate: items[0], pageActivityAt: at,
    expectedGameCount: items[0].parsed.games.length, detectedGameCount: items[0].parsed.games.length });
  const chrome = { runtime: { onInstalled: event, onStartup: event, onMessage: event }, alarms: { onAlarm: event },
    tabs: { onUpdated: event, query: async () => [{ id: 1 }] },
    storage: { local: { get: async () => structuredClone(state),
      set: async values => Object.assign(state, structuredClone(values)) } } };
  const worker = vm.createContext({ chrome, Date: Clock, crypto: webcrypto, URL, TextEncoder,
    AbortController, setTimeout, clearTimeout, queueMicrotask, canonicalReaderPayload, readerMarketProperties,
    readerPayloadsByDate, shouldSkipSuccessfulPayload,
    nhlReaderEvidencePayload: input => input,
    selectAuthoritativeBoard: items => ({ ok: true, selected: selected(items) }),
    selectAuthoritativeSoccerBoards: items => ({ ok: true, selections: [{ selected: selected(items),
      sourceScopes: [...new Set(items[0].parsed.games.map(game => game.boardDate))]
        .map(boardDate => ({ boardDate, periodsCovered: ['FT'] })) }] }),
    testScan: { candidates: [candidate], sections: [], emptyCaptures: [], silentTabIds: [] },
    fetch: async (url, options) => {
      const input = JSON.parse(options.body); uploads.push({ url, input });
      return { ok: true, status: 200, text: async () => JSON.stringify(await respond(input)) };
    } });
  vm.runInContext(source, worker);
  vm.runInContext('collectCandidates = async () => testScan', worker);
  return { state, uploads, worker, candidate, run: reason => vm.runInContext(`performSync('${reason}')`, worker) };
}
function confirm(data, payload) {
  const { worker } = harness(payload);
  Object.assign(worker, { receiptInput: data, receiptPayload: payload, receiptHash: digest(payload) });
  return plain(vm.runInContext('confirmedReaderSaveReceipt(receiptInput, receiptPayload, receiptHash)', worker));
}
for (const league of leagues) {
  const payload = board(league), valid = readerSaveReceiptFixture(payload, { password: poison });
  const receipt = confirm(valid, payload);
  assert.equal(receipt.status, 'CONFIRMED'); assert.equal(receipt.league, league);
  assert.equal(receipt.boardDate, payload.boardDate); assert.equal(receipt.payloadHash, digest(payload));
  assert.equal(JSON.stringify(receipt).includes(poison), false, 'save receipts retain only allowlisted evidence');
  for (const changed of [{ ok: true }, { ...valid, league: league === 'NBA' ? 'MLB' : 'NBA' },
    { ...valid, boardDate: '2026-10-28' }, { ...valid, durable: false }, { ...valid, persisted: false }]) {
    assert.throws(() => confirm(changed, payload), error => error.code === 'INVALID_RESPONSE');
  }
  if (['MLB', 'NPB', 'KBO', 'CPBL', 'NBA'].includes(league)) {
    for (const changed of [
      { ...valid, allRequiredWritesSucceeded: false }, { ...valid, historyTracking: undefined },
      ...[{ configured: false }, { checked: '1' }, { inserted: -1 }, { failed: 1 }, { unchanged: 1 }]
        .map(fields => ({ ...valid, historyTracking: { ...valid.historyTracking, ...fields } })),
    ]) assert.throws(() => confirm(changed, payload), error => error.code === 'INVALID_RESPONSE');
    assert.equal(confirm({ ...valid, historyTracking: { configured: true, checked: 0, inserted: 0, unchanged: 0, failed: 0 } }, payload)
      .historyTracking.checked, 0, 'an acknowledged locked-only capture is not invented as a saved quote');
  } else {
    for (const fields of [{ revision: 'broken' }, { observedAt: '2026-10-26T23:59:59.000Z' },
      ...(league === 'NHL' ? [] : [{ observationId: 'b'.repeat(64) }, { receivedAt: null }, { firstFetchedAt: null }, { timeEvidence: 'UNKNOWN' }]),
    ]) assert.throws(() => confirm({ ...valid, ...fields }, payload), error => error.code === 'INVALID_RESPONSE');
  }
  // An HTTP 200/ok:true lacking a persistence receipt is a failed sync. The
  // next alarm must re-upload it instead of throttling it as a success.
  let complete = false;
  const flow = harness(board(league), input => complete ? readerSaveReceiptFixture(input, { password: poison }) : { ok: true });
  assert.equal((await flow.run('manual')).ok, false, league);
  assert.deepEqual(flow.state.lastSuccessfulPayloadHashes, {}); assert.deepEqual(flow.state.lastSuccessfulSyncAts, {});
  assert.equal(flow.state.readerStatuses[league].dateErrors[0].diagnosticCode, 'INVALID_RESPONSE');
  complete = true; flow.uploads.length = 0;
  assert.equal((await flow.run('alarm')).ok, true, league); assert.equal(flow.uploads.length, 1);
  assert.equal(flow.state.readerStatuses[league].dateStatuses[0].saveReceipt.status, 'CONFIRMED');
  assert.equal(JSON.stringify(flow.state.readerStatuses[league].dateStatuses).includes(poison), false);
  flow.uploads.length = 0; await flow.run('alarm'); assert.equal(flow.uploads.length, 0, 'confirmed same-state receipt preserves heartbeat throttle');
  delete flow.state.readerStatuses[league].dateStatuses[0].saveReceipt;
  await flow.run('alarm'); assert.equal(flow.uploads.length, 1, 'legacy success markers require a persistence revalidation');
}

const nba = board('NBA'), nbaResponse = readerSaveReceiptFixture(nba);
const captureReceipt = { configured: true, persisted: true, receiptId: 'c'.repeat(64),
  sourceObservedAt: at, pageActivityAt: at, receivedAt: at, persistedAt: at,
  gameCount: 1, coverageComplete: false, closingLineVerified: false, password: poison };
const withCapture = confirm({ ...nbaResponse, historyTracking: { ...nbaResponse.historyTracking, captureReceipt } }, nba);
assert.equal(withCapture.historyTracking.captureReceipt.receiptId, captureReceipt.receiptId);
assert.equal(JSON.stringify(withCapture).includes(poison), false);
assert.equal(withCapture.historyTracking.captureReceipt.closingLineVerified, false);
const invalidOptional = confirm({ ...nbaResponse, historyTracking: { ...nbaResponse.historyTracking,
  captureReceipt: { ...captureReceipt, receiptId: poison } } }, nba);
assert.equal(Object.hasOwn(invalidOptional.historyTracking, 'captureReceipt'), false);

let tomorrowSaved = false;
const partial = harness(board('NBA', ['2026-10-27', '2026-10-28']), input =>
  input.boardDate === '2026-10-28' && !tomorrowSaved ? { ok: true } : readerSaveReceiptFixture(input));
await partial.run('manual');
assert.equal(partial.state.readerStatuses.NBA.ok, false); assert.equal(partial.state.readerStatuses.NBA.dateStatuses.length, 1);
assert.deepEqual(Object.keys(partial.state.lastSuccessfulSyncAts), ['NBA:2026-10-27']);
tomorrowSaved = true; partial.uploads.length = 0; await partial.run('alarm');
assert.deepEqual(partial.uploads.map(row => row.input.boardDate), ['2026-10-28'], 'retry only the unconfirmed date');
assert.equal(partial.state.readerStatuses.NBA.ok, true); assert.equal(partial.state.readerStatuses.NBA.dateStatuses.length, 2);
const oldHashes = structuredClone(partial.state.lastSuccessfulPayloadHashes), oldTimes = structuredClone(partial.state.lastSuccessfulSyncAts);
partial.candidate.parsed.games[1].fullTotal.line = '4平'; tomorrowSaved = false;
await partial.run('alarm');
assert.equal(partial.state.readerStatuses.NBA.ok, false);
assert.deepEqual(partial.state.lastSuccessfulPayloadHashes, oldHashes, 'a failed new-price receipt preserves earlier success hashes');
assert.deepEqual(partial.state.lastSuccessfulSyncAts, oldTimes, 'a failed receipt never refreshes success times');
console.log('PASS actual Reader worker: eight-league durable receipt contracts, strict counts and identity/time binding, sanitized capture evidence, failed/missing-ack retries, legacy revalidation and isolated date/price heartbeat markers; Production NOT VERIFIED');
