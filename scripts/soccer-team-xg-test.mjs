import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { soccerDate } from '../lib/soccer/contracts.js';
import { fetchSoccerTeamXg, normalizeSoccerTeamXg, soccerTeamXgDocumentProof,
  SOCCER_TEAM_XG_SOURCE_URL, SOCCER_TEAM_XG_MAX_BYTES, getSoccerTeamXgProvider } from '../lib/soccer/team-xg.js';

const html = fs.readFileSync('scripts/fixtures/soccer/opta-epl-20261028.html', 'utf8');
const identities = JSON.parse(fs.readFileSync('scripts/fixtures/soccer/opta-espn-identities-20261029.json', 'utf8'));
const initial = Date.parse('2026-10-28T22:00:00Z'), calendar = '6pdwluctev9iebv00r4qqukno';
const iso = time => new Date(time).toISOString(), hash = text => createHash('sha256').update(text).digest('hex');
const team = sourceId => { const value = identities.mappings.find(row => row.espnId === sourceId);
  return { id: `soccer:epl:team:${sourceId}`, sourceId, name: value.espnName }; };
export const teamXgFixtureGame = { id: 'soccer:epl:401879248', league: 'epl', sourceId: '401879248', date: '2026-10-31',
  startTime: '2026-10-31T12:30:00.000Z', status: 'scheduled', home: team('363'), away: team('360') };
const game = teamXgFixtureGame;
const source = (text = html, time = initial) => ({ provider: 'OPTA_ANALYST', url: SOCCER_TEAM_XG_SOURCE_URL,
  requestedAt: iso(time), fetchedAt: iso(time), availableAt: iso(time), contentHash: hash(text) });
const normalized = (text = html, target = game, receipt = source(text), time = initial) => normalizeSoccerTeamXg(text, target, receipt, time);
function stateEdit(change) {
  const $ = cheerio.load(html), script = $('script[type="application/json"]');
  const state = JSON.parse(script.text()); change(state);
  script.text(JSON.stringify(state)); return $.html();
}
function htmlEdit(change) { const $ = cheerio.load(html); change($); return $.html(); }
const expected = state => state.state['ta/competition'].competitions[calendar].expected;
function response(text = html, { status = 200, url = SOCCER_TEAM_XG_SOURCE_URL, type = 'text/html; charset=UTF-8', redirected = false, headers = {} } = {}) {
  const value = new Response(text, { status, headers: { 'content-type': type, ...headers } });
  Object.defineProperties(value, { url: { value: url }, redirected: { value: redirected } }); return value;
}

const value = normalized();
assert.equal(value.ok, true); assert.equal(value.status, 'PROVIDER_REPORTED');
assert.deepEqual(value.teams.home, { sourceId: '363', optaId: '9q0arba2kbnywth8bkxlhgmdr', name: 'Chelsea',
  played: 8, xg: 10.3, xga: 11.4, xgPerMatch: 1.2875, xgaPerMatch: 1.425 });
assert.equal(value.teams.away.xg, 12.8); assert.equal(value.source.sourcePublishedAt, null);
assert.equal(value.source.sourceUpdatedAt, '2026-10-28T06:18:02.988Z');
assert.equal(value.sourceEvidence.updateField, 'expected.lastUpdated');
assert.equal(value.coverage.currentTableOnly, true);
for (const key of ['modelEffectApplied','pointInTimeAvailabilityVerified','formalEligible','executable']) assert.equal(value[key], false);
for (const key of ['matchLevel','halfTime','nonPenaltyXg','shotQuality','personnel','completeSeason']) assert.equal(value.coverage[key], false);
assert.equal(soccerTeamXgDocumentProof(value), null, 'pure fixture normalization cannot create trusted fetch archival proof');
const otherSection = stateEdit(state => { state.state['ta/competition'].competitions[calendar]['standings.full'] = { lastUpdated: '2099-01-01T00:00:00Z' }; });
assert.equal(normalized(otherSection).source.sourceUpdatedAt, value.source.sourceUpdatedAt, 'unrelated standings timestamp is never borrowed');
for (const mapping of identities.mappings) {
  assert.equal(mapping.espnUid, `s:600~t:${mapping.espnId}`);
  const own = team(mapping.espnId), opponent = team(mapping.espnId === '359' ? '364' : '359');
  const checked = normalized(html, { ...game, home: own, away: opponent });
  assert.equal(checked.ok, true, mapping.espnName); assert.equal(checked.teams.home.optaId, mapping.optaId);
}
for (const [text, code] of [
  [html.replace('2026/2027', '2025/2026'), 'TEAM_XG_SEASON_UNVERIFIED'],
  [htmlEdit($ => $('h1').text('Champions League Table')), 'TEAM_XG_COMPETITION_UNVERIFIED'],
  [html.replace('"code":"EPL"', '"code":"UCL"'), 'TEAM_XG_COMPETITION_UNVERIFIED'],
  [html.replace('"tmcl":"6pdwluctev9iebv00r4qqukno"', '"tmcl":"other-calendar"'), 'TEAM_XG_TABLE_SCOPE_UNVERIFIED'],
  [stateEdit(state => { expected(state).lastUpdated = '2026-10-29T23:00:00Z'; }), 'TEAM_XG_UPDATE_TIME_UNVERIFIED'],
  [stateEdit(state => { delete expected(state).lastUpdated; }), 'TEAM_XG_UPDATE_TIME_UNVERIFIED'],
  [stateEdit(state => { expected(state).rows.push(expected(state).rows[0]); }), 'TEAM_XG_TEAM_COVERAGE_INVALID'],
  [stateEdit(state => { expected(state).rows[1] = expected(state).rows[0]; }), 'TEAM_XG_TEAM_IDENTITY_UNVERIFIED'],
  [stateEdit(state => { expected(state).rows[0].contestantId = 'unknown'; }), 'TEAM_XG_TEAM_IDENTITY_UNVERIFIED'],
  [stateEdit(state => { expected(state).rows[0].longName = 'Liverpool'; }), 'TEAM_XG_TEAM_IDENTITY_UNVERIFIED'],
  [stateEdit(state => { expected(state).rows[0].played = 39; }), 'TEAM_XG_VALUES_INVALID'],
  [stateEdit(state => { expected(state).rows[0].xG = '-2.0'; }), 'TEAM_XG_VALUES_INVALID'],
  [stateEdit(state => { expected(state).rows[0].xGA = 'NaN'; }), 'TEAM_XG_VALUES_INVALID'],
  [stateEdit(state => { expected(state).rows[0].xGA = 6.2; }), 'TEAM_XG_VALUES_INVALID'],
  [stateEdit(state => { expected(state).rows[0].played = 0; }), 'TEAM_XG_VALUES_INVALID'],
]) assert.equal(normalized(text).code, code, code);
const zeroPlayed = stateEdit(state => { for (const row of expected(state).rows) Object.assign(row, { played: 0, xG: '0.0', xGA: '0.0' }); });
assert.equal(normalized(zeroPlayed).teams.home.xgPerMatch, null, 'zero appearances is unknown per-game rate, never infinity');
for (const changed of [{ ...game, home: { ...game.home, sourceId: '359' } },
  { ...game, home: { ...game.home, name: 'Liverpool' } }, { ...game, away: game.home }])
  assert.equal(normalized(html, changed).code, 'TEAM_XG_TEAM_IDENTITY_UNVERIFIED');
for (const receipt of [{ ...source(), url: 'https://evil.example/competition/premier-league/table?view=expected' },
  { ...source(), contentHash: 'a'.repeat(64) }, { ...source(), fetchedAt: iso(initial + 1) },
  { ...source(), requestedAt: iso(initial + 1) }]) assert.equal(normalized(html, game, receipt).code, 'TEAM_XG_SOURCE_RECEIPT_INVALID');
assert.equal(normalized(html, game, source(), initial + 600000).code, 'TEAM_XG_SOURCE_RECEIPT_INVALID');
assert.equal(normalized(html, { ...game, startTime: iso(initial - 1), date: soccerDate(initial - 1) }).code, 'TEAM_XG_NOT_PREMATCH');
assert.equal(normalized(html, { ...game, startTime: '2027-10-31T12:30:00Z', date: '2027-10-31' }).code, 'TEAM_XG_SEASON_UNSUPPORTED');
console.log('PASS Opta retained actual provider state: exact league/season/calendar and twenty reviewed IDs, rounded aggregate fields, field-local update time, unsupported data stays absent and no pure-parser archival authority');

let current = initial, calls = 0, release;
const fetchImpl = async (url, options) => { calls++; assert.equal(url, SOCCER_TEAM_XG_SOURCE_URL);
  assert.equal(options.redirect, 'manual'); assert.equal(options.cache, 'no-store');
  if (calls === 1) await new Promise(resolve => { release = resolve; }); return response(); };
const first = fetchSoccerTeamXg(game, { fetchImpl, now: () => current });
const second = fetchSoccerTeamXg({ ...game, sourceId: '456', id: 'soccer:epl:456' }, { fetchImpl, now: () => current });
await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); release();
const [one, two] = await Promise.all([first, second]);
assert.equal(one.ok, true); assert.equal(two.ok, true);
assert.notEqual(one.gameId, two.gameId);
const proof = soccerTeamXgDocumentProof(one), secondProof = soccerTeamXgDocumentProof(two);
assert.equal(proof.binding.fetchId, secondProof.binding.fetchId, 'one actual underlying fetch is not inflated into two fetch observations');
assert.equal(proof.text, html); assert.equal(proof.bytes, Buffer.byteLength(html));
assert.equal(soccerTeamXgDocumentProof(structuredClone(one)), null);
proof.binding.gameId = 'mutated'; assert.equal(soccerTeamXgDocumentProof(one).binding.gameId, game.id, 'proof accessor detaches returned bytes/binding');
current += 599999;
const cached = await fetchSoccerTeamXg(game, { fetchImpl, now: () => current });
assert.equal(calls, 1); assert.equal(cached.source.fetchedAt, one.source.fetchedAt);
assert.equal(soccerTeamXgDocumentProof(cached).binding.fetchId, soccerTeamXgDocumentProof(one).binding.fetchId);
current++;
const renewed = await fetchSoccerTeamXg(game, { fetchImpl, now: () => current });
assert.equal(calls, 2); assert.equal(renewed.source.fetchedAt, iso(current));
assert.notEqual(soccerTeamXgDocumentProof(renewed).binding.fetchId, soccerTeamXgDocumentProof(one).binding.fetchId);
for (const edit of [result => { result.teams.home.xg += 1; }, result => { result.sourceEvidence.independentlyConfirmed = true; },
  result => { result.teams.home.optaId = result.teams.away.optaId; }]) {
  const fresh = await fetchSoccerTeamXg(game, { fetchImpl, now: () => current }); edit(fresh);
  assert.equal(soccerTeamXgDocumentProof(fresh), null, 'modified normalized values cannot borrow genuine document proof');
}
const archiveAttached = await fetchSoccerTeamXg(game, { fetchImpl, now: () => current });
archiveAttached.sourceDocumentArchive = { status: 'ARCHIVED' };
assert.ok(soccerTeamXgDocumentProof(archiveAttached), 'attaching the independent archive receipt does not change original normalized content');
let unavailableCalls = 0;
const failsAfterTtl = async () => { unavailableCalls++; return unavailableCalls === 1 ? response() : response('unavailable', { status: 503 }); };
assert.equal((await fetchSoccerTeamXg(game, { fetchImpl: failsAfterTtl, now: () => current, ttlMs: 10 })).ok, true);
current += 10;
assert.equal((await fetchSoccerTeamXg(game, { fetchImpl: failsAfterTtl, now: () => current, ttlMs: 10 })).ok, false, 'source failure after TTL never serves an old success');
console.log('PASS actual fetch proof and cache: bounded single-flight concurrent reads, original fetch time preserved for ten minutes, TTL forces new fetch identity, no stale-success fallback and mutated/caller-copied results cannot archive');

let requests = 0;
const neverFetch = async () => { requests++; throw Error('unexpected fetch'); };
assert.equal((await fetchSoccerTeamXg({ ...game, league: 'npb' }, { fetchImpl: neverFetch, now: () => current })).code, 'TEAM_XG_LEAGUE_UNSUPPORTED');
assert.equal((await fetchSoccerTeamXg({ ...game, status: 'final' }, { fetchImpl: neverFetch, now: () => current })).code, 'TEAM_XG_NOT_PREMATCH');
assert.equal((await fetchSoccerTeamXg(game, { fetchImpl: neverFetch, now: () => current, url: 'http://localhost' })).code, 'TEAM_XG_FETCH_OPTIONS_INVALID');
assert.equal(requests, 0);
for (const [make, code] of [
  [() => response(html, { status: 302 }), 'TEAM_XG_SOURCE_REDIRECT_REJECTED'],
  [() => response(html, { redirected: true }), 'TEAM_XG_SOURCE_REDIRECT_REJECTED'],
  [() => response(html, { url: 'https://evil.example/table' }), 'TEAM_XG_SOURCE_RESPONSE_URL_MISMATCH'],
  [() => response(html, { status: 429 }), 'TEAM_XG_SOURCE_RATE_LIMITED'],
  [() => response(html, { type: 'application/json' }), 'TEAM_XG_SOURCE_CONTENT_TYPE_INVALID'],
  [() => response(html, { headers: { 'content-length': String(SOCCER_TEAM_XG_MAX_BYTES + 1) } }), 'TEAM_XG_DOCUMENT_SIZE_INVALID'],
  [() => response('x'.repeat(SOCCER_TEAM_XG_MAX_BYTES + 1)), 'TEAM_XG_DOCUMENT_SIZE_INVALID'],
  [() => response(Uint8Array.from([0xff, 0xfe, 0xfd])), 'TEAM_XG_SOURCE_UTF8_INVALID'],
]) {
  const result = await fetchSoccerTeamXg(game, { fetchImpl: async () => make(), now: () => current });
  assert.equal(result.code, code, JSON.stringify(result)); assert.equal(soccerTeamXgDocumentProof(result), null);
}
const timedOut = await fetchSoccerTeamXg(game, { fetchImpl: async () => new Promise(() => {}), now: () => current, timeoutMs: 5 });
assert.equal(timedOut.code, 'TEAM_XG_SOURCE_TIMEOUT');
const slowBody = new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/html' } });
Object.defineProperty(slowBody, 'url', { value: SOCCER_TEAM_XG_SOURCE_URL });
assert.equal((await fetchSoccerTeamXg(game, { fetchImpl: async () => slowBody, now: () => current, timeoutMs: 5 })).code, 'TEAM_XG_SOURCE_TIMEOUT');
console.log('PASS transport boundaries: fixed allowlisted URL only, unsupported leagues/postgame rejected without network, redirected/wrong URL/content type/oversized/invalid UTF8 responses fail closed, fetch and streaming body have one bounded deadline');

const uclHtml=fs.readFileSync('scripts/fixtures/soccer/opta-ucl-20261028.html','utf8');
const uclIdentities=JSON.parse(fs.readFileSync('scripts/fixtures/soccer/opta-ucl-espn-identities-20261029.json','utf8'));
const uclProvider=getSoccerTeamXgProvider('ucl'),uclCalendar=uclProvider.competition.tournamentCalendarId;
const uclTeam=sourceId=>{const mapping=uclIdentities.mappings.find(row=>row.espnId===sourceId);
  return{id:`soccer:ucl:team:${sourceId}`,sourceId,name:mapping.espnName};};
const uclGame={...game,league:'ucl',id:'soccer:ucl:401915395',sourceId:'401915395',home:uclTeam('2572'),away:uclTeam('360')};
const uclSource=(text=uclHtml)=>({...source(text,current),url:uclProvider.sourceUrl});
const uclNormalize=(text=uclHtml,target=uclGame)=>normalizeSoccerTeamXg(text,target,uclSource(text),current);
const uclResult=uclNormalize();
assert.equal(uclResult.ok,true,JSON.stringify(uclResult));assert.equal(uclResult.league,'ucl');
assert.equal(uclResult.source.sourceUpdatedAt,'2026-10-28T06:59:48.629Z');
assert.deepEqual(uclResult.teams.home,{sourceId:'2572',optaId:'6uzfw7ahyxg4wrrfxo5u7qt0n',name:'Como',played:3,
  xg:6.4,xga:3,xgPerMatch:6.4/3,xgaPerMatch:1});
assert.equal(uclResult.teams.away.xg,5.7);assert.equal(uclResult.teams.away.xga,4.4);
assert.equal(uclResult.coverage.teamCount,36);assert.equal(uclResult.coverage.currentTableOnly,true);
assert.equal(uclResult.coverage.completeSeason,false);assert.equal(uclResult.formalEligible,false);
assert.equal(uclResult.pointInTimeAvailabilityVerified,false);assert.equal(uclResult.modelEffectApplied,false);
assert.equal(soccerTeamXgDocumentProof(uclResult),null);
assert.equal(getSoccerTeamXgProvider('epl').sourceUrl,SOCCER_TEAM_XG_SOURCE_URL);
assert.equal(getSoccerTeamXgProvider('toString'),null);
assert.equal(uclProvider.tab,'actual','the observed UCL page tab is actual, while the selected data source remains expected');
for(const mapping of uclIdentities.mappings){
  assert.equal(mapping.espnUid,`s:600~t:${mapping.espnId}`);
  const own=uclTeam(mapping.espnId),opponent=uclTeam(mapping.espnId==='360'?'2572':'360');
  const checked=uclNormalize(uclHtml,{...uclGame,home:own,away:opponent});
  assert.equal(checked.ok,true,mapping.espnName);assert.equal(checked.teams.home.optaId,mapping.optaId);
}
function uclEdit(edit){
  const $=cheerio.load(uclHtml),script=$('script[type="application/json"]'),state=JSON.parse(script.text());
  edit(state,$);script.text(JSON.stringify(state));return $.html();
}
const uclOtherSection=uclEdit(state=>{state.state['ta/competition'].competitions[uclCalendar]['standings.full']={
  lastUpdated:'2099-01-01T00:00:00Z',rows:Array(108).fill({xG:'999.0',xGA:'999.0'})};});
assert.deepEqual(uclNormalize(uclOtherSection).teams,uclResult.teams,'108 actual home/away/total rows never replace the 36 expected rows');
assert.equal(uclNormalize(uclOtherSection).source.sourceUpdatedAt,uclResult.source.sourceUpdatedAt,'unrelated actual-table update is not the xG source update');
for(const [text,code]of[
  [uclHtml.replace('2026/2027','2025/2026'),'TEAM_XG_SEASON_UNVERIFIED'],
  [uclHtml.replace('"tmcl":"99jev9kv55deht65t6myggxlg"','"tmcl":"6pdwluctev9iebv00r4qqukno"'),'TEAM_XG_TABLE_SCOPE_UNVERIFIED'],
  [uclEdit(state=>{state.state['ta/competition'].competitions[uclCalendar].expected.rows.push(
    state.state['ta/competition'].competitions[uclCalendar].expected.rows[0]);}),'TEAM_XG_TEAM_COVERAGE_INVALID'],
  [uclEdit(state=>{const rows=state.state['ta/competition'].competitions[uclCalendar].expected.rows;rows[1]=rows[0];}),'TEAM_XG_TEAM_IDENTITY_UNVERIFIED'],
  [uclEdit(state=>{state.state['ta/competition'].competitions[uclCalendar].expected.lastUpdated='2099-01-01T00:00:00Z';}),'TEAM_XG_UPDATE_TIME_UNVERIFIED'],
])assert.equal(uclNormalize(text).code,code);
assert.equal(uclNormalize(uclHtml,{...uclGame,home:{...uclGame.home,sourceId:'363',id:'soccer:ucl:team:363',name:'Chelsea'}}).code,
  'TEAM_XG_TEAM_IDENTITY_UNVERIFIED','a real EPL club is not automatically in the reviewed UCL table');
assert.equal(normalizeSoccerTeamXg(uclHtml,uclGame,source(uclHtml,current),current).code,'TEAM_XG_SOURCE_RECEIPT_INVALID');
assert.equal(uclNormalize(html).code,'TEAM_XG_COMPETITION_UNVERIFIED','EPL data cannot be relabeled UCL even for shared clubs');

const leagueCalls=[];
const bothFetch=async url=>{leagueCalls.push(url);return response(url===SOCCER_TEAM_XG_SOURCE_URL?html:uclHtml,{url});};
const[eplFetched,uclFetched,uclRepeated]=await Promise.all([
  fetchSoccerTeamXg(game,{fetchImpl:bothFetch,now:()=>current}),
  fetchSoccerTeamXg(uclGame,{fetchImpl:bothFetch,now:()=>current}),
  fetchSoccerTeamXg(uclGame,{fetchImpl:bothFetch,now:()=>current}),
]);
assert.equal(eplFetched.ok,true);assert.equal(uclFetched.ok,true);assert.equal(uclRepeated.ok,true);
assert.equal(leagueCalls.length,2,'concurrent EPL and UCL requests use separate exact URL caches, UCL repeats coalesce');
assert.equal(eplFetched.teams.away.xg,12.8);assert.equal(uclFetched.teams.away.xg,5.7,'the same club keeps league-specific totals');
const eplProof=soccerTeamXgDocumentProof(eplFetched),uclProof=soccerTeamXgDocumentProof(uclFetched);
assert.notEqual(eplProof.binding.fetchId,uclProof.binding.fetchId);
assert.equal(uclProof.binding.league,'ucl');assert.equal(uclProof.binding.sourceUrl,uclProvider.sourceUrl);
assert.equal(uclProof.binding.fetchId,soccerTeamXgDocumentProof(uclRepeated).binding.fetchId);
assert.equal((await fetchSoccerTeamXg(uclGame,{fetchImpl:async()=>response(uclHtml),now:()=>current})).code,'TEAM_XG_SOURCE_RESPONSE_URL_MISMATCH');
console.log('PASS UCL actual provider table: 36 exact reviewed ESPN/Opta IDs, own expected timestamp, 108 standings rows excluded, table-only coverage explicit, league-specific totals/cache/proof and shared clubs never borrow EPL observations');
