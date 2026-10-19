import assert from 'node:assert/strict';
import { evaluateSoccerQuote } from '../lib/soccer/market-payoff.js';
import { scoreDistribution } from '../lib/soccer/score-model.js';
import { predictHalfTimeDistribution, HALF_TIME_MODEL_VERSION, HALF_TIME_PROTOCOL_VERSION } from '../lib/soccer/half-time-model.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const grid = (cells, tailMass = 0, period = 'REGULATION_FT') => ({ cells, tailMass,
  retainedMass: cells.reduce((sum, row) => sum + row.probability, 0), period });
const one = (home, away, period) => grid([{ home, away, probability: 1 }], 0, period);
const quote = { kind: 'HANDICAP', direction: 'HOME', sourceLine: '0.75', period: 'FT', lineSide: 'home', water: 0.9, waterFormat: 'PROFIT_PER_UNIT' };
const contract = { type: 'ASIAN_SPLIT', period: 'FT', rebate: { rate: 0, basis: 'NONE' }, provenance: { status: 'ASSUMPTION', note: 'synthetic engineering fixture, not provider terms' } };
const calc = (q = quote, d = one(1, 0), c = contract) => evaluateSoccerQuote({ quote: q, distribution: d, contract: c });

// No implicit contract, period, price format or football rebate is fabricated.
assert.equal(evaluateSoccerQuote({ quote, distribution: one(1, 0) }).status, 'NOT_CALCULABLE');
for (const c of [null, {}, { ...contract, rebate: undefined }, { ...contract, rebate: { basis: 'NONE' } },
  { ...contract, provenance: undefined }, { ...contract, period: undefined }]) {
  const result = calc(quote, one(1, 0), c); assert.equal(result.ok, false); assert.equal(result.netEV, null); assert.equal(result.rows.length, 0);
}
assert.equal(calc({ ...quote, waterFormat: undefined }).ok, false);
assert.equal(calc(quote, one(1, 0), { ...contract, rebate: { rate: 0.015, basis: 'NONE' } }).ok, false);

// Asian .75 must split: win by one = half win / half push, NOT full win.
const quarter = calc(); assert.equal(quarter.status, 'UNVERIFIED_ASSUMPTION');
assert.deepEqual(quarter.lineLegs, [0.5, 1]); close(quarter.rows[0].winFraction, 0.5); close(quarter.rows[0].pushFraction, 0.5); close(quarter.netEV, 0.45);
close(calc({ ...quote, direction: 'AWAY' }).netEV, -0.5);
close(calc({ ...quote, sourceLine: '0.5/1' }).netEV, 0.45);
assert.equal(calc({ ...quote, sourceLine: '0/1' }).ok, false, 'nonadjacent split legs are unsupported');
assert.equal(calc({ ...quote, sourceLine: '0.6' }).ok, false);
assert.equal(calc({ ...quote, sourceLine: '0.75+50' }).ok, false);
const awayGives = { ...quote, direction: 'AWAY', lineSide: 'away' };
close(calc(awayGives, one(0, 1)).netEV, 0.45);

// Explicit credit mapping and suffix semantics use the existing credit engine.
const credit = { ...contract, type: 'CREDIT_BOUNDARY', labelMapping: { home: '主隊甲', away: '客隊乙' } };
const cplus = calc({ ...quote, sourceLine: '1+25' }, one(1, 0), credit);
close(cplus.rows[0].winFraction, 0.25); close(cplus.netEV, 0.225);
const cminus = calc({ ...quote, sourceLine: '1-25' }, one(1, 0), credit);
close(cminus.rows[0].lossFraction, 0.25); close(cminus.netEV, -0.25);
close(calc({ ...quote, sourceLine: '1+25', direction: 'AWAY' }, one(1, 0), credit).netEV, -0.25);
close(calc({ ...quote, sourceLine: '1平' }, one(1, 0), credit).netEV, 0);
assert.equal(calc(quote, one(1, 0), credit).ok, false, 'credit quarter magnitude cannot become a single .75 leg');
assert.equal(calc({ ...quote, sourceLine: '1+150' }, one(1, 0), credit).ok, false, 'do not silently cap credit percentages');
assert.equal(calc({ ...quote, sourceLine: '1平' }, one(1, 0), { ...credit, labelMapping: undefined }).ok, false);

const total = { kind: 'TOTAL', direction: 'OVER', sourceLine: '2.25', period: 'FT', water: 0.8, waterFormat: 'PROFIT_PER_UNIT' };
close(calc(total, one(1, 1)).netEV, -0.5);
close(calc({ ...total, direction: 'UNDER' }, one(1, 1)).netEV, 0.4);
close(calc({ ...total, sourceLine: '2+50' }, one(1, 1), credit).netEV, 0.4);

// Rebate amount uses an explicit basis, not an implicit site-wide 1.5%.
for (const [basis, expected] of [['SETTLED_PRINCIPAL', 0.005], ['TOTAL_PRINCIPAL', 0.01], ['LOSS_PRINCIPAL', 0]]) {
  const r = calc(quote, one(1, 0), { ...contract, rebate: { rate: 0.01, basis } });
  close(r.retainedEV.rebate, expected); close(r.netEV, 0.45 + expected);
}
close(calc({ ...quote, direction: 'AWAY' }, one(1, 0), { ...contract, rebate: { rate: 0.01, basis: 'LOSS_PRINCIPAL' } }).netEV, -0.495);
const flat = { ...quote, sourceLine: '1' };
close(calc(flat, one(1, 0), { ...contract, rebate: { rate: 0.01, basis: 'TOTAL_PRINCIPAL' } }).netEV, 0.01);
close(calc(flat, one(1, 0), { ...contract, rebate: { rate: 0.01, basis: 'SETTLED_PRINCIPAL' } }).netEV, 0);

// Every score stays visible; five outcome probabilities represent retained mass.
const diverse = grid([{ home: 0, away: 0, probability: 0.2 }, { home: 1, away: 0, probability: 0.3 }, { home: 2, away: 0, probability: 0.48 }], 0.02);
const truncated = calc(quote, diverse);
assert.equal(truncated.rows.length, 3); close(truncated.probabilities.FULL_LOSS, 0.2); close(truncated.probabilities.PARTIAL_WIN, 0.3); close(truncated.probabilities.FULL_WIN, 0.48);
close(Object.values(truncated.probabilities).reduce((a, b) => a + b), 0.98);
assert.equal(truncated.netEV, null); assert.equal(truncated.grossEV, null);
close(truncated.retainedEV.net, -0.2 + 0.3 * 0.45 + 0.48 * 0.9);
close(truncated.evBounds.net.lower, truncated.retainedEV.net - 0.02);
close(truncated.evBounds.net.upper, truncated.retainedEV.net + 0.02 * 0.9);
assert.equal(truncated.tailUncertainty.interpretation, 'OMITTED_SCORE_MASS_ONLY_NOT_MODEL_CONFIDENCE_INTERVAL');
assert.equal(truncated.partialOutcomes[0].fraction, 0.5);

// These are conditional arithmetic bounds, tested against every omitted payoff.
for (const basis of ['NONE', 'SETTLED_PRINCIPAL', 'TOTAL_PRINCIPAL', 'LOSS_PRINCIPAL']) {
  const c = { ...contract, rebate: { rate: basis === 'NONE' ? 0 : 0.07, basis } };
  const bounded = calc(quote, diverse, c);
  for (let h = 0; h <= 5; h++) for (let a = 0; a <= 5; a++) {
    const completed = bounded.retainedEV.net + 0.02 * calc(quote, one(h, a), c).netEV;
    assert.ok(completed >= bounded.evBounds.net.lower - 1e-12 && completed <= bounded.evBounds.net.upper + 1e-12);
  }
}

// Period, mass, duplication and malformed numeric data must fail closed.
assert.equal(calc(quote, one(1, 0, 'REGULATION_HT')).ok, false);
assert.equal(calc({ ...quote, period: 'HT' }, one(1, 0), contract).ok, false);
assert.equal(calc({ ...quote, period: 'HT' }, one(1, 0, 'REGULATION_HT'), { ...contract, period: 'HT' }).ok, true);
assert.equal(calc(quote, { ...diverse, tailMass: 0 }).ok, false);
assert.equal(calc(quote, { ...diverse, retainedMass: 1 }).ok, false);
const tinyTail = calc(quote, grid([{ home: 1, away: 0, probability: 1 - 1e-12 }]));
assert.equal(tinyTail.netEV, null, 'mass tolerance must not silently turn omitted mass into exact EV');
assert.ok(tinyTail.tailMass > 0);
assert.equal(calc(quote, grid([{ home: 1, away: 0, probability: 0.5 }, { home: 1, away: 0, probability: 0.5 }])).ok, false);
assert.equal(calc(quote, grid([{ home: -1, away: 0, probability: 1 }])).ok, false);
assert.equal(calc(quote, grid([{ home: 1, away: 0, probability: '1' }])).ok, false);

// For genuine own DC grids, all omitted TOTAL scores can share one settlement
// state. Complete that state, without moving probability into a made-up score
// or dividing the retained grid by its mass. Independent total-goal marginals
// (Poisson sum plus the four-cell DC correction) provide the numerical oracle.
const dcTotal = (distribution, n) => {
  const { homeRate: h, awayRate: a, rho } = distribution;
  let probability = Math.exp(-h - a);
  for (let i = 1; i <= n; i++) probability *= (h + a) / i;
  const correction = Math.exp(-h - a) * h * a * rho;
  return probability + (n === 0 ? -correction : n === 1 ? 2 * correction : n === 2 ? -correction : 0);
};
const totalQuote = { ...total, sourceLine: '2.5', water: .95 };
const fullRebate = { ...contract, rebate: { rate: .01, basis: 'TOTAL_PRINCIPAL' } };
const genuine = scoreDistribution(1.5, 1.1, .1), genuineBefore = JSON.stringify(genuine);
const complete = calc(totalQuote, genuine, fullRebate);
assert.ok(genuine.tailMass > 0);
assert.equal(complete.tailMass, genuine.tailMass, 'original omitted score mass stays visible');
assert.equal(complete.resolvedTailMass, genuine.tailMass); assert.equal(complete.unresolvedTailMass, 0);
assert.equal(complete.rows.length, genuine.cells.length, 'tail is a settlement state, never an invented score row');
assert.deepEqual(complete.rows.map(row => [row.home, row.away, row.probability]), genuine.cells.map(row => [row.home, row.away, row.probability]));
assert.equal(complete.tailSettlement.method, 'SETTLEMENT_INVARIANT_OUTSIDE_RECTANGLE');
assert.equal(complete.tailSettlement.outcome, 'FULL_WIN');
assert.equal(complete.tailSettlement.winFraction, 1); assert.equal(complete.tailSettlement.lossFraction, 0);
assert.equal(complete.tailSettlement.support.verification, 'RECOMPUTED_GENERATOR_PMF_AND_COMPLETE_RECTANGLE');
close(complete.tailSettlement.contribution.net, genuine.tailMass * .96);
close(complete.netEV, complete.retainedEV.net + complete.tailSettlement.contribution.net);
close(complete.probabilities.FULL_WIN, complete.retainedProbabilities.FULL_WIN + genuine.tailMass);
close(Object.values(complete.probabilities).reduce((sum, mass) => sum + mass, 0), 1);
close(Object.values(complete.retainedProbabilities).reduce((sum, mass) => sum + mass, 0), genuine.retainedMass);
for (const state of Object.keys(complete.probabilities)) {
  assert.equal(complete.probabilityBounds[state].lower, complete.probabilities[state]);
  assert.equal(complete.probabilityBounds[state].upper, complete.probabilities[state]);
}
assert.equal(complete.evBounds.net.lower, complete.netEV); assert.equal(complete.evBounds.net.upper, complete.netEV);
assert.equal(complete.tailUncertainty.maxAbsoluteNetContribution, 0);
const cdf2 = [0, 1, 2].reduce((sum, n) => sum + dcTotal(genuine, n), 0);
close(complete.netEV, .95 * (1 - cdf2) - cdf2 + .01);
const completeUnder = calc({ ...totalQuote, direction: 'UNDER' }, genuine, fullRebate);
assert.equal(completeUnder.tailSettlement.outcome, 'FULL_LOSS');
close(completeUnder.tailSettlement.contribution.net, genuine.tailMass * -.99);
close(completeUnder.netEV, .95 * cdf2 - (1 - cdf2) + .01);
const lowOver = calc({ ...totalQuote, sourceLine: '.5' }, genuine, fullRebate);
assert.equal(lowOver.ok, false, 'raw source syntax remains unchanged');
const low = calc({ ...totalQuote, sourceLine: '0.5' }, genuine, fullRebate);
close(low.netEV, .95 * (1 - dcTotal(genuine, 0)) - dcTotal(genuine, 0) + .01);
const p2 = dcTotal(genuine, 2), cdf1 = dcTotal(genuine, 0) + dcTotal(genuine, 1);
const exactQuarter = calc({ ...totalQuote, sourceLine: '2.25' }, genuine, fullRebate);
close(exactQuarter.netEV, .95 * (1 - cdf2) - cdf1 - .5 * p2 + .01);
const exactCredit = calc({ ...totalQuote, sourceLine: '2+25' }, genuine, { ...fullRebate, type: 'CREDIT_BOUNDARY' });
close(exactCredit.netEV, .95 * (1 - cdf2 + .25 * p2) - cdf1 + .01);
for (const [basis, expectedTailRebate] of [['NONE', 0], ['SETTLED_PRINCIPAL', .01], ['LOSS_PRINCIPAL', 0]]) {
  const resolved = calc(totalQuote, genuine, { ...contract, rebate: { rate: basis === 'NONE' ? 0 : .01, basis } });
  close(resolved.tailSettlement.rebatePerUnit, expectedTailRebate);
}
const differentTruncation = calc(totalQuote, scoreDistribution(1.5, 1.1, .1, 1e-8), fullRebate);
assert.ok(differentTruncation.tailMass > complete.tailMass);
assert.equal(differentTruncation.unresolvedTailMass, 0);
close(differentTruncation.netEV, complete.netEV);
assert.notEqual(differentTruncation.retainedEV.net, complete.retainedEV.net);
assert.equal(JSON.stringify(genuine), genuineBefore, 'conditional completion does not mutate the generator output');

// A label, rectangular shape, comparison tolerance or small residual cannot
// certify a model. Missing low scores and changed PMFs retain unknown tails.
const metadata = { distributionFamily: genuine.distributionFamily, homeRate: genuine.homeRate,
  awayRate: genuine.awayRate, rho: genuine.rho, tolerance: genuine.tolerance };
const missingCell = structuredClone(genuine); missingCell.cells.shift();
missingCell.retainedMass = missingCell.cells.reduce((sum, row) => sum + row.probability, 0);
missingCell.tailMass = 1 - missingCell.retainedMass;
const changedPMF = structuredClone(genuine);
changedPMF.cells[0].probability += 1e-6; changedPMF.cells[1].probability -= 1e-6;
const tinyChangedPMF = structuredClone(genuine);
tinyChangedPMF.cells[0].probability += 1e-14; tinyChangedPMF.cells[1].probability -= 1e-14;
for (const distribution of [{ ...diverse, ...metadata }, missingCell, changedPMF, tinyChangedPMF,
  { ...genuine, homeRate: 1.6 }, { ...genuine, distributionFamily: 'CALLER_RECTANGULAR_GRID' }]) {
  const result = calc(totalQuote, distribution, fullRebate);
  assert.equal(result.ok, true); assert.equal(result.tailSettlement, null);
  assert.equal(result.netEV, null); assert.equal(result.resolvedTailMass, 0);
  assert.equal(result.unresolvedTailMass, result.tailMass);
}
const boundary = complete.tailSettlement.support.minimumOmittedTotal;
const aboveTail = calc({ ...totalQuote, sourceLine: String(boundary) }, genuine, fullRebate);
assert.equal(aboveTail.tailSettlement, null); assert.equal(aboveTail.netEV, null);
const genuineHandicap = calc(quote, genuine, contract);
assert.equal(genuineHandicap.tailSettlement, null); assert.equal(genuineHandicap.netEV, null);
assert.equal(genuineHandicap.unresolvedTailMass, genuineHandicap.tailMass);

// HT must have its own documented adaptive grid and the matching model/joint
// metadata. An inherited omitted FT mixture can affect even low HT scores.
const halfModel = { version: HALF_TIME_MODEL_VERSION, protocolVersion: HALF_TIME_PROTOCOL_VERSION,
  league: 'epl', period: 'REGULATION_HT', cutoff: '2026-01-01T00:00:00Z', shares: { home: .45, away: .43 } };
const half = predictHalfTimeDistribution(genuine, halfModel);
const halfQuote = { ...totalQuote, period: 'HT', sourceLine: '0.5' }, halfContract = { ...fullRebate, period: 'HT' };
const completeHalf = calc(halfQuote, half, halfContract);
assert.equal(completeHalf.tailSettlement.support.generator, 'POISSON_DIXON_COLES_THINNED');
assert.equal(completeHalf.unresolvedTailMass, 0);
close(completeHalf.netEV, .95 * (1 - dcTotal(half, 0)) - dcTotal(half, 0) + .01);
for (const distribution of [{ ...half, jointContract: null }, { ...half, modelVersion: 'CALLER_HT_MODEL' },
  { ...half, tailSemantics: 'INHERITED_OMITTED_FT_MASS_CAN_CONTRIBUTE_TO_ANY_HT_SCORE_NOT_HT_OUTSIDE_GRID_PROBABILITY' },
  predictHalfTimeDistribution({ ...diverse, period: 'REGULATION_FT' }, halfModel)]) {
  const result = calc(halfQuote, distribution, halfContract);
  assert.equal(result.ok, true); assert.equal(result.tailSettlement, null); assert.equal(result.netEV, null);
}
console.log('PASS verified FT/HT DC complete-rectangle TOTAL tails: invariant-state integration, analytic total-goal oracle, credit/Asian boundaries and rebates, traceable unchanged omitted mass, no invented cells; altered/unknown/inherited tails and handicaps remain unresolved');

for (const r of [quarter, truncated, complete, completeUnder, completeHalf, calc(quote, one(1, 0), { ...contract, provenance: { status: 'VERIFIED', evidenceRef: 'fixture-only' } })]) {
  assert.equal(r.W, null); assert.equal(r.R, null); assert.equal(r.S, null);
  assert.equal(r.eligible, false); assert.equal(r.executable, false); assert.equal(r.formalScoringEnabled, false);
}
console.log('PASS conditional soccer payoff: explicit credit/Asian mechanics, correct quarter splits and credit signs, per-score five-state mass, explicit rebate bases, omitted-tail EV bounds, period/mass guards, no formal W/R/S or execution');
