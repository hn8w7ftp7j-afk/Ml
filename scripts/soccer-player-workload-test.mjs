import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { normalizeSoccerPlayerMatch, normalizeSoccerPlayerWorkload, fetchSoccerPlayerWorkload } from '../lib/soccer/player-workload.js';
import { fetchSoccerJson } from '../lib/soccer/data.js';
import { soccerMinutesAudit, SOCCER_MINUTES_AUDIT_V2_VERSION } from '../lib/soccer/personnel-audit.js';

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
assert.equal(match.version, 'SOCCER-OBSERVED-PLAYER-WORKLOAD-v2');
assert.equal(match.extractorVersion, SOCCER_MINUTES_AUDIT_V2_VERSION);
assert.equal(match.dismissalPolicy, 'EXPLICIT_ESPN_TYPE_93_RED_CARD_ONLY_VAR_REVIEW_IS_INFORMATIONAL');
assert.equal(match.formalEligible, false);
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
const ownRecovered = rejected(ownRoleText);
assert.equal(ownRecovered.ok, true, 'one unique source-ID/active-state/roster-flag pair resolves changed provider name text');
assert.equal(ownRecovered.stateResolvedSubstitutions, 1);
assert.deepEqual(ownRecovered.players, match.players);
const resolvedEvent = ownRecovered.participationEvents.find(event => event.roleEvidence?.method === 'UNIQUE_SOURCE_IDS_ACTIVE_STATE_AND_ROSTER_FLAGS');
assert.ok(resolvedEvent);
const contraryRoleText = structuredClone(ownRoleText);
const contraryEvent = contraryRoleText.keyEvents.find(event => String(event.id) === resolvedEvent.eventId);
const ownNames = new Map(contraryRoleText.rosters.find(team => team.team.id === '359').roster.map(player => [String(player.athlete.id), player.athlete.displayName || player.athlete.fullName]));
contraryEvent.text = `${ownNames.get(resolvedEvent.exit)} replaces ${ownNames.get(resolvedEvent.enter)}.`;
assert.equal(rejected(contraryRoleText).ok, false, 'contrary exact provider names still reject source-ID fallback');
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

// Actual retained ESPN Southampton–Newcastle source: the VAR review explicitly
// reports no card change. The old live extractor incorrectly removed Bednarek.
// This replay tests the current workload boundary, not historical PIT approval.
const retained = JSON.parse(gunzipSync(fs.readFileSync(new URL('../research/soccer/personnel-epl-sources.json.gz', import.meta.url))));
const noCardRecord = retained.find(item => item.eventId === '578438');
assert.ok(noCardRecord);
const noCard = noCardRecord.data, noCardCompetition = noCard.header.competitions[0];
const noCardStart = noCardCompetition.date, noCardAt = Date.parse(noCardStart) + 86_400_000;
const ownSide = noCard.rosters.find(group => group.roster.some(player => String(player.athlete.id) === '221788')).homeAway;
const ownCompetitor = noCardCompetition.competitors.find(team => team.homeAway === ownSide);
const opponent = noCardCompetition.competitors.find(team => team.homeAway !== ownSide);
const actualRecord = { eventId: '578438', startTime: noCardStart,
  competition: { id: String(noCard.header.league.id), slug: noCard.header.league.slug },
  homeAway: ownSide, opponent: { sourceId: String(opponent.team.id) }, status: 'COMPLETED', extraTimeReported: false };
const actualWorkload = { ok: true, sourceId: String(ownCompetitor.team.id),
  asOf: new Date(noCardAt - 1000).toISOString(), referenceAt: new Date(noCardAt).toISOString(), recentCompleted: [actualRecord] };
const actualSource = data => ({ provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${actualRecord.competition.slug}/summary?event=578438`,
  fetchedAt: new Date(noCardAt - 500).toISOString(), contentHash: createHash('sha256').update(JSON.stringify(data)).digest('hex') });
const actualGame = { status: 'final', ...Object.fromEntries(noCardCompetition.competitors.map(team => [team.homeAway, { sourceId: String(team.team.id) }])) };
const oldActual = soccerMinutesAudit(noCard, actualGame, { teamSide: ownSide });
assert.ok(oldActual.teams[ownSide].players.find(player => player.id === '221788').regulationClockMinutes < 90);
const correctedActual = normalizeSoccerPlayerMatch(noCard, actualRecord, actualWorkload, actualSource(noCard), noCardAt);
assert.equal(correctedActual.ok, true);
assert.equal(correctedActual.players.find(player => player.id === '221788').regulationClockMinutes, 90);
assert.ok(correctedActual.informationalCardReviews.some(event => /No card change/.test(event.sourceText)));
assert.equal(correctedActual.participationEvents.some(event => event.type.includes('DISMISSAL') && event.playerId === '221788'), false);
for (const [providerType, providerTypeId] of [['var---red-card-upgrade','167'], ['var---red-card-given','168']]) {
  const changed = structuredClone(noCard), review = changed.keyEvents.find(event => /No card change/.test(event.text || ''));
  review.type = { ...review.type, type: providerType, id: providerTypeId };
  const result = normalizeSoccerPlayerMatch(changed, actualRecord, actualWorkload, actualSource(changed), noCardAt);
  assert.equal(result.ok, true);
  assert.equal(result.players.find(player => player.id === '221788').regulationClockMinutes, 90, providerType);
  assert.ok(result.informationalCardReviews.some(event => event.providerType === providerType));
  assert.equal(result.formalEligible, false); assert.equal(result.modelEffectApplied, false);
}
const actualFetched = await fetchSoccerPlayerWorkload(actualWorkload, {
  fetchImpl: async url => ({ ok: true, url, json: async () => structuredClone(noCard) }), now: () => noCardAt,
});
assert.equal(actualFetched.ok, true);
assert.equal(actualFetched.players.find(player => player.id === '221788').regulationClockMinutesLast14Days, 90);
assert.equal(actualFetched.matches[0].extractorVersion, SOCCER_MINUTES_AUDIT_V2_VERSION);
assert.equal(actualFetched.pointInTimeAvailabilityVerified, false);
assert.equal(actualFetched.formalEligible, false);

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
assert.equal(fetched.extractorVersion, SOCCER_MINUTES_AUDIT_V2_VERSION);
assert.equal(fetched.matches[0].extractorVersion, SOCCER_MINUTES_AUDIT_V2_VERSION);
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

console.log('PASS observed player workload v2: actual ESPN VAR167/168 no-card regression and fetch/aggregation, source-ID active-state substitution recovery with contrary-name rejection, true minutes and zero-clock appearances, 7/14-day aggregation, identity/final/ET/schema guards, partial omissions, cache/concurrency/deadline bounds; no predicted minutes or model promotion');
