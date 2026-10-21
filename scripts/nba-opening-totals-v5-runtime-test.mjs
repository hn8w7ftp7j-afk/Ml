import assert from 'node:assert/strict';
import { openingResearchHistory } from '../lib/nba/opening-research-history.js';
import { openingTraining } from '../lib/nba/opening-training.js';
import { nbaMarketScore } from '../lib/nba/market-score.js';
import { evaluateWeightedContract,parseCreditLine } from '../lib/nba/analysis-core/credit-total.js';
import { TOTALS_V5_PROTOCOL,TOTALS_V5_PROTOCOL_HASH,totalsV5Candidate,buildTotalsV5Observations,
  totalsV5Distribution,totalsV5Cdf } from '../lib/nba/opening-research-v5.js';
import { predictTotalsV5AsOf,createOpeningTotalsV5Runtime,verifyTotalsV5IndependentEvidence,
  totalsV5RuntimeHash,analyzeNbaOpeningTotalsV5,V5_RUNTIME_VALIDATION_PIN } from '../lib/nba/opening-totals-v5-runtime.js';

const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const older=openingResearchHistory.history,empty=[],sourcePins={older:totalsV5RuntimeHash(older),recent:totalsV5RuntimeHash(empty)};
const gameFor=r=>({league:'NBA',id:r.gameId,taipeiDate:r.date,seasonType:'regular',season:{year:r.year,type:'regular'},
  home:{id:r.homeId},away:{id:r.awayId},neutralSite:r.neutralSite});
const quotes={fullTotal:{line:'235.5',overWater:.94,underWater:.94},firstHalfTotal:{line:'110+50',overWater:.95,underWater:.95}};
const forecasts={};
for(const target of ['fullTotal','halfTotal']) {
  const observations=buildTotalsV5Observations(older,target);forecasts[target]=observations;
  const cohort=observations.filter(r=>r.year===2021),sample=[cohort[0],cohort[30],cohort[140],cohort[500],cohort.at(-1)];
  for(const row of sample) {
    const raw=older.find(r=>r.gameId===row.gameId),point=predictTotalsV5AsOf(gameFor(raw),older,target,observations);
    close(point.prediction,row.prediction);close(point.rawPrediction,row.rawPrediction);close(point.correction,row.correction);
    close(point.fit.slope,row.fit.slope);close(point.distributionCenter,row.distributionCenter);
    assert.equal(point.fitSamples,row.fitSamples);assert.equal(point.featureThrough,row.featureThrough);
    assert.equal(point.fitThrough,row.fitThrough);assert.equal(point.correctionThrough,row.correctionThrough);
    assert.equal(point.correctionSamples,row.correctionSamples);assert.deepEqual(point.currentGames,row.currentGames);
    assert.ok(!Object.hasOwn(point,'actual')&&!Object.hasOwn(point,'error')&&!Object.hasOwn(point,'pointError'),'runtime forecast has no target label');
    const live=totalsV5Distribution(point,observations,target),replay=totalsV5Distribution(row,observations,target);
    assert.deepEqual(live,replay,'runtime and retrospective full predictive distribution must agree');
  }
}

// Explicitly synthetic acceptance evidence exercises the adapter gate. It is
// never written as real independent evidence and the production default is null.
assert.equal(V5_RUNTIME_VALIDATION_PIN,null);
const metrics={samples:1230,earlySamples:140,probabilitySamples:1230,
  modelMAE:10,baselineMAE:12,earlyModelMAE:11,earlyBaselineMAE:13,
  modelBrier:.24,baselineBrier:.25,modelLogLoss:.68,baselineLogLoss:.69};
const manifest={version:'nba-opening-v5-independent-evaluation-v1',modelVersion:TOTALS_V5_PROTOCOL.version,
  protocolHash:TOTALS_V5_PROTOCOL_HASH,selectionFrozenCommit:'1'.repeat(40),developmentReportHash:'2'.repeat(64),
  sourceHistoryHash:'3'.repeat(64),reviewedArchiveSha256:'4'.repeat(64),holdoutYear:2017,
  role:'EARLIER_ERA_EXTERNAL_RETROSPECTIVE_NOT_PROSPECTIVE_OOS',
  targets:Object.fromEntries(['fullTotal','halfTotal'].map(target=>[target,{candidate:totalsV5Candidate(target),metrics:{...metrics},passed:true,reasons:[]}])) ,
  holdoutConsumed:true,reselectionAllowed:false,status:'HOLDOUT_PASSED_REQUIRES_CURRENT_REGRESSION_AND_INTEGRATION_REVIEW',executable:false,promotionEligible:false};
const pins={expectedSha256:totalsV5RuntimeHash(manifest),expectedArchiveSha256:manifest.reviewedArchiveSha256,expectedSourceHistoryHash:manifest.sourceHistoryHash};
const runtime=createOpeningTotalsV5Runtime({olderHistory:older,recentHistory:empty,sourceHistoryPins:sourcePins,validationManifest:manifest,validationPins:pins});
const source=older.find(r=>r.year===2022&&!r.neutralSite&&forecasts.fullTotal.find(o=>o.gameId===r.gameId)?.phase==='early'),game=gameFor(source);
const result=runtime(game,quotes);
assert.equal(result.status,'ready');assert.equal(result.executable,false);assert.equal(result.promotionEligible,false);
assert.deepEqual(Object.keys(result.marketAnalyses),['fullTotal','firstHalfTotal'],'spread markets are never changed by this adapter');
for(const [key,target] of [['fullTotal','fullTotal'],['firstHalfTotal','halfTotal']]) {
  const market=result.marketAnalyses[key],row=forecasts[target].find(r=>r.gameId===game.id),distribution=totalsV5Distribution(row,forecasts[target],target);
  assert.equal(market.status,'ready');assert.equal(market.rebateRate,.015);assert.equal(market.unitStake,100);
  close(market.quantity,row.prediction);close(market.distributionCenter,distribution.center);
  const quote=quotes[key],contract=evaluateWeightedContract(distribution.center,distribution.residuals,parseCreditLine(quote.line,'total'),{positive:quote.overWater,negative:quote.underWater},row.date,365,.015);
  close(market.sides.over.expectedNet,contract.positive.expectedNet);close(market.sides.under.expectedNet,contract.negative.expectedNet);
  if(key==='fullTotal')close(market.sides.over.winProbability,1-totalsV5Cdf(distribution,235.5));
  assert.ok(market.sides.over.scoreEvidence.seasons.length>=2);
  assert.ok(market.sides.over.scoreEvidence.seasons.every(r=>r.year<game.season.year&&r.samples>=30));
  assert.ok(nbaMarketScore(market.sides.over),'existing S mapping receives exact prior-season stress evidence');
}
assert.equal(runtime(game,{fullTotal:{...quotes.fullTotal,line:'235.25'}}).marketAnalyses.fullTotal.status,'blocked');
assert.equal(runtime(game,{firstHalfTotal:quotes.firstHalfTotal}).marketAnalyses.fullTotal.status,'unavailable');
assert.equal(runtime({...game,league:'NHL'},quotes).status,'blocked');
assert.equal(runtime({...game,neutralSite:true},quotes).status,'insufficient');
assert.equal(analyzeNbaOpeningTotalsV5(game,quotes).marketAnalyses.fullTotal.status,'insufficient','real unreviewed model never inherits fixture approval');
assert.equal(verifyTotalsV5IndependentEvidence(manifest,{...pins,target:'fullTotal',targetSeasonYear:2017}).accepted,false);
for(const mutate of [
  r=>{r.protocolHash='5'.repeat(64);},r=>{r.sourceHistoryHash='5'.repeat(64);},r=>{r.targets.fullTotal.candidate.candidateId='5'.repeat(64);},
  r=>{r.targets.fullTotal.metrics.modelBrier=.26;},r=>{r.targets.fullTotal.metrics.earlyModelMAE=14;},r=>{r.targets.fullTotal.metrics.probabilitySamples=999;},
  r=>{r.targets.fullTotal.passed=false;},r=>{r.holdoutYear=2021;},r=>{r.selectionFrozenCommit=null;},r=>{r.holdoutConsumed=false;},
]) {
  const changed=structuredClone(manifest);mutate(changed);
  assert.equal(verifyTotalsV5IndependentEvidence(changed,{...pins,target:'fullTotal',targetSeasonYear:2022}).accepted,false,'changed artifact fails exact immutable pin');
  assert.equal(verifyTotalsV5IndependentEvidence(changed,{...pins,expectedSha256:totalsV5RuntimeHash(changed),target:'fullTotal',targetSeasonYear:2022}).accepted,false,'even a freshly supplied hash cannot bypass scope or raw gates');
}
assert.throws(()=>createOpeningTotalsV5Runtime({olderHistory:older,recentHistory:empty,sourceHistoryPins:{...sourcePins,older:'6'.repeat(64)}}),/SOURCE_PIN/);
const frozenMutation=structuredClone(manifest);const isolated=createOpeningTotalsV5Runtime({olderHistory:older,recentHistory:empty,sourceHistoryPins:sourcePins,validationManifest:frozenMutation,validationPins:pins});
frozenMutation.targets.fullTotal.metrics.modelBrier=1;assert.equal(isolated(game,quotes).marketAnalyses.fullTotal.status,'ready','factory snapshots trusted release inputs');

const priorSource=older.find(r=>r.year===2021),conflict={...priorSource,homeScore:priorSource.homeScore+1};
assert.equal(runtime(game,quotes,{regularHistory:[conflict]}).status,'blocked');
const futurePoison={...source,gameId:'nba:espn:game:999999991',date:game.taipeiDate,homeScore:400,homeHalf:200};
assert.deepEqual(runtime(game,quotes,{regularHistory:[futurePoison]}),result,'same-day/future live labels are excluded before any state update');

// Real frozen + research archives can coexist. A new verified full result still
// requires its separately checked first-half result and cannot contradict one.
const complete=createOpeningTotalsV5Runtime(),next={...game,id:'nba:espn:game:999999990',taipeiDate:'2026-10-25',season:{year:2027,type:'regular'}};
const live={gameId:'nba:espn:game:999999989',date:'2026-10-22',year:2027,seasonType:'regular',homeId:game.home.id,awayId:game.away.id,
  neutralSite:false,homeScore:110,awayScore:100,homeHalf:55,awayHalf:50,checkpointSha256:'7'.repeat(64)};
assert.equal(complete(next,quotes,{regularHistory:[live]}).status,'insufficient');
assert.equal(complete(next,quotes,{regularHistory:[live]}).issues[0].code,'NBA_TOTALS_V5_RUNTIME_LIVE_HALF_MISSING');
const joined=complete(next,quotes,{regularHistory:[live],halfHistory:[live]});
assert.equal(joined.status,'insufficient');assert.ok(joined.totalsAnalysis,'eligible current-season labels update a real unaccepted shadow model');
assert.equal(complete(next,quotes,{regularHistory:[live],halfHistory:[{...live,awayId:live.homeId}]}).status,'blocked');
assert.equal(complete(next,quotes,{regularHistory:[live,live],halfHistory:[live]}).status,'blocked');
assert.equal(complete(next,quotes,{regularHistory:[live],halfHistory:[live,live]}).status,'blocked');
console.log('PASS V5 totals runtime: target-label-free point/distribution replay parity, exact pinned independent/raw gates, 1.5% original credit contract, prior-season R/S, live identity joins, leakage counterexamples, no unaccepted production score');
