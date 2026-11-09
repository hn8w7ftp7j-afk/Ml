import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { taipeiHistoryTime } from '../app/market-line-history/history-view.js';

// Run the shipped JSX and its handlers. Network replies are intentionally held
// so that aborted/late responses can be exercised without a browser or writes.
const source=fs.readFileSync('app/market-line-history/raw-seen-history-index-panel.js','utf8');
const replaySource=fs.readFileSync('app/market-line-history/raw-seen-replay.js','utf8');
async function compile(source,filename){return(await transform(source.replace(/^import .*?;\n/gm,'').replace(/export default function/g,'function').replace(/export function/g,'function'),{
  filename,jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}},
})).code;}
const code=await compile(source,'raw-seen-history-index-panel.jsx'),replayCode=await compile(replaySource,'raw-seen-replay.jsx');
const now=Date.parse('2026-11-08T01:00:00.000Z');
class FixtureDate extends Date {static now(){return now;}}
const flags={archiveOnly:true,currentBoardUpdated:false,historicalAvailabilityVerified:false,executable:false,coverageComplete:false,
  closingCoverage:'NOT_VERIFIED',formalEligible:false,calibrationEligible:false,identityVerified:false};
const original='2026-11-04T17:44:45.474Z',received='2026-11-04T17:44:48.123456Z',persisted='2026-11-04T17:44:48.654321Z',indexed='2026-11-08T00:10:00.111222Z';
const defaults={league:'UCL',from:'2026-11-02',through:'2026-11-08',gameKey:''};
const capture=(league='UCL',seed='a')=>({league,captureId:seed.repeat(64),captureBatchId:'b'.repeat(64),evidenceHash:'e'.repeat(64),observedAt:original});
const row=(league='UCL',seed='a')=>({...flags,league,boardDate:'2026-11-05',boardTime:'04:00',gameKey:'04:00|兵工廠|布拉格斯拉維亞',
  awayRaw:'阿仙奴',homeRaw:'布拉格斯拉維亞[主]',awayKey:'兵工廠',homeKey:'布拉格斯拉維亞',marketCount:9,periods:['FT','HT','UNKNOWN'],
  identityStatus:'ORIGINAL_BOARD_IDENTITY_ONLY',captureBatchId:'b'.repeat(64),derivedHash:'d'.repeat(64),derivationVersion:'SOCCER-RAW-CREDIT-TABLE-HISTORY-v1',
  observedAt:original,sourceReceivedAt:received,sourcePersistedAt:persisted,indexedAt:indexed,capture:capture(league,seed)});
const result=(filters=defaults,entries=[row(filters.league)])=>({ok:true,schema:'soccer-raw-history-index-v1',...flags,status:'INDEXED_HISTORY_ONLY',
  indexCoverage:'NOT_VERIFIED',filters:{...filters,gameKey:filters.gameKey||null},until:'2026-11-08T01:00:00.000Z',entries,hasMore:false,nextAfter:null});
const receipt=()=>({ok:true,schema:'soccer-raw-history-index-v1',...flags,indexedGames:16,indexedAt:indexed,
  captureBatchId:'b'.repeat(64),derivedHash:'d'.repeat(64),observedAt:original,sourcePersistedAt:persisted});
const nodes=v=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==='object'?[v,...nodes(v.props?.children)]:[];
const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):String(v??'');
const clone=v=>structuredClone(v);
function RawSeenReplay(props){return React.createElement('div',{'data-raw-replay':props.capture.captureId,'data-board-date':props.gameFilter.boardDate,'data-game-key':props.gameFilter.gameKey});}
class FixtureFormData {constructor(values){this.values=values;}get(k){return this.values[k]??null;}}
function harness({replay=false,props={}}={}){
  let i=0,dirty=false,tree,currentProps=props;const hooks=[],effects=[],calls=[];
  const scope=vm.createContext({React,taipeiHistoryTime,RawSeenReplay,AbortController,Date:FixtureDate,URLSearchParams,FormData:FixtureFormData,styles:{},
    window:{setTimeout:()=>1,clearTimeout(){}},
    useState:init=>{const n=i++;if(!(n in hooks))hooks[n]=typeof init==='function'?init():init;return[hooks[n],v=>{hooks[n]=typeof v==='function'?v(hooks[n]):v;dirty=true;}];},
    useRef:init=>{const n=i++;return hooks[n]??={current:init};},
    useEffect:(fn,deps)=>{const n=i++,old=hooks[n];if(old&&deps.every((v,j)=>Object.is(v,old.deps[j])))return;hooks[n]={deps};effects.push(()=>{old?.cleanup?.();hooks[n].cleanup=fn();});},
    fetch:(url,options)=>new Promise((resolve,reject)=>calls.push({url,options,respond:(body,status=200)=>resolve({ok:status>=200&&status<300,json:async()=>body}),reject}))});
  vm.runInContext(replay?replayCode:code,scope);
  function render(next=currentProps){currentProps=next;let turns=0;do{dirty=false;i=0;tree=replay?scope.RawSeenReplay(currentProps):scope.RawSeenHistoryIndexPanel();effects.splice(0).forEach(fn=>fn());assert.ok(turns++<20);}while(dirty);}
  async function settle(){for(let n=0;n<30;n++){await Promise.resolve();if(dirty)render();}}
  const form=(n=0)=>nodes(tree).filter(n=>n.type==='form')[n];
  return{scope,calls,render,settle,get tree(){return tree;},get markup(){return tree?renderToStaticMarkup(tree):'';},
    submit:(values=defaults,n=0)=>form(n).props.onSubmit({preventDefault(){},currentTarget:values}),
    change:(name,value)=>nodes(tree).find(n=>n.props?.name===name).props.onChange({target:{value}}),
    sourceId:value=>nodes(tree).find(n=>n.type==='input'&&n.props.maxLength===64).props.onChange({target:{value}}),
    click:label=>nodes(tree).find(n=>n.type==='button'&&text(n.props.children).includes(label)).props.onClick(),
    unmount:()=>hooks.forEach(h=>h?.cleanup?.())};
}
const h=harness();h.render();assert.equal(h.calls.length,1,'mount queries its visible recent seven board days');
const initial=new URL(h.calls[0].url,'https://fixture.invalid');
assert.equal(initial.pathname,'/api/soccer/raw-seen-history-index');assert.deepEqual(Object.fromEntries(initial.searchParams),{league:'UCL',from:'2026-11-02',through:'2026-11-08'});
assert.equal(h.calls[0].options.credentials,'same-origin');assert.equal(h.calls[0].options.cache,'no-store');assert.equal(h.calls[0].options.method,undefined);
assert.equal(h.scope.validateRawHistoryIndex(result(),defaults).entries.length,1);
for(const mutate of [
  v=>{v.ok=false;},v=>{v.schema='wrong';},v=>{v.archiveOnly=false;},v=>{v.executable=true;},v=>{v.currentBoardUpdated=true;},
  v=>{v.historicalAvailabilityVerified=true;},v=>{v.formalEligible=true;},v=>{v.calibrationEligible=true;},v=>{v.identityVerified=true;},
  v=>{v.coverageComplete=true;},v=>{v.closingCoverage='COMPLETE';},v=>{v.indexCoverage='COMPLETE';},v=>{v.status='DONE';},
  v=>{v.until='bad';},v=>{v.filters.league='EPL';},v=>{v.filters.from='2026-11-03';},v=>{v.filters.gameKey='different';},
  v=>{v.hasMore=true;},v=>{v.nextAfter='unsolicited';},v=>{v.status='NOT_INITIALIZED';},v=>{v.entries.push(clone(v.entries[0]));},
  v=>{v.entries[0].boardDate='2026-02-30';},v=>{v.entries[0].boardDate='2026-11-01';},v=>{v.entries[0].boardTime='25:00';},
  v=>{v.entries[0].gameKey='bad';},v=>{v.entries[0].awayKey=v.entries[0].homeKey;},v=>{v.entries[0].homeRaw='';},
  v=>{v.entries[0].marketCount=0;},v=>{v.entries[0].marketCount=201;},v=>{v.entries[0].periods=['CORNERS'];},
  v=>{v.entries[0].identityStatus='VERIFIED';},v=>{v.entries[0].captureBatchId='bad';},v=>{v.entries[0].derivedHash='bad';},
  v=>{v.entries[0].capture.captureId='bad';},v=>{v.entries[0].capture.evidenceHash='bad';},v=>{v.entries[0].capture.league='EPL';},
  v=>{v.entries[0].capture.captureBatchId='f'.repeat(64);},v=>{v.entries[0].capture.observedAt=indexed;},
  ...['observedAt','indexedAt','sourceReceivedAt','sourcePersistedAt'].map(k=>v=>{v.entries[0][k]='bad';}),
  ...Object.keys(flags).map(k=>v=>{v.entries[0][k]=typeof flags[k]==='boolean'?!flags[k]:'COMPLETE';}),
]){const value=result();mutate(value);assert.throws(()=>h.scope.validateRawHistoryIndex(value,defaults),/未通過核對/);}
h.calls[0].respond(result());await h.settle();
assert.match(h.markup,/已載入 1 筆來源場次紀錄/);assert.match(h.markup,/2026-11-05 04:00/);assert.match(h.markup,/阿仙奴/);
assert.match(h.markup,/9 個已辨識進球市場/);assert.match(h.markup,/無分析／投注操作/);assert.match(h.markup,/全部來源是否已索引仍未確認/);
assert.match(h.markup,/原始接收/);assert.match(h.markup,/原始存入/);assert.match(h.markup,/建立查閱索引/);
assert.ok(h.markup.includes(taipeiHistoryTime(original)));assert.ok(h.markup.includes(taipeiHistoryTime(indexed)));
const embedded=nodes(h.tree).find(n=>n.type===RawSeenReplay);assert.ok(embedded);
assert.deepEqual(JSON.parse(JSON.stringify(embedded.props.capture)),capture());
assert.deepEqual(JSON.parse(JSON.stringify(embedded.props.gameFilter)),{boardDate:'2026-11-05',gameKey:row().gameKey});
assert.ok(nodes(h.tree).filter(n=>n.type==='button').every(n=>!/下注|記錄|結算|分析/.test(text(n.props.children))),'history never offers financial/model actions');
h.click('只查這一場');await h.settle();const gameCall=h.calls[1],gameQuery=new URL(gameCall.url,'https://fixture.invalid');
assert.equal(gameQuery.searchParams.get('from'),'2026-11-05');assert.equal(gameQuery.searchParams.get('through'),'2026-11-05');assert.equal(gameQuery.searchParams.get('gameKey'),row().gameKey);
assert.doesNotMatch(h.markup,/阿仙奴/,'changing scope clears prior rows while requesting');
const gameFilters={...defaults,from:'2026-11-05',through:'2026-11-05',gameKey:row().gameKey};gameCall.respond(result(gameFilters));await h.settle();assert.match(h.markup,/阿仙奴/);
// An edit invalidates the in-flight scope even if the aborted fetch resolves.
h.submit(gameFilters);await h.settle();const stale=h.calls[2];h.change('league','EPL');await h.settle();assert.equal(stale.options.signal.aborted,true);
const epl={...gameFilters,league:'EPL'};h.submit(epl);await h.settle();const fresh=h.calls[3];fresh.respond(result(epl,[{...row('EPL','c'),awayRaw:'愛華頓'}]));await h.settle();
stale.respond(result(gameFilters));await h.settle();assert.match(h.markup,/愛華頓/);assert.doesNotMatch(h.markup,/阿仙奴/);
h.submit(epl);await h.settle();h.calls[4].respond({ok:false,error:'private-upstream-fixture-error'},503);await h.settle();
assert.match(h.markup,/暫時無法讀取/);assert.doesNotMatch(h.markup,/愛華頓|private-upstream-fixture-error/);
const uninitialized=result(epl,[]);uninitialized.status='NOT_INITIALIZED';h.submit(epl);await h.settle();h.calls[5].respond(uninitialized);await h.settle();
assert.match(h.markup,/索引尚未建立/);assert.match(h.markup,/不能當成沒有盤口/);
// The only POST accepts the identifier of evidence already held by the server.
h.sourceId('bad');await h.settle();await h.submit({},1);await h.settle();assert.equal(h.calls.length,6);assert.match(h.markup,/64 碼/);
h.sourceId('a'.repeat(64));await h.settle();const index=h.submit({},1);await h.settle();const post=h.calls[6];
assert.equal(post.url,'/api/soccer/raw-seen-history-index');assert.equal(post.options.method,'POST');assert.equal(post.options.credentials,'same-origin');assert.equal(post.options.cache,'no-store');
assert.deepEqual(JSON.parse(post.options.body),{action:'index',captureId:'a'.repeat(64)});assert.equal(post.options.headers['Content-Type'],'application/json');
post.respond({ok:false,code:'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT'},422);await index;await h.settle();
assert.match(h.markup,/格式尚未支援辨識/);assert.match(h.markup,/不能據此認定沒有盤口/);
const reindex=h.submit({},1);await h.settle();h.calls[7].respond(receipt());await h.settle();assert.equal(h.calls.length,9,'index success re-queries board days rather than publishing quotes from the POST');
h.calls[8].respond(result(epl,[]));await reindex;await h.settle();assert.match(h.markup,/已核對 16 場原盤對戰/);assert.match(h.markup,/來源時間維持原值/);
h.submit(epl);await h.settle();const pending=h.calls[9];h.unmount();assert.equal(pending.options.signal.aborted,true);pending.reject(Object.assign(Error('cancelled'),{name:'AbortError'}));await h.settle();

// Exercise the real replay selector rather than relying only on props passed to
// a stub. Whole-batch validation remains responsible for integrity; selection
// only changes what a matching indexed row renders.
const replay=harness({replay:true,props:{capture:capture()}});
const selected={boardDate:'2026-11-05',gameKey:row().gameKey},game={league:'UCL',boardDate:selected.boardDate,boardTime:'04:00',awayKey:'兵工廠',homeKey:'布拉格斯拉維亞'};
const games={games:[game,{...game,boardDate:'2026-11-04'},{...game,awayKey:'別場客隊'}]};
assert.equal(replay.scope.rawSeenSelectedGames(games,null).length,3);
assert.equal(replay.scope.rawSeenSelectedGames(games,selected).length,1);
assert.equal(replay.scope.rawSeenSelectedGames(games,selected)[0],game);
assert.throws(()=>replay.scope.rawSeenSelectedGames(games,{...selected,gameKey:'不存在'}),/未通過來源核對/);
assert.throws(()=>replay.scope.rawSeenSelectedGames({games:[game,game]},selected),/未通過來源核對/);
const quoteGame={...game,awayRaw:'阿仙奴',homeRaw:'布拉格斯拉維亞[主]',executable:false,markets:[{period:'FT',kind:'HANDICAP',unit:'GOALS',line:'1+50',lineSide:'away',awayWater:1.05,homeWater:.75,rawRows:['1+50 1.050','0.750'],source:{tableIndex:1,rowIndex:2,columnIndex:3}}]};
const rawResponse={ok:true,league:'UCL',schema:'soccer-raw-seen-history-v1',recordKind:'RAW_SEEN_REPLAY',...flags,
  integrity:{status:'VERIFIED',batchHashVerified:true},captureBatchId:'b'.repeat(64),observedAt:original,pageActivityAt:null,
  receivedAt:received,persistedAt:persisted,recoveredAt:indexed,derivationVersion:'fixture-v1',derivedHash:'d'.repeat(64),
  parts:[{captureId:'a'.repeat(64),evidenceHash:'e'.repeat(64),partIndex:0,partCount:1,receivedAt:received,persistedAt:persisted}],
  games:[quoteGame,{...quoteGame,awayKey:'另一客隊',awayRaw:'不應顯示的其他比賽'}]};
replay.render({capture:capture(),gameFilter:selected});const replayRun=replay.click('重播歷史盤口');replay.calls[0].respond(rawResponse);await replayRun;await replay.settle();
assert.equal(nodes(replay.tree).filter(n=>n.type==='article').length,1);assert.match(replay.markup,/阿仙奴/);assert.doesNotMatch(replay.markup,/不應顯示的其他比賽/);
const badOther=clone(rawResponse);badOther.games[1].markets[0].unit='CORNERS';const invalidReplay=replay.click('重播歷史盤口');replay.calls[1].respond(badOther);await invalidReplay;await replay.settle();
assert.match(replay.markup,/未通過核對/);assert.doesNotMatch(replay.markup,/阿仙奴/,'an invalid unselected game rejects the whole batch rather than bypassing source validation');replay.unmount();
const host=fs.readFileSync('app/market-line-history/page.js','utf8');assert.match(host,/<RawSeenHistoryIndexPanel\/>/);
assert.doesNotMatch(source,/dangerouslySetInnerHTML|\/api\/(?:analy|bets|soccer\/(?:analysis|reader)[?'"`])/);
assert.match(replaySource,/const checked = validateRawSeenReplay\(payload, capture\);\s*rawSeenSelectedGames\(checked, gameFilter\)/,'selected replay still validates its whole raw source batch first');
console.log('PASS shipped raw-history index UI: strict scope/clock/hash/readonly validation; recent board-date GET; original and indexing clocks; per-game source replay; source-ID-only indexing; unsupported/failed/absent indexes remain explicit; stale scope abort/fencing and no financial/model actions; Production NOT VERIFIED');
