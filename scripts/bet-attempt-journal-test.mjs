import assert from 'node:assert/strict';
import { betPositionIdentity } from '../lib/bet-ledger.js';
import { createBetRecordQueue } from '../lib/bet-record-queue.js';
import { BET_ATTEMPT_JOURNAL_KEY, MAX_BET_ATTEMPTS, loadBetAttemptJournal, saveBetAttemptJournal } from '../lib/bet-attempt-journal.js';

function memoryStorage() {
  const values = new Map();
  let writes = 0;
  return { values, get writes() { return writes; },
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes += 1; values.set(key, value); },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const candidate = { id: 'client-attempt', league: 'KBO', date: '2026-09-27', gamePk: 900001,
  market: '全場大小', pick: '大8平', water: 0.95, stake: 100, pitSnapshotId: 'must-not-persist',
  readerPayloadHash: 'must-not-persist', placedAt: '2026-09-27T12:00:00.000Z' };
const keyFor = value => betPositionIdentity(value.date, value.gamePk, value, value.league);
const key = keyFor(candidate);
const durable = { ...candidate, id: 'server-record', status: 'OPEN',
  readerEvidenceStatus: 'SERVER_VERIFIED_CAPTURED_READER', pitEvidenceVerified: true,
  pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED' };
const ledger = { ok: true, bets: [durable] };

// Store synchronously before a network outcome, then reload the exact entry.
const storage = memoryStorage();
let current;
let release;
let networkWrites = 0;
const queue = createBetRecordQueue(entries => {
  current = entries;
  assert.equal(saveBetAttemptJournal(entries, storage).ok, true);
});
queue.enqueue(key, 'KBO 大分', async () => { networkWrites += 1; await new Promise(resolve => { release = resolve; }); return { status: 'confirmed', betId: durable.id }; }, candidate);
assert.equal(networkWrites, 1);
assert.equal(loadBetAttemptJournal(storage).entries[0].status, 'saving');
assert.equal(current[0].candidate.pitSnapshotId, undefined);
assert.equal(current[0].candidate.readerPayloadHash, undefined);
assert.equal(current[0].candidate.id, candidate.id);
const beforeLoadWrites = storage.writes;
const loaded = loadBetAttemptJournal(storage);
assert.equal(storage.writes, beforeLoadWrites, 'load is read-only');
let restoredEntries;
const restored = createBetRecordQueue(entries => { restoredEntries = entries; });
assert.equal(restored.restore(loaded.entries).ok, true);
assert.equal(restored.running, false);
assert.equal(networkWrites, 1, 'restore cannot replay a network writer');
assert.equal(restoredEntries[0].status, 'uncertain');
assert.equal(restored.enqueue(key, 'blind retry', () => assert.fail('duplicate write'), candidate), false);
assert.equal(restored.confirm(key), false);
assert.equal(restored.confirm(key, { ok: true, bets: [{ ...durable, league: 'MLB' }] }), false);
assert.equal(restored.confirm(key, { ok: true, bets: [{ ...durable, stake: 200 }] }), false);
assert.equal(restored.confirm(key, { ok: true, bets: [{ ...durable, pitEvidenceVerified: false }] }), false);
assert.equal(restored.confirm(key, ledger), true, 'only exact durable ledger readback confirms');
assert.equal(restoredEntries[0].confirmedBetId, durable.id);
assert.equal(restored.restore(loaded.entries).ok, false, 'restore cannot replace a live queue');
release();
while (queue.running) await tick();
assert.equal(current[0].confirmedBetId, durable.id);

// A local success flag is downgraded after reload and must be independently read.
let confirmedReload;
const confirmedQueue = createBetRecordQueue(entries => { confirmedReload = entries; });
confirmedQueue.restore(loadBetAttemptJournal(storage).entries);
assert.equal(confirmedReload[0].status, 'uncertain');
assert.equal(confirmedQueue.confirm(key, { ok: true, bets: [] }), false);

// Cancel only the exact durable record, including price/stake and evidence.
const originalSerialized = JSON.stringify(loadBetAttemptJournal(storage).entries);
for (const change of [{ id: 'older-cancelled' }, { water: 0.8 }, { stake: 200 }, { league: 'MLB' }, { pitEvidenceVerified: false }]) {
  assert.equal(confirmedQueue.reconcile({ ok: true, bets: [{ ...durable, status: 'CANCELLED', ...change }] }), false);
}
const cancelledLedger = { ok: true, bets: [{ ...durable, status: 'CANCELLED' }] };
assert.equal(confirmedQueue.reconcile(cancelledLedger), true);
assert.equal(confirmedReload[0].status, 'failed');
assert.match(confirmedReload[0].message, /確認取消/);
assert.equal(JSON.stringify(loadBetAttemptJournal(storage).entries), originalSerialized, 'reconciliation does not mutate saved records or ledger');
assert.equal(cancelledLedger.bets[0].status, 'CANCELLED');
assert.equal(confirmedQueue.reconcile(cancelledLedger), false, 'unchanged reconciliation cannot publish loops');
assert.equal(restored.reconcile(cancelledLedger), true, 'a currently confirmed queue also follows exact cancellation');
assert.equal(restoredEntries[0].status, 'failed');

// Queued writes were never dispatched; failed and uncertain reasons survive.
for (const [savedStatus, expectedStatus] of [['queued', 'failed'], ['failed', 'failed'], ['uncertain', 'uncertain'], ['saving', 'uncertain'], ['confirmed', 'uncertain']]) {
  let output;
  const q = createBetRecordQueue(entries => { output = entries; });
  q.restore([{ ...loaded.entries[0], status: savedStatus, message: 'original failure', requiresRecheck: true, rejectedPitSnapshotId: 'pit-old' }]);
  assert.equal(output[0].status, expectedStatus);
  assert.equal(output[0].requiresRecheck, true);
  assert.equal(output[0].rejectedPitSnapshotId, 'pit-old');
  assert.equal(q.running, false);
  if (savedStatus === 'failed' || savedStatus === 'uncertain') assert.equal(output[0].message, 'original failure');
}

// Same numeric game ID and market remain isolated across leagues.
const mlbCandidate = { ...candidate, league: 'MLB' };
const mlbKey = keyFor(mlbCandidate);
const separate = createBetRecordQueue(() => {});
assert.equal(separate.restore([{ ...loaded.entries[0], key: mlbKey, candidate: mlbCandidate }]).ok, true);
assert.equal(separate.confirm(mlbKey, ledger), false);
assert.equal(createBetRecordQueue().restore([{ ...loaded.entries[0], key: mlbKey }]).ok, false);

// Corrupt records cannot assert success, inject runners, or destroy good data.
const valid = loadBetAttemptJournal(storage).entries[0];
for (const change of [{ candidate: { ...candidate, stake: -1 } }, { candidate: { ...candidate, water: 999 } },
  { candidate: { ...candidate, gamePk: Number.MAX_SAFE_INTEGER + 1 } }, { candidate: { ...candidate, date: '2026-02-31' } },
  { status: 'bogus' }, { updatedAt: 0 }, { key: `${key}wrong` }]) {
  const old = storage.getItem(BET_ATTEMPT_JOURNAL_KEY);
  assert.equal(saveBetAttemptJournal([{ ...valid, ...change }], storage).ok, false);
  assert.equal(storage.getItem(BET_ATTEMPT_JOURNAL_KEY), old);
}
storage.values.set(BET_ATTEMPT_JOURNAL_KEY, '{bad json');
assert.equal(loadBetAttemptJournal(storage).ok, false);
assert.equal(storage.getItem(BET_ATTEMPT_JOURNAL_KEY), '{bad json');
storage.values.set(BET_ATTEMPT_JOURNAL_KEY, JSON.stringify({ version: 1, entries: [valid, { key: 'bad' }] }));
const partial = loadBetAttemptJournal(storage);
assert.equal(partial.ok, false);
assert.equal(partial.entries.length, 1, 'valid attempts remain available with an explicit corruption warning');
assert.equal(loadBetAttemptJournal({ getItem() { throw new Error('denied'); } }).ok, false);
assert.equal(saveBetAttemptJournal([valid], { setItem() { throw new Error('quota'); } }).ok, false);

const many = Array.from({ length: MAX_BET_ATTEMPTS + 1 }, (_, index) => {
  const candidateValue = { ...candidate, gamePk: 1000 + index };
  return { ...valid, key: keyFor(candidateValue), candidate: candidateValue, status: 'uncertain', createdAt: 1000 + index, updatedAt: 1000 + index };
});
const fullStorage = memoryStorage();
assert.equal(saveBetAttemptJournal(many, fullStorage).code, 'BET_ATTEMPT_JOURNAL_FULL');
assert.equal(fullStorage.writes, 0, 'capacity cannot silently discard unresolved attempts');
assert.equal(saveBetAttemptJournal([{ ...many[0], status: 'confirmed' }, ...many.slice(1)], fullStorage).ok, true);
assert.equal(loadBetAttemptJournal(fullStorage).entries.length, MAX_BET_ATTEMPTS);
assert.equal(loadBetAttemptJournal(fullStorage).entries.some(entry => entry.key === many[0].key), false, 'only a confirmed oldest entry may be pruned');
const fullQueue = createBetRecordQueue();
assert.equal(fullQueue.restore(many.slice(0, MAX_BET_ATTEMPTS)).ok, true);
assert.equal(fullQueue.enqueue(many[MAX_BET_ATTEMPTS].key, 'overflow', () => assert.fail('must not submit'), many[MAX_BET_ATTEMPTS].candidate), false);
assert.equal(fullQueue.lastError.code, 'BET_ATTEMPT_JOURNAL_FULL');

console.log('Bet attempt journal: synchronous capture, safe reload, no replay, durable readback, cancellation, isolation, corruption and capacity PASS');
