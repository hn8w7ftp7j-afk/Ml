import assert from 'node:assert/strict';
import { buildMlbAdvancedAdjustmentV2 } from '../lib/mlb-advanced-features-v2.js';
import { buildServerOwnedMlbAdvancedPolicyV110 } from '../lib/mlb-advanced-runtime-policy-v110.js';
import { buildJointScoreSnapshotV13, estimateRunProfileV13 } from '../lib/joint-score-v13.js';
import { sha256 } from '../lib/snapshot-v9.js';

const observedAt = '2026-08-22T12:00:00.000Z';
const gameDate = '2026-08-23T00:00:00.000Z';
const families = ['fielding', 'injury', 'pitchMatchup', 'catcherFraming', 'umpireZone', 'directionalWind'];
const reportKeys = { fielding: 'fielding', injury: 'injury', pitchMatchup: 'pitchMatchup', catcherFraming: 'catcherFraming', umpireZone: 'umpireZone', directionalWind: 'windOrientation' };

const pass = () => ({ folds: [2022, 2023, 2024, 2025].map(validationSeason => ({
  validationSeason,
  sufficient: true,
  metrics: { poissonLossDeltaUpper95: -0.001, rmseDelta: -0.01, calibrationErrorDelta: -0.001 },
})) });

function artifactFor(enabledFamilies, { impact = 0.05 } = {}) {
  const featureFamilyOos = {};
  const featurePromotionInputs = {};
  for (const family of enabledFamilies) {
    featureFamilyOos[reportKeys[family]] = pass();
    featurePromotionInputs[family] = {
      learnedBlendWeight: 1,
      absoluteRunDeltaP99: impact,
      ...(family === 'injury' ? { officialImmutableIl: true } : {}),
      ...(family === 'umpireZone' ? { abs2026SeparatelyValidated: true } : {}),
    };
  }
  return {
    featureFamilyOos,
    featurePromotionInputs,
    ...(enabledFamilies.includes('umpireZone') ? {
      regimeValidation: { umpireZone2026AbsChallenge: { status: 'PASSED', pitSafe: true, sampleSufficient: true, regime: 'MLB_2026_ABS_CHALLENGE' } },
    } : {}),
  };
}

function trustedPolicy(enabledFamilies, options) {
  const artifact = artifactFor(enabledFamilies, options);
  return buildServerOwnedMlbAdvancedPolicyV110(artifact, {
    approved: true,
    artifactHash: sha256(artifact),
    releaseId: `test-${enabledFamilies.join('-')}`,
    approvedAt: '2026-08-22T13:00:00.000Z',
  });
}

const advanced = {
  fielding: { status: 'CONFIRMED', validationStatus: 'PENDING', observedAt, fieldingRunValue: 12, catcherFramingRuns: 3, includesCatcherFraming: true, innings: 900, gamesEquivalent: 100 },
  catcherFraming: { status: 'CONFIRMED', validationStatus: 'PENDING', observedAt, framingRuns: 5, pitches: 2200, gamesEquivalent: 100 },
  umpireZone: { status: 'PROJECTED', validationStatus: 'PENDING', observedAt, catcherNeutralRunsPerGame: -0.08, takenPitches: 2600 },
  injuryRunValue: { status: 'CONFIRMED', validationStatus: 'PENDING', observedAt, expectedAbsentShare: 1, replacementRunDeltaPerGame: 0.22, lineupCoverage: 1, regressedValue: { battingRunsPerGame: 0.18, fieldingRunsPerGame: 0.06, baserunningRunsPerGame: 0.03 } },
  pitchTypeMatchup: { status: 'CONFIRMED', validationStatus: 'PENDING', observedAt, centeredRunValuePer100: 0.30, expectedPitches: 95, samplePitches: 4000, lineupCoverage: 1 },
};

function team() {
  return {
    hitting: { status: 'CONFIRMED', games: 120, runsPerGame: 4.5, ops: 0.725 },
    recentHitting: { status: 'PROJECTED', games: 12, runsPerGame: 4.5, ops: 0.725 },
    pitching: { status: 'CONFIRMED', inningsPitched: 1000, era: 4.2, fip: 4.2, whip: 1.30 },
    recentPitching: { status: 'PROJECTED', inningsPitched: 110, era: 4.2, fip: 4.2, whip: 1.30 },
    starter: { status: 'CONFIRMED', throwsStatus: 'CONFIRMED', throws: 'R', expectedInnings: 5.5, inningsPitched: 120, gamesStarted: 21, gamesPitched: 21, era: 4.0, fip: 4.05, whip: 1.25 },
    lineup: { status: 'CONFIRMED', official: true, projected: false, offensiveIndex: 1 },
    vsLeft: { status: 'CONFIRMED', available: true, plateAppearances: 850, ops: 0.725 },
    vsRight: { status: 'CONFIRMED', available: true, plateAppearances: 1800, ops: 0.725 },
    bullpen: { status: 'CONFIRMED', pureRelief: true, qualityFactor: 1 },
    injuriesAvailable: true,
    injuries: [],
    scoring: { games: 60, meanRuns: 4.5, varianceRuns: 7 },
    advanced: structuredClone(advanced),
  };
}

function context() {
  return {
    game: { gamePk: 991100, gameDate },
    league: { runsPerTeamGame: 4.5, ops: 0.725, era: 4.2, whip: 1.30, kPer9: 8.7, bbPer9: 3.2, hrPer9: 1.15 },
    away: team(),
    home: team(),
    park: { runFactor: 1, factorStatus: 'CONFIRMED' },
    weather: { meanRunFactor: 1, status: 'CONFIRMED' },
    advancedEnvironment: { directionalWind: { status: 'CONFIRMED', validationStatus: 'PENDING', observedAt, validatedRunsPerMphAlignment: 0.02, parkBaselineAlignedWindMph: 2, fieldBearingDegrees: 45, windFromDegrees: 225, windSpeedMph: 12, roofOpenProbability: 1 } },
    sourceStatuses: { lineups: 'CONFIRMED' },
  };
}

const defaultNeutral = buildMlbAdvancedAdjustmentV2(context());
assert.equal(defaultNeutral.awayRunFactor, 1);
assert.equal(defaultNeutral.homeRunFactor, 1);
assert.equal(defaultNeutral.promotion.allNeutral, true);
assert.deepEqual(defaultNeutral.promotion.promotedFamilies, []);
assert.ok(families.every(family => defaultNeutral.promotion.families[family].runtimeStatus === 'DIAGNOSTIC_NEUTRAL'));

const malicious = context();
malicious.advancedPromotionPolicy = Object.fromEntries(families.map(family => [family, { promoted: true, blendWeight: 1 }]));
const payloadIgnored = buildMlbAdvancedAdjustmentV2(malicious);
assert.equal(payloadIgnored.awayRunFactor, 1, 'serialized context policy must never activate a feature');
assert.equal(payloadIgnored.promotion.payloadPolicyIgnored, true);

const untrustedPolicy = { __meta: { maxAbsoluteRunDeltaPerTeam: 0.30 }, ...Object.fromEntries(families.map(family => [family, { promoted: true, blendWeight: 1 }])) };
const untrustedRejected = buildMlbAdvancedAdjustmentV2(context(), { serverOwnedPromotionPolicy: untrustedPolicy });
assert.equal(untrustedRejected.awayRunFactor, 1);
assert.equal(untrustedRejected.promotion.untrustedOverrideRejected, true);

const futureArtifact = artifactFor(['fielding']);
const futurePolicy = buildServerOwnedMlbAdvancedPolicyV110(futureArtifact, {
  approved: true,
  artifactHash: sha256(futureArtifact),
  releaseId: 'future-policy-test',
  approvedAt: '2026-08-23T01:00:00.000Z',
});
const futureRejected = buildMlbAdvancedAdjustmentV2(context(), { serverOwnedPromotionPolicy: futurePolicy });
assert.equal(futureRejected.awayRunFactor, 1, 'a policy approved after first pitch must remain neutral for this PIT context');
assert.equal(futureRejected.promotion.policyPointInTimeRejected, true);
assert.equal(futureRejected.promotion.policyRejectionReason, 'PROMOTION_POLICY_NOT_EFFECTIVE_BEFORE_CONTEXT');

for (const family of families) {
  const result = buildMlbAdvancedAdjustmentV2(context(), { serverOwnedPromotionPolicy: trustedPolicy([family]) });
  assert.deepEqual(result.promotion.promotedFamilies, [family], `${family} must be independently promoted`);
  assert.deepEqual(result.promotion.activeFamilies, [family], `${family} must activate only its own coefficient`);
  assert.equal(result.promotion.families[family].runtimeStatus, 'PROMOTED_ACTIVE');
  assert.ok(families.filter(name => name !== family).every(name => result.promotion.families[name].runtimeStatus === 'DIAGNOSTIC_NEUTRAL'));
  assert.ok(Math.abs(result.awayRunFactor - 1) > 1e-8 || Math.abs(result.homeRunFactor - 1) > 1e-8, `${family} promotion must affect at least one run mean`);
}

const allPolicy = trustedPolicy(families, { impact: 0.30 });
const profile = estimateRunProfileV13(context(), { serverOwnedPromotionPolicy: allPolicy });
assert.deepEqual(profile.components.advancedPromotion.promotedFamilies.sort(), [...families].sort());
assert.equal(profile.components.advancedPromotion.source, 'SERVER_OWNED_MODULE');
assert.ok(Math.abs(profile.components.advancedRunBudget.awayActualScheduledRunDelta) <= 0.300000000001);
assert.ok(Math.abs(profile.components.advancedRunBudget.homeActualScheduledRunDelta) <= 0.300000000001);
const snapshot = buildJointScoreSnapshotV13({ context: context(), modelVersion: 'test-v110', rulesVersion: 'test-v110', serverOwnedPromotionPolicy: allPolicy });
assert.equal(snapshot.profile.components.advancedPromotion.releaseApproved, true);
assert.equal(snapshot.profile.components.advancedPromotion.activeFamilies.length, 6);

const capContext = context();
for (const side of ['away', 'home']) {
  capContext[side].advanced.fielding.fieldingRunValue = -500;
  capContext[side].advanced.fielding.catcherFramingRuns = -50;
  capContext[side].advanced.catcherFraming.framingRuns = -500;
  capContext[side].advanced.umpireZone.catcherNeutralRunsPerGame = 3;
  capContext[side].advanced.injuryRunValue.regressedValue.fieldingRunsPerGame = 0;
  capContext[side].advanced.injuryRunValue.regressedValue.baserunningRunsPerGame = 0;
  capContext[side].advanced.pitchTypeMatchup.centeredRunValuePer100 = 5;
}
capContext.advancedEnvironment.directionalWind.validatedRunsPerMphAlignment = 1;
const cappedProfile = estimateRunProfileV13(capContext, { serverOwnedPromotionPolicy: allPolicy });
assert.equal(cappedProfile.components.advancedRunBudget.awayCapped, true);
assert.equal(cappedProfile.components.advancedRunBudget.homeCapped, true);
assert.ok(Math.abs(cappedProfile.components.advancedRunBudget.awayActualScheduledRunDelta - 0.30) < 1e-10);
assert.ok(Math.abs(cappedProfile.components.advancedRunBudget.homeActualScheduledRunDelta - 0.30) < 1e-10);

console.log(JSON.stringify({
  ok: true,
  defaultNeutral: defaultNeutral.promotion.allNeutral,
  independentlyPromoted: families,
  advancedRunBudget: profile.components.advancedRunBudget,
  cappedRunBudget: cappedProfile.components.advancedRunBudget,
}, null, 2));
