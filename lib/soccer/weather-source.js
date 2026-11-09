import { createHash } from 'node:crypto';

// Private acquisition identities are separate from JSON hashes. A normalized
// caller-supplied object, copied source metadata, or saved flag cannot recreate
// a successful HTTP fetch in this process.
const acquired = new WeakMap(), stores = new WeakMap();
export const soccerWeatherJsonHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const soccerWeatherCanonicalHash = value => createHash('sha256').update(JSON.stringify(value, (_key,item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item)).digest('hex');
export const SOCCER_WEATHER_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const fail = reason => ({ok:false,reason});
function allowed(url,provider) {
  try { const u=new URL(url);
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash
      &&(provider==='OPEN_METEO'&&u.hostname==='api.open-meteo.com'&&u.pathname==='/v1/forecast'
        ||provider==='WIKIDATA'&&u.hostname==='www.wikidata.org'&&u.pathname==='/w/api.php')
      &&![...u.searchParams.keys()].some(key=>/token|key|secret|password|callback/i.test(key));
  }catch{return false;}
}
export function soccerWeatherDocumentValid(document,provider,now) {
  try { return document?.source?.provider===provider&&allowed(document.source.url,provider)
    &&document.representation==='PARSED_PROVIDER_JSON'&&typeof document.text==='string'
    &&Buffer.byteLength(document.text)>0&&Buffer.byteLength(document.text)<=SOCCER_WEATHER_MAX_DOCUMENT_BYTES
    &&createHash('sha256').update(document.text).digest('hex')===document.source.contentHash
    &&soccerWeatherCanonicalHash(JSON.parse(document.text))===soccerWeatherCanonicalHash(document.data??JSON.parse(document.text))
    &&[document.source.requestedAt,document.source.fetchedAt,document.source.availableAt].map(instant).every(Number.isFinite)
    &&instant(document.source.requestedAt)<=instant(document.source.fetchedAt)
    &&instant(document.source.fetchedAt)<=instant(document.source.availableAt)&&instant(document.source.availableAt)<=now;
  }catch{return false;}
}
export function soccerWeatherAcquiredDocument(document) {
  const signature=acquired.get(document);
  return Boolean(signature&&signature===soccerWeatherCanonicalHash({source:document.source,text:document.text,representation:document.representation}));
}

/** Cached documents keep their original acquisition clock. They are never
 * re-stamped as a newer fetch, and negative results never become empty data. */
export async function fetchSoccerWeatherJson(url,provider,{fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=8000,ttlMs=300000}={}) {
  if(!allowed(url,provider)||typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isFinite(now())
    ||!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isFinite(ttlMs)||ttlMs<0)return fail('WEATHER_SOURCE_REQUEST_INVALID');
  if(!stores.has(fetchImpl))stores.set(fetchImpl,new Map());
  const cache=stores.get(fetchImpl),key=`${provider}:${url}`,old=cache.get(key);
  if(old?.inflight)return old.inflight;
  if(old?.expiresAt>now()&&old.value&&(!old.value.ok||soccerWeatherAcquiredDocument(old.value.document)))return old.value;
  const operation=(async()=>{
    const requestedAt=new Date(now()).toISOString(),controller=new AbortController();let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('WEATHER_SOURCE_TIMEOUT'));},timeoutMs);});
    let result;
    try {
      const response=await Promise.race([fetchImpl(url,{signal:controller.signal,redirect:'manual',cache:'no-store',headers:{Accept:'application/json','User-Agent':'FootballPrematchResearch/1.0 (https://mlb-positive-ev.vercel.app/)'}}),timeout]);
      if(response?.redirected||response?.type==='opaqueredirect'||response?.status>=300&&response.status<400)result=fail('WEATHER_SOURCE_REDIRECT_REJECTED');
      else if(response?.url&&response.url!==new URL(url).href)result=fail('WEATHER_SOURCE_RESPONSE_SCOPE_MISMATCH');
      else if(!response?.ok)result=fail(response?.status===429?'WEATHER_SOURCE_RATE_LIMITED':response?.status===403?'WEATHER_SOURCE_FORBIDDEN':'WEATHER_SOURCE_HTTP_ERROR');
      else {
        let text;
        if(response.body?.getReader){const reader=response.body.getReader(),decoder=new TextDecoder();let size=0;text='';
          while(true){const part=await Promise.race([reader.read(),timeout]);if(part.done)break;size+=part.value.byteLength;if(size>SOCCER_WEATHER_MAX_DOCUMENT_BYTES){await reader.cancel();throw Error('WEATHER_SOURCE_DOCUMENT_BUDGET');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();
        }else text=await Promise.race([response.text(),timeout]);
        if(Buffer.byteLength(text)>SOCCER_WEATHER_MAX_DOCUMENT_BYTES)throw Error('WEATHER_SOURCE_DOCUMENT_BUDGET');
        const data=JSON.parse(text);if(!data||typeof data!=='object')throw Error('WEATHER_SOURCE_SCHEMA_UNVERIFIED');
        // The archive explicitly retains parsed provider JSON, not HTTP bytes.
        const retained=JSON.stringify(data),fetchedAt=new Date(now()).toISOString();
        const document={source:{provider,url,requestedAt,fetchedAt,availableAt:fetchedAt,sourcePublishedAt:null,
          sourceUpdatedAt:null,contentHash:soccerWeatherJsonHash(data),availabilityBasis:'OBSERVED_HTTP_FETCH_ONLY',confidence:'provider_reported',fallbackSource:null},
          text:retained,representation:'PARSED_PROVIDER_JSON'};
        acquired.set(document,soccerWeatherCanonicalHash(document));
        result={ok:true,document};
      }
    }catch(error){result=fail(controller.signal.aborted?'WEATHER_SOURCE_TIMEOUT':/^(?:WEATHER_)/.test(error.message)?error.message:error instanceof SyntaxError?'WEATHER_SOURCE_SCHEMA_UNVERIFIED':'WEATHER_SOURCE_UNAVAILABLE');}
    finally{clearTimeout(timer);}
    cache.set(key,{value:result,expiresAt:now()+(result.ok?ttlMs:Math.min(ttlMs,5000))});
    while(cache.size>128)cache.delete(cache.keys().next().value);
    return result;
  })();
  cache.set(key,{inflight:operation});return operation;
}
