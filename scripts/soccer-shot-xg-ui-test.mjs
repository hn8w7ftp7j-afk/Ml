import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { soccerIdentityHash } from '../lib/soccer/identity-hash.js';
import { soccerMatchContextObservations } from '../lib/soccer/match-context-observations.js';

// A synthetic renderer input is not a source-data authentication fixture or a
// fit. The real report builder's raw-document and private-fit tests are separate.
const modelMetrics={games:100,shots:2300,logLoss:.301234,brier:.081234,predictedMean:.102,observedGoalRate:.101,
  calibrationBins:[{lower:0,upper:.1,count:1200,predictedMean:.04,observedRate:.05},{lower:.1,upper:.2,count:0,predictedMean:null,observedRate:null}]};
const reseal=value=>{const {contentHash,...body}=value;return {...body,contentHash:soccerIdentityHash(body)};};
const example=()=>reseal({version:'SOCCER-WYSCOUT-XY-SHOT-RESEARCH-v1',type:'AGGREGATE_SHOT_XG_RESEARCH_REPORT',
  provider:'WYSCOUT_OPEN_DATA',league:'epl',synthetic:false,sourceAuthenticationVerified:true,
  coordinateContract:'WYSCOUT_ATTACK_RIGHT_UNIT_SQUARE-v1',createdAt:'2026-11-07T12:00:00Z',availableAt:'2026-11-07T12:00:00Z',
  accepted:false,formalEligible:false,calibrationEligible:false,promotionEligible:false,modelEffectApplied:false,executable:false,
  historicalAvailabilityVerified:false,independentUntouchedTestVerified:false,currentSeasonCoverageVerified:false,uclCoverageVerified:false,
  rawRowsIncluded:false,fittedCoefficientsIncluded:false,
  protocol:{version:'SOCCER-WYSCOUT-XY-SHOT-PROTOCOL-2017-18-v1',trainingBefore:'2018-01-01',calibrationBefore:'2018-03-01',testBefore:'2018-06-01',
    embargoHours:48,strictEmbargo:true,featureSelection:'FIXED_BEFORE_CORPUS_METRICS_NO_TEST_TUNING'},
  sourceCollection:{sourceMatches:380,eligibleMatches:378,quarantinedMatches:2,fullPublishedCohortVerified:true},
  coverage:{sourceMatches:378,sourceShots:9800,includedMatches:366,includedNonPenaltyShots:9200,penaltyShotsExcluded:80,excludedMatches:12},
  evaluation:{test:{constantBaseline:{...modelMetrics,logLoss:.32,brier:.09},locationBaseline:{...modelMetrics,logLoss:.29,brier:.08},
    candidate:structuredClone(modelMetrics),calibratedCandidate:{...structuredClone(modelMetrics),logLoss:.302,brier:.082}}}});

const compile=async path=>{
  const source=fs.readFileSync(path,'utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
  return (await transform(source,{filename:path.replace('.js','.jsx'),jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}})).code;
};
const context=vm.createContext({React,soccerIdentityHash,soccerMatchContextObservations});
vm.runInContext(await compile('app/soccer/shot-xg-research-panel.js'),context);
vm.runInContext(await compile('app/soccer/model-development-panel.js'),context);
const game={id:'soccer:epl:123',sourceId:'123',league:'epl',date:'2026-11-07',startTime:'2026-11-07T20:00:00Z',home:{sourceId:'1'},away:{sourceId:'2'}};
const viewFor=(report,displayGame=game)=>({version:'SOCCER-SHOT-XG-RESEARCH-VIEW-v1',status:'RESEARCH_AVAILABLE',league:displayGame.league,gameId:displayGame.id,
  gameContext:{sourceId:displayGame.sourceId,date:displayGame.date,startTime:displayGame.startTime,homeSourceId:displayGame.home?.sourceId,awaySourceId:displayGame.away?.sourceId},
  analysisCutoff:'2026-11-07T13:00:00Z',artifact:{version:'SOCCER-SHOT-XG-RESEARCH-ARTIFACT-v1',contentHash:'a'.repeat(64),createdAt:'2026-11-07T12:00:00Z'},
  report,accepted:false,formalEligible:false,calibrationEligible:false,promotionEligible:false,modelEffectApplied:false,executable:false,currentSeasonModelApplied:false,W:null,R:null,S:null});
const savedCutoff='2026-11-07T13:00:00Z';
const renderView=(view,displayGame=game,analysisCutoff=savedCutoff)=>renderToStaticMarkup(React.createElement(context.SoccerShotXgResearchPanel,{view,game:displayGame,analysisCutoff}));
const render=(report,displayGame=game)=>renderView(viewFor(report,displayGame),displayGame);
const valid=example(),markup=render(valid);
assert.match(markup,/2017\/18 英超/);assert.match(markup,/來源清單 380 場，資料核對可用 378 場，隔離 2 場/);
assert.match(markup,/切分評估納入 366 場、9200 次非十二碼射門/);assert.match(markup,/12 場未納入本次切分/);
assert.match(markup,/0\.2900/);assert.match(markup,/0\.3012/);assert.match(markup,/0\.3020/,'worse raw/calibrated candidate values remain visible');
assert.match(markup,/48 小時間隔/);assert.match(markup,/測試結果不參與選模型或調參/);
assert.match(markup,/CC BY 4\.0/);assert.match(markup,/Pappalardo/);
assert.match(markup,/並非當時已凍結的獨立賽前驗收/);assert.match(markup,/當季完整 npxG/);
assert.match(markup,/XY 模型的分箱校準/);assert.match(markup,/4\.0%/);assert.match(markup,/5\.0%/);
assert.doesNotMatch(markup,/NaN|Infinity|undefined|正式評分已完成|勝率提高/);
for(const change of [{version:'FORGED'},{provider:'ESPN'},{league:'ucl'},{synthetic:true},{accepted:true},{formalEligible:true},{modelEffectApplied:true},
  {sourceAuthenticationVerified:false},{currentSeasonCoverageVerified:true},{uclCoverageVerified:true},{independentUntouchedTestVerified:true},
  {rawRowsIncluded:true},{fittedCoefficientsIncluded:true},{coordinateContract:'GUESSED_105X68'}])assert.equal(render(reseal({...valid,...change})), '');
assert.equal(render({...valid,coverage:{...valid.coverage,includedMatches:380}}),'','mutating a saved public report invalidates its display binding');
assert.equal(render(reseal({...valid,protocol:{...valid.protocol,embargoHours:0}})),'');
assert.equal(render(valid,{league:'nba'}),'');
const uclGame={...game,id:'soccer:ucl:123',league:'ucl'};
assert.equal(render(valid,uclGame),'','an EPL aggregate cannot appear inside a UCL available view');
const ucl=renderView({...viewFor(null,uclGame),status:'NO_LEAGUE_COHORT'},uclGame);
assert.match(ucl,/本聯盟尚無符合本方法的同聯盟保留期測試/);assert.doesNotMatch(ucl,/0\.3012|380 場|9200 次|保留期測試<\/h5>/);
const missing=reseal({...valid,evaluation:{test:null}});
assert.match(render(missing),/保留期測試尚無可核對結果/);assert.doesNotMatch(render(missing),/0\.0000/);
const invalid=example();invalid.evaluation.test.candidate.logLoss=NaN;invalid.evaluation.test.candidate.brier=Infinity;
invalid.evaluation.test.candidate.predictedMean=-.1;invalid.evaluation.test.candidate.calibrationBins[0].predictedMean=null;
const invalidMarkup=render(reseal(invalid));
assert.doesNotMatch(invalidMarkup,/NaN|Infinity|-10\.0%/);assert.match(invalidMarkup,/—/);
const mismatch=example();mismatch.evaluation.test.candidate.games=99;
assert.match(render(reseal(mismatch)),/各方法的評估樣本不同/);
const rawBin=example();rawBin.evaluation.test.candidate.calibrationBins[0].lower='<script>untrusted</script>';
assert.doesNotMatch(render(reseal(rawBin)),/<script>|untrusted/,'malformed probabilities cannot become markup');
const renderParent=(shotXg,analysisCutoff=savedCutoff)=>renderToStaticMarkup(React.createElement(context.SoccerModelDevelopmentPanel,{shotXg,game,analysisCutoff}));
assert.match(renderParent(viewFor(valid)),/人員、逐場 xG 與賽程條件模型/);assert.match(renderParent(viewFor(valid)),/自建射門 xG/);
assert.equal(renderParent({...viewFor(valid),formalEligible:true}),'');
assert.equal(renderParent(undefined),'');
for(const change of [{gameId:'soccer:epl:999'},{league:'ucl'},{formalEligible:true},{W:0},{currentSeasonModelApplied:true},{version:'FORGED'},
  {analysisCutoff:'2026-11-07T11:59:59Z'},{analysisCutoff:'2026-11-07 13:00:00'}])assert.equal(renderView({...viewFor(valid),...change}),'');
for(const [key,value] of Object.entries({sourceId:'999',date:'2026-11-08',startTime:'2026-11-07T21:00:00Z',homeSourceId:'2',awaySourceId:'1'})){
  const view=viewFor(valid);view.gameContext[key]=value;assert.equal(renderView(view),'','different fixture context cannot borrow this saved view');
}
assert.equal(renderView({...viewFor(valid),artifact:{...viewFor(valid).artifact,createdAt:'2026-11-07T14:00:00Z'}}),'');
assert.match(renderView({...viewFor(null),status:'NOT_AVAILABLE_AT_CUTOFF'}),/未將後來的研究結果填入舊分析/);
assert.match(renderView({...viewFor(null),status:'ARTIFACT_INVALID',artifact:null}),/尚未通過內容核對/);
assert.equal(renderView({...viewFor(valid),status:'NO_LEAGUE_COHORT'}),'','missing states never carry report metrics');
const unsupported=example();unsupported.evaluation.test.calibratedCandidate=null;
assert.match(render(reseal(unsupported)),/校準版本尚無可核對結果/);
assert.equal(renderView(viewFor(valid),game,'2026-11-07T11:00:00Z'),'','same-fixture later report cannot be inserted into an older saved result');
assert.equal(renderView(viewFor(valid),game,null),'','new source research fails closed without the saved analysis cutoff');
assert.equal(renderParent(viewFor(valid),null),'');
assert.equal(renderParent(viewFor(valid),'2026-11-07T11:00:00Z'),'');
const parentSource=fs.readFileSync('app/soccer/analysis-panel.js','utf8');
assert.match(parentSource,/analysisCutoff=\{data\.analysisCutoff\|\|data\.observedAt\}/,'saved result cutoff reaches the research renderer');
assert.match(parentSource,/shotXg=\{data\.shotXgResearch\}/,'the displayed report comes from the saved analysis payload');
console.log('PASS actual shot-xG research JSX: saved hash/scope/restriction checks, visible adverse holdout comparisons, unknown metrics, raw/cal bins, EPL/UCL isolation, safe missing state and existing parent integration; no formal score authorization');
