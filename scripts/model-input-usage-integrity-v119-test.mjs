import assert from 'node:assert/strict';
import { estimateAsianRunProfileV1, buildAsianJointScoreSnapshotV1 } from '../lib/asian-joint-score-v1.js';
import { buildAsianGameContext } from '../lib/asian-baseball.js';
import { estimateRunProfileV13, buildJointScoreSnapshotV13 } from '../lib/joint-score-v13.js';
import { estimateRunProfileV103 } from '../lib/mlb-run-model-v103.js';

function asianContext() {
  const team = () => ({
    seasonHitting: { runsPerGame: 4.2 },
    starter: { confirmed: true, qualityFactor: 1, expectedInnings: 5.5, season: { battersFaced: 420 } },
    lineup: { official: true, offensiveIndex: 1 },
    bullpen: { pureRelief: true, qualityFactor: 1, sampleInnings: 120, fatigueIndex: 0.1, highLeverageAvailability: 0.9 },
  });
  return {
    leagueId: 'CPBL', game: { gamePk: 'USAGE-CPBL' }, league: { runsPerTeamGame: 4.2 },
    coreModelable: true, dataGateV10: { passedForShadowScore: true }, analysisReadiness: { distributionEngineReady: true },
    away: team(), home: team(), park: { runFactor: 1, sampleGames: 30 }, weather: { meanRunFactor: 1 },
    gameStateModel: { regulationInnings: 9, extraInningsLimit: 12, allowDraw: true },
  };
}

const numericView = profile => ({ first5: profile.first5, middle3: profile.middle3, ninth: profile.ninth, uncertainty: profile.uncertainty });
const usage = (profile, key) => profile.dataUsage.find(row => row.key === key);
const asianBase = asianContext();
const asianProfile = estimateAsianRunProfileV1(asianBase);
const strongerStarter = structuredClone(asianBase);
strongerStarter.home.starter.qualityFactor = 0.8;
assert.ok(estimateAsianRunProfileV1(strongerStarter).first5.away < asianProfile.first5.away, 'actual opposing starter quality changes run estimates');

const missingAsian = structuredClone(asianBase);
delete missingAsian.home.starter.qualityFactor;
delete missingAsian.home.starter.expectedInnings;
delete missingAsian.home.bullpen.qualityFactor;
const missingAsianProfile = estimateAsianRunProfileV1(missingAsian);
for (const missing of [null, '', false, [], {}]) {
  const invalid = structuredClone(missingAsian);
  invalid.home.starter.qualityFactor = missing;
  invalid.home.starter.expectedInnings = missing;
  invalid.home.bullpen.qualityFactor = missing;
  assert.deepEqual(numericView(estimateAsianRunProfileV1(invalid)), numericView(missingAsianProfile), 'absent/invalid values use missing-data fallback, never fabricated zero');
}

const diagnosticOnly = structuredClone(asianBase);
diagnosticOnly.home.bullpen.fatigueIndex = 0.95;
diagnosticOnly.home.bullpen.highLeverageAvailability = 0.1;
diagnosticOnly.home.starter.projectionConfidence = 0.1;
const diagnosticProfile = estimateAsianRunProfileV1(diagnosticOnly);
assert.deepEqual(numericView(diagnosticProfile), numericView(asianProfile));
for (const key of ['home.bullpen.fatigueIndex', 'home.bullpen.highLeverageAvailability', 'home.starter.projectionConfidence']) {
  assert.equal(usage(diagnosticProfile, key).usedInMean, false);
  assert.equal(usage(diagnosticProfile, key).usedInUncertainty, false);
  assert.match(usage(diagnosticProfile, key).reason, /DIAGNOSTIC_ONLY/);
}

const candidateContext = structuredClone(asianBase);
candidateContext.home.starter.confirmed = false;
candidateContext.home.starter.projectionMode = 'OFFICIAL_PRIOR_START_ROTATION_MIXTURE';
candidateContext.home.starter.candidates = [
  { id: 'A', probability: 2, qualityFactor: 0.8, expectedInnings: 5.5, battersFaced: 420 },
  { id: 'B', probability: 2, qualityFactor: 1.2, expectedInnings: 5.5, battersFaced: 420 },
];
const candidateProfile = estimateAsianRunProfileV1(candidateContext);
assert.deepEqual(numericView(candidateProfile), numericView(asianProfile), 'candidate mixture must remain diagnostic until validated/approved');
assert.equal(candidateProfile.starterMixtureDiagnostic.usedInProductionDistribution, false);
assert.equal(candidateProfile.starterMixtureDiagnostic.uncertaintyExpanded, false);
assert.equal(candidateProfile.starterMixtureDiagnostic.componentCount, 2);
assert.deepEqual(candidateProfile.starterMixtureDiagnostic.components.map(row => row.weight), [0.5, 0.5]);
assert.ok(candidateProfile.starterMixtureDiagnostic.betweenCandidateVariance.first5.away > 0, 'diagnostic must reveal actual candidate spread instead of claiming a fictitious uncertainty effect');
assert.equal(usage(candidateProfile, 'home.starter.candidates').usedInUncertainty, false);
assert.match(usage(candidateProfile, 'home.starter.candidates').reason, /PENDING_VALIDATION/);
const incompleteCandidate = structuredClone(candidateContext);
incompleteCandidate.home.starter.candidates[1].qualityFactor = null;
const incompleteProfile = estimateAsianRunProfileV1(incompleteCandidate);
assert.equal(incompleteProfile.starterMixtureDiagnostic.candidateUsed, false, 'never omit a missing candidate and redistribute its probability to known pitchers');

function mlbContext() {
  const team = () => ({
    hitting: { status: 'CONFIRMED', games: 120, runsPerGame: 4.5, ops: 0.725 },
    recentHitting: { status: 'PROJECTED', games: 12, runsPerGame: 4.5, ops: 0.725 },
    starter: { status: 'CONFIRMED', throws: 'R', throwsStatus: 'CONFIRMED', inningsPitched: 120, gamesStarted: 20, era: 4.2, whip: 1.3 },
    lineup: { official: true, offensiveIndex: 1 },
    bullpen: { status: 'CONFIRMED', pureRelief: true, qualityFactor: 1 },
    vsLeft: { available: true, status: 'CONFIRMED', ops: 0.725, plateAppearances: 600 },
    vsRight: { available: true, status: 'CONFIRMED', ops: 0.725, plateAppearances: 1200 },
    injuriesAvailable: true, injuries: [], scoring: { games: 60, varianceRuns: 7 },
  });
  return {
    game: { gamePk: 'USAGE-MLB' },
    league: { runsPerTeamGame: 4.5, ops: 0.725, era: 4.2, whip: 1.3, kPer9: 8.6, bbPer9: 3.2, hrPer9: 1.15 },
    away: team(), home: team(), park: { runFactor: 1, factorStatus: 'CONFIRMED' },
    weather: { meanRunFactor: 1, status: 'CONFIRMED' }, sourceStatuses: { lineups: 'CONFIRMED' },
  };
}
const mlbBase = mlbContext();
const mlbProfile = estimateRunProfileV13(mlbBase);
const unknownHand = structuredClone(mlbBase);
unknownHand.home.starter.throwsStatus = 'MISSING';
const unknownHandProfile = estimateRunProfileV13(unknownHand);
assert.deepEqual(unknownHandProfile.first5, mlbProfile.first5, 'status residual must not alter mean runs');
assert.deepEqual(unknownHandProfile.ninth, mlbProfile.ninth);
assert.ok(unknownHandProfile.uncertainty.away > mlbProfile.uncertainty.away, 'existing opposing hand residual must reach away-run parameter uncertainty');
assert.equal(unknownHandProfile.uncertainty.home, mlbProfile.uncertainty.home, 'hand uncertainty must affect correct opponent only');
const baseModel = estimateRunProfileV103(unknownHand);
assert.ok(Math.abs(unknownHandProfile.uncertainty.away ** 2 - baseModel.uncertainty.away ** 2 - unknownHandProfile.diagnostics.stateFeatureResidual.away ** 2) < 1e-15);
assert.equal(unknownHandProfile.diagnostics.stateFeatureResidual.usedInUncertainty, true);
assert.equal(mlbProfile.dataUsage.filter(row => row.key.startsWith('advanced.')).length, 6);
assert.ok(mlbProfile.dataUsage.filter(row => row.key.startsWith('advanced.')).every(row => row.usedInMean === false), 'unvalidated advanced features remain unpromoted');

const missingMlb = structuredClone(mlbBase);
delete missingMlb.home.starter.era;
delete missingMlb.home.starter.whip;
delete missingMlb.home.bullpen.qualityFactor;
const missingMlbProfile = estimateRunProfileV13(missingMlb);
assert.equal(missingMlbProfile.components.homeStarterExpectedInnings, 6, 'no supplied innings uses actual IP/starts, not a coerced zero');
for (const missing of [null, '', false, [], {}]) {
  const invalid = structuredClone(missingMlb);
  Object.assign(invalid.home.starter, { era: missing, whip: missing, expectedInnings: missing, kPer9: missing, bbPer9: missing, hrPer9: missing });
  invalid.home.bullpen.qualityFactor = missing;
  assert.deepEqual(numericView(estimateRunProfileV13(invalid)), numericView(missingMlbProfile));
}
const trueZeroEra = structuredClone(missingMlb);
trueZeroEra.home.starter.era = 0;
assert.ok(estimateRunProfileV13(trueZeroEra).first5.away < missingMlbProfile.first5.away, 'observed zero ERA remains valid and follows existing clamps');

const snapshot = buildJointScoreSnapshotV13({ context: unknownHand, modelVersion: 'integrity-test', rulesVersion: 'unchanged' });
assert.equal(snapshot.scenarioSigmaScale, 0.92, 'optional calibration adjustment is not silently changed');
assert.equal(snapshot.scenarios.length, 27);
assert.ok(Math.abs(snapshot.scenarioWeight - 1) < 1e-12);
const asianSnapshot = buildAsianJointScoreSnapshotV1({ context: candidateContext, modelVersion: 'integrity-test', rulesVersion: 'unchanged' });
assert.equal(asianSnapshot.scenarios.length, 27, 'diagnostic candidate work does not multiply production runtime scenarios');

const game = { leagueId: 'CPBL', league: 'CPBL', gamePk: 999001, awayTeamId: 703, homeTeamId: 701, awayCode: 'RKM', homeCode: 'CTB', away: 'A', home: 'H', gameDate: '2099-08-25T10:00:00Z', officialDate: '2099-08-25', venue: 'Synthetic' };
const historyGames = [0, null, '', false, []].map((score, index) => ({ ...game, gamePk: 9900 + index, gameDate: '2099-08-20T10:00:00Z', statusCode: 'F', awayScore: score, homeScore: 4 }));
const historyContext = await buildAsianGameContext('CPBL', game, { historyGames, productionFeatures: false });
assert.equal(historyContext.historyGameCount, 1, 'final status without actual numeric scores must not enter baseline; true zero does');
assert.equal(historyContext.away.seasonHitting.gamesPlayed, 1);
const foreignDiagnostic = await buildAsianGameContext('CPBL', game, {
  historyGames, productionFeatures: false,
  featureSnapshot: {
    asOf: '2099-08-25T09:00:00Z',
    rules: { foreignPlayerConstraint: { status: 'DIAGNOSTIC_ONLY', applies: true, source: 'SYNTHETIC_OFFICIAL_FOREIGN_PLAYER_PROFILE' } },
  },
});
assert.equal(foreignDiagnostic.leagueRuleState.cpbl.foreignPlayerConstraint.status, 'DIAGNOSTIC_FOREIGN_STATUS_TRANSITION_UNMODELED');
assert.equal(foreignDiagnostic.leagueRuleState.cpbl.foreignPlayerConstraint.pitcherExitLineupTransitionModeled, false);
assert.equal(foreignDiagnostic.leagueRuleState.cpbl.foreignPlayerConstraint.first5FullDifferentiated, false);

console.log('Model input usage integrity PASS: null/zero distinction, actual quality sensitivity, residual propagation, diagnostic-only disclosures, no unapproved mixture or promotion');
