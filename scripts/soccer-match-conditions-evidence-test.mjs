import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { fetchSoccerWorkload, soccerWorkloadSourceDocuments } from '../lib/soccer/workload.js';
import { buildSoccerMatchConditionsEvidence, fetchSoccerMatchConditionsEvidence,
  soccerMatchConditionsDocumentProof, restoreSoccerMatchConditionsObservation, soccerVenueGreatCircleKilometres } from '../lib/soccer/match-conditions-evidence.js';
import { soccerWeatherFixture } from './helpers/soccer-weather-fixture.mjs';

// Retained provider documents plus explicit synthetic coordinates/status
// counterexamples verify engineering only, never model accuracy or acceptance.
const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/soccer/${name}.json`, import.meta.url)));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function doc(data, url, now) { return { ok: true, data, source: { provider: 'ESPN', url,
  requestedAt: new Date(now - 10).toISOString(), fetchedAt: new Date(now).toISOString(), contentHash: digest(data) } }; }
function summary(league = 'epl', change = () => {}) {
  const payload = fixture(`${league}-summary`); change(payload);
  const c = payload.header.competitions[0], now = Date.parse(c.date) - 24 * 3600000;
  const document = doc(payload, `https://site.api.espn.com/apis/site/v2/sports/soccer/${payload.header.league.slug}/summary?event=${payload.header.id}`, now);
  const game = normalizeSoccerSchedule({ leagues: [payload.header.league], events: [{ ...payload.header, date: c.date, status: c.status }] }, league, document.source).games[0];
  return { document, game, now, evidence: normalizeSoccerPrematch(payload, game, document.source, now) };
}
function schedules({ game, now }, withCoordinates = false) {
  const data = fixture('workload-results');
  if (withCoordinates) for (const event of data.events) event.competitions[0].venue = {
    ...event.competitions[0].venue, id: '198', location: { latitude: 51.555, longitude: -0.108 } };
  return [doc(data, 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/359/schedule?season=2026', now)];
}
const e = summary(), documents = schedules(e), original = JSON.stringify({ e, documents });
const value = buildSoccerMatchConditionsEvidence({ game: e.game, summaryDocument: e.document, workloadDocuments: documents, now: e.now });
assert.equal(value.ok, true); assert.equal(value.travel.status, 'PROVIDER_REPORTED_PARTIAL');
assert.equal(value.travel.value.teams.home.status, 'UNKNOWN');
const away = value.travel.value.teams.away;
assert.equal(away.lastKnownCompleted.eventId, '401915417');
assert.equal(away.kickoffGapHoursFromLastCompleted, 116.5);
assert.equal(away.observedCompletedMatchesLast7Days, 1); assert.equal(away.observedCompletedMatchesLast14Days, 2);
assert.ok(away.distinctObservedCompetitions.includes('uefa.champions'));
assert.equal(away.actualRestHours, null); assert.equal(away.actualTravelDistanceKm, null); assert.equal(away.venueDistanceKm, null);
assert.equal(value.travel.coverage.complete, false); assert.equal(value.travel.coverage.internationalDutyCoverageVerified, false);
assert.equal(value.uclContext.status, 'NOT_APPLICABLE');
assert.equal(value.travel.source.scope.field, 'travel'); assert.equal(value.travel.source.scope.gameId, e.game.id);
assert.equal(value.travel.source.availableAt, new Date(e.now).toISOString()); assert.equal(value.travel.source.sourcePublishedAt, null);
assert.equal(soccerMatchConditionsDocumentProof(value.travel), null, 'a pure normalizer creates no private acquisition capability');
assert.equal(JSON.stringify({ e, documents }), original);
for (const result of [value, value.travel, value.uclContext]) {
  assert.equal(result.modelEffectApplied, false); assert.equal(result.formalEligible, false); assert.equal(result.executable, false);
}
const c = summary('epl', payload => { payload.gameInfo.venue.location = { latitude: 52.94, longitude: -1.13 }; });
const distances = buildSoccerMatchConditionsEvidence({ game: c.game, summaryDocument: c.document, workloadDocuments: schedules(c, true), now: c.now });
assert.ok(distances.travel.value.teams.away.venueDistanceKm > 150 && distances.travel.value.teams.away.venueDistanceKm < 200);
assert.equal(distances.travel.value.teams.away.actualTravelDistanceKm, null, 'venue geometry never establishes the actual itinerary');
assert.equal(soccerVenueGreatCircleKilometres({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }), 0);
assert.equal(soccerVenueGreatCircleKilometres({ latitude: 91, longitude: 0 }, { latitude: 0, longitude: 0 }), null);
const conflict = structuredClone(c.document); conflict.data.header.competitions[0].venue = {
  id: '999', fullName: 'Different venue', address: { city: 'Different city', country: 'England' } }; conflict.source.contentHash = digest(conflict.data);
assert.equal(buildSoccerMatchConditionsEvidence({ game: c.game, summaryDocument: conflict, workloadDocuments: schedules(c, true), now: c.now }).travel.value.targetVenue, null);
for (const mutate of [d => { d.source.contentHash = '0'.repeat(64); }, d => { d.source.url = d.source.url.replace('event=', 'foreign='); },
  d => { d.source.fetchedAt = new Date(e.now + 1).toISOString(); }, d => { d.data.header.id = '999'; d.source.contentHash = digest(d.data); }]) {
  const bad = structuredClone(e.document); mutate(bad);
  assert.equal(buildSoccerMatchConditionsEvidence({ game: e.game, summaryDocument: bad, workloadDocuments: documents, now: e.now }).ok, false);
}
const foreign = structuredClone(documents[0]); foreign.source.url = foreign.source.url.replace('/359/', '/999/');
assert.equal(buildSoccerMatchConditionsEvidence({ game: e.game, summaryDocument: e.document, workloadDocuments: [foreign], now: e.now }).travel.status, 'UNKNOWN');
const unordered = structuredClone(documents[0]); unordered.data.events.reverse(); unordered.source.contentHash = digest(unordered.data);
assert.deepEqual(buildSoccerMatchConditionsEvidence({ game: e.game, summaryDocument: e.document, workloadDocuments: [unordered], now: e.now }).travel.value, value.travel.value,
  'provider event order cannot change chronological workload or venue selection');

const u = summary('ucl'), leaguePhase = buildSoccerMatchConditionsEvidence({ game: u.game, summaryDocument: u.document, now: u.now });
assert.equal(leaguePhase.uclContext.value.phase, 'LEAGUE_PHASE'); assert.equal(leaguePhase.uclContext.value.aggregate.status, 'NOT_APPLICABLE');
assert.equal(leaguePhase.uclContext.value.domesticStrengthAdjustment, null); assert.equal(leaguePhase.uclContext.modelEffectApplied, false);
const knockout = summary('ucl', payload => { payload.header.season.name = '2026-27 UEFA Champions League, Round of 16'; });
const ko = buildSoccerMatchConditionsEvidence({ game: knockout.game, summaryDocument: knockout.document, now: knockout.now });
assert.equal(ko.uclContext.value.phase, 'KNOCKOUT'); assert.equal(ko.uclContext.value.aggregate.status, 'UNKNOWN');
assert.equal(ko.uclContext.value.tieFormat, 'NOT_CONFIRMED_FOR_THIS_TIE', 'a knockout label cannot override possible UEFA one-leg exceptions');
const final = summary('ucl', payload => { payload.header.season.name = '2026-27 UEFA Champions League, Final'; payload.header.competitions[0].isFinal = true; });
assert.equal(buildSoccerMatchConditionsEvidence({ game: final.game, summaryDocument: final.document, now: final.now }).uclContext.value.phase, 'FINAL');
const unknown = summary('ucl', payload => { payload.header.season.name = 'Group A'; });
assert.equal(buildSoccerMatchConditionsEvidence({ game: unknown.game, summaryDocument: unknown.document, now: unknown.now }).uclContext.status, 'UNKNOWN');
const past = { ...e, now: Date.parse(e.game.startTime) + 60000 };
assert.equal(buildSoccerMatchConditionsEvidence({ game: e.game, summaryDocument: e.document, workloadDocuments: documents, now: past.now }).travel.status, 'POSTSTART_OBSERVATION');

// The real acquisition path retains immutable provider-shaped originals outside
// public JSON. Archive reconstruction must reproduce the exact observation.
const workload = await fetchSoccerWorkload(e.game, { now: () => e.now, includePlayerMinutes: false, fetchImpl: async url => {
  const parsed = new URL(url), teamId = parsed.pathname.match(/teams\/(\d+)/)[1], year = Number(parsed.searchParams.get('season'));
  const data = teamId === '359' && year === 2026 ? fixture('workload-results') : { status: 'success', team: { id: teamId }, requestedSeason: { year }, events: [] };
  return { ok: true, url, json: async () => data };
} });
assert.equal(soccerWorkloadSourceDocuments(workload).length, 6);
assert.equal(soccerWorkloadSourceDocuments(structuredClone(workload)).length, 0);
let unexpectedFetch = 0;
const live = await fetchSoccerMatchConditionsEvidence({ game: e.game, evidence: e.evidence, workload }, { now: () => e.now,
  fetchJson: async () => { unexpectedFetch++; throw Error('must reuse original summary'); }, fetchVenueGeography: async () => ({ ok: false }) });
assert.equal(unexpectedFetch, 0); assert.equal(live.travel.value.teams.away.lastKnownCompleted.eventId, '401915417');
const proof = soccerMatchConditionsDocumentProof(live.travel);
assert.ok(proof); assert.ok(proof.documents.length >= 6); assert.equal(proof.binding.gameId, e.game.id);
assert.deepEqual(restoreSoccerMatchConditionsObservation(proof), live.travel);
live.travel.observationArchive = { status: 'ARCHIVED', persisted: true, receiptId: 'a'.repeat(64) };
assert.ok(soccerMatchConditionsDocumentProof(live.travel), 'a receipt attached after acquisition preserves the actual producer capability for archive retry');
delete live.travel.observationArchive;
const corruptedProof = structuredClone(proof); corruptedProof.documents[0].text = '{';
assert.equal(restoreSoccerMatchConditionsObservation(corruptedProof), null);
const changedProof = structuredClone(proof); changedProof.documents[0].text = changedProof.documents[0].text.replace('The City Ground', 'Wrong Stadium');
assert.equal(restoreSoccerMatchConditionsObservation(changedProof), null, 'a changed raw document cannot satisfy the normalized observation hash');
const foreignProof = structuredClone(proof); foreignProof.binding.league = 'ucl';
assert.equal(restoreSoccerMatchConditionsObservation(foreignProof), null);
const uclLive = await fetchSoccerMatchConditionsEvidence({ game: u.game, evidence: u.evidence }, { now: () => u.now });
const uclProof = soccerMatchConditionsDocumentProof(uclLive.uclContext);
assert.ok(uclProof); assert.equal(uclProof.documents.length, 1, 'phase evidence uses only its original summary');
assert.deepEqual(restoreSoccerMatchConditionsObservation(uclProof), uclLive.uclContext);

// Synthetic Wikidata originals exercise exact provider-venue identity for the
// previous event, including the honest absence of an ESPN venue ID.
const geoFixture = soccerWeatherFixture(), entities = structuredClone(geoFixture.entities);
entities.Q11 = structuredClone(entities.Q1); entities.Q11.id = 'Q11'; entities.Q11.labels.en.value = 'Emirates Stadium';
entities.Q11.claims.P625[0].mainsnak.datavalue.value.latitude = 51.555;
entities.Q11.claims.P625[0].mainsnak.datavalue.value.longitude = -0.108;
entities.Q11.claims.P276[0].mainsnak.datavalue.value.id = 'Q13';
entities.Q13 = structuredClone(entities.Q3); entities.Q13.id = 'Q13'; entities.Q13.labels.en.value = 'London';
const geographyRequests = [];
const withGeography = await fetchSoccerMatchConditionsEvidence({ game: e.game, evidence: e.evidence, workload }, {
  now: () => e.now, fetchImpl: async url => {
    const parsed = new URL(url); geographyRequests.push(parsed.href);
    const data = parsed.searchParams.get('action') === 'wbsearchentities'
      ? { search: [{ id: parsed.searchParams.get('search') === 'Emirates Stadium' ? 'Q11' : 'Q1' }] }
      : { entities: Object.fromEntries(parsed.searchParams.get('ids').split('|').map(key => [key, entities[key]])) };
    return new Response(JSON.stringify(data), { status: 200 });
  } });
const geoAway = withGeography.travel.value.teams.away;
assert.ok(geographyRequests.length >= 4); assert.equal(geoAway.previousVenue.venueId, null);
assert.equal(geoAway.previousVenue.scopeKey, 'soccer:epl:event:401915417:venue');
assert.equal(geoAway.previousVenue.coordinateProviderEntityId, 'Q11');
assert.ok(geoAway.venueDistanceKm > 150 && geoAway.venueDistanceKm < 200);
assert.equal(geoAway.actualTravelDistanceKm, null); assert.equal(geoAway.actualRestHours, null);
assert.ok(withGeography.travel.sources.some(source => source.provider === 'WIKIDATA'), 'all coordinates expose their actual input source documents');
assert.deepEqual(restoreSoccerMatchConditionsObservation(soccerMatchConditionsDocumentProof(withGeography.travel)), withGeography.travel);
assert.equal(soccerMatchConditionsDocumentProof(structuredClone(live.travel)), null);
const forged = structuredClone(live.travel); forged.modelEffectApplied = true; assert.equal(soccerMatchConditionsDocumentProof(forged), null);
const mutated = live.travel; mutated.value.teams.away.observedCompletedMatchesLast14Days++;
assert.equal(soccerMatchConditionsDocumentProof(mutated), null, 'changed normalized values lose their acquisition capability');
console.log('PASS match-condition evidence: exact summary and all-competition schedule identity/hash/time, chronological observed workload, no fabricated recovery or itinerary, venue geometry, explicit UCL phase and aggregate applicability, private originals and exact reconstruction; no formal promotion');
