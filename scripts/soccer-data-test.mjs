// Synthetic source contracts, never treated as historical soccer model evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { SOCCER_CAPABILITIES, SOCCER_LEAGUES, publicSoccerLeagues, soccerDate, validSoccerDate, soccerCacheKey } from '../lib/soccer/contracts.js';
import { fetchSoccerJson, fetchSoccerSchedule, fetchSoccerStandings, normalizeSoccerEvent, normalizeSoccerSchedule, normalizeSoccerStandings } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { soccerObservationSource } from '../lib/soccer/source-evidence.js';
const source = { provider: 'ESPN', fetchedAt: '2026-10-18T00:00:00.000Z', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard' };
const competition = league => ({ id: SOCCER_LEAGUES[league].espnId, slug: SOCCER_LEAGUES[league].espnSlug });
const event = (overrides = {}) => ({ id: '401000001', date: '2026-10-17T16:00Z', status: { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED', shortDetail: '10/18 - 12:00 AM' } }, competitions: [{ competitors: [{ homeAway: 'home', team: { id: '1', displayName: 'Home fixture' }, score: '0' }, { homeAway: 'away', team: { id: '2', displayName: 'Away fixture' }, score: '0' }], venue: { fullName: 'Fixture venue' } }], ...overrides });
const board = (games = [event()], league = 'epl') => ({ leagues: [competition(league)], events: games });
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
let checks = 0;
const test = async (name, action) => { await action(); checks += 1; console.log(`PASS ${name}`); };

await test('Taipei date boundaries and calendar validation do not depend on server timezone', () => {
  assert.equal(soccerDate('2026-10-17T15:59:59Z'), '2026-10-17');
  assert.equal(soccerDate('2026-10-17T16:00:00Z'), '2026-10-18');
  assert.equal(validSoccerDate('2026-02-30'), false);
  assert.equal(validSoccerDate('2024-02-29'), true);
  assert.equal(validSoccerDate('2026-2-02'), false);
  assert.equal(soccerDate('garbage'), null);
});
await test('league registries and game/team/cache identity are isolated', () => {
  const a = normalizeSoccerSchedule(board(), 'epl', source), b = normalizeSoccerSchedule(board([event()], 'ucl'), 'ucl', source);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.notEqual(a.games[0].id, b.games[0].id);
  assert.notEqual(a.games[0].home.id, b.games[0].home.id);
  assert.notEqual(soccerCacheKey('epl', 'schedule', '2026-10-18'), soccerCacheKey('ucl', 'schedule', '2026-10-18'));
  assert.equal(normalizeSoccerSchedule(board(), 'ucl', source).code, 'SOCCER_LEAGUE_IDENTITY_MISMATCH');
  assert.equal(normalizeSoccerSchedule({ ...board(), leagues: [competition('epl'), competition('ucl')] }, 'epl', source).code, 'SOCCER_LEAGUE_IDENTITY_MISMATCH');
  assert.deepEqual(publicSoccerLeagues().map(item => item.id), ['EPL', 'UCL']);
  for (const field of ['model', 'ranking', 'betting']) assert.equal(SOCCER_CAPABILITIES[field], false);
});
await test('supplied provider UIDs cannot contradict the sport, league, event, competition or team identity', () => {
  const raw = event({ uid: 's:600~l:700~e:401000001' });
  raw.competitions[0].id = '401000001'; raw.competitions[0].uid = 's:600~l:700~e:401000001~c:401000001';
  raw.competitions[0].competitors[0].team.uid = 's:600~t:1';
  const valid = { leagues: [{ ...competition('epl'), uid: 's:600~l:700' }], events: [raw] };
  assert.equal(normalizeSoccerSchedule(valid, 'epl', source).ok, true);
  for (const uid of ['s:600~l:775~e:401000001', 's:40~l:700~e:401000001', 's:600~l:700~e:999', 's:600~l:700~l:775~e:401000001', 'broken']) {
    assert.equal(normalizeSoccerSchedule({ ...valid, events: [{ ...raw, uid }] }, 'epl', source).code, 'SOCCER_GAME_UID_IDENTITY_MISMATCH');
  }
  const competitionMismatch = structuredClone(raw); competitionMismatch.competitions[0].uid = 's:600~l:700~e:401000001~c:999';
  assert.equal(normalizeSoccerEvent(competitionMismatch, 'epl', source).code, 'SOCCER_GAME_UID_IDENTITY_MISMATCH');
  for (const uid of ['s:600~t:999', 's:40~t:1', 's:600~l:775~t:1']) {
    const teamMismatch = structuredClone(raw); teamMismatch.competitions[0].competitors[0].team.uid = uid;
    assert.equal(normalizeSoccerEvent(teamMismatch, 'epl', source).code, 'SOCCER_TEAM_IDENTITY_INVALID');
  }
  assert.equal(normalizeSoccerSchedule({ ...valid, leagues: [{ ...valid.leagues[0], uid: 's:600~l:775' }] }, 'epl', source).code, 'SOCCER_LEAGUE_IDENTITY_MISMATCH');
  assert.equal(normalizeSoccerSchedule(board(), 'epl', source).ok, true, 'absent UIDs are allowed within a verified league envelope');
});
await test('scheduled placeholder zeroes never become a scored result', () => {
  const game = normalizeSoccerSchedule(board(), 'epl', source).games[0];
  assert.equal(game.home.score, null); assert.equal(game.away.score, null);
  assert.equal(game.status, 'scheduled'); assert.equal(game.date, '2026-10-18');
  assert.equal(game.halfTime, null);
});
await test('final/live scores and explicit first half periods are validated', () => {
  const raw = event({ status: { period: 2, type: { state: 'post', completed: true, name: 'STATUS_FULL_TIME' } } });
  raw.competitions[0].competitors[0].score = '2';
  for (const side of raw.competitions[0].competitors) side.linescores = [{ period: 1, value: 0 }, { period: 2, value: 0 }];
  const result = normalizeSoccerEvent(raw, 'epl', source);
  assert.equal(result.game.status, 'final'); assert.equal(result.game.home.score, 2);
  assert.equal(result.game.halfTime.verified, true); assert.equal(result.game.halfTime.home, 0);
  raw.competitions[0].competitors[0].linescores[0].value = 3;
  assert.equal(normalizeSoccerEvent(raw, 'epl', source).game.halfTime, null);
  for (const score of [false, true, [], {}, ' ', '-1', '1.5']) { raw.competitions[0].competitors[0].score = score; assert.equal(normalizeSoccerEvent(raw, 'epl', source).code, 'SOCCER_SCORE_MISSING'); }
  raw.competitions[0].competitors[0].score = '';
  assert.equal(normalizeSoccerEvent(raw, 'epl', source).code, 'SOCCER_SCORE_MISSING');
  raw.status.type = { state: 'post', completed: true, name: 'STATUS_CANCELED' };
  assert.equal(normalizeSoccerEvent(raw, 'epl', source).game.home.score, null);
});
await test('malformed or conflicting identity blocks the whole board instead of silently dropping games', () => {
  assert.equal(normalizeSoccerSchedule({ events: [] }, 'epl', source).ok, false);
  assert.equal(normalizeSoccerSchedule({ ...board(), events: null }, 'epl', source).code, 'SOCCER_SCHEDULE_SCHEMA_INVALID');
  assert.equal(normalizeSoccerSchedule(board([event(), event({ id: 'bad' })]), 'epl', source).ok, false);
  assert.equal(normalizeSoccerEvent(event({ date: '2026-10-18T12:00:00' }), 'epl', source).code, 'SOCCER_GAME_START_INVALID');
  const duplicate = event(); duplicate.competitions[0].competitors[0].team.id = '999';
  assert.equal(normalizeSoccerSchedule(board([event(), duplicate]), 'epl', source).code, 'SOCCER_DUPLICATE_GAME_CONFLICT');
  const sameTeam = event(); sameTeam.competitions[0].competitors[1].team.id = '1';
  assert.equal(normalizeSoccerEvent(sameTeam, 'epl', source).code, 'SOCCER_TEAM_IDENTITY_INVALID');
});
await test('schedule covers UTC boundary then filters exactly by Taipei date and discovers upcoming dates', async () => {
  const requested = [];
  const fetchImpl = async url => { requested.push(url); return json(board([event({ id: '1', date: '2026-10-17T15:59Z' }), event({ id: '2' }), event({ id: '3', date: '2026-10-18T16:00Z' })])); };
  const result = await fetchSoccerSchedule('epl', '2026-10-18', { fetchImpl });
  assert.equal(result.ok, true); assert.equal(result.games.length, 1); assert.equal(result.games[0].sourceId, '2');
  assert.equal(requested.length, 2); assert.ok(requested.some(url => /dates=20261017$/.test(url))); assert.ok(requested.some(url => /dates=20261018$/.test(url))); assert.equal(requested.some(url => /dates=.*-/.test(url)), false);
  const upcoming = await fetchSoccerSchedule('epl', '2026-10-18', { fetchImpl, windowDays: 14 });
  assert.deepEqual(upcoming.availableDates, ['2026-10-18', '2026-10-19']);
  assert.equal(upcoming.until, '2026-10-31');
  const empty = await fetchSoccerSchedule('epl', '2026-10-18', { fetchImpl: async () => json(board([])) });
  assert.equal(empty.ok, true); assert.deepEqual(empty.games, []);
  assert.equal(empty.missing[0].reason, 'NO_SCHEDULED_EVENTS_IN_CONFIRMED_SOURCE_WINDOW');
});
await test('upcoming reads use at most four concurrent single days and require complete source coverage', async () => {
  let active = 0, maximum = 0, calls = 0;
  const result = await fetchSoccerSchedule('epl', '2026-10-18', { windowDays: 14, fetchImpl: async () => {
    active++; calls++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--; return json(board([]));
  } });
  assert.equal(result.ok, true); assert.equal(calls, 15); assert.equal(maximum, 4);
  assert.equal(result.coverage.complete, true); assert.equal(result.sources.length, 15);
  let failures = 0;
  const partial = await fetchSoccerSchedule('epl', '2026-10-18', { windowDays: 14, fetchImpl: async () => ++failures === 1 ? new Response('', { status: 503 }) : json(board([])) });
  assert.equal(partial.ok, false); assert.equal(partial.coverage.complete, false); assert.equal(Object.hasOwn(partial, 'games'), false); assert.ok(failures <= 4);
});
await test('HTTP source failure and timeout stay errors without a fabricated empty board', async () => {
  const unavailable = await fetchSoccerSchedule('ucl', '2026-10-18', { fetchImpl: async () => new Response('', { status: 429 }) });
  assert.equal(unavailable.ok, false); assert.equal(unavailable.code, 'SOCCER_SOURCE_RATE_LIMITED');
  assert.equal(Object.hasOwn(unavailable, 'games'), false);
  const timeout = await fetchSoccerJson(source.url, { fetchImpl: () => new Promise(() => {}), timeoutMs: 5 });
  assert.equal(timeout.code, 'SOCCER_SOURCE_TIMEOUT');
  const bodyTimeout = await fetchSoccerJson(source.url, { fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }), timeoutMs: 5 });
  assert.equal(bodyTimeout.code, 'SOCCER_SOURCE_TIMEOUT');
  const redirect = await fetchSoccerJson(source.url, { fetchImpl: async () => new Response('', { status: 302 }) });
  assert.equal(redirect.code, 'SOCCER_SOURCE_REDIRECT_REJECTED');
});
await test('source URLs are allowlisted and responses do not silently change provider', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return json({}); };
  for (const url of ['http://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard', 'https://evil.test/apis/site/v2/sports/soccer/eng.1/scoreboard', 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard', `${source.url}#wrong`]) assert.equal((await fetchSoccerJson(url, { fetchImpl })).ok, false);
  assert.equal(calls, 0);
  const mismatch = await fetchSoccerJson(source.url, { fetchImpl: async () => ({ ok: true, url: 'https://evil.test/', json: async () => ({}) }) });
  assert.equal(mismatch.code, 'SOCCER_SOURCE_RESPONSE_URL_MISMATCH');
});
await test('cache coalesces independent consumers and never leaks mutations or stale success', async () => {
  let calls = 0, clock = Date.parse('2026-10-18T00:00Z');
  const fetchImpl = async () => { calls++; return calls === 1 ? json(board()) : new Response('', { status: 503 }); };
  const options = { fetchImpl, now: () => clock, ttlMs: 100 };
  const [a, b] = await Promise.all([fetchSoccerJson(source.url, options), fetchSoccerJson(source.url, options)]);
  assert.equal(calls, 1); a.data.events[0].id = 'mutated'; assert.notEqual(b.data.events[0].id, 'mutated');
  assert.equal((await fetchSoccerJson(source.url, options)).data.events[0].id, '401000001');
  clock += 101;
  assert.equal((await fetchSoccerJson(source.url, options)).ok, false);
});
await test('standings preserve missing values and reject another league or duplicate team', async () => {
  const fixture = { id: '23', uid: 's:600~l:700', name: 'English Premier League', children: [{ name: 'Table', standings: { entries: [{ team: { id: '1', displayName: 'Home fixture' }, stats: [{ name: 'rank', value: 1 }, { name: 'points', value: 12 }, { name: 'gamesPlayed', value: 5 }] }] } }] };
  const result = normalizeSoccerStandings(fixture, 'epl', source);
  assert.equal(result.ok, true); assert.equal(result.standings[0].rows[0].points, 12);
  assert.equal(result.standings[0].rows[0].drawn, null);
  assert.equal(normalizeSoccerStandings(fixture, 'ucl', source).ok, false);
  assert.equal(normalizeSoccerStandings({ ...fixture, id: '700', uid: 's:600~l:775' }, 'epl', source).ok, false);
  const ucl = { ...structuredClone(fixture), id: '2', uid: 's:600~l:775', name: 'UEFA Champions League' };
  assert.equal(normalizeSoccerStandings(ucl, 'ucl', source).ok, true);
  ucl.children[0].uid = 's:600~l:700~g:1'; assert.equal(normalizeSoccerStandings(ucl, 'ucl', source).ok, false);
  const fetched = await fetchSoccerStandings('epl', { fetchImpl: async () => json(fixture) }); assert.equal(fetched.ok, true);
  fixture.children[0].standings.entries.push(fixture.children[0].standings.entries[0]);
  assert.equal(normalizeSoccerStandings(fixture, 'epl', source).ok, false);
});

// Retained provider schemas exercise the real producer. Added publication and
// medical records below are synthetic adapter contracts, never live evidence.
const summaryFixture=()=>JSON.parse(fs.readFileSync(new URL('./fixtures/soccer/lineup-announced.json',import.meta.url)));
const sourceHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const prematchNow=Date.parse('2026-10-18T14:50:00.000Z');
const summarySource=payload=>({provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${payload.header.id}`,
  requestedAt:'2026-10-18T14:49:59.000Z',fetchedAt:new Date(prematchNow).toISOString(),contentHash:sourceHash(payload)});
const summaryGame=(payload,meta=summarySource(payload))=>{
  const c=payload.header.competitions[0];
  return normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:c.date,status:c.status}]},'epl',meta).games[0];
};
await test('prematch producer distinguishes actual document fetch availability from unknown publication and independent confirmation',async()=>{
  const payload=summaryFixture(),before=JSON.stringify(payload),meta=summarySource(payload),game=summaryGame(payload,meta);
  const fetched=await fetchSoccerJson(meta.url,{fetchImpl:async()=>json(payload),now:()=>prematchNow,ttlMs:0});
  const evidence=normalizeSoccerPrematch(fetched.data,game,fetched.source,prematchNow);
  assert.equal(evidence.ok,true);assert.equal(evidence.observedAvailabilityVerified,true);
  assert.equal(evidence.source.availableAt,fetched.source.fetchedAt);
  assert.equal(evidence.source.availabilityBasis,'OBSERVED_FETCH_COMPLETION');
  assert.equal(evidence.sourcePublishedAt,undefined);assert.equal(evidence.source.sourcePublishedAt,null);
  assert.equal(evidence.sourceEvidence.contentHashVerified,true);assert.equal(evidence.sourceEvidence.sourceScopeVerified,true);
  assert.equal(evidence.pointInTimeAvailabilityVerified,false);assert.equal(evidence.historicalAvailabilityVerified,false);
  assert.equal(evidence.sourceEvidence.missingReason,'SOURCE_PUBLICATION_TIME_UNVERIFIED');
  assert.deepEqual(evidence.rawSource,fetched.source);
  for(const side of ['home','away']){
    const lineup=evidence.teams[side].lineup;
    assert.equal(lineup.starters.length,11);assert.equal(lineup.status,'PROVIDER_REPORTED_XI');
    assert.equal(lineup.independentlyConfirmed,false);assert.equal(lineup.sourcePublishedAt,null);
    assert.equal(lineup.source.availableAt,fetched.source.fetchedAt);assert.equal(lineup.source.scope.field,`teams.${side}.lineup`);
    assert.equal(lineup.source.contentHash,evidence.source.contentHash);assert.deepEqual(lineup.rawSource,fetched.source);
    assert.ok(lineup.starters.every(player=>player.sourcePublishedAt===null&&player.expectedMinutes===null));
  }
  assert.equal(JSON.stringify(payload),before,'normalization preserves original provider JSON/hash');
});
await test('publication and update timestamps remain field-local and never borrow kickoff, logos or article dates',()=>{
  const payload=summaryFixture();payload.publishedAt='2026-10-18T14:40:00Z';payload.lastUpdated='2026-10-18T14:48:00Z';
  payload.rosters[0].publishedAt='2026-10-18T14:45:00Z';payload.rosters[0].lastUpdated='2026-10-18T14:47:00Z';
  const evidence=normalizeSoccerPrematch(payload,summaryGame(payload),summarySource(payload),prematchNow);
  assert.equal(evidence.source.sourcePublishedAt,'2026-10-18T14:40:00.000Z');
  assert.equal(evidence.source.sourceUpdatedAt,'2026-10-18T14:48:00.000Z');
  assert.equal(evidence.pointInTimeAvailabilityVerified,true,'only the currently fetched document has source publication evidence');
  assert.equal(evidence.pointInTimeAvailabilityScope,'CURRENT_FETCHED_DOCUMENT_ONLY_NOT_HISTORICAL_ARCHIVE');
  assert.equal(evidence.historicalAvailabilityVerified,false);assert.equal(evidence.teams.home.lineup.independentlyConfirmed,false);
  const publishedSide=payload.rosters[0].homeAway,other=publishedSide==='home'?'away':'home';
  assert.equal(evidence.teams[publishedSide].lineup.sourcePublishedAt,'2026-10-18T14:45:00.000Z');
  assert.equal(evidence.teams[other].lineup.sourcePublishedAt,null,'document publication does not become lineup publication');
  assert.ok(evidence.teams[publishedSide].lineup.starters.every(player=>player.sourcePublishedAt===null));
  const updatedOnly=summaryFixture();updatedOnly.lastUpdated='2026-10-18T14:48:00Z';
  updatedOnly.news={articles:[{published:'2026-10-18T14:40:00Z'}]};
  const noPublication=normalizeSoccerPrematch(updatedOnly,summaryGame(updatedOnly),summarySource(updatedOnly),prematchNow);
  assert.equal(noPublication.source.sourceUpdatedAt,'2026-10-18T14:48:00.000Z');
  assert.equal(noPublication.source.sourcePublishedAt,null);assert.equal(noPublication.pointInTimeAvailabilityVerified,false);
});
await test('source hash/scope/fetch and invalid/future/conflicting publication evidence fail closed',()=>{
  const payload=summaryFixture();payload.publishedAt='2026-10-18T14:40:00Z';
  const meta=summarySource(payload),game=summaryGame(payload,meta);
  for(const patch of [{contentHash:'a'.repeat(64)},{url:meta.url.replace('eng.1','uefa.champions')},
    {url:meta.url+'&event=999'},{fetchedAt:'2026-10-18T14:50:01Z'},{requestedAt:'2026-10-18T14:50:01Z'},
    {availableAt:'2026-10-18T14:50:01Z'},{availableAt:'2026-10-18T14:49:59Z'}]){
    const evidence=normalizeSoccerPrematch(payload,game,{...meta,...patch},prematchNow);
    assert.equal(evidence.pointInTimeAvailabilityVerified,false);assert.equal(evidence.observedAvailabilityVerified,false);
  }
  for(const value of ['2026-10-18T14:50:01Z','2026-10-18T14:40:00','2026-02-30T14:40:00Z','bad']){
    const body={...payload,publishedAt:value},evidence=normalizeSoccerPrematch(body,game,summarySource(body),prematchNow);
    assert.equal(evidence.source.sourcePublishedAt,null);assert.equal(evidence.pointInTimeAvailabilityVerified,false);
  }
  const conflict={...payload,datePublished:'2026-10-18T14:41:00Z'};
  assert.equal(normalizeSoccerPrematch(conflict,game,summarySource(conflict),prematchNow).source.publicationStatus,'CONFLICTING_TIMESTAMPS');
  const supplied=soccerObservationSource({node:payload,payload,game,source:{...meta,sourcePublishedAt:'2026-10-18T14:40:00Z'},now:prematchNow});
  assert.equal(supplied.source.sourcePublishedAt,'2026-10-18T14:40:00.000Z');
  const conflictingAdapter=soccerObservationSource({node:payload,payload,game,source:{...meta,sourcePublishedAt:'2026-10-18T14:42:00Z'},now:prematchNow});
  assert.equal(conflictingAdapter.source.sourcePublishedAt,null);
  const laterAvailable=soccerObservationSource({node:payload,payload,game,source:{...meta,availableAt:'2026-10-18T14:50:00.500Z'},now:prematchNow+1000});
  assert.equal(laterAvailable.source.availableAt,'2026-10-18T14:50:00.500Z','a real later availability time is never moved back to fetch time');
  const final=JSON.parse(fs.readFileSync(new URL('./fixtures/soccer/historic-summary.json',import.meta.url)));
  final.publishedAt='2026-10-18T14:40:00Z';
  assert.equal(normalizeSoccerPrematch(final,summaryGame(final),summarySource(final),prematchNow).pointInTimeAvailabilityVerified,false,'a poststart document is never historical prematch PIT');
});
await test('available injury/suspension records preserve scoped provider metadata without claiming complete eligibility or minutes',()=>{
  const payload=summaryFixture(),home=payload.rosters.find(row=>row.homeAway==='home'),away=payload.rosters.find(row=>row.homeAway==='away');
  const injury={athlete:{id:'9999001',displayName:'Synthetic injured player'},status:'Out',date:'2026-10-15T00:00:00Z',details:{type:'Knee',returnDate:'2026-11-01'}};
  payload.injuries=[{team:{id:home.team.id},publishedAt:'2026-10-18T14:42:00Z',injuries:[injury]}];
  payload.suspensions=[{team:{id:home.team.id},suspensions:[]}];
  away.suspensions=[{athlete:{id:'9999002',displayName:'Synthetic suspended player'},status:'Suspended',updatedAt:'2026-10-18T14:43:00Z'}];
  const normalize=body=>normalizeSoccerPrematch(body,summaryGame(body),summarySource(body),prematchNow);
  const evidence=normalize(payload),observed=evidence.teams.home.injuries;
  assert.equal(observed.status,'PROVIDER_REPORTED');assert.equal(observed.value.length,1);
  assert.equal(observed.sourcePublishedAt,'2026-10-18T14:42:00.000Z');
  assert.equal(observed.value[0].reportedDate,injury.date);assert.equal(observed.value[0].sourcePublishedAt,null,'injury record date is not publication');
  assert.equal(observed.value[0].source.scope.field,'teams.home.injuries.9999001');
  assert.equal(observed.coverage,'PROVIDER_LIST_ONLY_NOT_COMPLETE_ELIGIBILITY');assert.equal(observed.independentlyConfirmed,false);
  assert.equal(evidence.teams.away.injuries.status,'UNKNOWN','one team cannot establish another team coverage');
  assert.deepEqual(evidence.teams.home.suspensions.value,[]);assert.equal(evidence.teams.home.suspensions.status,'PROVIDER_REPORTED');
  assert.equal(evidence.teams.away.suspensions.value[0].source.sourceUpdatedAt,'2026-10-18T14:43:00.000Z');
  assert.equal(evidence.teams.away.suspensions.value[0].sourcePublishedAt,null);
  assert.equal(evidence.teams.home.minutes.status,'UNKNOWN');assert.equal(evidence.teams.home.injuries.modelEffectApplied,false);
  for(const change of [body=>body.injuries[0].injuries.push(structuredClone(injury)),
    body=>{body.injuries[0].injuries[0].team={id:away.team.id};},body=>{body.injuries[0].injuries={};}]){
    const body=structuredClone(payload);change(body);assert.equal(normalize(body).teams.home.injuries.status,'UNKNOWN');
  }
  const cross=structuredClone(payload);cross.injuries.push({team:{id:away.team.id},injuries:[structuredClone(injury)]});
  assert.equal(normalize(cross).teams.home.injuries.reason,'INJURY_CROSS_TEAM_PLAYER_CONFLICT');
  assert.equal(normalize(cross).teams.away.injuries.status,'UNKNOWN');
});
console.log(`Soccer data contracts: ${checks} checks passed. Live provider and historical model validation are separate.`);

// Run with the repository's next-route-test-loader and --api to exercise the real route.
if (process.argv.includes('--api')) {
  const { GET } = await import('../app/api/soccer/route.js');
  const { createSessionToken } = await import('../lib/security.js');
  const originalFetch = globalThis.fetch, password = process.env.APP_PASSWORD, secret = process.env.SESSION_SECRET;
  process.env.APP_PASSWORD = 'soccer-local-contract-fixture'; process.env.SESSION_SECRET = 'soccer-local-contract-fixture-secret';
  try {
    const cookie = `mlb_session=${await createSessionToken()}`;
    const request = (query, authenticated = true) => new Request(`http://localhost/api/soccer?${query}`, { headers: authenticated ? { cookie } : {} });
    await test('API rejects unauthenticated or ambiguous scope before contacting providers', async () => {
      let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('must not contact provider'); };
      assert.equal((await GET(request('league=epl', false))).status, 401);
      for (const query of ['league=nhl', 'league=epl&date=2026-02-30', 'league=ucl&view=unknown', 'league=epl&league=ucl', 'league=epl&date=2026-10-18&date=2026-10-19']) assert.equal((await GET(request(query))).status, 400, query);
      assert.equal(calls, 0);
    });
    await test('API exposes provider failure as 503 and confirmed-empty schedule as 200', async () => {
      globalThis.fetch = async () => new Response('', { status: 403 });
      const bad = await GET(request('league=ucl&date=2026-10-18'));
      assert.equal(bad.status, 503); const failed = await bad.json(); assert.equal(failed.ok, false); assert.equal(Object.hasOwn(failed, 'games'), false);
      globalThis.fetch = async () => json(board([]));
      const good = await GET(request('league=epl&date=2026-10-18')); assert.equal(good.status, 200);
      const empty = await good.json(); assert.equal(empty.ok, true); assert.deepEqual(empty.games, []); assert.equal(good.headers.get('Cache-Control'), 'no-store');
    });
    await test('API standings retain navigation date while declaring current snapshot scope', async () => {
      globalThis.fetch = async () => json({ id: '23', uid: 's:600~l:700', name: 'English Premier League', children: [{ standings: { entries: [{ team: { id: '1', displayName: 'Contract fixture' }, stats: [] }] } }] });
      const response = await GET(request('league=epl&view=standings&date=2025-10-18'));
      const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.date, '2025-10-18');
      assert.equal(body.historicalAsOfVerified, false); assert.equal(body.requestedDateIsNavigationOnly, true); assert.equal(body.standingsScope, 'CURRENT_PROVIDER_TABLE');
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (password === undefined) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = password;
    if (secret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = secret;
  }
}
