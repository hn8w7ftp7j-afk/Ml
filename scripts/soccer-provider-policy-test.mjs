import assert from 'node:assert/strict';
import { soccerProviderPolicy, SOCCER_PROVIDER_POLICY_VERSION } from '../lib/soccer/provider-policy.js';
import { evaluateSoccerQuote } from '../lib/soccer/market-payoff.js';
import { NBA_FORWARD_RULE } from '../lib/nba/forward-validation.js';
import { soccerSettlementMissingTerms } from '../lib/soccer/settlement-contract.js';
import { soccerCreditRuleConfirmation } from '../lib/soccer/credit-rule-confirmation.js';

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

const confirmation='2026-10-20T09:11:48Z';
const fractional=soccerProviderPolicy({asOf:confirmation});
assert.equal(fractional.rebateBasis,'SETTLED_PRINCIPAL');
assert.equal(fractional.rebateApplicability,'WIN_AND_LOSS_FRACTIONS_EXCLUDING_PUSH');
assert.equal(fractional.rebateApplicabilityStatus,'USER_CONFIRMED');
assert.equal(fractional.settlementConfirmation.confirmedAt,confirmation);
assert.equal(fractional.rebateFormula,'stake * (winFraction + lossFraction) * 0.01');
for(const example of fractional.settlementConfirmation.examples){
  assert.ok(Math.abs((example.winFraction+example.lossFraction)*fractional.rebateRate-example.rate)<1e-12);
}
const beforeFractional=soccerProviderPolicy({asOf:Date.parse(confirmation)-1});
assert.equal(beforeFractional.rebateBasis,'TOTAL_PRINCIPAL');
assert.equal(beforeFractional.rebateApplicability,'UNKNOWN');
assert.equal(beforeFractional.rebateFormula,null);
assert.equal(fractional.formalContractVerified,false);
assert.equal(NBA_FORWARD_RULE.rebateRate,.015);
assert.equal(soccerSettlementMissingTerms(confirmation).some(term=>term.code==='REBATE_ELIGIBLE_SETTLEMENT_STATES'),false);
assert.equal(soccerSettlementMissingTerms(Date.parse(confirmation)-1).find(term=>term.code==='REBATE_ELIGIBLE_SETTLEMENT_STATES').status,'UNKNOWN');
console.log('PASS confirmed football fractional principal: full/half/20% wins/losses and no push rebate, exact confirmation cutoff and unchanged NBA policy');

const creditReceipt=soccerCreditRuleConfirmation('2026-10-30T15:01:39Z');
assert.equal(creditReceipt.status,'USER_CONFIRMED');
assert.equal(creditReceipt.formalContractVerified,false);
assert.deepEqual(creditReceipt.examples.map(e=>[e.line,e.netProfit]),[['1+20',182],['1-20',-198],['1平',0]]);
assert.ok(Object.isFrozen(creditReceipt.examples[0]));
for(const cutoff of ['2026-10-30T15:01:38.999Z','2026-10-30T15:01:39',null,NaN,Infinity,1e20,{}]){
  assert.equal(soccerCreditRuleConfirmation(cutoff).status,'NOT_YET_CONFIRMED');
  assert.deepEqual(soccerCreditRuleConfirmation(cutoff).examples,[]);
}
// Reproduce the user's amounts through the shipped payoff engine, for both home
// and away giving sides. This checks arithmetic, not empirical model acceptance.
for(const league of creditReceipt.leagues)for(const period of ['FT','HT'])for(const giving of ['home','away'])for(const example of creditReceipt.examples){
  const amount=evaluateSoccerQuote({
    quote:{league,kind:'HANDICAP',direction:giving.toUpperCase(),sourceLine:example.line,lineSide:giving,period,water:example.water,waterFormat:'PROFIT_PER_UNIT'},
    distribution:{period:period==='FT'?'REGULATION_FT':'REGULATION_HT',retainedMass:1,tailMass:0,cells:[{home:giving==='home'?1:0,away:giving==='away'?1:0,probability:1}]},
    contract:{type:'CREDIT_BOUNDARY',period,labelMapping:{home:'主隊',away:'客隊'},rebate:{rate:.01,basis:'SETTLED_PRINCIPAL'},provenance:{status:'ASSUMPTION'}},
  });
  assert.equal(amount.ok,true);
  assert.ok(Math.abs(amount.netEV*example.stake-example.netProfit)<1e-9);
  assert.ok(Math.abs(amount.retainedEV.rebate*example.stake-example.rebate)<1e-9);
  assert.equal(amount.formalScoringEnabled,false);
  assert.equal(amount.R,null);assert.equal(amount.S,null);
}
const currentTerms=soccerSettlementMissingTerms(creditReceipt.confirmedAt);
assert.equal(currentTerms.find(t=>t.code==='INTEGER_AND_CREDIT_BOUNDARY_PAYOFF').status,'SYSTEM_BINDING_PENDING');
assert.equal(currentTerms.some(t=>t.code==='REBATE_ELIGIBLE_SETTLEMENT_STATES'),false);
assert.equal(soccerSettlementMissingTerms('2026-10-29T00:00:00Z').find(t=>t.code==='INTEGER_AND_CREDIT_BOUNDARY_PAYOFF').status,'PARTIAL');
console.log('PASS confirmed credit examples: +182/-198/0, receipt cutoff, immutable scoped examples and no invented formal model approval');
