import assert from 'node:assert/strict';
import {defaultTraining} from '../lib/nba/analysis-training.js';
import {analyzeNbaModel,parseNbaAnalysisTotal,NBA_ANALYSIS_MODEL_VERSION} from '../lib/nba/analysis-model.js';

assert.equal(NBA_ANALYSIS_MODEL_VERSION,'nba-total-pace-rest-v1');
assert.equal(defaultTraining.history.length,1315);assert.equal(defaultTraining.predictions.length,1243);assert.equal(defaultTraining.observations.length,1243);
assert.ok(Object.isFrozen(defaultTraining));assert.ok(Object.isFrozen(defaultTraining.history[0]));
assert.equal(defaultTraining.strictPointInTime,false);assert.equal(defaultTraining.promotionEligible,false);
const historical = defaultTraining.history.find(row=>row.date==='2026-01-21' && row.seasonType==='regular');
assert.ok(historical);
const normalize = row=>({id:row.gameId,league:'NBA',taipeiDate:row.date,season:{year:row.year,type:row.seasonType},seasonType:row.seasonType,home:{id:row.homeId},away:{id:row.awayId},neutralSite:row.neutralSite});
const game=normalize(historical),quote={line:'230+50',overWater:0.94,underWater:0.93};
const result=analyzeNbaModel(game,quote);
assert.equal(result.status,'ready',JSON.stringify(result.issues));
assert.equal(result.executable,false);assert.equal(result.probabilityEstimate,null);assert.equal(result.strictPointInTime,false);assert.equal(result.promotionEligible,false);
assert.equal(result.prediction.baseTotal,result.prediction.home+result.prediction.away);
assert.equal(result.prediction.total,result.prediction.baseTotal+result.prediction.correction);
assert.ok(result.assessment.calibrationThrough < game.taipeiDate);assert.ok(result.assessment.distributionThrough < game.taipeiDate);
assert.ok(result.assessment.calibrationSamples>=50);assert.equal(result.assessment.calibrationSamples,result.assessment.distributionSamples);
assert.ok(result.assessment.paceProxy.home.priorDates.every(date=>date<game.taipeiDate));assert.ok(result.assessment.paceProxy.away.priorDates.every(date=>date<game.taipeiDate));
assert.equal(result.assessment.paceProxy.home.count,5);assert.equal(result.assessment.paceProxy.away.count,5);
assert.ok(result.assessment.restProxy.home.priorDate<game.taipeiDate);assert.ok(result.assessment.restProxy.away.priorDate<game.taipeiDate);
assert.equal(result.assessment.direction,result.assessment.positiveExpectedNet>=result.assessment.negativeExpectedNet?'over':'under');

// Current season/type is empty even though the retained archive is large.
const current={...game,id:'nba:espn:game:401900001',taipeiDate:'2026-10-05',season:{year:2027,type:'preseason'},seasonType:'preseason'};
const insufficient=analyzeNbaModel(current,quote);
assert.equal(insufficient.status,'insufficient');assert.equal(insufficient.prediction,null);assert.equal(insufficient.assessment,null);
assert.equal(insufficient.training.availableGames,0);assert.equal(insufficient.training.eligibleInnovations,0);assert.equal(insufficient.training.seasonYear,2027);assert.equal(insufficient.training.seasonType,'preseason');
const otherType=analyzeNbaModel({...game,season:{year:2026,type:'preseason'},seasonType:'preseason'},quote);
assert.equal(otherType.status,'insufficient');assert.equal(otherType.training.availableGames,0);
const tooFew=structuredClone(defaultTraining);
tooFew.observations=tooFew.observations.filter(row=>row.year===2026&&row.seasonType==='regular'&&row.date<game.taipeiDate).slice(-49);
assert.equal(analyzeNbaModel(game,quote,{trainingData:tooFew}).status,'insufficient');
const missingTeamHistory=structuredClone(defaultTraining);
missingTeamHistory.history=missingTeamHistory.history.filter(row=>!(row.date<game.taipeiDate&&[row.homeId,row.awayId].includes(game.home.id)));
assert.equal(analyzeNbaModel(game,quote,{trainingData:missingTeamHistory}).status,'insufficient');

// Target/same-date/future outcomes, pace and archived innovations cannot enter.
const changedFuture=structuredClone(defaultTraining);
for(const row of changedFuture.history)if(row.date>=game.taipeiDate){row.homeScore+=97;row.awayScore+=113;}
for(const row of changedFuture.paceHistory.rows)if(row.date>=game.taipeiDate)row.pace+=80;
for(const row of changedFuture.pairedResiduals)if(row.date>=game.taipeiDate){row.rawHome+=97;row.rawAway+=113;}
for(const row of changedFuture.observations)if(row.date>=game.taipeiDate){row.rawError+=210;row.error+=210;row.features=[1,80,20,100];}
assert.deepEqual(analyzeNbaModel(game,quote,{trainingData:changedFuture}),result);
assert.deepEqual(analyzeNbaModel({...game,home:{...game.home,score:500},away:{...game.away,score:0},basketball:{pace:300},lineups:[{starter:true}],injuries:[],pace:300,restDays:0},quote),result);

// Same date under a different injected history must fit again, not reuse a
// prior date-only cache entry. Earlier scores are legitimate model inputs.
const changedPast=structuredClone(defaultTraining);
for(const row of changedPast.history)if(row.date<game.taipeiDate&&row.year===2026&&row.seasonType==='regular'){row.homeScore+=10;row.awayScore+=10;}
const different=analyzeNbaModel(game,quote,{trainingData:changedPast});
assert.equal(different.status,'ready');assert.ok(Math.abs(different.prediction.baseTotal-result.prediction.baseTotal)>10);
assert.deepEqual(analyzeNbaModel(game,quote),result);

for(const line of ['230.25','230/230.5','230-230.5','230+101','230.5+50','0','PK','230+Infinity'])assert.equal(parseNbaAnalysisTotal({...quote,line}),null,line);
for(const line of ['230','230.5','230+50','230-100','230平',230.5])assert.ok(parseNbaAnalysisTotal({...quote,line}),String(line));
for(const water of [0,-1,3.001,Infinity,NaN,'0.94'])assert.equal(parseNbaAnalysisTotal({...quote,overWater:water}),null,String(water));
for(const invalid of [{...game,league:'MLB'},{...game,home:{id:game.away.id}},{...game,taipeiDate:'2026-02-30'},{...game,season:{year:2026,type:'preseason'}}])assert.equal(analyzeNbaModel(invalid,quote).status,'blocked');
assert.equal(analyzeNbaModel(game,{...quote,line:'230.25'}).status,'blocked');
assert.equal(analyzeNbaModel(game,quote,{trainingData:null}).status,'blocked');
const badResidual=structuredClone(defaultTraining);
badResidual.observations.find(row=>row.year===2026&&row.seasonType==='regular'&&row.date<game.taipeiDate).error=NaN;
assert.equal(analyzeNbaModel(game,quote,{trainingData:badResidual}).status,'blocked');
const badPlan=structuredClone(defaultTraining);badPlan.scorePlan.model.priorEquivalentGames=20;
assert.equal(analyzeNbaModel(game,quote,{trainingData:badPlan}).status,'blocked');
console.log(JSON.stringify({status:'PASS',history:1315,precomputedPredictions:1243,prequentialInnovations:1243,current2027Preseason:'insufficient',strictEarlierTargetAndFutureIsolation:true,sameSeasonTypeMinimum50:true,freshHistoryFit:true,unsupportedCreditQuotesBlocked:true,executable:false,probabilityEstimate:null}));
