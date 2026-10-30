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
function harness({league='epl',throwFirst=false,deferUpdaters=false}={}){
 let props={league},cursor=0,dirty=false,tree,writes=0,fetchCount=0,timerId=0,now=Date.now();
 class ControlledDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const hooks=[],effects=[],calls=[],timers=new Map(),queuedUpdates=[];
 const ctx=vm.createContext({React,Date:ControlledDate,URLSearchParams,AbortController,SoccerCalibrationPanel:calibrationContext.SoccerCalibrationPanel,
  useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return[hooks[i],update=>{const apply=()=>{hooks[i]=typeof update==='function'?update(hooks[i]):update;dirty=true;writes++;};if(deferUpdaters&&typeof update==='function')queuedUpdates.push(apply);else apply();}];},
  useRef:initial=>{const i=cursor++;return hooks[i]??={current:initial};},
  useEffect:(fn,deps)=>{const i=cursor++,previous=hooks[i];if(previous&&deps.every((v,j)=>Object.is(v,previous.deps[j])))return;hooks[i]={deps};effects.push(()=>{previous?.cleanup?.();hooks[i].cleanup=fn();});},
  setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,delay,at:now+delay});return timerId;},clearTimeout:id=>timers.delete(id),
  fetch:(url,options)=>{fetchCount++;if(throwFirst&&fetchCount===1)throw Error('controlled synchronous fetch failure');return new Promise((resolve,reject)=>calls.push({url,options,reject,respond:(body,status=200,headers={})=>resolve({ok:status>=200&&status<300,status,headers:{get:name=>headers[name]??null},json:async()=>body})}));},
 });
 vm.runInContext(compiled.code,ctx);
 function render(next=props){props=next;let turns=0;do{cursor=0;dirty=false;tree=ctx.SoccerForwardValidationPanel(props);effects.splice(0).forEach(fn=>fn());assert.ok(turns++<20);}while(dirty);return tree;}
 async function settle(){for(let i=0;i<25;i++){await Promise.resolve();queuedUpdates.splice(0).forEach(apply=>apply());if(dirty)render();}}
 const button=label=>nodes(tree).find(n=>n.type==='button'&&text(n.props.children)===label);
 return{render,settle,calls,timers,button,get tree(){return tree;},get writes(){return writes;},get markup(){return renderToStaticMarkup(tree);},
  get now(){return now;},
  fireNextTimer:async()=>{const [id,timer]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0]||[];assert.ok(timer,'a scheduled timer must exist');timers.delete(id);now=timer.at;timer.fn();await settle();return timer;},
  input:(name,value)=>{const event={target:{value}};nodes(tree).find(n=>n.type==='input'&&n.props.name===name).props.onChange(event);return event;},
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

// React can defer functional state updaters until after the event's live input
// target changes. Exercise the shipped handlers with that scheduling: each ISO
// value must be captured during onChange, rather than read in the updater.
const deferred=harness({deferUpdaters:true});deferred.render();await deferred.settle();deferred.calls[0].respond({ok:true,report:report()});await deferred.settle();
const fromEvent=deferred.input('from','2026-10-19'),throughEvent=deferred.input('through','2026-10-20');
fromEvent.target.value='';throughEvent.target.value='';await deferred.settle();
assert.equal(nodes(deferred.tree).find(n=>n.type==='input'&&n.props.name==='from').props.value,'2026-10-19','the queued updater preserves the captured start date after the live target is cleared');
assert.equal(nodes(deferred.tree).find(n=>n.type==='input'&&n.props.name==='through').props.value,'2026-10-20','the queued updater preserves the captured end date after the live target is cleared');
deferred.apply();await deferred.settle();assert.equal(deferred.calls.length,2);assert.equal(deferred.calls[1].url,'/api/soccer/forward-validation?league=epl&from=2026-10-19&through=2026-10-20','submission validates and sends the preserved ISO range');
deferred.calls[1].respond({ok:true,report:report()});await deferred.settle();deferred.unmount();
// Return observations have their own denominator and never masquerade as R.
const returnsReport={...report('epl',[group]),marketReturnValidation:{version:'SOCCER-SAVED-QUOTE-RETURN-OBSERVATION-v1',
 quoteObservations:12,observedQuoteReturns:0,pendingQuoteReturns:12,conflictingQuoteReturns:0,uniqueObservedGames:0,
 pendingReasons:{SOCCER_SOURCE_CONTRACT_UNVERIFIED:12},predictionPeriodReasons:{},
 empiricalErrorMargin:null,W:null,R:null,S:null,formalEligible:false,calibrationEligible:false,promotionEligible:false,executable:false}};
const returnsUi=harness();returnsUi.render();returnsUi.calls[0].respond({ok:true,report:returnsReport});await returnsUi.settle();
assert.match(returnsUi.markup,/保存原盤 12 筆/);assert.match(returnsUi.markup,/已核對收益 0 筆/);
assert.match(returnsUi.markup,/尚未取得正式 R/);assert.match(returnsUi.markup,/系統尚未完成原盤適用派彩規則的綁定與正式登錄/);returnsUi.unmount();
const forgedReturns=harness();forgedReturns.render();forgedReturns.calls[0].respond({ok:true,report:{...returnsReport,
 marketReturnValidation:{...returnsReport.marketReturnValidation,R:.01}}});await forgedReturns.settle();
assert.match(forgedReturns.markup,/聯盟或範圍不符/);assert.doesNotMatch(forgedReturns.markup,/保存原盤 12 筆/);forgedReturns.unmount();
console.log('PASS shipped forward-validation JSX and hooks: actual FT/HT/personnel groups, proper-score zero vs missing denominators, actual classwise audit, prospective limits, pending/excluded reasons, truncation date filters, exact scoped GET/POST, duplicate/race fencing, late league/range replies, abort/unmount and retry');

const scanToken='a'.repeat(64);
const scanned=(purpose='read',complete=false,n=1)=>({...report('epl',[{...group,capturedGames:n,evaluatedGames:n}]),complete,truncated:!complete,
 scan:{version:'SOCCER-FORWARD-SCAN-v1',purpose,scope:{league:'epl',from:'2026-10-20',through:'2026-10-21'},cursor:scanToken,nextCursor:complete?null:scanToken,
 complete,processedGames:complete?2:1,totalGames:2,frozenAt:'2026-10-21T00:00:00Z'}});
const continuation=harness();continuation.render();continuation.calls[0].respond({ok:true,report:scanned()});await continuation.settle();
assert.match(continuation.markup,/已處理 1／2 場/);assert.match(continuation.markup,/尚有後續批次/);
assert.match(continuation.markup,/各批次不重複加總/);assert.match(continuation.markup,/累計數字不能當成完整驗收/);
const next=continuation.button('繼續處理下一批').props.onClick;next();next();
assert.equal(continuation.calls.length,2,'continuation deduplicates concurrent clicks');
const nextQuery=new URLSearchParams(continuation.calls[1].url.split('?')[1]);
assert.equal(nextQuery.get('cursor'),scanToken);assert.equal(nextQuery.get('from'),'2026-10-20','default scope is pinned across a date rollover');
assert.equal(nextQuery.get('through'),'2026-10-21');
continuation.calls[1].respond({ok:false,error:'controlled continuation failure'},503);await continuation.settle();
assert.match(continuation.markup,/上次成功讀取的資料/);assert.match(continuation.markup,/已處理 1／2 場/);
continuation.button('繼續處理下一批').props.onClick();continuation.calls[2].respond({ok:true,report:scanned('read',true,3)});await continuation.settle();
assert.equal(continuation.button('繼續處理下一批'),undefined);assert.match(continuation.markup,/本次範圍已掃描完成/);
assert.match(continuation.markup,/有效封存 3 筆/);assert.doesNotMatch(continuation.markup,/有效封存 4 筆/,'cumulative pages replace rather than add counts');continuation.unmount();
const evalPages=harness();evalPages.render();evalPages.calls[0].respond({ok:true,report:report()});await evalPages.settle();
evalPages.button('核對已封存賽果').props.onClick();evalPages.calls[1].respond({ok:true,report:scanned('evaluate'),summary:{checkedGameModelPeriods:1,evaluated:1,pending:0,deferred:0}});await evalPages.settle();
evalPages.button('繼續處理下一批').props.onClick();
assert.equal(evalPages.calls[2].options.method,'POST');
assert.deepEqual(JSON.parse(evalPages.calls[2].options.body),{action:'evaluate',league:'epl',from:'2026-10-20',through:'2026-10-21',cursor:scanToken,limit:25});
evalPages.calls[2].respond({ok:true,report:scanned('read',true)});await evalPages.settle();
assert.match(evalPages.markup,/接續工作已改變/,'read tokens cannot replace an evaluation continuation');evalPages.unmount();
for(const patch of [{scope:{league:'ucl',from:'2026-10-20',through:'2026-10-21'}},{nextCursor:'<invalid>'},{processedGames:3},{complete:true}]){
 const malformedScan=harness();malformedScan.render();const r=scanned();malformedScan.calls[0].respond({ok:true,report:{...r,scan:{...r.scan,...patch}}});await malformedScan.settle();
 assert.match(malformedScan.markup,/接續資料的範圍或處理狀態不符/);assert.equal(malformedScan.button('繼續處理下一批'),undefined);malformedScan.unmount();
}
assert.match(renderReport(returnsReport),/已確認的信用盤算法與 1% 實際輸贏本金退水不需重報/);
console.log('PASS actual continuation UI: scope/date rollover pinning, GET/POST purpose, cumulative replacement, retries, duplicate fencing and malformed cursor/scope rejection');

for(const patch of [{frozenAt:'2026-10-22T00:00:00Z'},{totalGames:3},{processedGames:0},{cursor:'b'.repeat(64)}]){
 const changedJob=harness();changedJob.render();changedJob.calls[0].respond({ok:true,report:scanned()});await changedJob.settle();
 changedJob.button('繼續處理下一批').props.onClick();const r=scanned();changedJob.calls[1].respond({ok:true,report:{...r,scan:{...r.scan,...patch}}});await changedJob.settle();
 assert.match(changedJob.markup,/接續工作已改變/);assert.match(changedJob.markup,/已處理 1／2 場/);changedJob.unmount();
}
const falseCompletion=renderReport({...scanned('read',true),complete:false,truncated:true});
assert.match(falseCompletion,/批次已結束，但本次資料仍不完整/);assert.doesNotMatch(falseCompletion,/本次範圍已掃描完成/);

const replacedJob=harness();replacedJob.render();replacedJob.calls[0].respond({ok:true,report:scanned()});await replacedJob.settle();
const obsoleteNext=replacedJob.button('繼續處理下一批').props.onClick;
replacedJob.button('重新讀取').props.onClick();const freshJob=scanned();freshJob.scan.cursor='b'.repeat(64);freshJob.scan.nextCursor=freshJob.scan.cursor;
replacedJob.calls[1].respond({ok:true,report:freshJob});await replacedJob.settle();
obsoleteNext();await replacedJob.settle();assert.equal(replacedJob.calls.length,2,'obsolete same-scope continuation cannot restore an older scan after refresh');
replacedJob.button('繼續處理下一批').props.onClick();assert.equal(replacedJob.calls.length,3);assert.match(replacedJob.calls[2].url,/cursor=bbbb/);replacedJob.unmount();

// Exercise the actual automatic timer callbacks, rather than only invoking the
// old manual handlers. Fake time lets the real 4/minute admission window and
// Retry-After waits run without sleeping or weakening the server policy.
const page=(purpose,processed,total=7)=>{
 const r=scanned(purpose,processed===total,processed);
 return{...r,scan:{...r.scan,processedGames:processed,totalGames:total}};
};
const automaticRead=harness();automaticRead.render();automaticRead.calls[0].respond({ok:true,report:page('read',1,3)});await automaticRead.settle();
assert.equal(automaticRead.calls.length,1,'successful partial response schedules, rather than recursively flooding, the next batch');
assert.match(automaticRead.markup,/自動接續/);assert.ok(automaticRead.button('暫停自動處理'));
await automaticRead.fireNextTimer();assert.equal(automaticRead.calls.length,2);assert.match(automaticRead.calls[1].url,/cursor=aaaa/);
automaticRead.button('暫停自動處理').props.onClick();await automaticRead.settle();assert.equal(automaticRead.calls[1].options.signal.aborted,true);assert.equal(automaticRead.timers.size,0);
automaticRead.calls[1].respond({ok:true,report:page('read',2,3)});await automaticRead.settle();
assert.match(automaticRead.markup,/已處理 1／3 場/,'a late cancelled response cannot replace the last reviewed cumulative result');
automaticRead.button('繼續處理下一批').props.onClick();assert.equal(automaticRead.calls.length,3);assert.equal(automaticRead.calls[2].url,automaticRead.calls[1].url,'resume replays the same durable cursor and scope');
automaticRead.calls[2].respond({ok:true,report:page('read',3,3)});await automaticRead.settle();assert.equal(automaticRead.timers.size,0);assert.match(automaticRead.markup,/本次範圍已掃描完成/);automaticRead.unmount();

const limited=harness();limited.render();limited.calls[0].respond({ok:true,report:report()});await limited.settle();
const postStarted=limited.now;limited.button('核對已封存賽果').props.onClick();
for(let processed=1;processed<=4;processed++){
 assert.equal(limited.calls.at(-1).options.method,'POST');limited.calls.at(-1).respond({ok:true,report:page('evaluate',processed)});await limited.settle();
 if(processed<4)await limited.fireNextTimer();
}
assert.equal(limited.calls.length,5,'four evaluate requests are admitted before the fifth is held');
const hold=[...limited.timers.values()][0];assert.ok(hold.at>=postStarted+60000,'automatic evaluate continuation cannot exceed four starts in a rolling minute');
await limited.fireNextTimer();assert.equal(limited.calls.length,6);assert.ok(limited.now-postStarted>=60000);
assert.deepEqual(JSON.parse(limited.calls[5].options.body),{action:'evaluate',league:'epl',from:'2026-10-20',through:'2026-10-21',cursor:scanToken,limit:25});
limited.calls[5].respond({ok:true,report:page('evaluate',7)});await limited.settle();assert.equal(limited.timers.size,0);limited.unmount();

for(const header of ['30','HTTP_DATE',null]){
 const throttled=harness();throttled.render();throttled.calls[0].respond({ok:true,report:report()});await throttled.settle();
 throttled.button('核對已封存賽果').props.onClick();const request=throttled.calls[1],start=throttled.now;
 const retryAfter=header==='HTTP_DATE'?new Date(start+45000).toUTCString():header;
 request.respond({ok:false,error:'請求過於頻繁'},429,retryAfter===null?{}:{'Retry-After':retryAfter});await throttled.settle();
 assert.equal(throttled.calls.length,2);assert.match(throttled.markup,/依伺服器指定時間等待/);assert.doesNotMatch(throttled.markup,/role="alert"/);
 const timer=await throttled.fireNextTimer(),expected=header==='30'?30000:header==='HTTP_DATE'?Date.parse(retryAfter)-start:60000;
 assert.ok(timer.delay>=expected,'429 preserves Retry-After seconds / HTTP date, with a conservative missing-header fallback');
 assert.equal(throttled.calls.length,3);assert.equal(throttled.calls[2].options.body,request.options.body,'a throttled first page retries its exact method and body');
 throttled.calls[2].respond({ok:true,report:report()});await throttled.settle();assert.equal(throttled.timers.size,0);throttled.unmount();
}
const pauseWait=harness();pauseWait.render();pauseWait.calls[0].respond({ok:false},429,{'Retry-After':'60'});await pauseWait.settle();
pauseWait.button('暫停自動處理').props.onClick();await pauseWait.settle();assert.equal(pauseWait.timers.size,0);assert.equal(pauseWait.button('重新讀取').props.disabled,false,'pausing a rate-limit wait releases the controls');pauseWait.unmount();

const pausedReturn=harness();pausedReturn.render();pausedReturn.calls[0].respond({ok:true,report:report()});await pausedReturn.settle();
pausedReturn.button('核對已封存賽果').props.onClick();pausedReturn.calls[1].respond({ok:true,report:page('evaluate',1)});await pausedReturn.settle();await pausedReturn.fireNextTimer();
const deniedContinuation=pausedReturn.calls[2];deniedContinuation.respond({ok:false},429,{'Retry-After':'60'});await pausedReturn.settle();
pausedReturn.button('暫停自動處理').props.onClick();await pausedReturn.settle();assert.equal(pausedReturn.timers.size,0);assert.equal(pausedReturn.button('繼續處理下一批').props.disabled,false);
pausedReturn.button('繼續處理下一批').props.onClick();await pausedReturn.settle();assert.equal(pausedReturn.calls.length,3,'resuming cannot bypass the existing Retry-After wait');await pausedReturn.fireNextTimer();
assert.equal(pausedReturn.calls[3].options.method,'POST');assert.equal(pausedReturn.calls[3].options.body,deniedContinuation.options.body,'pausing a throttled evaluation retains the exact frozen cursor and purpose');
pausedReturn.calls[3].respond({ok:true,report:page('evaluate',7)});await pausedReturn.settle();assert.equal(pausedReturn.timers.size,0);pausedReturn.unmount();

const stuck=harness();stuck.render();stuck.calls[0].respond({ok:true,report:page('read',1)});await stuck.settle();await stuck.fireNextTimer();
stuck.calls[1].respond({ok:true,report:page('read',1)});await stuck.settle();assert.equal(stuck.timers.size,0);assert.match(stuck.markup,/尚未取得新進度，已暫停/);assert.match(stuck.markup,/已處理 1／7 場/);assert.ok(stuck.button('繼續處理下一批'));stuck.unmount();

const switchAuto=harness();switchAuto.render();switchAuto.calls[0].respond({ok:true,report:page('read',1)});await switchAuto.settle();
const staleTimer=[...switchAuto.timers.values()][0];switchAuto.render({league:'ucl'});assert.equal(switchAuto.calls.length,2);
staleTimer.fn();await switchAuto.settle();assert.equal(switchAuto.calls.length,2,'an old league timer cannot start another request after a scope change');
switchAuto.calls[1].respond({ok:true,report:report('ucl')});await switchAuto.settle();switchAuto.unmount();assert.equal(switchAuto.timers.size,0);
const unmountAuto=harness();unmountAuto.render();unmountAuto.calls[0].respond({ok:true,report:page('read',1)});await unmountAuto.settle();
const unmountedTimer=[...unmountAuto.timers.values()][0];unmountAuto.unmount();assert.equal(unmountAuto.timers.size,0);unmountedTimer.fn();await unmountAuto.settle();assert.equal(unmountAuto.calls.length,1,'an unmounted pending continuation never starts a request');
console.log('PASS automatic forward scan: complete cumulative GET/POST flow, 4/minute rolling admission, Retry-After seconds/date/fallback, same-cursor retry, pause/abort/resume, no-progress stop, scope invalidation and timer cleanup');
