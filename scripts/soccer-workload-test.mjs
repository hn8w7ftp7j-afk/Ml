import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchSoccerWorkload, normalizeSoccerTeamWorkload } from '../lib/soccer/workload.js';
import { fetchSoccerJson } from '../lib/soccer/data.js';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/soccer/${name}.json`, import.meta.url)));
const results = fixture('workload-results'), fixtures = fixture('workload-fixtures');
const at = Date.parse('2026-10-19T00:00:00Z');
const game = { id: 'soccer:epl:401878768', sourceId: '401878768', league: 'epl', startTime: '2026-10-24T14:00:00Z', home: { sourceId: '359' }, away: { sourceId: '368' } };
const source = kind => ({ provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/359/schedule?season=2026${kind === 'fixtures' ? '&fixture=true' : ''}`, fetchedAt: '2026-10-18T23:59:59Z' });
const observations = () => [{ data: structuredClone(results), source: source('results'), kind: 'results', season: 2026 }, { data: structuredClone(fixtures), source: source('fixtures'), kind: 'fixtures', season: 2026 }];
const normalize = obs => normalizeSoccerTeamWorkload(obs, game.home, game, at);

const actual = normalize(observations());
assert.equal(actual.ok, true);
assert.equal(actual.completedMatchesLast7Days, 2);
assert.equal(actual.completedMatchesLast14Days, 3);
assert.equal(actual.lastKnownCompleted.eventId, '401878769');
assert.equal(actual.kickoffGapHoursFromLastCompleted, 142.5);
assert.equal(actual.elapsedHoursSinceLastCompletedKickoff, 8.5);
assert.equal(actual.actualRestHours, null, 'kickoff gap is not actual recovery time');
assert.deepEqual(actual.scheduledBeforeTarget.map(e => e.eventId), ['401915312']);
assert.ok(actual.scheduledBeforeTarget.every(e => e.status === 'SCHEDULED'));
assert.ok(actual.recentCompleted.every(e => e.status === 'COMPLETED'));
assert.ok(actual.coverage.distinctCompetitions.includes('uefa.champions'));
assert.ok(actual.coverage.distinctCompetitions.includes('eng.league_cup'));
assert.equal(actual.coverage.complete, false);
assert.equal(actual.coverage.playerMinutesComplete, false);
assert.equal(actual.pointInTimeAvailabilityVerified, false);
assert.equal(actual.modelEffectApplied, false);
assert.ok(actual.recentCompleted.every(e => e.playerMinutes === null));
assert.ok(![...actual.recentCompleted, ...actual.scheduledAhead].some(e => e.eventId === game.sourceId), 'target match must not count as its own workload');
// A long gap in European fixtures must survive newer domestic matches.
const longGapInputs=observations();
const european=longGapInputs[0].data.events.find(event=>event.league.slug==='uefa.champions');
assert.ok(european,'fixture has a completed European match');
european.date=european.competitions[0].date=new Date(at-21*86400000).toISOString();
const longGap=normalize(longGapInputs);
assert.equal(longGap.ok,true);
assert.equal(longGap.lastKnownCompletedByCompetition['uefa.champions'].eventId,String(european.id));
assert.notEqual(longGap.lastKnownCompleted.eventId,String(european.id));
assert.ok(!longGap.recentCompleted.some(record=>record.eventId===String(european.id)));
assert.equal(longGap.coverage.complete,false);
const plansOnly = normalize(observations().filter(o => o.kind === 'fixtures'));
assert.equal(plansOnly.completedMatchesLast7Days, null, 'fixture plans alone cannot establish zero completed workload');
assert.equal(plansOnly.coverage.resultsObserved, false);

const mixed = observations();
mixed[0].data.events[0].competitions[0].competitors.find(t => t.team.id === '359').team.id = '999';
assert.equal(normalize(mixed).code, 'SOCCER_WORKLOAD_COMPETITORS_INVALID');
const foreignTeam = observations(); foreignTeam[0].data.team.id = '999';
assert.equal(normalize(foreignTeam).code, 'SOCCER_WORKLOAD_TEAM_SCHEMA_INVALID');
const badLeague = observations(); badLeague[0].data.events[0].league = { id: '700', slug: '../nba' };
assert.equal(normalize(badLeague).code, 'SOCCER_WORKLOAD_EVENT_SCHEMA_INVALID');
const badUid = observations(); badUid[0].data.events[0].uid = 's:600~l:775~e:401878769';
assert.equal(normalize(badUid).code, 'SOCCER_WORKLOAD_EVENT_IDENTITY_INVALID');
const naive = observations(); naive[0].data.events[0].date = '2026-10-18T15:30';
assert.equal(normalize(naive).code, 'SOCCER_WORKLOAD_START_INVALID');
const futureSource = observations(); futureSource[1].source.fetchedAt = '2026-10-19T00:00:01Z';
assert.equal(normalize(futureSource).code, 'SOCCER_WORKLOAD_SOURCE_AFTER_CUTOFF');
const conflicting = observations(); conflicting[0].data.events.push(structuredClone(conflicting[0].data.events[0])); conflicting[0].data.events.at(-1).competitions[0].neutralSite = true;
assert.equal(normalize(conflicting).code, 'SOCCER_WORKLOAD_EVENT_REVISION_CONFLICT');
const noTime = observations(); noTime[0].data.events[0].timeValid = false;
assert.equal(normalize(noTime).completedMatchesLast7Days, 1);
assert.ok(normalize(noTime).excluded.some(e => e.reason === 'START_TIME_UNCONFIRMED'));
const awarded = observations(); awarded[0].data.events[0].competitions[0].status.type.name = 'STATUS_AWARDED';
assert.equal(normalize(awarded).completedMatchesLast7Days, 1, 'awarded scores do not establish physical participation');
const futureFinal = observations(); const e = futureFinal[0].data.events[0]; e.date = e.competitions[0].date = '2026-10-20T15:30Z';
assert.equal(normalize(futureFinal).completedMatchesLast7Days, 1);
assert.ok(normalize(futureFinal).excluded.some(e => e.reason === 'COMPLETED_START_NOT_BEFORE_REFERENCE'));

let requests = 0, summaryRequests = 0;
const fetchImpl = async url => {
  if (url.includes('/summary?')) { summaryRequests++; return { ok: false, status: 503 }; }
  requests++;
  if (url.includes('/368/')) return { ok: false, status: 503 };
  const data = structuredClone(url.includes('fixture=true') ? fixtures : results);
  if (url.includes('season=2025')) { data.requestedSeason.year = 2025; data.events = []; }
  return { ok: true, url, json: async () => data };
};
const fetched = await fetchSoccerWorkload(game, { fetchImpl, now: () => at });
assert.equal(fetched.ok, true);
assert.equal(fetched.status, 'INCOMPLETE');
assert.equal(fetched.teams.home.ok, true);
assert.equal(fetched.teams.away.code, 'SOCCER_SOURCE_HTTP_ERROR');
assert.equal(requests, 6);
assert.equal(summaryRequests, 3, 'recent player summaries are attempted independently of the six team schedule reads');
assert.equal(fetched.teams.home.playerWorkload.ok, false);
assert.equal(fetched.teams.home.playerWorkload.players.length, 0, 'failed player data is unknown, not invented zero minutes');
assert.equal(fetched.teams.home.playerWorkload.omissions.length, 3);
await fetchSoccerWorkload(game, { fetchImpl, now: () => at });
assert.equal(requests, 6, 'per-endpoint positive and short negative caches prevent duplicate refreshes');
const partial = await fetchSoccerWorkload(game, { now: () => at, fetchImpl: async url => url.includes('season=2025') ? { ok: false, status: 503 } : { ok: true, url, json: async () => url.includes('/359/') ? structuredClone(url.includes('fixture=true') ? fixtures : results) : { status: 'success', team: { id: '368' }, events: [] } } });
assert.equal(partial.teams.home.ok, true, 'an unavailable extra season does not erase valid acquired observations');
assert.equal(partial.teams.home.completedMatchesLast14Days, 3);
assert.equal(partial.teams.home.coverage.missingRequests, 1);
assert.equal(partial.status, 'INCOMPLETE');

let active = 0, maxActive = 0, count = 0;
const boundedFetch = async url => {
  active++; maxActive = Math.max(maxActive, active); count++;
  await new Promise(resolve => setTimeout(resolve, 3));
  active--;
  const parsed = new URL(url), teamId = parsed.pathname.match(/teams\/(\d+)/)[1], year = Number(parsed.searchParams.get('season'));
  return { ok: true, url, json: async () => ({ status: 'success', team: { id: teamId }, requestedSeason: { year }, events: [] }) };
};
const july = { ...game, startTime: '2026-07-05T14:00:00Z' };
const boundary = await fetchSoccerWorkload(july, { fetchImpl: boundedFetch, now: () => Date.parse('2026-07-02T00:00:00Z') });
assert.equal(count, 6, 'current and previous year labels cover different league season conventions without assuming every UCL club changes season in July');
assert.ok(maxActive <= 4);
assert.equal(boundary.ok, true);
assert.equal(boundary.teams.home.completedMatchesLast14Days, 0);
assert.equal(boundary.teams.home.lastKnownCompleted, null);
assert.equal(boundary.teams.home.coverage.complete, false, 'an empty provider response does not prove no workload');
assert.equal((await fetchSoccerWorkload(game, { timeoutMs: 0 })).code, 'SOCCER_WORKLOAD_FETCH_OPTIONS_INVALID');
assert.equal((await fetchSoccerWorkload({ ...game, away: { sourceId: 359 } })).code, 'SOCCER_WORKLOAD_REQUEST_INVALID');
const timeout = await fetchSoccerWorkload(game, { now: () => at, timeoutMs: 3, fetchImpl: () => new Promise(() => {}) });
assert.equal(timeout.ok, false);
assert.equal(timeout.teams.home.code, 'SOCCER_WORKLOAD_BUDGET_EXCEEDED', 'timeoutMs bounds the whole workload operation');

// Exercise the complete schedule -> exact source summary -> observed player path
// with the repository's genuine Brentford/Arsenal regulation-minute fixture.
const minutesPast = fixture('minutes-past'), prior = minutesPast.header.competitions[0];
const minuteAt = Date.parse('2025-01-02T12:00:00Z');
const nextGame = { id: 'soccer:epl:999001', sourceId: '999001', league: 'epl', startTime: '2025-01-03T17:30:00Z', home: { sourceId: '337' }, away: { sourceId: '359' } };
let playerSummaryReads = 0;
const withActualSummary = await fetchSoccerWorkload(nextGame, { now: () => minuteAt, fetchImpl: async url => {
  if (url.includes('/summary?')) { playerSummaryReads++; assert.ok(url.endsWith('/eng.1/summary?event=704467')); return { ok: true, url, json: async () => structuredClone(minutesPast) }; }
  const parsed = new URL(url), teamId = parsed.pathname.match(/teams\/(\d+)/)[1], season = Number(parsed.searchParams.get('season'));
  const events = parsed.searchParams.has('fixture') || season !== 2025 ? [] : [{ id: minutesPast.header.id, uid: minutesPast.header.uid, date: prior.date, league: minutesPast.header.league, competitions: [prior] }];
  return { ok: true, url, json: async () => ({ status: 'success', team: { id: teamId }, requestedSeason: { year: season }, events }) };
} });
assert.equal(withActualSummary.gameId,nextGame.id);
assert.deepEqual(withActualSummary.target,{id:nextGame.id,sourceId:nextGame.sourceId,league:nextGame.league,date:nextGame.date,startTime:nextGame.startTime,
  home:{sourceId:nextGame.home.sourceId},away:{sourceId:nextGame.away.sourceId}});
assert.equal(playerSummaryReads, 1, 'shared historical event summaries coalesce across the two teams');
for (const side of ['home', 'away']) {
  const observed = withActualSummary.teams[side].playerWorkload;
  assert.equal(observed.ok, true); assert.equal(observed.coverage.verifiedMatches, 1); assert.equal(observed.coverage.complete, false);
  assert.equal(observed.sourceId, nextGame[side].sourceId); assert.equal(observed.matches[0].teamPlayerMinutes, 990);
  assert.ok(observed.players.length >= 11); assert.equal(observed.modelEffectApplied, false); assert.equal(observed.executable, false);
  assert.equal(withActualSummary.teams[side].actualRestHours, null);
  assert.ok(withActualSummary.sources.some(source => source.url.endsWith('/summary?event=704467') && /^[a-f0-9]{64}$/.test(source.contentHash)));
}

// Verify orchestration forwards the target competition into bounded selection.
// The real retained EPL squad remains observable behind four newer cup games.
const crowdedAt=minuteAt+12*3600000,crowdedGame={...nextGame,startTime:'2025-01-04T17:30:00Z'};
const cupEvents=Array.from({length:4},(_,index)=>{
  const eventId=String(830000+index),date=new Date(crowdedAt-(index+1)*3*3600000).toISOString();
  return{id:eventId,uid:`s:600~l:41~e:${eventId}`,date,league:{id:'41',slug:'eng.league_cup'},
    competitions:[{...structuredClone(prior),id:eventId,uid:`s:600~l:41~e:${eventId}~c:${eventId}`,date}]};
});
const crowdedSummaryReads=[];
const crowded=await fetchSoccerWorkload(crowdedGame,{now:()=>crowdedAt,fetchImpl:async url=>{
  if(url.includes('/summary?')){crowdedSummaryReads.push(url);return url.endsWith('/eng.1/summary?event=704467')
    ?{ok:true,url,json:async()=>structuredClone(minutesPast)}:{ok:false,status:503};}
  const parsed=new URL(url),teamId=parsed.pathname.match(/teams\/(\d+)/)[1],season=Number(parsed.searchParams.get('season'));
  const events=parsed.searchParams.has('fixture')||season!==2025?[]:[...cupEvents,
    {id:minutesPast.header.id,uid:minutesPast.header.uid,date:prior.date,league:minutesPast.header.league,competitions:[prior]}];
  return{ok:true,url,json:async()=>({status:'success',team:{id:teamId},requestedSeason:{year:season},events})};
}});
assert.equal(crowdedSummaryReads.length,4,'priority preserves the four-summary limit and shared team reads');
assert.ok(crowdedSummaryReads.some(url=>url.endsWith('/eng.1/summary?event=704467')));
for(const side of['home','away']){
  assert.equal(crowded.teams[side].recentCompleted.length,5);
  assert.equal(crowded.teams[side].playerWorkload.matches[0].eventId,'704467');
  assert.equal(crowded.teams[side].playerWorkload.coverage.verifiedMatches,1);
  assert.equal(crowded.teams[side].playerWorkload.coverage.complete,false);
}

// A previous caller's long-lived producer must not override this consumer's
// own deadline, and this consumer must not abort or replace the shared read.
{
  const url = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/359/schedule?season=2026';
  let release, aborted = false, sharedCalls = 0, producerFinished = false, watchdog;
  const sharedFetch = async (requested, { signal }) => {
    if (requested === url) {
      sharedCalls++; signal.addEventListener('abort', () => { aborted = true; });
      await new Promise(resolve => { release = resolve; });
      return { ok: true, url: requested, json: async () => structuredClone(results) };
    }
    const parsed = new URL(requested), teamId = parsed.pathname.match(/teams\/(\d+)/)[1], season = Number(parsed.searchParams.get('season'));
    return { ok: true, url: requested, json: async () => ({ status: 'success', team: { id: teamId }, requestedSeason: { year: season }, events: [] }) };
  };
  const producer = fetchSoccerJson(url, { fetchImpl: sharedFetch, now: () => at, timeoutMs: 1000 });
  producer.then(() => { producerFinished = true; });
  try {
    const started = Date.now();
    const consumer = await Promise.race([
      fetchSoccerWorkload(game, { fetchImpl: sharedFetch, now: () => at, timeoutMs: 30, includePlayerMinutes: false }),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error('shared schedule ignored workload deadline')), 500); }),
    ]);
    assert.ok(Date.now() - started < 450);
    assert.equal(producerFinished, false); assert.equal(aborted, false); assert.equal(sharedCalls, 1);
    assert.equal(consumer.teams.home.ok, true, 'the other already-acquired team observations survive');
    const omitted = consumer.teams.home.retrievalFailures.find(row => row.kind === 'results' && row.requestedSeason === 2026);
    assert.equal(omitted.code, 'SOCCER_WORKLOAD_BUDGET_EXCEEDED'); assert.equal(omitted.attempted, true);
    assert.equal(omitted.source.fetchedAt, null); assert.equal(omitted.source.acquisitionStatus, 'NOT_ACQUIRED_BY_THIS_CONSUMER');
    assert.equal(consumer.status, 'INCOMPLETE');
  } finally { clearTimeout(watchdog); release(); }
  assert.equal((await producer).ok, true); assert.equal(aborted, false);
  const later = await fetchSoccerWorkload(game, { fetchImpl: sharedFetch, now: () => at, includePlayerMinutes: false });
  assert.equal(later.teams.home.completedMatchesLast14Days, 3); assert.equal(sharedCalls, 1, 'the producer result remains reusable');
}

// Fixture acquisition and player summaries share one operation budget. The
// unchanged shared summary producer has a longer independent lifetime.
{
  const summaryUrl = 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=704467';
  let release, aborted = false, calls = 0, finished = false, watchdog;
  const stageFetch = async (url, { signal }) => {
    if (url === summaryUrl) {
      calls++; signal.addEventListener('abort', () => { aborted = true; });
      await new Promise(resolve => { release = resolve; });
      return { ok: true, url, json: async () => structuredClone(minutesPast) };
    }
    const parsed = new URL(url), teamId = parsed.pathname.match(/teams\/(\d+)/)[1], season = Number(parsed.searchParams.get('season'));
    if (season === 2025 || parsed.searchParams.has('fixture')) await new Promise(resolve => setTimeout(resolve, 200));
    const events = parsed.searchParams.has('fixture') || season !== 2025 ? [] : [{ id: minutesPast.header.id, uid: minutesPast.header.uid, date: prior.date, league: minutesPast.header.league, competitions: [prior] }];
    return { ok: true, url, json: async () => ({ status: 'success', team: { id: teamId }, requestedSeason: { year: season }, events }) };
  };
  const producer = fetchSoccerJson(summaryUrl, { fetchImpl: stageFetch, now: () => minuteAt, timeoutMs: 1500 });
  producer.then(() => { finished = true; });
  try {
    const started = Date.now();
    const consumer = await Promise.race([
      fetchSoccerWorkload(nextGame, { fetchImpl: stageFetch, now: () => minuteAt, timeoutMs: 350 }),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error('player stage received a fresh operation budget')), 500); }),
    ]);
    assert.ok(Date.now() - started < 480, 'the player stage must fit inside the original 350ms budget');
    assert.equal(finished, false); assert.equal(aborted, false); assert.equal(calls, 1);
    for (const side of ['home', 'away']) {
      assert.equal(consumer.teams[side].ok, true); assert.equal(consumer.teams[side].recentCompleted.length, 1);
      const players = consumer.teams[side].playerWorkload;
      assert.equal(players.ok, false); assert.equal(players.omissions[0].reason, 'SOCCER_PLAYER_BUDGET_EXCEEDED');
      assert.equal(players.coverage.attemptedMatches, 1); assert.equal(players.coverage.verifiedMatches, 0);
      assert.equal(players.omissions[0].source.fetchedAt, null);
    }
  } finally { clearTimeout(watchdog); release(); }
  assert.equal((await producer).ok, true); assert.equal(aborted, false);
}

console.log('PASS all-competition workload: actual multi-league source schema, source/time/identity guards, observed fixtures retained on omissions, whole-operation schedule/player deadline, shared-producer lifetime isolation, cache reuse, partial-source failure, season boundary and concurrency bounds; no model change');
