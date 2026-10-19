import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent } from 'undici';
import { gzipSync,gunzipSync } from 'node:zlib';
import { normalizeSoccerPersonnelHistory,soccerPersonnelSourceProjection,soccerPersonnelHash } from '../lib/soccer/personnel-history.js';

const root='research/soccer',cache=path.join(root,'sources','personnel');
const proxy=process.env.HTTPS_PROXY||process.env.https_proxy||process.env.ALL_PROXY;
const dispatcher=proxy?new ProxyAgent(proxy):undefined;
const protocol=JSON.parse(fs.readFileSync(`${root}/personnel-protocol.json`)),protocolHash=soccerPersonnelHash(protocol);
const load=file=>JSON.parse(gunzipSync(fs.readFileSync(file))),save=(file,value)=>fs.writeFileSync(file,gzipSync(JSON.stringify(value),{mtime:0}));
const populations=Object.fromEntries(['epl','ucl'].map(league=>[league,load(`${root}/${league}-history.json.gz`).rows]));
const jobs=Object.values(populations).flat(),results=Array(jobs.length),startedAt=new Date().toISOString();
fs.mkdirSync(cache,{recursive:true});let cursor=0,done=0,network=0;
async function acquire(row){
 const file=path.join(cache,`${row.league}-${row.eventId}.json.gz`),slug=row.league==='epl'?'eng.1':'uefa.champions';let record;
 if(fs.existsSync(file)){record=load(file);if(record.ok&&record.source.contentHash!==soccerPersonnelHash(record.data))throw Error('PERSONNEL_RAW_CACHE_HASH_MISMATCH');}
 else{
  const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${row.eventId}`,attempts=[];
  for(let attempt=1;attempt<=protocol.maximumAttempts;attempt++){
   const requestedAt=new Date().toISOString();network++;
   try{const response=await fetch(url,{dispatcher,signal:AbortSignal.timeout(protocol.requestTimeoutSeconds*1000)});if(!response.ok)throw Error(`HTTP_${response.status}`);const data=await response.json(),fetchedAt=new Date().toISOString(),projection=soccerPersonnelSourceProjection(data);
    record={ok:true,data:projection,source:{provider:'ESPN',url,requestedAt,fetchedAt,originalResponseHash:soccerPersonnelHash(data),contentHash:soccerPersonnelHash(projection),contentSemantics:'RETAINED_EXTRACTION_PROJECTION',sourcePublishedAt:null},attempts};attempts.push({attempt,ok:true,requestedAt,fetchedAt});break;
   }catch(error){attempts.push({attempt,ok:false,requestedAt,fetchedAt:new Date().toISOString(),reason:error.name==='TimeoutError'?'PERSONNEL_SOURCE_TIMEOUT':'PERSONNEL_SOURCE_UNAVAILABLE'});record={ok:false,code:attempts.at(-1).reason,source:{provider:'ESPN',url,requestedAt,fetchedAt:new Date().toISOString()},attempts};}
  }
  save(file,record);
 }
 if(!record.ok)return {league:row.league,eventId:row.eventId,status:'MISSING',reason:record.code,source:record.source};
 const normalized=normalizeSoccerPersonnelHistory(row,record.data,record.source);
 return normalized.ok?{league:row.league,eventId:row.eventId,status:'ACCEPTED',row:normalized.row,projection:record}:{league:row.league,eventId:row.eventId,status:'EXCLUDED',reason:normalized.code,source:record.source};
}
async function worker(){while(cursor<jobs.length){const i=cursor++;results[i]=await acquire(jobs[i]);done++;if(done%100===0||done===jobs.length)console.log(JSON.stringify({stage:'PERSONNEL_COLLECT',done,total:jobs.length,accepted:results.filter(x=>x?.status==='ACCEPTED').length,network,elapsedSeconds:Math.round((Date.now()-Date.parse(startedAt))/1000)}));}}
await Promise.all(Array.from({length:Math.min(protocol.maximumConcurrency,4)},worker));
if(dispatcher)await dispatcher.close();
const allSources=results.map(x=>x.source||x.row?.personnel?.source).filter(Boolean);
const report={version:'SOCCER-XI-COLLECTION-v1',protocolHash,startedAt:allSources.map(s=>s.requestedAt).filter(Boolean).sort()[0]||startedAt,completedAt:allSources.map(s=>s.fetchedAt).filter(Boolean).sort().at(-1)||new Date().toISOString(),lastExtractionAt:new Date().toISOString(),total:jobs.length,networkRequestsThisRun:network,pointInTimeAvailabilityVerified:false,leagues:{}};
for(const league of ['epl','ucl']){const all=results.filter(x=>x.league===league),accepted=all.filter(x=>x.status==='ACCEPTED'),excluded=all.filter(x=>x.status!=='ACCEPTED'),reasons={};for(const x of excluded)reasons[x.reason]=(reasons[x.reason]||0)+1;
 const rows=accepted.map(x=>x.row),minutes=rows.filter(x=>x.personnel.minutes.status==='REGULATION_CLOCK_RECONSTRUCTED').length,minuteReasons={};for(const row of rows)if(row.personnel.minutes.status!=='REGULATION_CLOCK_RECONSTRUCTED'){const reason=row.personnel.minutes.reason||'UNKNOWN';minuteReasons[reason]=(minuteReasons[reason]||0)+1;}
 save(`${root}/personnel-${league}-history.json.gz`,{rows,excluded});save(`${root}/personnel-${league}-sources.json.gz`,accepted.map(x=>({eventId:x.eventId,...x.projection})));
 report.leagues[league]={total:all.length,accepted:rows.length,excluded:excluded.length,reasons,minutesAudited:minutes,minutesUnverified:rows.length-minutes,minutesUnverifiedReasons:minuteReasons,inputHash:soccerPersonnelHash(populations[league]),rowsHash:soccerPersonnelHash(rows)};
}
fs.writeFileSync(`${root}/personnel-collection.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
