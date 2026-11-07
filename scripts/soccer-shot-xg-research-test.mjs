import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeSoccerWyscoutShotDataset, soccerWyscoutShotHash,
} from '../lib/soccer/wyscout-shot-source.js';
import { soccerWyscoutSyntheticDocuments } from './fixtures/soccer/wyscout-shot-fixture.mjs';
import {
  SOCCER_SHOT_XG_PROTOCOL, fitSoccerShotXgResearch, predictSoccerShotXgResearch,
  soccerShotXgAggregateReport, soccerShotXgHash,
} from '../lib/soccer/shot-xg-research.js';

// Entirely invented records exercise the actual reviewed source parser and
// private source capability. They are not evidence of predictive performance.
const now = Date.parse('2026-11-08T12:00:00Z');
const kickoffs = ['2017-10-01T15:00:00Z', '2017-11-01T15:00:00Z', '2017-12-01T15:00:00Z',
  '2018-01-10T15:00:00Z', '2018-02-01T15:00:00Z', '2018-02-20T15:00:00Z',
  '2018-03-10T15:00:00Z', '2018-04-10T15:00:00Z', '2018-05-10T15:00:00Z'];
function fixture({ dates = kickoffs, mutate = null } = {}) {
  const docs = soccerWyscoutSyntheticDocuments({ kickoffs: dates });
  const events = JSON.parse(docs.eventsDocument.text), matches = JSON.parse(docs.matchesDocument.text);
  if (mutate) mutate(events, matches);
  // Keep label mutation counterexamples source-consistent. Invalid raw-label
  // metadata must be caught by the source parser rather than enter the model.
  for (const match of matches) for (const team of Object.values(match.teamsData)) {
    const selected = events.events.filter(event => event.matchId === match.wyId && event.teamId === team.teamId
      && ['1H', '2H'].includes(event.matchPeriod) && event.tags.some(tag => tag.id === 101));
    team.score = selected.length; team.scoreHT = selected.filter(event => event.matchPeriod === '1H').length;
  }
  for (const [name, data] of [['eventsDocument', events], ['matchesDocument', matches]]) {
    docs[name].text = JSON.stringify(data); docs[name].source.contentHash = soccerWyscoutShotHash(docs[name].text);
  }
  const dataset = normalizeSoccerWyscoutShotDataset({ ...docs, now });
  assert.equal(dataset.ok, true, dataset.reason);
  return dataset;
}
const fit = dataset => fitSoccerShotXgResearch(dataset, { now });
const data = fixture(), report = fit(data);
assert.equal(report.synthetic, true); assert.equal(report.sourceAuthenticationVerified, false);
assert.equal(report.models.candidate.synthetic, true);
assert.equal(report.evaluation.training.candidate.games, 3); assert.equal(report.evaluation.calibration.candidate.games, 3);
assert.equal(report.evaluation.test.candidate.games, 3); assert.equal(report.evaluation.test.candidate.shots, 48);
for (const model of Object.values(report.models)) if (model) {
  assert.equal(model.accepted, false); assert.equal(model.formalEligible, false); assert.equal(model.R, null);
  assert.equal(model.optimization.converged, true); assert.ok(model.optimization.maxGradient < 1e-8);
}
const mean = report.models.constantBaseline.trainingGoals / report.models.constantBaseline.trainingShots;
const test = report.evaluation.test.constantBaseline, goals = test.observedShotGoals, n = test.shots;
assert.ok(Math.abs(test.brier - (goals * (1 - mean) ** 2 + (n - goals) * mean ** 2) / n) < 1e-12);
assert.ok(Math.abs(test.logLoss + (goals * Math.log(mean) + (n - goals) * Math.log1p(-mean)) / n) < 1e-12);
assert.ok(Math.abs(report.evaluation.training.candidate.predictedMean - mean) < 1e-8,
  'an unpenalized fitted intercept must satisfy the training score equation');
assert.ok(Math.abs(report.evaluation.calibration.calibratedCandidate.predictedMean
  - report.evaluation.calibration.calibratedCandidate.observedGoalRate) < 1e-8);
console.log('PASS shot-model numerical oracles: exact constant Brier/log loss and training/calibration intercept score equations');

const first = data.matches[0].shots.find(shot => !shot.penalty);
const target = { ...first, provider: data.provider, league: data.league, coordinateContract: data.coordinateContract };
const prediction = predictSoccerShotXgResearch(report.models.candidate, target);
assert.ok(prediction.xg > 0 && prediction.xg < 1);
assert.equal(prediction.predictionSourceAuthenticationVerified, false);
assert.equal(prediction.sourceAuthenticationVerified, false); assert.equal(prediction.hypotheticalLocation, true);
assert.equal(prediction.accepted, false); assert.equal(prediction.W, null);
for (const change of [{ provider: 'ESPN' }, { league: 'ucl' }, { coordinateContract: 'GUESSED_METRES' },
  { penalty: true }, { period: 3 }, { period: 5 }, { x: 1.1 }, { x: NaN }])
  assert.throws(() => predictSoccerShotXgResearch(report.models.candidate, { ...target, ...change }), /SHOT_XG_/);
assert.throws(() => predictSoccerShotXgResearch(JSON.parse(JSON.stringify(report.models.candidate)), target), /NOT_PRIVATELY_FITTED/);
assert.throws(() => fitSoccerShotXgResearch(JSON.parse(JSON.stringify(data)), { now }), /SOURCE_DATASET_UNVERIFIED/);
const forged = { ...data, accepted: true, synthetic: false, sourceAuthenticationVerified: true };
assert.throws(() => fitSoccerShotXgResearch(forged, { now }), /SOURCE_DATASET_UNVERIFIED/);
assert.throws(() => fitSoccerShotXgResearch(data, { now: now - 1 }), /SOURCE_NOT_AVAILABLE_AT_FIT/);
assert.throws(() => fitSoccerShotXgResearch(data, { now, protocol: { ...SOCCER_SHOT_XG_PROTOCOL, l2: 0.001 } }), /FROZEN_RESEARCH_PLAN/);
console.log('PASS source/model boundaries: actual parser capability, no JSON/flag authority, no source-clock backdating or cross-provider/league/period/penalty transfer');

const flip = event => { const goal = event.tags.some(tag => tag.id === 101);
  event.tags = [{ id: goal ? 1802 : 101 }]; };
const testChanged = fit(fixture({ mutate(events, matches) {
  const dates = new Map(matches.map(match => [match.wyId, match.dateutc]));
  for (const event of events.events) if (dates.get(event.matchId) >= '2018-03-01') flip(event);
} }));
for (const key of Object.keys(report.models)) assert.equal(testChanged.models[key]?.contentHash, report.models[key]?.contentHash,
  'test outcomes cannot change any fitted predictor, scaler, intercept correction or semantic model hash');
assert.notEqual(testChanged.evaluation.test.candidate.brier, report.evaluation.test.candidate.brier);
const testLocations = fit(fixture({ mutate(events, matches) {
  const dates = new Map(matches.map(match => [match.wyId, match.dateutc]));
  for (const event of events.events) if (dates.get(event.matchId) >= '2018-03-01') event.positions[0] = { x: 1, y: 99 };
} }));
for (const key of Object.keys(report.models)) assert.equal(testLocations.models[key]?.contentHash, report.models[key]?.contentHash);
const calChanged = fit(fixture({ mutate(events, matches) {
  const dates = new Map(matches.map(match => [match.wyId, match.dateutc]));
  for (const event of events.events) if (dates.get(event.matchId) >= '2018-01-01' && dates.get(event.matchId) < '2018-03-01') flip(event);
} }));
for (const key of ['candidate', 'locationBaseline', 'constantBaseline'])
  assert.equal(calChanged.models[key].contentHash, report.models[key].contentHash);
assert.notEqual(calChanged.models.calibratedCandidate.contentHash, report.models.calibratedCandidate.contentHash);
const laterFit = fitSoccerShotXgResearch(data, { now: now + 3600000 });
for (const key of Object.keys(report.models)) assert.equal(laterFit.models[key]?.contentHash, report.models[key]?.contentHash);
assert.notEqual(laterFit.contentHash, report.contentHash, 'artifact acquisition/calculation provenance remains separately timed');
console.log('PASS whole-cohort leakage counterexamples: test labels/locations and calibration labels cannot mutate training-only scalers/parameters; fit clocks do not change semantic predictor identities');

const terminalCoordinates = fit(fixture({ mutate(events) {
  for (const event of events.events) { event.positions[1] = { x: 0, y: 0 }; event.expectedGoals = Number(event.tags.some(tag => tag.id === 101)); }
} }));
for (const key of Object.keys(report.models)) assert.equal(terminalCoordinates.models[key]?.contentHash, report.models[key]?.contentHash,
  'shot end and provider xG fields must never enter location features');
const fixedCoordinates = fit(fixture({ mutate(events, matches) {
  const dates = new Map(matches.map(match => [match.wyId, match.dateutc]));
  for (const event of events.events) if (dates.get(event.matchId) < '2018-01-01') event.positions[0] = { x: 90, y: 50 };
} }));
assert.deepEqual(fixedCoordinates.models.candidate.scaling.zeroVariance, [false, true, true, true, true]);
assert.deepEqual(fixedCoordinates.models.candidate.scaling.std, [1, 1, 1, 1, 1]);
assert.equal(predictSoccerShotXgResearch(fixedCoordinates.models.candidate, { ...target, x: 0.2, y: 0.99 }).xg,
  predictSoccerShotXgResearch(fixedCoordinates.models.candidate, { ...target, x: 0.95, y: 0.5 }).xg);
const calibrationEmpty = fit(fixture({ dates: kickoffs.filter(at => at < '2018-01-01' || at >= '2018-03-01') }));
assert.equal(calibrationEmpty.calibrationStatus, 'CALIBRATION_EMPTY'); assert.equal(calibrationEmpty.models.calibratedCandidate, null);
const sameOutcome = fit(fixture({ mutate(events, matches) {
  const dates = new Map(matches.map(match => [match.wyId, match.dateutc]));
  for (const event of events.events) if (dates.get(event.matchId) >= '2018-01-01' && dates.get(event.matchId) < '2018-03-01') event.tags = [{ id: 1802 }];
} }));
assert.equal(sameOutcome.calibrationStatus, 'CALIBRATION_NEEDS_BOTH_OUTCOMES');
assert.equal(sameOutcome.evaluation.test.calibratedCandidate, null);
console.log('PASS no outcome-conditioned features or fabricated calibrators: end coordinates/xG ignored, exact constant-feature invariance and empty/single-class calibration disclosed');

const boundary = fit(fixture({ dates: [...kickoffs,
  '2017-12-29T23:59:00Z', '2017-12-30T00:00:00Z', '2017-12-31T15:00:00Z',
  '2018-02-26T23:59:00Z', '2018-02-27T00:00:00Z', '2018-02-28T15:00:00Z'] }));
assert.equal(boundary.coverage.excludedReasons.STRICT_48H_FIT_BOUNDARY_EMBARGO, 4);
assert.equal(boundary.evaluation.training.candidate.games, 4); assert.equal(boundary.evaluation.calibration.candidate.games, 4);
assert.equal(boundary.evaluation.test.candidate.games, 3);
assert.ok(Date.parse(boundary.models.candidate.trainedThrough) + 48 * 3600000 < Date.parse('2018-01-01T00:00:00Z'));
for (const key of ['training', 'calibration', 'test']) for (const value of Object.values(boundary.evaluation[key])) if (value)
  assert.equal(value.calibrationBins.reduce((sum, bin) => sum + bin.count, 0), value.shots);
const aggregate = soccerShotXgAggregateReport(report), serialized = JSON.stringify(aggregate);
assert.equal(aggregate.synthetic, true); assert.equal(aggregate.sourceAuthenticationVerified, false);
assert.equal(aggregate.fittedCoefficientsIncluded, false); assert.equal(aggregate.rawRowsIncluded, false);
assert.equal(aggregate.models, undefined); assert.equal(aggregate.datasetHash, undefined);
assert.doesNotMatch(serialized, /"(?:weights|scaling|matches|shotId|teamId|positions)":/);
assert.equal(aggregate.sourceAttribution.license, null, 'synthetic data cannot masquerade as a licensed real-source corpus');
assert.equal(aggregate.currentSeasonCoverageVerified, false); assert.equal(aggregate.uclCoverageVerified, false);
assert.equal(aggregate.independentUntouchedTestVerified, false); assert.equal(aggregate.R, null);
const { contentHash, ...body } = aggregate;
assert.equal(contentHash, soccerShotXgHash(body));
assert.throws(() => soccerShotXgAggregateReport(JSON.parse(serialized)), /NOT_PRIVATELY_FITTED/);
console.log('PASS strict48h whole-game embargo, per-shot calibration accounting, aggregate-only publication and explicit synthetic/noncurrent/non-OOS/nonformal scope');

if (fs.existsSync(new URL('../lib/soccer/shot-xg-frozen.js', import.meta.url))) {
  const { soccerShotXgResearchArtifacts } = await import('../lib/soccer/shot-xg-frozen.js');
  const artifact = soccerShotXgResearchArtifacts(), actual = artifact.reports.epl;
  const { contentHash: artifactHash, ...artifactBody } = artifact;
  const { contentHash: reportHash, ...reportBody } = actual;
  assert.equal(artifactHash, soccerShotXgHash(artifactBody)); assert.equal(reportHash, soccerShotXgHash(reportBody));
  assert.equal(artifact.synthetic, false); assert.equal(actual.synthetic, false);
  assert.equal(actual.sourceAuthenticationVerified, true); assert.equal(actual.sourceAttribution.license, 'CC BY 4.0');
  assert.ok(Date.parse(actual.availableAt) <= Date.parse(artifact.createdAt));
  assert.equal(actual.sourceCollection.sourceMatches, 380); assert.equal(actual.sourceCollection.eligibleMatches, 378);
  assert.equal(actual.sourceCollection.quarantinedMatches, 2);
  assert.equal(actual.coverage.sourceMatches, actual.sourceCollection.eligibleMatches);
  assert.equal(actual.coverage.includedMatches + actual.coverage.excludedMatches, actual.sourceCollection.eligibleMatches);
  assert.equal(Object.values(actual.evaluation).reduce((sum, split) => sum + split.candidate.games, 0), actual.coverage.includedMatches);
  assert.equal(Object.values(actual.evaluation).reduce((sum, split) => sum + split.candidate.shots, 0), actual.coverage.includedNonPenaltyShots);
  assert.equal(actual.models, undefined); assert.equal(artifact.reports.ucl, undefined);
  assert.equal(artifact.formalEligible, false); assert.equal(artifact.currentSeasonCoverageVerified, false);
  assert.equal(artifact.uclCoverageVerified, false); assert.equal(artifact.R, null);
  assert.ok(actual.evaluation.test.candidate.games > 0);
  // These are integrity/count checks, not an assertion that a candidate must
  // win. Worse calibration/log-loss or transfer results must remain visible.
  for (const value of Object.values(actual.evaluation.test)) if (value) {
    assert.ok(Number.isFinite(value.brier)); assert.ok(Number.isFinite(value.logLoss));
    assert.equal(value.games, actual.evaluation.test.candidate.games);
    assert.equal(value.shots, actual.evaluation.test.candidate.shots);
  }
  actual.evaluation.test.candidate.brier = 999;
  assert.notEqual(soccerShotXgResearchArtifacts().reports.epl.evaluation.test.candidate.brier, 999);
  console.log('PASS authentic frozen aggregate integrity: 380 published/378 source-eligible games, separate embargo counts, no coefficients/current/UCL/formal claims and immutable clone views');
}
