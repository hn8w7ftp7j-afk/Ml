import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { soccerPersonnelArtifacts } from '../lib/soccer/personnel-frozen.js';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerAnalysis } from '../lib/soccer/analysis.js';

const shipped=fs.readFileSync('app/soccer/analysis-panel.js','utf8');
const source=shipped.replace(/^import .*?;\n/gm,'').replace(/export default function|export function/g,'function');
const {code}=await transform(source,{filename:'soccer-personnel-analysis.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
let analysisContext={states:{},run:()=>{}};
const ctx=vm.createContext({React,Date,URLSearchParams,AbortSignal,createContext:()=>({}),useContext:()=>analysisContext,
  useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useRef:initial=>({current:initial}),useEffect:()=>{},
  SoccerManualSimulation:()=>null,SoccerMarketDirections:()=>null,SoccerWorkloadPanel:()=>null,SoccerHalfTimeResearch:()=>null,SoccerWorkspace:({children})=>children});
vm.runInContext(code,ctx);
const render=props=>renderToStaticMarkup(ctx.SoccerPersonnelResearch(props));
const artifact=soccerPersonnelArtifacts(),analysisCutoff='2026-10-20T00:00:00Z';
const baseline={homeRate:1.4,awayRate:1.1,outcomes:{home:.48,draw:.27,away:.25}};
function projection(league){
  const p=artifact.leagues[league];
  return{artifactHash:artifact.contentHash,protocolHash:artifact.protocolHash,trainingHash:p.model.trainingHash,baselineHash:p.model.baselineHash,
    status:'RESEARCH_CHALLENGER_AVAILABLE',reason:null,defaultDistribution:'UNCHANGED_BASELINE',challengerDisplayOnly:true,formalEnabled:false,
    collection:p.collection,validation:{originalPopulation:p.validation.originalPopulation,commonCount:p.validation.commonCount,
      preferredModel:p.validationPreferredModel,reference:p.validation.reference,challenger:p.validation.trials.find(t=>t.penalty===p.selectedPenalty)?.common||null},
    diagnostic:{count:p.diagnostic.count,sample:p.diagnostic.sample,logLoss:p.diagnostic.logLoss,brier:p.diagnostic.brier,baseline:p.diagnostic.baseline,
      comparison:p.diagnostic.comparison,interpretation:p.diagnostic.interpretation}};
}
function fixture(league='epl'){
  return{league,analysisCutoff,baseline,research:projection(league),prediction:{league,period:'REGULATION_FT',mode:'CURRENT_PREMATCH',
    status:'RESEARCH_ONLY',formalEnabled:false,executable:false,homeRate:1.76,awayRate:1.12,outcomes:{home:.53,draw:.21,away:.26},
    cutoff:'2026-10-18T00:00:00Z',trainedThrough:'2026-10-17T00:00:00Z',
    personnelObservation:{availability:'OBSERVED_PREMATCH_XI',sourceHash:'a'.repeat(64),fetchedAt:'2026-10-19T23:59:00Z'}}};
}
for(const league of ['epl','ucl']){
  const props=fixture(league),before=JSON.stringify(props),html=render(props),p=artifact.leagues[league];
  assert.match(html,/<details class="soccerDetails soccerPersonnelResearch">/);assert.doesNotMatch(html,/<details[^>]+\sopen(?:=|>)/,'personnel study is collapsed initially');
  assert.match(html,/<summary>先發人員模型研究<\/summary>/);assert.match(html,/估計先發組合與進球率的關聯/);
  assert.match(html,/尚未估計傷停、預計分鐘、替補差距或因果影響/);assert.match(html,/本場全場比分研究比較/);
  for(const value of ['1.40','1.10','1.76','1.12','48.0%','53.0%'])assert.ok(html.includes(value),`current baseline and XI study retain their separate ${value} values`);
  assert.ok(html.includes(`共同可比較 ${p.validation.commonCount}／原始母體 ${p.validation.originalPopulation} 場`));
  assert.ok(html.includes(`共同可評估 ${p.diagnostic.count}／原始母體 ${p.diagnostic.sample} 場`));
  for(const metric of [p.validation.reference.logLoss,p.validation.trials.find(t=>t.penalty===p.selectedPenalty).common.logLoss,p.diagnostic.logLoss,p.diagnostic.baseline.logLoss])assert.ok(html.includes(metric.toFixed(3)));
  assert.match(html,/2024 年選模保留原比分基準/);assert.match(html,/2025 年資料已用於先前開發/);assert.match(html,/不是新的未用樣本外測試（OOS）/);
  assert.match(html,/目前預設比分分布維持原基準/);assert.match(html,/未啟用正式 W／R／S、候選或下注/);
  assert.doesNotMatch(html,/undefined|NaN|Infinity|RESEARCH_CHALLENGER_AVAILABLE|UNCHANGED_BASELINE|personnel-frozen/);
  assert.equal(JSON.stringify(props),before,'rendering cannot alter either distribution or stored research metrics');
}
console.log('PASS shipped personnel JSX: collapsed current XI association study, unchanged baseline, exact EPL/UCL paired 2024 cohorts/metrics, 2025 retrospective limitations and no formal promotion');

const props=fixture();
for(const [reason,message] of [['PERSONNEL_XI_INCOMPLETE','兩隊先發尚未完整核對'],['PERSONNEL_PREMATCH_LINEUP_UNVERIFIED','兩隊賽前先發尚未完整核對'],
  ['PERSONNEL_PLAYER_NOT_TRAINED','缺少訓練資料的球員'],['PERSONNEL_XI_SOURCE_UNVERIFIED','先發來源尚未通過核對'],
  ['PERSONNEL_PREMATCH_AVAILABILITY_UNVERIFIED','尚無符合分析時間的有效賽前先發觀察'],['NOT_A_PREMATCH_SNAPSHOT','賽後資料不補算'],
  ['SCORE_MODEL_UNAVAILABLE','缺少適用的比分基準'],['UNRECOGNIZED_INTERNAL_CODE','尚未完整核對']]){
  const html=render({...props,prediction:null,research:{...props.research,status:'PERSONNEL_INPUTS_INSUFFICIENT',reason}});
  assert.ok(html.includes(message));assert.doesNotMatch(html,/本場全場比分研究比較|1\.76|53\.0%|UNRECOGNIZED_INTERNAL_CODE/);
  assert.match(html,/2024 年共同樣本選模/,'a missing current XI does not erase known retrospective diagnostics');
}
for(const patch of [{homeRate:null},{awayRate:NaN},{league:'ucl'},{mode:'RETROSPECTIVE_OBSERVED_XI'},{period:'REGULATION_HT'},
  {formalEnabled:true},{cutoff:'2026-10-21T00:00:00Z'},{trainedThrough:'2026-10-21T00:00:00Z'},
  {personnelObservation:{...props.prediction.personnelObservation,fetchedAt:'2026-10-20T00:00:01Z'}}]){
  const html=render({...props,prediction:{...props.prediction,...patch}});assert.doesNotMatch(html,/本場全場比分研究比較|1\.76|53\.0%|NaN/);
}
const old=render({baseline,league:'epl',analysisCutoff});assert.match(old,/此歷史版本尚未保存先發人員研究/);assert.doesNotMatch(old,/2024 年共同樣本選模|共同可評估|53\.0%/);
const future=render({...props,research:{...props.research,status:'NOT_AVAILABLE_AT_CUTOFF',reason:'PERSONNEL_ARTIFACT_NOT_AVAILABLE_AT_CUTOFF'}});
assert.match(future,/不帶入較晚模型或研究數字/);assert.doesNotMatch(future,/本場全場比分研究比較|2024 年共同樣本選模|共同可比較|共同可評估|1\.76|53\.0%/);
const unmatched=render({...props,research:{...props.research,validation:{...props.research.validation,challenger:{count:1,logLoss:.0001}}}});
assert.match(unmatched,/2024 年尚無可核對的共同樣本比較/);assert.doesNotMatch(unmatched,/0\.000/,'unpaired figures cannot be shown as paired validation');
for(const value of [{},{prediction:{}},{research:{}},{research:props.research}])assert.doesNotThrow(()=>render(value));
assert.doesNotMatch(shipped,/import[^;]*(?:personnel-frozen|personnel-model|personnel-history)/,'the client consumes the small saved projection without importing model artifacts');
console.log('PASS missing/unknown XI, rates and source/model cutoff guards, cross-league/HT exclusion, Chinese reasons, paired denominators, safe legacy snapshots and no future-artifact values');

// Render the actual parent with an authentic legacy/pre-artifact snapshot.
const payload=JSON.parse(fs.readFileSync('scripts/fixtures/soccer/epl-summary.json','utf8')),competition=payload.header.competitions[0];
const at='2026-10-18T13:35:00Z',now=Date.parse(at),sourceMeta={provider:'ESPN',url:'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=401878769',fetchedAt:at,contentHash:'ui-reconstructed-provider-fixture'};
const game=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:competition.date,status:competition.status}]},'epl',sourceMeta).games[0];
const evidence=normalizeSoccerPrematch(payload,game,sourceMeta,now),snapshot=buildSoccerAnalysis({evidence,now});
analysisContext={states:{[game.id]:{status:'done',data:{...snapshot,persisted:true}}},run:()=>{}};
const parent=renderToStaticMarkup(ctx.SoccerAnalysisPanel({game}));
assert.match(parent,/<summary>先發人員模型研究<\/summary>/);assert.match(parent,/不帶入較晚模型或研究數字/);
assert.ok(parent.indexOf('研究比分分布')<parent.indexOf('先發人員模型研究'));
assert.ok(parent.indexOf('先發人員模型研究')<parent.indexOf('先發、裁判與待核對資料'));
assert.doesNotMatch(parent,/undefined|NaN/);
delete analysisContext.states[game.id].data.personnelResearch;delete analysisContext.states[game.id].data.personnelPrediction;
assert.match(renderToStaticMarkup(ctx.SoccerAnalysisPanel({game})),/此歷史版本尚未保存先發人員研究/);
console.log('PASS actual parent JSX places personnel details below baseline; real pre-artifact and legacy snapshots retain historical-time limits without replacing the baseline');
