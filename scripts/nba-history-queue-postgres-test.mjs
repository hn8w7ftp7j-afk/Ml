// --sql emits the production store's own parameterized statements plus actual
// PostgreSQL assertions. Without --sql this is SQL transport testing only.
import assert from 'node:assert/strict';
import {buildNbaHistoryCandidate,saveNbaHistoryCandidate,saveNbaHistoryAttempt,loadPendingNbaHistory,readNbaHistoryQueueStatus} from '../lib/nba/history-queue-store.js';
import {saveNbaLiveHistory} from '../lib/nba/live-history-store.js';
import {createLiveHistoryFixture} from './fixtures/nba-live-history-fixture.mjs';
const emit=process.argv.includes('--sql');
const literal=value=>value==null?'NULL':typeof value==='number'?String(value):`'${String(value).replaceAll("'","''")}'`;
const candidates=new Map(),attempts=new Map(),completed=new Map(),statements=[];
let createAttempts=0,failOnce=false;
const db=async(parts,...values)=>{
 const text=parts.reduce((output,part,index)=>output+part+(index<values.length?literal(values[index]):''),'').trim();
 statements.push(text);if(emit)console.log(`${text};`);
 if(text.startsWith('CREATE')){createAttempts++;if(failOnce){failOnce=false;throw Error('schema retry fixture');}return[];}
 if(text.startsWith('INSERT INTO sports_nba_history_candidates_v1')){
  const[gameId,revision,identityHash,date,capturedAt,payload]=values;
  if(candidates.has(gameId))return[];
  const saved={revision,identityHash,date,capturedAt,payload:JSON.parse(payload)};candidates.set(gameId,saved);return[structuredClone(saved)];
 }
 if(text.startsWith('INSERT INTO sports_nba_history_attempts_v1')){
  const[revision,gameId,candidateRevision,attemptedAt,status,payload]=values,source=candidates.get(gameId);
  if(source?.revision===candidateRevision&&Date.parse(source.capturedAt)<=Date.parse(attemptedAt)&&!attempts.has(revision))attempts.set(revision,{attempt_hash:revision,gameId,candidateRevision,attemptedAt,status,payload:JSON.parse(payload)});
  return[];
 }
 if(text.startsWith('INSERT INTO sports_nba_live_history_v1')){
  const[gameId,revision,,date,,,capturedAt,payload]=values;
  if(completed.has(gameId))return[];const saved={revision,date,capturedAt,payload:JSON.parse(payload)};completed.set(gameId,saved);return[structuredClone(saved)];
 }
 if(text.startsWith('SELECT revision,payload FROM sports_nba_history_candidates_v1 WHERE game_id='))return candidates.has(values[0])?[structuredClone(candidates.get(values[0]))]:[];
 if(text.startsWith('SELECT attempt_hash,payload FROM sports_nba_history_attempts_v1'))return attempts.has(values[0])?[structuredClone(attempts.get(values[0]))]:[];
 if(text.startsWith('SELECT revision,payload FROM sports_nba_live_history_v1 WHERE game_id='))return completed.has(values[0])?[structuredClone(completed.get(values[0]))]:[];
 if(text.startsWith('SELECT COUNT(*) AS pending_games')){
  const pending=[...candidates.values()].filter(row=>row.date<=values[0]&&!completed.has(row.payload.gameId));
  const ids=new Set(pending.map(row=>row.payload.gameId));
  const dates=pending.map(row=>row.date).sort(),times=[...attempts.values()].filter(row=>ids.has(row.gameId)).map(row=>row.attemptedAt).sort();
  return[{pending_games:String(pending.length),oldest_pending_date:dates[0]??null,last_attempt_at:times.at(-1)??null}];
 }
 if(text.startsWith('SELECT c.revision,c.payload,a.last_attempt_at')){
  const[throughDate,limit]=values;
  return [...candidates.values()].filter(row=>row.date<=throughDate&&!completed.has(row.payload.gameId)).map(row=>{
   const times=[...attempts.values()].filter(attempt=>attempt.gameId===row.payload.gameId).map(attempt=>attempt.attemptedAt).sort();
   return{...structuredClone(row),last_attempt_at:times.at(-1)??null};
  }).sort((a,b)=>(a.last_attempt_at??a.capturedAt).localeCompare(b.last_attempt_at??b.capturedAt)||a.date.localeCompare(b.date)||a.payload.gameId.localeCompare(b.payload.gameId)).slice(0,limit);
 }
 throw Error(`Unexpected queue SQL: ${text.slice(0,120)}`);
};
const fixture=(date,id)=>{
 const value=createLiveHistoryFixture({date,gameId:id});
 const source={...value.result.sources[0],url:`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date.replaceAll('-','')}`};
 return{...value,candidate:buildNbaHistoryCandidate(value.result.data.game,[source],{now:value.now}),source};
};
// Distinct test-only identities avoid collisions with the existing live-history
// PostgreSQL fixture when both scripts run against the same CI database.
const first=fixture('2025-10-23','401899834'),second=fixture('2025-10-24','401899835'),third=fixture('2025-10-25','401899836');
const now=Date.parse('2026-10-07T12:00:00Z');
assert.deepEqual(await readNbaHistoryQueueStatus({throughDate:'2026-10-07'},{sql:db,now}),{pendingGames:0,oldestPendingDate:null,lastAttemptAt:null},'An empty persistent backlog has an explicit zero/null status');
const savedFirst=await saveNbaHistoryCandidate(first.candidate,{sql:db,now});assert.equal(savedFirst.inserted,true);
const repeatedCandidate=buildNbaHistoryCandidate(first.result.data.game,[first.source],{now:first.now+100});
const repeated=await saveNbaHistoryCandidate(repeatedCandidate,{sql:db,now});assert.equal(repeated.inserted,false);assert.equal(repeated.revision,first.candidate.recordHash);assert.equal(repeated.capturedAt,first.candidate.capturedAt);
await saveNbaHistoryCandidate(second.candidate,{sql:db,now});await saveNbaHistoryCandidate(third.candidate,{sql:db,now});
const pending=await loadPendingNbaHistory({throughDate:'2026-10-07'},{sql:db,now});
assert.deepEqual(pending.map(row=>row.gameId),[first.candidate.gameId,second.candidate.gameId,third.candidate.gameId]);
assert.ok(pending.every(row=>Date.parse(row.date)<now-3*86400000),'The persisted retry queue has no three-day discovery cutoff');
assert.deepEqual(await readNbaHistoryQueueStatus({throughDate:'2026-10-07'},{sql:db,now}),{pendingGames:3,oldestPendingDate:'2025-10-23',lastAttemptAt:null});
const attemptOne={gameId:first.candidate.gameId,candidateRevision:first.candidate.recordHash,attemptedAt:'2026-10-01T12:00:00Z',status:'failed',code:'NBA_OFFICIAL_UNAVAILABLE'};
const attemptTwo={...attemptOne,attemptedAt:'2026-10-02T12:00:00Z'};
const attemptReceipt=await saveNbaHistoryAttempt(attemptOne,{sql:db,now});
const repeatedAttempt=await saveNbaHistoryAttempt(attemptOne,{sql:db,now});assert.equal(repeatedAttempt.revision,attemptReceipt.revision);
await saveNbaHistoryAttempt(attemptTwo,{sql:db,now});assert.equal(attempts.size,2);
const retried=await loadPendingNbaHistory({throughDate:'2026-10-07',limit:2},{sql:db,now});
assert.deepEqual(retried.map(row=>row.gameId),[second.candidate.gameId,third.candidate.gameId],'Recently retried failures rotate behind older untouched candidates');
const afterAttempts=await loadPendingNbaHistory({throughDate:'2026-10-07'},{sql:db,now});assert.equal(afterAttempts.at(-1).lastAttemptAt,'2026-10-02T12:00:00.000Z');
await saveNbaLiveHistory(second.row,{sql:db,now});
await saveNbaHistoryAttempt({gameId:second.candidate.gameId,candidateRevision:second.candidate.recordHash,attemptedAt:'2026-10-03T12:00:00Z',status:'saved',code:null},{sql:db,now});
const unfinished=await loadPendingNbaHistory({throughDate:'2026-10-07'},{sql:db,now});assert.deepEqual(unfinished.map(row=>row.gameId),[third.candidate.gameId,first.candidate.gameId],'Verified completed records are excluded without deleting first-discovery evidence');
assert.deepEqual(await readNbaHistoryQueueStatus({throughDate:'2026-10-07'},{sql:db,now}),{pendingGames:2,oldestPendingDate:'2025-10-23',lastAttemptAt:'2026-10-02T12:00:00.000Z'},'Queue status counts only unfinished records and excludes completed attempts');
assert.deepEqual(await readNbaHistoryQueueStatus({throughDate:'2025-10-22'},{sql:db,now}),{pendingGames:0,oldestPendingDate:null,lastAttemptAt:null},'The status respects the requested historical date cutoff');
const historicalCutoff=await loadPendingNbaHistory({throughDate:'2025-10-24'},{sql:db,now});assert.deepEqual(historicalCutoff.map(row=>row.gameId),[first.candidate.gameId]);
const altered=structuredClone(first.result.data.game);altered.home.score++;
const conflict=buildNbaHistoryCandidate(altered,[first.source],{now:first.now});
await assert.rejects(()=>saveNbaHistoryCandidate(conflict,{sql:db,now}),error=>error.code==='NBA_HISTORY_CANDIDATE_CONFLICT');
assert.equal(candidates.get(first.candidate.gameId).payload.game.home.score,119);
if(emit){
 console.log(`DO $$ BEGIN
  IF (SELECT count(*) FROM sports_nba_history_candidates_v1) <> 3 THEN RAISE EXCEPTION 'retry candidates duplicated'; END IF;
  IF (SELECT revision FROM sports_nba_history_candidates_v1 WHERE game_id=${literal(first.candidate.gameId)}) <> ${literal(first.candidate.recordHash)} THEN RAISE EXCEPTION 'first candidate evidence overwritten'; END IF;
  IF (SELECT captured_at FROM sports_nba_history_candidates_v1 WHERE game_id=${literal(first.candidate.gameId)}) <> ${literal(first.candidate.capturedAt)}::timestamptz THEN RAISE EXCEPTION 'first candidate capture overwritten'; END IF;
  IF (SELECT payload->'game'->'home'->>'score' FROM sports_nba_history_candidates_v1 WHERE game_id=${literal(first.candidate.gameId)}) <> '119' THEN RAISE EXCEPTION 'conflicting final overwritten'; END IF;
  IF (SELECT count(*) FROM sports_nba_history_attempts_v1) <> 3 THEN RAISE EXCEPTION 'attempts not append-only/idempotent'; END IF;
  IF (SELECT count(*) FROM sports_nba_history_attempts_v1 WHERE game_id=${literal(first.candidate.gameId)}) <> 2 THEN RAISE EXCEPTION 'failed attempts overwritten'; END IF;
  IF (SELECT count(*) FROM sports_nba_live_history_v1 WHERE game_id=${literal(second.candidate.gameId)}) <> 1 THEN RAISE EXCEPTION 'completed evidence missing'; END IF;
  IF (SELECT count(*) FROM sports_nba_history_candidates_v1 c LEFT JOIN sports_nba_live_history_v1 h ON h.game_id=c.game_id WHERE h.game_id IS NULL AND c.game_date <= '2026-10-07'::date) <> 2 THEN RAISE EXCEPTION 'backlog older than 3 days disappeared or completed retained'; END IF;
  IF (SELECT MIN(c.game_date) FROM sports_nba_history_candidates_v1 c LEFT JOIN sports_nba_live_history_v1 h ON h.game_id=c.game_id WHERE h.game_id IS NULL AND c.game_date <= '2026-10-07'::date) <> '2025-10-23'::date THEN RAISE EXCEPTION 'oldest pending date wrong'; END IF;
  IF (SELECT MAX(a.last_attempt_at) FROM sports_nba_history_candidates_v1 c LEFT JOIN sports_nba_live_history_v1 h ON h.game_id=c.game_id LEFT JOIN (SELECT game_id,MAX(attempted_at) AS last_attempt_at FROM sports_nba_history_attempts_v1 GROUP BY game_id) a ON a.game_id=c.game_id WHERE h.game_id IS NULL AND c.game_date <= '2026-10-07'::date) <> '2026-10-02T12:00:00Z'::timestamptz THEN RAISE EXCEPTION 'last attempt includes completed game'; END IF;
  IF (SELECT c.game_id FROM sports_nba_history_candidates_v1 c LEFT JOIN sports_nba_live_history_v1 h ON h.game_id=c.game_id LEFT JOIN (SELECT game_id,MAX(attempted_at) AS last_attempt_at FROM sports_nba_history_attempts_v1 GROUP BY game_id) a ON a.game_id=c.game_id WHERE h.game_id IS NULL AND c.game_date <= '2026-10-07'::date ORDER BY COALESCE(a.last_attempt_at,c.captured_at),c.game_date,c.game_id LIMIT 1) <> ${literal(third.candidate.gameId)} THEN RAISE EXCEPTION 'least-recently-attempted FIFO broken'; END IF;
 END $$;`);
}else{
 assert.equal(createAttempts,4,'Queue schema is coalesced, plus independently initialized live-history schema');
 const db2=async(parts,...values)=>db(parts,...values);await loadPendingNbaHistory({throughDate:'2026-10-07'},{sql:db2,now});assert.equal(createAttempts,7,'Different SQL clients initialize separately');
 const retryDb=async(parts,...values)=>db(parts,...values);failOnce=true;
 await assert.rejects(()=>loadPendingNbaHistory({throughDate:'2026-10-07'},{sql:retryDb,now}));
 await loadPendingNbaHistory({throughDate:'2026-10-07'},{sql:retryDb,now});assert.equal(createAttempts,11,'A failed schema promise is cleared and retried');
 for(const invalid of [{...attemptOne,candidateRevision:'0'.repeat(64)},{...attemptOne,gameId:'nba:espn:game:999999999'},{...attemptOne,attemptedAt:'2025-10-23T01:00:00Z'},{...attemptOne,attemptedAt:'2026-10-08T12:00:00Z'}])await assert.rejects(()=>saveNbaHistoryAttempt(invalid,{sql:db,now}),error=>error.code==='NBA_HISTORY_QUEUE_INVALID');
 await assert.rejects(()=>loadPendingNbaHistory({throughDate:'2099-01-01'},{sql:db,now}),error=>error.code==='NBA_HISTORY_QUEUE_INVALID');
  await assert.rejects(()=>readNbaHistoryQueueStatus({throughDate:'2099-01-01'},{sql:db,now}),error=>error.code==='NBA_HISTORY_QUEUE_INVALID');
 candidates.get(first.candidate.gameId).payload.game.home.score++;
 await assert.rejects(()=>loadPendingNbaHistory({throughDate:'2026-10-07'},{sql:db,now}),error=>error.code==='NBA_HISTORY_QUEUE_INVALID');
 assert.ok(statements.every(statement=>!/^\s*(?:UPDATE|DELETE|TRUNCATE|DROP)\b/.test(statement)));
 console.log('NBA retry queue SQL transport: immutable first final, append-only attempts, three-day-old backlog, FIFO, completed exclusion, schema isolation/retry PASS (not live PostgreSQL)');
}
