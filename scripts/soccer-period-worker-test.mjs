import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload } from '../reader/parser.js';
import { selectAuthoritativeBoard, selectAuthoritativeSoccerBoards, assessBoardCandidate, readerPayloadsByDate, shouldSkipSuccessfulPayload } from '../reader/board-selector.js';
import { validateSoccerCapture } from '../lib/soccer/reader.js';

const now=Date.parse('2026-10-19T00:00:00Z'),at=new Date(now).toISOString();
const version=JSON.parse(fs.readFileSync('reader/manifest.json')).version;
const backgroundSource=fs.readFileSync('reader/background.js','utf8');
assert.equal(backgroundSource.match(/const VERSION = '([^']+)'/)?.[1],version,'packaged worker and manifest versions must agree');
const plain=value=>JSON.parse(JSON.stringify(value));
const cell=pair=>({pair});
function board(period,{line='1平',water='0.90',date='10-19',locked=false}={}){
  const prefix=period==='FT'?'全場':period==='HT'?'上半場':'';
  return {version:'TAI888-DOM-CAPTURE-v2.2.0',league:'EPL',pageLeagueLabel:'英格蘭超級聯賽',sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/',observedAt:at,
    tables:[{...(period==='UNKNOWN'?{}:{sectionTitle:'英格蘭超級聯賽',headers:['時間','主客隊伍',`${prefix}讓球`,`${prefix}大小`,`${prefix}獨贏`]}),rows:[{cells:[cell([date,'22:00']),cell(['水晶宮','白禮頓[主]']),cell(locked?['-','-']:[`${line} ${water}`,'0.95']),cell(locked?['-','-']:['大3+50 0.88','小 0.92']),cell(['主勝 -','和 -','客勝 -'])]}]}],diagnostics:{gameCount:1,expectedGameCount:1,lastMutationAt:at}};
}
const candidate=(capture,tabId=1,frameId=0)=>({capture,parsed:parseTai888Capture(capture,new Date(now)),tabId,frameId,active:tabId===1,lastAccessed:tabId});
const ft=board('FT'),ht=board('HT',{line:'0.5',water:'0.85'});
const ftCandidate=candidate(ft,1),htCandidate=candidate(ht,2);
const separate=selectAuthoritativeSoccerBoards([ftCandidate,htCandidate],{league:'EPL',now});
assert.equal(separate.ok,true,JSON.stringify(separate));assert.equal(separate.selections.length,2);
assert.deepEqual(separate.selections.map(item=>item.periodsCovered),[['FT'],['HT']]);
assert.equal(separate.selections[0].selected.candidate,ftCandidate,'authority projection maps back to the exact original source');
assert.equal(separate.selections[1].selected.candidate,htCandidate);
const changed=board('FT',{water:'0.91'});
const conflict=selectAuthoritativeSoccerBoards([ftCandidate,candidate(changed,3),htCandidate],{league:'EPL',now});
assert.equal(conflict.ok,false,'disagreement in a shared period cannot be rescued by a valid different-period source');
assert.equal(conflict.selections.length,0);
const combined={...ft,tables:[...ft.tables,...ht.tables]};
const combinedCandidate=candidate(combined);
const combinedSelected=selectAuthoritativeSoccerBoards([combinedCandidate],{league:'EPL',now});
assert.equal(combinedSelected.ok,true,JSON.stringify(combinedSelected));assert.equal(combinedSelected.selections.length,1,'one source selected for FT and HT is uploaded only once');
assert.equal(combinedSelected.selections[0].selected.candidate,combinedCandidate);
assert.deepEqual(combinedSelected.selections[0].periodsCovered,['FT','HT']);
const multi={...ft,tables:[...ft.tables,...board('HT',{date:'10-20'}).tables],diagnostics:{gameCount:2,expectedGameCount:2,lastMutationAt:at}};
const days=readerPayloadsByDate(parseTai888Capture(multi,new Date(now)));
assert.deepEqual(days.map(day=>[day.boardDate,day.periodsCovered]),[['2026-10-19',['FT']],['2026-10-20',['HT']]],'a period from another date cannot clear this date');
assert.equal(days[0].sourceCapture.tables,multi.tables,'the entire captured source remains available for server reparse');
assert.deepEqual(readerPayloadsByDate({league:'EPL',games:[],periodsCovered:['FT'],boardDate:'2026-10-19'}),[],'scope metadata with no dated identity rows cannot create a tombstone upload');

const event={addListener(){}};
class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
async function execute(captures,{failPeriod=null}={}){
  const state={readerToken:'synthetic-period-worker-token',deviceId:'synthetic-period-worker-device',autoEnabled:true},uploads=[];
  let shouldFail=failPeriod;
  const tabs=captures.map((capture,index)=>({id:index+1,active:index===0,lastAccessed:index+1}));
  const chrome={runtime:{onInstalled:event,onStartup:event,onMessage:event},alarms:{onAlarm:event},tabs:{onUpdated:event,query:async()=>tabs,sendMessage:async(tabId)=>({ok:true,capture:{readerVersion:version,captures:[captures[tabId-1]]}})},webNavigation:{getAllFrames:async()=>[{frameId:0}]},storage:{local:{get:async()=>structuredClone(state),set:async value=>Object.assign(state,value),remove:async key=>{delete state[key];}}}};
  const worker=vm.createContext({chrome,Date:Clock,URL,setTimeout,clearTimeout,queueMicrotask,TextEncoder,AbortController,crypto:webcrypto,
    parseTai888Capture,canonicalReaderPayload,readerMarketProperties,nhlReaderEvidencePayload,selectAuthoritativeBoard,selectAuthoritativeSoccerBoards,shouldSkipSuccessfulPayload,readerPayloadsByDate,
    fetch:async(url,options)=>{
      assert.equal(url,'https://mlb-positive-ev.vercel.app/api/soccer/reader');
      const body=JSON.parse(options.body);uploads.push(body);
      const checked=validateSoccerCapture(body,{now,headerVersion:version});assert.equal(checked.ok,true,JSON.stringify(checked));
      const original=captures.find(capture=>JSON.stringify(capture.tables)===JSON.stringify(body.sourceCapture.tables));
      assert.ok(original,'uploaded sourceCapture must be an entire actual source, never an authority projection or recombined frames');
      if(shouldFail&&body.periodsCovered?.includes(shouldFail))return{ok:false,status:503,text:async()=>JSON.stringify({ok:false,error:'synthetic scope failure'})};
      return{ok:true,status:200,text:async()=>JSON.stringify({ok:true,rawGameCount:body.games.length,marketCount:body.games.reduce((sum,game)=>sum+game.markets.length,0),executable:false})};
    }});
  vm.runInContext(backgroundSource.replace(/^import .*?;\n/gm,''),worker);
  const run=reason=>vm.runInContext(`performSync('${reason}')`,worker);
  const first=await run('manual');
  return{state,uploads,run,first,clearFailure(){shouldFail=null;}};
}
const separateWorker=await execute([ft,ht]);
assert.equal(separateWorker.first.ok,true,JSON.stringify(separateWorker.state.readerStatuses.EPL));assert.equal(separateWorker.uploads.length,2);
assert.deepEqual(separateWorker.uploads.map(body=>body.periodsCovered),[['FT'],['HT']]);
assert.deepEqual(Object.keys(separateWorker.state.lastSuccessfulSyncAts).sort(),['EPL:2026-10-19:FT','EPL:2026-10-19:HT']);
assert.deepEqual(plain(separateWorker.state.readerStatuses.EPL.dateStatuses.map(receipt=>receipt.periodsCovered)),[['FT'],['HT']]);
assert.equal(separateWorker.state.readerStatuses.EPL.executable,false);
assert.equal(separateWorker.state.readerStatuses.EPL.uniqueGameCount,1);
assert.equal(separateWorker.state.readerStatuses.EPL.rawGameCount,2);
assert.match(separateWorker.state.readerStatuses.EPL.message,/2 筆盤面紀錄/,'the same match observed in two periods is not described as two independent matches');
separateWorker.uploads.length=0;await separateWorker.run('alarm');assert.equal(separateWorker.uploads.length,0,'heartbeat receipts are scoped independently');
const conflictWorker=await execute([ft,changed,ht]);
assert.equal(conflictWorker.first.ok,false);assert.equal(conflictWorker.uploads.length,0);assert.equal(conflictWorker.state.readerStatuses.EPL.state,'error');
const combinedWorker=await execute([combined]);
assert.equal(combinedWorker.first.ok,true);assert.equal(combinedWorker.uploads.length,1);assert.equal(combinedWorker.uploads[0].sourceCapture.tables.length,2);assert.deepEqual(combinedWorker.uploads[0].periodsCovered,['FT','HT']);
const dateWorker=await execute([multi]);assert.equal(dateWorker.uploads.length,2);assert.deepEqual(dateWorker.uploads.map(body=>[body.boardDate,body.periodsCovered]),[['2026-10-19',['FT']],['2026-10-20',['HT']]]);
const partialWorker=await execute([ft,ht],{failPeriod:'HT'});
assert.equal(partialWorker.state.readerStatuses.EPL.ok,false);assert.equal(partialWorker.state.readerStatuses.EPL.dateStatuses.length,1);assert.deepEqual(plain(partialWorker.state.readerStatuses.EPL.dateErrors[0].periodsCovered),['HT']);
partialWorker.clearFailure();partialWorker.uploads.length=0;await partialWorker.run('alarm');assert.equal(partialWorker.uploads.length,1);assert.deepEqual(partialWorker.uploads[0].periodsCovered,['HT'],'a failed HT upload does not force a successful FT re-upload');
const legacyWorker=await execute([board('UNKNOWN')]);
assert.equal(legacyWorker.first.ok,true);assert.deepEqual(legacyWorker.uploads[0].periodsCovered,['UNKNOWN']);assert.deepEqual(Object.keys(legacyWorker.state.lastSuccessfulSyncAts),['EPL:2026-10-19'],'legacy unknown-period heartbeat key is unchanged');
legacyWorker.uploads.length=0;await legacyWorker.run('alarm');assert.equal(legacyWorker.uploads.length,0);
const lockedCapture=board('FT',{locked:true}),locked=candidate(lockedCapture);
assert.equal(locked.parsed.games.length,1,'an all-locked board retains an explicit dated game identity');
assert.equal(locked.parsed.games[0].marketStatus,'locked');assert.deepEqual(locked.parsed.games[0].markets,[]);assert.deepEqual(locked.parsed.games[0].periodsCovered,['FT']);
assert.equal(assessBoardCandidate(locked,now).ok,true,'an empty market array is not a live locked-game quote');
const lockedWorker=await execute([lockedCapture]);assert.equal(lockedWorker.first.ok,true);assert.equal(lockedWorker.uploads.length,1);assert.deepEqual(lockedWorker.uploads[0].periodsCovered,['FT']);assert.equal(lockedWorker.state.readerStatuses.EPL.marketCount,0);
const mixedCapture={...ft,tables:[...ft.tables,...board('HT',{locked:true}).tables]};
const mixed=candidate(mixedCapture);assert.equal(mixed.parsed.games[0].marketStatus,'open');assert.deepEqual(mixed.parsed.games[0].periodStates,{FT:'open',HT:'locked'});
assert.equal(selectAuthoritativeSoccerBoards([mixed,htCandidate],{league:'EPL',now}).ok,false,'an HT scoped tombstone conflicts with another HT frame exposing a live price, even while FT remains open');
const mixedWorker=await execute([mixedCapture]);assert.equal(mixedWorker.first.ok,true);assert.equal(mixedWorker.uploads.length,1);assert.deepEqual(mixedWorker.uploads[0].periodsCovered,['FT','HT']);assert.equal(mixedWorker.uploads[0].games[0].periodStates.HT,'locked');
const noIdentity={...ft,tables:[{...ft.tables[0],rows:[]}],diagnostics:{gameCount:0,expectedGameCount:0,lastMutationAt:at}};
const emptyWorker=await execute([noIdentity]);assert.equal(emptyWorker.first.ok,false);assert.equal(emptyWorker.uploads.length,0,'a bare FT header is not evidence that all matches are locked');
console.log('PASS real Reader worker: separate FT/HT authority and uploads, original-capture reparse, same-scope conflicts, source dedup, date-scoped receipts/retries, legacy UNKNOWN heartbeat and identity-backed locked tombstones');
