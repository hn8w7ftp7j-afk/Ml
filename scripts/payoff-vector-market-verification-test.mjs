import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyIndependentMarketVerification,
  MARKET_VERIFICATION_V2_VERSION,
} from '../lib/market-verification-v2.js';

const observedAt = '2026-08-21T00:00:00.000Z';
const books = ['book-a', 'book-b', 'book-c'];
const evidence = (market, pick, probabilities, eventId = 'event-1') => ({
  market,
  pick,
  water: 0.94,
  sourceType: 'INTERNATIONAL',
  provider: 'THE_ODDS_API_CONSENSUS',
  providerEventId: eventId,
  lineAsOf: observedAt,
  referenceEvidenceEligible: true,
  consensusBookCount: books.length,
  consensusBookKeys: books,
  consensusOldestObservedAt: observedAt,
  consensusNewestObservedAt: observedAt,
  consensusTimeSpanMs: 0,
  consensusFreshnessMaxMs: 0,
  referenceProbabilitySpread: Math.max(...probabilities) - Math.min(...probabilities),
  referenceProbabilityMad: 0.001,
  referenceBookProbabilities: books.map((bookmakerKey, index) => ({
    bookmakerKey,
    observedAt,
    probability: probabilities[index],
  })),
});

const actual = pick => ({
  market: '全場大小',
  pick,
  water: 0.94,
  sourceType: 'ACTUAL_TW_CREDIT',
  provider: 'TAI888_READER_AUTO',
  lineAsOf: observedAt,
});

const totalLattice = [
  evidence('全場大小', '大7.5', [0.55, 0.551, 0.549]),
  evidence('全場大小', '小7.5', [0.45, 0.449, 0.451]),
  evidence('全場大小', '大8.5', [0.45, 0.451, 0.449]),
  evidence('全場大小', '小8.5', [0.55, 0.549, 0.551]),
];

const verified = applyIndependentMarketVerification(
  [actual('大8+80'), actual('小8+80')],
  totalLattice,
  undefined,
  Date.parse(observedAt) + 60_000,
);
assert.match(MARKET_VERIFICATION_V2_VERSION, /v2\.4\.0/);
assert.ok(verified.every(row => row.marketVerification.referencePriorEligible));
const over = verified[0].marketVerification.referencePayoffVector;
assert.ok(Math.abs(over.equivalentWin - 0.53) < 1e-12);
assert.ok(Math.abs(over.equivalentLoss - 0.45) < 1e-12);
assert.ok(Math.abs(over.equivalentPush - 0.02) < 1e-12);
assert.ok(Math.abs(over.equivalentWin + over.equivalentLoss + over.equivalentPush - 1) < 1e-12);
const under = verified[1].marketVerification.referencePayoffVector;
assert.ok(Math.abs(under.equivalentWin - 0.45) < 1e-12);
assert.ok(Math.abs(under.equivalentLoss - 0.53) < 1e-12);
assert.ok(Math.abs(under.equivalentPush - 0.02) < 1e-12);

const fourBooks = ['book-a', 'book-b', 'book-c', 'book-d'];
const fourEvidence = (pick, probabilities) => ({
  ...evidence('全場大小', pick, probabilities),
  consensusBookCount: fourBooks.length,
  consensusBookKeys: fourBooks,
  referenceProbabilityMad: 0.0095,
  referenceBookProbabilities: fourBooks.map((bookmakerKey, index) => ({
    bookmakerKey,
    observedAt,
    probability: probabilities[index],
  })),
});
const fourBookProbabilities = [0.470, 0.476, 0.490, 0.495];
const fourBookLattice = [
  fourEvidence('大7.5', fourBookProbabilities),
  fourEvidence('小7.5', fourBookProbabilities.map(value => 1 - value)),
  fourEvidence('大8.5', fourBookProbabilities),
  fourEvidence('小8.5', fourBookProbabilities.map(value => 1 - value)),
];
const fourBookPair = applyIndependentMarketVerification(
  [actual('大8平'), actual('小8平')],
  fourBookLattice,
  undefined,
  Date.parse(observedAt) + 60_000,
);
assert.ok(fourBookPair.every(row => row.marketVerification.referencePriorEligible));
const fourBookOver = fourBookPair[0].marketVerification.referencePayoffVector;
const fourBookUnder = fourBookPair[1].marketVerification.referencePayoffVector;
assert.ok(Math.abs(fourBookOver.effectiveWinProbability + fourBookUnder.effectiveWinProbability - 1) < 1e-12,
  '偶數莊家必須平均中間兩個完整payoff向量，正反方向中心機率仍須互補');
assert.ok(Math.abs(fourBookOver.equivalentWin - fourBookUnder.equivalentLoss) < 1e-12);
assert.ok(Math.abs(fourBookOver.equivalentLoss - fourBookUnder.equivalentWin) < 1e-12);

const split = applyIndependentMarketVerification(
  [actual('大8/8.5平')],
  totalLattice,
  undefined,
  Date.parse(observedAt) + 60_000,
)[0].marketVerification.referencePayoffVector;
assert.ok(Math.abs(split.equivalentWin - 0.45) < 1e-12);
assert.ok(Math.abs(split.equivalentLoss - 0.50) < 1e-12);
assert.ok(Math.abs(split.equivalentPush - 0.05) < 1e-12);

const missingBoundary = applyIndependentMarketVerification(
  [actual('大8+80')],
  totalLattice.filter(row => row.pick !== '大7.5'),
  undefined,
  Date.parse(observedAt) + 60_000,
)[0];
assert.equal(missingBoundary.marketVerification.referencePriorEligible, false);
assert.match(missingBoundary.marketVerification.priorIneligibleReason, /相鄰半分盤/);

const nonMonotonic = applyIndependentMarketVerification(
  [actual('大8平')],
  [
    evidence('全場大小', '大7.5', [0.44, 0.441, 0.439]),
    evidence('全場大小', '大8.5', [0.45, 0.451, 0.449]),
  ],
  undefined,
  Date.parse(observedAt) + 60_000,
)[0];
assert.equal(nonMonotonic.marketVerification.referencePriorEligible, false);
assert.match(nonMonotonic.marketVerification.priorIneligibleReason, /不單調/);

const wrongPeriod = applyIndependentMarketVerification(
  [{ ...actual('大4平'), market: '上半大小' }],
  totalLattice,
  undefined,
  Date.parse(observedAt) + 60_000,
)[0];
assert.equal(wrongPeriod.marketVerification.referencePriorEligible, false);
assert.match(wrongPeriod.marketVerification.priorIneligibleReason, /同賽事同期間|5分鐘內/);

const spreadLattice = [
  evidence('全場讓分', '主隊讓0.5', [0.55, 0.551, 0.549]),
  evidence('全場讓分', '主隊讓1.5', [0.45, 0.451, 0.449]),
  evidence('全場讓分', '客隊受讓0.5', [0.45, 0.449, 0.451]),
  evidence('全場讓分', '客隊受讓1.5', [0.55, 0.549, 0.551]),
];
const spreadActual = pick => ({ ...actual(pick), market: '全場讓分' });
const spreadVerified = applyIndependentMarketVerification(
  [spreadActual('主隊讓1-20'), spreadActual('客隊受讓1-20')],
  spreadLattice,
  undefined,
  Date.parse(observedAt) + 60_000,
);
assert.ok(spreadVerified.every(row => row.marketVerification.referencePriorEligible));
const giving = spreadVerified[0].marketVerification.referencePayoffVector;
assert.ok(Math.abs(giving.equivalentWin - 0.45) < 1e-12);
assert.ok(Math.abs(giving.equivalentLoss - 0.47) < 1e-12);
assert.ok(Math.abs(giving.equivalentPush - 0.08) < 1e-12);
const receiving = spreadVerified[1].marketVerification.referencePayoffVector;
assert.ok(Math.abs(receiving.equivalentWin - 0.47) < 1e-12);
assert.ok(Math.abs(receiving.equivalentLoss - 0.45) < 1e-12);
assert.ok(Math.abs(receiving.equivalentPush - 0.08) < 1e-12);

const repriceRoute = fs.readFileSync(new URL('../app/api/reprice/route.js', import.meta.url), 'utf8');
assert.match(repriceRoute, /referenceBookProbabilities:\s*row\.referenceBookProbabilities/, 'reprice must preserve signed per-book payoff evidence');
assert.match(
  repriceRoute,
  /const MAX_VERIFICATION_MARKET_ROWS = 120;/,
  'reprice verification lattice limit must remain 120 rows',
);
assert.match(
  repriceRoute,
  /body\.verificationMarkets, MAX_VERIFICATION_MARKET_ROWS\)/,
  'reprice must retain the complete targeted payoff lattice through the named limit',
);

console.log('Payoff-vector integer, modifier, split, monotonicity and period isolation PASS');
