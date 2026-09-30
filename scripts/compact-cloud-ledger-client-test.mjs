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

const history = Array.from({ length: 5001 }, (_, index) => ({ id: `history-${index}`, status: 'OPEN', placedAt: '2026-09-01T00:00:00Z' }));
const known = mergeKnownLedgerRecords(history, [{ ...history[0], status: 'CANCELLED' }, { id: 'new', status: 'OPEN', placedAt: '2026-10-01T00:00:00Z' }]);
assert.equal(known.length, 5002, 'bounded updates must not truncate older historical records');
assert.equal(known.find(row => row.id === history[0].id).status, 'CANCELLED');
assert.equal(known[0].id, 'new');
assert.equal(history[0].status, 'OPEN', 'stored original must not be mutated');
console.log('PASS bounded readback preserves more than 5000 known historical records');
