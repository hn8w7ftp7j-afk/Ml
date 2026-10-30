import assert from 'node:assert/strict';
import { candidateFixture } from './helpers/soccer-candidate-fixture.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { buildSoccerRanking,SOCCER_RANK_MARKETS,soccerMarketName } from '../lib/soccer/ranking.js';
import { soccerRecordKey,soccerRecordStats } from '../lib/soccer/manual-record.js';
import { soccerTeamLabel } from '../lib/soccer/team-labels.js';
import { soccerValidationArtifacts } from '../lib/soccer/validation-frozen.js';
import { soccerHalfTimeArtifacts } from '../lib/soccer/half-time-frozen.js';
import { soccerCreditRuleConfirmation } from '../lib/soccer/credit-rule-confirmation.js';
const source=fs.readFileSync('app/soccer/workspace.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export default function|export function/g,'function');
const compiled=await transform(source,{filename:'workspace.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const calibrationSource=fs.readFileSync('app/soccer/calibration-panel.js','utf8').replace(/export function/g,'function');
const calibrationCompiled=await transform(calibrationSource,{filename:'calibration-panel.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
let states=[],si=0;
const ctx=vm.createContext({React,Date,buildSoccerRanking,SOCCER_RANK_MARKETS,soccerTeamLabel,soccerValidationArtifacts,soccerHalfTimeArtifacts,
  SoccerRecordProvider:({children})=>children,SoccerRecordButton:()=>null,SoccerBetRecords:()=>React.createElement('p',null,'實際下注帳本'),
  SoccerForwardValidationPanel:({league})=>React.createElement('p',null,`${league} 前瞻封存與賽果核對`),
  useEffect:()=>{},useState:initial=>[states[si++]??(typeof initial==='function'?initial():initial),()=>{}]});
vm.runInContext(`Object.assign(globalThis,(()=>{${calibrationCompiled.code};return {SoccerCalibrationPanel};})());`,ctx);
vm.runInContext(compiled.code,ctx);
const render=(view,league='epl')=>{states=[view];si=0;return renderToStaticMarkup(ctx.SoccerWorkspace({league,date:'2026-10-20',games:[],states:{},run:()=>{},children:[]}));};
for(const view of ['board','results','ranking','records','data','validation']){
  const markup=render(view);for(const name of ['今日盤口','分析結果','排名','下注紀錄','賽程與球員','模型驗證'])assert.ok(markup.includes(name));
  assert.doesNotMatch(markup,/undefined|NaN/);
}
assert.match(render('ranking'),/全部排名/);assert.match(render('ranking'),/時間順序排名/);
assert.match(render('validation','epl'),/epl 前瞻封存與賽果核對/);
assert.match(render('validation','ucl'),/ucl 前瞻封存與賽果核對/);
const rankingNow=Date.parse('2026-10-20T00:00:00Z');
for(const league of ['epl','ucl']){
  const fixtures=[
    {name:'合格高分',score:9,minutes:120},
    {name:'合格早場',score:7.2,minutes:60,period:'HT',direction:'HANDICAP_HOME',kind:'HANDICAP'},
    {name:'研究方向',formalScoringEnabled:false},
    {name:'低於門檻',score:7.1},
    {name:'W零值',W:0},{name:'W負值',W:-1},{name:'R零值',R:0},{name:'R負值',R:-1},
    {name:'分數缺失',score:null},{name:'正式資格未通過',qualified:false},{name:'方向未通過',eligible:false},{name:'QA阻擋',qaFlag:'BLOCKED'},
  ].map((spec,index)=>{
    const game={id:`soccer:${league}:${index+1}`,sourceId:String(index+1),league,date:'2026-10-20',status:'scheduled',startTime:new Date(rankingNow+(spec.minutes??180)*60000).toISOString(),home:{name:spec.name,sourceId:'359'},away:{name:'對手',sourceId:'364'}};
    const quote={key:`quote-${index}`,period:spec.period??'FT',kind:spec.kind??'TOTAL',unit:'GOALS',line:'2-50',label:'原盤',water:.95,fresh:true,prestart:true,provenance:{gameId:game.id,observedAt:new Date(rankingNow).toISOString()}};
    const data={gameId:game.id,league,date:game.date,observedAt:new Date(rankingNow).toISOString(),persisted:true,publishedCurrent:true,analysisStatus:'COMPLETED',formalScoringEnabled:spec.formalScoringEnabled??true,qualification:{eligible:spec.qualified??true},directions:[{period:quote.period,direction:spec.direction??'TOTAL_OVER',score:spec.score===undefined?8:spec.score,W:spec.W??2,R:spec.R??1,eligible:spec.eligible??true,qaFlag:spec.qaFlag??'PASS',quotes:[quote]}]};
    return{game,data:candidateFixture({...data,evidence:{game}},rankingNow)};
  });
  const games=fixtures.map(f=>f.game),analysisStates=Object.fromEntries(fixtures.map(f=>[f.game.id,{status:'done',data:f.data}]));
  const original=JSON.stringify(analysisStates);
  const rankMarkup=(view,market='all',rows=games)=>{states=[view,market];si=0;return renderToStaticMarkup(ctx.SoccerRanking({games:rows,states:analysisStates,run:()=>{},now:rankingNow}));};
  for(const view of ['ranking','order']){
    const markup=rankMarkup(view);
    assert.equal((markup.match(/class="soccerRankRow"/g)||[]).length,2,`${league} ${view} includes only eligible candidate rows`);
    assert.match(markup,/合格高分/);assert.match(markup,/合格早場/);assert.match(markup,/2 個候選方向/);
    assert.match(markup,/W 200(?:\.0+)?%/);assert.match(markup,/R 100(?:\.0+)?%/);
    for(const fixture of fixtures.slice(2))assert.ok(!markup.includes(fixture.game.home.name),`${league} ${view} excludes ${fixture.game.home.name}`);
    assert.doesNotMatch(markup,/尚無評分者列後方|研究中・正式評分待驗證/);
    const first=view==='ranking'?'合格高分':'合格早場',second=view==='ranking'?'合格早場':'合格高分';
    assert.ok(markup.indexOf(first)<markup.indexOf(second),'ranking and kickoff views retain their independent ordering');
    const halfTime=rankMarkup(view,'HT:HANDICAP');assert.match(halfTime,/合格早場/);assert.doesNotMatch(halfTime,/合格高分/);
    const empty=rankMarkup(view,'all',games.slice(2));assert.match(empty,/目前沒有通過 S／W／R/);assert.match(empty,/研究原盤仍可在「分析結果」查閱/);assert.doesNotMatch(empty,/class="soccerRankRow"/);
  }
  assert.equal(JSON.stringify(analysisStates),original,'rendering either ranking cannot mutate research snapshots or quotes');
}
console.log('PASS shipped ranking JSX: EPL/UCL score and time views exclude research, low scores, missing scores, nonpositive W/R and failed formal QA; valid candidates, original quotes, ordering, filters and honest empty states remain');
const epl=render('validation'),ucl=render('validation','ucl');assert.match(epl,/393／412/);assert.match(ucl,/143／185/);assert.doesNotMatch(ucl,/393／412/);
for(const markup of [epl,ucl]){assert.match(markup,/全場｜逐年分事件校準/);assert.match(markup,/上半場｜分事件校準/);assert.match(markup,/全場勝平負校準核對/);assert.match(markup,/上半場勝平負校準核對/);assert.match(markup,/全場分事件校準指標/);assert.match(markup,/上半場分事件校準指標/);for(const name of ['主勝','和局','客勝'])assert.ok(markup.includes(`${name}｜分箱預估與實際比例`));assert.match(markup,/事後回補的研究診斷/);}
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
ledger={...ledger,league:'epl',load:()=>{},mutate:()=>{}};assert.match(renderToStaticMarkup(recordCtx.SoccerBetRecords()),/實際輸贏本金的 1%/);
ledger.settlementPolicy={creditRuleConfirmation:soccerCreditRuleConfirmation('2026-10-30T15:01:39Z'),
  missingTerms:[{code:'REGISTRATION',label:'原盤規則登錄仍待完成'}]};
const confirmedMarkup=renderToStaticMarkup(recordCtx.SoccerBetRecords());
for(const value of ['已確認的信用盤派彩例子','1+20','1-20','1平','淨損益 182 元','淨損益 -198 元','淨損益 0 元','走盤不退','系統證據與登錄待完成'])assert.ok(confirmedMarkup.includes(value),value);
assert.match(confirmedMarkup,/正式 S 評分的模型校準與誤差驗證仍由系統完成/);
assert.doesNotMatch(confirmedMarkup,/按投注金額計算|尚待核對的派彩條款|正式評分已啟用/);
ledger.settlementPolicy.creditRuleConfirmation=soccerCreditRuleConfirmation('2026-10-30T15:01:38Z');
assert.doesNotMatch(renderToStaticMarkup(recordCtx.SoccerBetRecords()),/已確認的信用盤派彩例子|淨損益 182 元/,'earlier receipt does not display later confirmed examples');
ledger.records=[];assert.match(renderToStaticMarkup(recordCtx.SoccerRecordButton({game,result,quote})),/紀錄實際下注/);
assert.equal(recordCtx.SoccerRecordButton({game,result,quote:{...quote,period:null}}),null);
console.log('PASS shipped record JSX: original prices, recorded/cancelled/restore states, 1% football policy and unknown-period exclusion');

// Execute the shipped provider hooks. Only React scheduling and HTTP are fixtures.
let cursor=0,hooks=[],effects=[],dirty=false,tree,props={league:'epl',date:game.date,children:[]};
const requests=[];
const hookCtx=vm.createContext({React,Date,URLSearchParams,AbortSignal,soccerRecordKey,soccerRecordStats,soccerMarketName,
  createContext:()=>({Provider:'provider'}),
  useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return[hooks[i],v=>{hooks[i]=typeof v==='function'?v(hooks[i]):v;dirty=true;}];},
  useRef:initial=>{const i=cursor++;return hooks[i]??={current:initial};},
  useEffect:(fn,deps)=>{const i=cursor++,old=hooks[i];if(old?.deps&&deps.every((d,j)=>Object.is(d,old.deps[j])))return;hooks[i]={deps};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});},
  fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})),
});
vm.runInContext(recordCode.code,hookCtx);
const rerender=()=>{cursor=0;dirty=false;tree=hookCtx.SoccerRecordProvider(props);const queued=effects;effects=[];queued.forEach(f=>f());};
const flush=async()=>{for(let i=0;i<20;i++){await Promise.resolve();if(dirty)rerender();}assert.equal(dirty,false);};
const ledgerNow=()=>tree.props.value;
const respond=async(req,value)=>{req.resolve({ok:true,json:async()=>value});await flush();};
rerender();await flush();await respond(requests.shift(),{ok:true,league:'epl',date:game.date,through:game.date,records:[]});
assert.equal(ledgerNow().status,'ready');
const saving=ledgerNow().mutate({action:'record',gameId:game.id,alreadyPlaced:true},'position');await flush();
await ledgerNow().load();await flush();assert.equal(requests.length,1,'manual refresh cannot supersede an in-flight durable write');
await respond(requests.shift(),{ok:true,record,persistence:'durable_database'});await saving;await flush();
assert.equal(ledgerNow().records.length,1);
const cancelling=ledgerNow().mutate({action:'cancel',id:record.id},'position');await flush();const late=requests.shift();
props={...props,league:'ucl'};rerender();await flush();
assert.equal(requests.length,1,'switching scope must still load its ledger while an old-scope write is pending');
await respond(requests.shift(),{ok:true,league:'ucl',date:game.date,through:game.date,records:[]});
await respond(late,{ok:true,record:{...record,status:'CANCELLED'},persistence:'durable_database'});await cancelling;await flush();
assert.equal(ledgerNow().league,'ucl');assert.equal(ledgerNow().records.length,0,'late EPL write cannot populate UCL records');
const checking=ledgerNow().checkSettlement();await flush();
assert.equal(requests.length,1);
assert.deepEqual(JSON.parse(requests[0].options.body),{action:'check-settlement',league:'ucl',date:game.date});
await ledgerNow().checkSettlement();await ledgerNow().mutate({action:'record',gameId:game.id,alreadyPlaced:true},'position');await flush();
assert.equal(requests.length,1,'duplicate checks and record writes cannot race a result check');
await respond(requests.shift(),{ok:true,league:'ucl',date:game.date,summary:{checked:1,resultVerified:1,settled:0,pending:1,deferred:0}});
assert.equal(requests.length,1,'result checks reload durable records instead of inventing settled records');
await respond(requests.shift(),{ok:true,league:'ucl',date:game.date,through:game.date,records:[],settlementPolicy:{status:'SOURCE_TERMS_UNVERIFIED',missingTerms:[{code:'REBATE',label:'走盤退水適用條款'}]}});
await checking;await flush();
assert.equal(ledgerNow().settlementSummary.settled,0);assert.equal(ledgerNow().settlementSummary.resultVerified,1);
assert.equal(ledgerNow().settlementPolicy.missingTerms[0].code,'REBATE');assert.equal(ledgerNow().records.length,0);
const oldScopeCheck=ledgerNow().checkSettlement();await flush();const oldScopeRequest=requests.shift();
props={...props,league:'epl'};rerender();await flush();
await respond(requests.shift(),{ok:true,league:'epl',date:game.date,through:game.date,records:[]});
await respond(oldScopeRequest,{ok:true,league:'ucl',date:game.date,summary:{checked:1,resultVerified:1,settled:1,pending:0,deferred:0}});
await oldScopeCheck;await flush();
assert.equal(ledgerNow().league,'epl');assert.equal(ledgerNow().settlementSummary,null,'late checks cannot show another league settlement counts');
assert.equal(requests.length,0,'late checks cannot reload the old league');
hooks.forEach(h=>h?.cleanup?.());
console.log('PASS actual record hooks: durable-write vs refresh fencing, scope switch during a write, late response isolation and stable effects');
console.log('PASS settlement hooks: duplicate/write fencing, result vs payout separation, durable readback, missing policy and late cross-league responses');
