import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';

const source=fs.readFileSync('app/soccer/analysis-panel.js','utf8');
const raw=source.replace(/^import .*?;\n/gm,'').replace(/export default function/g,'function').replace(/export function/g,'function');
const {code}=await transform(raw,{filename:'soccer-requirements-ui.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const games=Array.from({length:8},(_,i)=>({id:`soccer:epl:${i+1}`,sourceId:String(i+1),league:'epl',date:'2026-10-20',startTime:'2099-10-20T13:00:00Z',status:'scheduled',home:{name:'Home'},away:{name:'Away'}}));
const current={analysisStatus:'COMPLETED',selectionResult:'RESEARCH_SHADOW',publishedCurrent:true,qaFlag:'WARN'};
const plain=v=>JSON.parse(JSON.stringify(v));
const context=vm.createContext({React,createContext:()=>({Provider:'provider'})});
vm.runInContext(code,context);
const presentation=state=>plain(context.soccerAnalysisPresentation(state));
assert.equal(presentation().analysisStatus,'NOT_STARTED');
assert.equal(presentation({status:'loading',data:current}).selectionResult,null,'an old completed result cannot count while its replacement is running');
assert.equal(presentation({status:'error',analysisStatus:'FAILED',data:current}).analysisStatus,'FAILED');
assert.equal(presentation({status:'error',analysisStatus:'FAILED',data:current}).selectionResult,null);
assert.equal(presentation({status:'error',analysisStatus:'INSUFFICIENT_DATA',data:current}).analysisStatus,'INSUFFICIENT_DATA');
assert.equal(presentation({status:'done',data:current}).selectionResult,'RESEARCH_SHADOW');
assert.equal(presentation({status:'done',data:{...current,publishedCurrent:false}}).analysisStatus,'UNVERIFIED');
assert.equal(presentation({status:'done',data:{...current,publishedCurrent:undefined}}).current,false,'a legacy snapshot is readable but cannot establish current completion');
assert.equal(presentation({status:'done',data:{...current,analysisStatus:'INSUFFICIENT_DATA',selectionResult:null}}).selectionResult,null);
assert.deepEqual(presentation({status:'done',data:{analysisStatus:'INSUFFICIENT_DATA',selectionResult:null,publishedCurrent:false}}),{analysisStatus:'INSUFFICIENT_DATA',analysisLabel:'資料不足',selectionResult:null,selectionLabel:'尚無結果',current:false},'a saved data-shortage response does not need a published research distribution');
const states={
  [games[1].id]:{status:'queued'},[games[2].id]:{status:'loading'},
  [games[3].id]:{status:'error',analysisStatus:'FAILED',data:current},
  [games[4].id]:{status:'done',data:{...current,analysisStatus:'INSUFFICIENT_DATA',selectionResult:null}},
  [games[5].id]:{status:'done',data:current},
  [games[6].id]:{status:'done',data:{...current,publishedCurrent:false}},
  [games[7].id]:{status:'done',data:{...current,publishedCurrent:undefined}},
  'soccer:ucl:foreign':{status:'done',data:current},
};
assert.deepEqual(plain(context.soccerAnalysisCounts(games,states)),{total:8,candidates:0,waiting:3,processing:2,completed:1,insufficient:1,failed:1,research:1},'the current board, including unstarted and failed games, fixes the summary denominator');

const audit={layers:[{key:'personnel',title:'球員與分鐘',items:[
  {key:'lineup',label:'先發陣容',status:'AVAILABLE',reason:'資料源列出名單，公布時點尚未核對。',modelUsage:'OBSERVED_ONLY'},
  {key:'minutes',label:'預計分鐘',status:'UNKNOWN',reason:'分鐘模型未驗證。',modelUsage:'NOT_AVAILABLE'},
  {key:'history',label:'歷史比分',status:'PARTIAL',reason:'僅使用研究資料。',modelUsage:'USED_BASELINE'},
]}]};
const details=renderToStaticMarkup(context.SoccerRequirementDetails({audit}));
assert.match(details,/資料已取得/);assert.match(details,/資料待補/);assert.match(details,/資料部分取得/);
assert.match(details,/僅供觀測，未納入模型/);assert.match(details,/已用於研究基準/);
assert.match(details,/資料已取得不代表已納入模型/);assert.match(details,/\/soccer\/specification/);
assert.doesNotMatch(details,/undefined|NaN|正式模型已驗證/);
assert.match(renderToStaticMarkup(context.SoccerRequirementDetails({})),/歷史版本尚未保存六層核對結果/);

function harness(fetch){
  const state=[],refs=[];let si=0,ri=0;
  const ctx=vm.createContext({React,Date,URLSearchParams,AbortController,AbortSignal,setTimeout,clearTimeout,fetch,
    createContext:()=>({Provider:'provider'}),useContext:()=>({states:state[0],run:ctx.provider().props.value.run}),
    useState:initial=>{const i=si++;if(!(i in state))state[i]=initial;return[state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];},
    useRef:initial=>refs[ri++]||(refs[ri-1]={current:initial}),useEffect:()=>{}});
  vm.runInContext(code,ctx);ctx.provider=()=>{si=0;ri=0;return ctx.SoccerAnalysisProvider({games,children:[]});};
  return{state,provider:ctx.provider,panel:game=>{si=2;return ctx.SoccerAnalysisPanel({game});}};
}
for(const analysisStatus of ['FAILED','INSUFFICIENT_DATA']){
  const h=harness(async()=>Response.json({ok:false,error:'資料來源暫時無法核對',analysisStatus,selectionResult:null,qaFlag:'BLOCKED',analysisRunId:'failed-run'},{status:503}));
  await h.provider().props.value.run(games[0]);
  assert.equal(h.state[0][games[0].id].analysisStatus,analysisStatus);
  assert.equal(h.state[0][games[0].id].analysisRunId,'failed-run');
  const markup=renderToStaticMarkup(h.panel(games[0]));
  assert.match(markup,analysisStatus==='FAILED'?/分析：<strong>失敗/:/分析：<strong>資料不足/);
  assert.match(markup,/篩選：<strong>尚無結果/);
  assert.doesNotMatch(markup,/篩選：<strong>研究中|分析：<strong>完成/);
}
const superseded=harness(async()=>Response.json({ok:true,...current,publishedCurrent:false,gameId:games[0].id,league:'epl',date:games[0].date,formalScoringEnabled:false,executable:false,directions:Array.from({length:8},()=>({executable:false,eligible:false}))}));
await superseded.provider().props.value.run(games[0]);
assert.equal(plain(context.soccerAnalysisCounts(games,superseded.state[0])).completed,0);
const invalid=harness(async()=>Response.json({ok:true,...current,selectionResult:'CANDIDATE',gameId:games[0].id,league:'epl',date:games[0].date,formalScoringEnabled:false,executable:false,directions:Array.from({length:8},()=>({executable:false,eligible:false}))}));
await invalid.provider().props.value.run(games[0]);assert.equal(invalid.state[0][games[0].id].status,'error','an unexpected formal selection cannot enter the research-only UI');

const {normalizeSoccerPrematch}=await import('../lib/soccer/prematch.js');
const {normalizeSoccerSchedule}=await import('../lib/soccer/data.js');
const {buildSoccerAnalysis}=await import('../lib/soccer/analysis.js');
const payload=JSON.parse(fs.readFileSync('scripts/fixtures/soccer/minutes-past.json'));
const competition=payload.header.competitions[0],at='2026-10-18T14:50:00Z';
const sourceInfo={provider:'ESPN',fetchedAt:at,url:'https://fixture.invalid',contentHash:'fixture'};
const realGame=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:competition.date,status:competition.status}]},'epl',sourceInfo).games[0];
const evidence=normalizeSoccerPrematch(payload,realGame,sourceInfo,Date.parse(at));
const saved={...buildSoccerAnalysis({evidence,now:Date.parse(at)}),...current,persisted:true};
const insufficientResult={...saved,analysisStatus:'INSUFFICIENT_DATA',selectionResult:null,qaFlag:'BLOCKED',prediction:null,publishedCurrent:false,analysisRunId:'insufficient-run'};
const insufficient=harness(async()=>Response.json(insufficientResult));
await insufficient.provider().props.value.run(realGame);
assert.equal(plain(context.soccerAnalysisCounts([realGame],insufficient.state[0])).insufficient,1);
assert.equal(plain(context.soccerAnalysisCounts([realGame],insufficient.state[0])).waiting,0);
const insufficientMarkup=renderToStaticMarkup(insufficient.panel(realGame));
assert.match(insufficientMarkup,/分析：<strong>資料不足/);assert.match(insufficientMarkup,/本次資料不足/);
assert.match(insufficientMarkup,/篩選：<strong>尚無結果/);
assert.doesNotMatch(insufficientMarkup,/版本已失效|上次資料.*歷史查閱|分析：<strong>待重新核對/);
let attempt=0;
const refreshed=harness(async()=>attempt++===0?Response.json(saved):Response.json({ok:false,error:'重新核對失敗',analysisStatus:'FAILED',selectionResult:null,qaFlag:'BLOCKED'},{status:503}));
await refreshed.provider().props.value.run(realGame);
await new Promise(resolve=>setImmediate(resolve));
await refreshed.provider().props.value.run(realGame);
assert.ok(refreshed.state[0][realGame.id].data,'a failed refresh keeps the previous immutable evidence available');
const historicalMarkup=renderToStaticMarkup(refreshed.panel(realGame));
assert.match(historicalMarkup,/分析：<strong>失敗/);assert.match(historicalMarkup,/篩選：<strong>尚無結果/);
assert.match(historicalMarkup,/上次資料.*僅供歷史查閱/);assert.match(historicalMarkup,/不代表本次完成/);
assert.doesNotMatch(historicalMarkup,/分析：<strong>完成|篩選：<strong>研究中/);

const runs=[
  {analysisRunId:'processing',startedAt:at,analysisStatus:'PROCESSING',selectionResult:null,reasons:[]},
  {analysisRunId:'failed',startedAt:at,analysisStatus:'FAILED',qaFlag:'BLOCKED',selectionResult:null,reasons:['SOCCER_SOURCE_TIMEOUT']},
  {analysisRunId:'insufficient',startedAt:at,analysisStatus:'INSUFFICIENT_DATA',qaFlag:'BLOCKED',selectionResult:null,reasons:['SCORE_MODEL_UNAVAILABLE']},
];
const children=v=>Array.isArray(v)?v.flatMap(children):v&&typeof v==='object'?[v,...children(v.props?.children)]:[];
for(const includeRuns of [true,false]){
  const historyBody={ok:true,gameId:games[0].id,league:'epl',date:games[0].date,versions:[],...(includeRuns?{runs}:{})};
  const history=harness(async()=>Response.json(historyBody));
  history.provider();
  const button=children(history.panel(games[0])).find(node=>node.type==='button'&&node.props.children==='讀取最近紀錄');
  await button.props.onClick();
  assert.equal(history.state[2].error,'');assert.equal(history.state[2].runs.length,includeRuns?3:0);
  const markup=renderToStaticMarkup(history.panel(games[0]));
  if(includeRuns){assert.match(markup,/最近分析嘗試/);assert.match(markup,/分析：處理中/);assert.match(markup,/分析：失敗/);assert.match(markup,/分析：資料不足/);assert.match(markup,/資料來源讀取逾時/);assert.doesNotMatch(markup,/篩選：研究中/);}
}

const {SOCCER_REQUIREMENTS_VERSION,SOCCER_REQUIREMENT_LAYERS,SOCCER_REQUIREMENTS_GATES}=await import('../lib/soccer/requirements.js');
const specification=fs.readFileSync('app/soccer/specification/page.js','utf8').replace(/^import .*?;\n/gm,'').replace('export const metadata','const metadata').replace('export default function','function');
const compiled=await transform(specification,{filename:'soccer-specification.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const specificationContext=vm.createContext({React,SOCCER_REQUIREMENTS_VERSION,SOCCER_REQUIREMENT_LAYERS,SOCCER_REQUIREMENTS_GATES});
vm.runInContext(compiled.code,specificationContext);
const specificationMarkup=renderToStaticMarkup(specificationContext.SoccerSpecificationPage());
assert.equal(SOCCER_REQUIREMENT_LAYERS.length,6);for(const layer of SOCCER_REQUIREMENT_LAYERS)assert.ok(specificationMarkup.includes(layer.title));
assert.match(specificationMarkup,/SOCCER_ANALYSIS_2_2\.md/);assert.match(specificationMarkup,/目前正式評分、候選排名及下注尚未啟用/);
assert.doesNotMatch(specificationMarkup,/undefined|NaN|\/workspace\/|DATABASE_URL/);
console.log('PASS soccer requirement UI: current-version boundary, separate analysis/selection, full board counts, preserved API failure states, research-only response guard and observed-vs-modeled evidence');
