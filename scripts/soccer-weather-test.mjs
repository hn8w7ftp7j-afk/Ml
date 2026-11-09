import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { soccerWeatherFixture } from './helpers/soccer-weather-fixture.mjs';
import { fetchSoccerWeather,normalizeSoccerWeather,soccerWeatherDocumentProof } from '../lib/soccer/weather.js';
import { fetchSoccerVenueGeography,normalizeSoccerVenueGeography,soccerVenueGeographyDocumentProof } from '../lib/soccer/venue-geography.js';
import { fetchSoccerWeatherJson,soccerWeatherAcquiredDocument } from '../lib/soccer/weather-source.js';
const reseal=(doc,payload)=>{doc.text=JSON.stringify(payload);doc.source.contentHash=createHash('sha256').update(doc.text).digest('hex');return doc;};
for(const league of ['epl','ucl']) {
  const f=soccerWeatherFixture(league),options={evidence:f.evidence,fetchImpl:f.fetchImpl,now:()=>f.now};
  const actual=await fetchSoccerWeather(f.game,options),proof=soccerWeatherDocumentProof(actual);
  assert.equal(actual.ok,true,`${league}: ${actual.reason}`);assert.ok(proof);assert.equal(proof.binding.kind,'WEATHER_FORECAST');
  assert.equal(actual.league,league);assert.equal(actual.source.scope.gameId,f.game.id);assert.equal(actual.source.scope.field,'weather');
  assert.equal(actual.formalEligible,false);assert.equal(actual.modelEffectApplied,false);assert.equal(actual.historicalAvailabilityVerified,false);
  assert.equal(actual.value.forecastIssuedAt,null);assert.equal(actual.source.sourcePublishedAt,null);assert.equal(actual.source.sourceUpdatedAt,null);
  assert.equal(actual.value.hourly.length,4);assert.equal(actual.value.precipitationMm,0);assert.equal(actual.value.kickoffHourOffsetMinutes,new Date(f.game.startTime).getUTCMinutes());
  assert.equal(Date.parse(actual.value.validAt),Math.floor(Date.parse(f.game.startTime)/3600000)*3600000);
  assert.equal(Date.parse(actual.value.hourly[0].precipitationIntervalStart),Date.parse(actual.value.validAt)-3600000);
  assert.equal(soccerWeatherDocumentProof(structuredClone(actual)),null);
  const rebuilt=normalizeSoccerWeather({game:f.game,documents:proof.documents,now:f.now});assert.deepEqual(rebuilt,actual);assert.equal(soccerWeatherDocumentProof(rebuilt),null);
  const requestCount=f.requests.length,later=await fetchSoccerWeather(f.game,{...options,now:()=>f.now+1000});
  assert.equal(later.ok,true);assert.equal(f.requests.length,requestCount);assert.equal(later.source.fetchedAt,actual.source.fetchedAt);
  assert.equal((await fetchSoccerWeather(f.game,{...options,evidence:structuredClone(f.evidence)})).reason,'WEATHER_PRIVATE_VENUE_SOURCE_MISSING');
  assert.equal((await fetchSoccerWeather({...f.game,league:league==='epl'?'ucl':'epl'},options)).ok,false);
  assert.equal((await fetchSoccerWeather({...f.game,date:'2026-01-01'},options)).ok,false);
  assert.equal((await fetchSoccerWeather({...f.game,status:'final'},options)).ok,false);
  assert.equal((await fetchSoccerWeather(f.game,{...options,now:()=>Date.parse(f.game.startTime)})).ok,false);
  const normalize=docs=>normalizeSoccerWeather({game:f.game,documents:docs,now:f.now});
  for(const mutate of [
    d=>{d.hourly.temperature_2m[0]=null;d.hourly.temperature_2m.fill(null);},
    d=>{d.hourly_units.temperature_2m='°F';},
    d=>{d.latitude=-30;d.longitude=-100;},
    d=>{d.hourly.time=d.hourly.time.map(x=>x+17*86400);},
    d=>{d.utc_offset_seconds=3600;},
    d=>{d.hourly.weather_code.fill(999);},
    d=>{d.hourly.wind_speed_10m.pop();}
  ]){const docs=structuredClone(proof.documents),doc=docs.find(x=>x.source.provider==='OPEN_METEO'),p=JSON.parse(doc.text);mutate(p);reseal(doc,p);assert.equal(normalize(docs).ok,false);}
  const stale=structuredClone(proof.documents);stale.find(x=>x.source.provider==='OPEN_METEO').source.availableAt=new Date(f.now+1).toISOString();assert.equal(normalize(stale).ok,false);
  const query=structuredClone(proof.documents);query.find(x=>x.source.provider==='OPEN_METEO').source.url+='&apikey=secret';assert.equal(normalize(query).ok,false);
  const wrongVenue=structuredClone(proof.documents),summary=wrongVenue.find(x=>x.source.provider==='ESPN'),payload=JSON.parse(summary.text);payload.header.competitions[0].competitors[0].team.id='999';reseal(summary,payload);assert.equal(normalize(wrongVenue).ok,false);
  actual.value.temperatureC=999;assert.equal(soccerWeatherDocumentProof(actual),null);
  const horizon=await fetchSoccerWeather(f.game,{...options,now:()=>f.now-17*86400000});assert.equal(horizon.reason,'WEATHER_FORECAST_HORIZON_UNAVAILABLE');
}
{
  const f=soccerWeatherFixture();f.entities.Q4.claims.P999=[{irrelevantProviderClaim:'x'.repeat(2200000)}];
  const opts={fetchImpl:f.fetchImpl,now:()=>f.now},geo=await fetchSoccerVenueGeography(f.venue,opts),proof=soccerVenueGeographyDocumentProof(geo);
  assert.ok(f.requests.some(url=>new URL(url).searchParams.get('props')==='labels|aliases'),'country source uses exact small provider projection');
  assert.equal(geo.ok,true);assert.ok(proof);assert.equal(geo.value.coordinateBasis,'VENUE_ENTITY_P625_EARTH');
  assert.equal(soccerVenueGeographyDocumentProof(structuredClone(geo)),null);
  assert.deepEqual(normalizeSoccerVenueGeography({venue:f.venue,documents:proof.documents,now:f.now}),geo);
  assert.equal(soccerVenueGeographyDocumentProof(normalizeSoccerVenueGeography({venue:f.venue,documents:proof.documents,now:f.now})),null);
  for(const venue of [{...f.venue,city:'Wrong City'},{...f.venue,country:'Wrong Country'},{...f.venue,name:'Wrong Stadium'}])assert.equal(normalizeSoccerVenueGeography({venue,documents:proof.documents,now:f.now}).ok,false);
  const noEarth=structuredClone(proof.documents),doc=noEarth.find(x=>JSON.parse(x.text).entities?.Q1),p=JSON.parse(doc.text);p.entities.Q1.claims.P625[0].mainsnak.datavalue.value.globe='http://www.wikidata.org/entity/Q111';reseal(doc,p);
  assert.equal(normalizeSoccerVenueGeography({venue:f.venue,documents:noEarth,now:f.now}).ok,false);
  const duplicate=structuredClone(proof.documents),search=duplicate.find(x=>JSON.parse(x.text).search),s=JSON.parse(search.text);s.search.push({...s.search[0]});reseal(search,s);
  assert.equal(normalizeSoccerVenueGeography({venue:f.venue,documents:duplicate,now:f.now}).reason,'VENUE_LOCATION_AMBIGUOUS');
  const eventVenue={...f.venue,venueId:null,scopeKey:`soccer:epl:event:${f.game.sourceId}:venue`},eventGeo=await fetchSoccerVenueGeography(eventVenue,opts);
  assert.equal(eventGeo.ok,true);assert.equal(eventGeo.value.venueId,null);assert.equal(eventGeo.value.scopeKey,eventVenue.scopeKey);
  assert.equal(eventGeo.value.identityBasis,'EVENT_BOUND_EXACT_VENUE_NAME_ALIAS_CITY_COUNTRY');assert.ok(soccerVenueGeographyDocumentProof(eventGeo));
  assert.equal((await fetchSoccerVenueGeography({...eventVenue,scopeKey:'soccer:mlb:event:1:venue'},opts)).ok,false);
  geo.value.latitude=0;assert.equal(soccerVenueGeographyDocumentProof(geo),null);
}
{
  const f=soccerWeatherFixture(),opts={evidence:f.evidence,now:()=>f.now};
  assert.equal((await fetchSoccerWeather(f.game,{...opts,fetchImpl:async()=>new Response('{}',{status:403})})).reason,'WEATHER_SOURCE_FORBIDDEN');
  assert.equal((await fetchSoccerWeather(f.game,{...opts,timeoutMs:15,fetchImpl:()=>new Promise(()=>{})})).reason,'WEATHER_SOURCE_TIMEOUT');
  assert.equal((await fetchSoccerWeather(f.game,{...opts,fetchImpl:async()=>new Response('',{status:302})})).reason,'WEATHER_SOURCE_REDIRECT_REJECTED');
  assert.equal((await fetchSoccerWeather(f.game,{...opts,fetchImpl:async()=>new Response('invalid-json')})).reason,'WEATHER_SOURCE_SCHEMA_UNVERIFIED');
  let count=0;const fetchImpl=async()=>{count++;return new Response('{}',{status:429});};
  const url='https://www.wikidata.org/w/api.php?action=wbsearchentities&search=test&language=en&format=json&limit=5';
  await fetchSoccerWeatherJson(url,'WIKIDATA',{fetchImpl,now:()=>f.now});await fetchSoccerWeatherJson(url,'WIKIDATA',{fetchImpl,now:()=>f.now+1});assert.equal(count,1);
  assert.equal((await fetchSoccerWeatherJson('https://api.open-meteo.com/v1/forecast?apikey=private','OPEN_METEO',{fetchImpl})).ok,false);
  const acquired=await fetchSoccerWeatherJson(url,'WIKIDATA',{fetchImpl:async()=>new Response('{}'),now:()=>f.now});assert.equal(soccerWeatherAcquiredDocument(acquired.document),true);assert.equal(soccerWeatherAcquiredDocument(structuredClone(acquired.document)),false);
  acquired.document.source.fetchedAt=new Date(f.now-1).toISOString();assert.equal(soccerWeatherAcquiredDocument(acquired.document),false);
}
console.log('PASS soccer weather: EPL/UCL UTC forecasts, source/identity/venue isolation, private provenance, raw rebuild, units/missing/horizon, cache, timeout/403/redirect, no invented publication or model effect');
