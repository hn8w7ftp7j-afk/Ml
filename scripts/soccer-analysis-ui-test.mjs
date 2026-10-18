import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { transform } from 'next/dist/build/swc/index.js';

const raw=fs.readFileSync('app/soccer/analysis-panel.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export default function/g,'function').replace(/export function/g,'function');
const {code}=await transform(raw,{filename:'soccer-analysis.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const nodes=v=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==='object'?[v,...nodes(v.props?.children)]:[];
const label=v=>Array.isArray(v)?v.map(label).join(''):v&&typeof v==='object'?label(v.props?.children):v==null||typeof v==='boolean'?'':String(v);
const game=i=>({id:`soccer:epl:${i}`,sourceId:String(i),league:'epl',date:'2026-10-20',startTime:'2099-10-20T13:00:00Z',status:'scheduled',home:{name:'Home'},away:{name:'Away'}}),games=[game(1),game(2),game(3)];
function harness(fetch){
 const state=[],refs=[],effects=[];let si=0,ri=0,tree;
 const ctx=vm.createContext({React,Date,URLSearchParams,AbortController,AbortSignal,setTimeout,clearTimeout,fetch,
  createContext:()=>({Provider:'provider'}),useContext:()=>({states:state[0],run:ctx.provider().props.value.run}),
  useState:initial=>{const i=si++;if(!(i in state))state[i]=initial;return[state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];},
  useRef:initial=>refs[ri++]|| (refs[ri-1]={current:initial}),useEffect:fn=>effects.push(fn)});
 vm.runInContext(code,ctx);
 ctx.provider=()=>{si=0;ri=0;tree=ctx.SoccerAnalysisProvider({games,children:[]});return tree;};
 const provider=()=>ctx.provider();const renderPanel=g=>{si=2;return ctx.SoccerAnalysisPanel({game:g});};
 return{ctx,state,provider,renderPanel,cleanup:()=>effects[0]?.()};
}
const pending=[];let requests=0,active=0,maxActive=0;
const h=harness(async(_url,options)=>{requests++;active++;maxActive=Math.max(maxActive,active);const input=JSON.parse(options.body);return await new Promise(resolve=>pending.push(()=>{active--;resolve(Response.json({ok:true,gameId:`soccer:epl:${input.eventId}`,league:'epl',date:input.date,formalScoringEnabled:false,executable:false,directions:Array.from({length:8},()=>({executable:false,eligible:false})),persisted:true,evidence:{teams:{}},status:'RESEARCH_ONLY'}));}));});
let tree=h.provider();assert.equal(requests,0,'Opening a board cannot automatically run analysis');
const value=tree.props.value,a=value.run(games[0]),b=value.run(games[1]),c=value.run(games[2]);
assert.equal(value.run(games[0]),a,'Repeated clicks cannot duplicate a queued/inflight request');assert.equal(requests,2);assert.equal(h.state[0][games[2].id].status,'queued');
pending.shift()();await a;await new Promise(r=>setImmediate(r));assert.equal(requests,3);pending.shift()();pending.shift()();await Promise.all([b,c]);assert.equal(maxActive,2);assert.equal(Object.values(h.state[0]).filter(s=>s.status==='done').length,3);
const bad=harness(async()=>Response.json({ok:true,gameId:'soccer:ucl:1',league:'ucl',date:games[0].date,executable:false,formalScoringEnabled:false,directions:Array.from({length:8},()=>({executable:false,eligible:false}))}));
await bad.provider().props.value.run(games[0]);assert.equal(bad.state[0][games[0].id].status,'error');assert.match(bad.state[0][games[0].id].error,/身分/);
const failed=harness(async()=>Response.json({ok:false,error:'temporary source error'},{status:503}));await failed.provider().props.value.run(games[0]);assert.equal(failed.state[0][games[0].id].status,'error');assert.equal(nodes(failed.renderPanel(games[0])).find(x=>x.type==='button').props.disabled,false,'failure releases the retry button');
console.log('PASS shipped soccer JSX: manual-only entry, bounded two-request queue, duplicate-click suppression, independent game receipts, wrong-league rejection and retry unlock');

// Render the shipped result JSX with real provider evidence and both legacy/new snapshots.
const {normalizeSoccerPrematch}=await import('../lib/soccer/prematch.js'),{normalizeSoccerSchedule}=await import('../lib/soccer/data.js'),{buildSoccerAnalysis}=await import('../lib/soccer/analysis.js');
const payload=JSON.parse(fs.readFileSync('scripts/fixtures/soccer/minutes-past.json')),comp=payload.header.competitions[0],at='2026-10-18T14:50:00Z',source={provider:'ESPN',fetchedAt:at,url:'https://fixture.invalid',contentHash:'fixture'};
const realGame=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:comp.date,status:comp.status}]},'epl',source).games[0],evidence=normalizeSoccerPrematch(payload,realGame,source,Date.parse(at)),result=buildSoccerAnalysis({evidence,now:Date.parse(at)});
h.state[0][realGame.id]={status:'done',data:{...result,persisted:true}};const rendered=h.renderPanel(realGame),text=label(rendered);
assert.match(text,/正規時鐘上場分鐘/);assert.match(text,/補時登場/);assert.match(text,/逐年滾動研究檢查/);assert.match(text,/原盤結算核對表/);assert.match(text,/尚無已配對原盤/);assert.doesNotMatch(text,/undefined|NaN/);
console.log('PASS actual result JSX: postgame normalized minutes, stoppage-only player, rolling evidence, missing quotes and legacy optional fields render without invented values');
