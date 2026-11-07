import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {transform} from 'next/dist/build/swc/index.js';

// Run the shipped component and hooks. Only React scheduling and HTTP are
// fixtures; no real settlement, bet record or production write is performed.
const source=fs.readFileSync('app/soccer/bet-records.js','utf8')
  .replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const compiled=await transform(source,{filename:'soccer-records-feedback.jsx',
  jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
let cursor=0,hooks=[],effects=[],dirty=false,tree;
let props={league:'epl',date:'2026-11-07',children:[]};
const requests=[];
const ctx=vm.createContext({React,Date,URLSearchParams,AbortSignal,
  soccerRecordKey:r=>r.id||r.gameId,
  soccerRecordStats:()=>({active:0,cancelled:0,stake:0,settled:0,selfReportedSettled:0,pending:0,winRate:null,profit:0,roi:null}),
  soccerMarketName:()=>'',soccerReaderIdentityVerified:()=>false,
  createContext:()=>({Provider:({children})=>React.createElement(React.Fragment,null,children)}),
  useContext:()=>tree.props.value,
  useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;
    return[hooks[i],value=>{hooks[i]=typeof value==='function'?value(hooks[i]):value;dirty=true;}];},
  useRef:initial=>{const i=cursor++;return hooks[i]??={current:initial};},
  useEffect:(fn,deps)=>{const i=cursor++,old=hooks[i];
    if(old?.deps&&deps.every((value,index)=>Object.is(value,old.deps[index])))return;
    hooks[i]={deps};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});},
  fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),
});
vm.runInContext(compiled.code,ctx);
props.children=React.createElement(ctx.SoccerBetRecords);
const render=()=>{cursor=0;dirty=false;tree=ctx.SoccerRecordProvider(props);
  const queued=effects;effects=[];queued.forEach(effect=>effect());};
const flush=async()=>{for(let i=0;i<30;i++){await Promise.resolve();if(dirty)render();}assert.equal(dirty,false);};
const ledger=()=>tree.props.value;
const markup=()=>renderToStaticMarkup(tree);
const respond=async(request,body,status=200)=>{assert.ok(request,'expected an HTTP request');
  request.resolve({ok:status>=200&&status<300,status,json:async()=>body});await flush();};
const reject=async(request,error)=>{assert.ok(request);request.reject(error);await flush();};
const readBody=()=>({ok:true,league:props.league,date:props.date,through:props.through||props.date,records:[]});
const takeRead=()=>{const request=requests.shift();assert.ok(request);assert.equal(request.options.method,undefined);
  assert.match(request.url,/^\/api\/soccer\/bet-records\?/);return request;};
const successfulSummary={checked:9,resultVerified:9,settled:9,pending:0,deferred:0};
const zeroSummary={checked:0,resultVerified:0,settled:0,pending:0,deferred:0};
async function startCheck(){
  const task=ledger().checkSettlement();await flush();const post=requests.shift();
  assert.ok(post);assert.equal(post.options.method,'POST');
  assert.equal(JSON.parse(post.options.body).action,'check-settlement');
  assert.equal(ledger().settlementSummary,null,'a new check must not display an older success summary');
  return{task,post};
}
async function finishSuccessfulCheck(summary){
  const{task,post}=await startCheck();
  await respond(post,{ok:true,league:props.league,date:props.date,summary});
  await respond(takeRead(),readBody());await task;await flush();
}

render();await flush();await respond(takeRead(),readBody());
assert.equal(ledger().status,'ready');
await finishSuccessfulCheck(successfulSummary);
assert.equal(ledger().settlementSummary.settled,9);assert.match(markup(),/本次檢查 9 筆/);

// Reproduce the original failure: an operation fails, then an independent GET
// succeeds. Its success must not erase the settlement failure or resurrect 9/9.
const timedOut=await startCheck();
assert.doesNotMatch(markup(),/本次檢查 9 筆/);
await ledger().checkSettlement();await ledger().load();await flush();
assert.equal(requests.length,0,'duplicate check/refresh cannot race an in-flight settlement');
await reject(timedOut.post,Object.assign(new Error('fixture timeout'),{name:'TimeoutError'}));
assert.match(ledger().error,/結算核對逾時/);assert.equal(ledger().status,'loading');
await respond(takeRead(),readBody());await timedOut.task;await flush();
assert.equal(ledger().status,'ready');assert.match(ledger().error,/結算核對逾時/);
assert.equal(ledger().settlementSummary,null);assert.doesNotMatch(markup(),/本次檢查 9 筆/);
assert.match(markup(),/結果尚未確認/);assert.match(markup(),/重新核對結算/);
assert.doesNotMatch(markup(),/disabled=""[^>]*>重新核對結算/,'retry is enabled after durable readback');

// A manual ledger refresh is not a new settlement check and cannot clear the
// operation error. An explicit retry clears it and can truthfully report zero.
const refresh=ledger().load();await flush();await respond(takeRead(),readBody());await refresh;await flush();
assert.match(ledger().error,/結算核對逾時/);assert.equal(ledger().settlementSummary,null);
const retry=await startCheck();assert.equal(ledger().error,'');
await respond(retry.post,{ok:true,league:props.league,date:props.date,summary:zeroSummary});
await respond(takeRead(),readBody());await retry.task;await flush();
assert.equal(ledger().error,'');assert.equal(ledger().settlementSummary.checked,0);
assert.match(markup(),/本次檢查 0 筆/);assert.doesNotMatch(markup(),/結算核對逾時/);

// Operation and readback failures are independent. Preserve both causes; when
// readback later recovers only its own error disappears.
const failed=await startCheck();await respond(failed.post,{ok:false,error:'賽果來源暫時失效'},503);
await respond(takeRead(),{ok:false,error:'帳本讀回暫時失效'},503);await failed.task;await flush();
assert.equal(ledger().status,'failed');assert.match(ledger().error,/賽果來源暫時失效/);
assert.match(ledger().error,/帳本讀回暫時失效/);assert.equal(ledger().settlementSummary,null);
assert.match(markup(),/disabled=""[^>]*>重新核對結算/,'retry waits until the ledger can be read');
const recoveredRead=ledger().load();await flush();await respond(takeRead(),readBody());await recoveredRead;await flush();
assert.equal(ledger().status,'ready');assert.match(ledger().error,/賽果來源暫時失效/);
assert.doesNotMatch(ledger().error,/帳本讀回暫時失效/);assert.equal(ledger().settlementSummary,null);

const malformed=await startCheck();
await respond(malformed.post,{ok:true,league:props.league,date:props.date,summary:{checked:1,settled:1}});
await respond(takeRead(),readBody());await malformed.task;await flush();
assert.match(ledger().error,/賽果核對回應不完整/);assert.equal(ledger().settlementSummary,null);

// A valid POST result remains a result even if its independent ledger GET
// fails, but that read failure remains visible and all mutations stay fenced.
const readFailed=await startCheck();
await respond(readFailed.post,{ok:true,league:props.league,date:props.date,summary:successfulSummary});
await respond(takeRead(),{ok:false,error:'已核對，帳本讀回失敗'},503);await readFailed.task;await flush();
assert.equal(ledger().status,'failed');assert.equal(ledger().settlementSummary.settled,9);
assert.match(ledger().error,/帳本讀回失敗/);
const sync=ledger().load();await flush();await respond(takeRead(),readBody());await sync;await flush();
assert.equal(ledger().error,'');assert.equal(ledger().settlementSummary.settled,9);

// Old operation responses cannot show errors/counts or reload a different
// league/date after navigation. Before effects run, the scope projection is
// already empty so no old success summary flashes in the new ledger.
for(const nextScope of [{league:'ucl'},{date:'2026-11-08'}]){
  const old=await startCheck(),oldLeague=props.league,oldDate=props.date;
  props={...props,...nextScope};render();
  assert.equal(ledger().settlementSummary,null);assert.equal(ledger().error,'');
  await flush();await respond(takeRead(),readBody());
  if(nextScope.league)await reject(old.post,new Error('late old-league failure'));
  else await respond(old.post,{ok:true,league:oldLeague,date:oldDate,summary:successfulSummary});
  await old.task;await flush();
  assert.equal(ledger().league,props.league);assert.equal(ledger().date,props.date);
  assert.equal(ledger().settlementSummary,null);assert.equal(ledger().error,'');
  assert.equal(requests.length,0,'old checks never trigger an old-scope readback after navigation');
}
const unmounted=await startCheck();hooks.forEach(hook=>hook?.cleanup?.());
await reject(unmounted.post,new Error('late after unmount'));await unmounted.task;await flush();
assert.equal(requests.length,0);assert.equal(ledger().error,'');

console.log('PASS shipped soccer settlement feedback: old success cleared immediately, timeout/POST errors survive successful GET, separate readback failure/recovery, explicit retry and genuine zero summary, duplicate/write fencing, malformed responses, scope navigation and late/unmounted response isolation; no real writes.');
