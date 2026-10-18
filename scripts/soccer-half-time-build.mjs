import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fetchSoccerJson } from '../lib/soccer/data.js';
import { enrichSoccerHistoryHalfTime } from '../lib/soccer/history.js';

const root='research/soccer', cache=path.join(root,'sources','half-time');
const protocol=JSON.parse(fs.readFileSync(path.join(root,'half-time-protocol.json'),'utf8'));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const save=(file,data)=>fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');
const saveGz=(file,data)=>fs.writeFileSync(file,gzipSync(JSON.stringify(data),{mtime:0}));
const loadGz=file=>JSON.parse(gunzipSync(fs.readFileSync(file)).toString());
fs.mkdirSync(cache,{recursive:true});
const protocolHash=hash(protocol), startedAt=new Date().toISOString();
const previousCollection=fs.existsSync(path.join(root,'half-time-collection.json'))?JSON.parse(fs.readFileSync(path.join(root,'half-time-collection.json'),'utf8')):null;
const populations=Object.fromEntries(['epl','ucl'].map(league=>[league,loadGz(path.join(root,`${league}-history.json.gz`)).rows]));
const jobs=Object.values(populations).flat(), results=Array(jobs.length); let cursor=0,done=0,network=0,networkMs=0;
const slugs={epl:'eng.1',ucl:'uefa.champions'};
async function acquire(row){
 const file=path.join(cache,`${row.league}-${row.eventId}.json.gz`);
 let record;
 if(fs.existsSync(file)) {record=loadGz(file);if(record.ok&&record.source?.contentHash!==hash(record.data))throw Error('HALF_TIME_RAW_CACHE_HASH_MISMATCH');}
 else {
  const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${slugs[row.league]}/summary?event=${row.eventId}`;
  const attempts=[];
  for(let attempt=1;attempt<=protocol.maximumAttempts;attempt++){
   const before=Date.now();record=await fetchSoccerJson(url,{timeoutMs:protocol.requestTimeoutMs,ttlMs:0});network++;networkMs+=Date.now()-before;
   attempts.push({attempt,ok:record.ok,code:record.code||null,upstreamStatus:record.upstreamStatus||null,requestedAt:record.source?.requestedAt,fetchedAt:record.source?.fetchedAt});
   if(record.ok||!['SOCCER_SOURCE_TIMEOUT','SOCCER_SOURCE_UNAVAILABLE','SOCCER_SOURCE_HTTP_ERROR','SOCCER_SOURCE_RATE_LIMITED'].includes(record.code))break;
   if(attempt<protocol.maximumAttempts)await new Promise(resolve=>setTimeout(resolve,1000));
  }
  record={...record,attempts,protocolHash};saveGz(file,record);
 }
 if(!record.ok)return{league:row.league,eventId:row.eventId,status:'MISSING',reason:record.code,source:record.source,attempts:record.attempts};
 const enriched=enrichSoccerHistoryHalfTime(row,record.data,record.source);
 return enriched.ok?{league:row.league,eventId:row.eventId,status:'ACCEPTED',row:enriched.row}:{league:row.league,eventId:row.eventId,status:'EXCLUDED',reason:enriched.code,source:record.source};
}
async function worker(){while(cursor<jobs.length){const i=cursor++;results[i]=await acquire(jobs[i]);done++;if(done%50===0||done===jobs.length)console.log(JSON.stringify({stage:'COLLECT',done,total:jobs.length,accepted:results.filter(x=>x?.status==='ACCEPTED').length,networkRequests:network,averageRequestMs:network?Math.round(networkMs/network):null,elapsedSeconds:Math.round((Date.now()-Date.parse(startedAt))/1000)}));}}
await Promise.all(Array.from({length:Math.min(4,protocol.maximumConcurrency)},worker));
const collection={version:'SOCCER-HT-COLLECTION-v1',startedAt:network?startedAt:(previousCollection?.startedAt||startedAt),completedAt:network?new Date().toISOString():(previousCollection?.completedAt||new Date().toISOString()),protocolHash,total:jobs.length,networkRequests:network||previousCollection?.networkRequests||0,averageRequestMs:network?networkMs/network:(previousCollection?.averageRequestMs??null),cacheReplay:network===0?{replayedAt:new Date().toISOString(),rows:jobs.length,initialCollectionProtocolHash:previousCollection?.cacheReplay?.initialCollectionProtocolHash||previousCollection?.protocolHash||null}:null,rawCache:'research/soccer/sources/half-time (ignored raw public responses)',leagues:{}};
for(const league of ['epl','ucl']){
 const entries=results.filter(x=>x.league===league),rows=entries.filter(x=>x.status==='ACCEPTED').map(x=>x.row),excluded=entries.filter(x=>x.status!=='ACCEPTED');
 const reasons=Object.fromEntries([...new Set(excluded.map(x=>x.reason))].map(reason=>[reason,excluded.filter(x=>x.reason===reason).length]));
 const corroborationCases=rows.filter(r=>['704467','720330'].includes(r.eventId)).map(r=>({eventId:r.eventId,league:r.league,fullTime:{home:r.homeGoals,away:r.awayGoals},halfTime:r.halfTime,interpretation:'Two ordered period totals sum to FT and match period-specific scoring events; not cumulative scores'}));
 collection.leagues[league]={sample:entries.length,used:rows.length,excluded:excluded.length,coverage:entries.length?rows.length/entries.length:0,reasons,corroborationCases,rowsHash:hash(rows),sourcesHash:hash(entries.map(x=>({eventId:x.eventId,source:x.row?.halfTime?.source||x.source,status:x.status})))};
 saveGz(path.join(root,`half-time-${league}-history.json.gz`),{rows,excluded});
}
save(path.join(root,'half-time-collection.json'),collection);
const examples=['epl-704467','ucl-720330'].map(name=>{
 const raw=loadGz(path.join(cache,`${name}.json.gz`));
 if(!raw.ok)throw Error('HALF_TIME_CORROBORATION_CASE_MISSING');
 const competition=raw.data.header.competitions[0],projected={header:{id:raw.data.header.id,date:raw.data.header.date,competitions:[{date:competition.date,status:competition.status,competitors:competition.competitors.map(t=>({homeAway:t.homeAway,score:t.score,team:{id:t.team.id},linescores:t.linescores}))}]},format:raw.data.format,keyEvents:raw.data.keyEvents.map(e=>({id:e.id,type:e.type,period:e.period,clock:e.clock,scoringPlay:e.scoringPlay,team:e.team,text:e.text}))};
 return{name,source:raw.source,projectionHash:hash(projected),payload:projected};
});
save(path.join(root,'half-time-extraction-examples.json'),{version:'SOCCER-HT-EXTRACTION-EXAMPLES-v1',meaning:'Selected fields projected from actual raw responses. source.contentHash hashes the full raw parsed response; projectionHash hashes only this projection. Raw originals retained separately.',examples});
if(process.argv.includes('--collect-only'))process.exit(0);
const {fitScoreModel,predictScoreModel}=await import('../lib/soccer/score-model.js');
const {fitHalfTimeModel,evaluateHalfTimeModel}=await import('../lib/soccer/half-time-model.js');
const baseline=JSON.parse(fs.readFileSync(path.join(root,'baseline.json'),'utf8'));
const before=(rows,cutoff)=>rows.filter(r=>Date.parse(r.startTime)+protocol.assumedResultLagHours*3600000<Date.parse(cutoff));
const between=(rows,from,to)=>rows.filter(r=>r.startTime>=from&&r.startTime<to);
const leagues={};
for(const league of ['epl','ucl']){
 const collected=loadGz(path.join(root,`half-time-${league}-history.json.gz`)).rows,ftRows=populations[league],selectedFT=baseline.leagues[league].selected;
 const enrichedById=new Map(collected.map(r=>[r.eventId,r]));
 // Retain all original FT fixtures in fit/evaluation denominator ledgers. Missing HT
 // is explicitly excluded by the model rather than disappearing before coverage.
 const rows=ftRows.map(r=>enrichedById.get(r.eventId)||r);
 const fitFT=cutoff=>fitScoreModel(before(ftRows,cutoff),{league,cutoff,...selectedFT,maxIterations:6000,tolerance:1e-6});
 const validationFT=fitFT(protocol.trainingBefore);
 const validationRows=between(rows,protocol.trainingBefore,protocol.validationBefore);
 const trials=protocol.halfLives.map(halfLifeDays=>{
  const model=fitHalfTimeModel(before(rows,protocol.trainingBefore),{league,cutoff:protocol.trainingBefore,halfLifeDays});
  const metrics=evaluateHalfTimeModel(model,validationRows,{predictFullTime:row=>predictScoreModel(validationFT,row)});
  return{halfLifeDays,modelHash:hash(model),metrics};
 });
 const evaluable=trials.filter(t=>t.metrics.count>0&&Number.isFinite(t.metrics.scoreLogLoss));
 if(!evaluable.length)throw Error(`HALF_TIME_VALIDATION_EMPTY_${league}`);
 const gameSets=trials.map(t=>t.metrics.games.filter(g=>g.status==='EVALUATED').map(g=>g.eventId).join(','));
 if(new Set(gameSets).size!==1)throw Error('HALF_TIME_TRIAL_POPULATIONS_DIFFER');
 const selected=evaluable.toSorted((a,b)=>a.metrics.scoreLogLoss-b.metrics.scoreLogLoss||a.halfLifeDays-b.halfLifeDays)[0];
 const diagnosticFT=fitFT(protocol.validationBefore),diagnosticModel=fitHalfTimeModel(before(rows,protocol.validationBefore),{league,cutoff:protocol.validationBefore,halfLifeDays:selected.halfLifeDays});
 const diagnosticRows=between(rows,protocol.validationBefore,protocol.diagnosticBefore);
 const diagnostics=evaluateHalfTimeModel(diagnosticModel,diagnosticRows,{predictFullTime:row=>predictScoreModel(diagnosticFT,row)});
 const liveModel=fitHalfTimeModel(before(rows,protocol.liveTrainingBefore),{league,cutoff:protocol.liveTrainingBefore,halfLifeDays:selected.halfLifeDays});
 leagues[league]={selected:{halfLifeDays:selected.halfLifeDays},liveModel,collection:collection.leagues[league],validation:{period:'2024',sample:validationRows.length,trials:trials.map(t=>({...t,sample:t.metrics.total,used:t.metrics.count,excluded:t.metrics.total-t.metrics.count}))},diagnostic:{period:'2025',sample:diagnosticRows.length,used:diagnostics.count,excluded:diagnostics.total-diagnostics.count,metrics:diagnostics,modelHash:hash(diagnosticModel),fullTimeModelHash:hash(diagnosticFT),interpretation:protocol.diagnosticInterpretation},limitations:['Historical summaries backfilled now; no historical publication timestamp or PIT proof','League/side constant thinning is an assumption, not a dynamic score-state or player model','Outcome calibration curves are diagnostics, not a verified calibration or profit guarantee','No independent final acceptance; existing FT team coverage restrictions remain'],formalEnabled:false};
 console.log(JSON.stringify({stage:'FITTED',league,selected:leagues[league].selected,shares:liveModel.shares,diagnosticCount:diagnostics.count,scoreLogLoss:diagnostics.scoreLogLoss,logLoss:diagnostics.logLoss,brier:diagnostics.brier}));
}
const artifact={version:'SOCCER-HALF-TIME-ARTIFACT-v1',createdAt:new Date().toISOString(),protocol,protocolHash,collection,leagues,formalEnabled:false,formalScoringEnabled:false,pointInTimeAvailabilityVerified:false,executable:false};
artifact.contentHash=hash(artifact);save(path.join(root,'half-time-baseline.json'),artifact);
const stripMetrics=metrics=>({...metrics,games:undefined});
const frozen={...artifact,leagues:Object.fromEntries(Object.entries(leagues).map(([league,r])=>[league,{...r,validation:{...r.validation,trials:r.validation.trials.map(t=>({...t,metrics:stripMetrics(t.metrics)}))},diagnostic:{...r.diagnostic,metrics:stripMetrics(r.diagnostic.metrics)}}]))};
delete frozen.contentHash;frozen.contentHash=hash(frozen);
fs.writeFileSync('lib/soccer/half-time-frozen.js','// Generated by scripts/soccer-half-time-build.mjs; retrospective research only.\nconst data='+JSON.stringify(frozen)+';\nexport function soccerHalfTimeArtifacts(){return structuredClone(data); }\n');
