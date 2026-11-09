import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { analyzeSoccerGame } from '../lib/soccer/analysis-service.js';
import { soccerAnalysisHash } from '../lib/soccer/analysis.js';
import { buildSoccerReaderDiagnostics } from '../lib/soccer/reader-diagnostics.js';

const at='2026-10-18T13:35:00.000Z',now=Date.parse(at),stale=new Date(now-180001).toISOString();
const provider=JSON.parse(fs.readFileSync('scripts/fixtures/soccer/epl-summary.json','utf8'));
const source={provider:'ESPN',url:'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary',fetchedAt:at,contentHash:'provider-fixture'};
const competition=provider.header.competitions[0];
const game=normalizeSoccerSchedule({leagues:[provider.header.league],events:[{...provider.header,date:competition.date,status:competition.status}]},'epl',source).games[0];
const evidence=normalizeSoccerPrematch(provider,game,source,now);assert.equal(evidence.ok,true);
const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(game.startTime));
const quote=(period='FT',time=at)=>({unit:'GOALS',kind:'TOTAL',line:'3+50',overWater:.64,underWater:1.28,period,
  periodEvidence:{period,status:period==='UNKNOWN'?'UNKNOWN':'EXPLICIT',sectionTitle:`英格蘭超級聯賽${period==='FT'?' 全場':period==='HT'?' 上半場':''}`,
    tableHeaders:['時間','主客隊伍','讓球','大小','獨贏'],marketHeader:'大小'},rawRows:['大3+50 0.64','小 1.28'],
  serverObservation:{observedAt:time,firstFetchedAt:time,receivedAt:time,persistedAt:time}});
const reader={league:'EPL',boardDate:game.date,observedAt:at,isPeriodAggregate:true,games:[{league:'EPL',boardDate:game.date,boardTime:clock,
  homeKey:globalThis.Tai888SoccerTeams.key(game.home.name),awayKey:globalThis.Tai888SoccerTeams.key(game.away.name),markets:[quote()]}]};
const schedule={ok:true,league:{id:game.league},date:game.date,until:game.date,games:[game],coverage:{complete:true,identityComplete:true}};
const diagnose=(value,extra={})=>buildSoccerReaderDiagnostics({reader:value,game,schedule,now,...extra});
const unverified=diagnose(reader);assert.equal(unverified.code,'SOCCER_READER_SCHEDULE_IDENTITY_UNVERIFIED');assert.equal(unverified.status,'UNAVAILABLE');
assert.equal(unverified.counts.capturedGames,1);assert.equal(unverified.counts.capturedMarkets,1);
for(const key of ['matchedGames','matchedGoalMarkets','assignedQuotes','unassignedQuotes','freshPrematchQuotes'])assert.equal(unverified.counts[key],null,`${key} must not imply a verified match`);
assert.deepEqual(unverified.confirmedPeriods,[]);assert.deepEqual(unverified.freshPeriods,[]);
assert.equal(unverified.gameId,game.id);assert.equal(unverified.league,game.league);assert.equal(unverified.date,game.date);assert.equal(unverified.executable,false);
assert.equal(diagnose(null).code,'SOCCER_READER_CAPTURE_MISSING');
const unavailable=diagnose(null,{unavailable:true});assert.equal(unavailable.code,'SOCCER_READER_STORAGE_UNAVAILABLE');assert.ok(Object.values(unavailable.counts).every(value=>value===null));
for(const change of [s=>{s.league='UCL';},s=>{s.boardDate='2026-10-19';}]){
  const value=structuredClone(reader);change(value);const result=diagnose(value);
  assert.equal(result.code,'SOCCER_READER_CAPTURE_SCOPE_MISMATCH');assert.ok(Object.values(result.counts).every(value=>value===null));}
// A successful fetch or forged client-visible completeness flag cannot certify
// matching identity. Stale, changed, ambiguous and absent prices stay unknown
// until an independent completeness issuer exists.
const unmatched=structuredClone(reader);unmatched.games[0].awayKey='another-team';
const unknown=structuredClone(reader);unknown.games[0].markets=[quote('UNKNOWN')];
const old=structuredClone(reader);old.games[0].markets=[quote('FT',stale)];
const ambiguous=structuredClone(schedule);ambiguous.games.push({...structuredClone(game),sourceId:'987654321',id:'soccer:epl:987654321'});
for(const [value,board] of [[reader,schedule],[reader,ambiguous],[unmatched,schedule],[unknown,schedule],[old,schedule]]){
  const before=JSON.stringify(value),result=diagnose(value,{schedule:board});
  assert.equal(result.code,'SOCCER_READER_SCHEDULE_IDENTITY_UNVERIFIED');assert.equal(result.counts.matchedGames,null);
  assert.equal(result.counts.assignedQuotes,null);assert.equal(JSON.stringify(value),before);
}

const oldNow=Date.now;Date.now=()=>now;
try{
  for(const [value,code,throws]of [[reader,'SCHEDULE_IDENTITY_UNVERIFIED',false],[null,'CAPTURE_MISSING',false],[unmatched,'SCHEDULE_IDENTITY_UNVERIFIED',false],[unknown,'SCHEDULE_IDENTITY_UNVERIFIED',false],[null,'STORAGE_UNAVAILABLE',true]]){
    let persisted=null;
    const response=await analyzeSoccerGame({league:'epl',date:game.date,eventId:game.sourceId},{
      enrichSoccerPrematchInputs:async evidence=>evidence,
      ensureSoccerForwardProtocol:async()=>{throw Error('forward capture not part of fixture');},
      beginSoccerAnalysisRun:async()=>({runId:'diagnostic-fixture-run',requestSeq:'1',quoteGeneration:'1',startedAt:at}),
      fetchSoccerSchedule:async()=>schedule,recordSoccerCohort:async()=>{},
      fetchSoccerPrematch:async()=>structuredClone(evidence),fetchSoccerWorkload:async()=>({ok:false,teams:{},sources:[]}),
      fetchSoccerTeamXg:async()=>({ok:false,reason:'TEAM_XG_NOT_PART_OF_FIXTURE'}),
      loadSoccerReaderSnapshot:async()=>{if(throws)throw Error('postgres://private-password@private-host/?token=do-not-expose');return structuredClone(value);},
      listSoccerAnalysis:async()=>[],saveSoccerAnalysis:async snapshot=>{persisted=structuredClone(snapshot);const {analysisHash,...body}=snapshot;
        assert.equal(analysisHash,soccerAnalysisHash(body));return{persisted:true,revision:analysisHash};},
      finishSoccerAnalysisRun:async()=>({publishedCurrent:false}),getSoccerCurrentResearchStatus:async()=>null,
    });
    assert.equal(response.status,200,JSON.stringify(response.payload));assert.equal(persisted.readerDiagnostics.code,`SOCCER_READER_${code}`);
    assert.equal(response.payload.readerDiagnostics.code,persisted.readerDiagnostics.code);
    assert.equal(persisted.readerUnavailable,throws);assert.equal(response.payload.readerUnavailable,throws);
    assert.equal(response.payload.persisted,true);assert.equal(response.payload.executable,false);
    assert.doesNotMatch(JSON.stringify(response),/private-password|private-host|do-not-expose/);
    const {analysisHash,...tampered}=persisted;tampered.readerDiagnostics={...tampered.readerDiagnostics,code:'SOCCER_READER_CAPTURE_READY_FORGED'};
    assert.notEqual(soccerAnalysisHash(tampered),analysisHash,'diagnostic state is covered by immutable revision');
  }
}finally{Date.now=oldNow;}
console.log('PASS Reader diagnostics: unknown completeness fails closed, original capture counts, source scope, storage failures, immutable service persistence and private-error redaction.');
