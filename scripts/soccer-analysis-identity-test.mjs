import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import '../reader/soccer-teams.js';
import { fixtureCapture, changed, protocol, after } from './helpers/soccer-forward-fixture.mjs';
import { canonicalSoccerMarketReturnCaptures } from '../lib/soccer/market-return-validation.js';
import { soccerReaderIdentityVerified } from '../lib/soccer/reader-identity-proof.js';

const db = await soccerSqlFixture();
const keys=['DATABASE_URL','DATABASE_V2_URL'], original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const payload=JSON.parse(fs.readFileSync('scripts/fixtures/soccer/epl-summary.json'));
const kickoff=new Date(Math.ceil((Date.now()+3600000)/60000)*60000).toISOString();
payload.header.date=kickoff;const comp=payload.header.competitions[0];comp.date=kickoff;
comp.status={type:{state:'pre',completed:false,name:'STATUS_SCHEDULED'}};
const source={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${payload.header.id}`,
  fetchedAt:new Date().toISOString(),contentHash:'a'.repeat(64)};
const game=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:kickoff,status:comp.status}]},'epl',source).games[0];
const competing={...structuredClone(game),sourceId:'987654321',id:'soccer:epl:987654321'};
const foreign={...structuredClone(competing),league:'ucl',id:'soccer:ucl:987654321'};
const receipt={revision:'b'.repeat(64),observationId:'c'.repeat(64),observedAt:source.fetchedAt,firstFetchedAt:source.fetchedAt,
  receivedAt:source.fetchedAt,persistedAt:source.fetchedAt,sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/'};
const market={unit:'GOALS',kind:'TOTAL',period:'FT',line:'1.5',overWater:.9,underWater:.9,rawRows:['大1.5 0.9','小1.5 0.9'],
  periodEvidence:{period:'FT',status:'EXPLICIT',sectionTitle:'英格蘭超級聯賽',tableHeaders:['全場'],marketHeader:'全場'}};
const boardTime=new Date(Date.parse(kickoff)+8*3600000).toISOString().slice(11,16);
const reader={...receipt,league:'EPL',boardDate:game.date,games:[{league:'EPL',boardDate:game.date,boardTime,
  homeKey:globalThis.Tai888SoccerTeams.key(game.home.name),awayKey:globalThis.Tai888SoccerTeams.key(game.away.name),markets:[market]}]};
// An injected coverage flag cannot certify source completeness; real provider
// authority must be integrated before the verified path can be enabled.
const complete=games=>({ok:true,league:{id:'epl'},date:game.date,until:game.date,games,coverage:{complete:true,identityComplete:true},source});
try {
  process.env.DATABASE_URL='postgres://fixture.invalid/analysis-identity';delete process.env.DATABASE_V2_URL;
  const { analyzeSoccerGame }=await import('../lib/soccer/analysis-service.js');
  const evidence=()=>normalizeSoccerPrematch(payload,game,{...source,fetchedAt:new Date().toISOString()},Date.now());
  const deps={enrichSoccerPrematchInputs:async evidence=>evidence,fetchSoccerPrematch:async()=>evidence(),fetchSoccerWorkload:async()=>({ok:false,teams:{},sources:[]}),
    fetchSoccerTeamXg:async()=>({ok:false,reason:'FIXTURE_UNAVAILABLE'}),loadSoccerReaderSnapshot:async()=>reader};
  const analyze=async board=>analyzeSoccerGame({league:'epl',date:game.date,eventId:game.sourceId},
    {...deps,fetchSoccerSchedule:async()=>board});
  const normal=await analyze(complete([game]));assert.equal(normal.status,200,JSON.stringify(normal.payload));
  assert.equal(normal.payload.readerEvidence.games.length,0,'an untrusted completeness flag cannot establish identity authority');
  assert.equal(normal.payload.directions.flatMap(d=>d.quotes).length,0);
  assert.ok(normal.payload.provisionalReaderResearch?.quotes.length,'fetched-scope research remains explicitly provisional');
  const conflict=await analyze(complete([game,competing]));assert.equal(conflict.status,200,JSON.stringify(conflict.payload));
  assert.equal(conflict.payload.readerEvidence.games.length,0,'different official games with identical teams/time must remain ambiguous');
  assert.equal(conflict.payload.provisionalReaderResearch,null,'visible conflicts cannot enter provisional research');
  assert.equal(conflict.payload.readerDiagnostics.counts.matchedGames,null,
    'diagnostics do not claim a count when full-schedule authority is unavailable');
  assert.equal(conflict.payload.directions.flatMap(d=>d.quotes).length,0);
  const partial=await analyze({...complete([game]),coverage:{complete:false}});
  assert.equal(partial.status,200,JSON.stringify(partial.payload));
  assert.equal(partial.payload.readerEvidence.games.length,0,'partial board cannot prove uniqueness');
  const unproven=await analyze({...complete([game]),coverage:{complete:true}});
  assert.equal(unproven.status,200,JSON.stringify(unproven.payload));
  assert.equal(unproven.payload.readerEvidence.games.length,0,'successful source fetch is not proof of complete identities');
  assert.equal(unproven.payload.readerDiagnostics.code,'SOCCER_READER_SCHEDULE_IDENTITY_UNVERIFIED');
  const provisional=unproven.payload.provisionalReaderResearch;
  assert.ok(provisional?.quotes.length>0,'scope-only matches remain visible as provisional research');
  assert.equal(provisional.scheduleCompletenessVerified,false);assert.equal(provisional.formalEligible,false);
  assert.ok(provisional.quotes.every(q=>q.eligible===false&&q.W===null&&q.R===null&&q.S===null));
  assert.equal(unproven.payload.directions.flatMap(d=>d.quotes).length,0,'unverified quotes never enter formal directions');
  const forward=changed(fixtureCapture(),row=>{row.snapshot.directions=unproven.payload.directions;
    row.snapshot.provisionalReaderResearch=provisional;});
  assert.equal(soccerReaderIdentityVerified(fixtureCapture().snapshot),false,
    'matching fabricated fields and hashes do not provide verified schedule authority');
  assert.equal(canonicalSoccerMarketReturnCaptures([forward],protocol,after).observations.length,0,
    'forward market-return selection must not ingest provisional research');
  const mixed=await analyze(complete([game,foreign]));assert.equal(mixed.status,200,JSON.stringify(mixed.payload));
  assert.ok(mixed.payload.provisionalReaderResearch?.quotes.length,'foreign league must not create a false ambiguity');
  const partialMixed=await analyze({...complete([game,foreign]),coverage:{complete:true}});
  assert.ok(partialMixed.payload.provisionalReaderResearch?.quotes.length,'foreign league cannot suppress scoped research');
  const partialConflict=await analyze({...complete([game,competing]),coverage:{complete:true}});
  assert.equal(partialConflict.payload.provisionalReaderResearch,null,'visible official ambiguity blocks even provisional pairing');
  console.log('PASS actual analysis service: complete-board identity ambiguity, missing coverage and league isolation');
} finally {
  for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
  await db.close();
}
