import assert from 'node:assert/strict';
import { evaluateSoccerQuote } from '../lib/soccer/market-payoff.js';

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
for (const r of [quarter, truncated, calc(quote, one(1, 0), { ...contract, provenance: { status: 'VERIFIED', evidenceRef: 'fixture-only' } })]) {
  assert.equal(r.W, null); assert.equal(r.R, null); assert.equal(r.S, null);
  assert.equal(r.eligible, false); assert.equal(r.executable, false); assert.equal(r.formalScoringEnabled, false);
}
console.log('PASS conditional soccer payoff: explicit credit/Asian mechanics, correct quarter splits and credit signs, per-score five-state mass, explicit rebate bases, omitted-tail EV bounds, period/mass guards, no formal W/R/S or execution');
