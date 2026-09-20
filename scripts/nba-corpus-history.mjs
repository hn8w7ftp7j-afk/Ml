// Historical research only. Source odds never become executable quotes or PIT evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadNbaData} from '../lib/nba/data.js';
import {ESPN_NBA_TEAMS} from '../lib/nba/identity.js';
import {analyzeNbaShadow} from '../lib/nba/shadow.js';
const exec = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')));
if (!args.source || !args.output || !args.checkpoint || !/^\d{4}$/.test(args.season||'')) throw Error('Required: --source=... --output=... --checkpoint=... --season=2026');
const sourceText=await fs.readFile(args.source,'utf8'), corpus=JSON.parse(sourceText);
const sourceHash=createHash('sha256').update(sourceText).digest('hex');
const season=Number(args.season), root=path.resolve(args.checkpoint);
await fs.mkdir(root,{recursive:true});
const aliases={GSW:'GS',NOP:'NO',NYK:'NY',SAS:'SA',UTA:'UTAH',WAS:'WSH'};
const code=x=>aliases[x]||x;
const groups=new Map();
for(const row of corpus.raw_snapshots){
  if(!Object.values(ESPN_NBA_TEAMS).includes(code(row.home))||!Object.values(ESPN_NBA_TEAMS).includes(code(row.away))||row.home===row.away) throw Error('Unknown NBA team in '+row.id);
  const key=[row.date,row.away,row.home].join('|');
  if(!groups.has(key)) groups.set(key,{key,monthDay:row.date,away:row.away,home:row.home,snapshots:[]});
  groups.get(key).snapshots.push(row);
}
if(groups.size!==corpus.summary.gameCount||new Set(corpus.raw_snapshots.map(r=>r.id)).size!==corpus.raw_snapshots.length) throw Error('Corpus counts/row IDs conflict');
async function atomic(file,value){await fs.writeFile(file+'.tmp',JSON.stringify(value));await fs.rename(file+'.tmp',file);}
async function fetchViaCurl(url,{signal}={}){
 const {stdout}=await exec('curl',['--silent','--show-error','--max-time','25','--max-filesize','8388608','--write-out','\n%{http_code}',url],{maxBuffer:9*1024*1024,signal});
 const pos=stdout.lastIndexOf('\n'),status=Number(stdout.slice(pos+1));
 return {ok:status>=200&&status<300,status,headers:{get:()=> 'application/json'},text:async()=>stdout.slice(0,pos)};
}
let reused=0,fetched=0;
async function get(query){
 const key=createHash('sha256').update(JSON.stringify(query)).digest('hex'),file=path.join(root,key+'.json');
 try{const record=JSON.parse(await fs.readFile(file,'utf8'));if(record.schema===1&&JSON.stringify(record.query)===JSON.stringify(query)&&(args.offline==='true'||(record.result.status==='ready'&&record.result.qa.status!=='BLOCK')||record.result.qa.issues.some(i=>['SEASON_INVALID','PLAYER_IDENTITY_MISMATCH'].includes(i.code)))){reused++;return record.result;}}catch{}
 if(args.offline==='true') return {status:'unavailable',qa:{status:'WARNING',issues:[{code:'CHECKPOINT_MISSING'}]},data:{game:null,games:[]}};
 const result=await loadNbaData(query,{fetchImpl:fetchViaCurl,timeoutMs:30000});fetched++;
 await atomic(file,{schema:1,query,result});return result;
}
async function pool(items,fn){let next=0;await Promise.all(Array.from({length:24},async()=>{while(next<items.length){const index=next++;await fn(items[index],index);}}));}
const schedules=[],scheduleFailures=[];
const jobs=Object.keys(ESPN_NBA_TEAMS).flatMap(id=>['regular','postseason'].map(seasonType=>({view:'history',id,season,seasonType})));
await pool(jobs,async(q,i)=>{const r=await get(q);if(r.status==='ready'&&r.qa.status!=='BLOCK')schedules.push(r);else scheduleFailures.push({query:q,status:r.status,qa:r.qa});console.log('schedule',i+1,'/',jobs.length,r.status);});
const byId=new Map(),conflicts=new Set();
for(const r of schedules)for(const g of r.data.games){const old=byId.get(g.id);if(old&&JSON.stringify([old.startTime,old.home.id,old.away.id,old.home.score,old.away.score,old.seasonType])!==JSON.stringify([g.startTime,g.home.id,g.away.id,g.home.score,g.away.score,g.seasonType]))conflicts.add(g.id);byId.set(g.id,g);}
// Daily boards retain play-in/postponed rows absent from completed team schedules.
const unresolvedDates=[...new Set([...groups.values()].map(g=>({g,date:`${Number(g.monthDay.slice(0,2))>=7?season-1:season}-${g.monthDay}`})).filter(({g,date})=>![...byId.values()].some(x=>x.taipeiDate===date&&x.home.abbreviation===code(g.home)&&x.away.abbreviation===code(g.away))).map(x=>x.date))];
await pool(unresolvedDates,async(date)=>{const r=await get({view:'schedule',date});if(r.status==='ready'&&r.qa.status!=='BLOCK')for(const g of r.data.games){if(!byId.has(g.id))byId.set(g.id,g);}else scheduleFailures.push({query:{view:'schedule',date},status:r.status,qa:r.qa});});
const all=[...byId.values()];
const entries=[...groups.values()].map(g=>{
 const date=`${Number(g.monthDay.slice(0,2))>=7?season-1:season}-${g.monthDay}`;
 const hits=all.filter(x=>x.taipeiDate===date&&x.home.abbreviation===code(g.home)&&x.away.abbreviation===code(g.away));
 const match=hits.length===1&&!conflicts.has(hits[0].id)?hits[0]:null;
 return {...g,candidateDate:date,yearBasis:'candidate_season_checked_against_provider_schedule',gameId:match?.id||null,seasonType:match?.seasonType||null,identityStatus:match?'provider_matched_official_unverified':hits.length>1?'ambiguous':'unmatched',marketPeriodVerified:g.snapshots.every(r=>r.period==='full'),snapshotTimeVerified:g.snapshots.every(r=>!!r.snapshot_time),researchStatus:'pending',reasons:[]};
});
// Fetch full team histories (including warmup), once per unique game, not only selected odds dates.
const summaries=new Map(),summaryFailures=[];
await pool(all.filter(g=>g.completed&&!conflicts.has(g.id)),async(g,i)=>{
 let r=await get({view:'game',id:g.sourceId});
 const playerFailure=r.qa.issues.some(i=>i.code==='PLAYER_IDENTITY_MISMATCH');
 if(playerFailure){const teamResult=await get({view:'historical-team-box',id:g.sourceId});teamResult.playerEvidenceStatus='BLOCK';r=teamResult;}
 const actual=r.data.game;
 if(actual&&r.playerEvidenceStatus==='BLOCK')actual.researchEvidenceScope='team_only_player_identity_blocked';
 if(r.status==='ready'&&r.qa.status!=='BLOCK'&&actual&&JSON.stringify([actual.id,actual.startTime,actual.home.id,actual.away.id,actual.home.score,actual.away.score,actual.season.year,actual.seasonType])===JSON.stringify([g.id,g.startTime,g.home.id,g.away.id,g.home.score,g.away.score,g.season.year,g.seasonType])) summaries.set(g.id,actual);
 else summaryFailures.push({gameId:g.id,status:r.status,qa:r.qa,reason:'missing_or_conflicting_validated_boxscore'});
 if((i+1)%25===0)console.log('summary',i+1,'/',all.length,'ready',summaries.size,'failed',summaryFailures.length);
});
const reports=[];
for(const history of schedules){
 const teamId=history.data.team.id,type=history.data.games[0]?.seasonType;if(!type)continue;
 const missing=history.data.games.filter(g=>!summaries.has(g.id));
 const research=analyzeNbaShadow(history.data.games.map(g=>summaries.get(g.id)||{...g,home:{...g.home,statistics:[]},away:{...g.away,statistics:[]}}),{teamId,seasonType:type,includeHistoricalDiagnostics:true});
 const invalid=summaryFailures.filter(f=>history.data.games.some(g=>g.id===f.gameId)&&f.qa?.status==='BLOCK');
 if(invalid.length){research.status='blocked';research.qa.status='BLOCK';research.validation=null;research.qa.issues.push({code:'SOURCE_IDENTITY_BLOCK',severity:'BLOCK',message:'來源QA未通過，保留整隊研究阻擋，不隱藏成普通缺值。'});}
 reports.push({teamId,seasonType:type,missingGameIds:missing.map(g=>g.id),sourceBlockedGameIds:invalid.map(f=>f.gameId),research});
}
for(const e of entries){
 if(!e.gameId)e.reasons.push('GAME_IDENTITY_UNRESOLVED');
 if(e.gameId&&byId.get(e.gameId)?.status==='postponed')e.reasons.push('POSTPONED_OR_CANCELLED');
 if(e.gameId&&!summaries.has(e.gameId))e.reasons.push('VERIFIED_BOXSCORE_MISSING');
 const g=byId.get(e.gameId);
 e.evidenceScope=summaries.get(e.gameId)?.researchEvidenceScope||'full_summary';
 if(e.evidenceScope==='team_only_player_identity_blocked')e.reasons.push('PLAYER_EVIDENCE_BLOCKED_NOT_USED');
 // A fixed home-team perspective avoids selecting whichever model fits the result better.
 const report=g&&reports.find(r=>r.teamId===g.home.id&&r.seasonType===g.seasonType);
 const fold=report?.research.folds.find(f=>f.gameId===e.gameId);
 e.researchStatus=fold&&report.research.qa.status!=='BLOCK'?'included_home_team_chronological_fold':'pending';
 e.fold=fold||null;
 if(!fold&&e.gameId)e.reasons.push(report?.research.qa.status==='BLOCK'?'MODEL_QA_BLOCK':'WARMUP_OR_INSUFFICIENT_HISTORY');
 if(!e.marketPeriodVerified)e.reasons.push('MARKET_PERIOD_UNVERIFIED');
 if(!e.snapshotTimeVerified)e.reasons.push('ODDS_CAPTURE_TIME_MISSING');
 e.marketBacktestEligible=false;
}
const included=entries.filter(e=>e.researchStatus==='included_home_team_chronological_fold');
const errors=included.flatMap(e=>{const d=e.fold.historicalDiagnostics;return [d.predictedOwn-d.actualOwn,d.predictedOpponent-d.actualOpponent];});
const baselineErrors=included.flatMap(e=>{const d=e.fold.historicalDiagnostics;return [d.baselineOwn-d.actualOwn,d.baselineOpponent-d.actualOpponent];});
const metrics=xs=>xs.length?{samples:xs.length,mae:xs.reduce((s,x)=>s+Math.abs(x),0)/xs.length,rmse:Math.sqrt(xs.reduce((s,x)=>s+x*x,0)/xs.length),bias:xs.reduce((s,x)=>s+x,0)/xs.length}:null;
const result={candidateSubsetMetrics:{games:included.length,model:metrics(errors),baseline:metrics(baselineErrors)},kind:'nba-odds-corpus-shadow-research',generatedAt:new Date().toISOString(),sourceHash,seasonCandidate:season,modelUnchanged:true,strictPointInTime:false,summary:{candidateGames:entries.length,rawSnapshots:corpus.raw_snapshots.length,marketRecords:corpus.midpoint_markets.length,providerMatched:entries.filter(e=>e.gameId).length,boxscores:summaries.size,scheduleFailures:scheduleFailures.length,summaryFailures:summaryFailures.length,researchIncluded:entries.filter(e=>e.researchStatus==='included_home_team_chronological_fold').length,marketBacktestEligible:0,reusedRequests:reused,newRequests:fetched},limitations:['Existing single-team model, fixed home-team perspective; no model selection by observed performance.','Year and game matches use ESPN secondary source; official crosswalk remains unverified.','Source periods and quote timestamps are not established for the full corpus. No ROI/EV or strict PIT claim.','Postseason is isolated from regular season and may lack training history.'],scheduleFailures,summaryFailures,conflictingGameIds:[...conflicts],entries,reports};
await fs.mkdir(path.dirname(path.resolve(args.output)),{recursive:true});await atomic(args.output,result);console.log(JSON.stringify(result.summary));
