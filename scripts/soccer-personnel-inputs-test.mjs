import assert from 'node:assert/strict';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerExpectedMinutesResearch, soccerExpectedMinutesHash } from '../lib/soccer/expected-minutes-model.js';
import { soccerExpectedMinutesArtifacts } from '../lib/soccer/expected-minutes-frozen.js';
import { soccerFormalEvidenceReadiness } from '../lib/soccer/formal-evidence-readiness.js';
import { normalizeSoccerPlayerWorkload, soccerPlayerWorkloadArchiveProof, restoreSoccerPlayerWorkloadObservation } from '../lib/soccer/player-workload.js';
import { buildSoccerPersonnelInputs, attachSoccerPersonnelInputs, soccerPersonnelInputSourceProjection,
  getSoccerPersonnelInputArchiveProof, restoreSoccerPersonnelInputObservation } from '../lib/soccer/personnel-inputs.js';

import { soccerPersonnelInputsFixture } from './helpers/soccer-personnel-inputs-fixture.mjs';
const iso = value => new Date(value).toISOString();
const now = Date.parse('2026-11-09T01:00:00.000Z');

for (const league of ['epl', 'ucl']) {
  const f = soccerPersonnelInputsFixture(league, now), before = JSON.stringify(f.evidence);
  const raw = buildSoccerExpectedMinutesResearch(f), result = buildSoccerPersonnelInputs(f);
  assert.equal(result.status, 'PERSONNEL_RESEARCH_INPUTS_CONNECTED');
  assert.equal(result.model.version, raw.version); assert.equal(result.model.artifactHash, raw.model.artifactHash);
  assert.equal(result.validation.status, 'NOT_ACCEPTED'); assert.equal(result.validation.testUntouchedVerified, false);
  assert.equal(JSON.stringify(f.evidence), before, 'pure bridge does not alter lineup, workload or source observations');
  for (const side of ['home', 'away']) {
    const minutes = result.teams[side].minutes;
    assert.equal(minutes.status, 'RESEARCH_FORECAST_AVAILABLE'); assert.equal(minutes.coverage.announcedXI, true);
    assert.equal(minutes.players.length, 20); assert.equal(minutes.coverage.playersWithForecast, 19);
    assert.equal(minutes.coverage.playersWithoutForecast, 1); assert.equal(minutes.coverage.complete, false);
    assert.ok(minutes.expectedTeamMinutes <= 990 + 1e-9);
    assert.equal(minutes.players.filter(player => player.observedStarter).length, 11);
    const newcomer = minutes.players.find(player => player.missingReason);
    assert.equal(newcomer.expectedMinutes, null); assert.equal(newcomer.startProbability, null);
    assert.equal(newcomer.missingReason, 'CURRENT_PLAYER_NOT_IN_VERIFIED_PRIOR_SQUADS');
    for (const forecast of minutes.players.filter(player => player.forecastStatus === 'PRIOR_PARTICIPATION_FORECAST')) {
      const reference = raw.teams[side].players.find(player => player.id === forecast.id);
      assert.equal(forecast.expectedMinutes, reference.expectedMinutes); assert.equal(forecast.startProbability, reference.startProbability);
      assert.ok(forecast.historySources.every(source => source.contentHash.length === 64));
      assert.equal(forecast.replacementId, null);
      assert.ok(forecast.replacementCandidates.every(candidate => candidate.position === forecast.position));
    }
    assert.equal(minutes.modelEffectApplied, false); assert.equal(minutes.formalEligible, false);
    assert.equal(minutes.pointInTimeAvailabilityVerified, false);
  }
  // A published starting flag is not substituted into an unconditioned model
  // probability or silently converted to a hardcoded90-minute projection.
  assert.ok(result.teams.home.minutes.players.some(player => player.observedStarter && player.startProbability !== 1));
  const originalMinutes = structuredClone(f.evidence.teams.home.minutes), originalLineup = f.evidence.teams.home.lineup;
  const originalSource = f.evidence.source, originalWorkload = f.evidence.workload;
  attachSoccerPersonnelInputs(f.evidence, { now: f.now });
  const formal = soccerFormalEvidenceReadiness(f);
  assert.equal(formal.status, 'BLOCKED');
  for (const side of ['HOME', 'AWAY']) {
    assert.ok(formal.reasons.includes(`SOCCER_SCORE_${side}_MINUTES_UNVERIFIED`));
    assert.ok(formal.reasons.includes(`SOCCER_SCORE_${side}_PERSONNEL_MODEL_EFFECT_UNVERIFIED`));
  }
  assert.equal(f.evidence.teams.home.lineup, originalLineup); assert.equal(f.evidence.source, originalSource);
  assert.equal(f.evidence.workload, originalWorkload);
  assert.deepEqual(soccerPersonnelInputSourceProjection(f.evidence).minutes.home, originalMinutes);
  assert.equal(soccerPersonnelInputSourceProjection(structuredClone(f.evidence)), null, 'serialized flags cannot recover a live projection capability');
  const again = attachSoccerPersonnelInputs(f.evidence, { now: f.now });
  assert.deepEqual(again.sourceProjection.minutes.home, originalMinutes, 'repeat attachment never nests a derived field into the raw source projection');
  const proof = getSoccerPersonnelInputArchiveProof(f.evidence, { field: 'teams.home.minutes' });
  assert.ok(proof); assert.equal(proof.kind, 'PERSONNEL_RESEARCH'); assert.equal(proof.documents.length, 2);
  f.evidence.teams.home.minutes.observationArchive = { receiptId: '2'.repeat(64), persisted: true };
  assert.ok(soccerPersonnelInputSourceProjection(f.evidence));
  const awayProof = getSoccerPersonnelInputArchiveProof(f.evidence, { field: 'teams.away.minutes' });
  assert.ok(awayProof, 'archiving the first side does not invalidate proof for the second side');
  assert.equal(Object.hasOwn(awayProof.observation, 'observationArchive'), false);
  const rebuilt = normalizeSoccerPrematch(f.payload, f.game, f.currentSource, f.now);
  rebuilt.sourceDocumentArchive = f.evidence.sourceDocumentArchive;
  const { observationArchive: _archive, ...expectedMinutes } = f.evidence.teams.home.minutes;
  assert.deepEqual(restoreSoccerPersonnelInputObservation(rebuilt, proof), expectedMinutes);
  const alteredProof = structuredClone(proof); alteredProof.reconstructionInputs.workloadProofs.home.documents[0].retainedJson += ' ';
  assert.throws(() => restoreSoccerPersonnelInputObservation(rebuilt, alteredProof), /ARCHIVE_DOCUMENT_INVALID/);
  const forged = structuredClone(proof); forged.observation.players[0].expectedMinutes = 90;
  assert.throws(() => restoreSoccerPersonnelInputObservation(rebuilt, forged), /REPLAY_MISMATCH/);
  f.evidence.teams.home.minutes.players[0].expectedMinutes += 1;
  assert.equal(soccerPersonnelInputSourceProjection(f.evidence), null);
  assert.equal(getSoccerPersonnelInputArchiveProof(f.evidence, { field: 'teams.home.minutes' }), null);
  assert.throws(() => attachSoccerPersonnelInputs(f.evidence, { now: f.now }), /PROOF_CHANGED/);
}

const clean = soccerPersonnelInputsFixture('epl', now);
for (const change of [
  value => { value.createdAt = iso(now + 1); },
  value => { value.leagues.epl.model.league = 'ucl'; },
  value => { value.leagues.epl.model.trainingRowsHash = 'unverified'; },
  value => { value.leagues.epl.model.trainingBefore = iso(now + 1); },
]) {
  const artifact = soccerExpectedMinutesArtifacts(); change(artifact);
  const { contentHash: _oldHash, ...body } = artifact; artifact.contentHash = soccerExpectedMinutesHash(body);
  const result = buildSoccerPersonnelInputs({ ...clean, artifacts: artifact });
  assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.reason, 'PERSONNEL_MINUTES_MODEL_SCOPE_OR_AVAILABILITY_INVALID');
}
for (const change of [
  value => { value.game = { ...value.game, id: 'soccer:ucl:999' }; },
  value => { value.evidence.phase = 'POSTSTART_AUDIT'; },
  value => { value.evidence.source.fetchedAt = iso(value.now + 1); },
  value => { value.evidence.teams.home.lineup.starters[0].id = value.evidence.teams.away.lineup.starters[0].id; },
  value => { value.evidence.teams.home.lineup.bench.push(value.evidence.teams.home.lineup.starters[0]); },
  value => { value.evidence.teams.home.lineup.source.scope.field = 'teams.away.lineup'; },
]) { const value = structuredClone(clean); change(value); assert.equal(buildSoccerPersonnelInputs(value).status, 'UNAVAILABLE'); }
const notAnnounced = structuredClone(clean); notAnnounced.evidence.teams.home.lineup.status = 'NOT_PUBLISHED';
const unannounced = buildSoccerPersonnelInputs(notAnnounced).teams.home.minutes;
assert.equal(unannounced.coverage.announcedXI, false); assert.ok(unannounced.players.every(player => player.observedStarter === null));
const unavailable = structuredClone(clean); unavailable.evidence.workload.teams.home.playerWorkload.sourceId = '999';
assert.equal(buildSoccerPersonnelInputs(unavailable).teams.home.minutes.status, 'UNAVAILABLE');
assert.equal(buildSoccerPersonnelInputs(unavailable).teams.away.minutes.status, 'RESEARCH_FORECAST_AVAILABLE');
const partial = soccerPersonnelInputsFixture('epl', now);
partial.evidence.workload.teams.home.playerWorkload.sourceId = '999';
const originalHomeMinutes = partial.evidence.teams.home.minutes;
attachSoccerPersonnelInputs(partial.evidence, { now });
assert.equal(partial.evidence.teams.home.minutes, originalHomeMinutes, 'unavailable side preserves raw summary field and reference');
assert.equal(partial.evidence.teams.away.minutes.status, 'RESEARCH_FORECAST_AVAILABLE');
assert.ok(soccerPersonnelInputSourceProjection(partial.evidence));
assert.equal(getSoccerPersonnelInputArchiveProof(partial.evidence, { field: 'teams.home.minutes' }), null);
const partialProof = getSoccerPersonnelInputArchiveProof(partial.evidence, { field: 'teams.away.minutes' });
assert.ok(partialProof); assert.equal(partialProof.reconstructionInputs.workloadProofs.home, null);
const partialRebuilt = normalizeSoccerPrematch(partial.payload, partial.game, partial.currentSource, now);
partialRebuilt.sourceDocumentArchive = partial.evidence.sourceDocumentArchive;
assert.deepEqual(restoreSoccerPersonnelInputObservation(partialRebuilt, partialProof), partial.evidence.teams.away.minutes);
partial.evidence.teams.home.minutes.reason = 'FORGED_RAW_REASON';
assert.equal(soccerPersonnelInputSourceProjection(partial.evidence), null, 'unreplaced raw minutes remain under full hash verification');

const workload = clean.evidence.workload.teams.home.playerWorkload, rawProof = soccerPlayerWorkloadArchiveProof(workload);
assert.ok(rawProof); assert.equal(soccerPlayerWorkloadArchiveProof(structuredClone(workload)), null);
assert.deepEqual(restoreSoccerPlayerWorkloadObservation(rawProof), workload);
const originalObservation = rawProof.observations[0];
const mixed = normalizeSoccerPlayerWorkload(rawProof.teamWorkload, [
  { ...originalObservation, data: JSON.parse(rawProof.documents[0].retainedJson) },
  { ok: false, attempted: false, record: { ...originalObservation.record, eventId: '991002' }, code: 'SOCCER_PLAYER_BUDGET_EXCEEDED' },
  { ok: false, attempted: false, record: null, code: 'SOCCER_PLAYER_BUDGET_EXCEEDED' },
], { asOf: now, omissions: [{ eventId: '991003', reason: 'SOCCER_PLAYER_MATCH_LIMIT' }] });
assert.deepEqual(restoreSoccerPlayerWorkloadObservation(soccerPlayerWorkloadArchiveProof(mixed)), mixed,
  'mixed failed/invalid/omitted observations preserve exact coverage and missing reasons');
const empty = normalizeSoccerPlayerWorkload(rawProof.teamWorkload, [], { asOf: now });
assert.equal(empty.ok, false); assert.deepEqual(restoreSoccerPlayerWorkloadObservation(soccerPlayerWorkloadArchiveProof(empty)), empty);
const changedWorkload = structuredClone(rawProof); changedWorkload.observations[0].source.contentHash = '0'.repeat(64);
assert.throws(() => restoreSoccerPlayerWorkloadObservation(changedWorkload), /PROOF_INVALID/);
workload.players[0].name += ' changed'; assert.equal(soccerPlayerWorkloadArchiveProof(workload), null);
console.log('PASS personnel input bridge: current XI/bench and frozen prior forecasts, unchanged numerical predictions, missing newcomers, league/time/identity isolation, raw historical summary replay, private source projection, tamper rejection and no formal promotion (synthetic provider-shaped inputs only)');
