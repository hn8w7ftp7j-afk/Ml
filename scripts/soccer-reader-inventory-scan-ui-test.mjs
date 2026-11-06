import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
const source=fs.readFileSync('app/soccer/reader-inventory-scan-panel.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const {code}=await transform(source,{filename:'panel.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const nodes=v=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==='object'?[v,...nodes(v.props?.children)]:[];
const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):String(v??'');
function harness(storage=new Map()){
 let i=0,dirty=false,tree,props={league:'ucl',date:'2026-10-21'},random=0;
 const hooks=[],effects=[],calls=[];
 const context=vm.createContext({React,Date,AbortController,Uint8Array,crypto:{getRandomValues:a=>{a.fill(++random);return a;}},
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
  useState:init=>{const n=i++;if(!(n in hooks))hooks[n]=init;return[hooks[n],v=>{hooks[n]=typeof v==='function'?v(hooks[n]):v;dirty=true;}];},
  useRef:init=>{const n=i++;return hooks[n]??={current:init};},
  useEffect:(fn,deps)=>{const n=i++,old=hooks[n];if(old&&deps.every((v,j)=>Object.is(v,old.deps[j])))return;hooks[n]={deps};effects.push(()=>{old?.cleanup?.();hooks[n].cleanup=fn();});},
  fetch:(url,options)=>new Promise(resolve=>calls.push({url,options,respond:(data,status=200)=>resolve({ok:status>=200&&status<300,status,json:async()=>data})}))});
 vm.runInContext(code,context);
 function render(next=props){props=next;let turns=0;do{dirty=false;i=0;tree=context.SoccerReaderInventoryScanPanel(props);effects.splice(0).forEach(fn=>fn());assert.ok(turns++<20);}while(dirty);}
 async function settle(){for(let n=0;n<25;n++){await Promise.resolve();if(dirty)render();}}
 return {render,settle,calls,storage,get tree(){return tree;},get markup(){return renderToStaticMarkup(tree);},button(label){const b=nodes(tree).find(x=>x.type==='button'&&text(x.props.children)===label);assert.ok(b,`missing ${label}`);return b;},unmount(){hooks.forEach(h=>h?.cleanup?.());}};
}
function report(call,{status='RUNNING',totalCount=2,verifiedCount=0,reasons=[]}={}){const req=JSON.parse(call.options.body);return {ok:true,report:{version:'SOCCER-READER-INVENTORY-SCAN-v1',cursor:req.cursor,league:req.league,date:req.date,status,totalCount,verifiedCount,observedCount:totalCount,reasonCodes:reasons,formalEligible:false,identityVerified:false,selectedPairCount:null}};}
const h=harness();h.render();assert.equal(h.calls.length,0,'mount never triggers scan');
const pending=h.button('開始清點').props.onClick();assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/soccer/reader-inventory-scan');
const request=JSON.parse(h.calls[0].options.body);assert.equal(request.action,'start');assert.match(request.cursor,/^[a-f0-9]{48}$/);assert.equal(h.calls[0].options.method,'POST');
assert.doesNotMatch(h.markup,new RegExp(request.cursor));h.calls[0].respond(report(h.calls[0]));await h.settle();assert.equal(h.calls.length,2);assert.equal(JSON.parse(h.calls[1].options.body).action,'continue');
h.calls[1].respond(report(h.calls[1],{status:'COMPLETE',verifiedCount:2}));await pending;await h.settle();assert.match(h.markup,/清點完成/);assert.match(h.markup,/不是賽事配對、收益驗證或正式評分/);assert.doesNotMatch(h.markup,new RegExp(request.cursor));
h.unmount();const reload=harness(h.storage);reload.render();assert.equal(reload.calls.length,0);const resumed=reload.button('恢復清點').props.onClick();assert.equal(JSON.parse(reload.calls[0].options.body).cursor,request.cursor);reload.calls[0].respond(report(reload.calls[0],{status:'COMPLETE',verifiedCount:2}));await resumed;await reload.settle();
reload.render({league:'epl',date:'2026-10-21'});assert.ok(reload.button('開始清點'));assert.equal(reload.calls.length,1,'other league does not auto-request');
const empty=harness();empty.render();const e=empty.button('開始清點').props.onClick();empty.calls[0].respond(report(empty.calls[0],{status:'COMPLETE',totalCount:0,verifiedCount:0}));await e;await empty.settle();assert.match(empty.markup,/沒有可見的已提交收據/);
const partial=harness();partial.render();const p=partial.button('開始清點').props.onClick();partial.calls[0].respond(report(partial.calls[0],{status:'PARTIAL',totalCount:null,reasons:['READER_MANIFEST_ROW_BUDGET']}));await p;await partial.settle();assert.match(partial.markup,/超過單次清點上限/);assert.match(partial.markup,/總數 未知/);
const error=harness();error.render();const q=error.button('開始清點').props.onClick();error.calls[0].respond({error:'private-fixture-device'},503);await q;await error.settle();assert.match(error.markup,/清點暫時無法完成/);assert.doesNotMatch(error.markup,/private-fixture-device/);assert.ok(error.button('恢復清點'));
const outage=harness();outage.render();const outageRun=outage.button('開始清點').props.onClick();
const outageCursor=JSON.parse(outage.calls[0].options.body).cursor;
outage.calls[0].respond(report(outage.calls[0],{verifiedCount:1}));await outage.settle();
assert.equal(outage.calls.length,2);outage.calls[1].respond({ok:false,error:'sensitive-source-outage'},503);
await outageRun;await outage.settle();assert.match(outage.markup,/已核對 1 筆/);
assert.doesNotMatch(outage.markup,/清點完成|sensitive-source-outage/);
const outageRetry=outage.button('繼續清點').props.onClick();
assert.deepEqual(JSON.parse(outage.calls[2].options.body),{action:'continue',league:'ucl',date:'2026-10-21',cursor:outageCursor});
outage.calls[2].respond(report(outage.calls[2],{status:'COMPLETE',verifiedCount:2}));await outageRetry;await outage.settle();
assert.match(outage.markup,/清點完成/);assert.equal(JSON.parse([...outage.storage.values()][0]).items.length,1,
  'recovering a partially verified manifest must not create another cutoff');
const race=harness();race.render();const r=race.button('開始清點').props.onClick();race.render({league:'ucl',date:'2026-10-22'});race.calls[0].respond(report(race.calls[0],{status:'COMPLETE',verifiedCount:2}));await r;await race.settle();assert.doesNotMatch(race.markup,/清點完成/);assert.ok(race.button('開始清點'));
const history=harness();history.render();let firstHistory=history.button('開始清點').props.onClick();history.calls[0].respond(report(history.calls[0],{status:'COMPLETE',verifiedCount:2}));await firstHistory;await history.settle();
const firstToken=JSON.parse(history.calls[0].options.body).cursor;
const secondHistory=history.button('建立新時點').props.onClick();const secondToken=JSON.parse(history.calls[1].options.body).cursor;assert.notEqual(firstToken,secondToken);
history.calls[1].respond(report(history.calls[1],{status:'COMPLETE',totalCount:3,verifiedCount:3}));await secondHistory;await history.settle();
const record=JSON.parse([...history.storage.values()][0]);assert.equal(record.items.length,2);assert.equal(record.items[0].cursor,firstToken);
assert.doesNotMatch(history.markup,new RegExp(firstToken));assert.doesNotMatch(history.markup,new RegExp(secondToken));
history.unmount();const revisit=harness(history.storage);revisit.render();assert.match(revisit.markup,/已保存的清點時點/);
// The first option is selected using an index, never exposing its cursor as a DOM value.
const select=nodes(revisit.tree).find(x=>x.type==='select');select.props.onChange({target:{value:'0'}});revisit.render();
const oldReplay=revisit.button('恢復清點').props.onClick();assert.equal(JSON.parse(revisit.calls[0].options.body).cursor,firstToken);revisit.calls[0].respond(report(revisit.calls[0],{status:'COMPLETE',verifiedCount:2}));await oldReplay;await revisit.settle();
const bounded=harness();bounded.render();const operation=bounded.button('開始清點').props.onClick();
for(let i=0;i<12;i++){assert.equal(bounded.calls.length,i+1);bounded.calls[i].respond(report(bounded.calls[i],{status:'RUNNING',totalCount:50,verifiedCount:i}));await bounded.settle();}
await operation;await bounded.settle();assert.equal(bounded.calls.length,12,'automatic batches must be bounded');assert.ok(bounded.button('繼續清點'));
const publicId='d'.repeat(64);
const publicReport=(scope={league:'ucl',date:'2026-10-21'},changes={})=>({version:'SOCCER-READER-INVENTORY-SCAN-v1',scanId:publicId,startedAt:'2026-10-21T12:00:00.123456Z',...scope,status:'RUNNING',totalCount:3,verifiedCount:1,observedCount:3,reasonCodes:[],formalEligible:false,identityVerified:false,selectedPairCount:null,...changes});
const remote=harness();remote.render();assert.equal(remote.calls.length,0,'lookup is not automatic');
const lookup=remote.button('查詢已保存清單').props.onClick();assert.deepEqual(JSON.parse(remote.calls[0].options.body),{action:'list',league:'ucl',date:'2026-10-21'});
remote.calls[0].respond({ok:true,reports:[publicReport()],complete:true,reasonCodes:[]});await lookup;await remote.settle();
assert.match(remote.markup,/進行中/);assert.match(remote.markup,/已核對 1 筆/);assert.doesNotMatch(remote.markup,new RegExp(publicId));
const old=remote.button('繼續這份清單').props.onClick();assert.deepEqual(JSON.parse(remote.calls[1].options.body),{action:'resume',league:'ucl',date:'2026-10-21',scanId:publicId});
remote.calls[1].respond({ok:true,report:publicReport(undefined, {status:'COMPLETE',verifiedCount:3})});await old;await remote.settle();assert.match(remote.markup,/已完成/);assert.match(remote.markup,/已核對 3 筆/);assert.equal(remote.storage.size,0,'cross-device resume does not require or create local cursor');assert.doesNotMatch(remote.markup,new RegExp(publicId));
const noRemote=harness();noRemote.render();const noLookup=noRemote.button('查詢已保存清單').props.onClick();noRemote.calls[0].respond({ok:true,reports:[],complete:true,reasonCodes:[]});await noLookup;await noRemote.settle();assert.match(noRemote.markup,/目前沒有可查詢的清單/);
const badRemote=harness();badRemote.render();const badLookup=badRemote.button('查詢已保存清單').props.onClick();badRemote.calls[0].respond({ok:true,reports:[publicReport({league:'epl',date:'2026-10-21'})],complete:true,reasonCodes:[]});await badLookup;await badRemote.settle();assert.match(badRemote.markup,/數量未知/);assert.doesNotMatch(badRemote.markup,/已核對 1 筆/);
const truncated=harness();truncated.render();const truncLookup=truncated.button('查詢已保存清單').props.onClick();truncated.calls[0].respond({ok:true,reports:[publicReport()],complete:false,reasonCodes:['READER_MANIFEST_LIST_TRUNCATED']});await truncLookup;await truncated.settle();assert.match(truncated.markup,/較早清單未列出/);
const raceList=harness();raceList.render();const listFlight=raceList.button('查詢已保存清單').props.onClick();raceList.render({league:'epl',date:'2026-10-21'});raceList.calls[0].respond({ok:true,reports:[publicReport()],complete:true,reasonCodes:[]});await listFlight;await raceList.settle();assert.doesNotMatch(raceList.markup,/已核對 1 筆/);
const unavailable=harness();unavailable.render();const unavailableCall=unavailable.button('查詢已保存清單').props.onClick();unavailable.calls[0].respond({error:'sensitive source information'},503);await unavailableCall;await unavailable.settle();assert.match(unavailable.markup,/數量未知/);assert.doesNotMatch(unavailable.markup,/sensitive source information|目前沒有可查詢/);
const publicEmpty=harness();publicEmpty.render();const publicList=publicEmpty.button('查詢已保存清單').props.onClick();const zeroReport=publicReport(undefined,{status:'COMPLETE',totalCount:0,observedCount:0,verifiedCount:0});publicEmpty.calls[0].respond({ok:true,reports:[zeroReport],complete:true,reasonCodes:[]});await publicList;await publicEmpty.settle();const publicView=publicEmpty.button('查看這份清單').props.onClick();publicEmpty.calls[1].respond({ok:true,report:zeroReport});await publicView;await publicEmpty.settle();assert.match(publicEmpty.markup,/此時點沒有可見的已提交收據/);
const deniedResume=harness();deniedResume.render();const deniedList=deniedResume.button('查詢已保存清單').props.onClick();deniedResume.calls[0].respond({ok:true,reports:[publicReport()],complete:true,reasonCodes:[]});await deniedList;await deniedResume.settle();const deniedCall=deniedResume.button('繼續這份清單').props.onClick();deniedResume.calls[1].respond({ok:false,error:'sensitive-id'},404);await deniedCall;await deniedResume.settle();assert.match(deniedResume.markup,/清單暫時無法恢復/);assert.doesNotMatch(deniedResume.markup,/sensitive-id/);
const remoteRetry=deniedResume.button('繼續這份清單').props.onClick();
assert.deepEqual(JSON.parse(deniedResume.calls[2].options.body),{action:'resume',league:'ucl',date:'2026-10-21',scanId:publicId});
deniedResume.calls[2].respond({ok:true,report:publicReport(undefined,{status:'COMPLETE',verifiedCount:3})});
await remoteRetry;await deniedResume.settle();assert.match(deniedResume.markup,/已核對 3 筆/);

console.log('PASS Reader inventory scan UI: explicit start, bounded continuation, persistence, scope isolation, zero, partial and errors');
