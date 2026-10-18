import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { buildSoccerRanking,SOCCER_RANK_MARKETS,soccerMarketName } from '../lib/soccer/ranking.js';
import { soccerRecordKey,soccerRecordStats } from '../lib/soccer/manual-record.js';
import { soccerTeamLabel } from '../lib/soccer/team-labels.js';
import { soccerValidationArtifacts } from '../lib/soccer/validation-frozen.js';
const source=fs.readFileSync('app/soccer/workspace.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export default function|export function/g,'function');
const compiled=await transform(source,{filename:'workspace.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
let states=[],si=0;
const ctx=vm.createContext({React,Date,buildSoccerRanking,SOCCER_RANK_MARKETS,soccerTeamLabel,soccerValidationArtifacts,
  SoccerRecordProvider:({children})=>children,SoccerRecordButton:()=>null,SoccerBetRecords:()=>React.createElement('p',null,'實際下注帳本'),
  useEffect:()=>{},useState:initial=>[states[si++]??(typeof initial==='function'?initial():initial),()=>{}]});
vm.runInContext(compiled.code,ctx);
const render=(view,league='epl')=>{states=[view];si=0;return renderToStaticMarkup(ctx.SoccerWorkspace({league,date:'2026-10-20',games:[],states:{},run:()=>{},children:[]}));};
for(const view of ['board','results','ranking','records','data','validation']){
  const markup=render(view);for(const name of ['今日盤口','分析結果','排名','下注紀錄','賽程與球員','模型驗證'])assert.ok(markup.includes(name));
  assert.doesNotMatch(markup,/undefined|NaN/);
}
assert.match(render('ranking'),/全部排名/);assert.match(render('ranking'),/時間順序排名/);
states=['order','all'];si=0;assert.match(renderToStaticMarkup(ctx.SoccerRanking({games:[],states:{},run:()=>{},now:Date.now()})),/目前沒有通過 S／W／R/);
const epl=render('validation'),ucl=render('validation','ucl');assert.match(epl,/393／412/);assert.match(ucl,/143／185/);assert.doesNotMatch(ucl,/393／412/);
console.log('PASS shipped workspace JSX: six NBA-style tabs, two ranking views, honest empty candidates and separate EPL/UCL validation metrics');

const recordSource=fs.readFileSync('app/soccer/bet-records.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const recordCode=await transform(recordSource,{filename:'records.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
let ledger;
const recordCtx=vm.createContext({React,Date,createContext:()=>({}),useContext:()=>ledger,soccerRecordKey,soccerRecordStats,soccerMarketName});
vm.runInContext(recordCode.code,recordCtx);
const game={id:'soccer:epl:123',league:'epl',date:'2026-10-20'},quote={period:'FT',kind:'TOTAL',side:'over',line:'3+50',lineSide:null,water:.95,key:'q1',unit:'GOALS'},result={persisted:true,revision:'a'.repeat(64)};
const record={...quote,gameId:game.id,league:'epl',date:game.date,id:'id',status:'OPEN',stake:10000,recordedAt:'2026-10-19T00:00:00Z'};
ledger={records:[record],status:'ready',date:game.date,pending:new Set()};
assert.match(renderToStaticMarkup(recordCtx.SoccerRecordButton({game,result,quote})),/已下注 ✓/);
ledger.records=[{...record,status:'CANCELLED'}];assert.match(renderToStaticMarkup(recordCtx.SoccerRecordButton({game,result,quote})),/重新紀錄下注/);
ledger={...ledger,league:'epl',load:()=>{},mutate:()=>{}};assert.match(renderToStaticMarkup(recordCtx.SoccerBetRecords()),/足球退水 0.01/);
ledger.records=[];assert.match(renderToStaticMarkup(recordCtx.SoccerRecordButton({game,result,quote})),/紀錄實際下注/);
assert.equal(recordCtx.SoccerRecordButton({game,result,quote:{...quote,period:null}}),null);
console.log('PASS shipped record JSX: original prices, recorded/cancelled/restore states, 1% football policy and unknown-period exclusion');
