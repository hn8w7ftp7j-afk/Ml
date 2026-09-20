import assert from 'node:assert/strict';
import { createBetRecordQueue } from '../lib/bet-record-queue.js';
import { evaluateBetAction } from '../lib/bet-action-state-v118.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
let release;
const gate = new Promise(resolve => { release = resolve; });
let latest;
const calls = [];
let inFlight = 0;
const queue = createBetRecordQueue(entries => { latest = entries; });
const work = (name, result, wait = Promise.resolve()) => async () => {
  assert.equal(++inFlight, 1, 'one writer at a time');
  calls.push(name);
  await wait;
  --inFlight;
  return result;
};
assert.equal(queue.enqueue('a', 'A', work('a', { status: 'confirmed' }, gate)), true);
assert.equal(queue.enqueue('b', 'B', work('b', { status: 'failed', message: 'Rejected' })), true);
assert.equal(queue.enqueue('c', 'C', work('c', { status: 'confirmed' })), true);
assert.equal(queue.enqueue('a', 'A duplicate', () => assert.fail('duplicate')), false);
assert.deepEqual(calls, ['a']);
assert.deepEqual(latest.map(entry => entry.status), ['saving', 'queued', 'queued']);
release();
while (queue.running) await tick();
assert.deepEqual(calls, ['a', 'b', 'c']);
assert.deepEqual(latest.map(entry => entry.status), ['confirmed', 'failed', 'confirmed']);
queue.enqueue('b', 'B retry', work('b retry', { status: 'confirmed' }));
while (queue.running) await tick();
assert.equal(latest.find(entry => entry.key === 'b').status, 'confirmed');
queue.enqueue('d', 'D unknown', async () => { throw new Error('connection lost'); });
queue.enqueue('e', 'E', work('e', { status: 'confirmed' }));
while (queue.running) await tick();
assert.equal(latest.find(entry => entry.key === 'd').status, 'uncertain');
assert.equal(queue.enqueue('d', 'D retry', () => assert.fail('blind retry')), false);
assert.equal(latest.find(entry => entry.key === 'e').status, 'confirmed');
for (const status of ['queued', 'saving', 'uncertain']) {
  const action = evaluateBetAction({ queued: { status } });
  assert.equal(action.disabled, true);
  assert.equal(action.recordable, false);
  assert.doesNotMatch(action.text, /已下注|已記錄/);
}
console.log('bet record queue: FIFO, independent failure, duplicates and uncertain outcomes PASS');
