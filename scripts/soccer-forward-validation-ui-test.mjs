import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { buildSoccerProbabilityAudit } from '../lib/soccer/probability-audit.js';
import { SOCCER_FORWARD_POLICY,SOCCER_FORWARD_VERSION } from '../lib/soccer/forward-validation.js';

const compile=async(path,name)=>transform(fs.readFileSync(path,'utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function'),{
 filename:name,jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}},
});
const calibration=await compile('app/soccer/calibration-panel.js','forward-calibration.jsx'),calibrationContext=vm.createContext({React});vm.runInContext(calibration.code,calibrationContext);
const compiled=await compile('app/soccer/forward-validation-panel.js','forward-validation-panel.jsx');
const renderContext=vm.createContext({React,SoccerCalibrationPanel:calibrationContext.SoccerCalibrationPanel});vm.runInContext(compiled.code,renderContext);
const report=(league='epl',groups=[])=>({version:SOCCER_FORWARD_VERSION,protocol:{activatedAt:'2026-10-20T00:00:00Z'},canonicalRule:SOCCER_FORWARD_POLICY,
 capturedSnapshotPeriods:groups.length,selectedGameModelPeriods:groups.reduce((n,g)=>n+(g.capturedGames||0),0),evaluatedGameModelPeriods:groups.reduce((n,g)=>n+(g.evaluatedGames||0),0),
 excludedSnapshotPeriods:0,excludedReasons:{},laterReanalysesNotSelected:0,uniqueSelectedGames:groups.length,groups,complete:true,truncated:false,
 formalEligible:false,promotionEligible:false,executable:false,readAt:'2026-10-20T00:30:00Z'});
const scope={league:'epl',period:'REGULATION_FT',modelHash:'a'.repeat(64),fold:'forward'};
const audit=buildSoccerProbabilityAudit([{...scope,eventId:'123',status:'EVALUATED',actualOutcome:'home',probabilities:{home:1,draw:0,away:0},retainedMass:1,tailMass:0}],scope);
const group={...scope,variant:'BASELINE',modelVersion:'REAL-UI-FIXTURE',receivedSnapshotPeriods:1,excludedSnapshotPeriods:0,excludedReasons:{},laterReanalysesNotSelected:0,
 capturedGames:1,evaluatedGames:1,pendingGames:0,pendingReasons:{},properScores:{count:1,brier:0,logLoss:0,logLossState:'FINITE',scoreLogLoss:0,exactScoreCount:1,exactScoreExcluded:0},probabilityAudit:audit,observations:[]};
const renderReport=(value,league='epl',summary)=>renderToStaticMarkup(React.createElement(renderContext.ForwardReport,{report:value,league,summary}));
const zero=renderReport(report('epl',[group]));
assert.match(zero,/已封存 1、已評估 1、待賽果 0/);assert.match(zero,/<td>1<\/td><td>0\.0000<\/td><td>0\.0000<\/td><td>0\.0000<\/td>/,'real zero errors with a nonempty denominator remain visible');
assert.match(zero,/主勝<\/th><td>1<\/td><td>0\.0000<\/td>/,'the shipped calibration component receives the actual audit');
assert.match(zero,/開賽前封存樣本｜全場/);assert.doesNotMatch(zero,/資料為事後回補的研究診斷/,'forward data must not inherit the retrospective disclaimer');
const missingGroup={...group,capturedGames:undefined,evaluatedGames:undefined,pendingGames:undefined,properScores:{},probabilityAudit:null};
const missing=renderReport(report('epl',[missingGroup]));assert.match(missing,/已封存 未知、已評估 未知、待賽果 未知/);assert.match(missing,/<td>未知<\/td><td>—<\/td><td>—<\/td><td>—<\/td>/);assert.doesNotMatch(missing,/NaN|undefined|Infinity|0\.0000/);
const pendingGroup={...group,period:'REGULATION_HT',variant:'BASELINE',evaluatedGames:0,pendingGames:1,
 properScores:{count:0,brier:null,logLoss:null,logLossState:'NO_SAMPLES',scoreLogLoss:null,exactScoreCount:0,exactScoreExcluded:0},probabilityAudit:null,
 pendingReasons:{FORWARD_RESULT_NOT_CHECKED:1},excludedReasons:{FORWARD_FIRST_CAPTURE_NOT_PREGAME:2}};
const pending=renderReport(report('epl',[pendingGroup]));assert.match(pending,/上半場｜基準模型｜已封存 1、已評估 0、待賽果 1/);assert.match(pending,/<td>0<\/td><td>—<\/td><td>—<\/td><td>—<\/td>/);
assert.match(pending,/賽果尚未核對：1 筆/);assert.match(pending,/首次封存未早於開賽：2 筆/);assert.match(pending,/FORWARD_FIRST_CAPTURE_NOT_PREGAME/);
const challenger=renderReport(report('epl',[{...group,variant:'PERSONNEL_CHALLENGER',modelHash:'b'.repeat(64)}]));assert.match(challenger,/人員研究挑戰模型/);
const empty=renderReport(report());assert.match(empty,/尚無方案啟用後的合格封存樣本/);assert.match(empty,/不以既有 2025 年資料補成新的 OOS/);assert.doesNotMatch(empty,/0\.0000|NaN|undefined/);
const infinite=renderReport(report('epl',[{...group,properScores:{...group.properScores,logLoss:null,logLossState:'POSITIVE_INFINITY'}}]));assert.match(infinite,/\+∞（實際結果曾被預估為零機率）/);
const truncated=renderReport({...report(),truncated:true,complete:false});assert.match(truncated,/請用上方日期範圍縮小查詢/);

const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const text=value=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):String(value??'');
function harness({league='epl',throwFirst=false}={}){
 let props={league},cursor=0,dirty=false,tree,writes=0,fetchCount=0,timerId=0;
 const hooks=[],effects=[],calls=[],timers=new Map();
 const ctx=vm.createContext({React,Date,URLSearchParams,AbortController,SoccerCalibrationPanel:calibrationContext.SoccerCalibrationPanel,
  useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return[hooks[i],update=>{hooks[i]=typeof update==='function'?update(hooks[i]):update;dirty=true;writes++;}];},
  useRef:initial=>{const i=cursor++;return hooks[i]??={current:initial};},
  useEffect:(fn,deps)=>{const i=cursor++,previous=hooks[i];if(previous&&deps.every((v,j)=>Object.is(v,previous.deps[j])))return;hooks[i]={deps};effects.push(()=>{previous?.cleanup?.();hooks[i].cleanup=fn();});},
  setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId;},clearTimeout:id=>timers.delete(id),
  fetch:(url,options)=>{fetchCount++;if(throwFirst&&fetchCount===1)throw Error('controlled synchronous fetch failure');return new Promise((resolve,reject)=>calls.push({url,options,reject,respond:(body,status=200)=>resolve({ok:status>=200&&status<300,status,json:async()=>body})}));},
 });
 vm.runInContext(compiled.code,ctx);
 function render(next=props){props=next;let turns=0;do{cursor=0;dirty=false;tree=ctx.SoccerForwardValidationPanel(props);effects.splice(0).forEach(fn=>fn());assert.ok(turns++<20);}while(dirty);return tree;}
 async function settle(){for(let i=0;i<25;i++){await Promise.resolve();if(dirty)render();}}
 const button=label=>nodes(tree).find(n=>n.type==='button'&&text(n.props.children)===label);
 return{render,settle,calls,timers,button,get tree(){return tree;},get writes(){return writes;},get markup(){return renderToStaticMarkup(tree);},
  input:(name,value)=>nodes(tree).find(n=>n.type==='input'&&n.props.name===name).props.onChange({target:{value}}),
  apply:()=>nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}}),
  unmount:()=>hooks.forEach(h=>h?.cleanup?.()),
 };
}
const h=harness();h.render();assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/soccer/forward-validation?league=epl');
assert.match(h.markup,/ESPN 兩個端點交叉核對，並非獨立官方來源確認/);assert.match(h.markup,/模型放行維持關閉/);assert.match(h.markup,/不會新增下注/);
const first=h.calls[0];h.button('核對已封存賽果').props.onClick();h.button('重新讀取').props.onClick();assert.equal(h.calls.length,1,'GET and POST cannot overlap even when old handlers are invoked before re-render');
first.respond({ok:true,report:report('epl',[group])});await h.settle();assert.equal(h.button('核對已封存賽果').props.disabled,false);
const run=h.button('核對已封存賽果').props.onClick;const a=run(),b=run();h.button('重新讀取').props.onClick();assert.equal(h.calls.length,2,'duplicate POST and concurrent refresh deduplicate through the synchronous flight ref');
assert.deepEqual(JSON.parse(h.calls[1].options.body),{action:'evaluate',league:'epl',limit:25});assert.equal(h.calls[1].options.credentials,'same-origin');
h.calls[1].respond({ok:true,report:report('epl',[group]),summary:{checkedGameModelPeriods:1,evaluated:1,pending:0,deferred:0,reasons:{}}});await Promise.all([a,b]);await h.settle();assert.match(h.markup,/本次核對 1 筆/);
const n=h.calls.length;h.render();assert.equal(h.calls.length,n,'ordinary re-renders do not trigger new GETs');
h.input('from','2026-02-30');h.input('through','2026-03-01');await h.settle();h.apply();await h.settle();assert.equal(h.calls.length,n);assert.match(h.markup,/有效的開始與結束日期/);
h.input('from','2026-10-19');h.input('through','2026-10-20');await h.settle();h.apply();await h.settle();assert.equal(h.calls.length,n+1);assert.match(h.calls.at(-1).url,/from=2026-10-19&through=2026-10-20/);assert.doesNotMatch(h.markup,/REAL-UI-FIXTURE/,'old-range metrics are hidden immediately until the new range responds');
h.calls.at(-1).respond({ok:true,report:report('epl',[group])});await h.settle();const filtered=h.button('核對已封存賽果').props.onClick();assert.deepEqual(JSON.parse(h.calls.at(-1).options.body),{action:'evaluate',league:'epl',from:'2026-10-19',through:'2026-10-20',limit:25});
h.calls.at(-1).respond({ok:true,report:report(),summary:{checkedGameModelPeriods:0,evaluated:0,pending:0,deferred:0}});await filtered;await h.settle();h.unmount();assert.equal(h.timers.size,0);

const late=harness();late.render();const eplRequest=late.calls[0];late.render({league:'ucl'});assert.equal(eplRequest.options.signal.aborted,true);assert.equal(late.calls.length,2);assert.doesNotMatch(late.markup,/REAL-UI-FIXTURE/);
eplRequest.respond({ok:true,report:report('epl',[group])});await late.settle();assert.doesNotMatch(late.markup,/REAL-UI-FIXTURE/,'a late response is ignored even if the transport disregards abort');
late.calls[1].respond({ok:true,report:report('ucl')});await late.settle();assert.match(late.markup,/歐冠｜前瞻驗證/);
const refresh=late.button('重新讀取').props.onClick();const outstanding=late.calls.at(-1),before=late.writes;late.unmount();assert.equal(outstanding.options.signal.aborted,true);assert.equal(late.timers.size,0);
outstanding.respond({ok:true,report:report('ucl')});await refresh;await late.settle();assert.equal(late.writes,before,'unmounted requests cannot write state');

const mismatch=harness();mismatch.render();mismatch.calls[0].respond({ok:true,report:report('ucl',[{...group,league:'ucl'}])});await mismatch.settle();assert.match(mismatch.markup,/聯盟或範圍不符/);assert.doesNotMatch(mismatch.markup,/REAL-UI-FIXTURE/);mismatch.unmount();
const retry=harness({throwFirst:true});retry.render();await retry.settle();assert.match(retry.markup,/controlled synchronous fetch failure/);const again=retry.button('重新讀取').props.onClick();assert.equal(retry.calls.length,1,'a synchronous failed fetch must release the flight for retry');retry.calls[0].respond({ok:true,report:report()});await again;await retry.settle();retry.unmount();
console.log('PASS shipped forward-validation JSX and hooks: actual FT/HT/personnel groups, proper-score zero vs missing denominators, actual classwise audit, prospective limits, pending/excluded reasons, truncation date filters, exact scoped GET/POST, duplicate/race fencing, late league/range replies, abort/unmount and retry');
