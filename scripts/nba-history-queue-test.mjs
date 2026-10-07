import assert from 'node:assert/strict';
import {buildNbaHistoryCandidate,validateNbaHistoryCandidate,NBA_HISTORY_QUEUE_SCHEMA,NBA_HISTORY_ATTEMPTS_SCHEMA} from '../lib/nba/history-queue-store.js';
import {createLiveHistoryFixture} from './fixtures/nba-live-history-fixture.mjs';

const fixture=createLiveHistoryFixture(),{result,now}=fixture;
const source={...result.sources[0],url:'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20251023'};
const game=result.data.game;
const candidate=buildNbaHistoryCandidate(game,[source],{now});
assert.equal(validateNbaHistoryCandidate(candidate,now),candidate);
assert.equal(candidate.kind,'NBA_PROVIDER_FINAL_PENDING_OFFICIAL');
assert.equal(candidate.modelInputEnabled,false);assert.equal(candidate.strictPointInTime,false);
assert.equal(candidate.gameId,game.id);assert.equal(candidate.game.home.score,119);assert.equal(candidate.game.away.score,111);
assert.equal(candidate.game.home.periodScores,undefined,'A pending scoreboard final is not a validated half-score model input');
assert.equal(candidate.game.home.statistics,undefined,'The retry queue retains identity/final evidence only, not redundant player boxes');
assert.ok(/^[a-f0-9]{64}$/.test(candidate.recordHash));assert.ok(/^[a-f0-9]{64}$/.test(candidate.identityHash));
const another=buildNbaHistoryCandidate(game,[source],{now:now+100});
assert.equal(another.identityHash,candidate.identityHash);assert.notEqual(another.recordHash,candidate.recordHash,'Actual later acquisition times are not backdated');
for(const mutate of [
 bad=>bad.game.league='NHL',bad=>bad.game.status='live',bad=>bad.game.completed=false,bad=>bad.game.timeConfirmed=false,
 bad=>bad.game.sourceId='1',bad=>bad.game.taipeiDate='2025-10-24',bad=>bad.game.season.year='2026',
 bad=>bad.game.season.type='postseason',bad=>bad.game.neutralSite='false',bad=>bad.game.home.league='MLB',
 bad=>bad.game.home.abbreviation='BOS',bad=>bad.game.away.id=bad.game.home.id,bad=>bad.game.home.score=bad.game.away.score,
 bad=>bad.game.home.score=-1,bad=>bad.game.home.score=119.5,
 bad=>bad.sources[0].hash=null,bad=>bad.sources[0].provider='NBA',bad=>bad.sources[0].status='stale',
 bad=>bad.sources[0].url='https://example.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20251023',
 bad=>bad.sources[0].url='https://user:password@site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
 bad=>bad.sources[0].url='https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401809234',
 bad=>bad.sources[0].fetchedAt=new Date(now+1).toISOString(),
 bad=>bad.sources[0].fetchedAt=new Date(now-900001).toISOString(),
 ]){
 const bad={game:structuredClone(game),sources:[structuredClone(source)]};mutate(bad);
 assert.throws(()=>buildNbaHistoryCandidate(bad.game,bad.sources,{now}),error=>error.code==='NBA_HISTORY_QUEUE_INVALID');
}
for(const mutate of [bad=>bad.modelInputEnabled=true,bad=>bad.strictPointInTime=true,bad=>bad.game.home.score++,bad=>bad.recordHash='0'.repeat(64),bad=>bad.identityHash='0'.repeat(64),bad=>bad.lastAttemptAt=new Date(now+1).toISOString()]){
 const bad=structuredClone(candidate);mutate(bad);assert.throws(()=>validateNbaHistoryCandidate(bad,now),error=>error.code==='NBA_HISTORY_QUEUE_INVALID');
}
assert.throws(()=>validateNbaHistoryCandidate(another,now),error=>error.code==='NBA_HISTORY_QUEUE_INVALID');
assert.equal(validateNbaHistoryCandidate({...candidate,revision:candidate.recordHash,lastAttemptAt:new Date(now).toISOString()},now).revision,candidate.recordHash);
assert.ok(NBA_HISTORY_QUEUE_SCHEMA.includes('game_id TEXT PRIMARY KEY'));
assert.ok(NBA_HISTORY_ATTEMPTS_SCHEMA.includes('attempt_hash TEXT PRIMARY KEY'));
assert.ok(NBA_HISTORY_ATTEMPTS_SCHEMA.includes('REFERENCES sports_nba_history_candidates_v1(game_id)'));
console.log('NBA retry candidates: immutable evidence hashes, final-only identity, source freshness/time, compact non-model queue and no fabricated PIT PASS');
