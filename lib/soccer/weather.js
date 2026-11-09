import { createHash } from 'node:crypto';
import { soccerLeague,soccerDate } from './contracts.js';
import { normalizeSoccerSchedule } from './data.js';
import { soccerSourceDocumentProof } from './source-document-store.js';
import { fetchSoccerVenueGeography,normalizeSoccerVenueGeography,soccerVenueGeographyDocumentProof } from './venue-geography.js';
import { fetchSoccerWeatherJson,soccerWeatherDocumentValid,soccerWeatherCanonicalHash,soccerWeatherAcquiredDocument } from './weather-source.js';

export const SOCCER_WEATHER_VERSION='SOCCER-PREMATCH-HOURLY-WEATHER-v1';
const proofs=new WeakMap(),HOUR=3600000,DAY=24*HOUR;
const fields=['temperature_2m','precipitation','wind_speed_10m','relative_humidity_2m','weather_code'];
const units={time:'unixtime',temperature_2m:'°C',precipitation:'mm',wind_speed_10m:'km/h',relative_humidity_2m:'%',weather_code:'wmo code'};
const instant=value=>typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN;
const id=value=>typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value);
const text=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=160&&!/[<>\u0000-\u001f]/.test(value);
const fail=(reason,game)=>({ok:false,version:SOCCER_WEATHER_VERSION,status:'UNKNOWN',reason,value:null,
  gameId:game?.id??null,league:game?.league??null,date:game?.date??null,startTime:game?.startTime??null,
  modelEffectApplied:false,formalEligible:false,independentlyConfirmed:false});
const observationHash=value=>soccerWeatherCanonicalHash(Object.fromEntries(Object.entries(value).filter(([key])=>!['sourceDocumentArchive','observationArchive','archiveReceipt'].includes(key))));
function scopeValid(game,now){return ['epl','ucl'].includes(game?.league)&&id(game?.sourceId)&&game.id===`soccer:${game.league}:${game.sourceId}`
  &&game.status==='scheduled'&&Number.isFinite(instant(game.startTime))&&instant(game.startTime)>now&&soccerDate(game.startTime)===game.date
  &&['home','away'].every(side=>id(game[side]?.sourceId)&&game[side].id===`soccer:${game.league}:team:${game[side].sourceId}`)
  &&game.home.sourceId!==game.away.sourceId;}
function summaryVenue(game,document,now){
  try {
    const league=soccerLeague(game.league),source=document?.source,u=new URL(source.url);
    if(source.provider!=='ESPN'||u.href!==`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${game.sourceId}`
      ||typeof document.text!=='string'||Buffer.byteLength(document.text)>4*1024*1024
      ||createHash('sha256').update(document.text).digest('hex')!==source.contentHash
      ||![source.fetchedAt,source.availableAt].map(instant).every(value=>Number.isFinite(value)&&value<=now)
      ||instant(source.fetchedAt)>instant(source.availableAt)||instant(source.fetchedAt)>=instant(game.startTime))return null;
    const p=JSON.parse(document.text),competition=p.header?.competitions?.[0];
    if(String(p.header?.id)!==game.sourceId||p.header.competitions.length!==1)return null;
    const board=normalizeSoccerSchedule({leagues:[p.header.league],events:[{...p.header,date:competition.date,status:competition.status}]},game.league,source),observed=board.games?.[0];
    if(!board.ok||observed?.id!==game.id||observed.startTime!==game.startTime||observed.date!==game.date||observed.status!=='scheduled'
      ||['home','away'].some(side=>observed[side].sourceId!==game[side].sourceId))return null;
    const candidates=[p.gameInfo?.venue,competition.venue].filter(Boolean),venue=candidates[0];
    if(!venue||!id(String(venue.id))||![venue.fullName,venue.address?.city,venue.address?.country].every(text)
      ||candidates.some(value=>String(value.id)!==String(venue.id)||value.fullName!==venue.fullName
        ||value.address?.city&&value.address.city!==venue.address.city||value.address?.country&&value.address.country!==venue.address.country))return null;
    return {venueId:String(venue.id),name:venue.fullName,city:venue.address.city,country:venue.address.country};
  }catch{return null;}
}
function forecastUrl(location){const u=new URL('https://api.open-meteo.com/v1/forecast');for(const[key,value]of Object.entries({
  latitude:String(location.latitude),longitude:String(location.longitude),hourly:fields.join(','),timeformat:'unixtime',timezone:'UTC',forecast_days:'16',
  cell_selection:'nearest',wind_speed_unit:'kmh',temperature_unit:'celsius',precipitation_unit:'mm'}))u.searchParams.set(key,value);return u.href;}
function distanceKm(a,b){const rad=x=>x*Math.PI/180,dlat=rad(b.latitude-a.latitude),dlon=rad(b.longitude-a.longitude);
  const h=Math.sin(dlat/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dlon/2)**2;return 6371.0088*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));}

/** Rebuild only provider observations. An hourly value is labelled at its
 * actual UTC valid hour; precipitation is the PRECEDING hour's sum. No weather
 * effect, kickoff interpolation, historical issuance or formal score is invented. */
export function normalizeSoccerWeather({game,documents,now=Date.now()}={}){
  if(!Number.isFinite(now)||!scopeValid(game,now)||!Array.isArray(documents))return fail('WEATHER_PREMATCH_SCOPE_INVALID',game);
  if(instant(game.startTime)>=Math.floor(now/DAY)*DAY+16*DAY)return fail('WEATHER_FORECAST_HORIZON_UNAVAILABLE',game);
  const summaries=documents.filter(document=>document.source?.provider==='ESPN'),forecasts=documents.filter(document=>document.source?.provider==='OPEN_METEO');
  if(summaries.length!==1||forecasts.length!==1)return fail('WEATHER_SOURCE_DOCUMENTS_INCOMPLETE',game);
  const venue=summaryVenue(game,summaries[0],now);if(!venue)return fail('WEATHER_VENUE_SOURCE_UNVERIFIED',game);
  const geographyDocuments=documents.filter(document=>document.source?.provider==='WIKIDATA');
  if(documents.length!==summaries.length+forecasts.length+geographyDocuments.length)return fail('WEATHER_SOURCE_PROVIDER_UNVERIFIED',game);
  const location=normalizeSoccerVenueGeography({venue,documents:geographyDocuments,now});
  if(!location.ok)return fail(location.reason,game);
  const document=forecasts[0];if(!soccerWeatherDocumentValid(document,'OPEN_METEO',now))return fail('WEATHER_FORECAST_DOCUMENT_UNVERIFIED',game);
  const u=new URL(document.source.url),wanted=new URL(forecastUrl(location.value));
  if(u.href!==wanted.href)return fail('WEATHER_FORECAST_LOCATION_OR_QUERY_MISMATCH',game);
  const p=JSON.parse(document.text),hourly=p.hourly,times=hourly?.time;
  if(p.error||p.utc_offset_seconds!==0||!['UTC','GMT'].includes(p.timezone)
    ||typeof p.latitude!=='number'||!Number.isFinite(p.latitude)||p.latitude< -90||p.latitude>90
    ||typeof p.longitude!=='number'||!Number.isFinite(p.longitude)||p.longitude< -180||p.longitude>180
    ||!Array.isArray(times)||times.length<3||times.length>384
    ||times.some((value,index)=>!Number.isSafeInteger(value)||value%3600!==0||index>0&&value-times[index-1]!==3600)
    ||fields.some(field=>!Array.isArray(hourly[field])||hourly[field].length!==times.length)
    ||Object.entries(units).some(([field,unit])=>p.hourly_units?.[field]!==unit))return fail('WEATHER_FORECAST_SCHEMA_OR_UNITS_UNVERIFIED',game);
  // This is a source-location consistency diagnostic, not a model coefficient
  // or a weather-value cap. Returned coordinates are provider grid cells, not
  // asserted to be exact stadium coordinates. Europe's documented forecast
  // grids are far smaller than this conservative 50 km wrong-location guard.
  const gridDistance=distanceKm(location.value,p);
  if(!Number.isFinite(gridDistance)||gridDistance>50)return fail('WEATHER_FORECAST_GRID_LOCATION_MISMATCH',game);
  const kickoff=instant(game.startTime),firstHour=Math.floor(kickoff/HOUR)*3600;
  const indices=[0,1,2,3].map(offset=>times.indexOf(firstHour+offset*3600));
  if(indices.some(index=>index<0))return fail('WEATHER_FORECAST_HORIZON_UNAVAILABLE',game);
  const samples=indices.map(index=>({validAt:new Date(times[index]*1000).toISOString(),temperatureC:hourly.temperature_2m[index],
    precipitationMm:hourly.precipitation[index],precipitationIntervalStart:new Date((times[index]-3600)*1000).toISOString(),
    windSpeedKmh:hourly.wind_speed_10m[index],relativeHumidityPercent:hourly.relative_humidity_2m[index],weatherCode:hourly.weather_code[index]}));
  if(samples.some(value=>![value.temperatureC,value.precipitationMm,value.windSpeedKmh,value.relativeHumidityPercent,value.weatherCode].every(x=>typeof x==='number'&&Number.isFinite(x))
    ||value.precipitationMm<0||value.windSpeedKmh<0||value.relativeHumidityPercent<0||value.relativeHumidityPercent>100
    ||!Number.isInteger(value.weatherCode)||value.weatherCode<0||value.weatherCode>99))return fail('WEATHER_FORECAST_VALUES_UNAVAILABLE',game);
  const source={...document.source,sourcePublishedAt:null,sourceUpdatedAt:null,scope:{league:game.league,gameId:game.id,field:'weather'}};
  return {ok:true,version:SOCCER_WEATHER_VERSION,status:'PROVIDER_REPORTED',reason:null,gameId:game.id,league:game.league,date:game.date,startTime:game.startTime,
    phase:'PREMATCH_OBSERVATION',normalizedAt:new Date(now).toISOString(),source,sources:documents.map(d=>structuredClone(d.source)),
    freshness:{basis:'PROVIDER_HTTP_FETCH_NOT_FORECAST_ISSUANCE',ageMs:now-instant(source.fetchedAt),cacheTtlMs:120000,forecastIssuanceKnown:false},
    value:{venue:location.value,forecastIssuedAt:null,forecastIssuedAtStatus:'NOT_PROVIDED_BY_FORECAST_RESPONSE',
      forecastValidFrom:new Date(times[0]*1000).toISOString(),forecastValidThrough:new Date(times.at(-1)*1000).toISOString(),
      requestedLocation:{latitude:location.value.latitude,longitude:location.value.longitude},
      providerGridLocation:{latitude:p.latitude,longitude:p.longitude,distanceFromVenueKm:gridDistance},
      kickoffHourOffsetMinutes:(kickoff-firstHour*1000)/60000,samplePolicy:'FLOOR_UTC_KICKOFF_HOUR_PLUS_THREE_HOURS',hourly:samples,
      temperatureC:samples[0].temperatureC,precipitationMm:samples[0].precipitationMm,windSpeedKmh:samples[0].windSpeedKmh,
      relativeHumidityPercent:samples[0].relativeHumidityPercent,weatherCode:samples[0].weatherCode,validAt:samples[0].validAt},
    attribution:[{provider:'Open-Meteo',url:'https://open-meteo.com/',licence:'CC-BY-4.0'},{provider:'Wikidata',url:'https://www.wikidata.org/',licence:'CC0'}],
    modelEffectApplied:false,formalEligible:false,independentlyConfirmed:false,historicalAvailabilityVerified:false};
}
export function soccerWeatherDocumentProof(observation){
  const proof=proofs.get(observation);if(!proof||proof.binding.observationHash!==observationHash(observation))return null;
  return structuredClone(proof);
}
export async function fetchSoccerWeather(game,{evidence,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=12000}={}){
  if(typeof now!=='function'||!Number.isFinite(now())||!scopeValid(game,now())||!Number.isFinite(timeoutMs)||timeoutMs<=0)return fail('WEATHER_PREMATCH_SCOPE_INVALID',game);
  // The forecast API's public contract provides at most sixteen UTC days.
  if(instant(game.startTime)>=Math.floor(now()/DAY)*DAY+16*DAY)return fail('WEATHER_FORECAST_HORIZON_UNAVAILABLE',game);
  const summary=soccerSourceDocumentProof(evidence);
  if(!summary||summary.binding.gameId!==game.id||summary.binding.league!==game.league)return fail('WEATHER_PRIVATE_VENUE_SOURCE_MISSING',game);
  const summaryDocument={source:structuredClone(evidence.source),text:summary.text,representation:'PARSED_PROVIDER_JSON'};
  const venue=summaryVenue(game,summaryDocument,now());if(!venue)return fail('WEATHER_VENUE_SOURCE_UNVERIFIED',game);
  const deadline=Date.now()+timeoutMs,remaining=()=>Math.max(0,deadline-Date.now());
  const location=await fetchSoccerVenueGeography(venue,{fetchImpl,now,timeoutMs:remaining()});
  if(!location.ok)return fail(location.reason,game);
  const geoProof=soccerVenueGeographyDocumentProof(location);if(!geoProof)return fail('WEATHER_PRIVATE_LOCATION_PROOF_MISSING',game);
  if(remaining()<=0)return fail('WEATHER_SOURCE_TIMEOUT',game);
  const forecast=await fetchSoccerWeatherJson(forecastUrl(location.value),'OPEN_METEO',{fetchImpl,now,timeoutMs:remaining(),ttlMs:120000});
  if(!forecast.ok)return fail(forecast.reason,game);
  if(!soccerWeatherAcquiredDocument(forecast.document))return fail('WEATHER_PRIVATE_FORECAST_PROOF_MISSING',game);
  const documents=[summaryDocument,...geoProof.documents,structuredClone(forecast.document)];
  const result=normalizeSoccerWeather({game,documents,now:now()});
  if(result.ok)proofs.set(result,{documents,binding:{league:game.league,gameId:game.id,date:game.date,startTime:game.startTime,
    phase:'PREMATCH_OBSERVATION',kind:'WEATHER_FORECAST',field:'weather',normalizedAt:result.normalizedAt,observationHash:observationHash(result)}});
  return result;
}
