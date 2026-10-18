import assert from 'node:assert/strict';
import { soccerProviderPolicy, SOCCER_PROVIDER_POLICY_VERSION } from '../lib/soccer/provider-policy.js';
import { evaluateSoccerQuote } from '../lib/soccer/market-payoff.js';
import { NBA_FORWARD_RULE } from '../lib/nba/forward-validation.js';

const policy = soccerProviderPolicy();
assert.equal(policy.version, SOCCER_PROVIDER_POLICY_VERSION);
assert.deepEqual(policy.leagues, ['EPL', 'UCL']);
assert.equal(policy.rebateRate, 0.01);
assert.equal(policy.rebateRateStatus, 'USER_CONFIRMED');
assert.deepEqual(policy.rateConfirmation, {
  source: 'user_instruction', confirmedAt: '2026-10-18T20:53:42Z', confirmedFields: ['rebateRate'],
});
assert.equal(policy.rebateBasis, 'UNKNOWN');
assert.equal(policy.period, 'UNKNOWN');
assert.equal(policy.boundarySettlement, 'UNKNOWN');
assert.equal(policy.abnormalSettlement, 'UNKNOWN');
assert.equal(policy.sourceContractGatePassed, false);
assert.equal(policy.formalContractVerified, false);

// A detached immutable snapshot is safe to share with API/client rendering.
const second = soccerProviderPolicy();
assert.notEqual(policy, second); assert.notEqual(policy.leagues, second.leagues);
assert.ok(Object.isFrozen(policy)); assert.ok(Object.isFrozen(policy.leagues));
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
  assert.equal(historical.calculationPolicy, 'RATE_UNAVAILABLE_AT_CUTOFF_CONTRACT_INCOMPLETE');
  assert.equal(historical.rateConfirmation.confirmedAt, '2026-10-18T20:53:42Z');
  assert.equal(historical.sourceContractGatePassed, false);
}
assert.equal(soccerProviderPolicy({ asOf: '2026-10-18T20:53:41.999Z' }).rebateRate, null);
assert.equal(soccerProviderPolicy({ asOf: '2026-10-18T20:53:42Z' }).rebateRate, 0.01);
assert.equal(soccerProviderPolicy({ asOf: Date.parse('2026-10-18T20:53:42Z') }).rebateRate, 0.01);

// Compare against existing NBA policy without mutating its rule or files.
assert.equal(NBA_FORWARD_RULE.rebateRate, 0.015);
assert.notEqual(policy.rebateRate, NBA_FORWARD_RULE.rebateRate);

// The confirmed rate alone must not bypass the missing-basis contract guard.
const quote = { kind: 'TOTAL', direction: 'OVER', sourceLine: '2', period: 'FT', water: 0.9, waterFormat: 'PROFIT_PER_UNIT' };
const distribution = { period: 'REGULATION_FT', retainedMass: 1, tailMass: 0,
  cells: [{ home: 2, away: 1, probability: 1 }] };
const incomplete = evaluateSoccerQuote({ quote, distribution, contract: {
  type: 'ASIAN_SPLIT', period: 'FT', rebate: { rate: policy.rebateRate, basis: policy.rebateBasis },
  provenance: { status: 'ASSUMPTION' },
} });
assert.equal(incomplete.ok, false); assert.equal(incomplete.netEV, null);
assert.ok(incomplete.missing.includes('contract.rebate.basis'));
assert.equal(incomplete.executable, false); assert.equal(incomplete.W, null);

// When an explicit scenario supplies the still-unverified basis, the 1% rate
// affects that scenario only; it does not certify the provider's full contract.
const scenario = evaluateSoccerQuote({ quote, distribution, contract: {
  type: 'ASIAN_SPLIT', period: 'FT', rebate: { rate: policy.rebateRate, basis: 'SETTLED_PRINCIPAL' },
  provenance: { status: 'ASSUMPTION', note: 'basis is a test assumption, rate is user confirmed' },
} });
assert.equal(scenario.status, 'UNVERIFIED_ASSUMPTION');
assert.ok(Math.abs(scenario.retainedEV.rebate - 0.01) < 1e-12);
assert.ok(Math.abs(scenario.netEV - 0.91) < 1e-12);
assert.equal(scenario.executable, false); assert.equal(scenario.W, null);
console.log('PASS soccer provider policy: user-confirmed 1% rate, NBA 1.5% isolated, detached frozen client-safe snapshot, basis/period/contract remain unknown and cannot enable formal scoring');
