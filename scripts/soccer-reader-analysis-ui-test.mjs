import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';

const source=fs.readFileSync('app/soccer/reader-panel.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export default function/g,'function').replace(/export function/g,'function');
const {code}=await transform(source,{filename:'soccer-reader-analysis-ui.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const initial={league:'EPL',date:'2026-11-05'};
const body=(props=initial)=>({ok:true,league:props.league.toLowerCase(),date:props.date,observedAt:'2026-10-30T00:00:00Z',
  contentHash:'a'.repeat(64),sourceObservations:[{period:'FT',observedAt:'2026-10-30T00:00:00Z'}],games:[{
    league:props.league,boardDate:props.date,boardTime:'22:00',homeRaw:'主隊',awayRaw:'客隊',markets:[{
      period:'FT',kind:'TOTAL',unit:'GOALS',line:'2.5',overWater:.9,underWater:.95}]}],executable:false});
const started=(props=initial,status='STARTED')=>({ok:true,league:props.league.toLowerCase(),date:props.date,
  continuation:{status,durable:status==='STARTED',executable:false,...(status==='STARTED'?{runId:'wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV'}:{})},executable:false});
const text=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(text).join(''):typeof node==='object'?text(node.props?.children):String(node);
function harness(){
  const slots=[],effects=[],calls=[],timers=new Map();let at=0,props=initial,tree,dirty=false,timerId=0,mounted=true,lateUpdates=0;
  const pending=[];
  const context=vm.createContext({React,URLSearchParams,AbortController,Date,
    window:{dispatchEvent:()=>{}},CustomEvent:class{},document:{visibilityState:'visible'},
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
    setInterval:()=>++timerId,clearInterval:()=>{},
    useState:initial=>{const index=at++;if(!(index in slots))slots[index]=initial;return[slots[index],value=>{
      if(!mounted){lateUpdates++;return;}slots[index]=typeof value==='function'?value(slots[index]):value;dirty=true;}];},
    useRef:value=>{const index=at++;return slots[index]||(slots[index]={current:value});},
    useEffect:(fn,deps)=>{const index=at++,old=effects[index];if(!old||!deps||deps.some((value,i)=>value!==old.deps?.[i])){
      pending.push(()=>{old?.cleanup?.();effects[index]={deps,cleanup:fn()};});}},
    fetch:(url,options={})=>new Promise((resolve,reject)=>calls.push({url,options,
      respond:(value,status=200)=>resolve(Response.json(value,{status})),reject})),
  });
  vm.runInContext(code,context);
  function render(next=props){props=next;do{dirty=false;at=0;tree=context.SoccerReaderPanel(props);while(pending.length)pending.shift()();}while(dirty);return tree;}
  function find(label,node=tree){if(!node||typeof node!=='object')return null;const nodes=Array.isArray(node)?node:[node];for(const item of nodes){
    if(!item||typeof item!=='object')continue;if(item.type==='button'&&text(item)===label)return item;
    const nested=find(label,item.props?.children);if(nested)return nested;}return null;}
  return{calls,timers,render,get markup(){return renderToStaticMarkup(tree);},get lateUpdates(){return lateUpdates;},
    click(label){const button=find(label);assert.ok(button,`button ${label} exists`);assert.ok(!button.props.disabled,`button ${label} enabled`);return button.props.onClick();},
    button:find,async settle(){await new Promise(resolve=>setImmediate(resolve));if(mounted)render();},
    unmount(){for(const effect of effects)effect?.cleanup?.();mounted=false;},
  };
}
async function loaded(props=initial){const h=harness();h.render(props);assert.doesNotMatch(h.markup,/補存盤口預測/);
  h.calls[0].respond(body(props));await h.settle();return h;}
const h=await loaded();
assert.match(h.markup,/全場 .*待更新/);assert.ok(!h.button('補存盤口預測').props.disabled,'stale original board may request server inspection without refreshing its timestamps');
const click=h.click('補存盤口預測');
// Invoke the same stale render handler again: the ref must fence before React paints disabled.
h.click('補存盤口預測');assert.equal(h.calls.length,2,'a same-scope double click starts only one HTTP request');
h.render();assert.match(h.markup,/正在啟動補存/);assert.equal(h.button('正在啟動補存…').props.disabled,true);
const request=h.calls[1];assert.equal(request.url,'/api/soccer/reader-analysis');assert.equal(request.options.method,'POST');
assert.deepEqual(JSON.parse(request.options.body),{action:'resume',league:'epl',date:initial.date});
assert.equal(request.options.headers['Content-Type'],'application/json');assert.equal(request.options.signal.aborted,false);
request.respond(started());await click;await h.settle();
assert.match(h.markup,/已啟動背景補存，是否完成仍須核對封存結果/);assert.match(h.markup,/逾期盤口不會補造預測/);
assert.doesNotMatch(h.markup,/已補存完成|已保存 0|已封存 0|正式評分已完成/);assert.equal(h.timers.size,0);
const fallback=await loaded();const fp=fallback.click('補存盤口預測');fallback.calls[1].respond(started(initial,'FALLBACK_ONLY'));await fp;await fallback.settle();
assert.match(fallback.markup,/已安排備援處理/);assert.match(fallback.markup,/不代表預測已補存完成/);
for(const [response,status,expected]of [[started(initial,'UNAVAILABLE'),200,/補存未確認.*暫時無法啟動/],
  [{ok:false,error:'伺服器忙碌'},503,/補存未確認.*伺服器忙碌/],
  [{ok:false},401,/補存未確認.*登入已過期/],
  [started({league:'UCL',date:initial.date}),200,/補存未確認.*聯盟、日期或工作狀態/],
  [{...started(),date:'2026-11-06'},200,/補存未確認.*聯盟、日期或工作狀態/],
  [{...started(),executable:true},200,/補存未確認.*聯盟、日期或工作狀態/],
  [{...started(),continuation:{...started().continuation,runId:'wfr_01ARZ3NDEKTSV4RRFFQ69G5FAV'}},200,/補存未確認.*聯盟、日期或工作狀態/],
  [{...started(),continuation:{...started().continuation,runId:'wrun_synthetic_test'}},200,/補存未確認.*聯盟、日期或工作狀態/],
  [{...started(),continuation:{...started().continuation,durable:false}},200,/補存未確認.*聯盟、日期或工作狀態/],
  [{...started(),continuation:{...started().continuation,executable:undefined}},200,/補存未確認.*聯盟、日期或工作狀態/],
  [{...started(),continuation:{...started().continuation,executable:true}},200,/補存未確認.*聯盟、日期或工作狀態/],
  [{...started(initial,'FALLBACK_ONLY'),continuation:{...started(initial,'FALLBACK_ONLY').continuation,durable:true}},200,/補存未確認.*聯盟、日期或工作狀態/],
  [{...started(initial,'UNAVAILABLE'),continuation:{...started(initial,'UNAVAILABLE').continuation,durable:true}},200,/補存未確認.*聯盟、日期或工作狀態/],
  [{...started(initial,'FALLBACK_ONLY'),continuation:{...started(initial,'FALLBACK_ONLY').continuation,executable:undefined}},200,/補存未確認.*聯盟、日期或工作狀態/],
  [{...started(initial,'UNAVAILABLE'),continuation:{...started(initial,'UNAVAILABLE').continuation,executable:undefined}},200,/補存未確認.*聯盟、日期或工作狀態/],
  [started(initial,'COMPLETED'),200,/補存未確認.*聯盟、日期或工作狀態/]]){
  const test=await loaded(),promise=test.click('補存盤口預測');test.calls[1].respond(response,status);await promise;await test.settle();
  assert.match(test.markup,expected);assert.ok(!test.button('補存盤口預測').props.disabled);test.unmount();
}
const timed=await loaded();const tp=timed.click('補存盤口預測');for(const fn of [...timed.timers.values()])fn();
assert.equal(timed.calls[1].options.signal.aborted,true);const abort=Error('aborted');abort.name='AbortError';timed.calls[1].reject(abort);await tp;await timed.settle();
assert.match(timed.markup,/回應逾時，是否已啟動仍待核對/);assert.doesNotMatch(timed.markup,/補存已取消|已補存完成/);

for(const lateError of [false,true]){
  const race=await loaded(),old=race.click('補存盤口預測'),other={league:'UCL',date:'2026-11-06'};
  race.render(other);assert.equal(race.calls[1].options.signal.aborted,true);assert.doesNotMatch(race.markup,/已啟動背景補存|正在啟動補存/);
  race.calls[2].respond(body(other));await race.settle();
  const current=race.click('補存盤口預測');assert.equal(race.calls.length,4);
  if(lateError)race.calls[1].reject(Error('old EPL failure'));else race.calls[1].respond(started());
  await old;await race.settle();assert.match(race.markup,/正在啟動補存/);assert.doesNotMatch(race.markup,/old EPL failure|已啟動背景補存/);
  race.calls[3].respond(started(other));await current;await race.settle();assert.match(race.markup,/已啟動背景補存/);
  assert.deepEqual(JSON.parse(race.calls[3].options.body),{action:'resume',league:'ucl',date:other.date});race.unmount();
}
const back=await loaded(),prior=back.click('補存盤口預測');
back.render({league:'EPL',date:'2026-11-06'});back.render(initial);
back.calls[3].respond(body());await back.settle();
assert.ok(!back.button('補存盤口預測').props.disabled,'returning to an aborted scope clears its obsolete busy state');
const resumed=back.click('補存盤口預測');back.calls[1].respond(started());await prior;await back.settle();
assert.match(back.markup,/正在啟動補存/,'old response for the same returned key cannot replace the newer request');
back.calls[4].respond(started());await resumed;await back.settle();back.unmount();
for(const lateError of [false,true]){
  const unmounted=await loaded(),promise=unmounted.click('補存盤口預測');unmounted.unmount();
  assert.equal(unmounted.calls[1].options.signal.aborted,true);
  if(lateError)unmounted.calls[1].reject(Error('late failure'));else unmounted.calls[1].respond(started());
  await promise;await unmounted.settle();assert.equal(unmounted.lateUpdates,0,'unmounted request completion does not set state');
}
h.unmount();fallback.unmount();timed.unmount();
console.log('PASS Reader resume UI: scope-only request, double-click fence, start-not-completion, honest fallback/timeout, invalid scope/result rejection, league/date and unmount request isolation');
