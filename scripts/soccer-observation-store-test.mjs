import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {soccerSqlFixture} from './helpers/soccer-sql-fixture.mjs';
import {soccerWeatherFixture} from './helpers/soccer-weather-fixture.mjs';
import {normalizeSoccerSchedule} from '../lib/soccer/data.js';
import {normalizeSoccerPrematch} from '../lib/soccer/prematch.js';
import {fetchSoccerWeather,normalizeSoccerWeather,soccerWeatherDocumentProof} from '../lib/soccer/weather.js';
import {soccerPersonnelInputsFixture} from './helpers/soccer-personnel-inputs-fixture.mjs';
import {attachSoccerPersonnelInputs,soccerPersonnelInputSourceProjection} from '../lib/soccer/personnel-inputs.js';
import {fetchSoccerWorkload} from '../lib/soccer/workload.js';
import {fetchSoccerMatchConditionsEvidence} from '../lib/soccer/match-conditions-evidence.js';
import {buildSoccerAnalysis} from '../lib/soccer/analysis.js';

// Real PostgreSQL semantics with an isolated local transport. Provider responses
// are synthetic fixtures; these checks make no accuracy or historical PIT claim.
const fixture=await soccerSqlFixture(),{db}=fixture;
const keys=['DATABASE_URL','DATABASE_V2_URL'],old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
process.env.DATABASE_URL='postgres://fixture.invalid/soccer-observation';delete process.env.DATABASE_V2_URL;
const iso=value=>new Date(value).toISOString(),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function weatherFixture(league='epl',{kickoff=Date.now()+3600000,extra}={}) {
  const f=soccerWeatherFixture(league),now=Date.now();
  f.summary.header.date=iso(kickoff);f.summary.header.competitions[0].date=iso(kickoff);
  if(extra!==undefined)f.summary.archiveBorderFixture=extra;
  const source={...f.source,requestedAt:iso(now-2000),fetchedAt:iso(now-1000),availableAt:iso(now-1000),contentHash:hash(f.summary)};
  const c=f.summary.header.competitions[0];
  const game=normalizeSoccerSchedule({leagues:[f.summary.header.league],events:[{...f.summary.header,date:c.date,status:c.status}]},league,source).games[0];
  const evidence=normalizeSoccerPrematch(f.summary,game,source,now);
  f.forecast.hourly.time=f.forecast.hourly.time.map((_,i)=>Math.floor(now/86400000)*86400+i*3600);
  assert.equal(evidence.ok,true);
  return {...f,game,evidence,source,now};
}
try {
  const store=await import('../lib/soccer/observation-store.js');
  const sourceStore=await import('../lib/soccer/source-document-store.js');
  const journal=await import('../lib/soccer/journal.js');
  for(const league of ['epl','ucl']) {
    const f=weatherFixture(league,{extra:{quoted:'"quoted" \\ slash\nnew line',unicode:'足球\u2028天氣',nested:{z:1,a:2}}});
    f.evidence.sourceDocumentArchive=await sourceStore.archiveSoccerSourceDocument(f.evidence);
    assert.equal(f.evidence.sourceDocumentArchive.persisted,true);
    const weather=await fetchSoccerWeather(f.game,{evidence:f.evidence,fetchImpl:f.fetchImpl});
    assert.equal(weather.ok,true,weather.reason);f.evidence.weather=weather;
    const originalProof=soccerWeatherDocumentProof(weather);assert.ok(originalProof);
    assert.equal(soccerWeatherDocumentProof(structuredClone(weather)),null);
    const normalized=normalizeSoccerWeather({game:f.game,documents:originalProof.documents,now:Date.parse(weather.normalizedAt)});
    assert.deepEqual(normalized,weather);assert.equal(soccerWeatherDocumentProof(normalized),null);
    assert.equal((await store.archiveSoccerObservation(normalized,{game:f.game,field:'weather'})).persisted,false);
    const receipt=await store.archiveSoccerObservation(weather,{game:f.game,field:'weather'});
    assert.equal(receipt.persisted,true);assert.equal(receipt.prematchReceipt,true);assert.equal(receipt.documentCount,originalProof.documents.length);
    assert.equal(receipt.sourcePublishedAt,null);assert.equal(receipt.modelEffectApplied,false);
    assert.equal(receipt.historicalAvailabilityVerified,false);assert.equal(receipt.independentlyConfirmed,false);
    assert.equal(receipt.formalEligible,false);assert.equal(receipt.executable,false);
    assert.equal(Object.hasOwn(receipt,'document_text'),false);
    assert.ok(Date.parse(receipt.recordedAt)>=f.now,'real DB receipt never backdates to source fetch');
    weather.observationArchive=receipt;
    const now=Math.max(Date.now(),Date.parse(receipt.recordedAtUpperBound));
    assert.ok(store.soccerCurrentObservationAvailability(weather.source,{evidence:f.evidence,field:'weather',now}));
    assert.equal(store.soccerCurrentObservationAvailability(weather.source,{evidence:f.evidence,field:'weather',now:Date.parse(receipt.recordedAtUpperBound)-1}),null);
    assert.equal(store.soccerCurrentObservationAvailability(weather.source,{evidence:f.evidence,field:'weather',now:Date.parse(f.game.startTime)}),null);
    assert.equal(store.soccerCurrentObservationAvailability(weather.source,{evidence:f.evidence,field:'weather',now:Date.parse(weather.source.fetchedAt)+180000}),null);
    assert.deepEqual(await store.archiveSoccerObservation(weather,{game:f.game,field:'weather'}),receipt,'retry preserves first receipt clock');
    const loaded=await store.loadSoccerObservation(receipt.receiptId);
    assert.deepEqual(loaded.observation,normalized);assert.equal(loaded.documents.length,originalProof.documents.length);
    assert.ok(loaded.documents.every((doc,index)=>doc.text===originalProof.documents[index].text),'JSONB key ordering cannot change retained source bytes');
    const saved=JSON.parse(JSON.stringify(f.evidence));
    assert.equal(store.soccerCurrentObservationAvailability(saved.weather.source,{evidence:saved,field:'weather',now}),null,'serialized VERIFIED receipts confer no authority');
    assert.equal(await store.restoreSoccerObservationAvailability(saved,{field:'weather',now}),true,'restore replays original documents before minting process-local capability');
    assert.ok(store.soccerCurrentObservationAvailability(saved.weather.source,{evidence:saved,field:'weather',now}));
    assert.equal(await sourceStore.restoreSoccerCurrentSourceAvailability(saved,now),true,'external weather preserves original summary restoration');
    for(const mutate of [
      value=>{value.weather.value.temperatureC+=1;},
      value=>{value.weather.source.scope.field='travel';},
      value=>{value.weather.source.url='https://127.0.0.1/private';},
      value=>{value.weather.source.contentHash='0'.repeat(64);},
      value=>{value.game={...value.game,league:league==='epl'?'ucl':'epl'};},
      value=>{value.game={...value.game,sourceId:'999',id:`soccer:${league}:999`};},
      value=>{value.game={...value.game,startTime:iso(Date.parse(value.game.startTime)+1)};},
    ]) {
      const bad=structuredClone(f.evidence);mutate(bad);
      assert.equal(await store.restoreSoccerObservationAvailability(bad,{field:'weather',now}),false);
      assert.equal((await store.archiveSoccerObservation(bad.weather,{game:bad.game,field:'weather'})).persisted,false);
    }
    for(const change of [
      row=>{row.observation.value.temperatureC+=1;},
      row=>{row.binding.documents[0].source.url='https://example.invalid/source';},
      row=>{row.reconstruction_inputs={forged:true};},
    ]) {
      const query=async(sql,params)=>{const rows=await journal.soccerJournalQuery(sql,params);if(sql.includes('FROM sports_soccer_observations_v1')){change(rows[0]);}return rows;};
      await assert.rejects(()=>store.loadSoccerObservation(receipt.receiptId,{query}),/READBACK_INVALID/);
    }
    const custom=await fetchSoccerWeather(f.game,{evidence:f.evidence,fetchImpl:f.fetchImpl});
    const customReceipt=await store.archiveSoccerObservation(custom,{game:f.game,field:'weather',
      query:(...args)=>journal.soccerJournalQuery(...args),transaction:(...args)=>journal.soccerJournalTransaction(...args)});
    assert.equal(customReceipt.persisted,true);custom.observationArchive=customReceipt;
    const customEvidence={...f.evidence,weather:custom};
    assert.equal(store.soccerCurrentObservationAvailability(custom.source,{evidence:customEvidence,field:'weather',now:Date.now()+1}),null,'custom transport never grants current authority');
    const untouched=structuredClone(customEvidence);
    assert.equal(await store.restoreSoccerObservationAvailability(untouched,{field:'weather',now:Date.now()+1,query:(...args)=>journal.soccerJournalQuery(...args)}),false);
    const futureReceiptQuery=async(sql,params)=>{const rows=await journal.soccerJournalQuery(sql,params);if(sql.includes('FROM sports_soccer_observations_v1'))rows[0].source_available_by_receipt=false;return rows;};
    const quarantined=await store.loadSoccerObservation(receipt.receiptId,{query:futureReceiptQuery});
    assert.equal(quarantined.receipt.prematchReceipt,false);assert.match(quarantined.receipt.timingStatus,/QUARANTINED/);
    assert.equal(await store.restoreSoccerObservationAvailability(structuredClone(f.evidence),{field:'weather',now,query:futureReceiptQuery}),false);
    const afterKickoff=async(sql,params)=>{const rows=await journal.soccerJournalQuery(sql,params);if(sql.includes('FROM sports_soccer_observations_v1'))rows[0].receipt_before_kickoff=false;return rows;};
    assert.equal((await store.loadSoccerObservation(receipt.receiptId,{query:afterKickoff})).receipt.timingStatus,'AFTER_KICKOFF_DATABASE_RECEIPT');
    weather.value.temperatureC+=1;
    assert.equal(store.soccerCurrentObservationAvailability(weather.source,{evidence:f.evidence,field:'weather',now}),null);
    assert.equal((await store.archiveSoccerObservation(weather,{game:f.game,field:'weather'})).persisted,false);
  }
  for(const league of ['epl','ucl'])for(const partial of [false,true]) {
    const f=soccerPersonnelInputsFixture(league);
    f.evidence.sourceDocumentArchive=await sourceStore.archiveSoccerSourceDocument(f.evidence);
    assert.equal(f.evidence.sourceDocumentArchive.persisted,true);
    const original=structuredClone(f.evidence.teams);
    if(partial)f.evidence.workload.teams.away.playerWorkload={ok:false,reason:'SYNTHETIC_SOURCE_UNAVAILABLE'};
    attachSoccerPersonnelInputs(f.evidence,{now:f.now});
    assert.equal(f.evidence.teams.home.minutes.status,'RESEARCH_FORECAST_AVAILABLE');
    if(partial)assert.deepEqual(f.evidence.teams.away.minutes,original.away.minutes,'unavailable side keeps original raw minutes');
    for(const side of partial?['home']:['home','away']) {
      const field=`teams.${side}.minutes`,minutes=f.evidence.teams[side].minutes;
      const receipt=await store.archiveSoccerObservation(minutes,{evidence:f.evidence,game:f.game,field});
      assert.equal(receipt.persisted,true,`${league} ${field}: ${receipt.reason}`);assert.equal(receipt.kind,'PERSONNEL_RESEARCH');
      minutes.observationArchive=receipt;
      assert.equal(store.soccerCurrentObservationAvailability(minutes.source,{evidence:f.evidence,field,now:Date.now()+1}),null,'derived model output does not gain a raw-source publication capability');
    }
    assert.ok(soccerPersonnelInputSourceProjection(f.evidence),'receipt metadata cannot break actual producer proof');
    const saved=JSON.parse(JSON.stringify(f.evidence)),now=Date.now()+1;
    assert.equal(soccerPersonnelInputSourceProjection(saved),null);
    const projection=await store.restoreSoccerPersonnelObservationProjection(saved,{now});
    assert.ok(projection,`${league} partial=${partial}: immutable raw/model replay restores original summary projection`);
    assert.deepEqual(projection.minutes.home,original.home.minutes);assert.deepEqual(projection.minutes.away,original.away.minutes);
    assert.equal(await sourceStore.restoreSoccerCurrentSourceAvailability(saved,now),true,'original summary capability restores independently of derived minutes');
    for(const mutate of [
      value=>{value.teams.home.minutes.players[0].expectedMinutes+=1;},
      value=>{delete value.teams.home.minutes.observationArchive;},
      value=>{value.teams.home.minutes.observationArchive.receiptId='0'.repeat(64);},
    ]) {
      const bad=structuredClone(f.evidence);mutate(bad);const field='teams.home.minutes';
      assert.equal(await sourceStore.restoreSoccerCurrentSourceAvailability(bad,now),true,'a failed derived minute field cannot erase independently proven summary fields');
      assert.ok(sourceStore.soccerCurrentSourceAvailability(bad.source,{evidence:bad,game:f.game,now}));
      assert.equal(await store.restoreSoccerPersonnelObservationProjection(bad,{now}),null,'changed or unarchived minutes cannot recover an exact derived projection proof');
      assert.equal(await store.restoreSoccerObservationAvailability(bad,{field,now}),false);
      assert.equal(store.soccerCurrentObservationAvailability(bad.teams.home.minutes.source,{evidence:bad,field,now}),null);
      assert.equal(sourceStore.soccerCurrentSourceAvailability(bad.teams.home.minutes.source,{evidence:bad,game:f.game,field,now}),null);
      const analysis=buildSoccerAnalysis({evidence:bad,now});
      assert.equal(analysis.formalScoringEnabled,false);assert.equal(analysis.executable,false,'restoring the original summary never promotes failed derived inputs into formal scoring');
    }
    for(const mutate of [
      value=>{value.teams.home.lineup.starters[0].name+=' forged';},
      value=>{value.sourceDocumentArchive.receiptId='0'.repeat(64);},
      value=>{value.source.contentHash='0'.repeat(64);},
      value=>{value.teams.home.sourceId='999';},
      value=>{value.game.home.sourceId='999';value.game.home.id=`soccer:${league}:team:999`;},
    ]) {
      const bad=structuredClone(f.evidence);mutate(bad);
      assert.equal(await sourceStore.restoreSoccerCurrentSourceAvailability(bad,now),false,'original lineup/source/team identity tampering still prevents summary restoration');
    }
    if(partial) {
      const bad=structuredClone(f.evidence);bad.teams.away.minutes={status:'VERIFIED',value:90};
      assert.equal(await store.restoreSoccerPersonnelObservationProjection(bad,{now}),null,'unarchived side must still match original summary exactly');
      assert.equal((await store.archiveSoccerObservation(f.evidence.teams.away.minutes,{game:f.game,evidence:f.evidence,field:'teams.away.minutes'})).persisted,false);
    }
  }
  for(const league of ['epl','ucl']) {
    const f=weatherFixture(league);
    f.evidence.sourceDocumentArchive=await sourceStore.archiveSoccerSourceDocument(f.evidence);
    const workload=await fetchSoccerWorkload(f.game,{includePlayerMinutes:false,now:Date.now,fetchImpl:async url=>{
      const u=new URL(url),teamId=u.pathname.match(/teams\/(\d+)/)[1],year=Number(u.searchParams.get('season'));
      return {ok:true,url,json:async()=>({status:'success',team:{id:teamId},requestedSeason:{year},events:[]})};
    }});
    const conditions=await fetchSoccerMatchConditionsEvidence({game:f.game,evidence:f.evidence,workload},{now:Date.now,fetchVenueGeography:async()=>({ok:false})});
    for(const field of league==='ucl'?['travel','uclContext']:['travel']) {
      f.evidence[field]=conditions[field];
      const receipt=await store.archiveSoccerObservation(conditions[field],{game:f.game,evidence:f.evidence,field});
      assert.equal(receipt.persisted,true,`${league} ${field}: ${receipt.reason}`);
      conditions[field].observationArchive=receipt;
      assert.deepEqual(await store.archiveSoccerObservation(conditions[field],{game:f.game,evidence:f.evidence,field}),receipt,'condition retry preserves first receipt after metadata attachment');
      const saved=JSON.parse(JSON.stringify(f.evidence)),now=Date.now()+1;
      assert.equal(await store.restoreSoccerObservationAvailability(saved,{field,now}),true);
      assert.equal(await sourceStore.restoreSoccerCurrentSourceAvailability(saved,now),true,'same-summary travel/UCL source needs separate immutable field replay');
    }
  }
  {
    const f=weatherFixture('ucl',{kickoff:Date.now()-60000});
    assert.equal(f.evidence.phase,'POSTSTART_AUDIT');
    const conditions=await fetchSoccerMatchConditionsEvidence({game:f.game,evidence:f.evidence},{now:Date.now,
      fetchJson:async()=>({ok:true,source:f.source,data:f.summary}),fetchVenueGeography:async()=>({ok:false})});
    assert.equal(conditions.uclContext.phase,'POSTSTART_AUDIT');
    const receipt=await store.archiveSoccerObservation(conditions.uclContext,{game:f.game,field:'uclContext'});
    assert.equal(receipt.persisted,true);assert.equal(receipt.prematchReceipt,false);
    assert.equal(receipt.timingStatus,'AFTER_KICKOFF_DATABASE_RECEIPT','actual DB receipt after kickoff is archived for audit, never backdated');
    conditions.uclContext.observationArchive=receipt;f.evidence.uclContext=conditions.uclContext;
    assert.equal(store.soccerCurrentObservationAvailability(conditions.uclContext.source,{evidence:f.evidence,field:'uclContext',now:Date.now()+1}),null);
    assert.equal(await store.restoreSoccerObservationAvailability(JSON.parse(JSON.stringify(f.evidence)),{field:'uclContext',now:Date.now()+1}),false);
  }
  for(const table of ['observation_documents','observations']) {
    await assert.rejects(()=>db.query(`UPDATE sports_soccer_${table}_v1 SET recorded_at=recorded_at`),/SOCCER_IMMUTABLE_HISTORY/);
    await assert.rejects(()=>db.query(`DELETE FROM sports_soccer_${table}_v1`),/SOCCER_IMMUTABLE_HISTORY/);
  }
  await assert.rejects(()=>db.query(`INSERT INTO sports_soccer_observation_documents_v1(content_hash,document_text,document_bytes,representation)
    VALUES($1,$2,$3,'PARSED_PROVIDER_JSON')`,['f'.repeat(64),'x'.repeat(store.SOCCER_OBSERVATION_DOCUMENT_MAX_BYTES+1),store.SOCCER_OBSERVATION_DOCUMENT_MAX_BYTES+1]),/check constraint/);
  console.log('PASS external observation DB archive: weather/travel/UCL/personnel raw+model replay, partial-side source projection, JSON-saved summary restoration, actual private producer proof, immutable original bytes, EPL/UCL identity/field isolation, DB clock, bounded payloads, custom-transport denial, tamper rejection and no formal/model-effect promotion');
}finally{
  for(const key of keys)if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];
  await fixture.close();
}
