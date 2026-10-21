import assert from 'node:assert/strict';
import {analyzeNbaOpening} from '../lib/nba/opening-model.js';
import {analyzeNbaOpeningTotalsV6Released} from '../lib/nba/opening-totals-v6-release.js';
import {mergeNbaOpeningTotals} from '../lib/nba/opening-totals-integration.js';
import {defaultTraining} from '../lib/nba/analysis-training.js';
import {quarterTraining} from '../lib/nba/quarter-training.js';
import {ESPN_NBA_TEAMS} from '../lib/nba/identity.js';
import {NBA_OPENING_COMPOSITE_VERSION,validOpeningResult,validOpeningV6TotalMarket,
  mergeNbaAnalysisResults,nbaResultQuoteCurrent} from '../lib/nba/analysis-job-display.js';
import {buildNbaShadowRanking,buildNbaPreviousRanking,buildNbaShadowOrder} from '../lib/nba/shadow-ranking.js';
import {nbaOpeningMarketCoverage,nbaLeagueIndicator} from '../lib/nba/league-indicator.js';
import {nbaOpeningValidationDiagnostics} from '../lib/nba/opening-diagnostics.js';

const date='2026-10-23',now=Date.parse('2026-10-22T22:00:00Z'),observedAt=new Date(now).toISOString();
const team=id=>({id:`nba:espn:team:${id}`,sourceId:String(id),abbreviation:ESPN_NBA_TEAMS[id],league:'NBA'});
const game={league:'NBA',id:'nba:espn:game:401999001',sourceId:'401999001',gamePk:401999001,taipeiDate:date,
  season:{year:2027,type:'regular'},seasonType:'regular',home:team(18),away:team(20),neutralSite:false,
  startTime:'2026-10-22T23:00:00Z',status:'scheduled',completed:false,timeConfirmed:true};
// Deliberately artificial prices exercise a high-score candidate. They are not
// asserted to be actual current bookmaker quotes or evidence of profit.
const quotes={fullTotal:{line:'300.5',overWater:.94,underWater:.94},
  fullRunline:{line:'5+75',lineSide:'home',homeWater:.95,awayWater:.95},
  firstHalfTotal:{line:'150.5',overWater:.94,underWater:.94},
  firstHalfRunline:{line:'2+50',lineSide:'home',homeWater:.95,awayWater:.95}};
const history={regularHistory:defaultTraining.history,halfHistory:quarterTraining.history};
const legacy=analyzeNbaOpening(game,quotes,history),totals=analyzeNbaOpeningTotalsV6Released(game,quotes,history);
const model=mergeNbaOpeningTotals(legacy,totals,game);
const result={...model,league:'NBA',gameId:game.id,date,observedAt};
const row={game,quote:quotes,canAnalyze:true,observedAt,pageActivityAt:observedAt,result,resultRunId:'v6-client-run',jobState:'ready'};
assert.equal(result.modelVersion,NBA_OPENING_COMPOSITE_VERSION);
assert.equal(validOpeningResult(result,date),true);
assert.equal(result.openingAnalysis.validation,legacy.openingAnalysis.validation,'spread validation remains the original independent record');
for(const key of ['fullRunline','firstHalfRunline'])assert.equal(result.marketAnalyses[key],legacy.marketAnalyses[key]);
for(const key of ['fullTotal','firstHalfTotal']){
  assert.equal(legacy.marketAnalyses[key].status,'insufficient');
  assert.equal(result.marketAnalyses[key].status,'ready');
  assert.equal(validOpeningV6TotalMarket(result,key,date),true);
}
assert.equal(nbaResultQuoteCurrent(row,now),true);
const batch={league:'NBA',date,runId:row.resultRunId,results:[{ok:true,task:{nbaQuery:{id:game.sourceId,date,observedAt},game},payload:result}]};
assert.equal(mergeNbaAnalysisResults(batch,[row],date)[0].result.modelVersion,NBA_OPENING_COMPOSITE_VERSION);
// Durable job progress is JSONB: object key order changes on read. The same
// evidence must survive that boundary without changing any value or array.
const reorder = value => Array.isArray(value) ? value.map(reorder)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,reorder(value[key])])) : value;
const durableBatch=reorder(JSON.parse(JSON.stringify(batch)));
assert.equal(validOpeningResult(durableBatch.results[0].payload,date),true,'JSONB key order must not reject valid evidence');
assert.equal(mergeNbaAnalysisResults(durableBatch,[row],date)[0].result.modelVersion,NBA_OPENING_COMPOSITE_VERSION);
const ranking=buildNbaShadowRanking([row],date,now);
assert.equal(ranking.entries.length,8);assert.equal(ranking.currentGames,1);
assert.equal(ranking.entries.filter(r=>r.marketKey.endsWith('Total')).length,4);
const candidates=buildNbaShadowOrder(ranking.entries).flatMap(group=>group.entries);
assert.ok(candidates.some(r=>r.marketKey==='fullTotal'&&r.side==='under'));
assert.ok(candidates.some(r=>r.marketKey==='firstHalfTotal'&&r.side==='under'));
assert.ok(candidates.every(r=>r.score>=7.2&&r.expectedNet>0&&r.robustExpectedNet>0));
const sample=ranking.entries.find(r=>r.marketKey==='fullTotal'&&r.side==='under');
for(const score of [7,7.1,null,undefined,NaN])assert.deepEqual(buildNbaShadowOrder([{...sample,score,expectedNet:2,robustExpectedNet:1}]),[]);
assert.equal(buildNbaShadowOrder([{...sample,score:7.2,expectedNet:2,robustExpectedNet:1}]).length,1);
for(const field of ['expectedNet','robustExpectedNet'])for(const value of [0,-1,null,undefined,NaN,Infinity])
  assert.deepEqual(buildNbaShadowOrder([{...sample,score:8,[field]:value}]),[]);

const job={date,runId:row.resultRunId,status:'completed',outcome:{status:'done',total:1,ready:1}};
const coverage=nbaOpeningMarketCoverage([row],date,job);
assert.equal(coverage.quoted,4);assert.equal(coverage.ready,4);assert.equal(coverage.validationFailed,0);
assert.deepEqual(nbaLeagueIndicator(date,job,null,false,{date,readerStatus:'fresh',analysisGameCount:1,openingMarketCoverage:coverage}),{status:'done',label:'分析完成'});

const mutations=[
  r=>{r.modelVersion='nba-opening-composite-totals-v6-margins-v2';},
  r=>{delete r.openingAnalysis.totalsValidation;},
  r=>{r.openingAnalysis.totalsValidation.version='other';},
  r=>{r.openingAnalysis.totalsValidation.protocolHash='0'.repeat(64);},
  r=>{r.openingAnalysis.totalsValidation.validationManifestHash='0'.repeat(64);},
  r=>{r.openingAnalysis.totalsValidation.regressionManifestHash='0'.repeat(64);},
  r=>{r.openingAnalysis.totalsValidation.targets.fullTotal.accepted=false;},
  r=>{r.openingAnalysis.totalsValidation.targets.fullTotal.candidateId=r.openingAnalysis.totalsValidation.targets.halfTotal.candidateId;},
  r=>{r.openingAnalysis.totalsValidation.targets.fullTotal.metrics.earlyModelMAE=999;},
  r=>{r.openingAnalysis.totalsValidation.targets.fullTotal.metrics.probabilitySamples=999;},
  r=>{r.openingAnalysis.totalsValidation.fullTotal.independentValidationAccepted=false;},
  r=>{r.openingAnalysis.totalsValidation.fullTotal.regressionAccepted=false;},
  r=>{r.openingAnalysis.totalsValidation.fullTotal.featureThrough=date;},
  r=>{r.marketAnalyses.fullTotal.modelVersion='nba-regular-cross-season-v1';},
  r=>{r.marketAnalyses.fullTotal.validationDiagnostics.market='firstHalfTotal';},
  r=>{r.marketAnalyses.fullTotal.validationDiagnostics.accepted=false;},
  r=>{r.marketAnalyses.fullTotal.sides.over.scoreEvidence.protocolHash='0'.repeat(64);},
];
for(const mutate of mutations){
  const changed=structuredClone(result);mutate(changed);
  assert.equal(validOpeningResult(changed,date),false);
  assert.equal(validOpeningResult(reorder(changed),date),false,'key-order independence cannot relax evidence checks');
  assert.equal(buildNbaShadowRanking([{...row,result:changed}],date,now).entries.length,0);
  assert.throws(()=>mergeNbaAnalysisResults({...batch,results:[{...batch.results[0],payload:changed}]},[row],date),/分析無效|缺少有效分析/);
}

// A retained spread can stay ready while one total fails validation. It must
// remain absent from scoring/ranking and must produce a partial-market badge.
const partial=structuredClone(result),key='firstHalfTotal',target=partial.openingAnalysis.totalsValidation.targets.halfTotal;
target.accepted=false;
const diagnostic=nbaOpeningValidationDiagnostics({market:key,metrics:target.metrics,acceptance:false,validationYear:2011});
diagnostic.modelVersion=target.modelVersion;
partial.marketAnalyses[key]={...partial.marketAnalyses[key],status:'insufficient',validationDiagnostics:diagnostic};
delete partial.marketAnalyses[key].sides;
const partialRow={...row,result:partial},partialCoverage=nbaOpeningMarketCoverage([partialRow],date,job);
assert.equal(validOpeningResult(partial,date),true);
assert.equal(buildNbaShadowRanking([partialRow],date,now).entries.length,6);
assert.equal(partialCoverage.ready,3);assert.equal(partialCoverage.validationFailed,1);
assert.deepEqual(nbaLeagueIndicator(date,job,null,false,{date,readerStatus:'fresh',analysisGameCount:1,openingMarketCoverage:partialCoverage}),{status:'partial',label:'部分市場已分析'});

const failedSpread=structuredClone(result);
failedSpread.marketAnalyses.fullRunline={...failedSpread.marketAnalyses.fullRunline,status:'insufficient',
  validationDiagnostics:nbaOpeningValidationDiagnostics({market:'fullRunline',metrics:failedSpread.openingAnalysis.validation.metrics.fullMargin,acceptance:false,validationYear:2026})};
delete failedSpread.marketAnalyses.fullRunline.sides;
const spreadCoverage=nbaOpeningMarketCoverage([{...row,result:failedSpread}],date,job);
assert.equal(validOpeningResult(failedSpread,date),true);
assert.equal(spreadCoverage.ready,3);assert.equal(spreadCoverage.validationFailed,1,'legacy spread diagnostics keep their own model identity inside the composite result');
assert.deepEqual(nbaLeagueIndicator(date,job,null,false,{date,readerStatus:'fresh',analysisGameCount:1,openingMarketCoverage:spreadCoverage}),{status:'partial',label:'部分市場已分析'});

// The new model keeps all four exact quote bindings, page freshness and start
// fences. Old scores can appear only in the explicitly previous-analysis view.
for(const changed of [
  {...row,quote:{...quotes,firstHalfTotal:{...quotes.firstHalfTotal,line:'151.5'}}},
  {...row,pageActivityAt:new Date(now-180001).toISOString()},
  {...row,observedAt:new Date(now-180001).toISOString()},
  {...row,canAnalyze:false},
  {...row,game:{...game,startTime:observedAt}},
]){
  assert.equal(nbaResultQuoteCurrent(changed,now),false);
  assert.equal(buildNbaShadowRanking([changed],date,now).entries.length,0);
}
assert.equal(buildNbaShadowRanking([row],date,now+180001).entries.length,0);
assert.ok(buildNbaPreviousRanking([row],date,now+180001).entries.every(r=>r.previousAnalysis===true));
assert.equal(nbaOpeningMarketCoverage([{...row,resultRunId:'old-run'}],date,job).ready,0);
console.log('PASS V6 client materialization, exact release/candidate/market/raw gate guards, both totals and legacy spreads, candidate S/W/R gates, partial-market coverage, quote/page/start freshness and old-result separation');
