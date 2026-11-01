import assert from 'node:assert/strict';
import { poissonChernoffMeanInterval, poissonCellProbabilityBounds, buildSoccerModelFamilyConfidenceSet,
  boundSoccerModelFamilyQuote, evaluateSoccerModelFamilyUncertainty, soccerModelFamilyHash } from '../lib/soccer/model-family-uncertainty.js';
import { scoreDistribution } from '../lib/soccer/score-model.js';
import { evaluateSoccerQuote } from '../lib/soccer/market-payoff.js';
import Decimal from 'decimal.js';

// Mathematical counterexamples and SYNTHETIC engineering fixtures only. None
// of these observations are persisted as real calibration data or accepted.
const pmf = (k, rate) => { let p = Math.exp(-rate); for (let n = 1; n <= k; n++) p *= rate / n; return p; };
for (const count of [0, 1, 5, 50, 1000]) {
  const bounds = poissonChernoffMeanInterval(count, .05);
  assert.ok(bounds.lower >= 0 && bounds.lower <= count && bounds.upper >= count);
  if (count === 0) assert.ok(bounds.upper >= Math.log(40) && bounds.upper - Math.log(40) < 1e-12);
  const d = mean => count === 0 ? mean : count * Math.log(count / mean) + mean - count;
  if (bounds.lower > 0) assert.ok(d(bounds.lower) >= Math.log(40) - 1e-10);
  assert.ok(d(bounds.upper) >= Math.log(40) - 1e-10);
}
const coverageIntervals = Array.from({ length: 100 }, (_, count) => poissonChernoffMeanInterval(count, .1));
for (const mean of [.01, .5, 2, 10, 30]) {
  const delta = .1;
  let excludedMass = 0;
  for (let count = 0; count < coverageIntervals.length; count++) {
    const interval = coverageIntervals[count];
    if (mean < interval.lower || mean > interval.upper) excludedMass += pmf(count, mean);
  }
  assert.ok(excludedMass <= delta + 1e-12, 'inverted TWO-sided tail bound must cover the generating Poisson mean');
}
assert.throws(() => poissonChernoffMeanInterval(1, 0));
assert.throws(() => poissonChernoffMeanInterval(1.1, .05));

for (const rates of [{ lower: 0, upper: .5 }, { lower: .25, upper: 3.7 }, { lower: 2, upper: 2 }]) {
  for (let count = 0; count <= 10; count++) {
    const interval = poissonCellProbabilityBounds(count, rates);
    for (let index = 0; index <= 40; index++) {
      const rate = rates.lower + (rates.upper - rates.lower) * index / 40, probability = pmf(count, rate);
      assert.ok(probability >= interval.lower - 2e-16 && probability <= interval.upper + 2e-16,
        'continuous PMF enclosure includes endpoints AND the interior maximum lambda=k');
    }
  }
}
const interior = poissonCellProbabilityBounds(2, { lower: .5, upper: 4 });
assert.ok(interior.upper >= pmf(2, 2));
assert.ok(interior.upper > Math.max(pmf(2, .5), pmf(2, 4)), 'checking rate-box corners alone would miss this maximum');
const Exact = Decimal.clone({ precision: 150 });
function exactBinary64(value) {
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  const bits = view.getBigUint64(0), sign = bits >> 63n ? -1 : 1;
  const exponent = Number((bits >> 52n) & 2047n), fraction = bits & ((1n << 52n) - 1n);
  const significand = exponent === 0 ? fraction : (1n << 52n) + fraction;
  const power = exponent === 0 ? -1074 : exponent - 1023 - 52;
  return new Exact(significand.toString()).times(sign).times(new Exact(2).pow(power));
}
const highScoreBound = poissonCellProbabilityBounds(100, { lower: 50.1, upper: 50.1 });
const exactRate = exactBinary64(50.1);
let exactPmf = exactRate.negated().exp();
for (let count = 1; count <= 100; count++) exactPmf = exactPmf.times(exactRate).div(count);
assert.ok(new Exact(highScoreBound.lower).lte(exactPmf) && new Exact(highScoreBound.upper).gte(exactPmf),
  'input expansion must enclose the exact IEEE rate, not only the shortest JSON decimal after nonlinear PMF amplification');

const baseline = { league: 'epl', period: 'FT', modelHash: 'a'.repeat(64), createdAt: '2026-10-18T00:00:00Z',
  trainedThrough: '2026-10-17T00:00:00Z', sourceHashes: ['b'.repeat(64)] };
const protocol = { registeredAt: '2026-10-18T00:00:00Z', calibrationFrom: '2026-10-19T00:00:00Z',
  calibrationBefore: '2026-10-29T00:00:00Z', alpha: .1 };
const now = Date.parse('2026-11-01T00:00:00Z');
const rows = Array.from({ length: 8 }, (_, index) => ({ league: 'epl', period: 'FT', gameId: `soccer:epl:${index + 1}`,
  kickoff: `2026-10-${String(20 + index).padStart(2, '0')}T00:00:00Z`,
  predictedAt: null, baselineModelHash: baseline.modelHash, homeRate: 1.5, awayRate: 1,
  actualScore: { home: index % 4, away: index % 3 }, resultAvailableAt: `2026-10-${String(20 + index).padStart(2, '0')}T02:00:00Z`,
  sourceHashes: ['c'.repeat(64), 'd'.repeat(64)] }));
const original = JSON.stringify(rows);
const confidence = buildSoccerModelFamilyConfidenceSet({ observations: rows, baseline, protocol, now });
assert.equal(confidence.independentRealGames, 8);
assert.ok(confidence.marginals.home.countMean.errorProbability <= .05, 'home and away share the alpha budget by Bonferroni with conservative rounding');
assert.equal(confidence.marginals.home.goals, 12);
assert.ok(confidence.marginals.home.exposure.lower <= 12 && confidence.marginals.home.exposure.upper >= 12);
assert.equal(confidence.simultaneousErrorProbability, .1);
assert.equal(confidence.modelMisspecificationBound, null);
assert.equal(confidence.durableFreezeVerified, false);
assert.equal(confidence.coverageAssumptionsVerified, false);
const duplicate = buildSoccerModelFamilyConfidenceSet({ observations: [...rows, ...rows], baseline, protocol, now });
assert.deepEqual(duplicate, confidence, 'duplicate receipt/quote observations cannot increase real-game information');
const mixed = buildSoccerModelFamilyConfidenceSet({ observations: [...rows,
  { ...rows[0], league: 'ucl', gameId: 'soccer:ucl:1' }, { ...rows[0], period: 'HT' },
  { ...rows[0], baselineModelHash: 'e'.repeat(64) }], baseline, protocol, now });
assert.equal(mixed.independentRealGames, 8);
assert.equal(mixed.excludedReasons.MODEL_FAMILY_OBSERVATION_OUTSIDE_SCOPE, 3);
const conflict = buildSoccerModelFamilyConfidenceSet({ observations: [...rows, { ...rows[0], actualScore: { home: 9, away: 9 } }], baseline, protocol, now });
assert.equal(conflict.independentRealGames, 7); assert.equal(conflict.quarantinedGames, 1);
const lateFreeze = buildSoccerModelFamilyConfidenceSet({ observations: rows, baseline,
  protocol: { ...protocol, registeredAt: '2026-10-21T00:00:00Z' }, now });
assert.equal(lateFreeze.independentRealGames, 0);
assert.ok(lateFreeze.excludedReasons.MODEL_FAMILY_FROZEN_WINDOW_PROTOCOL_INVALID);
assert.equal(buildSoccerModelFamilyConfidenceSet({ observations: rows, baseline,
  protocol: { ...protocol, alpha: Number.MIN_VALUE }, now }).independentRealGames, 0,
  'an unrepresentable split error budget is rejected before numeric inversion');
const futureResult = buildSoccerModelFamilyConfidenceSet({ observations: [{ ...rows[0], resultAvailableAt: '2026-11-02T00:00:00Z' }], baseline, protocol, now });
assert.equal(futureResult.independentRealGames, 0);
assert.equal(JSON.stringify(rows), original);

const game = { league: 'epl', id: 'soccer:epl:999', sourceId: '999', status: 'scheduled', startTime: '2026-11-02T00:00:00Z' };
const contract = { type: 'CREDIT_BOUNDARY', period: 'FT', labelMapping: { home: '主隊甲', away: '客隊乙' },
  rebate: { rate: .01, basis: 'SETTLED_PRINCIPAL' }, provenance: { status: 'ASSUMPTION' } };
const quotes = [
  { kind: 'HANDICAP', direction: 'HOME', sourceLine: '1+20', lineSide: 'home' },
  { kind: 'HANDICAP', direction: 'AWAY', sourceLine: '1-20', lineSide: 'home' },
  { kind: 'TOTAL', direction: 'OVER', sourceLine: '2平' },
  { kind: 'TOTAL', direction: 'UNDER', sourceLine: '2.5' },
].map(quote => ({ ...quote, period: 'FT', water: .9, waterFormat: 'PROFIT_PER_UNIT' }));
const rates = { home: { lower: .8, upper: 2.6 }, away: { lower: .4, upper: 1.8 } };
for (const quote of quotes) {
  const result = boundSoccerModelFamilyQuote({ quote, contract, game, rates, maxGoals: 12 });
  assert.ok(result.bounds.lower <= result.bounds.upper);
  for (const h of [.8, 1.1, 2.6]) for (const a of [.4, .9, 1.8]) {
    const rhoLower = Math.max(-1 / h, -1 / a), rhoUpper = Math.min(1, 1 / (h * a));
    for (const rho of [rhoLower + 1e-8, 0, rhoUpper - 1e-8]) {
      const distribution = scoreDistribution(h, a, rho);
      const actual = evaluateSoccerQuote({ quote, contract, distribution });
      assert.equal(actual.ok, true);
      assert.ok(result.bounds.lower <= actual.evBounds.net.lower + 1e-12
        && result.bounds.upper >= actual.evBounds.net.upper - 1e-12,
      'bound encloses actual existing credit returns throughout rate rectangle and legal positive/negative rho');
    }
  }
  assert.equal(result.probabilityNormalizationApplied, false);
  assert.equal(result.accepted, false); assert.equal(result.empiricalErrorMargin, null); assert.equal(result.R, null);
}
const smallGrid = boundSoccerModelFamilyQuote({ quote: quotes[0], contract, game, rates, maxGoals: 1 });
assert.ok(smallGrid.omittedMassUpper > .5, 'coarse rectangle explicitly retains substantial unknown score mass');
assert.ok(smallGrid.bounds.upper - smallGrid.bounds.lower > 1,
  'unknown tail is permitted to realize either worst supported credit payoff, never a midpoint or normalized grid');
const zeroRates = boundSoccerModelFamilyQuote({ quote: quotes[0], contract, game,
  rates: { home: { lower: 0, upper: 0 }, away: { lower: 0, upper: 0 } }, maxGoals: 1 });
assert.ok(zeroRates.bounds.lower <= -.99 && zeroRates.bounds.upper >= -.99);
for (const rebateRate of [.9, .99]) {
  const cancellationContract = { ...contract, rebate: { rate: rebateRate, basis: 'SETTLED_PRINCIPAL' } };
  const cancellationQuote = { ...quotes[0], sourceLine: '0-29', water: .87 };
  const cancellationBound = boundSoccerModelFamilyQuote({ quote: cancellationQuote, contract: cancellationContract, game,
    rates: { home: { lower: 0, upper: 0 }, away: { lower: 0, upper: 0 } }, maxGoals: 1 });
  const exactRuleReturn = new Exact('.29').negated().plus(new Exact(String(rebateRate)).times('.29'));
  assert.ok(new Exact(cancellationBound.bounds.lower).lte(exactRuleReturn)
    && new Exact(cancellationBound.bounds.upper).gte(exactRuleReturn),
  'directed rule reconstruction encloses cancellation error exceeding one ULP of the final JS payoff');
  const binaryRuleReturn = exactBinary64(.29).negated().plus(exactBinary64(rebateRate).times(exactBinary64(.29)));
  assert.ok(new Exact(cancellationBound.bounds.lower).lte(binaryRuleReturn)
    && new Exact(cancellationBound.bounds.upper).gte(binaryRuleReturn), 'original IEEE fractions and rate are enclosed as well');
}
assert.throws(() => boundSoccerModelFamilyQuote({ quote: quotes[0], contract, game, rates, maxGoals: 0 }));
assert.throws(() => boundSoccerModelFamilyQuote({ quote: quotes[0], contract: { ...contract, rebate: { ...contract.rebate, appliesTo: {} } }, game, rates }));
assert.deepEqual(boundSoccerModelFamilyQuote({ quote: quotes[0], contract: { ...contract, rebate: { ...contract.rebate,
  appliesTo: { FULL_WIN: true, PARTIAL_WIN: true, PUSH: false, PARTIAL_LOSS: true, FULL_LOSS: true } } }, game, rates }).bounds,
boundSoccerModelFamilyQuote({ quote: quotes[0], contract, game, rates }).bounds);
const target = evaluateSoccerModelFamilyUncertainty({ confidenceSet: confidence, baselineRates: { modelHash: baseline.modelHash, homeRate: 1.6, awayRate: 1.1 },
  quote: quotes[0], contract, game, weightedExpectedReturn: .03, now });
assert.ok(target.familyOnlyErrorBound >= .03 - target.bounds.lower);
assert.ok(target.familyOnlyErrorBound >= target.bounds.upper - .03);
assert.equal(target.formalModelError, null); assert.equal(target.formalEligible, false); assert.equal(target.W, null);
assert.equal(target.confidenceSetHash, confidence.contentHash);
assert.equal(target.baselineModelHash, baseline.modelHash);
assert.equal(target.contentHash, soccerModelFamilyHash(Object.fromEntries(Object.entries(target).filter(([key]) => key !== 'contentHash'))));
assert.throws(() => evaluateSoccerModelFamilyUncertainty({ confidenceSet: confidence, baselineRates: { modelHash: 'e'.repeat(64), homeRate: 1.6, awayRate: 1.1 }, quote: quotes[0], contract, game, now }));
assert.throws(() => evaluateSoccerModelFamilyUncertainty({ confidenceSet: { ...confidence, independentRealGames: 999 }, baselineRates: { modelHash: baseline.modelHash, homeRate: 1.6, awayRate: 1.1 }, quote: quotes[0], contract, game, now }));
assert.throws(() => evaluateSoccerModelFamilyUncertainty({ confidenceSet: confidence, baselineRates: { modelHash: baseline.modelHash, homeRate: 1.6, awayRate: 1.1 }, quote: { ...quotes[0], period: 'HT' }, contract, game, now }));
console.log('Soccer individual Poisson/DC model-family uncertainty: Chernoff inversion, continuous probability/payoff bounds, full legal rho, tail, game isolation and no formal promotion PASS; actual applicability and misspecification NOT VERIFIED');
