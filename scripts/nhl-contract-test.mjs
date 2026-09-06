import assert from 'node:assert/strict';
import { SETTLEMENT_RULE_VERSION } from '../lib/taiwan-settlement-v9.js';
import { VERIFIED_NHL_MARKET_MANIFEST, validateNhlMarket, normalizeNhlReaderMarkets } from '../lib/nhl/contracts.js';
import { auditNhlEvDistribution, evaluateNhlMarkets, nhlPayoffCalibrationKey } from '../lib/nhl/ev.js';
import { compareNhlContracts, nhlPayoffForScore, projectNhlContractScore, settleNhlTicket,
  summarizeNhlTicketPerformance, validateNhlLinkedPath } from '../lib/nhl/settlement.js';

// SYNTHETIC MATHEMATICAL CONTRACTS ONLY. The test injects a private manifest.
// These are not Tai888 captures and never authenticate a production market.
const game = { league: 'NHL', gameId: 'test-2026020001', awayTeamId: 'test-away', homeTeamId: 'test-home' };
const now = Date.parse('2026-09-06T00:10:00Z');
const market = {
  ...game, book: 'TAI888', marketId: 'synthetic-total', marketType: 'TOTAL',
  scoreScope: 'REGULATION', period: null, includesOvertime: false,
  shootoutRule: 'EXCLUDED', voidRuleId: 'synthetic-completed-only', selection: 'over',
  pick: '大4平', water: 0.95, lineVersion: 'synthetic-1', sourceHash: 'synthetic-capture',
  observedAt: '2026-09-06T00:00:00Z', evidenceVersion: 'synthetic-test-evidence',
};
const evidenceFor = row => ({
  league: 'NHL', book: 'TAI888', verified: true, evidenceVersion: row.evidenceVersion,
  evidenceSourceHash: 'SYNTHETIC-NOT-PRODUCTION', evidenceObservedAt: '2026-09-01T00:00:00Z',
  ruleSourceUrl: 'https://example.invalid/synthetic-test-only', settlementRuleVersion: SETTLEMENT_RULE_VERSION,
  marketType: row.marketType, scoreScope: row.scoreScope, period: row.period,
  includesOvertime: row.includesOvertime, shootoutRule: row.shootoutRule, voidRuleId: row.voidRuleId,
});
const testOptions = row => ({ manifest: [evidenceFor(row)], game, now });
const checked = row => {
  const result = validateNhlMarket(row, testOptions(row));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.contract;
};
const tiedShootout = {
  probability: 1, periodScores: [{ period: 1, away: 1, home: 0 }, { period: 2, away: 0, home: 1 }, { period: 3, away: 1, home: 1 }],
  regulation: { away: 2, home: 2 }, final: { away: 2, home: 3 },
  outcome: { winner: 'home', overtime: true, shootout: true },
};
const regulationWin = {
  probability: 1, periodScores: [{ period: 1, away: 1, home: 0 }, { period: 2, away: 1, home: 1 }, { period: 3, away: 1, home: 1 }],
  regulation: { away: 3, home: 2 }, final: { away: 3, home: 2 },
  outcome: { winner: 'away', overtime: false, shootout: false },
};
let checks = 0;
const test = (name, fn) => { fn(); checks += 1; console.log(`PASS ${name}`); };

test('production manifest remains empty and synthetic quote cannot authorize production', () => {
  assert.deepEqual(VERIFIED_NHL_MARKET_MANIFEST, []);
  assert.equal(Object.isFrozen(VERIFIED_NHL_MARKET_MANIFEST), true);
  assert.equal(validateNhlMarket(market, { game, now }).ok, false);
  assert.equal(validateNhlMarket(market, testOptions(market)).ok, true);
});
test('unknown identity, scope, OT/SO and void policy fail closed', () => {
  for (const patch of [{ league: 'NBA' }, { gameId: null }, { awayTeamId: 'test-home' }, { book: 'OTHER' },
    { scoreScope: 'FULL' }, { includesOvertime: undefined }, { shootoutRule: null }, { voidRuleId: '' },
    { sourceHash: '' }, { lineVersion: '' }, { observedAt: null }, { evidenceVersion: '' }]) {
    assert.equal(validateNhlMarket({ ...market, ...patch }, testOptions(market)).ok, false, JSON.stringify(patch));
  }
  assert.equal(validateNhlMarket(market, { ...testOptions(market), game: { ...game, gameId: 'other' } }).ok, false);
});
test('timestamp, numeric strings, water null and impossible tail cannot coerce to a valid quote', () => {
  for (const patch of [{ observedAt: '2026-09-07T00:00:00Z' }, { water: null }, { water: '' },
    { observedAt: '2026-09-06T00:00:00' }, { water: '0.95' }, { water: NaN }, { water: -0.1 }, { pick: '大4+120' }, { water: [0.9, 0.95] }]) {
    assert.equal(validateNhlMarket({ ...market, ...patch }, testOptions(market)).ok, false, JSON.stringify(patch));
  }
  assert.equal(validateNhlMarket(market, { ...testOptions(market), maxAgeMs: 1 }).ok, false);
});
test('moneyline is never silently translated to spread zero', () => {
  const row = { ...market, marketType: 'MONEYLINE', pick: '客隊', selection: 'away', moneylineRuleId: 'unknown' };
  assert.equal(validateNhlMarket(row, testOptions(row)).ok, false);
});
test('Reader envelope preserves wrong league and duplicate evidence as errors', () => {
  assert.equal(normalizeNhlReaderMarkets({ league: 'MLB', book: 'TAI888', markets: [] }).status, 'BLOCK');
  assert.equal(normalizeNhlReaderMarkets({ league: 'NHL', book: 'TAI888', markets: [] }).status, 'WAITING_REAL_DATA');
  const result = normalizeNhlReaderMarkets({ league: 'NHL', book: 'TAI888', markets: [market, market] }, testOptions(market));
  assert.equal(result.markets[0].ok, true);
  assert.deepEqual(result.markets[1].errors, ['DUPLICATE_READER_MARKET']);
});
test('joint path verifies period totals, regulation tie, OT/SO winner goal, null scores', () => {
  assert.equal(validateNhlLinkedPath(tiedShootout).ok, true);
  assert.equal(validateNhlLinkedPath(regulationWin).ok, true);
  assert.equal(validateNhlLinkedPath(tiedShootout, { gameType: 3 }).ok, false);
  for (const patch of [{ final: { away: 2, home: 7 } }, { regulation: { away: null, home: 2 } },
    { outcome: { ...tiedShootout.outcome, overtime: false } }, { periodScores: [] }]) {
    assert.equal(validateNhlLinkedPath({ ...tiedShootout, ...patch }).ok, false);
  }
});
test('regulation, period, full game and excluding-SO scopes project one shared path', () => {
  const regulation = checked(market);
  const full = checked({ ...market, scoreScope: 'GAME', includesOvertime: true, shootoutRule: 'OFFICIAL_ONE_GOAL' });
  const noSO = checked({ ...market, scoreScope: 'GAME', includesOvertime: true, shootoutRule: 'EXCLUDED' });
  const period = checked({ ...market, scoreScope: 'PERIOD', period: 2 });
  assert.deepEqual(projectNhlContractScore(tiedShootout, regulation), { away: 2, home: 2 });
  assert.deepEqual(projectNhlContractScore(tiedShootout, full), { away: 2, home: 3 });
  assert.deepEqual(projectNhlContractScore(tiedShootout, noSO), { away: 2, home: 2 });
  assert.deepEqual(projectNhlContractScore(tiedShootout, period), { away: 0, home: 1 });
});
test('shared Taiwan exact-line push has zero rebate; nonpush gets 150 per 10000', () => {
  const contract = checked(market);
  const pushed = nhlPayoffForScore(contract, { away: 2, home: 2 }, { stake: 10000 });
  assert.equal(pushed.profit, 0);
  assert.equal(pushed.rebate, 0);
  const won = nhlPayoffForScore(contract, { away: 3, home: 2 }, { stake: 10000 });
  assert.equal(won.profit, 9650);
  assert.equal(won.rebate, 150);
  const partial = nhlPayoffForScore(checked({ ...market, pick: '大4+20' }), { away: 2, home: 2 }, { stake: 10000 });
  assert.equal(partial.profit, 1930);
  assert.equal(partial.rebate, 30);
});
test('split-line settlement uses per-leg water and rebate without shared-engine edits', () => {
  const payoff = nhlPayoffForScore(checked({ ...market, pick: '大4/4.5', water: [0.95, 0.93] }), { away: 2, home: 2 }, { stake: 10000 });
  assert.equal(payoff.profit, -4925);
  assert.equal(payoff.rebate, 75);
});
test('ambiguous displayed team aliases cannot change selected team identity', () => {
  const row = { ...market, marketType: 'SPREAD', selection: 'away', pick: 'ABC讓0', awayName: 'ABC', homeName: 'ABCD' };
  const payout = nhlPayoffForScore(checked(row), { away: 2, home: 1 });
  assert.equal(payout.profit, 0.965);
  assert.equal(validateNhlMarket({ ...row, pick: 'ABCD讓0' }, testOptions(row)).ok, false);
});

const distribution = { game, distributionId: 'synthetic-distribution', modelArtifactId: 'synthetic-model', dataQuality: 0.8, readyForFormal: false,
  scenarios: [{ id: 'goalie-a', weight: 0.2, paths: [tiedShootout] }, { id: 'goalie-b', weight: 0.8, paths: [regulationWin] }] };
const artifact = {
  validated: true, kind: 'NHL_PAYOFF_OOS_ERROR', modelArtifactId: 'synthetic-model', sourceHash: 'SYNTHETIC-OOS',
  calibrationMethod: 'SYNTHETIC-test-injected-margin', sampleCount: 100,
  payoffContractKey: nhlPayoffCalibrationKey(market), settlementRuleVersion: SETTLEMENT_RULE_VERSION,
  rebateRate: 0.015, modelErrorMarginEV: 0.1, trainingCutoff: '2024-01-01T00:00:00Z',
  validationStart: '2024-01-02T00:00:00Z', validationCutoff: '2025-01-01T00:00:00Z',
};
test('W integrates all weighted scenarios; missing EV calibration gives null R/S, not guessed zero haircut', () => {
  const [row] = evaluateNhlMarkets({ distribution, markets: [market], ...testOptions(market) });
  assert.ok(Math.abs(row.weightedEV - 0.772) < 1e-12);
  assert.equal(row.robustEV, null);
  assert.equal(row.score, null);
  assert.equal(row.status, 'BLOCK');
  assert.ok(row.errors.includes('NHL_PAYOFF_OOS_CALIBRATION_MISSING'));
});
test('R keeps min(W, weighted Q10, W minus empirical error); diagnostic quality never blocks alone', () => {
  const [row] = evaluateNhlMarkets({ distribution, markets: [market], calibrationArtifact: artifact, ...testOptions(market) });
  assert.equal(row.scenarioQ10EV, 0);
  assert.equal(row.robustEV, 0);
  assert.equal(row.status, 'WARNING');
  assert.equal(row.errors.length, 0);
  assert.ok(row.warnings.includes('DATA_QUALITY_BELOW_085'));
  assert.ok(row.warnings.includes('W_R_SCENARIO_GAP_OVER_5_PERCENT'));
  assert.equal(row.formalEligible, false);
});
test('score calibration is not payoff calibration; future OOS and different water are rejected', () => {
  for (const calibrationArtifact of [{ ...artifact, kind: 'CHRONOLOGICAL_SCORE_BRIER' },
    { ...artifact, validationCutoff: '2027-01-01' }, { ...artifact, modelErrorMarginEV: null },
    { ...artifact, payoffContractKey: nhlPayoffCalibrationKey({ ...market, water: 0.93 }) }]) {
    const [row] = evaluateNhlMarkets({ distribution, markets: [market], calibrationArtifact, ...testOptions(market) });
    assert.equal(row.robustEV, null);
  }
});
test('mass and model identity errors block instead of normalizing or leaking other leagues', () => {
  const invalids = [{ ...distribution, game: { ...game, league: 'NBA' } },
    { ...distribution, scenarios: {} }, { ...distribution, scenarios: [{ id: 'x', weight: 1, paths: {} }] },
    { ...distribution, qa: { passed: false } },
    { ...distribution, scenarios: [{ ...distribution.scenarios[0], weight: 0.3 }] },
    { ...distribution, scenarios: [{ id: 'x', weight: 1, paths: [{ ...tiedShootout, probability: 0.9 }] }] }];
  for (const invalid of invalids) assert.equal(auditNhlEvDistribution(invalid).ok, false);
  const [row] = evaluateNhlMarkets({ distribution: { ...distribution, game: { ...game, gameId: 'wrong' } }, markets: [market], ...testOptions(market) });
  assert.equal(row.weightedEV, null);
});
test('complementary over/under use same path and preserve signed Taiwan settlements', () => {
  const over = checked({ ...market, pick: '大4+20' });
  const under = checked({ ...market, pick: '小4+20', selection: 'under' });
  for (const path of [tiedShootout, regulationWin]) {
    const a = nhlPayoffForScore(over, projectNhlContractScore(path, over));
    const b = nhlPayoffForScore(under, projectNhlContractScore(path, under));
    assert.equal(a.settlement.netFraction + b.settlement.netFraction, 0);
    assert.equal(a.settlement.winFraction, b.settlement.lossFraction);
  }
});

const ticket = { league: 'NHL', status: 'OPEN', stake: 10000, contract: market, gameType: 'REGULAR' };
const officialResult = { ...game, ...tiedShootout, gameType: 'REGULAR', verified: true, sourceHash: 'synthetic-result', observedAt: '2026-09-06T00:05:00Z', status: 'FINAL' };
test('settlement verifies identity and complete official result; pending/canceled cannot settle', () => {
  const result = settleNhlTicket(ticket, officialResult, testOptions(market));
  assert.equal(result.ok, true);
  assert.equal(result.profit, 0);
  for (const patch of [{ verified: false }, { status: 'LIVE' }, { gameId: 'other' }, { gameType: 'PRESEASON' },
    { final: { away: null, home: 3 } }, { sourceHash: '' }]) {
    assert.equal(settleNhlTicket(ticket, { ...officialResult, ...patch }, testOptions(market)).ok, false);
  }
  assert.equal(settleNhlTicket({ ...ticket, status: 'CANCELED' }, officialResult, testOptions(market)).ok, false);
});
test('completed period can settle only with explicit verified completion', () => {
  const periodMarket = { ...market, scoreScope: 'PERIOD', period: 1, pick: '大0.5' };
  const partial = { ...game, gameType: 'REGULAR', verified: true, sourceHash: 'synthetic-period', observedAt: '2026-09-06T00:05:00Z', status: 'INTERMISSION',
    periodScores: [{ period: 1, away: 1, home: 0, complete: true }] };
  assert.equal(settleNhlTicket({ ...ticket, contract: periodMarket }, partial, testOptions(periodMarket)).profit, 9650);
  partial.periodScores[0].complete = false;
  assert.equal(settleNhlTicket({ ...ticket, contract: periodMarket }, partial, testOptions(periodMarket)).ok, false);
});
test('OT/SO final versus regulation settlement differs only by documented score scope', () => {
  const full = { ...market, scoreScope: 'GAME', includesOvertime: true, shootoutRule: 'OFFICIAL_ONE_GOAL' };
  assert.equal(settleNhlTicket({ ...ticket, contract: full }, officialResult, testOptions(full)).profit, 9650);
  assert.equal(settleNhlTicket(ticket, officialResult, testOptions(market)).profit, 0);
});
test('CLV is exact at symbolic breakpoints even far outside a baseball score grid', () => {
  const placed = { ...market, pick: '大400.5' };
  const current = { ...market, pick: '大401.5', lineVersion: 'synthetic-2' };
  const result = compareNhlContracts(placed, current, testOptions(placed));
  assert.equal(result.comparable, true);
  assert.equal(result.lineStatus, 'BETTER');
  assert.equal(result.combinedStatus, 'BETTER');
  assert.ok(result.evaluatedBreakpoints.some(row => row.value === 401));
  assert.equal(compareNhlContracts(placed, { ...current, gameId: 'other' }, testOptions(placed)).comparable, false);
});
test('CLV mixed line/water advantage is reported rather than forced into better/worse', () => {
  const result = compareNhlContracts({ ...market, pick: '大4.5', water: 0.9 }, { ...market, pick: '大5.5', water: 0.99 }, testOptions(market));
  assert.equal(result.combinedStatus, 'MIXED');
});
test('preseason P&L cannot contaminate regular or playoff performance', () => {
  const settlement = settleNhlTicket(ticket, officialResult, testOptions(market));
  const preseasonTicket = { ...ticket, gameType: 'PRESEASON' };
  const preseasonSettlement = settleNhlTicket(preseasonTicket, { ...officialResult, gameType: 'PRESEASON' }, testOptions(market));
  const stats = summarizeNhlTicketPerformance([
    { ...ticket, status: 'SETTLED', settlement }, { ...preseasonTicket, status: 'SETTLED', settlement: preseasonSettlement },
    { ...ticket, league: 'NBA', status: 'SETTLED', settlement }, { ...ticket, status: 'CANCELED' },
  ]);
  assert.equal(stats.regular.count, 1);
  assert.equal(stats.preseasonShadow.count, 1);
  assert.equal(stats.playoff.count, 0);
  assert.equal(stats.excluded, 2);
});
console.log(`NHL contract/EV/settlement: ${checks} synthetic mathematical tests PASS; real Tai888 market validation remains pending.`);
