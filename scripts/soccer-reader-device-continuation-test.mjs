import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {soccerSqlFixture} from './helpers/soccer-sql-fixture.mjs';

const fixture=await soccerSqlFixture();
const envKeys=['DATABASE_URL','DATABASE_V2_URL','SOCCER_READER_PERIOD_BINDING_JSON','SOCCER_READER_PERIOD_BINDING_ADDITIONAL_JSON','SOCCER_READER_PERIOD_BINDING_CURRENT_JSON'];
const before=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const hash=value=>createHash('sha256').update(value).digest('hex');
try {
  process.env.DATABASE_URL='postgres://fixture.invalid/device-continuation';
  delete process.env.DATABASE_V2_URL;
  delete process.env.SOCCER_READER_PERIOD_BINDING_ADDITIONAL_JSON;
  delete process.env.SOCCER_READER_PERIOD_BINDING_CURRENT_JSON;
  const {parseSoccerCapture}=await import('../reader/soccer-parser.js');
  const {validateSoccerCapture,matchSoccerReaderGames}=await import('../lib/soccer/reader.js');
  const {saveSoccerReaderSnapshot,loadSoccerReaderSnapshot}=await import('../lib/soccer/reader-store.js');
  const {registerSoccerReaderPeriodDevice,loadSoccerReaderPeriodDeviceAuthorizations}=await import('../lib/soccer/reader-period-device-registry.js');
  const {soccerReaderDeviceContinuationTemplate,soccerReaderPeriodBindingDiagnostics,soccerMarketHasVerifiedPeriodResolution}=await import('../lib/soccer/reader-period-binding.js');
  const deviceId='synthetic-reinstalled-paired-reader',deviceHash=hash(deviceId);
  const parent={version:'TAI888-ACCOUNT-PERIOD-BINDING-v1',profile:'TAI888-DESKTOP-PRIMARY-WITH-EXPLICIT-HT-v1',
    sourceHost:'www.tai888.in',deviceHash:hash('synthetic-original-paired-reader'),leagues:['epl'],
    proofKey:'a'.repeat(64),confirmedAt:new Date(Date.now()-60000).toISOString()};
  process.env.SOCCER_READER_PERIOD_BINDING_JSON=JSON.stringify(parent);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const rawAt=at=>({league:'EPL',pageLeagueLabel:'聯盟: 英格蘭超級聯賽(25)',sourceHost:parent.sourceHost,pageUrl:'https://www.tai888.in/newapp/',observedAt:at,
    tables:[['時間','主客隊伍','讓球','大小盤','獨贏','單雙','備註'],['時間','主客隊伍','上半讓球','上半大小','','單雙','備註']]
      .map(headers=>({headers,sectionTitle:'聯盟: 英格蘭超級聯賽(25)',rows:[{cells:[{pair:[today.slice(5),'22:00']},
        {pair:['賓福特','侯城[主]']},{pair:['1+50 0.91','0.97']},{pair:['大3+50 0.85','小 1.01']},{pair:['主勝 -','和 -','客勝 -']}]}]}))});
  const payloadAt=at=>{
    const wire={...parseSoccerCapture(rawAt(at),new Date(at)),readerVersion:'2.1.56',pageActivityAt:at};
    const checked=validateSoccerCapture(wire,{now:Date.now(),headerVersion:'2.1.56'});
    assert.equal(checked.ok,true,JSON.stringify(checked));
    return {...checked.payload,deviceId};
  };
  const original=payloadAt(new Date(Date.now()-20).toISOString());
  assert.equal((await registerSoccerReaderPeriodDevice({payload:original,authenticatedDeviceId:'wrong-device',observationId:'b'.repeat(64)})).reason,'AUTHENTICATED_DEVICE_REQUIRED');
  const uncreated=await fixture.db.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename='sports_soccer_reader_period_devices_v1'");
  assert.equal(uncreated.rows[0].n,0,'unverified callers cannot create schema or authorize a device');
  const notInitialized=await loadSoccerReaderPeriodDeviceAuthorizations('epl',[deviceHash]);
  assert.equal(notInitialized.status,'NOT_INITIALIZED');
  assert.equal((await fixture.db.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename='sports_soccer_reader_period_devices_v1'")).rows[0].n,0,'GET-style reads never initialize registration schema');
  assert.ok(soccerReaderDeviceContinuationTemplate(original,deviceHash));
  assert.equal(soccerReaderDeviceContinuationTemplate({...original,pageUrl:'https://www.tai888.in/unrelated/'},deviceHash),null);
  assert.equal(soccerReaderDeviceContinuationTemplate({...original,league:'UCL'},deviceHash),null);
  const noHalf=structuredClone(original);noHalf.games[0].markets=noHalf.games[0].markets.filter(m=>m.period!=='HT');
  assert.equal(soccerReaderDeviceContinuationTemplate(noHalf,deviceHash),null);
  const conflicting=structuredClone(original);conflicting.games[0].markets.find(m=>m.period==='UNKNOWN').periodEvidence.tableHeaders[0]='other';
  assert.equal(soccerReaderDeviceContinuationTemplate(conflicting,deviceHash),null);
  const saved=await saveSoccerReaderSnapshot(original);
  const register=(payload,observationId=saved.observationId)=>registerSoccerReaderPeriodDevice({payload,authenticatedDeviceId:deviceId,observationId});
  const rejected=await register({...original,pageActivityAt:new Date(Date.now()).toISOString()});
  assert.equal(rejected.status,'ALREADY_REGISTERED_OR_EVIDENCE_REJECTED','changing a stored immutable payload cannot register');
  const first=await register(original);assert.equal(first.status,'REGISTERED_FORWARD_ONLY');
  const registration=(await fixture.db.query('SELECT * FROM sports_soccer_reader_period_devices_v1')).rows[0];
  assert.equal(registration.evidence_observation_id,saved.observationId);
  assert.ok(new Date(registration.registered_at).getTime()>=Date.parse(saved.receivedAt));
  assert.equal((await register(original)).status,'ALREADY_REGISTERED_OR_EVIDENCE_REJECTED');
  assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM sports_soccer_reader_period_devices_v1')).rows[0].n,1);
  const old=await loadSoccerReaderSnapshot('epl',today);
  assert.ok(old.games[0].markets.every(m=>!m.serverObservation.periodBindingAuthorization),'registration cannot upgrade its older evidence observation');
  const historical=await loadSoccerReaderSnapshot('epl',today,{asOf:saved.receivedAt});
  assert.ok(!historical||historical.games[0].markets.every(m=>!m.serverObservation.periodBindingAuthorization));
  await new Promise(resolve=>setTimeout(resolve,10));
  const next=payloadAt(new Date().toISOString()),nextSaved=await saveSoccerReaderSnapshot(next);
  const current=await loadSoccerReaderSnapshot('epl',today);
  const official={id:'soccer:epl:123',sourceId:'123',league:'epl',date:today,startTime:`${today}T14:00:00.000Z`,status:'scheduled',
    home:{sourceId:'306',name:'Hull City'},away:{sourceId:'337',name:'Brentford'}};
  const matched=matchSoccerReaderGames(current,[official]);
  const ft=matched[0].markets.filter(m=>m.period==='FT');assert.equal(ft.length,2);
  assert.ok(ft.every(m=>soccerMarketHasVerifiedPeriodResolution(m)));
  assert.equal(soccerReaderPeriodBindingDiagnostics(matched,current).resolvedMarketCount,2);
  assert.equal(current.games[0].markets.find(m=>m.period==='UNKNOWN').line,'1+50');
  assert.equal(current.games[0].markets[0].serverObservation.observedAt,nextSaved.observedAt);
  const cert=current.games[0].markets[0].serverObservation.periodBindingAuthorization;
  assert.equal(cert.evidenceObservationId,saved.observationId);assert.equal(cert.deviceHash,deviceHash);
  assert.ok(!JSON.stringify(cert).includes(parent.proofKey),'authorization exposes no private signing key');
  const resolvedCount=value=>matchSoccerReaderGames(value,[official])[0].markets.filter(m=>m.period==='FT').length;
  for(const patch of [{deviceHash:'d'.repeat(64)},{sourceHost:'other.tai888.in'},{league:'ucl'},
    {parentConfigHash:'f'.repeat(64)},{evidenceObservationId:'e'.repeat(64)},
    {registeredAt:parent.confirmedAt},{signature:'0'.repeat(64)},{approved:true}]){
    const forged=structuredClone(current);for(const game of forged.games)for(const m of game.markets)
      Object.assign(m.serverObservation.periodBindingAuthorization,patch);
    assert.equal(resolvedCount(forged),0,JSON.stringify(patch));
  }
  const moved=structuredClone(current);moved.games[0].markets.forEach(m=>{m.serverObservation.deviceHash='9'.repeat(64);});
  assert.equal(resolvedCount(moved),0,'a valid certificate cannot transfer to another device');
  const movedPage=structuredClone(current);movedPage.games[0].markets.forEach(m=>{m.serverObservation.pageUrl='https://www.tai888.in/unrelated/';});
  assert.equal(resolvedCount(movedPage),0,'device continuation is confined to its confirmed desktop source path');
  const tooOld=structuredClone(current);tooOld.games[0].markets.forEach(m=>{m.serverObservation.observedAt=new Date(Date.parse(cert.registeredAt)-1).toISOString();});
  assert.equal(resolvedCount(tooOld),0,'source time preceding actual registration stays unknown');
  const unresolved=structuredClone(current);unresolved.games[0].markets.forEach(m=>{delete m.serverObservation.periodBindingAuthorization;});
  assert.equal(resolvedCount(unresolved),0,'unregistered paired metadata still fails the original device check');
  process.env.SOCCER_READER_PERIOD_BINDING_JSON=JSON.stringify({...parent,confirmedAt:new Date(Date.now()-1000).toISOString()});
  assert.equal(resolvedCount(current),0,'removing the parent configuration invalidates inherited certificates');
  const rotated=await register(next,nextSaved.observationId);assert.equal(rotated.status,'REGISTERED_FORWARD_ONLY');
  assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM sports_soccer_reader_period_devices_v1')).rows[0].n,2,'a changed parent configuration receives a new registration timestamp');
  process.env.SOCCER_READER_PERIOD_BINDING_JSON=JSON.stringify(parent);
  const microBase=new Date(Date.now()+100).toISOString().replace(/\.\d{3}Z$/,'.000Z');
  const microRead=await loadSoccerReaderPeriodDeviceAuthorizations('epl',[deviceHash],{now:Date.now()+10000,query:async()=>[{
    ...registration,registered_at:microBase.replace('.000Z','.000900Z'),effective_at:microBase.replace('.000Z','.001Z')}]});
  assert.equal(microRead.authorizations[0].registeredAt,microBase.replace('.000Z','.001Z'),'microsecond registrations round forward, not backward');

  // Execute the shipped POST handler with only transport/dependencies injected.
  const source=fs.readFileSync('app/api/soccer/reader/route.js','utf8').replace(/^import .*?;\n/gm,'')
    .replace(/export const /g,'const ').replace(/export async function /g,'async function ');
  const calls=[];let tokenValid=false,captureValid=true,saveFails=false,registrationFails=false;
  const context=vm.createContext({URL,Response,Date,NextResponse:{json:(body,options)=>Response.json(body,options)},
    readerCorsHeaders:()=>({}),readerOriginAllowed:()=>true,bearerToken:()=>'',verifyReaderToken:async()=>tokenValid?{deviceId}:null,
    checkRateLimit:()=>({allowed:true}),readJsonBody:async()=>({league:'EPL',periodBindingAuthorization:{approved:true}}),
    validateSoccerCapture:()=>captureValid?{ok:true,payload:original}:{ok:false,errors:['REPARSE_REJECTED']},
    saveSoccerReaderSnapshot:async payload=>{calls.push('save');assert.equal(payload.deviceId,deviceId);if(saveFails)throw Error('SAVE_FAILED');return saved;},
    registerSoccerReaderPeriodDevice:async args=>{calls.push('register');assert.equal(args.authenticatedDeviceId,deviceId);
      assert.equal(args.payload.periodBindingAuthorization,undefined);if(registrationFails)throw Error('DB_DOWN');return {status:'REGISTERED_FORWARD_ONLY'};},
    enqueueSoccerReaderAnalysis:async()=>{calls.push('queue');return {};},launchSoccerReaderContinuation:async()=>({}),
  });
  vm.runInContext(source+';globalThis.shippedPOST=POST;',context);
  const request=()=>new Request('https://fixture.invalid/api/soccer/reader',{method:'POST',headers:{'x-device-id':deviceId}});
  assert.equal((await context.shippedPOST(request())).status,401);assert.deepEqual(calls,[]);
  tokenValid=true;captureValid=false;assert.equal((await context.shippedPOST(request())).status,422);assert.deepEqual(calls,[]);
  captureValid=true;saveFails=true;assert.equal((await context.shippedPOST(request())).status,503);assert.deepEqual(calls,['save']);
  calls.length=0;saveFails=false;registrationFails=true;
  const partial=await (await context.shippedPOST(request())).json();assert.equal(partial.ok,true);assert.equal(partial.persisted,true);
  assert.equal(partial.periodContinuation.status,'NOT_VERIFIED');assert.deepEqual(calls,['save','register','queue']);
  calls.length=0;registrationFails=false;
  assert.equal((await (await context.shippedPOST(request())).json()).periodContinuation.status,'REGISTERED_FORWARD_ONLY');
  assert.deepEqual(calls,['save','register','queue']);
  console.log('PASS authenticated device-profile continuation: real immutable SQL evidence, exact source/header/HT scope, DB-clock forward-only registration, no GET DDL, retry dedup, parent rotation, signed source-bound receipts, forged/replayed/cross-league rejection and preserved source times.');
  console.log('PASS shipped Reader POST: token/reparse/durable-save fencing, client authorization ignored, registration outage cannot lose original capture and subsequent request retries.');
} finally {
  await fixture.close();for(const key of envKeys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
}
