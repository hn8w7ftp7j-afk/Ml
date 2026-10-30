import {nbaMarketDisplayState} from '../lib/nba/market-display-state.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {transform} from 'next/dist/build/swc/index.js';
import {analyzeNbaOpening} from '../lib/nba/opening-model.js';
import {analyzeNbaOpeningTotalsV6Released} from '../lib/nba/opening-totals-v6-release.js';
import {mergeNbaOpeningTotals,NBA_OPENING_COMPOSITE_VERSION} from '../lib/nba/opening-totals-integration.js';
import {TOTALS_V6_PROTOCOL,TOTALS_V6_PROTOCOL_HASH} from '../lib/nba/opening-research-v6.js';
import {loadNbaAnalysis} from '../lib/nba/analysis-service.js';
import {defaultTraining} from '../lib/nba/analysis-training.js';
import {quarterTraining} from '../lib/nba/quarter-training.js';
import {openingVariableAccepted} from '../lib/nba/opening-core.js';
import {nbaMarketScore} from '../lib/nba/market-score.js';
import {buildNbaAnalysisCapture} from '../lib/nba/analysis-journal.js';
import {canonicalNbaForwardCaptures,validNbaForwardCapture} from '../lib/nba/forward-validation.js';
import {ESPN_NBA_TEAMS} from '../lib/nba/identity.js';
import {NBA_TEAM_LABELS} from '../lib/nba/labels.js';
import {nbaResultQuoteCurrent,mergeNbaAnalysisResults,validOpeningResult} from '../lib/nba/analysis-job-display.js';
import {buildNbaShadowRanking} from '../lib/nba/shadow-ranking.js';

const date='2026-10-22',now=Date.parse('2026-10-21T22:00:00Z'),at=new Date(now).toISOString();
const team=id=>({id:`nba:espn:team:${id}`,sourceId:String(id),abbreviation:ESPN_NBA_TEAMS[id],league:'NBA'});
const game={league:'NBA',id:'nba:espn:game:401999001',sourceId:'401999001',gamePk:401999001,taipeiDate:date,
  season:{year:2027,type:'regular'},seasonType:'regular',home:team(18),away:team(20),neutralSite:false,
  startTime:'2026-10-21T23:00:00Z',status:'scheduled',completed:false,timeConfirmed:true};
const quotes={fullTotal:{line:'235.5',overWater:.94,underWater:.94},fullRunline:{line:'3-50',lineSide:'home',homeWater:.95,awayWater:.95},
  firstHalfTotal:{line:'115+50',overWater:.94,underWater:.94},firstHalfRunline:{line:'2+50',lineSide:'home',homeWater:.95,awayWater:.95}};
const history={regularHistory:defaultTraining.history,halfHistory:quarterTraining.history};
const legacy=analyzeNbaOpening(game,quotes,history),totals=analyzeNbaOpeningTotalsV6Released(game,quotes,history);
const combined=mergeNbaOpeningTotals(legacy,totals,game);
assert.equal(combined.modelVersion,NBA_OPENING_COMPOSITE_VERSION);assert.equal(combined.status,'ready');
assert.equal(combined.executable,false);assert.equal(combined.promotionEligible,false);assert.equal(combined.strictPointInTime,false);
for(const key of ['fullRunline','firstHalfRunline'])assert.equal(combined.marketAnalyses[key],legacy.marketAnalyses[key],'spread market identity and valuations remain unchanged');
assert.equal(combined.openingAnalysis.validation,legacy.openingAnalysis.validation);
assert.equal(combined.openingAnalysis.acceptance,legacy.openingAnalysis.acceptance);
assert.equal(combined.openingAnalysis.validationYear,2026);
assert.equal(combined.openingAnalysis.totalsValidation.validationYear,2011);
assert.equal(combined.openingAnalysis.totalsValidation.role,'EARLIER_ERA_EXTERNAL_RETROSPECTIVE_NOT_PROSPECTIVE_OOS');
assert.equal(combined.openingAnalysis.totalsValidation.protocolHash,TOTALS_V6_PROTOCOL_HASH);
assert.ok(Math.abs(combined.prediction.home+combined.prediction.away-combined.prediction.total)<1e-10);
assert.ok(Math.abs(combined.prediction.home-combined.prediction.away-legacy.openingAnalysis.fullMargin)<1e-10);
assert.equal(combined.prediction.total,totals.totalsAnalysis.fullTotal.pointPrediction);
assert.equal(combined.openingAnalysis.halfTotal,totals.totalsAnalysis.halfTotal.pointPrediction);
for(const [key,target] of [['fullTotal','fullTotal'],['firstHalfTotal','halfTotal']]) {
  const market=combined.marketAnalyses[key],validation=combined.openingAnalysis.totalsValidation.targets[target];
  assert.equal(market.status,'ready');assert.equal(market.modelVersion,TOTALS_V6_PROTOCOL.version);
  assert.equal(market.validationDiagnostics.status,'PASS');assert.equal(market.validationDiagnostics.validationYear,2011);
  assert.equal(validation.accepted,true);assert.equal(openingVariableAccepted(validation.metrics),true);
  assert.equal(validation.metrics.probabilitySamples,1230);assert.equal(market.rebateRate,.015);
  for(const side of ['over','under']) {
    assert.ok(Number.isFinite(market.sides[side].expectedNet));assert.ok(Number.isFinite(market.sides[side].robustExpectedNet));
    assert.ok(nbaMarketScore(market.sides[side]));
  }
}
assert.equal(mergeNbaOpeningTotals({...legacy,status:'blocked'},totals,game).status,'blocked');
assert.equal(mergeNbaOpeningTotals(legacy,{...totals,modelVersion:'foreign'},game),legacy);
assert.equal(mergeNbaOpeningTotals(legacy,totals,{...game,seasonType:'preseason'}),legacy);
const unaccepted=structuredClone(totals);unaccepted.totalsAnalysis.fullTotal.independentValidationAccepted=false;
assert.equal(mergeNbaOpeningTotals(legacy,unaccepted,game).marketAnalyses.fullTotal.status,'blocked');
const fullOnly={fullTotal:quotes.fullTotal};
const fullOnlyResult=mergeNbaOpeningTotals(analyzeNbaOpening(game,fullOnly,history),analyzeNbaOpeningTotalsV6Released(game,fullOnly,history),game);
assert.equal(fullOnlyResult.status,'ready');assert.equal(fullOnlyResult.marketAnalyses.firstHalfTotal.status,'unavailable');
assert.equal(fullOnlyResult.marketAnalyses.fullRunline.status,'unavailable');

const readerRow={...quotes,league:'NBA',boardDate:date,boardTime:'07:00',captureKey:'nba-opening-v6-integration',marketStatus:'open',away:game.away,home:game.home};
const snapshot={league:'NBA',boardDate:date,observedAt:at,pageActivityAt:at,games:[readerRow],gameCount:1};
const schedule={league:'NBA',status:'ready',qa:{status:'WARNING'},sources:[{status:'ready'}],data:{games:[game]}};
const options={now,loadSchedule:async()=>schedule,loadReader:async()=>snapshot,
  loadTraining:async()=>({status:'ready',trainingData:defaultTraining,halfTraining:quarterTraining})};
let captures=0,saved;
const service=await loadNbaAnalysis({date,id:game.sourceId,observedAt:at,analyzeOpeningTotals:null},{...options,saveCapture:async analysis=>{
  captures++;saved=buildNbaAnalysisCapture(analysis);return{persisted:true,status:'saved',revision:saved.revision,capturedAt:at};}});
assert.equal(service.modelVersion,NBA_OPENING_COMPOSITE_VERSION,'production default releases real reviewed totals without a server fixture override');
assert.equal(service.status,'ready');assert.equal(captures,1);assert.equal(service.persistence.persisted,true);
const capture={revision:saved.revision,payload:saved.payload,capturedAt:at};
assert.equal(validNbaForwardCapture(capture),true);
assert.deepEqual(new Set(canonicalNbaForwardCaptures([capture],{now}).map(c=>c.marketKey)),new Set(['fullTotal','fullRunline','firstHalfTotal','firstHalfRunline']));
assert.equal(saved.payload.modelVersion,NBA_OPENING_COMPOSITE_VERSION);
const query={date,id:game.sourceId,observedAt:at},row={game,quote:quotes,canAnalyze:true,observedAt:at,pageActivityAt:at,result:service,jobState:'ready'};
assert.equal(validOpeningResult(service,date),true);assert.equal(nbaResultQuoteCurrent(row,now),true);
assert.equal(buildNbaShadowRanking([row],date,now).entries.length,8);
const batch={league:'NBA',date,results:[{ok:true,task:{game,nbaQuery:query},payload:service}]};
assert.equal(mergeNbaAnalysisResults(batch,[row],date)[0].result.modelVersion,NBA_OPENING_COMPOSITE_VERSION);
const noQuoteReader=structuredClone(snapshot);delete noQuoteReader.games[0].firstHalfTotal;
const absentHalf=await loadNbaAnalysis(query,{...options,loadReader:async()=>noQuoteReader,saveCapture:async()=>({persisted:true})});
assert.equal(absentHalf.marketAnalyses.firstHalfTotal.status,'unavailable');
const unsupportedReader=structuredClone(snapshot);unsupportedReader.games[0].fullTotal.line='235.25';
const unsupported=await loadNbaAnalysis(query,{...options,loadReader:async()=>unsupportedReader,saveCapture:async()=>({persisted:true})});
assert.equal(unsupported.marketAnalyses.fullTotal.status,'blocked');assert.equal(unsupported.marketAnalyses.firstHalfTotal.status,'ready');
let modelCalls=0;
const noFallback=async()=>{modelCalls++;throw Error('source/preseason/same-season guard must prevent this call');};
const blocked=await loadNbaAnalysis(query,{...options,analyzeOpeningTotals:noFallback,
  loadTraining:async()=>({status:'blocked',issues:[{code:'FIXTURE_VERIFIED_HISTORY_CONFLICT',message:'history conflict'}]})});
assert.equal(blocked.status,'blocked');assert.equal(modelCalls,0);assert.equal(blocked.openingAnalysis,undefined);
const preseason={...game,seasonType:'preseason',season:{year:2027,type:'preseason'}};
await loadNbaAnalysis(query,{...options,analyzeOpeningTotals:noFallback,loadSchedule:async()=>({...schedule,data:{games:[preseason]}}),saveCapture:async()=>({persisted:true})});
assert.equal(modelCalls,0);
const matureDate='2026-03-10',matureNow=Date.parse('2026-03-10T09:00:00Z'),matureAt=new Date(matureNow).toISOString();
const matureGame={...game,taipeiDate:matureDate,startTime:'2026-03-10T10:00:00Z',season:{year:2026,type:'regular'}};
const matureReader={...snapshot,boardDate:matureDate,observedAt:matureAt,pageActivityAt:matureAt,
  games:[{...readerRow,boardDate:matureDate,boardTime:'18:00'}]};
const sameSeason=await loadNbaAnalysis({date:matureDate,id:game.sourceId,observedAt:matureAt},{...options,now:matureNow,
  analyzeOpeningTotals:noFallback,loadReader:async()=>matureReader,loadSchedule:async()=>({...schedule,data:{games:[matureGame]}}),saveCapture:async()=>({persisted:true})});
assert.equal(sameSeason.modelVersion,'nba-regular-four-market-v1');assert.equal(sameSeason.status,'ready');assert.equal(modelCalls,0);
const legacyOnly=await loadNbaAnalysis(query,{...options,analyzeOpeningTotals:null,saveCapture:async()=>({persisted:true})});
assert.equal(legacyOnly.modelVersion,'nba-regular-cross-season-v1');assert.equal(legacyOnly.marketAnalyses.fullTotal.status,'insufficient');

const source=fs.readFileSync('app/nba/main-workspace.js','utf8');
const helpers=source.slice(source.indexOf('const name ='),source.indexOf('const store ='));
const card=source.slice(source.indexOf('export function NbaGameCard'),source.indexOf('export default function')).replace('export function','function');
const {code}=await transform(helpers+card+'\nglobalThis.Card=NbaGameCard;globalThis.validationView=openingValidationView;',{filename:'nba-opening-composite-card.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}},module:{type:'commonjs'}});
const context={nbaMarketDisplayState,React,NBA_TEAM_LABELS,nbaResultQuoteCurrent,nbaMarketScore,NbaBetRecordButton:()=>React.createElement('button',null,'紀錄實際下注')};
vm.createContext(context);vm.runInContext(code,context);
assert.equal(context.validationView({...combined.marketAnalyses.fullTotal.validationDiagnostics,market:'fullRunline',variable:'fullMargin'},'fullRunline'),null,'V6 diagnostics may never authorize spread markets');
assert.equal(context.validationView({...combined.marketAnalyses.fullTotal.validationDiagnostics,modelVersion:'foreign'},'fullTotal'),null);
const markup=renderToStaticMarkup(React.createElement(context.Card,{row,now,busy:false,onAnalyze:()=>{}}));
assert.match(markup,/235\.5/);assert.match(markup,/115\+50/);assert.match(markup,/W .*%｜R /);
assert.equal((markup.match(/title="S 分數"/g)||[]).length,8);
assert.match(markup,/2011.*跨時代回溯外部驗證/);assert.match(markup,/2026.*時間切分驗證/);
assert.match(markup,/不是前瞻驗證/);assert.doesNotMatch(markup,/2011.*獨立時間切分驗證球季|undefined|NaN|待驗證/);
console.log('PASS production NBA V6 totals integration: real default warmup release, all eight W/R/S directions, exact preserved spreads, coherent scores, mixed/open/blocked markets, source/preseason guards, capture/merge/ranking and shipped JSX with honest era labels');
