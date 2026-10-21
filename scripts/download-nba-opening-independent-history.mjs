import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {researchScheduleOracle,validatedResearchScoreboard,researchArchiveCoverage,OPENING_ARCHIVE_SOURCE_ROLE} from '../lib/nba/opening-history-acquisition.js';

// Source acquisition only. No model imports, predictions or holdout metrics.
const destination=process.argv[2];
if(!destination)throw Error('Supply a scratch destination for independent source archive');
const root=path.resolve(destination),cache=path.join(root,'sources'),years=[2013,2014,2015,2016,2017];
await fs.mkdir(cache,{recursive:true});
const sha=value=>createHash('sha256').update(value).digest('hex');
const manifest=new Map();let attempts=0,completed=0;
const ledger=path.join(root,'request-attempts.json');
try{attempts=JSON.parse(await fs.readFile(ledger,'utf8')).attempts;}catch(e){if(e.code!=='ENOENT')throw e;}
if(!Number.isSafeInteger(attempts)||attempts<0)throw Error('Invalid request ledger');
let ledgerWrites=Promise.resolve();
async function source(url,details){
  const key=sha(url),file=path.join(cache,`${key}.json.gz`),meta=path.join(cache,`${key}.meta.json`);
  let raw,metadata;
  try{
    metadata=JSON.parse(await fs.readFile(meta,'utf8'));raw=gunzipSync(await fs.readFile(file)).toString('utf8');
    if(metadata.url!==url||metadata.sha256!==sha(raw)||metadata.bytes!==Buffer.byteLength(raw))throw Error('Corrupt source checkpoint');
  }catch(e){
    if(e.code!=='ENOENT')throw e;
    if(attempts>=1200)throw Error('Independent five-season source request budget exhausted');
    const count=++attempts;
    ledgerWrites=ledgerWrites.then(()=>fs.writeFile(ledger,JSON.stringify({attempts:count,scopeYears:years,updatedAt:new Date().toISOString()})));
    await ledgerWrites;
    const response=await fetch(url,{signal:AbortSignal.timeout(30000),redirect:'error'});
    if(!response.ok)throw Error(`Source HTTP ${response.status}: ${url}`);
    raw=await response.text();if(Buffer.byteLength(raw)>8*1024*1024)throw Error('Source too large');
    const body=JSON.parse(raw);if(body.code>=400)throw Error(`Source API ${body.code}`);
    metadata={url,sha256:sha(raw),retrievedAt:new Date().toISOString(),bytes:Buffer.byteLength(raw),...details,cacheFile:`sources/${key}.json.gz`};
    await fs.writeFile(`${file}.tmp`,gzipSync(raw));await fs.rename(`${file}.tmp`,file);
    await fs.writeFile(`${meta}.tmp`,JSON.stringify(metadata));await fs.rename(`${meta}.tmp`,meta);
  }
  manifest.set(url,metadata);completed++;
  if(completed%40===0)console.log(JSON.stringify({completedSources:completed,cumulativeAttempts:attempts,latest:details}));
  return {body:JSON.parse(raw),...metadata};
}
async function parallel(items,fn){let next=0,error;await Promise.all(Array.from({length:8},async()=>{while(!error&&next<items.length){try{await fn(items[next++]);}catch(e){error??=e;}}}));if(error)throw error;}
const schedules=[];
await parallel(years.flatMap(year=>Array.from({length:30},(_,i)=>({year,team:i+1}))),async({year,team})=>{
  const s=await source(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team}/schedule?season=${year}&seasontype=2`,{kind:'team_schedule',year,team});
  schedules.push({year,team,body:s.body});
});
const oracle=researchScheduleOracle(schedules,years);
const cached=new Set((await fs.readdir(cache)).filter(name=>name.endsWith('.meta.json')).map(name=>name.slice(0,-10)));
const needed=oracle.days.filter(day=>!cached.has(sha(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day.replaceAll('-','')}&limit=1000`)));
if(attempts+needed.length>1200)throw Error('Planned source calendar exceeds five-season acquisition budget');
console.log(JSON.stringify({phase:'schedules_verified',years,schedules:schedules.length,expectedGames:oracle.expected.size,scoreboardDates:oracle.days.length,plannedNewRequests:needed.length}));
const rows=new Map();let writes=Promise.resolve();
function checkpoint(){writes=writes.then(async()=>{
  const history=[...rows.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId));
  const coverage=researchArchiveCoverage(oracle,history,years);
  const archive={kind:'NBA_OPENING_INDEPENDENT_REGULAR_ARCHIVE',version:'nba-opening-independent-history-v1',retrievedAt:new Date().toISOString(),
    sourceRole:OPENING_ARCHIVE_SOURCE_ROLE,temporalBasis:'earlier_era_external_retrospective_results_not_prospective_OOS_or_historical_pregame_capture',
    strictPointInTime:false,officialNbaVerified:false,quarantinedHoldoutYears:[2017],
    holdoutPolicy:'Outcomes acquired and audited only. No 2017 predictive metrics before protocol and development selection freeze. Earlier-era external retrospective test; not prospective OOS.',
    sources:[...manifest.values()].sort((a,b)=>a.url.localeCompare(b.url)),coverage,history,missing:coverage.missing,excluded:oracle.excluded};
  const file=path.join(root,'opening-independent-history.json');await fs.writeFile(`${file}.tmp`,JSON.stringify(archive));await fs.rename(`${file}.tmp`,file);
});return writes;}
try{await parallel(oracle.days,async day=>{
  const s=await source(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day.replaceAll('-','')}&limit=1000`,{kind:'daily_scoreboard',day});
  for(const row of validatedResearchScoreboard(s.body,oracle.expected,s.sha256)){
    const old=rows.get(row.gameId);if(old&&JSON.stringify(old)!==JSON.stringify(row))throw Error('Conflicting source rows');rows.set(row.gameId,row);
  }
  if(completed%40===0)await checkpoint();
});}finally{await checkpoint();}
const coverage=researchArchiveCoverage(oracle,[...rows.values()],years);
if(coverage.status!=='complete')throw Error(`Incomplete independent archive: ${coverage.missing.length} missing`);
console.log(JSON.stringify({saved:path.join(root,'opening-independent-history.json'),games:rows.size,sources:manifest.size,attempts,coverage}));
