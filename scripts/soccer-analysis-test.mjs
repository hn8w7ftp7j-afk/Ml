import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerAnalysis } from '../lib/soccer/analysis.js';
const fixture=name=>JSON.parse(fs.readFileSync(`scripts/fixtures/soccer/${name}.json`));
const at='2026-10-18T13:35:00.000Z',now=Date.parse(at),source={provider:'ESPN',url:'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=401878769',fetchedAt:at,contentHash:'bounded-real-provider-extraction'};
function gameFrom(p,league='epl'){const c=p.header.competitions[0];return normalizeSoccerSchedule({leagues:[p.header.league],events:[{...p.header,date:c.date,status:c.status}]},league,source).games[0];}
for(const [name,league]of [['epl-summary','epl'],['ucl-summary','ucl'],['historic-summary','epl']]){
 const p=fixture(name),game=gameFrom(p,league),e=normalizeSoccerPrematch(p,game,source,now);assert.equal(e.ok,true);
 const a=buildSoccerAnalysis({evidence:e,now});assert.equal(a.directions.length,8);assert.equal(a.executable,false);assert.ok(a.directions.every(d=>d.W===null&&d.R===null&&d.score===null&&d.eligible===false));
 if(name==='historic-summary'){assert.equal(e.phase,'POSTSTART_AUDIT');assert.equal(a.prediction,null);assert.equal(e.teams.home.lineup.starters.length,11);assert.equal(e.teams.home.lineup.status,'POSTSTART_XI');assert.ok(e.teams.home.lineup.starters.every(p=>p.expectedMinutes===null));}
 else{assert.equal(a.prediction.status,'RESEARCH_ONLY');assert.equal(e.teams.home.injuries.status,'UNKNOWN');assert.equal(e.teams.home.lineup.status,'NOT_PUBLISHED');assert.equal(e.teams.home.lineup.sourcePublishedAt,null);}
 const swap=structuredClone(game);[swap.home,swap.away]=[swap.away,swap.home];assert.equal(normalizeSoccerPrematch(p,swap,source,now).ok,false);
 assert.equal(normalizeSoccerPrematch(p,{...game,sourceId:'999999'},source,now).ok,false);
 const foreign=structuredClone(p);foreign.header.league.slug=league==='epl'?'uefa.champions':'eng.1';assert.equal(normalizeSoccerPrematch(foreign,game,source,now).ok,false);
}
const p=fixture('epl-summary'),game=gameFrom(p),evidence=normalizeSoccerPrematch(p,game,source,now),analysis=buildSoccerAnalysis({evidence,now});
assert.equal(analysis.personnelPrediction,null);
assert.equal(analysis.personnelResearch.status,'NOT_AVAILABLE_AT_CUTOFF');
assert.equal(analysis.personnelResearch.reason,'PERSONNEL_ARTIFACT_NOT_AVAILABLE_AT_CUTOFF');
for(const key of ['artifactHash','protocolHash','trainingHash','baselineHash'])assert.equal(analysis.personnelResearch[key],null,'future personnel artifacts must not enter old cutoff snapshots');
assert.equal(analysis.personnelResearch.validation,undefined);
assert.equal(analysis.inputVersions.personnelArtifactHash,null);
const {soccerPersonnelArtifacts}=await import('../lib/soccer/personnel-frozen.js');
const personnelCreated=Date.parse(soccerPersonnelArtifacts().createdAt),currentEvidence=structuredClone(evidence);
currentEvidence.source.fetchedAt=new Date(personnelCreated).toISOString();currentEvidence.game.startTime=new Date(personnelCreated+86400000).toISOString();
const currentPersonnel=buildSoccerAnalysis({evidence:currentEvidence,now:personnelCreated});
assert.equal(currentPersonnel.personnelResearch.status,'PERSONNEL_INPUTS_INSUFFICIENT');
assert.match(currentPersonnel.personnelResearch.artifactHash,/^[a-f0-9]{64}$/);
assert.equal(currentPersonnel.personnelPrediction,null,'unpublished XI cannot be filled from historical rosters');
for(const side of ['主隊','客隊'])for(const label of ['傷停與復出','停賽與出賽資格','預計分鐘與替補'])assert.ok(analysis.missing.some(value=>value.label===side+label),'each side retains its own missing personnel evidence');
const oneSided=structuredClone(evidence);oneSided.teams.home.injuries={status:'PROVIDER_REPORTED',value:[]};
const asymmetric=buildSoccerAnalysis({evidence:oneSided,now});assert.ok(asymmetric.missing.some(value=>value.label==='客隊傷停與復出'));assert.ok(!asymmetric.missing.some(value=>value.label==='主隊傷停與復出'));
const withWorkload=structuredClone(evidence);withWorkload.workload={sources:[{url:'https://fixture.invalid/summary',fetchedAt:at,contentHash:'a'.repeat(64)}]};
assert.deepEqual(buildSoccerAnalysis({evidence:withWorkload,now}).inputVersions.workloadSourceVersions,withWorkload.workload.sources);
const rawReader={league:'EPL',boardDate:game.date,observedAt:at,revision:'synthetic-goal-quote',games:[{league:'EPL',boardDate:game.date,boardTime:'23:30',homeKey:globalThis.Tai888SoccerTeams.key(game.home.name),awayKey:globalThis.Tai888SoccerTeams.key(game.away.name),markets:[{unit:'GOALS',kind:'TOTAL',line:'3+50',overWater:.64,underWater:1.28,rawRows:['大3+50 0.64','小 1.28']}]}]};
const reviewed=buildSoccerAnalysis({evidence,reader:rawReader,now});assert.equal(reviewed.settlementReviews.length,1);assert.equal(reviewed.settlementReviews[0].rawLine,'3+50');assert.equal(reviewed.settlementReviews[0].period,null);assert.ok(reviewed.directions.every(d=>d.W===null&&d.R===null&&d.score===null&&d.executable===false));
const foreignReader={...rawReader,league:'UCL'};assert.equal(buildSoccerAnalysis({evidence,reader:foreignReader,now}).settlementReviews.length,0);
assert.throws(()=>buildSoccerAnalysis({evidence,now:now+180001}),/EVIDENCE_INVALID/);
assert.throws(()=>buildSoccerAnalysis({evidence:{...evidence,source:{...evidence.source,fetchedAt:new Date(now+1).toISOString()}},now}),/EVIDENCE_INVALID/);
assert.throws(()=>buildSoccerAnalysis({evidence,reader:{...rawReader,receivedAt:new Date(now+1).toISOString()},now}),/READER_AFTER_CUTOFF/);
const bad=fixture('historic-summary');bad.rosters[0].roster[1].athlete.id=bad.rosters[0].roster[0].athlete.id;assert.equal(normalizeSoccerPrematch(bad,gameFrom(bad),source,now).code,'SOCCER_ROSTER_PLAYER_CONFLICT');
console.log('PASS real provider extraction: EPL/UCL summaries, separate pre/post phases, complete XI audit, unknown minutes/injury/referee, side/league/player identity, stale snapshots and eight blocked directions');

// Execute the real API, SQL and constraints in an isolated PostgreSQL engine.
register('./next-route-test-loader.mjs',import.meta.url);
const {soccerSqlFixture}=await import('./helpers/soccer-sql-fixture.mjs');
const fixtureDb=await soccerSqlFixture(),{db}=fixtureDb;
const originalFetch=globalThis.fetch,originalNow=Date.now,keys=['APP_PASSWORD','SESSION_SECRET','DATABASE_URL','DATABASE_V2_URL'],env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const count=async()=>(await db.query('SELECT count(*)::int AS n FROM sports_soccer_analysis_v1')).rows[0].n;
try{
 Date.now=()=>now;delete process.env.DATABASE_V2_URL;process.env.DATABASE_URL='postgres://fixture.invalid/analysis';process.env.APP_PASSWORD='fixture-soccer';process.env.SESSION_SECRET='fixture-soccer-session';
 let calls=0;globalThis.fetch=async url=>{calls++;assert.match(String(url),/^https:\/\/site.api.espn.com\/apis\/site\/v2\/sports\/soccer\/eng.1\/(?:summary\?event=401878769|scoreboard\?dates=202610(?:17|18|19))$/);if(String(url).includes('summary'))return Response.json(p);return Response.json({leagues:[p.header.league],events:[{...p.header,date:p.header.competitions[0].date,status:p.header.competitions[0].status}]});};
 const {POST,GET}=await import('../app/api/soccer/analysis/route.js'),{createSessionToken}=await import('../lib/security.js'),{saveSoccerAnalysis}=await import('../lib/soccer/analysis-store.js');
 const token=await createSessionToken(),body={league:'epl',date:game.date,eventId:game.sourceId};
 const request=(b=body,headers={})=>new Request('https://fixture.invalid/api/soccer/analysis',{method:'POST',headers:{cookie:`mlb_session=${token}`,'Content-Type':'application/json',Origin:'https://fixture.invalid',...headers},body:JSON.stringify(b)});
 assert.equal((await POST(request(body,{cookie:''}))).status,401);assert.equal((await POST(request(body,{Origin:'https://evil.invalid'}))).status,403);assert.equal(calls,0);
 assert.equal((await POST(request({...body,eventId:'x/../'}))).status,400);assert.equal(calls,0);
 const absent=await POST(request({...body,date:'2026-10-19'}));assert.equal(absent.status,404);assert.equal((await absent.json()).analysisStatus,'INSUFFICIENT_DATA');
 const result=await POST(request());assert.equal(result.status,200,JSON.stringify(await result.clone().json()));const resultBody=await result.json();assert.equal(resultBody.persisted,true);assert.equal(resultBody.journalPersisted,true);assert.equal(resultBody.analysisStatus,'COMPLETED');assert.equal(resultBody.selectionResult,'RESEARCH_SHADOW');assert.equal(resultBody.gameId,game.id);assert.equal(resultBody.prediction.status,'RESEARCH_ONLY');assert.equal(await count(),1);assert.equal(resultBody.requirements.layers.length,6);
 await saveSoccerAnalysis(analysis);const previous=await count();await saveSoccerAnalysis(analysis);assert.equal(await count(),previous,'identical immutable revisions deduplicate');
 const later=buildSoccerAnalysis({evidence,now:now+1000});await saveSoccerAnalysis(later);assert.equal(await count(),previous+1);
 await assert.rejects(()=>db.query('UPDATE sports_soccer_analysis_v1 SET payload=payload'),/SOCCER_IMMUTABLE_HISTORY/);
 const historyRequest=(query='league=epl&date=2026-10-18&eventId=401878769',auth=true)=>new Request('https://fixture.invalid/api/soccer/analysis?'+query,{headers:auth?{cookie:`mlb_session=${token}`}:{}});
 assert.equal((await GET(historyRequest(undefined,false))).status,401);assert.equal((await GET(historyRequest('league=NHL&date=2026-10-18&eventId=1'))).status,400);
 const saved=await (await GET(historyRequest())).json();assert.equal(saved.versions.length,await count());assert.ok(saved.versions.every(v=>v.persisted));assert.equal(saved.runs[0].analysisStatus,'COMPLETED');assert.equal((await (await GET(historyRequest('league=ucl&date=2026-10-18&eventId=401878769'))).json()).versions.length,0);
 const failedRuns=(await db.query("SELECT analysis_status,selection_result FROM sports_soccer_analysis_events_v2 WHERE analysis_status='INSUFFICIENT_DATA'")).rows;assert.equal(failedRuns.length,1);assert.equal(failedRuns[0].selection_result,null);
 assert.ok((await db.query('SELECT * FROM sports_soccer_cohort_v2')).rows.length>0,'entire observed schedule is retained, including unselected games');
 console.log('PASS real soccer API + PostgreSQL: auth/origin/scope, six-layer research states, immutable snapshots/dedup, failed attempts, cohort retention and separate historical versions; no Production writes');
}finally{Date.now=originalNow;globalThis.fetch=originalFetch;for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}await fixtureDb.close();}
