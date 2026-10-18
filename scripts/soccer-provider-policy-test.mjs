import assert from 'node:assert/strict';
import { soccerProviderPolicy, SOCCER_PROVIDER_POLICY_VERSION } from '../lib/soccer/provider-policy.js';
import { evaluateSoccerQuote } from '../lib/soccer/market-payoff.js';
import { NBA_FORWARD_RULE } from '../lib/nba/forward-validation.js';

const policy = soccerProviderPolicy({ asOf: '2026-10-18T22:15:31Z' });
assert.equal(policy.version, SOCCER_PROVIDER_POLICY_VERSION);
assert.deepEqual(policy.leagues, ['EPL', 'UCL']);
assert.equal(policy.rebateRate, 0.01);
assert.equal(policy.rebateRateStatus, 'USER_CONFIRMED');
assert.deepEqual(policy.rateConfirmation, {
  source: 'user_instruction', confirmedAt: '2026-10-18T20:53:42Z', confirmedFields: ['rebateRate'],
});
assert.equal(policy.rebateBasis, 'TOTAL_PRINCIPAL');
assert.equal(policy.rebateBasisStatus, 'USER_CONFIRMED');
assert.equal(policy.rebateApplicability, 'UNKNOWN');
assert.deepEqual(policy.basisConfirmation, {
  source: 'user_instruction', confirmedAt: '2026-10-18T22:15:31Z', confirmedFields: ['rebateBasis'],
});
assert.equal(10000 * policy.rebateRate, 100);
assert.equal(policy.period, 'UNKNOWN');
assert.equal(policy.boundarySettlement, 'UNKNOWN');
assert.equal(policy.abnormalSettlement, 'UNKNOWN');
assert.equal(policy.sourceContractGatePassed, false);
assert.equal(policy.formalContractVerified, false);

// A detached immutable snapshot is safe to share with API/client rendering.
const second = soccerProviderPolicy();
assert.notEqual(policy, second); assert.notEqual(policy.leagues, second.leagues);
assert.ok(Object.isFrozen(policy)); assert.ok(Object.isFrozen(policy.leagues));
assert.ok(Object.isFrozen(policy.basisConfirmation)); assert.ok(Object.isFrozen(policy.basisConfirmation.confirmedFields));
assert.ok(Object.isFrozen(policy.rateConfirmation)); assert.ok(Object.isFrozen(policy.rateConfirmation.confirmedFields));
assert.throws(() => { policy.rebateRate = 0.015; }, TypeError);
assert.throws(() => { policy.rateConfirmation.confirmedFields.push('rebateBasis'); }, TypeError);
assert.equal(soccerProviderPolicy().rebateRate, 0.01);

// Today's confirmation cannot be retrospectively available to older analyses.
for (const asOf of ['2026-10-18T12:00:00Z', Date.parse('2026-10-18T12:00:00Z'),
  'not-a-date', null, NaN, Infinity, 1e20, {}, '2026-10-18T20:53:42']) {
  const historical = soccerProviderPolicy({ asOf });
  assert.equal(historical.rebateRate, null);
  assert.equal(historical.rebateRateStatus, 'UNKNOWN');
  assert.equal(historical.rebateBasis, 'UNKNOWN');
  assert.equal(historical.rebateBasisStatus, 'UNKNOWN');
  assert.equal(historical.calculationPolicy, 'RATE_UNAVAILABLE_AT_CUTOFF_CONTRACT_INCOMPLETE');
  assert.equal(historical.rateConfirmation.confirmedAt, '2026-10-18T20:53:42Z');
  assert.equal(historical.sourceContractGatePassed, false);
}
assert.equal(soccerProviderPolicy({ asOf: '2026-10-18T20:53:41.999Z' }).rebateRate, null);
assert.equal(soccerProviderPolicy({ asOf: '2026-10-18T20:53:42Z' }).rebateRate, 0.01);
assert.equal(soccerProviderPolicy({ asOf: Date.parse('2026-10-18T20:53:42Z') }).rebateRate, 0.01);

// The later basis confirmation cannot be backdated to the earlier rate instruction.
for (const asOf of ['2026-10-18T20:53:42Z', '2026-10-18T22:15:30.999Z',
  Date.parse('2026-10-18T22:15:30.999Z')]) {
  const historical = soccerProviderPolicy({ asOf });
  assert.equal(historical.rebateRate, 0.01);
  assert.equal(historical.rebateRateStatus, 'USER_CONFIRMED');
  assert.equal(historical.rebateBasis, 'UNKNOWN');
  assert.equal(historical.rebateBasisStatus, 'UNKNOWN');
  assert.equal(historical.calculationPolicy, 'RATE_CONFIRMED_CONTRACT_INCOMPLETE');
}
for (const asOf of ['2026-10-18T22:15:31Z', '2026-10-19T06:15:31+08:00', Date.parse('2026-10-18T22:15:31Z')]) {
  const current = soccerProviderPolicy({ asOf });
  assert.equal(current.rebateRate, 0.01);
  assert.equal(current.rebateBasis, 'TOTAL_PRINCIPAL');
  assert.equal(current.rebateBasisStatus, 'USER_CONFIRMED');
  assert.equal(current.calculationPolicy, 'RATE_AND_BASIS_CONFIRMED_CONTRACT_INCOMPLETE');
  assert.equal(current.rebateApplicability, 'UNKNOWN');
  assert.equal(current.sourceContractGatePassed, false);
  assert.equal(current.formalContractVerified, false);
}

// Compare against existing NBA policy without mutating its rule or files.
assert.equal(NBA_FORWARD_RULE.rebateRate, 0.015);
assert.notEqual(policy.rebateRate, NBA_FORWARD_RULE.rebateRate);

// Rate-only snapshots still fail the missing-basis guard; the later basis must not leak into them.
const rateOnly = soccerProviderPolicy({ asOf: '2026-10-18T22:15:30.999Z' });
const quote = { kind: 'TOTAL', direction: 'OVER', sourceLine: '2', period: 'FT', water: 0.9, waterFormat: 'PROFIT_PER_UNIT' };
const distribution = { period: 'REGULATION_FT', retainedMass: 1, tailMass: 0,
  cells: [{ home: 2, away: 1, probability: 1 }] };
const incomplete = evaluateSoccerQuote({ quote, distribution, contract: {
  type: 'ASIAN_SPLIT', period: 'FT', rebate: { rate: rateOnly.rebateRate, basis: rateOnly.rebateBasis },
  provenance: { status: 'ASSUMPTION' },
} });
assert.equal(incomplete.ok, false); assert.equal(incomplete.netEV, null);
assert.ok(incomplete.missing.includes('contract.rebate.basis'));
assert.equal(incomplete.executable, false); assert.equal(incomplete.W, null);

// Even the confirmed rate and basis cannot supply the missing source contract.
const noContract = evaluateSoccerQuote({ quote, distribution, contract: null });
assert.equal(noContract.ok, false); assert.equal(noContract.netEV, null);
assert.equal(noContract.executable, false); assert.equal(noContract.W, null);

// Complete explicit assumptions permit scenario arithmetic without certifying a contract.
const scenario = evaluateSoccerQuote({ quote, distribution, contract: {
  type: 'ASIAN_SPLIT', period: 'FT', rebate: { rate: policy.rebateRate, basis: policy.rebateBasis },
  provenance: { status: 'ASSUMPTION', note: 'rate and basis confirmed; mechanism and period are test assumptions' },
} });
assert.equal(scenario.status, 'UNVERIFIED_ASSUMPTION');
assert.ok(Math.abs(scenario.retainedEV.rebate - 0.01) < 1e-12);
assert.ok(Math.abs(scenario.netEV - 0.91) < 1e-12);
assert.equal(scenario.executable, false); assert.equal(scenario.W, null);
console.log('PASS soccer provider policy: user-confirmed 1% of stake, independent rate/basis time boundaries, NBA 1.5% isolated, immutable snapshots and incomplete contract cannot enable formal scoring');
