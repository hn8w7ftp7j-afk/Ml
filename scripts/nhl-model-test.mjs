import assert from 'node:assert/strict';
import {
  buildNhlModelFeatures, fitNhlModel as productionFitNhlModel, predictNhlDistribution, walkForwardNhlModel as productionWalkForwardNhlModel,
} from '../lib/nhl/model.js';
import {
  getNhlScoreForPath, nhlMarginalDistribution, normalizeNhlWeights, summarizeNhlDistribution,
} from '../lib/nhl/distribution.js';
import { auditNhlDistribution, normalizeNhlModelGame, validateNhlPath } from '../lib/nhl/model-qa.js';

const fitNhlModel = (history, options) => productionFitNhlModel(history, { ...options, allowSyntheticFixtures: true });
const walkForwardNhlModel = (history, options) => productionWalkForwardNhlModel(history, { ...options, allowSyntheticFixtures: true });

// Synthetic fixtures test invariants only. These are not official historical
// results, performance evidence, fitted Production artifacts, or payoff data.
function fixture(index, { gameType = 2, outcomeType = 'REG', awayTeamId = '1', homeTeamId = '2' } = {}) {
  const date = new Date(Date.UTC(2025, 0, 1 + index * 3, 18));
  const periods = outcomeType === 'REG'
    ? [{ awayGoals: index % 3, homeGoals: 1 }, { awayGoals: 0, homeGoals: index % 2 }, { awayGoals: 1, homeGoals: 4 }]
    : [{ awayGoals: 1, homeGoals: 0 }, { awayGoals: 0, homeGoals: 1 }, { awayGoals: 1, homeGoals: 1 }];
  const regulation = { awayGoals: periods.reduce((sum, row) => sum + row.awayGoals, 0), homeGoals: periods.reduce((sum, row) => sum + row.homeGoals, 0) };
  const final = { ...regulation, homeGoals: regulation.homeGoals + (outcomeType === 'REG' ? 0 : 1) };
  return {
    leagueId: 'NHL', gameId: `synthetic-${index}-${gameType}`, season: '20242025', gameType,
    startTimeUTC: date.toISOString(), outcomeAvailableAt: new Date(date.getTime() + 3 * 3600_000).toISOString(),
    awayTeamId, homeTeamId, periods, regulation, final, outcomeType,
    source: { url: 'fixture://nhl-model-invariants', fetchedAt: new Date(date.getTime() + 4 * 3600_000).toISOString() },
    featureAvailableAt: new Date(date.getTime() - 3600_000).toISOString(),
    features: { awayXgForPer60: 2 + index / 10, homeGoalieGsaxPer60: index / 20 },
  };
}

let checks = 0;
function test(name, fn) { fn(); checks += 1; console.log(`PASS ${name}`); }
function rejectsCode(fn, code) { assert.throws(fn, error => error.code === code); }
function approx(actual, expected, epsilon = 1e-10) { assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`); }
const history = Array.from({ length: 14 }, (_, index) => fixture(index, { outcomeType: index % 5 === 0 ? 'SO' : index % 4 === 0 ? 'OT' : 'REG' }));
const trainingCutoff = '2025-03-01T00:00:00.000Z';
const target = { leagueId: 'NHL', gameId: 'synthetic-future', gameType: 2, season: '20242025', startTimeUTC: '2025-03-02T18:00:00.000Z', awayTeamId: '1', homeTeamId: '2' };
let model;
let distribution;

test('fit stores independent NHL parameters, chronology, sources and no invented EV error margin', () => {
  model = fitNhlModel(history, { trainingCutoff });
  assert.equal(model.leagueId, 'NHL');
  assert.equal(model.observations.length, history.length);
  assert.ok(model.artifactId.startsWith('nhl-model-'));
  assert.ok(model.calibrationEvidence.foldCount > 0);
  assert.equal(model.calibrationEvidence.payoffCalibrationAvailable, false);
  assert.equal(model.modelErrorMarginEV, undefined);
  assert.equal(model.readyForFormal, false);
  assert.equal(model.featureCoverage.awayGoalieGsaxPer60, 0);
  assert.ok(model.featureCoverage.awayXgForPer60 > 0);
});

test('linked period paths preserve regulation/final, unit mass and source outcomes', () => {
  distribution = predictNhlDistribution(model, target, { asOf: trainingCutoff, scenarioCount: 7, seed: 'invariants' });
  assert.equal(auditNhlDistribution(distribution).passed, true);
  assert.equal(distribution.game.league, 'NHL');
  assert.equal(distribution.scenarios.length, 7);
  for (const scenario of distribution.scenarios) {
    approx(scenario.paths.reduce((sum, path) => sum + path.probability, 0), 1);
    assert.equal(scenario.paths.length, history.length);
    for (const path of scenario.paths) assert.equal(validateNhlPath(path).passed, true);
  }
  const summary = summarizeNhlDistribution(distribution);
  approx(summary.P1.awayGoals + summary.P2.awayGoals + summary.P3.awayGoals, summary.REGULATION.awayGoals);
  approx(summary.P1.homeGoals + summary.P2.homeGoals + summary.P3.homeGoals, summary.REGULATION.homeGoals);
  approx(summary.FINAL.tieProbability, 0);
  assert.ok(summary.REGULATION.tieProbability > 0);
  approx(nhlMarginalDistribution(distribution, 'REGULATION').reduce((sum, row) => sum + row.probability, 0), 1);
});

test('same frozen model, time and seed are deterministic, and market quotes never alter model', () => {
  const another = predictNhlDistribution(model, { ...target, water: 0.91, line: '6-90', externalBookProbability: 0.9 }, { asOf: trainingCutoff, scenarioCount: 7, seed: 'invariants' });
  assert.equal(another.distributionHash, distribution.distributionHash);
});

test('shootout winner goal is included only in applicable score scope', () => {
  const shootout = normalizeNhlModelGame(fixture(30, { outcomeType: 'SO' })).path;
  const overtime = normalizeNhlModelGame(fixture(31, { outcomeType: 'OT' })).path;
  assert.deepEqual(getNhlScoreForPath(shootout, 'REGULATION'), { away: 2, home: 2 });
  assert.deepEqual(getNhlScoreForPath(shootout, 'INCLUDING_OT_EXCLUDING_SO'), { away: 2, home: 2 });
  assert.deepEqual(getNhlScoreForPath(shootout, 'FINAL'), { away: 2, home: 3 });
  assert.deepEqual(getNhlScoreForPath(overtime, 'INCLUDING_OT_EXCLUDING_SO'), { away: 2, home: 3 });
  rejectsCode(() => getNhlScoreForPath(shootout, '上半'), 'NHL_SCORE_SCOPE_UNVERIFIED');
});

test('unknown xG/goalie data stays null; a late injury/feature snapshot is not a pregame input', () => {
  const enriched = buildNhlModelFeatures({ ...target, features: { awayGoalieGsaxPer60: 2, homeXgForPer60: null }, featureAvailableAt: '2025-03-03T00:00:00Z' }, model.observations.map(row => row.record), { asOf: trainingCutoff });
  assert.equal(enriched.values.awayGoalieGsaxPer60, null);
  assert.equal(enriched.values.homeXgForPer60, null);
  assert.ok(enriched.diagnostics.includes('FEATURE_NOT_POINT_IN_TIME:awayGoalieGsaxPer60'));
  assert.ok(enriched.values.awayAttackGoalsPerGame > 0);
});

test('score underflow/overflow and malformed mass are rejected without silently repairing snapshots', () => {
  const bad = structuredClone(distribution);
  bad.scenarios[0].paths[0].probability = -0.1;
  assert.equal(auditNhlDistribution(bad).passed, false);
  const missingMass = structuredClone(distribution);
  missingMass.scenarios[0].paths[0].probability += 0.1;
  assert.equal(auditNhlDistribution(missingMass).passed, false);
  const wrongPeriod = structuredClone(distribution);
  wrongPeriod.scenarios[0].paths[0].periodScores[0].away += 1;
  assert.equal(auditNhlDistribution(wrongPeriod).passed, false);
  rejectsCode(() => normalizeNhlWeights([1, Infinity]), 'NHL_WEIGHTS_INVALID');
  rejectsCode(() => normalizeNhlWeights([0, 0]), 'NHL_WEIGHTS_EMPTY');
  approx(normalizeNhlWeights([1e300, 1e300]).reduce((sum, value) => sum + value, 0), 1);
  assert.ok(normalizeNhlWeights([1, 1e-200])[1] > 0);
});

test('regulation ties, impossible OT/SO and wrong season type cannot bypass result QA', () => {
  rejectsCode(() => normalizeNhlModelGame(fixture(32, { outcomeType: 'SO', gameType: 3 })), 'NHL_RESULT_PATH_INVALID');
  const extra = fixture(33, { outcomeType: 'OT' });
  extra.final.homeGoals += 1;
  rejectsCode(() => normalizeNhlModelGame(extra), 'NHL_RESULT_PATH_INVALID');
  const missing = fixture(34);
  delete missing.periods;
  rejectsCode(() => normalizeNhlModelGame(missing), 'NHL_PERIOD_DATA_MISSING');
  const wrongLeague = { ...fixture(35), leagueId: 'MLB' };
  rejectsCode(() => normalizeNhlModelGame(wrongLeague), 'NHL_IDENTITY_INVALID');
  rejectsCode(() => normalizeNhlModelGame(fixture(36, { homeTeamId: '1' })), 'NHL_IDENTITY_INVALID');
});

test('future data, duplicate games and target leakage never enter training or prediction', () => {
  const future = fixture(80);
  const trimmed = fitNhlModel([...history, future], { trainingCutoff });
  assert.equal(trimmed.excludedUnavailableCount, 1);
  assert.ok(!trimmed.trainingGameIds.includes(future.gameId));
  rejectsCode(() => fitNhlModel([...history, history[0]], { trainingCutoff }), 'NHL_DUPLICATE_HISTORY_GAME');
  rejectsCode(() => predictNhlDistribution(model, target, { asOf: '2025-02-01T00:00:00Z' }), 'NHL_PREDICTION_TIME_LEAKAGE');
  rejectsCode(() => predictNhlDistribution(model, { ...target, gameId: history[0].gameId }, { asOf: trainingCutoff }), 'NHL_TARGET_IN_TRAINING');
  const tampered = structuredClone(model);
  tampered.observations[0].record.path.final.home += 1;
  rejectsCode(() => predictNhlDistribution(tampered, target, { asOf: trainingCutoff }), 'NHL_MODEL_ARTIFACT_HASH_MISMATCH');
});

test('preseason never trains regular-season model and preview uses its own performance cohort', () => {
  const withPreseason = fitNhlModel([...history, fixture(15, { gameType: 1 })], { trainingCutoff });
  assert.equal(withPreseason.excludedPreseasonCount, 1);
  assert.deepEqual(withPreseason.trainingGameIds, model.trainingGameIds);
  rejectsCode(() => fitNhlModel(history, { trainingCutoff, gameType: 1 }), 'NHL_PRESEASON_TRAINING_EXCLUDED');
  const preseason = predictNhlDistribution(model, { ...target, gameType: 1 }, { asOf: trainingCutoff, scenarioCount: 1 });
  assert.equal(preseason.performanceCohort, 'NHL_PRESEASON_SHADOW');
  assert.equal(preseason.readyForFormal, false);
});

test('historical final API data without old availability timestamps is never labelled verified PIT', () => {
  const retrospective = history.map(row => ({ ...row, outcomeAvailableAt: null, source: { ...row.source, fetchedAt: '2026-09-06T00:00:00Z' } }));
  rejectsCode(() => fitNhlModel(retrospective, { trainingCutoff }), 'NHL_HISTORY_NOT_AVAILABLE_AT_CUTOFF');
  const fitted = fitNhlModel(retrospective, { trainingCutoff, availabilityMode: 'RETROSPECTIVE_48H_EMBARGO' });
  assert.equal(fitted.pointInTimeVerified, false);
  const report = walkForwardNhlModel(retrospective, { availabilityMode: 'RETROSPECTIVE_48H_EMBARGO' });
  assert.ok(report.foldCount > 0);
  assert.equal(report.pointInTimeVerified, false);
  assert.equal(report.verifiedTai888PayoffBacktest, false);
  assert.equal(report.status, 'RETROSPECTIVE_SCORE_BACKTEST_ONLY');
});

test('walk-forward fits each fold from earlier available outcomes and reports score evidence only', () => {
  const report = walkForwardNhlModel(history, { initialTrainingGames: 3 });
  assert.equal(report.foldCount, history.length - 3);
  const byId = new Map(history.map(row => [row.gameId, row]));
  for (const fold of report.folds) {
    assert.ok(!fold.trainingGameIds.includes(fold.targetGameId));
    for (const id of fold.trainingGameIds) assert.ok(Date.parse(byId.get(id).outcomeAvailableAt) <= Date.parse(fold.asOf));
    assert.ok(fold.regulationBrier >= 0 && fold.regulationBrier <= 2 + 1e-10);
  }
  assert.equal(report.verifiedTai888PayoffBacktest, false);
  assert.equal(report.historicalInjurySnapshotBacktest, false);
  assert.equal(report.readyForFormal, false);
});

test('large observed integer scores remain intact instead of being capped to look plausible', () => {
  const rare = fixture(16);
  rare.periods[0].awayGoals = 82;
  rare.regulation.awayGoals = 83;
  rare.final.awayGoals = 83;
  const largeModel = fitNhlModel([rare], { trainingCutoff });
  const result = predictNhlDistribution(largeModel, target, { asOf: trainingCutoff, scenarioCount: 1 });
  assert.equal(result.scenarios[0].paths[0].regulation.away, 83);
  assert.equal(result.outcomeTailTruncated, false);
});

test('equivalent zoned game starts normalize to UTC and fit does not mutate source records', () => {
  const input = fixture(1);
  input.startTimeUTC = '2025-01-05T02:00:00+08:00';
  const normalized = normalizeNhlModelGame(input);
  assert.equal(normalized.startTimeUTC, '2025-01-04T18:00:00.000Z');
  normalized.source.url = 'fixture://changed';
  normalized.features.awayXgForPer60 = 999;
  assert.equal(input.source.url, 'fixture://nhl-model-invariants');
  assert.notEqual(input.features.awayXgForPer60, 999);
});

test('blank strings and non-scalar values cannot turn missing goals/features into zero', () => {
  const blankPeriod = fixture(1);
  blankPeriod.periods[1].awayGoals = ' ';
  rejectsCode(() => normalizeNhlModelGame(blankPeriod), 'NHL_RESULT_PATH_INVALID');
  const blankFinal = fixture(1);
  blankFinal.final.awayGoals = [];
  rejectsCode(() => normalizeNhlModelGame(blankFinal), 'NHL_RESULT_PATH_INVALID');
  const features = buildNhlModelFeatures({ ...target, featureAvailableAt: trainingCutoff, features: { awayGoalieGsaxPer60: ' ' } }, model.observations.map(row => row.record), { asOf: trainingCutoff });
  assert.equal(features.values.awayGoalieGsaxPer60, null);
  assert.ok(features.diagnostics.includes('FEATURE_INVALID:awayGoalieGsaxPer60'));
});

test('refreshing asOf with unchanged effective inputs does not perturb bootstrap predictions', () => {
  const refreshed = predictNhlDistribution(model, target, { asOf: '2025-03-01T00:00:01.000Z', scenarioCount: 7, seed: 'invariants' });
  assert.deepEqual(refreshed.features.values, distribution.features.values);
  assert.deepEqual(refreshed.scenarios, distribution.scenarios);
  assert.notEqual(refreshed.asOf, distribution.asOf);
});

test('a duplicate final walk-forward target cannot be counted twice in out-of-sample results', () => {
  rejectsCode(() => walkForwardNhlModel([...history, history.at(-1)], { initialTrainingGames: 3 }), 'NHL_DUPLICATE_HISTORY_GAME');
});

test('synthetic training requires explicit test mode and remains labelled throughout', () => {
  rejectsCode(() => productionFitNhlModel(history, { trainingCutoff }), 'NHL_SYNTHETIC_TRAINING_NOT_AUTHORIZED');
  rejectsCode(() => productionWalkForwardNhlModel(history, {}), 'NHL_SYNTHETIC_TRAINING_NOT_AUTHORIZED');
  assert.equal(model.synthetic, true);
  assert.equal(distribution.synthetic, true);
  const noSource = history.map(row => ({ ...row, source: null }));
  rejectsCode(() => productionFitNhlModel(noSource, { trainingCutoff }), 'NHL_HISTORY_SOURCE_MISSING');
});

test('sparse historical outcomes cannot masquerade as complete rest/travel/schedule evidence', () => {
  const sparse = buildNhlModelFeatures(target, model.observations.map(row => row.record), { asOf: trainingCutoff, availabilityMode: 'RETROSPECTIVE_48H_EMBARGO' });
  assert.equal(sparse.values.awayRestHours, null);
  assert.equal(sparse.values.homeGamesLastSevenDays, null);
  assert.ok(sparse.diagnostics.includes('SCHEDULE_FEATURES_REQUIRE_COMPLETE_PIT_SCHEDULE_EVIDENCE'));
  const known = buildNhlModelFeatures({ ...target, featureAvailableAt: trainingCutoff, features: { awayRestHours: 26, homeGamesLastSevenDays: 3 } }, model.observations.map(row => row.record), { asOf: trainingCutoff });
  assert.equal(known.values.awayRestHours, 26);
  assert.equal(known.values.homeGamesLastSevenDays, 3);
});

test('a mathematically valid path or game identity mutation fails frozen distribution integrity', () => {
  const changed = structuredClone(distribution);
  const replacement = normalizeNhlModelGame(fixture(2)).path;
  changed.scenarios[0].paths[0] = { ...replacement, probability: changed.scenarios[0].paths[0].probability };
  assert.equal(validateNhlPath(changed.scenarios[0].paths[0]).passed, true);
  assert.ok(auditNhlDistribution(changed).errors.some(message => message.includes('hash')));
  const wrongGame = structuredClone(distribution);
  wrongGame.game.homeTeamId = wrongGame.game.awayTeamId;
  assert.ok(auditNhlDistribution(wrongGame).errors.some(message => message.includes('identity')));
});

console.log(`NHL model: ${checks} invariant/counterexample groups passed. Synthetic fixtures only; no historical ROI claim.`);
