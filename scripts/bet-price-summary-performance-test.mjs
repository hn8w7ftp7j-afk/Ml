import assert from 'node:assert/strict';
import { compareBetPrice, createBetPriceComparisonCache } from '../lib/bet-price-comparison.js';
import { summarizeOriginalBetPrices, summarizeOriginalBetPricesAsync } from '../lib/bet-price-summary.js';

const base = {
  bet: { id: 'base', league: 'MLB', market: '全場大小', pick: '小8+50', water: 0.94,
    away: '客隊', home: '主隊', rebateRate: 0.015 },
  row: { market: '全場大小', pick: '小8+60', water: 0.94 },
  game: { away: '客隊', home: '主隊' }, rebateRate: 0.015,
};
let computations = 0;
const cached = createBetPriceComparisonCache({ compare: options => { computations += 1; return compareBetPrice(options); } });
const expected = compareBetPrice(base);
const first = cached(base);
assert.deepEqual(first, expected);
first.combinedStatus = 'corrupted';
first.keyDifference.delta = 999;
assert.deepEqual(cached(structuredClone(base)), expected, 'caller mutation cannot contaminate a cached comparison');
assert.equal(computations, 1);
for (const changed of [
  { ...base, bet: { ...base.bet, market: '上半大小' } },
  { ...base, bet: { ...base.bet, pick: '小8+40' } },
  { ...base, row: { ...base.row, pick: '小8+70' } },
  { ...base, bet: { ...base.bet, water: 0.93 } },
  { ...base, row: { ...base.row, water: 0.95 } },
  { ...base, bet: { ...base.bet, away: '新客隊' } },
  { ...base, bet: { ...base.bet, home: '新主隊' } },
  { ...base, bet: { ...base.bet, rebateRate: 0.02 } },
]) {
  const before = computations;
  assert.deepEqual(cached(changed), compareBetPrice(changed));
  assert.equal(computations, before + 1, 'each effective payoff input must be part of the cache key');
  cached(structuredClone(changed));
  assert.equal(computations, before + 1);
}
const fallback = { ...base, bet: { ...base.bet, away: undefined, home: undefined, rebateRate: undefined } };
cached(fallback);
for (const changed of [
  { ...fallback, game: { ...fallback.game, away: '備援客隊' } },
  { ...fallback, game: { ...fallback.game, home: '備援主隊' } },
  { ...fallback, rebateRate: 0.025 },
]) {
  const before = computations;
  assert.deepEqual(cached(changed), compareBetPrice(changed));
  assert.equal(computations, before + 1, 'fallback game names and explicit rebate options must not collide');
}
let boundedComputations = 0;
const bounded = createBetPriceComparisonCache({ maxEntries: 2,
  compare: options => { boundedComputations += 1; return compareBetPrice(options); } });
const second = { ...base, row: { ...base.row, pick: '小8+70' } };
const third = { ...base, row: { ...base.row, pick: '小8+80' } };
bounded(base); bounded(second); bounded(base); bounded(third); bounded(base); bounded(second);
assert.equal(boundedComputations, 4, 'bounded LRU preserves a touched entry and recomputes an evicted contract');

const start = '2026-08-20T10:00:00.000Z';
const bets = Array.from({ length: 7 }, (_, i) => ({ ...base.bet, id: `summary-${i}`,
  gameDate: start, status: 'SETTLED',
  closingContractSnapshot: { ...base.row, verified: true, provider: 'TAI888_READER_AUTO',
    sourceType: 'ACTUAL_TW_CREDIT', lineAsOf: '2026-08-20T09:59:00.000Z' },
}));
const after = Date.parse(start), before = after - 1;
assert.deepEqual(await summarizeOriginalBetPricesAsync(bets, {}, { now: before, yieldControl: async () => {} }),
  { total: 0, better: 0, worse: 0 }, 'a warmed payoff cache cannot make a future closing contract authoritative before game start');
const complete = await summarizeOriginalBetPricesAsync(bets, {}, { now: after, yieldControl: async () => {} });
assert.deepEqual(complete, summarizeOriginalBetPrices(bets, {}, { now: after }));
assert.deepEqual(complete, { total: 7, better: 7, worse: 0 });
assert.deepEqual(await summarizeOriginalBetPricesAsync(bets.map(bet => ({ ...bet,
  closingContractSnapshot: { ...bet.closingContractSnapshot, verified: false } })), {}, { now: after, yieldControl: async () => {} }),
  { total: 0, better: 0, worse: 0 }, 'cache hits must never bypass changed closing verification');
assert.deepEqual(await summarizeOriginalBetPricesAsync(bets.map(bet => ({ ...bet,
  closingContractSnapshot: { ...bet.closingContractSnapshot, lineAsOf: '2026-08-20T10:01:00.000Z' } })), {}, { now: after, yieldControl: async () => {} }),
  { total: 0, better: 0, worse: 0 }, 'post-start closing observations remain ineligible');
const currentFeed = Object.fromEntries(bets.map(bet => [bet.id, { current: { ...base.row, pick: '小8+40' } }]));
assert.deepEqual(await summarizeOriginalBetPricesAsync(bets, currentFeed, { now: before, yieldControl: async () => {} }),
  { total: 7, better: 0, worse: 7 }, 'before start, current feed authority and changed prices are evaluated independently');

let cancelled = false, compared = 0, published = false;
const yields = [];
const pending = summarizeOriginalBetPricesAsync(bets, {}, {
  now: after, cancelled: () => cancelled,
  compare: options => { compared += 1; return compareBetPrice(options); },
  yieldControl: () => new Promise(resolve => yields.push(resolve)),
}).then(value => { published = true; return value; });
assert.equal(compared, 0, 'cold comparisons cannot execute synchronously while React schedules the summary');
assert.equal(published, false);
yields.shift()();
await new Promise(setImmediate);
assert.equal(compared, 2, 'only two comparisons execute before yielding browser control');
assert.equal(published, false, 'partial financial counts cannot publish as a completed summary');
cancelled = true;
yields.shift()();
assert.equal(await pending, null);
assert.equal(compared, 2, 'a changed scope stops remaining computations instead of publishing old totals');

let repeatComputations = 0;
const repeated = createBetPriceComparisonCache({ compare: options => { repeatComputations += 1; return compareBetPrice(options); } });
const history = Array.from({ length: 739 }, (_, i) => ({ ...bets[0], id: `history-${i}` }));
const unchanged = JSON.stringify(history);
assert.deepEqual(await summarizeOriginalBetPricesAsync(history, {}, { now: after,
  yieldControl: async () => {}, compare: repeated }), { total: 739, better: 739, worse: 0 });
assert.equal(repeatComputations, 1, '739 identical immutable contracts require one payoff computation');
assert.equal(JSON.stringify(history), unchanged);
console.log('Original-price summary: bounded complete-input cache, mutation isolation, fresh authority, yielded cold work and cancelled scope PASS');
