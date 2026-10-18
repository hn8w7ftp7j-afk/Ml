import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeSoccerPlayerMatch, normalizeSoccerPlayerWorkload, fetchSoccerPlayerWorkload } from '../lib/soccer/player-workload.js';
import { fetchSoccerJson } from '../lib/soccer/data.js';

// Repository-captured ESPN Brentford–Arsenal summary, 1 January 2025.
const past = JSON.parse(fs.readFileSync(new URL('./fixtures/soccer/minutes-past.json', import.meta.url)));
const at = Date.parse('2025-01-02T12:00:00Z');
const record = { eventId: '704467', startTime: '2025-01-01T17:30Z', competition: { id: '700', slug: 'eng.1', name: 'English Premier League' }, homeAway: 'away', opponent: { sourceId: '337' }, status: 'COMPLETED', extraTimeReported: false };
const workload = { ok: true, sourceId: '359', asOf: new Date(at - 1000).toISOString(), referenceAt: new Date(at).toISOString(), recentCompleted: [record] };
const source = (data, fixture = record) => ({ provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${fixture.competition.slug}/summary?event=${fixture.eventId}`, fetchedAt: new Date(at - 500).toISOString(), contentHash: createHash('sha256').update(JSON.stringify(data)).digest('hex') });
const observation = (data = past, fixture = record) => ({ ok: true, data, source: source(data, fixture), record: fixture });
const match = normalizeSoccerPlayerMatch(past, record, workload, source(past), at);
assert.equal(match.ok, true);
assert.equal(match.sourceId, '359');
assert.equal(match.teamPlayerMinutes, 990);
assert.equal(match.teamScope, 'TEAM_ONLY');
assert.equal(match.auditedTeamSide, 'away');
assert.equal(match.players.find(player => player.name === 'Oleksandr Zinchenko').regulationClockMinutes, 0);
assert.equal(match.players.find(player => player.name === 'Oleksandr Zinchenko').appeared, true, 'added-time appearance must not disappear because its regulation-clock minutes are zero');
assert.ok(Math.abs(match.players.find(player => player.name === 'Mikel Merino').regulationClockMinutes - 77.6) < 1e-9);
assert.equal(match.source.contentHash, source(past).contentHash);
assert.notEqual(match.source, source(past));

const aggregate = normalizeSoccerPlayerWorkload(workload, [observation()], { asOf: at });
assert.equal(aggregate.status, 'OBSERVED_PARTIAL');
assert.equal(aggregate.coverage.verifiedMatchesLast7Days, 1);
assert.equal(aggregate.coverage.verifiedMatchesLast14Days, 1);
assert.equal(aggregate.coverage.complete, false);
assert.equal(aggregate.modelEffectApplied, false);
assert.equal(aggregate.executable, false);
assert.equal(aggregate.pointInTimeAvailabilityVerified, false);
const late = aggregate.players.find(player => player.name === 'Oleksandr Zinchenko');
assert.equal(late.appearancesLast7Days, 1);
assert.equal(late.startsLast7Days, 0);
assert.equal(late.regulationClockMinutesLast7Days, 0);
assert.equal(late.rosterMatchesObservedLast7Days, 1);
const unused = aggregate.players.find(player => player.name === 'Neto');
assert.equal(unused.appearancesLast14Days, 0);
assert.equal(unused.rosterMatchesObservedLast14Days, 1, 'zero describes a verified roster observation, not proof of full-window absence');
assert.ok(Math.abs(aggregate.players.reduce((sum, player) => sum + player.regulationClockMinutesLast7Days, 0) - 990) < 1e-7);

// Controlled copies below exercise windows and guards; they are not additional historical evidence.
const older = structuredClone(past), olderRecord = { ...record, eventId: '704468', startTime: '2024-12-24T17:30Z' };
older.header.id = olderRecord.eventId;
older.header.uid = 's:600~l:700~e:704468';
older.header.competitions[0].id = olderRecord.eventId;
older.header.competitions[0].uid = 's:600~l:700~e:704468~c:704468';
older.header.competitions[0].date = olderRecord.startTime;
const combined = normalizeSoccerPlayerWorkload(workload, [observation(), observation(older, olderRecord)], { asOf: at });
const merino = combined.players.find(player => player.name === 'Mikel Merino');
assert.ok(Math.abs(merino.regulationClockMinutesLast14Days - 155.2) < 1e-9);
assert.ok(Math.abs(merino.regulationClockMinutesLast7Days - 77.6) < 1e-9);
assert.equal(merino.startsLast7Days, 1);
assert.equal(merino.startsLast14Days, 2);
assert.deepEqual(merino.sourceMatchIds, ['704467', '704468']);
assert.equal(combined.coverage.verifiedMatchesLast7Days, 1);
assert.equal(combined.coverage.verifiedMatchesLast14Days, 2);
const olderOnly = normalizeSoccerPlayerWorkload(workload, [observation(older, olderRecord)], { asOf: at });
assert.equal(olderOnly.players[0].regulationClockMinutesLast7Days, null, 'no observed roster within seven days must remain unknown, not zero');
assert.equal(olderOnly.players[0].appearancesLast7Days, null);
assert.equal(olderOnly.players[0].startsLast7Days, null);

const rejected = (data, fixture = record, meta = source(data, fixture)) => normalizeSoccerPlayerMatch(data, fixture, workload, meta, at);
const futureSource = { ...source(past), fetchedAt: new Date(at + 1).toISOString() };
assert.equal(rejected(past, record, futureSource).code, 'SOCCER_PLAYER_SOURCE_AFTER_CUTOFF');
assert.equal(rejected(past, record, { ...source(past), fetchedAt: null }).code, 'SOCCER_PLAYER_SOURCE_AFTER_CUTOFF');
assert.equal(rejected(past, record, { ...source(past), fetchedAt: '2025-01-02T11:59:00' }).code, 'SOCCER_PLAYER_SOURCE_AFTER_CUTOFF');
assert.equal(rejected(past, record, { ...source(past), contentHash: 'wrong' }).code, 'SOCCER_PLAYER_SOURCE_VERSION_INVALID');
assert.equal(rejected(past, record, { ...source(past), url: source(past).url.replace('eng.1', 'uefa.champions') }).code, 'SOCCER_PLAYER_SOURCE_VERSION_INVALID');
const wrongId = structuredClone(past); wrongId.header.id = '999';
assert.equal(rejected(wrongId).code, 'SOCCER_PLAYER_SUMMARY_SCOPE_MISMATCH');
const wrongCompetition = structuredClone(past); wrongCompetition.header.league.id = '775';
assert.equal(rejected(wrongCompetition).code, 'SOCCER_PLAYER_SUMMARY_SCOPE_MISMATCH');
const wrongTeam = structuredClone(past); wrongTeam.header.competitions[0].competitors.find(team => team.homeAway === 'away').team.id = '360';
assert.equal(rejected(wrongTeam).code, 'SOCCER_PLAYER_SUMMARY_IDENTITY_INVALID');
assert.equal(rejected(past, { ...record, opponent: { sourceId: '360' } }).code, 'SOCCER_PLAYER_TEAM_IDENTITY_MISMATCH');
assert.equal(rejected(past, { ...record, homeAway: 'home' }).code, 'SOCCER_PLAYER_TEAM_IDENTITY_MISMATCH');
const live = structuredClone(past); live.header.competitions[0].status.type = { completed: false, state: 'in', name: 'STATUS_IN_PROGRESS' };
assert.equal(rejected(live).code, 'SOCCER_PLAYER_REGULATION_FINAL_UNVERIFIED');
const awarded = structuredClone(past); awarded.header.competitions[0].status.type.name = 'STATUS_AWARDED';
assert.equal(rejected(awarded).code, 'SOCCER_PLAYER_REGULATION_FINAL_UNVERIFIED');
const extra = structuredClone(past); extra.header.competitions[0].status.type.name = 'STATUS_FINAL_AFTER_EXTRA_TIME';
assert.equal(rejected(extra).code, 'SOCCER_PLAYER_REGULATION_FINAL_UNVERIFIED');
const noEvents = structuredClone(past); noEvents.keyEvents = [];
assert.equal(rejected(noEvents).code, 'REGULATION_END_MISSING');
const opponentRoleText = structuredClone(past);
opponentRoleText.keyEvents.find(event => event.type.type === 'substitution' && event.team.id === '337').text = 'Unverified opponent substitution role text';
assert.equal(rejected(opponentRoleText).ok, true, 'unverified opponent substitution roles must not erase the separately verified target-team minutes');
assert.equal(rejected(opponentRoleText).teamPlayerMinutes, 990);
const ownRoleText = structuredClone(past);
ownRoleText.keyEvents.find(event => event.type.type === 'substitution' && event.team.id === '359').text = 'Unverified own substitution role text';
assert.equal(rejected(ownRoleText).code, 'SUBSTITUTION_ROLE_UNVERIFIED', 'target-team roles remain strict; no alias or role guessing');
const reusedPlayer = structuredClone(past); reusedPlayer.rosters[1].roster[0].athlete.id = reusedPlayer.rosters[0].roster[0].athlete.id;
assert.equal(rejected(reusedPlayer).code, 'SOCCER_PLAYER_ROSTER_IDENTITY_INVALID');
assert.equal(rejected(past, { ...record, status: 'SCHEDULED' }).code, 'SOCCER_PLAYER_MATCH_SCOPE_INVALID');
assert.equal(rejected(past, { ...record, startTime: new Date(at + 1).toISOString() }).code, 'SOCCER_PLAYER_MATCH_SCOPE_INVALID');
assert.equal(normalizeSoccerPlayerWorkload(workload, [observation(), observation()], { asOf: at }).code, 'SOCCER_PLAYER_DUPLICATE_MATCH');
const none = normalizeSoccerPlayerWorkload(workload, [], { asOf: at });
assert.equal(none.ok, false); assert.deepEqual(none.players, []); assert.equal(none.coverage.complete, false);
const partial = normalizeSoccerPlayerWorkload(workload, [observation(), { ok: false, code: 'SOCCER_SOURCE_TIMEOUT', record: olderRecord }], { asOf: at });
assert.equal(partial.ok, true);
assert.equal(partial.coverage.omittedMatches, 1);
assert.equal(partial.omissions[0].reason, 'SOCCER_SOURCE_TIMEOUT');

// One malformed provider summary cannot erase a different verified match.
for (const [label, mutate, expected] of [
  ['null roster', data => { data.rosters[0] = null; }, 'SOCCER_PLAYER_ROSTER_SCOPE_INVALID'],
  ['null player', data => { data.rosters[0].roster[0] = null; }, 'SOCCER_PLAYER_ROSTER_IDENTITY_INVALID'],
  ['null key event', data => { data.keyEvents[0] = null; }, 'SOCCER_PLAYER_TIMELINE_SCHEMA_INVALID'],
  ['null competitor', data => { data.header.competitions[0].competitors[0] = null; }, 'SOCCER_PLAYER_SUMMARY_IDENTITY_INVALID'],
  ['malformed target-team audit statistics', data => { data.rosters[1].roster[0].stats = {}; }, 'SOCCER_PLAYER_SUMMARY_SCHEMA_INVALID'],
]) {
  const malformed = structuredClone(older); mutate(malformed);
  const invalid = rejected(malformed, olderRecord);
  assert.equal(invalid.ok, false, label); assert.equal(invalid.code, expected, label);
  const retained = normalizeSoccerPlayerWorkload(workload, [observation(), observation(malformed, olderRecord)], { asOf: at });
  assert.equal(retained.ok, true, label); assert.equal(retained.matches.length, 1, label);
  assert.equal(retained.coverage.verifiedMatches, 1); assert.equal(retained.coverage.omittedMatches, 1);
  assert.equal(retained.omissions[0].eventId, olderRecord.eventId); assert.equal(retained.omissions[0].reason, expected);
  assert.equal(retained.omissions[0].source.contentHash, source(malformed, olderRecord).contentHash);
  assert.ok(Math.abs(retained.players.find(player => player.name === 'Mikel Merino').regulationClockMinutesLast14Days - 77.6) < 1e-9, label);
}

let requests = 0;
const fetchImpl = async url => { requests++; return { ok: true, url, json: async () => structuredClone(past) }; };
const fetched = await fetchSoccerPlayerWorkload(workload, { fetchImpl, now: () => at });
assert.equal(fetched.ok, true); assert.equal(requests, 1);
await fetchSoccerPlayerWorkload(workload, { fetchImpl, now: () => at });
assert.equal(requests, 1, 'unchanged endpoint reads use the bounded source cache without changing original fetchedAt');
const excluded = await fetchSoccerPlayerWorkload({ ...workload, recentCompleted: [{ ...record, status: 'SCHEDULED' }, { ...olderRecord, extraTimeReported: true }] }, { fetchImpl, now: () => at });
assert.equal(excluded.ok, false); assert.equal(requests, 1);
assert.deepEqual(excluded.omissions.map(value => value.reason).sort(), ['SOCCER_PLAYER_EXTRA_TIME_UNVERIFIED', 'SOCCER_PLAYER_MATCH_SCOPE_INVALID']);

let active = 0, maxActive = 0, boundedRequests = 0;
const many = Array.from({ length: 6 }, (_, i) => ({ ...record, eventId: String(800000 + i), startTime: new Date(at - (i + 1) * 86_400_000).toISOString() }));
const bounded = await fetchSoccerPlayerWorkload({ ...workload, recentCompleted: many }, { now: () => at, fetchImpl: async () => { active++; maxActive = Math.max(maxActive, active); boundedRequests++; await new Promise(resolve => setTimeout(resolve, 3)); active--; return { ok: false, status: 503 }; } });
assert.equal(boundedRequests, 4);
assert.ok(maxActive <= 2);
assert.equal(bounded.coverage.omittedMatches, 6);
assert.equal(bounded.omissions.filter(value => value.reason === 'SOCCER_PLAYER_MATCH_LIMIT').length, 2);
assert.equal((await fetchSoccerPlayerWorkload(workload, { maxMatches: 100, now: () => at })).code, 'SOCCER_PLAYER_FETCH_OPTIONS_INVALID');
const timeout = await fetchSoccerPlayerWorkload(workload, { now: () => at, timeoutMs: 2, fetchImpl: () => new Promise(() => {}) });
assert.equal(timeout.ok, false);
assert.equal(timeout.omissions[0].reason, 'SOCCER_SOURCE_TIMEOUT');

// The as-of clock stays fixed while real wall time bounds this consumer. An
// already running reader retains its own longer deadline and must not abort.
for (const limits of [
  { budgetMs: 25, timeoutMs: 200, expected: 'SOCCER_PLAYER_BUDGET_EXCEEDED' },
  { budgetMs: 200, timeoutMs: 20, expected: 'SOCCER_SOURCE_TIMEOUT' },
]) {
  let release, producerFinished = false, aborted = false, calls = 0, watchdog;
  const sharedFetch = async (url, { signal }) => {
    calls++; signal.addEventListener('abort', () => { aborted = true; });
    await new Promise(resolve => { release = resolve; });
    return { ok: true, url, json: async () => structuredClone(past) };
  };
  const producer = fetchSoccerJson(source(past).url, { fetchImpl: sharedFetch, now: () => at, timeoutMs: 1000 });
  producer.then(() => { producerFinished = true; });
  try {
    const started = Date.now();
    const consumer = await Promise.race([
      fetchSoccerPlayerWorkload(workload, { fetchImpl: sharedFetch, now: () => at, budgetMs: limits.budgetMs, timeoutMs: limits.timeoutMs }),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('consumer ignored its own deadline')), 500); }),
    ]);
    assert.ok(Date.now() - started < 450, 'consumer must finish before the unrelated producer timeout');
    assert.equal(producerFinished, false); assert.equal(aborted, false); assert.equal(calls, 1, 'the same URL shares a single ongoing read');
    assert.equal(consumer.ok, false); assert.equal(consumer.omissions[0].reason, limits.expected);
    assert.equal(consumer.coverage.attemptedMatches, 1); assert.equal(consumer.coverage.verifiedMatches, 0);
    assert.equal(consumer.omissions[0].source.fetchedAt, null, 'a timed-out consumer cannot claim source acquisition');
    assert.equal(consumer.omissions[0].source.requestedAt, new Date(at).toISOString());
    assert.equal(consumer.sources[0].acquisitionStatus, 'NOT_ACQUIRED_BY_THIS_CONSUMER');
  } finally { clearTimeout(watchdog); release(); }
  assert.equal((await producer).ok, true, 'the original reader remains alive and receives its provider response');
  assert.equal(aborted, false);
  const later = await fetchSoccerPlayerWorkload(workload, { fetchImpl: sharedFetch, now: () => at });
  assert.equal(later.ok, true); assert.equal(calls, 1, 'a subsequent consumer can use the intact completed cache');
}

console.log('PASS observed player workload: true ESPN minutes, zero-clock added-time appearances, 7/14-day aggregation, source/time/identity/final/ET guards, per-summary schema failures, partial omissions, no false completeness, fetch cap/cache/concurrency and independent consumer deadlines; no predicted minutes or model promotion');
