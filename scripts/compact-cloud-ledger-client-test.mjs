import assert from 'node:assert/strict';
import { loadCompactCloudLedger, mergeKnownLedgerRecords } from '../lib/compact-cloud-ledger-client.js';

const calls = [];
const pages = [
  { ok: true, bets: [{ id: 'one', status: 'OPEN' }], pagination: { totalRecords: 2, returnedRecords: 1, invalidRecordsOnPage: 0, hasMore: true, nextCursor: 'cursor/one' } },
  { ok: true, bets: [{ id: 'two', status: 'CANCELLED' }], pagination: { totalRecords: 2, returnedRecords: 1, invalidRecordsOnPage: 0, hasMore: false, nextCursor: null } },
];
const result = await loadCompactCloudLedger(async (url, options, timeout) => {
  calls.push({ url, options, timeout });
  return pages.shift();
});
assert.deepEqual(result.bets.map(row => row.id), ['one', 'two']);
assert.equal(result.pagination.pages, 2);
assert.equal(result.statsScope, 'COMPLETE_COMPACT_READ');
assert.equal(result.stats, null, 'server does not calculate expensive all-history stats on compact pages');
assert.match(calls[1].url, /cursor=cursor%2Fone/);
assert.deepEqual(calls[0].options, {}, 'read-only fetch must not send mutations');
assert.equal(calls[0].timeout, 15000);
const empty = await loadCompactCloudLedger(async () => ({ ok: true, bets: [], pagination: { totalRecords: 0, returnedRecords: 0, invalidRecordsOnPage: 0, hasMore: false } }));
assert.deepEqual(empty.bets, []);
await assert.rejects(loadCompactCloudLedger(async () => ({ ok: true, bets: [] })), { code: 'LEDGER_RESPONSE_INVALID' });
await assert.rejects(loadCompactCloudLedger(async () => ({ ok: true, bets: [{ id: 'one' }], pagination: { totalRecords: 10, returnedRecords: 1, invalidRecordsOnPage: 0, hasMore: true, nextCursor: 'repeat' } })), { code: 'LEDGER_RESPONSE_INVALID' });
await assert.rejects(loadCompactCloudLedger(async () => ({ ok: true, bets: [{ id: 'one' }], pagination: { totalRecords: 10, returnedRecords: 1, invalidRecordsOnPage: 0, hasMore: false } })), { code: 'LEDGER_RESPONSE_INVALID' }, 'a terminal page is not proof of complete counts');
let request = 0;
await assert.rejects(loadCompactCloudLedger(async () => {
  request += 1;
  if (request === 2) throw new Error('later page failed');
  return { ok: true, bets: [{ id: 'one' }], pagination: { totalRecords: 2, returnedRecords: 1, invalidRecordsOnPage: 0, hasMore: true, nextCursor: 'next' } };
}), /later page failed/, 'no partial success if a later read fails');
let stamp = 0;
await assert.rejects(loadCompactCloudLedger(async () => { throw new Error('must not fetch'); }, { now: () => { stamp += 10; return stamp; }, budgetMs: 5 }), { code: 'REQUEST_TIMEOUT' });
console.log('PASS compact ledger reads complete pagination without mutations or partial success');

const terminalPage = { ok: true, bets: [{ id: 'last' }], pagination: {
  totalRecords: 1, returnedRecords: 1, invalidRecordsOnPage: 0, hasMore: false,
} };
const fakeClock = (budgetMs = 60000) => {
  let time = 0;
  const waits = [];
  return { waits, options: { now: () => time, budgetMs, wait: async ms => { waits.push(ms); time += ms; } },
    advance: ms => { time += ms; } };
};
const retryClock = fakeClock();
const retriedUrls = [];
const secondPageFailure = new TypeError('Load failed');
const recovered = await loadCompactCloudLedger(async (url, init) => {
  retriedUrls.push(url);
  assert.deepEqual(init, {}, 'retry remains a read-only request');
  if (retriedUrls.length === 1) return { ...terminalPage, bets: [{ id: 'first' }], pagination: {
    ...terminalPage.pagination, totalRecords: 2, hasMore: true, nextCursor: 'same/cursor',
  } };
  if (retriedUrls.length === 2) throw secondPageFailure;
  return { ...terminalPage, pagination: { ...terminalPage.pagination, totalRecords: 2 } };
}, retryClock.options);
assert.deepEqual(recovered.bets.map(row => row.id), ['first', 'last']);
assert.equal(recovered.pagination.pages, 2, 'failed requests must not count as loaded pages');
assert.equal(retriedUrls[1], retriedUrls[2], 'retry keeps the same page cursor without replaying completed pages');
assert.deepEqual(retryClock.waits, [250]);

for (const message of ['Failed to fetch', 'Failed fetch', 'NetworkError when attempting to fetch resource.', 'Network request failed']) {
  let attempts = 0;
  const clock = fakeClock();
  assert.deepEqual((await loadCompactCloudLedger(async () => {
    if (++attempts === 1) throw new TypeError(message);
    return terminalPage;
  }, clock.options)).bets, terminalPage.bets);
  assert.equal(attempts, 2, `${message} receives a bounded transport retry`);
}
let permanentAttempts = 0;
let namedNetworkAttempts = 0;
await loadCompactCloudLedger(async () => {
  if (++namedNetworkAttempts === 1) throw Object.assign(new Error('A network error occurred'), { name: 'NetworkError' });
  return terminalPage;
}, fakeClock().options);
assert.equal(namedNetworkAttempts, 2, 'a native NetworkError is retryable even without a browser-specific message');
const permanentClock = fakeClock();
const permanentFailure = new TypeError('Load failed');
await assert.rejects(loadCompactCloudLedger(async () => { permanentAttempts += 1; throw permanentFailure; }, permanentClock.options),
  error => error === permanentFailure, 'exhausted retries preserve the original transport error');
assert.equal(permanentAttempts, 3, 'a permanent network failure receives at most two additional attempts');
assert.deepEqual(permanentClock.waits, [250, 1000]);

for (const failure of [
  Object.assign(new TypeError('Load failed'), { status: 401 }),
  Object.assign(new TypeError('Load failed'), { status: 403 }),
  Object.assign(new TypeError('Load failed'), { status: 429, retryAfterMs: 1000 }),
  Object.assign(new TypeError('Load failed'), { code: 'DATABASE_TRANSFER_QUOTA_EXCEEDED', retryAfterMs: 21600000 }),
  Object.assign(new TypeError('Load failed'), { databaseOperation: true }),
  Object.assign(new TypeError('Load failed'), { code: 'INVALID_JSON' }),
  Object.assign(new TypeError('Load failed'), { code: 'LEDGER_RESPONSE_INVALID' }),
]) {
  let attempts = 0;
  const clock = fakeClock();
  await assert.rejects(loadCompactCloudLedger(async () => { attempts += 1; throw failure; }, clock.options), error => error === failure);
  assert.equal(attempts, 1, 'authentication, database and validation failures must not enter transport retries');
  assert.deepEqual(clock.waits, []);
}
let malformedAttempts = 0;
await assert.rejects(loadCompactCloudLedger(async () => { malformedAttempts += 1; return { ok: true, bets: [] }; }, fakeClock().options),
  { code: 'LEDGER_RESPONSE_INVALID' });
assert.equal(malformedAttempts, 1, 'a malformed successful page must never be retried as a network outage');

const retryAfterClock = fakeClock(10000);
const retryTimeouts = [];
const timedOut = Object.assign(new Error('request timed out'), { code: 'REQUEST_TIMEOUT', retryAfterMs: 2000 });
await loadCompactCloudLedger(async (url, init, timeout) => {
  retryTimeouts.push(timeout);
  if (retryTimeouts.length === 1) throw timedOut;
  return terminalPage;
}, retryAfterClock.options);
assert.deepEqual(retryAfterClock.waits, [2000], 'Retry-After must override the shorter default delay');
assert.deepEqual(retryTimeouts, [10000, 8000], 'the request deadline shrinks within one overall read budget');
const delayedBeyondBudget = Object.assign(new TypeError('Failed to fetch'), { retryAfterMs: 10000 });
const shortClock = fakeClock(5000);
let beyondBudgetAttempts = 0;
await assert.rejects(loadCompactCloudLedger(async () => { beyondBudgetAttempts += 1; throw delayedBeyondBudget; }, shortClock.options),
  error => error === delayedBeyondBudget);
assert.equal(beyondBudgetAttempts, 1, 'a Retry-After outside the read budget must not cause an immediate retry');
assert.deepEqual(shortClock.waits, []);
const expiredClock = fakeClock(1000);
let expiredAttempts = 0;
await assert.rejects(loadCompactCloudLedger(async () => { expiredAttempts += 1; throw permanentFailure; }, {
  ...expiredClock.options, wait: async () => expiredClock.advance(1000),
}), { code: 'REQUEST_TIMEOUT' });
assert.equal(expiredAttempts, 1, 'a delayed retry cannot make another request after the overall deadline');
console.log('PASS bounded read-only transport retries retain cursors, completeness, failure contracts and the overall deadline');

const history = Array.from({ length: 5001 }, (_, index) => ({ id: `history-${index}`, status: 'OPEN', placedAt: '2026-09-01T00:00:00Z' }));
const known = mergeKnownLedgerRecords(history, [{ ...history[0], status: 'CANCELLED' }, { id: 'new', status: 'OPEN', placedAt: '2026-10-01T00:00:00Z' }]);
assert.equal(known.length, 5002, 'bounded updates must not truncate older historical records');
assert.equal(known.find(row => row.id === history[0].id).status, 'CANCELLED');
assert.equal(known[0].id, 'new');
assert.equal(history[0].status, 'OPEN', 'stored original must not be mutated');
console.log('PASS bounded readback preserves more than 5000 known historical records');
