import assert from 'node:assert/strict';
import { buildSoccerProbabilityAudit, soccerProbabilityAuditFields, SOCCER_PROBABILITY_AUDIT_VERSION } from '../lib/soccer/probability-audit.js';
import { SOCCER_MODEL_VERSION, scoreDistribution, predictScoreModel, evaluateScoreModel, soccerScoreLogProbability } from '../lib/soccer/score-model.js';
import { fitHalfTimeModel, evaluateHalfTimeModel } from '../lib/soccer/half-time-model.js';
const near=(a,b,t=1e-12)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const scope={league:'epl',period:'REGULATION_FT',fold:'diagnostic-2025',modelHash:'model-hash'};
const record=(eventId,probabilities={home:1/3,draw:1/3,away:1/3},actualOutcome='home',extra={})=>({eventId:String(eventId),status:'EVALUATED',...scope,probabilities,actualOutcome,...extra});
const rows=Array.from({length:6},(_,i)=>record(i+1));
const original=JSON.stringify(rows),a=buildSoccerProbabilityAudit(rows,scope);
assert.equal(a.version,SOCCER_PROBABILITY_AUDIT_VERSION);assert.equal(a.pooledEventCount,18);assert.equal(a.cohort.used,6);
for(const [key,ece,rel] of [['home',2/3,4/9],['draw',1/3,1/9],['away',1/3,1/9]]){const c=a.classes[key];assert.equal(c.count,6);near(c.ECE_L1,ece);near(c.REL_L2,rel);assert.equal(c.bins.reduce((s,b)=>s+b.count,0),6);assert.equal(c.bins.filter(b=>b.count).length,1);}
const pooledMeanPrediction=rows.flatMap(r=>Object.values(r.probabilities)).reduce((s,p)=>s+p,0)/18;near(pooledMeanPrediction,1/3);near(6/18,pooledMeanPrediction);
assert.equal(JSON.stringify(rows),original);assert.equal(a.estimator.biasCorrected,false);assert.equal(a.estimator.fullMurphyDecomposition,false);assert.equal(a.formalEnabled,false);
console.log('PASS uniform forecasts with all-home outcomes expose class errors hidden by perfect pooled calibration; class N and pooled 3N remain distinct');

const edges=buildSoccerProbabilityAudit([0,.1,.2,.9,1].map((p,i)=>record(i+1,{home:p,draw:1-p,away:0})));
for(const [index,count] of [[0,1],[1,1],[2,1],[9,2]])assert.equal(edges.classes.home.bins[index].count,count);
assert.equal(edges.classes.home.bins[8].count,0);assert.equal(edges.classes.home.bins[8].meanPredicted,null);assert.equal(edges.classes.home.bins[8].observedFrequency,null);assert.equal(edges.classes.home.bins[9].upperInclusive,true);
const empty=buildSoccerProbabilityAudit([]);assert.equal(empty.cohort.sample,0);assert.equal(empty.classes.home.ECE_L1,null);assert.equal(empty.classes.home.REL_L2,null);
const small=buildSoccerProbabilityAudit([record(1,{home:1,draw:0,away:0})]);assert.equal(small.classes.home.count,1);near(small.classes.home.REL_L2,0);
console.log('PASS fixed left-closed bins include exact boundaries and p=1 without rounding; empty and one-record bins retain honest support');

const bads=[NaN,Infinity,-.1,1.1].map((p,i)=>record(i+10,{home:p,draw:0,away:1}));
const combined=buildSoccerProbabilityAudit([rows[0],...bads,{eventId:'99',status:'SKIPPED',reason:'SOCCER_TEAM_NOT_TRAINED',...scope}]);
assert.equal(combined.cohort.sample,6);assert.equal(combined.cohort.used,1);assert.equal(combined.cohort.excluded,5);assert.deepEqual(combined.classes,buildSoccerProbabilityAudit([rows[0]]).classes);assert.equal(combined.cohort.reasons.reduce((s,r)=>s+r.count,0),5);
const missingId=buildSoccerProbabilityAudit([{...rows[0],eventId:null}]);assert.equal(missingId.cohort.used,0);assert.equal(missingId.cohort.reasons[0].code,'AUDIT_EVENT_ID_MISSING');
for(const eventId of [{},[],true,'  '])assert.equal(buildSoccerProbabilityAudit([{...rows[0],eventId}]).cohort.missingIdentityRecords,1);
const mixedScope=buildSoccerProbabilityAudit([rows[0],{...rows[1],league:'ucl'}],scope);assert.equal(mixedScope.cohort.used,1);assert.equal(mixedScope.cohort.reasons[0].code,'AUDIT_SCOPE_MISMATCH');
const duplicate=buildSoccerProbabilityAudit([rows[0],rows[0]]);assert.equal(duplicate.cohort.sample,2);assert.equal(duplicate.cohort.used,2);assert.equal(duplicate.cohort.uniqueGames,1);assert.equal(duplicate.cohort.duplicateRecords,1);assert.equal(duplicate.cohort.independenceAssumed,false);
const unknown=buildSoccerProbabilityAudit([{eventId:'100',status:'EVALUATED',probabilities:{home:1,draw:0,away:0},actualOutcome:'home'}]);assert.equal(unknown.fold,null);assert.equal(unknown.modelHash,null);assert.equal(unknown.missingMetadata.modelHash,1);
console.log('PASS invalid records are excluded before any numerator update; original cohort, exclusion reasons, duplicate games and unknown metadata remain explicit');

const tail=1e-12,sub=record(1,{home:.5-tail,draw:.3,away:.2},'home',{retainedMass:1-tail,tailMass:tail});
const t=buildSoccerProbabilityAudit([sub]);assert.equal(t.cohort.used,1);near(t.classes.home.bins[4].meanPredicted,.5-tail);assert.equal(t.probabilityMass.renormalized,false);assert.equal(t.probabilityMass.tailAffectedGames,1);
const noTail=buildSoccerProbabilityAudit([record(1,{home:.4,draw:.3,away:.2})]);assert.equal(noTail.cohort.reasons[0].code,'AUDIT_PROBABILITY_MASS_UNVERIFIED');
const large=buildSoccerProbabilityAudit([record(1,{home:.4,draw:.3,away:.2},'home',{retainedMass:.9,tailMass:.1})]);assert.equal(large.cohort.reasons[0].code,'AUDIT_OMITTED_MASS_EXCEEDS_TOLERANCE');assert.equal(large.classes.home.ECE_L1,null);
const wrongTail=buildSoccerProbabilityAudit([{...sub,retainedMass:.7}]);assert.equal(wrongTail.cohort.used,0);
console.log('PASS known tiny tails remain unnormalized; missing, contradictory or large omitted mass is audit-excluded without masquerading as complete probabilities');

const ftModel={version:SOCCER_MODEL_VERSION,league:'epl',period:'REGULATION_FT',cutoff:'2024-01-01T00:00:00.000Z',trainingHash:'original-training-hash',intercept:0,homeEffect:0,rho:0,coefficients:{'1':{attack:0,defence:0},'2':{attack:0,defence:0}},fit:{converged:true}};
const source={url:'https://example.invalid/retained',contentHash:'source-hash'};
const game={eventId:'101',league:'epl',homeId:'1',awayId:'2',startTime:'2025-01-01T12:00:00.000Z',period:'REGULATION_FT',homeGoals:0,awayGoals:0,source};
const beforeModel=JSON.stringify(ftModel),beforePrediction=predictScoreModel(ftModel,game),metric=evaluateScoreModel(ftModel,[game],{fold:'diagnostic-2025'});
assert.equal(JSON.stringify(ftModel),beforeModel);assert.deepEqual(predictScoreModel(ftModel,game),beforePrediction);assert.equal(metric.scoreLogLoss,2);near(metric.logLoss,-Math.log(beforePrediction.outcomes.draw));near(metric.brier,Object.entries(beforePrediction.outcomes).reduce((s,[k,p])=>s+(p-(k==='draw'?1:0))**2,0));
assert.equal(metric.bins.reduce((s,b)=>s+b.count,0),3);assert.equal(metric.probabilityAudit.classes.home.count,1);assert.equal(metric.games[0].fold,'diagnostic-2025');assert.match(metric.games[0].modelHash,/^[a-f0-9]{64}$/);assert.equal(metric.games[0].exactScoreLogProbability,-2);assert.equal(metric.games[0].exactScoreLogProbabilityState,'FINITE');
const invalidRow=evaluateScoreModel(ftModel,[game,{...game,eventId:'102',homeGoals:-1}],{fold:'diagnostic-2025'});assert.equal(invalidRow.count,1);assert.equal(invalidRow.logLoss,metric.logLoss);assert.equal(invalidRow.brier,metric.brier);assert.equal(invalidRow.probabilityAudit.cohort.sample,2);assert.equal(invalidRow.probabilityAudit.cohort.excluded,1);
const rare={...game,homeGoals:30,awayGoals:0};assert.equal(beforePrediction.cells.some(c=>c.home===30),false);assert.ok(Number.isFinite(evaluateScoreModel(ftModel,[rare]).games[0].exactScoreLogProbability));
console.log('PASS FT evaluator preserves coefficients, predictions, original numeric metrics/pooled bins and rare-score accounting while adding replayable provenance');

const training=[{...game,eventId:'1',startTime:'2022-01-01T12:00:00.000Z',homeGoals:1,awayGoals:1,halfTime:{home:0,away:0,verified:true,source,evidence:{method:'EXPLICIT_PERIOD_1'}}}];
const htModel=fitHalfTimeModel(training,{league:'epl',cutoff:'2024-01-01T00:00:00.000Z'}),heldout={...game,homeGoals:1,awayGoals:0,halfTime:{home:1,away:0,verified:true,source,evidence:{method:'EXPLICIT_PERIOD_1'}}};
const ht=evaluateHalfTimeModel(htModel,[heldout],{predictFullTime:()=>scoreDistribution(1,1),fold:'diagnostic-2025',fullTimeModelHash:'actual-ft-model-hash'});
assert.equal(ht.count,1);assert.equal(ht.scoreLogLoss,Infinity);assert.equal(ht.logLoss,Infinity);assert.equal(ht.probabilityAudit.cohort.used,1);assert.equal(ht.games[0].exactScoreLogProbabilityState,'ZERO_MODEL_PROBABILITY');assert.equal(ht.games[0].exactScoreLogProbability,null);assert.equal(ht.games[0].fullTimeModelHash,'actual-ft-model-hash');
const restored=JSON.parse(JSON.stringify(ht.games[0]));assert.equal(restored.exactScoreLogProbabilityState,'ZERO_MODEL_PROBABILITY');assert.equal(buildSoccerProbabilityAudit([restored]).exactScoreEvidence.zeroModelProbability,1);
const tinyFT=scoreDistribution(1e-20,1),exact=soccerScoreLogProbability(1,0,tinyFT.homeRate,tinyFT.awayRate,tinyFT.rho),tinyFields=soccerProbabilityAuditFields(tinyFT,'home',exact);
assert.equal(tinyFT.outcomes.home,0);assert.ok(Number.isFinite(exact));assert.equal(tinyFields.exactScoreLogProbabilityState,'FINITE');assert.equal(tinyFields.outcomeProbabilityState,'ZERO_RETAINED_PROBABILITY');
const noFT=evaluateHalfTimeModel(htModel,[heldout],{predictFullTime:()=>scoreDistribution(1,1)});assert.equal(noFT.games[0].fullTimeModelHash,null);assert.equal(noFT.games[0].fullTimeTrainingHash,null);
console.log('PASS true zero-score probability survives JSON and stays in denominator; zero retained-grid probability is distinguished from exact model zero, and unknown FT hashes remain null');
