import assert from 'node:assert/strict';
import {buildNbaLiveHistoryRow, validateNbaLiveHistoryRow} from '../lib/nba/live-history.js';
import {syncNbaLiveHistory} from '../lib/nba/live-history-service.js';
import {createLiveHistoryFixture, resealLiveHistoryFixture} from './fixtures/nba-live-history-fixture.mjs';

const fixture = createLiveHistoryFixture(), {row,result,official,now} = fixture;
assert.equal(validateNbaLiveHistoryRow(row,now),row);
assert.equal(row.homeHalf,65); assert.equal(row.awayHalf,50); assert.notEqual(row.homeHalf,row.homeScore/2);
assert.equal(row.strictPointInTime,false); assert.equal(row.paceOfficialMetric,false);
const partial = {...official,status:'partial',players:[],missingPlayers:[{reason:'identity unavailable'}]};
assert.equal(buildNbaLiveHistoryRow(result,partial,{now}).official.status,'partial','Team+score official checks remain valid when player identities are outside training scope');
for (const mutate of [
  bad => bad.game.status = 'live',
  bad => bad.game.home.id = 'nba:espn:team:5',
  bad => bad.game.season.type = 'postseason',
  bad => bad.game.home.periodScores.pop(),
  bad => bad.game.home.periodScores[0].score += 1,
  bad => bad.homeHalf = bad.homeScore / 2,
  bad => bad.pace += 1,
  bad => bad.paceOfficialMetric = true,
  bad => bad.official.status = 'unavailable',
  bad => bad.official.teams[0].providerId = bad.official.teams[1].providerId,
  bad => bad.official.teams[0].officialId = bad.official.teams[1].officialId,
  bad => bad.officialGameId = bad.official.officialGameId = '0052500003',
  bad => bad.officialGameId = bad.official.officialGameId = '0022400003',
  bad => bad.game.name = 'NBA Cup Final',
  bad => bad.capturedAt = new Date(now+1).toISOString(),
  bad => bad.sources[0].fetchedAt = new Date(now-900001).toISOString(),
  bad => bad.sources[0].fetchedAt = new Date(now+1).toISOString(),
  bad => bad.sources[0].url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=1',
  bad => bad.sources[0].status = 'stale',
  bad => bad.sources[1].url = 'https://www.nba.com/games?date=2025-10-25',
  bad => bad.sources[2].hash = null,
]) {const bad = structuredClone(row); mutate(bad); resealLiveHistoryFixture(bad); assert.throws(() => validateNbaLiveHistoryRow(bad,now),error => error.code === 'NBA_LIVE_HISTORY_INVALID');}
const corrupt = structuredClone(row); corrupt.game.name += 'corrupt'; assert.throws(() => validateNbaLiveHistoryRow(corrupt,now));
assert.throws(() => buildNbaLiveHistoryRow({...result,status:'partial'},official,{now}));
for (const name of ['NBA Cup Semifinals','NBA Cup Semi-Finals','NBA Cup Quarter Finals']) {const semifinal = structuredClone(row); semifinal.game.name=name; resealLiveHistoryFixture(semifinal); assert.equal(validateNbaLiveHistoryRow(semifinal,now),semifinal,'Regular-season Cup elimination games are not Cup finals');}

const memory = new Map(), calls = [];
const queue = new Map(), attempts = new Map();
const enqueue = async candidate => {const existing=queue.get(candidate.gameId);if(existing && existing.identityHash!==candidate.identityHash)throw Object.assign(Error('Candidate conflict'),{code:'NBA_HISTORY_CANDIDATE_CONFLICT'});if(!existing)queue.set(candidate.gameId,candidate);return {persisted:true,inserted:!existing,gameId:candidate.gameId,revision:existing?.recordHash || candidate.recordHash};};
const pending = async ({throughDate,limit}) => [...queue.values()].filter(candidate => !memory.has(candidate.gameId) && candidate.date<=throughDate).sort((a,b) => String(attempts.get(a.gameId)||a.capturedAt).localeCompare(String(attempts.get(b.gameId)||b.capturedAt)) || a.gameId.localeCompare(b.gameId)).slice(0,limit);
const attempt = async event => {attempts.set(event.gameId,event.attemptedAt);return {persisted:true};};
const store = async record => {
  const existing = memory.get(record.gameId);
  if (existing && existing.outcomeHash !== record.outcomeHash) throw Object.assign(Error('No overwrite'),{code:'NBA_LIVE_HISTORY_CONFLICT'});
  if (!existing) memory.set(record.gameId,record);
  return {persisted:true,inserted:!existing,gameId:record.gameId,revision:existing?.recordHash || record.recordHash,capturedAt:existing?.capturedAt || record.capturedAt};
};
const scheduleSource = {...result.sources[0],url:'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20251023'};
const options = {throughDate:row.date,lookbackDays:1,now,enqueue,pending,attempt,load:async query => {calls.push(query); return query.view === 'schedule' ? {status:'ready',qa:{status:'PASS'},sources:[scheduleSource],data:{games:[result.data.game]}} : result;},official:async () => official,store,list:async () => [...memory.values()]};
const synced = await syncNbaLiveHistory(options); assert.equal(synced.saved,1); assert.equal(synced.status,'ready'); assert.equal(synced.checked,1);
calls.length = 0;
const again = await syncNbaLiveHistory(options); assert.equal(again.existing,1); assert.equal(again.checked,0); assert.equal(calls.length,1,'Already verified final is not redownloaded');
const revisedBoardGame = structuredClone(result.data.game); revisedBoardGame.home.score++;
const revised = await syncNbaLiveHistory({...options,load:async () => ({status:'ready',qa:{status:'PASS'},sources:[scheduleSource],data:{games:[revisedBoardGame]}})});
assert.equal(revised.failed,1); assert.equal(revised.games[0].code,'NBA_LIVE_HISTORY_CONFLICT'); assert.equal(memory.get(row.gameId).homeScore,119,'Saved final is never overwritten by a changed schedule');
memory.clear(); calls.length = 0;
const fallback = await syncNbaLiveHistory({...options,load:async query => {calls.push(query); return query.view === 'game' ? {status:'unavailable',qa:{status:'BLOCK',issues:[{code:'PLAYER_IDENTITY_MISMATCH'}]}} : query.view === 'historical-team-box' ? {...result,data:{game:result.data.game,players:[]}} : options.load(query);}});
assert.equal(fallback.saved,1); assert.ok(calls.some(query => query.view === 'historical-team-box'));
memory.clear();
const unavailable = await syncNbaLiveHistory({...options,official:async () => ({status:'unavailable'})}); assert.equal(unavailable.failed,1); assert.equal(unavailable.saved,0); assert.equal(memory.size,0);
const weekLater = now+7*86400000, laterTime = new Date(weekLater).toISOString();
const laterResult = {...result,sources:result.sources.map(source => ({...source,fetchedAt:laterTime}))};
const laterOfficial = {...official,sources:official.sources.map(source => ({...source,fetchedAt:laterTime}))};
const recoveredOld = await syncNbaLiveHistory({...options,throughDate:'2025-10-30',now:weekLater,load:async query => query.view==='schedule'?{status:'empty',qa:{status:'PASS'},sources:[{...scheduleSource,fetchedAt:laterTime}],data:{games:[]}}:laterResult,official:async () => laterOfficial});
assert.equal(recoveredOld.saved,1); assert.equal(recoveredOld.discovered,0); assert.equal(recoveredOld.games[0].gameId,row.gameId,'A durable failure still retries outside the three-day discovery window');
memory.clear();
queue.clear(); attempts.clear();
const stale = await syncNbaLiveHistory({...options,load:async () => ({status:'partial',qa:{status:'WARNING'},sources:[{status:'stale'}],data:{games:[result.data.game]}})}); assert.equal(stale.status,'unavailable'); assert.equal(stale.checked,0);
const noDb = await syncNbaLiveHistory({...options,list:async () => {throw Error('database offline');}}); assert.equal(noDb.status,'unavailable'); assert.equal(noDb.checked,0);
const second = createLiveHistoryFixture({date:row.date,gameId:'401809235'});
const independent = await syncNbaLiveHistory({...options,limit:2,load:async query => query.view === 'schedule' ? {status:'ready',qa:{status:'PASS'},sources:[scheduleSource],data:{games:[result.data.game,second.result.data.game]}} : query.id === result.data.game.sourceId ? {...result,status:'unavailable'} : second.result,official:async () => second.official});
assert.equal(independent.failed,1); assert.equal(independent.saved,1); assert.equal(independent.status,'partial');
let elapsed = 0; const timeouts = [];
const budgeted = await syncNbaLiveHistory({...options,timeBudgetMs:5000,now:() => now+elapsed,list:async () => [],load:async (query,loadOptions) => {timeouts.push(loadOptions.timeoutMs); elapsed += 3000; return query.view === 'schedule' ? {status:'ready',qa:{status:'PASS'},sources:[scheduleSource],data:{games:[result.data.game]}} : result;}});
assert.deepEqual(timeouts,[1666,2000]); assert.equal(budgeted.saved,0); assert.equal(budgeted.games[0].code,'NBA_LIVE_HISTORY_TIME_BUDGET','Discovery gets at most one third; an exhausted total budget never initiates official requests');
await assert.rejects(() => syncNbaLiveHistory({...options,throughDate:'2099-01-01'}));
console.log('NBA live history: real final box, source hashes/freshness, identity/quarters, no fake PIT, fallback, persistence, independent failures and no-redownload tests passed');
