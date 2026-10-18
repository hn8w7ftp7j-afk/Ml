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
assert.throws(()=>buildSoccerAnalysis({evidence,now:now+180001}),/EVIDENCE_INVALID/);
const bad=fixture('historic-summary');bad.rosters[0].roster[1].athlete.id=bad.rosters[0].roster[0].athlete.id;assert.equal(normalizeSoccerPrematch(bad,gameFrom(bad),source,now).code,'SOCCER_ROSTER_PLAYER_CONFLICT');
console.log('PASS real provider extraction: EPL/UCL summaries, separate pre/post phases, complete XI audit, unknown minutes/injury/referee, side/league/player identity, stale snapshots and eight blocked directions');

// Real route and immutable store execute with isolated SQL/source transports only.
register('./next-route-test-loader.mjs',import.meta.url);
const adapter='data:text/javascript,'+encodeURIComponent(`export function neon(){return async function(sql,...values){return globalThis.__SOCCER_ANALYSIS_SQL(sql.join('?'),values);};}`);
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='@neondatabase/serverless'&&/\\/lib\\/soccer\\/(?:analysis-store|reader-store)\\.js$/.test(c.parentURL||''))return {url:${JSON.stringify(adapter)},shortCircuit:true};return n(s,c);}`),import.meta.url);
const db=[],originalFetch=globalThis.fetch,originalNow=Date.now,keys=['APP_PASSWORD','SESSION_SECRET','DATABASE_URL','DATABASE_V2_URL'],env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const reverse=value=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reverse(v)])):value;
globalThis.__SOCCER_ANALYSIS_SQL=async(query,values)=>{
 if(query.includes('CREATE TABLE'))return[];
 if(query.includes('sports_soccer_reader_snapshots'))return[];
 if(query.includes('INSERT INTO')){if(!db.some(x=>x.hash===values[2]))db.push({league:values[0],id:values[1],hash:values[2],payload:reverse(JSON.parse(values[4]))});return[];}
 if(query.includes('SELECT analysis_hash'))return db.filter(r=>r.league===values[0]&&r.id===values[1]&&r.payload.date===values[2]).sort((a,b)=>b.payload.observedAt.localeCompare(a.payload.observedAt)).slice(0,5).map(r=>({analysis_hash:r.hash,payload:r.payload}));
 if(query.includes('SELECT payload'))return db.filter(r=>r.league===values[0]&&r.id===values[1]&&r.hash===values[2]);throw Error('Unexpected isolated SQL');
};
try{
 Date.now=()=>now;delete process.env.DATABASE_V2_URL;process.env.DATABASE_URL='postgres://fixture.invalid/analysis';process.env.APP_PASSWORD='fixture-soccer';process.env.SESSION_SECRET='fixture-soccer-session';
 let calls=0;globalThis.fetch=async url=>{calls++;assert.match(String(url),/^https:\/\/site.api.espn.com\/apis\/site\/v2\/sports\/soccer\/eng.1\/(?:summary\?event=401878769|scoreboard\?dates=202610(?:17|18|19))$/);if(String(url).includes('summary'))return Response.json(p);return Response.json({leagues:[p.header.league],events:[{...p.header,date:p.header.competitions[0].date,status:p.header.competitions[0].status}]});};
 const {POST,GET}=await import('../app/api/soccer/analysis/route.js'),{createSessionToken}=await import('../lib/security.js'),{saveSoccerAnalysis}=await import('../lib/soccer/analysis-store.js');
 const token=await createSessionToken(),body={league:'epl',date:game.date,eventId:game.sourceId};
 const request=(b=body,headers={})=>new Request('https://fixture.invalid/api/soccer/analysis',{method:'POST',headers:{cookie:`mlb_session=${token}`,'Content-Type':'application/json',Origin:'https://fixture.invalid',...headers},body:JSON.stringify(b)});
 assert.equal((await POST(request(body,{cookie:''}))).status,401);assert.equal((await POST(request(body,{Origin:'https://evil.invalid'}))).status,403);assert.equal(calls,0);
 assert.equal((await POST(request({...body,eventId:'x/../'}))).status,400);assert.equal(calls,0);
 assert.equal((await POST(request({...body,date:'2026-10-19'}))).status,404);
 const result=await POST(request());assert.equal(result.status,200);const resultBody=await result.json();assert.equal(resultBody.persisted,true);assert.equal(resultBody.gameId,game.id);assert.equal(resultBody.prediction.status,'RESEARCH_ONLY');assert.equal(db.length,1);
 await saveSoccerAnalysis(analysis);const previous=db.length;await saveSoccerAnalysis(analysis);assert.equal(db.length,previous,'identical immutable revisions deduplicate');
 const later=buildSoccerAnalysis({evidence,now:now+1000});await saveSoccerAnalysis(later);assert.equal(db.length,previous+1);assert.equal(db[0].payload.observedAt,at,'a new analysis cannot overwrite an earlier revision');
 const historyRequest=(query='league=epl&date=2026-10-18&eventId=401878769',auth=true)=>new Request('https://fixture.invalid/api/soccer/analysis?'+query,{headers:auth?{cookie:`mlb_session=${token}`}:{}});
 assert.equal((await GET(historyRequest(undefined,false))).status,401);assert.equal((await GET(historyRequest('league=NHL&date=2026-10-18&eventId=1'))).status,400);
 const saved=await (await GET(historyRequest())).json();assert.equal(saved.versions.length,db.length);assert.ok(saved.versions.every(v=>v.persisted));assert.equal((await (await GET(historyRequest('league=ucl&date=2026-10-18&eventId=401878769'))).json()).versions.length,0);
 const cleanPayload=structuredClone(db[0].payload);db[0].payload.prediction.homeRate+=1;assert.equal((await GET(historyRequest())).status,503,'corrupted saved output cannot be presented as valid history');db[0].payload=cleanPayload;
 console.log('PASS actual soccer analysis API/store: session/origin/input rejection before fetch, exact date/game, real source reparse, research prediction, immutable JSONB readback/dedup/new revision; no Production writes');
}finally{Date.now=originalNow;globalThis.fetch=originalFetch;delete globalThis.__SOCCER_ANALYSIS_SQL;for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}}
