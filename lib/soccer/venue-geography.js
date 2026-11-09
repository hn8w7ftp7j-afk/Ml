import { fetchSoccerWeatherJson,soccerWeatherDocumentValid,soccerWeatherAcquiredDocument,soccerWeatherCanonicalHash } from './weather-source.js';

export const SOCCER_VENUE_GEOGRAPHY_VERSION='SOCCER-WIKIDATA-VENUE-LOCATION-v1';
const proofs=new WeakMap(),id=value=>typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value);
const qid=value=>typeof value==='string'&&/^Q[1-9]\d{0,15}$/.test(value);
const clean=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=160&&!/[<>\u0000-\u001f]/.test(value);
const name=value=>typeof value==='string'?value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/^(?:the|stadio|stadium|estadio|stade) /,''):'';
const names=entity=>[...Object.values(entity?.labels||{}).map(x=>x?.value),...Object.values(entity?.aliases||{}).flatMap(list=>list.map(x=>x?.value))].filter(clean).map(name);
const data=document=>JSON.parse(document.text);
const entityValues=(entity,property)=>[...new Set((entity?.claims?.[property]||[]).filter(x=>x.rank!=='deprecated'&&x.mainsnak?.snaktype==='value').map(x=>x.mainsnak.datavalue?.value?.id).filter(qid))];
const fail=reason=>({ok:false,version:SOCCER_VENUE_GEOGRAPHY_VERSION,status:'UNKNOWN',reason,value:null,modelEffectApplied:false,formalEligible:false});
const eventScope=value=>typeof value==='string'&&/^soccer:(?:epl|ucl):event:[1-9]\d{0,15}:venue$/.test(value);
const venueValid=venue=>(id(venue?.venueId??venue?.id)||(venue?.venueId==null&&venue?.id==null&&eventScope(venue?.scopeKey)))&&[venue?.name,venue?.city,venue?.country].every(clean);
const normalizedVenue=venue=>({venueId:venue.venueId??venue.id??null,...(venue.scopeKey?{scopeKey:venue.scopeKey}:{}),name:venue.name,city:venue.city,country:venue.country});
function api(params){const url=new URL('https://www.wikidata.org/w/api.php');for(const[key,value]of Object.entries(params))url.searchParams.set(key,value);return url.href;}
const searchUrl=venue=>api({action:'wbsearchentities',search:venue.name,language:'en',format:'json',limit:'5'});
const entitiesUrl=(ids,props='labels|aliases|claims')=>api({action:'wbgetentities',ids:[...ids].sort().join('|'),props,languages:'en',format:'json'});
function urlKind(document){const u=new URL(document.source.url);if(u.searchParams.get('format')!=='json'||u.searchParams.get('language')&&u.searchParams.get('language')!=='en')return null;return u.searchParams.get('action');}
function allEntities(documents,now){
  const entities=new Map();
  for(const document of documents){if(!soccerWeatherDocumentValid(document,'WIKIDATA',now))return null;
    if(urlKind(document)!=='wbgetentities')continue;
    const u=new URL(document.source.url),ids=u.searchParams.get('ids')?.split('|')||[];
    if(!ids.length||ids.length>50||ids.some(value=>!qid(value))||new Set(ids).size!==ids.length)return null;
    const payload=data(document);if(!payload.entities||typeof payload.entities!=='object'||Array.isArray(payload.entities)||payload.error)return null;
    for(const [key,value]of Object.entries(payload.entities)){
      if(!ids.includes(key)||value?.id!==key||value.type!=='item'||value.missing!==undefined)return null;
      if(entities.has(key)&&soccerWeatherCanonicalHash(entities.get(key))!==soccerWeatherCanonicalHash(value))return null;
      entities.set(key,value);
    }
    if(ids.some(key=>!payload.entities[key]))return null;
  }
  return entities;
}
function coordinates(entity){
  const values=(entity?.claims?.P625||[]).filter(claim=>claim.rank!=='deprecated'&&claim.mainsnak?.snaktype==='value')
    .map(claim=>claim.mainsnak.datavalue?.value).filter(v=>v?.globe==='http://www.wikidata.org/entity/Q2'
      &&typeof v.latitude==='number'&&Number.isFinite(v.latitude)&&v.latitude>=-90&&v.latitude<=90
      &&typeof v.longitude==='number'&&Number.isFinite(v.longitude)&&v.longitude>=-180&&v.longitude<=180);
  if(!values.length||values.some(value=>value.latitude!==values[0].latitude||value.longitude!==values[0].longitude))return null;
  return {latitude:values[0].latitude,longitude:values[0].longitude};
}
const countryNames={england:'united kingdom',scotland:'united kingdom',wales:'united kingdom','northern ireland':'united kingdom'};
function matchingEntities(venue,search,entities){
  const expected=name(venue.name),city=name(venue.city),country=name(venue.country),countryAlias=countryNames[country]||country;
  return search.filter(result=>qid(result.id)).flatMap(result=>{
    const entity=entities.get(result.id),coordinate=coordinates(entity);
    if(!entity||!coordinate||!names(entity).includes(expected))return [];
    const places=new Set(),countries=new Set(),queue=entityValues(entity,'P276').concat(entityValues(entity,'P131')).map(key=>[key,0]);
    for(const key of entityValues(entity,'P17')){const item=entities.get(key);if(item)names(item).forEach(value=>countries.add(value));}
    const visited=new Set();
    for(let index=0;index<queue.length;index++){
      const [key,depth]=queue[index];if(visited.has(key)||depth>3)continue;visited.add(key);
      const place=entities.get(key);if(!place)continue;names(place).forEach(value=>places.add(value));
      for(const key of entityValues(place,'P17')){const item=entities.get(key);if(item)names(item).forEach(value=>countries.add(value));}
      if(depth<3)for(const next of entityValues(place,'P131'))queue.push([next,depth+1]);
    }
    if(!places.has(city)||!countries.has(countryAlias)&&!countries.has(country))return [];
    return [{entityId:entity.id,...coordinate}];
  });
}

// Stop only when every other exact-name stadium has a directly reported,
// fully loaded country that excludes the target country. Unresolved candidates
// still require the bounded location ancestry walk; the first hit is not enough.
function locationSettled(venue,search,entities){
  const matches=matchingEntities(venue,search,entities);if(matches.length!==1)return matches.length>1;
  const country=name(venue.country),alias=countryNames[country]||country;
  return search.every(result=>{const entity=entities.get(result.id);if(!entity||!coordinates(entity)||!names(entity).includes(name(venue.name))||result.id===matches[0].entityId)return true;
    const ids=entityValues(entity,'P17');if(!ids.length||ids.some(id=>!entities.has(id)))return false;
    const supplied=ids.flatMap(id=>names(entities.get(id)));return !supplied.includes(country)&&!supplied.includes(alias);
  });
}

/** Exact provider venue label/alias, municipality and country are all required.
 * A city centre, fuzzy name score, or a first search hit is never a stadium. */
export function normalizeSoccerVenueGeography({venue,documents,now=Date.now()}={}) {
  if(!venueValid(venue)||!Array.isArray(documents)||!Number.isFinite(now))return fail('VENUE_LOCATION_SCOPE_INVALID');
  venue=normalizedVenue(venue);
  const searches=documents.filter(document=>{try{return urlKind(document)==='wbsearchentities';}catch{return false;}});
  if(searches.length!==1||!soccerWeatherDocumentValid(searches[0],'WIKIDATA',now))return fail('VENUE_SEARCH_DOCUMENT_UNVERIFIED');
  const query=new URL(searches[0].source.url),payload=data(searches[0]);
  if(query.searchParams.get('search')!==venue.name||query.searchParams.get('limit')!=='5'||!Array.isArray(payload.search)||payload.error
    ||payload.search.length>5||payload.search.some(result=>!qid(result?.id)))return fail('VENUE_SEARCH_SCOPE_MISMATCH');
  const entities=allEntities(documents,now);if(!entities)return fail('VENUE_ENTITY_DOCUMENT_UNVERIFIED');
  const matches=matchingEntities(venue,payload.search,entities);
  if(matches.length!==1)return fail(matches.length?'VENUE_LOCATION_AMBIGUOUS':'VENUE_LOCATION_NOT_CONFIRMED');
  const selected=matches[0],entityDocument=documents.find(document=>{try{return data(document).entities?.[selected.entityId];}catch{return false;}});
  const source={...entityDocument.source,scope:{field:'venueGeography',venueId:venue.venueId,...(venue.scopeKey?{scopeKey:venue.scopeKey}:{}),providerEntityId:selected.entityId}};
  return {ok:true,version:SOCCER_VENUE_GEOGRAPHY_VERSION,status:'PROVIDER_REPORTED',reason:null,
    value:{...venue,...selected,provider:'WIKIDATA',coordinateBasis:'VENUE_ENTITY_P625_EARTH',identityBasis:venue.venueId?'EXACT_VENUE_NAME_ALIAS_CITY_COUNTRY':'EVENT_BOUND_EXACT_VENUE_NAME_ALIAS_CITY_COUNTRY'},
    normalizedAt:new Date(now).toISOString(),source,sources:documents.map(document=>document.source),
    freshness:{basis:'PROVIDER_HTTP_FETCH',ageMs:Math.max(...documents.map(document=>now-Date.parse(document.source.fetchedAt))),cacheTtlMs:86400000},
    independentlyConfirmed:false,modelEffectApplied:false,formalEligible:false};
}
export function soccerVenueGeographyDocumentProof(observation){
  const proof=proofs.get(observation);if(!proof||proof.observationHash!==soccerWeatherCanonicalHash(observation)
    ||proof.documents.some(document=>!soccerWeatherAcquiredDocument(document)))return null;
  return {documents:proof.documents.map(document=>structuredClone(document)),binding:structuredClone(proof.binding),reconstructionInputs:{venue:structuredClone(proof.venue),now:Date.parse(observation.normalizedAt)}};
}
export async function fetchSoccerVenueGeography(venue,{fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=8000}={}) {
  if(!venueValid(venue)||typeof now!=='function'||!Number.isFinite(now()))return fail('VENUE_LOCATION_SCOPE_INVALID');
  venue=normalizedVenue(venue);const deadline=Date.now()+timeoutMs,documents=[],read=async url=>{
    const remaining=deadline-Date.now();if(remaining<=0)return {ok:false,reason:'WEATHER_SOURCE_TIMEOUT'};
    const result=await fetchSoccerWeatherJson(url,'WIKIDATA',{fetchImpl,now,timeoutMs:remaining,ttlMs:86400000});
    if(result.ok)documents.push(result.document);return result;
  };
  const search=await read(searchUrl(venue));if(!search.ok)return fail(search.reason);
  let payload;try{payload=data(search.document);}catch{return fail('VENUE_SEARCH_DOCUMENT_UNVERIFIED');}
  if(!Array.isArray(payload.search)||payload.search.length>5||payload.search.some(item=>!qid(item?.id)))return fail('VENUE_SEARCH_DOCUMENT_UNVERIFIED');
  const ids=[...new Set(payload.search.map(value=>value.id))];if(!ids.length)return fail('VENUE_LOCATION_NOT_CONFIRMED');
  const entityResult=await read(entitiesUrl(ids));if(!entityResult.ok)return fail(entityResult.reason);
  let entities=allEntities(documents,now());if(!entities)return fail('VENUE_ENTITY_DOCUMENT_UNVERIFIED');
  let frontier=ids.filter(key=>names(entities.get(key)).includes(name(venue.name))&&coordinates(entities.get(key)));
  for(let depth=0;depth<4&&frontier.length;depth++){
    if(locationSettled(venue,payload.search,entities))break;
    const places=[...new Set(frontier.flatMap(key=>['P276','P131'].flatMap(property=>entityValues(entities.get(key),property))))].filter(key=>!entities.has(key));
    const countries=[...new Set(frontier.flatMap(key=>entityValues(entities.get(key),'P17')))].filter(key=>!entities.has(key)&&!places.includes(key));
    const required=[...places,...countries];if(!required.length)break;if(required.length>50)return fail('VENUE_LOCATION_REFERENCE_BUDGET');
    // Country labels establish the country identity; their unrelated full
    // claim graphs are unnecessary and can exceed a bounded source document.
    const references=await Promise.all([...(places.length?[read(entitiesUrl(places))]:[]),...(countries.length?[read(entitiesUrl(countries,'labels|aliases'))]:[])]);
    const failure=references.find(reference=>!reference.ok);if(failure)return fail(failure.reason);
    entities=allEntities(documents,now());if(!entities)return fail('VENUE_ENTITY_DOCUMENT_UNVERIFIED');frontier=required;
  }
  const result=normalizeSoccerVenueGeography({venue,documents,now:now()});
  if(result.ok&&documents.every(soccerWeatherAcquiredDocument))proofs.set(result,{documents,venue,observationHash:soccerWeatherCanonicalHash(result),
    binding:{kind:'VENUE_GEOGRAPHY',field:'venueGeography',venueId:venue.venueId,...(venue.scopeKey?{scopeKey:venue.scopeKey}:{}),normalizedAt:result.normalizedAt,observationHash:soccerWeatherCanonicalHash(result)}});
  return result;
}
