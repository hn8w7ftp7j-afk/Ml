import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { mergeSoccerRetrospectivePayoffReports as merge } from '../lib/soccer/forward-scan-aggregate.js';

// Explicitly synthetic disjoint-game summaries exercise conservation and
// interval rounding, not observed account returns or model acceptance.
const restrictions = { accountSettlementVerified:false, historicalContractVerified:false, verifiedAtOriginalCutoff:false,
  formalEligible:false, calibrationEligible:false, promotionEligible:false, executable:false,
  W:null, R:null, S:null, empiricalErrorMargin:null };
function contribution(value, { league='epl', period='FT', modelHash='a'.repeat(64), at='2026-11-01T00:00:00Z' }={}) {
  const group={ league,period,variant:'BASELINE',modelHash,ruleHash:'b'.repeat(64),kind:'TOTAL',side:'over',
    quotes:1,games:1,exactPredictedQuotes:1,boundedPredictedQuotes:0,
    predictedNetReturnSum:{lower:value,upper:value},hypotheticalRealizedNetReturnSum:.96,
    retrospectiveErrorSum:{lower:.96-value,upper:.96-value},...restrictions };
  return { version:'SOCCER-RETROSPECTIVE-CONFIRMED-RULE-PAYOFF-v1',status:'RESEARCH_REPLAY_AVAILABLE',
    interpretation:'TEST_REPLAY_HYPOTHESIS',ruleApplication:{ruleHash:group.ruleHash,appliedAt:at},
    selectedQuoteObservations:1,replayedQuoteObservations:1,exactPredictedQuoteReturns:1,boundedPredictedQuoteReturns:0,
    pendingQuoteObservations:0,quarantinedQuoteObservations:0,uniqueReplayedGames:1,duplicateEconomicQuoteObservations:0,
    invalidOriginalQuotes:0,unpricedPredictionPeriods:0,incompleteResultHistories:0,gameContributions:1,
    completeWithinRequestedScope:true,excludedReasons:{},groups:[group],...restrictions };
}
const a=contribution(.1), b=contribution(.2,{at:'2026-11-01T00:00:01Z'}), before=JSON.stringify([a,b]);
const output=merge(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
assert.equal(output.replayedQuoteObservations,2);assert.equal(output.uniqueReplayedGames,2);
assert.equal(output.gameContributions,2);assert.equal(output.groups.length,1);
assert.equal(output.groups[0].games,2);assert.equal(output.groups[0].quotes,2);
const sum=new Decimal(.1).plus(new Decimal(.2)), bounds=output.groups[0].predictedNetReturnSum;
assert.ok(new Decimal(bounds.lower).lte(sum)&&new Decimal(bounds.upper).gte(sum),'outward bounds contain the exact decimal sum');
assert.equal(output.ruleApplication.appliedAt,null);
assert.equal(output.ruleApplication.firstAppliedAt,a.ruleApplication.appliedAt);
assert.equal(output.ruleApplication.lastAppliedAt,b.ruleApplication.appliedAt);
const three=merge(output,contribution(-.3,{at:'2026-11-01T00:00:02Z'}));
assert.equal(three.gameContributions,3);assert.equal(three.ruleApplication.firstAppliedAt,a.ruleApplication.appliedAt);
assert.equal(three.ruleApplication.lastAppliedAt,'2026-11-01T00:00:02Z');
assert.ok(three.groups[0].predictedNetReturnSum.lower<=0&&three.groups[0].predictedNetReturnSum.upper>=0);
assert.equal(JSON.stringify([a,b]),before,'merging cannot mutate saved per-game contributions');
for(const variant of [{league:'ucl'},{period:'HT'},{modelHash:'c'.repeat(64)}])
  assert.equal(merge(a,contribution(.2,variant)).groups.length,2,'league, period and model remain separate');
assert.equal(merge(a,{...b,completeWithinRequestedScope:false}).completeWithinRequestedScope,false);
assert.equal(merge(a,{...b,completeWithinRequestedScope:false}).status,'PARTIAL');
assert.equal(merge(a,{...b,pendingQuoteObservations:1}).status,'PARTIAL');
for(const field of ['accountSettlementVerified','historicalContractVerified','verifiedAtOriginalCutoff','formalEligible','calibrationEligible','promotionEligible','executable']) {
  assert.throws(()=>merge(a,{...b,[field]:true}),/PROMOTION_REJECTED/);
  const forged=structuredClone(b);forged.groups[0][field]=true;
  assert.throws(()=>merge(a,forged),/PROMOTION_REJECTED/);
}
for(const field of ['W','R','S','empiricalErrorMargin'])assert.throws(()=>merge(a,{...b,[field]:0}),/PROMOTION_REJECTED/);
assert.throws(()=>merge(a,{...b,selectedQuoteObservations:-1}),/COUNT_INVALID/);
const bad=structuredClone(b);bad.groups[0].predictedNetReturnSum.lower=Infinity;
assert.throws(()=>merge(a,bad),/METRIC_INVALID/);
assert.throws(()=>merge(a,{...b,ruleApplication:{...b.ruleApplication,ruleHash:'d'.repeat(64)}}),/REPLAY_RULE_HASH/);
console.log('PASS retrospective replay aggregation: disjoint-game counts, exact decimal containment, JSON continuation, source/model/period isolation, rule application interval and fail-closed research restrictions');
