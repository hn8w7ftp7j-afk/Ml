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
const diagnose=(value,extra={})=>buildSoccerReaderDiagnostics({reader:value,game,now,...extra});
const ready=diagnose(reader);assert.equal(ready.code,'SOCCER_READER_CAPTURE_READY');assert.equal(ready.status,'READY');
assert.deepEqual(ready.counts,{capturedGames:1,matchedGames:1,capturedMarkets:1,matchedGoalMarkets:1,assignedQuotes:2,unassignedQuotes:0,freshPrematchQuotes:2});
assert.deepEqual(ready.confirmedPeriods,['FT']);assert.deepEqual(ready.freshPeriods,['FT']);
assert.equal(ready.gameId,game.id);assert.equal(ready.league,game.league);assert.equal(ready.date,game.date);assert.equal(ready.executable,false);
assert.equal(diagnose(null).code,'SOCCER_READER_CAPTURE_MISSING');
const unavailable=diagnose(null,{unavailable:true});assert.equal(unavailable.code,'SOCCER_READER_STORAGE_UNAVAILABLE');assert.ok(Object.values(unavailable.counts).every(value=>value===null));
for(const change of [s=>{s.league='UCL';},s=>{s.boardDate='2026-10-19';}]){
  const value=structuredClone(reader);change(value);const result=diagnose(value);
  assert.equal(result.code,'SOCCER_READER_CAPTURE_SCOPE_MISMATCH');assert.ok(Object.values(result.counts).every(value=>value===null));}
const unmatched=structuredClone(reader);unmatched.games[0].awayKey='another-team';
assert.equal(diagnose(unmatched).code,'SOCCER_READER_GAME_UNMATCHED');assert.equal(diagnose(unmatched).counts.capturedMarkets,1);
for(const markets of [[],[{kind:'MONEYLINE',unit:'GOALS',homeWater:2,awayWater:3}],[{...quote(),overWater:null,underWater:null}]]){
  const value=structuredClone(reader);value.games[0].markets=markets;assert.equal(diagnose(value).code,'SOCCER_READER_NO_OPEN_GOAL_MARKET');}
const unknown=structuredClone(reader);unknown.games[0].markets=[quote('UNKNOWN')];
assert.equal(diagnose(unknown).code,'SOCCER_READER_PERIOD_UNCONFIRMED');assert.equal(diagnose(unknown).counts.unassignedQuotes,2);
assert.deepEqual(diagnose(unknown).confirmedPeriods,[]);assert.deepEqual(diagnose(unknown).freshPeriods,[]);
const old=structuredClone(reader);old.games[0].markets=[quote('FT',stale)];
assert.equal(diagnose(old).code,'SOCCER_READER_QUOTES_STALE');assert.equal(diagnose(old).counts.assignedQuotes,2);
assert.equal(diagnose(reader,{game:{...game,status:'final'}}).code,'SOCCER_READER_MATCH_STARTED');
const afterCutoff=structuredClone(reader);afterCutoff.games[0].markets[0].serverObservation.receivedAt=new Date(now+1).toISOString();
assert.equal(diagnose(afterCutoff).code,'SOCCER_READER_CAPTURE_UNUSABLE_AT_CUTOFF');
for(const change of [
  value=>{value.games[0].markets[0].serverObservation.persistedAt=new Date(now+1).toISOString();},
  value=>{value.games[0].markets[0].serverObservation.persistedAt='invalid';},
  value=>{delete value.games[0].markets[0].serverObservation;},
]){const value=structuredClone(reader);change(value);const original=JSON.stringify(value),diagnostic=diagnose(value);
  assert.equal(diagnostic.code,'SOCCER_READER_CAPTURE_UNUSABLE_AT_CUTOFF');assert.equal(diagnostic.counts.assignedQuotes,2);
  assert.equal(diagnostic.counts.freshPrematchQuotes,0,'unusable own receipts cannot borrow aggregate freshness');
  assert.deepEqual(diagnostic.freshPeriods,[]);assert.equal(JSON.stringify(value),original);}
const mixed=structuredClone(reader);mixed.observedAt=stale;mixed.games[0].markets.push(quote('HT',stale),quote('UNKNOWN'));
const before=JSON.stringify(mixed),mixedResult=diagnose(mixed);
assert.equal(mixedResult.code,'SOCCER_READER_CAPTURE_READY');assert.deepEqual(mixedResult.confirmedPeriods,['FT','HT']);assert.deepEqual(mixedResult.freshPeriods,['FT']);
assert.equal(JSON.stringify(mixed),before);

const oldNow=Date.now;Date.now=()=>now;
try{
  for(const [value,code,throws]of [[reader,'CAPTURE_READY',false],[null,'CAPTURE_MISSING',false],[unmatched,'GAME_UNMATCHED',false],[unknown,'PERIOD_UNCONFIRMED',false],[null,'STORAGE_UNAVAILABLE',true]]){
    let persisted=null;
    const response=await analyzeSoccerGame({league:'epl',date:game.date,eventId:game.sourceId},{
      ensureSoccerForwardProtocol:async()=>{throw Error('forward capture not part of fixture');},
      beginSoccerAnalysisRun:async()=>({runId:'diagnostic-fixture-run',requestSeq:'1',quoteGeneration:'1',startedAt:at}),
      fetchSoccerSchedule:async()=>({ok:true,games:[game]}),recordSoccerCohort:async()=>{},
      fetchSoccerPrematch:async()=>structuredClone(evidence),fetchSoccerWorkload:async()=>({ok:false,teams:{},sources:[]}),
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
console.log('PASS Reader diagnostics: unavailable storage vs absent captures, exact scope/identity, closed/unknown/stale/poststart/current originals, own-receipt validity and immutable service persistence without private error text.');
