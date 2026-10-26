import assert from 'node:assert/strict';
import { readerSaveReceiptFixture } from './reader-save-receipt-fixture.mjs';
import '../reader/soccer-card-normalizer.js';
import { parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload } from '../reader/parser.js';
import { soccerMarket, canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { readerPayloadsByDate, selectAuthoritativeBoard, selectAuthoritativeSoccerBoards, shouldSkipSuccessfulPayload } from '../reader/board-selector.js';
import { validateSoccerCapture, matchSoccerReaderGames } from '../lib/soccer/reader.js';
const now=Date.parse('2026-10-18T12:54Z');
const at=new Date(now).toISOString();
// Reconstructed geometry from the user screenshots; the cropped league heading
// is a synthetic explicit test envelope, never evidence of the live site's DOM.
const fragments=[];const add=(text,top,left)=>fragments.push({text,top,left});
function card(top,{corner=false,alt=false}={}){
 add('獨贏',top,530);add('讓分',top,750);add('大小',top,970);
 add('10/18 21:00 (GMT+8)',top+70,40);
 add(corner?'白禮頓-角球數[主]':'白禮頓[主]',top+160,40);add(corner?'水晶宮-角球數':'水晶宮',top+330,40);
 for(const [label,y]of [['主勝',160],['和',330],['客勝',500]]){add(label,top+y,530);add('-',top+y+70,570);}
 add(alt?'1.5':'1平',top+160,750);add(alt?'1.18':'0.63',top+230,750);add(alt?'0.73':'1.27',top+470,750);
 add(alt?'大3-50':'大3+50',top+160,970);add(alt?'1.08':'0.64',top+230,970);add('小',top+400,970);add(alt?'0.78':'1.28',top+470,970);
}
card(0);card(650,{alt:true});card(1300,{corner:true});
const normalized=globalThis.Tai888SoccerCardNormalizer.normalize([{label:'英格蘭超級聯賽',fragments}],'EPL');
assert.equal(normalized.tables[0].rows.length,2);assert.equal(normalized.diagnostics.excludedProps,1);
const capture={...normalized,league:'EPL',pageLeagueLabel:'英格蘭超級聯賽',sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/',observedAt:at};
const payload=parseTai888Capture(capture,new Date(now));
assert.deepEqual(payload.parseIssues,[]);assert.equal(payload.games.length,1);
assert.equal(payload.games[0].markets.length,4,'alternative lines remain distinct; unavailable 1X2 is not a zero quote');
const markets=payload.games[0].markets;
assert.deepEqual(markets.filter(m=>m.kind==='TOTAL').map(m=>[m.line,m.overWater,m.underWater]),[['3+50',.64,1.28],['3-50',1.08,.78]]);
assert.deepEqual(markets.filter(m=>m.kind==='HANDICAP').map(m=>[m.line,m.lineSide,m.homeWater,m.awayWater]),[['1平','home',.63,1.27],['1.5','home',1.18,.73]]);
assert.ok(markets.every(m=>m.unit==='GOALS'));assert.equal(payload.executable,false);
assert.equal(parseTai888Capture({...capture,pageLeagueLabel:'NHL國家冰球聯盟--包括加時與點球'},new Date(now)).games.length,0);
assert.equal(globalThis.Tai888LeagueRegistry.standardMarker('歐洲冠軍聯賽','UCL'),true);
assert.equal(globalThis.Tai888LeagueRegistry.standardMarker('歐洲冠軍聯賽 上半場','UCL'),true);
assert.equal(globalThis.Tai888LeagueRegistry.identify('歐洲聯賽'),null);
const candidate={tabId:1,frameId:0,active:true,capture,parsed:payload};
const selected=selectAuthoritativeBoard([candidate],{now,league:'EPL'});assert.equal(selected.ok,true,JSON.stringify(selected.assessed));
const wire={...payload,readerVersion:'2.1.34',pageActivityAt:at};
const checked=validateSoccerCapture(wire,{now,headerVersion:'2.1.34'});assert.equal(checked.ok,true,JSON.stringify(checked));
const corrupted=structuredClone(wire);corrupted.games[0].markets[0].homeWater=.01;
assert.equal(validateSoccerCapture(corrupted,{now,headerVersion:'2.1.34'}).ok,false);
assert.equal(validateSoccerCapture({...wire,league:'NHL'},{now,headerVersion:'2.1.34'}).ok,false);
assert.equal(validateSoccerCapture(wire,{now:now+180001,headerVersion:'2.1.34'}).ok,false);
const reverse=value=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(k=>[k,reverse(value[k])])):value;
assert.equal(canonicalSoccerPayload(wire),canonicalSoccerPayload(reverse(wire)),'PostgreSQL JSONB order must not corrupt source hashes');
const official={league:'epl',date:'2026-10-18',id:'soccer:epl:123',startTime:'2026-10-18T13:00:00.000Z',status:'scheduled',home:{name:'Brighton & Hove Albion'},away:{name:'Crystal Palace'}};
assert.equal(matchSoccerReaderGames(checked.payload,[official],now)[0].officialGameId,official.id);
assert.equal(matchSoccerReaderGames(checked.payload,[{...official,home:official.away,away:official.home}],now)[0].matchStatus,'UNMATCHED');
assert.equal(matchSoccerReaderGames(checked.payload,[{...official,league:'ucl'}],now)[0].matchStatus,'UNMATCHED');
const second=structuredClone(payload.games[0]);second.boardDate='2026-10-19';
assert.equal(readerPayloadsByDate({...payload,games:[payload.games[0],second]}).length,2);
assert.equal(soccerMarket('total',['大3+50 0.64','小 1.28']).line,'3+50');
assert.equal(soccerMarket('moneyline',['主勝 -','和 -','客勝 -']),null);
assert.ok(canonicalReaderPayload(payload).includes('3-50'));
console.log('PASS soccer screenshot reconstruction: 2 alternate goal cards, corner exclusion, dash/decimal/credit fidelity, paired board authority, server reparse, scope/freshness/JSONB and official identity guards. Live DOM NOT VERIFIED.');

if(process.argv.includes('--api')){
  const {register}=await import('node:module');
  register('./next-route-test-loader.mjs',import.meta.url);
  const {soccerSqlFixture}=await import('./helpers/soccer-sql-fixture.mjs');
  const fixture=await soccerSqlFixture(),{db}=fixture;
  const envKeys=['DATABASE_URL','DATABASE_V2_URL','APP_PASSWORD','SESSION_SECRET','READER_PAIR_SECRET'];
  const before=Object.fromEntries(envKeys.map(k=>[k,process.env[k]])),oldFetch=globalThis.fetch,oldNow=Date.now;
  const rowCount=async()=>(await db.query('SELECT count(*)::int AS n FROM sports_soccer_reader_observations_v2')).rows[0].n;
  try{
    Date.now=()=>now;delete process.env.DATABASE_V2_URL;process.env.DATABASE_URL='postgres://fixture.invalid/soccer';process.env.APP_PASSWORD='soccer-fixture';process.env.SESSION_SECRET='soccer-fixture-session';process.env.READER_PAIR_SECRET='soccer-fixture-reader';
    globalThis.fetch=async(url)=>{assert.match(String(url),/^https:\/\/site.api.espn.com\/apis\/site\/v2\/sports\/soccer\/eng.1\/scoreboard\?dates=202610(?:17|18)$/);return Response.json({leagues:[{id:'700',slug:'eng.1'}],events:[{id:'123',date:official.startTime,status:{type:{state:'pre'}},competitions:[{competitors:[{homeAway:'home',team:{id:'376',displayName:'Brighton & Hove Albion'}},{homeAway:'away',team:{id:'384',displayName:'Crystal Palace'}}]}]}]});};
    const {createReaderToken}=await import('../lib/reader-auth-v2.js');
    const {createSessionToken}=await import('../lib/security.js');
    const {POST,GET,OPTIONS}=await import('../app/api/soccer/reader/route.js');
    const token=await createReaderToken({deviceId:'soccer-local-fixture'}),session=await createSessionToken();
    const post=(body=wire,headers={})=>POST(new Request('https://fixture.invalid/api/soccer/reader',{method:'POST',headers:{Origin:`chrome-extension://${'a'.repeat(32)}`,Authorization:`Bearer ${token}`,'x-device-id':'soccer-local-fixture','x-reader-version':'2.1.34','content-type':'application/json',...headers},body:JSON.stringify(body)}));
    assert.equal((await post(wire,{Authorization:''})).status,401);
    assert.equal((await post(wire,{Origin:'https://evil.invalid'})).status,403);
    assert.equal((await post(wire,{'x-device-id':'another-device'})).status,403);
    assert.equal((await post(corrupted)).status,422);assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename='sports_soccer_reader_observations_v2'")).rows[0].n,0);
    const saved=await post();assert.equal(saved.status,200,JSON.stringify(await saved.clone().json()));assert.equal((await saved.json()).persisted,true);assert.equal(await rowCount(),1);
    assert.equal((await post()).status,200);assert.equal(await rowCount(),1,'exact transport retries do not duplicate observations');
    const get=(query='league=EPL&date=2026-10-18',auth=true)=>GET(new Request(`https://fixture.invalid/api/soccer/reader?${query}`,{headers:auth?{cookie:`mlb_session=${session}`}:{}}));
    assert.equal((await get(undefined,false)).status,401);assert.equal((await get('league=NHL&date=2026-10-18')).status,400);
    const read=await get();assert.equal(read.status,200);assert.equal(read.headers.get('Cache-Control'),'no-store');const body=await read.json();assert.equal(body.games.length,1);assert.equal(body.games[0].officialGameId,'soccer:epl:123');assert.equal(body.executable,false);
    assert.equal((await get('league=UCL&date=2026-10-18')).status,200);assert.equal((await(await get('league=UCL&date=2026-10-18')).json()).games.length,0);
    assert.equal((await OPTIONS(new Request('https://fixture.invalid/api/soccer/reader',{headers:{Origin:'https://evil.invalid'}}))).status,403);
    console.log('PASS real soccer Reader API/store with isolated SQL transport: origin/token/device, server reparse, durable readback/dedup, private GET, official join and league isolation; no Production writes.');
  }finally{Date.now=oldNow;globalThis.fetch=oldFetch;await fixture.close();for(const k of envKeys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}}
}

// Execute the packaged worker against both football envelopes, not a copied upload helper.
{
 const {default:fs}=await import('node:fs'),{default:vm}=await import('node:vm'),{webcrypto}=await import('node:crypto');
 const version=JSON.parse(fs.readFileSync('reader/manifest.json')).version;
 const captures=[capture,{...capture,league:'UCL',pageLeagueLabel:'歐洲冠軍聯賽',tables:capture.tables.map(table=>({...table,sectionTitle:String(table.sectionTitle||'').replaceAll('英格蘭超級聯賽','歐洲冠軍聯賽')}))}],uploads=[];
 const event={addListener(){}},state={deviceId:'soccer-worker-fixture',readerToken:'fixture-token'};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const chrome={runtime:{onInstalled:event,onStartup:event,onMessage:event},alarms:{onAlarm:event},tabs:{onUpdated:event,query:async()=>[{id:7,active:true}],sendMessage:async()=>({ok:true,capture:{readerVersion:version,captures}})},webNavigation:{getAllFrames:async()=>[{frameId:0}]},storage:{local:{get:async()=>structuredClone(state),set:async v=>Object.assign(state,v),remove:async()=>{}}}};
 const worker={chrome,Date:Clock,URL,setTimeout,clearTimeout,queueMicrotask,TextEncoder,AbortController,crypto:webcrypto,parseTai888Capture,canonicalReaderPayload,readerMarketProperties,nhlReaderEvidencePayload,selectAuthoritativeBoard,selectAuthoritativeSoccerBoards,readerPayloadsByDate,shouldSkipSuccessfulPayload,fetch:async(url,options)=>{
  assert.equal(url,'https://mlb-positive-ev.vercel.app/api/soccer/reader');assert.equal(options.headers['X-Reader-Version'],version);
  const body=JSON.parse(options.body),checked=validateSoccerCapture(body,{now,headerVersion:version});assert.equal(checked.ok,true,JSON.stringify(checked));uploads.push(body.league);
  return{ok:true,status:200,text:async()=>JSON.stringify(readerSaveReceiptFixture(body,{rawGameCount:1,marketCount:4,executable:false}))};
 }};
 vm.createContext(worker);vm.runInContext(fs.readFileSync('reader/background.js','utf8').replace(/^import .*?;\n/gm,''),worker);
 assert.equal((await vm.runInContext("performSync('manual')",worker)).ok,true);assert.deepEqual(uploads,['EPL','UCL']);
 for(const league of uploads){assert.equal(state.readerStatuses[league].captureOnly,true);assert.equal(state.readerStatuses[league].executable,false);assert.equal(state.readerStatuses[league].marketCount,4);}
 uploads.length=0;await vm.runInContext("performSync('alarm')",worker);assert.equal(uploads.length,0,'unchanged football rescans respect heartbeat throttle');
 console.log('PASS packaged Reader worker: EPL/UCL signed separate uploads, server reparse, four alternate markets, receipts and heartbeat. Live PC NOT VERIFIED.');
}
