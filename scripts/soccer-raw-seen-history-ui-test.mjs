import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { taipeiHistoryTime } from '../app/market-line-history/history-view.js';

const source=fs.readFileSync('app/market-line-history/raw-seen-replay.js','utf8');
const {code}=await transform(source.replace(/^import .*?;\n/gm,'').replace(/export default function/g,'function').replace(/export function/g,'function'),{
  filename:'raw-seen-replay.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}},
});
const at='2026-11-05T06:21:35.668Z',batch='c'.repeat(64);
const capture=(id='a',league='UCL')=>({captureId:id.repeat(64),captureBatchId:batch,observedAt:at,league});
const result=(id='a',league='UCL')=>({ok:true,league,schema:'soccer-raw-seen-history-v1',recordKind:'RAW_SEEN_REPLAY',archiveOnly:true,
  currentBoardUpdated:false,historicalAvailabilityVerified:false,executable:false,coverageComplete:false,closingCoverage:'NOT_VERIFIED',
  integrity:{status:'VERIFIED',batchHashVerified:true},captureBatchId:batch,observedAt:at,pageActivityAt:at,
  receivedAt:at,persistedAt:at,recoveredAt:'2026-11-08T01:00:00.000Z',derivationVersion:'fixture-raw-seen-v1',derivedHash:'d'.repeat(64),
  parts:[{captureId:id.repeat(64),evidenceHash:'e'.repeat(64),partIndex:0,partCount:1,receivedAt:at,persistedAt:at}],
  games:[{league,boardDate:'2026-11-05',boardTime:'04:00',awayRaw:'阿仙奴',homeRaw:'布拉格斯拉維亞[主]',awayKey:'兵工廠',homeKey:'布拉格斯拉維亞',executable:false,
    markets:[{period:'FT',kind:'HANDICAP',unit:'GOALS',line:'1+50',lineSide:'away',awayWater:1.05,homeWater:0.75,rawRows:['1+50 1.050',' 0.750'],
      source:{tableIndex:1,rowIndex:3,columnIndex:3,originalCell:['1+50','1.050','0.750']},periodEvidence:{originalPeriod:'UNKNOWN',displayPeriod:'FT',basis:'SAME_ROW_PRIMARY_AND_EXPLICIT_HT_COLUMNS'}},
    {period:'HT',kind:'TOTAL',unit:'GOALS',line:'1-50',overWater:0.91,underWater:0.95,isAlternative:true,rawRows:['大1-50 0.910','小 0.950'],source:{tableIndex:1,rowIndex:3,columnIndex:7}},
    {period:'UNKNOWN',kind:'MONEYLINE',unit:'GOALS',homeWater:2.5,drawWater:3.5,awayWater:1.5,rawRows:['主勝 2.5','和 3.5','客勝 1.5'],source:{tableIndex:1,rowIndex:3,columnIndex:2}}]}],diagnostics:{}});
const nodes=v=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==='object'?[v,...nodes(v.props?.children)]:[];
const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):String(v??'');
function harness(){
  let i=0,dirty=false,tree,props={capture:capture()};const hooks=[],effects=[],calls=[];
  const scope=vm.createContext({React,taipeiHistoryTime,AbortController,styles:{},window:{setTimeout:()=>1,clearTimeout(){}},
    useState:init=>{const n=i++;if(!(n in hooks))hooks[n]=init;return[hooks[n],v=>{hooks[n]=typeof v==='function'?v(hooks[n]):v;dirty=true;}];},
    useRef:init=>{const n=i++;return hooks[n]??={current:init};},
    useEffect:(fn,deps)=>{const n=i++,old=hooks[n];if(old&&deps.every((v,j)=>Object.is(v,old.deps[j])))return;hooks[n]={deps};effects.push(()=>{old?.cleanup?.();hooks[n].cleanup=fn();});},
    fetch:(url,options)=>new Promise((resolve,reject)=>calls.push({url,options,respond:(body,status=200)=>resolve({ok:status>=200&&status<300,json:async()=>body}),reject}))});
  vm.runInContext(code,scope);
  function render(next=props){props=next;let turns=0;do{dirty=false;i=0;tree=scope.RawSeenReplay(props);effects.splice(0).forEach(fn=>fn());assert.ok(turns++<20);}while(dirty);}
  async function settle(){for(let n=0;n<20;n++){await Promise.resolve();if(dirty)render();}}
  return{scope,calls,render,settle,get tree(){return tree;},get markup(){return tree?renderToStaticMarkup(tree):'';},
    click:()=>nodes(tree).find(n=>n.type==='button').props.onClick(),unmount:()=>hooks.forEach(h=>h?.cleanup?.())};
}
const h=harness();h.render();assert.equal(h.calls.length,0,'mount does not fetch or write');
assert.equal(h.scope.validateRawSeenReplay(result(),capture()).games.length,1);
for(const mutate of [
  r=>{r.executable=true;},r=>{r.currentBoardUpdated=true;},r=>{r.historicalAvailabilityVerified=true;},r=>{r.coverageComplete=true;},
  r=>{r.integrity.batchHashVerified=false;},r=>{r.integrity.status='EVIDENCE_UNVERIFIED';},r=>{r.closingCoverage='COMPLETE';},
  r=>{r.observedAt='2026-11-08T01:00:00.000Z';},r=>{r.captureBatchId='f'.repeat(64);},r=>{r.parts[0].captureId='f'.repeat(64);},
  r=>{r.parts[0].partCount=2;},r=>{r.parts.push({...r.parts[0]});},r=>{r.derivedHash='bad';},r=>{r.games[0].league='EPL';},
  r=>{r.games[0].executable=true;},r=>{r.games[0].boardDate='2026-02-30';},r=>{r.games[0].markets[0].unit='CORNERS';},
  r=>{r.games[0].markets[0].period='2H';},r=>{r.games[0].markets[0].awayWater=null;},r=>{r.games[0].markets[0].source.rowIndex=-1;},
  r=>{r.games[0].markets[0].periodEvidence.displayPeriod='HT';},
]){const r=result();mutate(r);assert.throws(()=>h.scope.validateRawSeenReplay(r,capture()),/未通過核對/);}
assert.equal(h.scope.rawSeenMarketText(result().games[0].markets[0]),'客讓1+50｜客 1.05／主 0.75');
assert.match(h.scope.rawSeenMarketText({...result().games[0].markets[0],lineSide:'home'}),/^主讓1\+50/);
const operation=h.click();assert.equal(h.calls[0].url,`/api/soccer/raw-seen-history?captureId=${'a'.repeat(64)}`);
assert.equal(h.calls[0].options.cache,'no-store');assert.equal(h.calls[0].options.credentials,'same-origin');assert.equal(h.calls[0].options.method,undefined);
h.calls[0].respond(result());await operation;await h.settle();
assert.match(h.markup,/這批來源辨識出 1 場進球盤/);assert.match(h.markup,/阿仙奴/);assert.match(h.markup,/1\+50/);assert.match(h.markup,/客 1\.05／主 0\.75/);
assert.match(h.markup,/歷史辨識；原文未標全場/);assert.match(h.markup,/上半場 大小/);assert.match(h.markup,/時段未確認 獨贏/);
assert.match(h.markup,/替代盤線/);assert.match(h.markup,/保存原格/);assert.match(h.markup,/辨識用文字/);
assert.match(h.markup,/來源時間保持原值/);assert.match(h.markup,/未確認當時可分析資格或尾盤完整度/);
assert.match(h.markup,/表 2／列 4／欄 4/);assert.match(h.markup,/原文雜湊/);
assert.ok(nodes(h.tree).some(n=>n.type==='a'&&n.props.href===`/api/reader/seen-captures?captureId=${'a'.repeat(64)}`));
assert.equal(nodes(h.tree).filter(n=>n.type==='button').length,1,'historical results offer no analysis, bet or settlement action');
const failure=h.click();h.calls[1].respond({ok:false,error:'private-fixture-error'},503);await failure;await h.settle();
assert.match(h.markup,/這批來源目前無法重播/);assert.doesNotMatch(h.markup,/private-fixture-error|客 1\.05/,'failure cannot retain stale successful quotes');
const empty=h.click(),none=result();none.games=[];h.calls[2].respond(none);await empty;await h.settle();assert.match(h.markup,/不能據此認定沒有開盤/);
const race=h.click();const oldSignal=h.calls[3].options.signal;
h.render({capture:capture('b','EPL')});assert.equal(oldSignal.aborted,true);assert.doesNotMatch(h.markup,/阿仙奴/);
const newer=h.click();h.calls[4].respond(result('b','EPL'));await newer;await h.settle();
h.calls[3].respond(result());await race;await h.settle();assert.match(h.markup,/保存識別 b{64}/);assert.doesNotMatch(h.markup,/保存識別 a{64}/,'late prior capture response cannot replace the new batch');
const aborted=h.click();h.unmount();assert.equal(h.calls[5].options.signal.aborted,true);h.calls[5].reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));await aborted;
const basketball=harness(),nba=result('a','NBA');nba.schema='nba-raw-seen-history-v1';nba.games[0].markets=nba.games[0].markets.filter(m=>m.kind!=='MONEYLINE').map(m=>({...m,unit:'POINTS',periodEvidence:undefined}));
basketball.render({capture:capture('a','NBA')});const nbaRun=basketball.click();assert.equal(basketball.calls[0].url,`/api/nba/raw-seen-history?captureId=${'a'.repeat(64)}`);basketball.calls[0].respond(nba);await nbaRun;await basketball.settle();assert.match(basketball.markup,/場籃球盤/);assert.match(basketball.markup,/上半場 大小/);basketball.unmount();
const baseball=harness();baseball.render({capture:capture('a','MLB')});assert.equal(baseball.tree,null);assert.equal(baseball.calls.length,0);
const host=fs.readFileSync('app/market-line-history/seen-capture-panel.js','utf8');assert.match(host,/import RawSeenReplay from '\.\/raw-seen-replay\.js'/);assert.match(host,/<SeenCaptureEvidence capture=\{row\}\/>/);assert.match(host,/\['EPL', 'UCL', 'NBA'\]\.includes\(row\.league\) && replayIds\.has\(row\.captureId\)/);
assert.doesNotMatch(source,/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]|dangerouslySetInnerHTML|\/api\/(?:analy|bets|soccer\/reader[?'"`])/);
for(const path of process.argv.slice(2)){
  const actual=JSON.parse(fs.readFileSync(path,'utf8'));
  const selected={captureId:actual.parts[0].captureId,captureBatchId:actual.captureBatchId,observedAt:actual.observedAt,league:actual.league};
  const live=harness();live.render({capture:selected});live.scope.validateRawSeenReplay(actual,selected);
  const run=live.click();live.calls[0].respond(actual);await run;await live.settle();
  assert.equal(nodes(live.tree).filter(n=>n.type==='article').length,actual.games.length);
  assert.equal(nodes(live.tree).filter(n=>n.type==='tbody').flatMap(n=>nodes(n.props.children)).filter(n=>n.type==='tr').length,actual.games.reduce((n,g)=>n+g.markets.length,0));
  for(const game of actual.games){assert.ok(live.markup.includes(game.awayRaw));assert.ok(live.markup.includes(game.homeRaw));}
  console.log(`PASS exact retained response UI: ${actual.observedAt}, ${actual.parts.length} parts, ${actual.games.length} games, ${actual.games.reduce((n,g)=>n+g.markets.length,0)} quote rows; no Production writes`);
  live.unmount();
}
console.log('PASS shipped raw-seen history UI: strict batch/seed/hash/read-only and GOALS guards, preserved original time/line/water, FT interpretation distinction, raw-part links, GET-only reads, failure clearing, abort and late-seed fencing; Production NOT VERIFIED');
