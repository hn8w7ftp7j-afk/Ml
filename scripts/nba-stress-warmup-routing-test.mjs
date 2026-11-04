import assert from 'node:assert/strict';
import {createLiveHistoryFixture} from './fixtures/nba-live-history-fixture.mjs';
import {buildLiveNbaTraining} from '../lib/nba/live-training.js';
import {analyzeNbaRegularMarkets,nbaRegularStressWarmup} from '../lib/nba/regular-markets.js';
import {analyzeNbaOpening} from '../lib/nba/opening-model.js';
import {analyzeNbaOpeningTotalsV6Released} from '../lib/nba/opening-totals-v6-release.js';
import {mergeNbaOpeningTotals} from '../lib/nba/opening-totals-integration.js';
import {loadNbaAnalysis} from '../lib/nba/analysis-service.js';
import {nbaMarketScore} from '../lib/nba/market-score.js';
import {buildNbaAnalysisCapture} from '../lib/nba/analysis-journal.js';
import {validNbaForwardCapture} from '../lib/nba/forward-validation.js';
import {validOpeningResult} from '../lib/nba/analysis-job-display.js';
import {buildNbaShadowRanking} from '../lib/nba/shadow-ranking.js';
import {ESPN_NBA_TEAMS} from '../lib/nba/identity.js';

// Explicitly synthetic test dates/identities, never production training data.
// Reproduce the live incident: 58 prior residuals fit W, but only one R block.
const date='2026-11-05',now=Date.parse('2026-11-04T17:00:00Z'),at=new Date(now).toISOString();
const rows=Array.from({length:62},(_,i)=>createLiveHistoryFixture({
 date:new Date(Date.parse('2026-10-20')+Math.floor(i/4)*86400000).toISOString().slice(0,10),
 year:2027,gameId:String(401899000+i)}).row);
const context=buildLiveNbaTraining(rows,{beforeDate:date,seasonYear:2027,now});
assert.equal(context.status,'ready');
const team=id=>({id,sourceId:id.split(':').at(-1),abbreviation:ESPN_NBA_TEAMS[id.split(':').at(-1)],league:'NBA'});
const game={id:'nba:espn:game:401999998',sourceId:'401999998',league:'NBA',taipeiDate:date,
 season:{year:2027,type:'regular'},seasonType:'regular',home:team(rows[0].homeId),away:team(rows[0].awayId),
 neutralSite:false,startTime:'2026-11-05T00:00:00Z',status:'scheduled',completed:false,timeConfirmed:true};
const quotes={fullTotal:{line:'230.5',overWater:.94,underWater:.94},fullRunline:{line:'3+25',lineSide:'home',homeWater:.95,awayWater:.95},
 firstHalfTotal:{line:'112.5',overWater:.93,underWater:.93},firstHalfRunline:{line:'1+25',lineSide:'home',homeWater:.94,awayWater:.94}};
const regular=analyzeNbaRegularMarkets(game,quotes,context);
assert.equal(regular.status,'ready');assert.equal(regular.training.eligibleInnovations,58);
for(const market of Object.values(regular.marketAnalyses))for(const side of Object.values(market.sides)){
 assert.equal(side.scoreEvidence.blocks.length,1);assert.equal(side.robustExpectedNet,null);assert.equal(nbaMarketScore(side),null);
}
assert.equal(nbaRegularStressWarmup(regular,game,context.trainingData.history),true);
for(const changed of [{...game,league:'MLB'},{...game,seasonType:'preseason'},{...game,seasonType:'postseason'},
 {...game,taipeiDate:'bad'}])assert.equal(nbaRegularStressWarmup(regular,changed,context.trainingData.history),false);
assert.equal(nbaRegularStressWarmup({...regular,status:'blocked'},game,context.trainingData.history),false);
const matureHistory=[...context.trainingData.history,{year:2027,seasonType:'regular',date:'2026-08-07'}];
assert.equal(nbaRegularStressWarmup(regular,game,matureHistory),false,'a mature-season missing block cannot silently select a different model');
const complete=structuredClone(regular);
for(const m of Object.values(complete.marketAnalyses))for(const s of Object.values(m.sides))s.robustExpectedNet=0;
assert.equal(nbaRegularStressWarmup(complete,game,context.trainingData.history),false,'a finite R is never replaced based on its sign or score');
const unsupported=structuredClone(regular);for(const m of Object.values(unsupported.marketAnalyses))m.status='blocked';
assert.equal(nbaRegularStressWarmup(unsupported,game,context.trainingData.history),false);

const row={...quotes,league:'NBA',boardDate:date,boardTime:'08:00',captureKey:'nba-stress-warmup-test',marketStatus:'open',away:game.away,home:game.home};
const snapshot={league:'NBA',boardDate:date,observedAt:at,pageActivityAt:at,games:[row],gameCount:1};
const schedule={league:'NBA',status:'ready',qa:{status:'WARNING'},sources:[{status:'ready'}],data:{games:[game]}};
let captured;
const options={now,loadSchedule:async()=>schedule,loadReader:async()=>snapshot,loadTraining:async()=>context,
 saveCapture:async a=>{captured=buildNbaAnalysisCapture(a);return{persisted:true,status:'saved',revision:captured.revision,capturedAt:at};}};
const service=await loadNbaAnalysis({date,id:game.sourceId,observedAt:at},options);
assert.equal(service.status,'ready');assert.equal(service.modelVersion,'nba-opening-composite-totals-v6-margins-v1');
assert.ok(service.issues.some(i=>i.code==='NBA_REGULAR_STRESS_WARMUP'));
assert.equal(validOpeningResult(service,date),true);
assert.equal(validNbaForwardCapture({revision:captured.revision,payload:captured.payload,capturedAt:at}),true);
assert.equal(service.executable,false);assert.equal(service.promotionEligible,false);
const history={regularHistory:context.trainingData.history,halfHistory:context.halfTraining.history};
const expected=mergeNbaOpeningTotals(analyzeNbaOpening(game,quotes,history),analyzeNbaOpeningTotalsV6Released(game,quotes,history),game);
assert.deepEqual(service.marketAnalyses,expected.marketAnalyses,'existing reviewed model outputs, formulas and evidence remain bit-exact');
for(const m of Object.values(service.marketAnalyses))for(const s of Object.values(m.sides)){
 assert.ok(Number.isFinite(s.expectedNet)&&Number.isFinite(s.robustExpectedNet));assert.ok(nbaMarketScore(s));
 assert.ok(s.robustExpectedNet<=s.expectedNet);assert.ok(Math.abs(s.winProbability+s.lossProbability+s.pushProbability-1)<1e-8);
 assert.ok(s.scoreEvidence.seasons.every(e=>e.year<2027&&e.samples>=30));
}
const displayRow={game,quote:quotes,result:service,observedAt:at,pageActivityAt:at,canAnalyze:true,jobState:'ready'};
assert.equal(buildNbaShadowRanking([displayRow],date,now).entries.length,8);
let fallbackCalls=0;
const failed=await loadNbaAnalysis({date,id:game.sourceId,observedAt:at},{...options,
 loadTraining:async()=>({status:'unavailable'}),analyzeOpeningTotals:()=>{fallbackCalls++;return expected;}});
assert.equal(failed.status,'blocked');assert.equal(fallbackCalls,0);
const changedQuote=structuredClone(snapshot);changedQuote.games[0].fullTotal.line='231.5';let reads=0;
const changed=await loadNbaAnalysis({date,id:game.sourceId,observedAt:at},{...options,
 loadReader:async()=>++reads===1?snapshot:{...changedQuote,observedAt:'2026-11-04T17:00:01Z'}});
assert.equal(changed.status,'blocked');assert.ok(changed.issues.some(i=>i.code==='NBA_ANALYSIS_QUOTE_CHANGED'));
console.log('PASS 58-residual/one-block incident, unchanged reviewed eight-direction W/R/S, durable evidence, ranking, mature-season/source/identity/quote guards');
