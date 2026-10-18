import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { readerArtifactNames } from '../lib/reader-artifact-names.js';

const manifest=JSON.parse(fs.readFileSync(new URL('../reader/manifest.json',import.meta.url),'utf8'));
const downloadHref=`/downloads/${readerArtifactNames(manifest).archiveName}`;
const escapePattern=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

const now=Date.parse('2026-10-19T00:00:00Z'),date='2026-10-19',league='EPL';
class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const source=fs.readFileSync('app/soccer/reader-panel.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export default function/g,'function').replace(/export function/g,'function');
const {code}=await transform(source,{filename:'soccer-reader-period-ui.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const plain=value=>JSON.parse(JSON.stringify(value));
const inspect=vm.createContext({React,Date:Clock});vm.runInContext(code,inspect);
const freshAt=offset=>new Date(now+offset).toISOString();
const sources=[{period:'FT',observedAt:freshAt(-180001)},{period:'HT',observedAt:freshAt(-60000)},{period:'UNKNOWN',sourceObservedAt:freshAt(-1000)}];
const original=structuredClone(sources),periods=plain(inspect.soccerReaderPeriods({sourceObservations:sources},now));
assert.deepEqual(periods.map(item=>[item.period,item.label,item.fresh]),[['FT','全場',false],['HT','上半場',true],['UNKNOWN','期間待確認',true]]);
assert.deepEqual(sources,original,'freshness presentation cannot mutate stored receipt evidence');
for(const [offset,expected]of[[-180000,true],[-180001,false],[5000,true],[5001,false],[3600000,false]])assert.equal(inspect.soccerReaderPeriods({sourceObservations:[{period:'FT',observedAt:freshAt(offset)}]},now)[0].fresh,expected);
assert.equal(inspect.soccerReaderPeriods({sourceObservations:[{period:'FT',observedAt:'unparseable'}]},now)[0].fresh,false);
assert.deepEqual(plain(inspect.soccerReaderPeriods({sourceObservations:[null,undefined,0,'bad',{period:'HT',observedAt:freshAt(-1)}]},now)).map(item=>item.period),['HT'],'malformed optional observations cannot crash the page or pose as valid receipts');
for(const value of [null,undefined,{},'bad'])assert.deepEqual(plain(inspect.soccerReaderPeriods({sourceObservations:value},now)),[]);

const market=(period,overWater)=>({period,kind:'TOTAL',unit:'GOALS',line:'3+25',overWater,underWater:.9});
const game={league,boardDate:date,boardTime:'22:00',homeRaw:'白禮頓[主]',awayRaw:'水晶宮',homeCode:'BHA',awayCode:'CRY',officialGameId:'soccer:epl:1',matchStatus:'MATCHED',prestart:true,marketStatus:'open',markets:[market('FT',.84),market('HT',.92)]};
const body={ok:true,league:'epl',date,isPeriodAggregate:true,observedAt:freshAt(-180001),sourceObservations:sources.slice(0,2),periodsCovered:['FT','HT'],games:[game],executable:false};
function harness(){
  const state=[],effects=[];let index=0,response=body;
  const ctx=vm.createContext({React,Date:Clock,URLSearchParams,AbortController,setTimeout,clearTimeout,
    useState:initial=>{const slot=index++;if(!(slot in state))state[slot]=initial;return[state[slot],value=>{state[slot]=typeof value==='function'?value(state[slot]):value;}];},
    useEffect:fn=>effects.push(fn),fetch:async()=>{if(response instanceof Error)throw response;return Response.json(response);}});
  vm.runInContext(code,ctx);
  function render(props={league,date}){index=0;effects.length=0;return ctx.SoccerReaderPanel(props);}
  return{state,render,async load(value,props={league,date}){response=value;render(props);const cleanup=effects.at(-1)();await new Promise(resolve=>setImmediate(resolve));return cleanup;}};
}
const ui=harness();
let markup=renderToStaticMarkup(ui.render());assert.match(markup,new RegExp(`等待 Reader ${escapePattern(manifest.version)}`));assert.doesNotMatch(markup,/白禮頓|0\.84/);
const cleanup=await ui.load(body);markup=renderToStaticMarkup(ui.render());cleanup();
assert.match(markup,/全場 [\d:]+（待更新）/);assert.match(markup,/上半場 [\d:]+(?:｜|<\/p>)/);assert.doesNotMatch(markup,/上半場 [\d:]+（待更新）/,'a fresh HT quote is not called stale because the FT aggregate timestamp is older');
assert.match(markup,/按期間分開保存/);assert.match(markup,/白禮頓（主）對 水晶宮（客）/);assert.match(markup,/大 0\.84/);assert.match(markup,/大 0\.92/);assert.match(markup,/官方場次已配對/);
assert.doesNotMatch(markup,/原盤已逾期，請重新同步|undefined|NaN|已通過正式驗收|可直接下注/);
assert.match(markup,new RegExp(`下載 Reader ${escapePattern(manifest.version)} 足球版`));assert.match(markup,new RegExp(`href="${escapePattern(downloadHref)}"`));
const closed={...body,games:[{...game,marketStatus:'locked',markets:[],periodStates:{FT:'locked',HT:'locked'}}]};
await ui.load(closed);markup=renderToStaticMarkup(ui.render());
assert.match(markup,/沒有開放盤口|目前無開放原盤|目前無開放盤口/,'a saved identity-backed all-locked board is distinguishable from waiting for Reader');
assert.match(markup,/白禮頓/,'all-locked evidence keeps its dated match identity');assert.doesNotMatch(markup,/等待 Reader|大 0\.84|大 0\.92/);
const empty={...body,games:[]};await ui.load(empty);markup=renderToStaticMarkup(ui.render());assert.match(markup,/沒有開放盤口|目前無開放原盤|目前無開放盤口/);assert.doesNotMatch(markup,/等待 Reader/);
const waiting={ok:true,league:'epl',date,status:'WAITING_READER',games:[],executable:false};await ui.load(waiting);markup=renderToStaticMarkup(ui.render());assert.match(markup,/等待 Reader/);assert.doesNotMatch(markup,/沒有開放盤口/,'missing Reader evidence must not become a no-market claim');
const legacy={...body,isPeriodAggregate:false,sourceObservations:[],observedAt:freshAt(3600000),games:[game]};await ui.load(legacy);markup=renderToStaticMarkup(ui.render());assert.match(markup,/原盤已逾期|待更新/,'a far-future legacy timestamp cannot be called fresh');
await ui.load({...body,sourceObservations:[null,...sources]});assert.doesNotThrow(()=>renderToStaticMarkup(ui.render()));
await ui.load({...body,league:'ucl'});markup=renderToStaticMarkup(ui.render());assert.match(markup,/原盤更新失敗.*身分核對未通過/,'wrong-league API results cannot silently replace the current board');
const otherDate={league,date:'2026-10-20'};markup=renderToStaticMarkup(ui.render(otherDate));assert.doesNotMatch(markup,/白禮頓|大 0\.84/,'changing date cannot display the previous date as its current board');
await ui.load({...body,date:'2026-10-19'},otherDate);markup=renderToStaticMarkup(ui.render(otherDate));assert.match(markup,/原盤更新失敗/);assert.doesNotMatch(markup,/白禮頓|大 0\.84/);
console.log('PASS shipped soccer Reader UI: independent FT/HT freshness, clock bounds, safe optional receipts, identity-backed locked boards vs missing capture, raw prices, actual download link and league/date isolation');
