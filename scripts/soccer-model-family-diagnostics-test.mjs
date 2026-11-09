import assert from 'node:assert/strict';
import { diagnoseSoccerModelFamily } from '../lib/soccer/model-family-diagnostics.js';

// Synthetic tests of the diagnostic calculation and counterexamples. They do
// not assert that a real football model, its family or source has been accepted.
const baseline = { league: 'epl', period: 'FT', modelHash: 'a'.repeat(64),
  createdAt: '2026-10-01T00:00:00Z', trainedThrough: '2026-09-30T00:00:00Z', sourceHashes: ['b'.repeat(64)] };
const protocol = { registeredAt: '2026-10-01T00:00:00Z', calibrationFrom: '2026-10-02T00:00:00Z',
  calibrationBefore: '2026-10-10T00:00:00Z', testFrom: '2026-10-11T00:00:00Z', testBefore: '2026-10-15T00:00:00Z', alpha: .1 };
const now = Date.parse('2026-10-16T00:00:00Z');
const row = (id, day, home, away, extra = {}) => ({ league: 'epl', period: 'FT', gameId: `soccer:epl:${id}`,
  baselineModelHash: baseline.modelHash, kickoff: `2026-10-${day}T12:00:00Z`, predictedAt: `2026-10-${day}T11:00:00Z`,
  resultAvailableAt: `2026-10-${day}T15:00:00Z`, homeRate: 1, awayRate: 2,
  actualScore: { home, away }, sourceHashes: ['c'.repeat(64)], ...extra });
const observations = [row(1, '03', 0, 2), row(2, '04', 1, 4), row(3, '05', 2, 0), row(4, '06', 3, 2),
  row(5, '12', 1, 2), row(6, '13', 2, 1)];
const input = { observations, baseline, protocol, now, requestedScopeComplete: true };
const before = JSON.stringify(input), d = diagnoseSoccerModelFamily(input);
assert.equal(d.status, 'DESCRIPTIVE_SIGNALS_AVAILABLE');
assert.equal(d.calibration.realGames, 4); assert.equal(d.test.realGames, 2);
assert.equal(d.calibration.sides.home.goals, 6); assert.equal(d.calibration.sides.home.exposure, 4);
assert.equal(d.calibration.sides.home.meanResidual.value, .5);
assert.equal(d.calibration.sides.home.pearsonSum.value, 6);
assert.equal(d.calibration.sides.home.pearsonPerGame.value, 1.5);
assert.equal(d.calibration.sides.home.time.lag1Correlation.value, 1);
assert.equal(d.calibration.sides.home.time.early.realGames, 2);
assert.equal(d.calibration.sides.home.time.late.realGames, 2);
assert.equal(d.calibration.sides.home.time.residualMeanChange.value, 2);
assert.equal(d.test.evaluationMode, 'DESCRIPTIVE_REPLAY'); assert.equal(d.test.pretestFreezeVerified, false);
assert.equal(JSON.stringify(input), before, 'the diagnostic must not mutate raw evidence');
for (const key of ['accepted', 'formalEligible', 'coverageAssumptionsVerified', 'untouchedTestVerified', 'executable']) assert.equal(d[key], false);
for (const key of ['formalModelError', 'modelMisspecificationBound', 'W', 'R', 'S']) assert.equal(d[key], null);

const repeated = diagnoseSoccerModelFamily({ ...input, observations: [...observations, ...observations] });
assert.equal(repeated.calibration.realGames, 4); assert.equal(repeated.test.realGames, 2);
assert.deepEqual(repeated.calibration, d.calibration); assert.equal(repeated.duplicateReceipts, 6);
const corrected = diagnoseSoccerModelFamily({ ...input, observations: [...observations, { ...observations[0], actualScore: { home: 9, away: 2 } }] });
assert.equal(corrected.calibration.realGames, 3); assert.equal(corrected.quarantinedGames, 1);
const changedRate = diagnoseSoccerModelFamily({ ...input, observations: [...observations, { ...observations[1], homeRate: 1.1 }] });
assert.equal(changedRate.calibration.realGames, 3); assert.equal(changedRate.quarantinedGames, 1);
const shiftedGame = diagnoseSoccerModelFamily({ ...input, observations: [...observations, { ...observations[1], kickoff: '2026-10-12T12:00:00Z',
  predictedAt: '2026-10-12T11:00:00Z', resultAvailableAt: '2026-10-12T15:00:00Z' }] });
assert.equal(shiftedGame.quarantinedGames, 1, 'a game cannot re-enter as a separate later test observation');
const outsideCorrection = diagnoseSoccerModelFamily({ ...input, observations: [...observations, { ...observations[1],
  kickoff: '2026-10-10T12:00:00Z', predictedAt: '2026-10-10T11:00:00Z', resultAvailableAt: '2026-10-10T15:00:00Z' }] });
assert.equal(outsideCorrection.calibration.realGames, 3);
assert.equal(outsideCorrection.quarantinedGames, 1, 'a valid same-model context correction in the gap still quarantines the real game');
const mixed = diagnoseSoccerModelFamily({ ...input, observations: [...observations,
  { ...observations[0], league: 'ucl', gameId: 'soccer:ucl:1' }, { ...observations[0], period: 'HT' },
  { ...observations[0], baselineModelHash: 'd'.repeat(64) }] });
assert.deepEqual(mixed.calibration, d.calibration); assert.equal(mixed.excludedReasons.MODEL_FAMILY_OBSERVATION_OUTSIDE_SCOPE, 3);

const ties = [row(1, '03', 0, 0), row(2, '03', 2, 4), row(3, '04', 3, 2), row(4, '05', 4, 3)];
const tied = diagnoseSoccerModelFamily({ ...input, observations: ties });
const reversed = diagnoseSoccerModelFamily({ ...input, observations: [...ties].reverse() });
assert.deepEqual(tied.calibration, reversed.calibration, 'same-time ID/input order cannot create temporal evidence');
assert.equal(tied.calibration.sides.home.time.distinctKickoffCohorts, 3);
assert.equal(tied.calibration.sides.home.time.lag1Pairs, 2);
assert.equal(tied.calibration.sides.home.time.early.realGames, 2, 'same kickoff games remain in the same segment');
const constant = diagnoseSoccerModelFamily({ ...input, observations: [row(1, '03', 1, 2), row(2, '04', 1, 2), row(3, '05', 1, 2)] });
assert.equal(constant.calibration.sides.home.time.lag1Correlation.value, null);
assert.equal(constant.calibration.sides.home.time.lag1Correlation.state, 'UNAVAILABLE');

const changedTest = diagnoseSoccerModelFamily({ ...input, observations: observations.map(value => Date.parse(value.kickoff) >= Date.parse(protocol.testFrom)
  ? { ...value, actualScore: { home: 80, away: 90 } } : value) });
assert.deepEqual(changedTest.calibration, d.calibration, 'test labels never affect calibration diagnostics or a fitted parameter');
const context = { ...input, freezeReceipt: { claimedVerified: true }, frozenArtifactHash: 'e'.repeat(64) };
assert.equal(diagnoseSoccerModelFamily(context).test.pretestFreezeVerified, false, 'caller receipt flags are not DB authority');
let verifiedContext;
const frozen = diagnoseSoccerModelFamily(context, { verifyFreezeReceipt: value => {
  verifiedContext = value; return value.artifactHash === 'e'.repeat(64) && value.firstTestKickoff === observations[4].kickoff;
} });
assert.equal(frozen.test.pretestFreezeVerified, true); assert.equal(frozen.test.evaluationMode, 'FROZEN_TEST_DIAGNOSTICS');
assert.equal(frozen.untouchedTestVerified, false); assert.equal(frozen.formalEligible, false);
assert.equal(verifiedContext.modelHash, baseline.modelHash); assert.ok(/^[a-f0-9]{64}$/.test(verifiedContext.protocolHash));
assert.equal(diagnoseSoccerModelFamily(context, { verifyFreezeReceipt: () => 'true' }).test.pretestFreezeVerified, false);
assert.equal(diagnoseSoccerModelFamily(context, { verifyFreezeReceipt: () => Promise.resolve(true) }).test.pretestFreezeVerified, false,
  'an unawaited promise cannot count as a successful authoritative verification');
assert.equal(diagnoseSoccerModelFamily(context, { verifyFreezeReceipt: () => { throw Error('DB unavailable'); } }).test.pretestFreezeVerified, false);
assert.equal(diagnoseSoccerModelFamily({ ...context, requestedScopeComplete: false }, { verifyFreezeReceipt: () => true }).test.pretestFreezeVerified, false);
assert.equal(diagnoseSoccerModelFamily({ ...input, requestedScopeComplete: false }).status, 'PARTIAL_SOURCE');
const withoutPrediction = diagnoseSoccerModelFamily({ ...input, observations: [row(1, '03', 1, 2, { predictedAt: '2026-10-03T13:00:00Z' })] });
assert.equal(withoutPrediction.calibration.realGames, 0);
assert.equal(diagnoseSoccerModelFamily({ ...input, observations: [{ ...observations[0], predictedAt: null }] }).calibration.realGames, 0,
  'the private source adapter must supply an actual saved pregame forecast time');
assert.equal(diagnoseSoccerModelFamily({ ...input, observations: [{ ...observations[0], resultAvailableAt: '2026-10-17T00:00:00Z' }] }).calibration.realGames, 0);
const overflow = diagnoseSoccerModelFamily({ ...input, observations: [row(1, '03', 100, 2, { homeRate: Number.MIN_VALUE })] });
assert.equal(overflow.calibration.sides.home.pearsonPerGame.state, 'POSITIVE_INFINITY');
assert.equal(overflow.calibration.sides.home.pearsonPerGame.value, null, 'JSON cannot silently turn an infinite diagnostic into an apparently valid zero');
assert.equal(diagnoseSoccerModelFamily({ ...input, baseline: { ...baseline, league: 'nba' } }).status, 'INVALID_SCOPE');
assert.equal(diagnoseSoccerModelFamily({ ...input, protocol: { ...protocol, calibrationBefore: '2026-10-18T00:00:00Z' } }).status, 'INVALID_SCOPE');
console.log('PASS model-family applicability diagnostics: independent games, whole-game correction quarantine, exact scope, chronological tied cohorts, residual moments and lag signals, calibration/test isolation, DB pretest authority boundary, missing/infinite metrics and no automatic acceptance');
