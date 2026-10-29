import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerReaderHash } from '../lib/soccer/reader.js';
import { canonicalSoccerPayload } from '../reader/soccer-parser.js';

const now=Date.parse('2026-10-29T00:00:00Z');
class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const source=fs.readFileSync('app/soccer/reader-inventory-panel.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const {code}=await transform(source,{filename:'soccer-reader-inventory.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const at='2026-10-28T10:00:00Z';
const scope={from:'2026-09-29',through:'2026-11-12',readAt:new Date(now).toISOString(),dateLimit:31};
const shift=(value,n)=>new Date(Date.parse(value)+n*86400000).toISOString().slice(0,10);
function day(date='2026-10-31',observationCount=2,distinctBoardGameKeys=3){return{date,observationCount,distinctBoardGameKeys,gameKeysComplete:true,lastObservedAt:at,lastReceivedAt:at,lastPersistedAt:at,
 current:{status:'AVAILABLE',gameCount:3,marketCount:4,periods:['FT','HT'],periodCounts:['FT','HT'].map(period=>({period,gameCount:3,marketCount:2,observedAt:at,receivedAt:at,persistedAt:at}))}};}
function body({league='epl',days=[day(),day('2026-10-25',4,5)],window=scope}={}){
 const ordered=structuredClone(days).sort((a,b)=>b.date.localeCompare(a.date)),complete=ordered.every(row=>row.gameKeysComplete);
 return{ok:true,version:'SOCCER-READER-INVENTORY-v1',league,scope:{...window},summary:{observationCount:ordered.reduce((n,row)=>n+row.observationCount,0),boardDateCount:ordered.length,
  distinctBoardGameKeys:complete?ordered.reduce((n,row)=>n+row.distinctBoardGameKeys,0):null,gameKeysComplete:complete,
  firstBoardDate:ordered.at(-1)?.date??null,lastBoardDate:ordered[0]?.date??null,lastObservedAt:ordered.length?at:null,lastReceivedAt:ordered.length?at:null,lastPersistedAt:ordered.length?at:null},
  gameKeyDefinition:'BOARD_DATE_TIME_AWAY_HOME_SOURCE_KEYS_NOT_OFFICIAL_GAME_IDENTITIES',observationDefinition:'IMMUTABLE_V2_READER_RECEIPTS_HEARTBEATS_INCLUDED',truncated:false,days:ordered,
  legacy:{status:'ABSENT',snapshotCount:0,boardDateCount:0,lastObservedAt:null,days:[],truncated:false,readAt:null,historicalAvailabilityVerified:false,formalEligible:false,executable:false},formalEligible:false,executable:false};
}
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const text=value=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):String(value??'');
function harness({initial={},throwFirst=false}={}){
 let index=0,dirty=false,tree,fetches=0,writes=0,timerId=0;
 const selected=[],hooks=[],effects=[],calls=[],timers=new Map();let props={league:'EPL',date:'2026-10-29',throughDate:'2026-11-12',onSelectDate:value=>selected.push(value),...initial};
 const context=vm.createContext({React,Date:Clock,URLSearchParams,AbortController,
  useState:initial=>{const i=index++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return[hooks[i],update=>{hooks[i]=typeof update==='function'?update(hooks[i]):update;dirty=true;writes++;}];},
  useRef:initial=>{const i=index++;return hooks[i]??={current:initial};},
  useEffect:(fn,deps)=>{const i=index++,previous=hooks[i];if(previous&&deps.every((value,j)=>Object.is(value,previous.deps[j])))return;hooks[i]={deps};effects.push(()=>{previous?.cleanup?.();hooks[i].cleanup=fn();});},
  setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId;},clearTimeout:id=>timers.delete(id),
  fetch:(url,options)=>{fetches++;if(throwFirst&&fetches===1)throw Error('controlled fetch failure');return new Promise((resolve,reject)=>calls.push({url,options,reject,respond:(value,status=200)=>resolve({ok:status>=200&&status<300,status,json:async()=>value})}));},
 });vm.runInContext(code,context);
 function render(next=props){props=next;let turns=0;do{dirty=false;index=0;tree=context.SoccerReaderInventoryPanel(props);effects.splice(0).forEach(fn=>fn());assert.ok(turns++<20);}while(dirty);return tree;}
 async function settle(){for(let i=0;i<20;i++){await Promise.resolve();if(dirty)render();}}
 const button=label=>nodes(tree).find(node=>node.type==='button'&&text(node.props.children)===label);
 return{render,settle,calls,timers,selected,button,get tree(){return tree;},get markup(){return renderToStaticMarkup(tree);},get writes(){return writes;},get props(){return props;},unmount:()=>hooks.forEach(h=>h?.cleanup?.())};
}

const h=harness();h.render();assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/soccer/reader-inventory?league=epl&from=2026-09-29&through=2026-11-12');
assert.equal(h.calls[0].options.cache,'no-store');assert.equal(h.calls[0].options.credentials,'same-origin');assert.match(h.markup,/已保存原盤｜讀取中/);assert.doesNotMatch(h.markup,/0 盤日/);
const fixture=body(),original=structuredClone(fixture);h.calls[0].respond(fixture);await h.settle();
assert.match(h.markup,/已保存原盤｜收據 2 盤日｜最近 2026-10-31/);assert.match(h.markup,/已保存 6 筆來源收據｜保存場次 8 筆/);
assert.match(h.markup,/目前保存版本：保存場次 3 筆、4 個原盤/);assert.match(h.markup,/全場 2 個原盤｜上半場 2 個原盤/);assert.match(h.markup,/最後接收：2026\/10\/28/);
assert.match(h.markup,/依原始日期、時間及隊名去重，尚未全數核對官方賽程/);assert.match(h.markup,/不代表尾盤完整/);assert.match(h.markup,/不代表仍有效或已有 S 評分/);assert.doesNotMatch(h.markup,/新鮮|fresh|可直接下注|已通過正式驗收/);
assert.equal(nodes(h.tree).find(node=>node.type==='details').props.open,undefined,'the saved inventory stays a collapsed details panel by default');
h.button('查看 2026-10-25 當日賽程').props.onClick();assert.deepEqual(h.selected,['2026-10-25']);assert.deepEqual(fixture,original,'display and navigation never mutate the immutable inventory response');
const fetchCount=h.calls.length;h.render();assert.equal(h.calls.length,fetchCount,'ordinary renders do not refetch inventory');
const refresh=h.button('重新核對清單').props.onClick;const first=refresh(),second=refresh();assert.equal(h.calls.length,2,'duplicate refresh handlers synchronously deduplicate');
h.button('查看 2026-10-25 當日賽程')?.props.onClick();assert.deepEqual(h.selected,['2026-10-25'],'a refresh cannot select stale rows while metadata is unknown');
h.calls[1].respond({ok:false,error:'untrusted source detail'},503);await Promise.all([first,second]);await h.settle();assert.match(h.markup,/盤日數量待核對/);assert.match(h.markup,/盤日與筆數仍待核對/);assert.doesNotMatch(h.markup,/0 盤日|查看 2026|untrusted source detail/);
h.button('重新核對清單').props.onClick();h.calls[2].respond(body({days:[]}));await h.settle();assert.match(h.markup,/已保存原盤｜收據 0 盤日/);assert.match(h.markup,/此查詢範圍尚未找到/);assert.match(h.markup,/其他日期是否有保存仍需另查/);assert.equal(h.timers.size,0);h.unmount();

const unreadable=day();unreadable.gameKeysComplete=false;unreadable.distinctBoardGameKeys=null;unreadable.current={status:'UNAVAILABLE',reason:'HEAD_INSPECTION_BUDGET',gameCount:null,marketCount:null,periods:['FT','HT'],periodCounts:[]};
const unknown=harness();unknown.render();unknown.calls[0].respond(body({days:[unreadable]}));await unknown.settle();assert.match(unknown.markup,/保存場次 未知 筆/);assert.match(unknown.markup,/保存場次尚未完整核對/);assert.match(unknown.markup,/尚未完成核對，盤數未知/);assert.doesNotMatch(unknown.markup,/0 個原盤|保存場次 0 筆/);unknown.unmount();
const noHead=day();noHead.current={status:'NO_ACTIVE_HEAD',gameCount:0,marketCount:0,periods:[],periodCounts:[]};
const archived=harness();archived.render();archived.calls[0].respond(body({days:[noHead]}));await archived.settle();assert.match(archived.markup,/已確認沒有目前期間版本（0 個原盤）；歷史收據仍保存/);assert.match(archived.markup,/來源收據 2 筆/);archived.unmount();
const emptyHead=day();emptyHead.current={status:'AVAILABLE',gameCount:0,marketCount:0,periods:['FT'],periodCounts:[{period:'FT',gameCount:0,marketCount:0,observedAt:at,receivedAt:at,persistedAt:at}]};
const zero=harness();zero.render();zero.calls[0].respond(body({days:[emptyHead]}));await zero.settle();assert.match(zero.markup,/目前保存版本：保存場次 0 筆、0 個原盤/);zero.unmount();

const allDates=Array.from({length:45},(_,i)=>day(shift(scope.through,-i),1,1)),truncated=body({days:allDates});truncated.days=truncated.days.slice(0,31);truncated.truncated=true;
const limited=harness();limited.render();limited.calls[0].respond(truncated);await limited.settle();assert.match(limited.markup,/已保存原盤｜收據 45 盤日/);assert.match(limited.markup,/先列最近 31 盤日/);assert.match(limited.markup,/上方累計含完整查詢範圍/);assert.equal(nodes(limited.tree).filter(node=>node.type==='button'&&/^查看 /.test(text(node.props.children))).length,31);limited.unmount();

function legacyFixture(){return{status:'AVAILABLE',snapshotCount:3,boardDateCount:2,lastObservedAt:'2026-10-20T02:00:00Z',
 days:[{date:'2026-10-21',snapshotCount:1,lastObservedAt:'2026-10-20T02:00:00Z',receiptStatus:'LEGACY_ACQUISITION_UNKNOWN'},{date:'2026-10-20',snapshotCount:2,lastObservedAt:'2026-10-19T02:00:00Z',receiptStatus:'LEGACY_ACQUISITION_UNKNOWN'}],
 truncated:false,readAt:new Date(now).toISOString(),historicalAvailabilityVerified:false,formalEligible:false,executable:false};}
const legacySection=h=>renderToStaticMarkup(nodes(h.tree).find(node=>node.type==='section'&&node.props['aria-label']==='舊版盤日（接收時間未確認）'));
const oldOnly=harness();oldOnly.render();const oldBody=body({days:[]});oldBody.legacy=legacyFixture();oldOnly.calls[0].respond(oldBody);await oldOnly.settle();
assert.match(oldOnly.markup,/已保存原盤｜收據 0 盤日｜舊版 2 盤日｜最近 2026-10-21/);assert.match(oldOnly.markup,/已保存 0 筆來源收據｜保存場次 0 筆/);
assert.match(legacySection(oldOnly),/舊版保存 3 筆、2 盤日/);assert.match(legacySection(oldOnly),/接收時間與歷史可得性未確認/);assert.match(legacySection(oldOnly),/不計入上方來源收據、保存場次或評分/);assert.match(legacySection(oldOnly),/來源回報時間（未核對）/);
assert.doesNotMatch(legacySection(oldOnly),/最後接收|最後封存|個原盤|新鮮|目前保存版本|接收已驗證/,'legacy date metadata cannot acquire database receipts, market counts or freshness');
const oldHandler=oldOnly.button('切換至 2026-10-20 當日賽程').props.onClick;oldHandler();assert.deepEqual(oldOnly.selected,['2026-10-20']);
oldOnly.button('重新核對清單').props.onClick();const refreshed=body({days:[]});refreshed.legacy={...refreshed.legacy,status:'EMPTY',readAt:new Date(now).toISOString()};oldOnly.calls[1].respond(refreshed);await oldOnly.settle();oldHandler();
assert.deepEqual(oldOnly.selected,['2026-10-20'],'a removed legacy date cannot navigate through an obsolete same-scope handler');assert.match(legacySection(oldOnly),/此查詢範圍尚未找到舊版盤日/);oldOnly.unmount();

for(const status of ['ABSENT','EMPTY','UNAVAILABLE']){
 const value=body();value.legacy=status==='UNAVAILABLE'?{...value.legacy,status,snapshotCount:null,boardDateCount:null}:status==='EMPTY'?{...value.legacy,status,readAt:new Date(now).toISOString()}:value.legacy;
 const history=harness();history.render();history.calls[0].respond(value);await history.settle();assert.match(history.markup,/已保存 6 筆來源收據/);
 assert.match(legacySection(history),status==='ABSENT'?/沒有可讀取的舊版保存來源/:status==='EMPTY'?/此查詢範圍尚未找到舊版盤日/:/讀取失敗，保存筆數與日期未知，不能判定沒有保存/);
 if(status==='UNAVAILABLE'){assert.match(history.markup,/舊版待核對/);assert.doesNotMatch(legacySection(history),/0 筆|0 盤日|沒有可讀取/);}
 assert.equal(history.button('切換至 2026-10-20 當日賽程'),undefined);history.unmount();
}
const oldTruncated=harness();oldTruncated.render();const oldMany=body();oldMany.legacy={...legacyFixture(),snapshotCount:45,boardDateCount:45,truncated:true,days:Array.from({length:31},(_,i)=>({date:shift(scope.through,-i),snapshotCount:1,lastObservedAt:'2026-10-20T02:00:00Z',receiptStatus:'LEGACY_ACQUISITION_UNKNOWN'}))};
oldTruncated.calls[0].respond(oldMany);await oldTruncated.settle();assert.match(oldTruncated.markup,/收據 2 盤日｜舊版 45 盤日/);assert.match(legacySection(oldTruncated),/舊版超過 31 個盤日/);assert.match(oldTruncated.markup,/已保存 6 筆來源收據/);assert.equal(nodes(oldTruncated.tree).filter(node=>node.type==='button'&&/^切換至 /.test(text(node.props.children))).length,31);oldTruncated.unmount();

for(const mutate of [
 value=>{delete value.legacy;},value=>{value.legacy.formalEligible=true;},value=>{value.legacy.executable=true;},value=>{value.legacy.historicalAvailabilityVerified=true;},
 value=>{value.legacy.snapshotCount='3';},value=>{value.legacy.boardDateCount=0;},value=>{value.legacy.readAt=null;},value=>{value.legacy.days[0].date='2026-11-13';},value=>{value.legacy.days.reverse();},
 value=>{value.legacy.days[0].receiptStatus='DATABASE_RECEIPT_VERIFIED';},value=>{value.legacy.days[0].snapshotCount=4;},value=>{value.legacy.days[0].lastObservedAt='2026-10-21T00:00:00Z';},value=>{value.legacy.truncated=true;},
 value=>{value.legacy={...value.legacy,status:'UNAVAILABLE'};},value=>{value.legacy={...value.legacy,status:'ABSENT'};},
]){
 const malformedLegacy=harness();malformedLegacy.render();const value=body();value.legacy=legacyFixture();mutate(value);malformedLegacy.calls[0].respond(value);await malformedLegacy.settle();
 assert.match(malformedLegacy.markup,/尚未通過核對/);assert.doesNotMatch(malformedLegacy.markup,/切換至 2026|舊版保存 3 筆|收據 2 盤日/);malformedLegacy.unmount();
}

for(const mutate of [
 value=>{value.league='ucl';},value=>{value.scope.from='2026-09-28';},value=>{value.scope.through='2026-11-11';},value=>{value.scope.dateLimit=40;},value=>{value.scope.readAt=null;},
 value=>{value.formalEligible=true;},value=>{value.executable=true;},value=>{value.summary.observationCount='6';},value=>{value.summary.boardDateCount=NaN;},value=>{value.summary.distinctBoardGameKeys=-1;},
 value=>{value.summary.lastBoardDate='2026-10-30';},value=>{value.summary.lastReceivedAt=null;},value=>{value.gameKeyDefinition='OFFICIAL_GAMES';},value=>{value.observationDefinition='INDEPENDENT_GAMES';},
 value=>{value.days[0].date='2026-02-30';},value=>{value.days[0].date='2026-11-13';},value=>{value.days.reverse();},value=>{value.days.push(structuredClone(value.days[0]));},
 value=>{value.days[0].distinctBoardGameKeys=null;},value=>{value.days[0].gameKeysComplete=false;},value=>{value.days[0].lastReceivedAt='2026-10-29T00:00:01Z';},
 value=>{value.days[0].current.marketCount=5;},value=>{value.days[0].current.periods=['FT','FT'];},value=>{value.days[0].current.periodCounts[0].period='BAD';},value=>{value.days[0].current.periodCounts[0].observedAt='2026-02-30T00:00:00Z';},
 value=>{value.days[0].current={status:'UNAVAILABLE',gameCount:0,marketCount:0,periods:[],periodCounts:[]};},value=>{value.truncated=true;},
]){
 const malformed=harness();malformed.render();const value=body();mutate(value);malformed.calls[0].respond(value);await malformed.settle();assert.match(malformed.markup,/尚未通過核對/);assert.doesNotMatch(malformed.markup,/已保存原盤｜收據 2 盤日|查看 2026|4 個原盤/,'malformed metadata cannot turn into usable inventory rows');malformed.unmount();
}

const changed=harness();changed.render();const eplRequest=changed.calls[0];changed.render({...changed.props,league:'ucl'});assert.equal(eplRequest.options.signal.aborted,true);assert.equal(changed.calls.length,2);assert.doesNotMatch(changed.markup,/查看 2026/);
eplRequest.respond(body());await changed.settle();assert.doesNotMatch(changed.markup,/2 盤日|查看 2026/,'a transport ignoring abort cannot restore the previous league');
changed.calls[1].respond(body({league:'ucl'}));await changed.settle();const oldDateHandler=changed.button('查看 2026-10-25 當日賽程').props.onClick;
changed.render({...changed.props,date:'2026-10-25',throughDate:'2026-10-25'});assert.match(changed.calls[2].url,/from=2026-09-25&through=2026-10-25/);oldDateHandler();assert.deepEqual(changed.selected,[],'old scope callbacks cannot navigate after the selected date range changes');
changed.calls[2].respond(body({league:'ucl',days:[day('2026-10-25')],window:{...scope,from:'2026-09-25',through:'2026-10-25'}}));await changed.settle();changed.button('查看 2026-10-25 當日賽程').props.onClick();assert.deepEqual(changed.selected,['2026-10-25']);
const pendingRefresh=changed.button('重新核對清單').props.onClick(),pendingRequest=changed.calls.at(-1),writes=changed.writes;changed.unmount();assert.equal(pendingRequest.options.signal.aborted,true);assert.equal(changed.timers.size,0);
pendingRequest.respond(body({league:'ucl'}));await pendingRefresh;await changed.settle();assert.equal(changed.writes,writes,'unmounted replies cannot write state');

const dormant=harness({initial:{active:false}});assert.equal(dormant.render(),null);assert.equal(dormant.calls.length,0);dormant.render({...dormant.props,active:true});assert.equal(dormant.calls.length,1);const activeRequest=dormant.calls[0];dormant.render({...dormant.props,active:false});assert.equal(activeRequest.options.signal.aborted,true);activeRequest.respond(body());await dormant.settle();assert.equal(dormant.tree,null);assert.equal(dormant.timers.size,0);dormant.unmount();
for(const props of [{date:'2026-02-30'},{throughDate:'not-date'},{league:'nba'},{throughDate:'2028-01-01'}]){const invalid=harness({initial:props});invalid.render();assert.equal(invalid.calls.length,0);assert.match(invalid.markup,/日期範圍尚未通過核對/);invalid.unmount();}
const defaults=harness({initial:{date:'',throughDate:undefined}});defaults.render();assert.equal(defaults.calls[0].url,'/api/soccer/reader-inventory?league=epl&from=2026-09-29&through=2026-10-29');defaults.unmount();
const login=harness();login.render();login.calls[0].respond({ok:false},401);await login.settle();assert.match(login.markup,/登入已過期/);assert.doesNotMatch(login.markup,/0 盤日/);login.unmount();
const synchronous=harness({throwFirst:true});synchronous.render();await synchronous.settle();synchronous.button('重新核對清單').props.onClick();assert.equal(synchronous.calls.length,1,'synchronous fetch failures release the flight for an explicit retry');synchronous.calls[0].respond(body());await synchronous.settle();assert.match(synchronous.markup,/已保存原盤｜收據 2 盤日/);synchronous.unmount();
const timeout=harness();timeout.render();[...timeout.timers.values()][0].fn();assert.equal(timeout.calls[0].options.signal.aborted,true);timeout.calls[0].reject(Object.assign(Error('controlled timeout'),{name:'AbortError'}));await timeout.settle();assert.match(timeout.markup,/讀取逾時，盤日與筆數仍待核對/);assert.doesNotMatch(timeout.markup,/0 盤日/);assert.equal(timeout.timers.size,0);timeout.unmount();

// Verify the public shape from the actual immutable store and inventory SQL,
// then pass that result to the shipped client hooks. Only Neon transport is
// replaced with real PostgreSQL/WASM; no production data or credentials are used.
const sql=await soccerSqlFixture(),before={DATABASE_URL:process.env.DATABASE_URL,DATABASE_V2_URL:process.env.DATABASE_V2_URL};
process.env.DATABASE_URL='postgres://fixture.invalid/reader-inventory-ui';delete process.env.DATABASE_V2_URL;
try{
 const {saveSoccerReaderSnapshot}=await import('../lib/soccer/reader-store.js');
 const {readSoccerReaderInventory}=await import('../lib/soccer/reader-inventory.js');
 const payload={league:'EPL',boardDate:'2026-10-25',observedAt:new Date(Date.now()-60000).toISOString(),executable:false,periodsCovered:['FT'],games:[{
  league:'EPL',boardDate:'2026-10-25',boardTime:'22:00',homeCode:'BHA',awayCode:'CRY',homeKey:'brighton',awayKey:'crystalpalace',homeRaw:'白禮頓[主]',awayRaw:'水晶宮',periodsCovered:['FT'],periodStates:{FT:'open'},
  markets:[{kind:'TOTAL',unit:'GOALS',line:'2.5',overWater:.9,underWater:.95,period:'FT',periodEvidence:{period:'FT',status:'EXPLICIT'}}],
 }]};payload.contentHash=soccerReaderHash(canonicalSoccerPayload(payload));
 await saveSoccerReaderSnapshot(payload);const report=await readSoccerReaderInventory({league:'epl',from:scope.from,through:scope.through});
 assert.equal(report.days[0].current.status,'AVAILABLE');const real=harness();real.render();real.calls[0].respond(report);await real.settle();
 assert.match(real.markup,/已保存原盤｜收據 1 盤日｜最近 2026-10-25/);assert.match(real.markup,/已保存 1 筆來源收據｜保存場次 1 筆/);assert.match(real.markup,/目前保存版本：保存場次 1 筆、1 個原盤/);assert.match(real.markup,/全場 1 個原盤/);
 real.button('查看 2026-10-25 當日賽程').props.onClick();assert.deepEqual(real.selected,['2026-10-25']);real.unmount();
 await sql.db.query('CREATE TABLE sports_soccer_reader_snapshots_v1 (league TEXT NOT NULL,board_date DATE NOT NULL,observed_at TIMESTAMPTZ NOT NULL,revision TEXT NOT NULL,payload JSONB NOT NULL)');
 for(const [league,date,observed] of [['EPL','2026-10-20','2026-10-19T01:00:00Z'],['EPL','2026-10-20','2026-10-19T02:00:00Z'],['EPL','2026-10-21','2026-10-20T02:00:00Z'],['UCL','2026-10-20','2026-10-19T03:00:00Z']]){
  await sql.db.query('INSERT INTO sports_soccer_reader_snapshots_v1 VALUES ($1,$2::date,$3::timestamptz,$4,$5::jsonb)',[league,date,observed,'unreceipted-legacy-fixture',JSON.stringify({deviceId:'private-device',rawRows:['private-old-content']})]);
 }
 const actualLegacy=await readSoccerReaderInventory({league:'epl',from:scope.from,through:scope.through});assert.equal(actualLegacy.summary.observationCount,1);assert.equal(actualLegacy.legacy.snapshotCount,3);
 const realLegacy=harness();realLegacy.render();realLegacy.calls[0].respond(actualLegacy);await realLegacy.settle();
 assert.match(realLegacy.markup,/已保存原盤｜收據 1 盤日｜舊版 2 盤日｜最近 2026-10-25/);assert.match(realLegacy.markup,/已保存 1 筆來源收據｜保存場次 1 筆/);assert.match(legacySection(realLegacy),/舊版保存 3 筆、2 盤日/);
 assert.doesNotMatch(realLegacy.markup,/private-device|private-old-content|unreceipted-legacy-fixture/);assert.doesNotMatch(legacySection(realLegacy),/最後接收|最後封存|個原盤/);
 realLegacy.button('切換至 2026-10-20 當日賽程').props.onClick();assert.deepEqual(realLegacy.selected,['2026-10-20']);realLegacy.unmount();
}finally{for(const key of Object.keys(before)){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}await sql.close();}
console.log('PASS shipped Reader inventory JSX/hooks: actual PostgreSQL v2 and separate legacy metadata, no invented acquisition/market/freshness claims or mixed counts, exact league/range, unknown/confirmed-zero, separate 31-date truncation, validated navigation, malformed rejection, stale callbacks/replies, active/unmount abort and retry');
