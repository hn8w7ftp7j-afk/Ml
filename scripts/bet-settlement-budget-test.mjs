import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settleBetTickets } from '../lib/bet-settlement-service.js';
import { listCloudBetSettlementCandidates, persistBetUpdates } from '../lib/cloud-bet-store.js';

const ticket = (id, gamePk = Number(id.replace(/\D/g, '')) || 1) => ({
  id, gamePk, league: 'MLB', officialDate: '2026-09-01', date: '2026-09-02',
  placedAt: '2026-09-01T12:00:00.000Z', market: '全場大小', pick: '小6平',
  away: '客隊', home: '主隊', water: 0.95, stake: 10_000, status: 'OPEN',
  analysisSnapshot: { immutable: true }, closingContractSnapshot: { revision: 'placed' },
  readerEvidenceStatus: 'SERVER_VERIFIED_CAPTURED_READER',
  pitEvidenceVerified: true, pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED',
});
const officialFinal = {
  final: true, statusEnglish: 'Final', awayRuns: 3, homeRuns: 2,
  first5Complete: true, awayFirst5: 2, homeFirst5: 1,
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// One stalled official provider must not hold another game's verified results
// only in memory until the entire run has finished.
const slow = deferred();
const fastPersisted = deferred();
const writes = [];
const starts = [];
const parallel = settleBetTickets([ticket('fast1', 1), ticket('fast2', 1), ticket('slow3', 3)], {
  concurrency: 2,
  fetchResult: async bet => {
    starts.push(bet.gamePk);
    if (bet.gamePk === 3) await slow.promise;
    return officialFinal;
  },
  onGroupSettled: async (updates, originals) => {
    writes.push(updates.map(bet => bet.id));
    assert.equal(updates.length, originals.length);
    if (updates[0].gamePk === 1) fastPersisted.resolve();
  },
});
await fastPersisted.promise;
assert.deepEqual(writes, [['fast1', 'fast2']], 'Fast game must be durable while the unrelated provider is still pending');
assert.deepEqual(starts, [1, 3], 'Same-game markets must share a single official request');
slow.resolve();
const parallelResults = await parallel;
assert.deepEqual(parallelResults.map(bet => bet.id), ['fast1', 'fast2', 'slow3']);
assert.ok(parallelResults.every(bet => bet.status === 'SETTLED'));

// The clock includes DB persistence. Never stamp deferred tickets as checked:
// the next least-recently-checked query must be able to select them first.
let clock = 0;
const candidates = [ticket('budget1'), ticket('budget2'), ticket('budget3')];
const originalCandidates = structuredClone(candidates);
const budgetStarts = [];
const budgeted = await settleBetTickets(candidates, {
  concurrency: 1,
  timeBudgetMs: 100,
  now: () => clock,
  fetchResult: async (bet, { timeoutMs }) => {
    budgetStarts.push(bet.id);
    assert.equal(timeoutMs, 90, 'Official request deadline must leave a persistence reserve');
    clock += 70;
    return officialFinal;
  },
  onGroupSettled: async () => { clock += 30; },
});
assert.deepEqual(budgetStarts, ['budget1']);
assert.deepEqual(budgeted.map(bet => bet.id), ['budget1']);
assert.deepEqual(candidates, originalCandidates, 'Deferred and original immutable tickets must remain untouched');
assert.equal((await settleBetTickets(candidates, {
  timeBudgetMs: 0,
  fetchResult: async () => { throw new Error('Expired run must not fetch'); },
})).length, 0);

// Provider failures rotate fairly like live games, but a database failure is a
// request failure, never a fake upstream-score error or a background write.
const failedProvider = await settleBetTickets([ticket('network1')], {
  fetchResult: async () => { throw new Error('official response timeout'); },
});
assert.equal(failedProvider[0].status, 'OPEN');
assert.equal(failedProvider[0].lastResultError, 'official response timeout');
assert.ok(failedProvider[0].lastResultCheckAt);
assert.equal(failedProvider[0].settlement, undefined);
const refreshedLive = await settleBetTickets(failedProvider, {
  fetchResult: async () => ({ final: false, statusEnglish: 'In Progress' }),
});
assert.equal(refreshedLive[0].status, 'OPEN');
assert.equal(refreshedLive[0].lastResultError, null, 'A successful live check must clear a stale upstream failure');

const otherInFlight = deferred();
const writeFailed = deferred();
const failureStarts = [];
const databaseError = new Error('durable database unavailable');
let failureRunFinished = false;
const failureRun = settleBetTickets([ticket('db1'), ticket('db2'), ticket('db3')], {
  concurrency: 2,
  fetchResult: async bet => {
    failureStarts.push(bet.id);
    if (bet.id === 'db2') await otherInFlight.promise;
    return officialFinal;
  },
  onGroupSettled: async updates => {
    if (updates[0].id === 'db1') {
      writeFailed.resolve();
      throw databaseError;
    }
  },
}).then(() => { throw new Error('DB failure must reject'); }, error => {
  failureRunFinished = true;
  assert.equal(error, databaseError);
});
await writeFailed.promise;
await Promise.resolve();
assert.equal(failureRunFinished, false, 'The failed request must drain other in-flight persistence before returning');
otherInFlight.resolve();
await failureRun;
assert.deepEqual(failureStarts, ['db1', 'db2'], 'Do not launch more provider work after a durable-write failure');

// SQL selection reads the candidate set directly, even when the newest display
// window is entirely settled. Parameters keep date/league identity separate.
const oldTicket = ticket('historical-beyond-display-5000', 9);
let selectionCalls = 0;
const selected = await listCloudBetSettlementCandidates({
  league: 'mlb', limit: 12,
  database: async (parts, ...values) => {
    selectionCalls += 1;
    const query = parts.join('?');
    assert.match(query, /WHERE \(\? = '' OR league = \?\)/);
    assert.match(query, /readerEvidenceStatus' IN \('SERVER_VERIFIED_CURRENT_READER', 'SERVER_VERIFIED_CAPTURED_READER'\)/);
    assert.match(query, /pitEvidenceVerified' = 'true'::jsonb/);
    assert.match(query, /pitPredictionStatus' = 'IMMUTABLE_PIT_VERIFIED'/);
    assert.match(query, /status = 'OPEN'[\s\S]*status = 'MANUAL_REVIEW'/);
    assert.match(query, /settlementError' IN \('缺少可驗證的前五局正式賽果', '缺少可驗證的全場正式賽果'\)/);
    assert.match(query, /payload->'settlement' IS NULL[\s\S]*resultSnapshot'->>'final' = 'true'/);
    assert.match(query, /ORDER BY COALESCE\([\s\S]*lastResultCheckAt[\s\S]*checkedAt[\s\S]*\) ASC, placed_at ASC, id ASC/);
    assert.doesNotMatch(query, /placed_at DESC|5000/);
    assert.deepEqual(values, ['MLB', 'MLB', 12]);
    return [{ payload: oldTicket }];
  },
});
assert.equal(selectionCalls, 1);
assert.equal(selected[0].id, oldTicket.id);
const untrustedCandidates = await listCloudBetSettlementCandidates({
  database: async () => [
    { payload: { ...oldTicket, readerEvidenceStatus: 'EXCLUDED_UNVERIFIABLE_LEGACY' } },
    { payload: { ...oldTicket, pitEvidenceVerified: false } },
    { payload: { ...oldTicket, pitPredictionStatus: 'UNVERIFIED' } },
    { payload: { ...oldTicket, status: 'CANCELLED' } },
  ],
});
assert.deepEqual(untrustedCandidates, [], 'Quarantined or cancelled rows must never become settlement candidates');

// Exercise the actual parameterized write and its optimistic status guard.
// SQL only merges settlement fields, so a Reader update made while results
// were fetched is retained, and cancellation/settlement races are skipped.
const originals = [ticket('write1'), ticket('write2'), ticket('write3'), {
  ...ticket('write4'), status: 'MANUAL_REVIEW',
  settlementError: '缺少可驗證的前五局正式賽果', resultSnapshot: { final: true },
}];
const updates = await settleBetTickets(originals, { fetchResult: async () => officialFinal });
const rows = new Map(originals.map(bet => [bet.id, structuredClone(bet)]));
rows.get('write1').closingContractSnapshot = { revision: 'new-reader-close' };
rows.get('write2').status = 'CANCELLED';
rows.get('write3').status = 'SETTLED';
const originalFrozenFields = structuredClone(rows.get('write1'));
const writeResult = await persistBetUpdates(updates, originals, {
  database: async (parts, ...values) => {
    const query = parts.join('?');
    assert.match(query, /payload = payload \|\| \?::jsonb/);
    assert.match(query, /WHERE id = \? AND status = \?/);
    assert.match(query, /pitEvidenceVerified' = 'true'::jsonb/);
    assert.match(query, /settlementError' = \?[\s\S]*payload->'settlement' IS NULL[\s\S]*resultSnapshot'->>'final' = 'true'/);
    assert.match(query, /RETURNING id/);
    const [status, json, id, previousStatus, statusBranch, previousReason] = values;
    assert.equal(statusBranch, previousStatus);
    const patch = JSON.parse(json);
    assert.deepEqual(Object.keys(patch).filter(key => ![
      'status', 'resultSnapshot', 'settlement', 'settlementError', 'lastResultCheckAt', 'lastResultError', 'updatedAt',
    ].includes(key)), [], 'Persistence must not overwrite immutable contract/model or concurrent Reader fields');
    const row = rows.get(id);
    if (row.status !== previousStatus) return [];
    if (previousStatus !== 'OPEN' && (row.settlementError !== previousReason || row.settlement || row.resultSnapshot?.final !== true)) return [];
    rows.set(id, { ...row, ...patch, status });
    return [{ id }];
  },
});
assert.deepEqual(writeResult, { updated: 2, skipped: 2 });
assert.equal(rows.get('write2').status, 'CANCELLED');
assert.equal(rows.get('write3').settlement, undefined, 'A concurrent settlement must not be replaced by this run');
assert.equal(rows.get('write4').status, 'SETTLED', 'A verified score may recover only the exact retryable manual-review state');
for (const key of ['id', 'gamePk', 'league', 'date', 'officialDate', 'placedAt', 'market', 'pick', 'water', 'stake', 'analysisSnapshot', 'closingContractSnapshot']) {
  assert.deepEqual(rows.get('write1')[key], originalFrozenFields[key], `${key} must survive settlement unchanged`);
}
const rerun = await persistBetUpdates(updates, originals, {
  database: async () => [],
});
assert.deepEqual(rerun, { updated: 0, skipped: 4 }, 'Already-settled/cancelled records cannot be counted twice');

const store = fs.readFileSync(new URL('../lib/cloud-bet-store.js', import.meta.url), 'utf8');
const settleFunction = store.slice(store.indexOf('export async function settleOpenCloudBets'));
assert.match(settleFunction, /onGroupSettled:[\s\S]*await persistBetUpdates\(groupUpdates, previous\)/);
assert.match(settleFunction, /deferredTickets: candidates.length - updates.length/);
for (const [path, budget] of [
  ['app/api/bets/route.js', '15_000'],
  ['app/api/cron/bet-settlements/route.js', '240_000'],
]) {
  assert.match(fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
    new RegExp(`settleOpenCloudBets\\(\\{[^}]*timeBudgetMs: ${budget}`));
}

console.log('Bounded settlement, per-game persistence, fair historical candidates, immutable/race-safe writes PASS');
