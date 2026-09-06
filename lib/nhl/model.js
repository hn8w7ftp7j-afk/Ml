import {
  buildNhlLinkedDistribution, nhlContentHash, normalizeNhlWeights, summarizeNhlDistribution,
} from './distribution.js';
import {
  finiteNhlNumber, nhlModelError, nhlTimestamp, normalizeNhlModelGame,
} from './model-qa.js';

export const NHL_MODEL_VERSION = 'NHL-FITTED-CONDITIONAL-EMPIRICAL-PATHS-2026-09-v1';
export const NHL_FEATURE_SCHEMA_VERSION = 'NHL-PIT-TEAM-GOALIE-XG-FEATURES-v1';
export const NHL_FEATURE_NAMES = Object.freeze([
  'awayAttackGoalsPerGame', 'awayDefenseGoalsPerGame', 'homeAttackGoalsPerGame', 'homeDefenseGoalsPerGame',
  'awayRestHours', 'homeRestHours', 'awayXgForPer60', 'awayXgAgainstPer60', 'homeXgForPer60', 'homeXgAgainstPer60',
  'awayFiveOnFiveXgForPer60', 'awayFiveOnFiveXgAgainstPer60', 'homeFiveOnFiveXgForPer60', 'homeFiveOnFiveXgAgainstPer60',
  'awayPowerPlayXgPer60', 'homePowerPlayXgPer60', 'awayPenaltyKillXgAgainstPer60', 'homePenaltyKillXgAgainstPer60',
  'awayGoalieGsaxPer60', 'homeGoalieGsaxPer60', 'awayProjectedToiImpact', 'homeProjectedToiImpact',
  'awayTravelKm', 'homeTravelKm', 'awayGamesLastSevenDays', 'homeGamesLastSevenDays',
]);
const BANDWIDTH_CANDIDATES = Object.freeze([0.5, 1, 2, null]);
const RETROSPECTIVE_EMBARGO_MS = 48 * 60 * 60 * 1000;

function assertAvailabilityMode(mode) {
  if (!['STRICT_PIT', 'RETROSPECTIVE_48H_EMBARGO'].includes(mode)) throw nhlModelError('NHL_AVAILABILITY_MODE_INVALID', 'Unknown NHL historical availability mode.');
}

function usableBefore(record, cutoff, availabilityMode) {
  const start = nhlTimestamp(record.startTimeUTC);
  if (start == null || start >= cutoff) return false;
  if (availabilityMode === 'RETROSPECTIVE_48H_EMBARGO') return start + RETROSPECTIVE_EMBARGO_MS <= cutoff;
  const available = nhlTimestamp(record.outcomeAvailableAt);
  return available != null && available <= cutoff;
}

function queryIdentity(raw = {}) {
  const game = {
    leagueId: String(raw.leagueId || raw.league || '').toUpperCase(), league: 'NHL', gameId: String(raw.gameId ?? raw.officialGameId ?? ''),
    season: String(raw.season ?? ''), gameType: Number(raw.gameType), startTimeUTC: raw.startTimeUTC,
    awayTeamId: String(raw.awayTeamId ?? raw.awayTeam?.id ?? ''), homeTeamId: String(raw.homeTeamId ?? raw.homeTeam?.id ?? ''),
  };
  if (game.leagueId !== 'NHL' || !game.gameId || !game.awayTeamId || !game.homeTeamId || game.awayTeamId === game.homeTeamId || ![1, 2, 3].includes(game.gameType) || nhlTimestamp(game.startTimeUTC) == null) {
    throw nhlModelError('NHL_IDENTITY_INVALID', 'NHL prediction requires explicit official IDs, game type and a zoned start time.');
  }
  game.startTimeUTC = new Date(nhlTimestamp(game.startTimeUTC)).toISOString();
  return game;
}

function teamHistoryFeatures(teamId, historical) {
  const rows = historical.filter(row => row.awayTeamId === teamId || row.homeTeamId === teamId);
  if (!rows.length) return { attack: null, defense: null, count: 0 };
  let scored = 0;
  let allowed = 0;
  for (const row of rows) {
    const side = row.awayTeamId === teamId ? 'away' : 'home';
    scored += row.path.regulation[side];
    allowed += row.path.regulation[side === 'away' ? 'home' : 'away'];
  }
  return {
    attack: scored / rows.length, defense: allowed / rows.length,
    count: rows.length,
  };
}

export function buildNhlModelFeatures(gameInput, historical, { asOf = gameInput.startTimeUTC, availabilityMode = 'STRICT_PIT' } = {}) {
  assertAvailabilityMode(availabilityMode);
  const game = queryIdentity(gameInput);
  const cutoff = nhlTimestamp(asOf);
  if (cutoff == null || cutoff > nhlTimestamp(game.startTimeUTC)) throw nhlModelError('NHL_FEATURE_TIME_INVALID', 'Pregame feature cutoff must not follow game start.');
  const eligible = historical.filter(row => row.gameId !== game.gameId && row.gameType === game.gameType && usableBefore(row, cutoff, availabilityMode));
  const away = teamHistoryFeatures(game.awayTeamId, eligible);
  const home = teamHistoryFeatures(game.homeTeamId, eligible);
  const values = Object.fromEntries(NHL_FEATURE_NAMES.map(name => [name, null]));
  Object.assign(values, {
    awayAttackGoalsPerGame: away.attack, awayDefenseGoalsPerGame: away.defense,
    homeAttackGoalsPerGame: home.attack, homeDefenseGoalsPerGame: home.defense,
  });
  // Result samples and an embargo are not a complete historical schedule.
  // Rest/travel/density remain null unless a traceable pregame schedule
  // feature snapshot is supplied; the last observed game is not necessarily
  // the team's actual previous game.
  const diagnostics = [];
  const externalTime = nhlTimestamp(gameInput.featureAvailableAt);
  const rawFeatures = gameInput.features || {};
  for (const name of NHL_FEATURE_NAMES) {
    if (rawFeatures[name] == null) continue;
    const raw = rawFeatures[name];
    const number = finiteNhlNumber(typeof raw === 'object' ? raw.value : raw);
    const published = nhlTimestamp(typeof raw === 'object' ? raw.availableAt : gameInput.featureAvailableAt);
    if (number == null) { diagnostics.push(`FEATURE_INVALID:${name}`); continue; }
    const nonNegative = /Xg.*Per60|AttackGoalsPerGame|DefenseGoalsPerGame|RestHours|TravelKm|GamesLastSevenDays/.test(name);
    if ((nonNegative && number < 0) || (/GamesLastSevenDays/.test(name) && !Number.isInteger(number))) {
      diagnostics.push(`FEATURE_INVALID_DOMAIN:${name}`);
      continue;
    }
    if (published == null || published > cutoff || (externalTime != null && externalTime > cutoff)) {
      diagnostics.push(`FEATURE_NOT_POINT_IN_TIME:${name}`);
      continue;
    }
    values[name] = number;
  }
  const missing = NHL_FEATURE_NAMES.filter(name => values[name] == null);
  if (missing.some(name => /RestHours|GamesLastSevenDays|TravelKm/.test(name))) diagnostics.push('SCHEDULE_FEATURES_REQUIRE_COMPLETE_PIT_SCHEDULE_EVIDENCE');
  return {
    values, missing, diagnostics, sourceGameIds: eligible.map(row => row.gameId),
    teamHistoryCounts: { away: away.count, home: home.count },
    schemaVersion: NHL_FEATURE_SCHEMA_VERSION, asOf,
    pointInTimeVerified: availabilityMode === 'STRICT_PIT',
  };
}

function fitScales(observations) {
  return Object.fromEntries(NHL_FEATURE_NAMES.flatMap(name => {
    const values = observations.map(row => row.features.values[name]).filter(value => value != null);
    if (values.length < 2) return [];
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return variance > 0 && Number.isFinite(variance) ? [[name, { mean, standardDeviation: Math.sqrt(variance), count: values.length }]] : [];
  }));
}

function conditionalWeights(observations, queryFeatures, scales, bandwidth) {
  if (bandwidth == null) return { weights: normalizeNhlWeights(observations.map(() => 1)), usedFeatures: [], empiricalPrior: true };
  const names = Object.keys(scales).filter(name => queryFeatures.values[name] != null);
  const rows = observations.map(observation => {
    const shared = names.filter(name => observation.features.values[name] != null);
    if (!shared.length) return { logWeight: null, used: [] };
    const distance = shared.reduce((sum, name) => sum + ((queryFeatures.values[name] - observation.features.values[name]) / scales[name].standardDeviation) ** 2, 0) / shared.length;
    return { logWeight: -distance / (2 * bandwidth ** 2), used: shared };
  });
  const supported = rows.filter(row => row.logWeight != null && Number.isFinite(row.logWeight));
  if (!supported.length) return { weights: normalizeNhlWeights(observations.map(() => 1)), usedFeatures: [], empiricalPrior: true };
  const maximum = Math.max(...supported.map(row => row.logWeight));
  // Shift log weights for numerical stability; zero-probability paths remain
  // present in the snapshot and no high/low goal score is capped.
  const weights = normalizeNhlWeights(rows.map(row => row.logWeight == null ? 0 : Math.exp(row.logWeight - maximum)));
  return { weights, usedFeatures: [...new Set(supported.flatMap(row => row.used))], empiricalPrior: false };
}

function scoreBrier(observations, weights, targetPath) {
  const bins = new Map();
  observations.forEach((row, index) => {
    const key = `${row.record.path.regulation.away}:${row.record.path.regulation.home}`;
    bins.set(key, (bins.get(key) || 0) + weights[index]);
  });
  const target = `${targetPath.regulation.away}:${targetPath.regulation.home}`;
  return 1 + [...bins.values()].reduce((sum, probability) => sum + probability ** 2, 0) - 2 * (bins.get(target) || 0);
}

function selectBandwidth(observations, availabilityMode) {
  const candidates = BANDWIDTH_CANDIDATES.map(bandwidth => ({ bandwidth, sumBrier: 0, count: 0 }));
  const folds = [];
  for (let index = 1; index < observations.length; index += 1) {
    const target = observations[index];
    const cutoff = nhlTimestamp(target.record.startTimeUTC);
    const prefix = observations.slice(0, index).filter(row => usableBefore(row.record, cutoff, availabilityMode));
    if (!prefix.length) continue;
    const scales = fitScales(prefix);
    const fold = { targetGameId: target.record.gameId, asOf: target.record.startTimeUTC, trainingGameIds: prefix.map(row => row.record.gameId), scores: [] };
    for (const candidate of candidates) {
      const { weights } = conditionalWeights(prefix, target.features, scales, candidate.bandwidth);
      const brier = scoreBrier(prefix, weights, target.record.path);
      candidate.sumBrier += brier;
      candidate.count += 1;
      fold.scores.push({ bandwidth: candidate.bandwidth, brier });
    }
    folds.push(fold);
  }
  const scored = candidates.map(candidate => ({ bandwidth: candidate.bandwidth, count: candidate.count, meanBrier: candidate.count ? candidate.sumBrier / candidate.count : null }));
  // Ties favor the unconditional empirical estimate, avoiding unsupported
  // claims that a particular feature improved predictive performance.
  const ranked = scored.filter(candidate => candidate.count > 0).sort((left, right) => left.meanBrier - right.meanBrier || (left.bandwidth == null ? -1 : right.bandwidth == null ? 1 : right.bandwidth - left.bandwidth));
  return { bandwidth: ranked[0]?.bandwidth ?? null, candidates: scored, folds };
}

export function fitNhlModel(history, { trainingCutoff, gameType = 2, availabilityMode = 'STRICT_PIT', allowSyntheticFixtures = false } = {}) {
  assertAvailabilityMode(availabilityMode);
  const cutoff = nhlTimestamp(trainingCutoff);
  if (cutoff == null) throw nhlModelError('NHL_TRAINING_CUTOFF_REQUIRED', 'A zoned NHL training cutoff is required.');
  if (![2, 3].includes(gameType)) throw nhlModelError('NHL_PRESEASON_TRAINING_EXCLUDED', 'Preseason does not train the regular-season/playoff model.');
  if (!Array.isArray(history) || !history.length) throw nhlModelError('NHL_HISTORY_MISSING', 'Observed NHL historical period paths are required.');
  const all = history.map(normalizeNhlModelGame).sort((left, right) => nhlTimestamp(left.startTimeUTC) - nhlTimestamp(right.startTimeUTC) || left.gameId.localeCompare(right.gameId));
  const ids = new Set();
  for (const record of all) {
    if (ids.has(record.gameId)) throw nhlModelError('NHL_DUPLICATE_HISTORY_GAME', `Duplicate official NHL game ID: ${record.gameId}`);
    ids.add(record.gameId);
  }
  const selected = all.filter(record => record.gameType === gameType && usableBefore(record, cutoff, availabilityMode));
  if (!selected.length) throw nhlModelError('NHL_HISTORY_NOT_AVAILABLE_AT_CUTOFF', 'No verified final NHL paths are available before the requested cutoff.');
  if (selected.some(record => record.synthetic) && !allowSyntheticFixtures) {
    throw nhlModelError('NHL_SYNTHETIC_TRAINING_NOT_AUTHORIZED', 'Synthetic NHL fixtures require explicit test-only authorization.');
  }
  if (selected.some(record => record.sourceKind === 'UNVERIFIED_RECORD')) {
    throw nhlModelError('NHL_HISTORY_SOURCE_MISSING', 'Every NHL training record requires traceable source evidence.');
  }
  const observations = selected.map(record => ({ record, features: buildNhlModelFeatures(record, selected, { asOf: record.startTimeUTC, availabilityMode }) }));
  const tuning = selectBandwidth(observations, availabilityMode);
  const scales = fitScales(observations);
  const diagnostics = [];
  if (availabilityMode !== 'STRICT_PIT') diagnostics.push('RETROSPECTIVE_RESULTS_WITH_48H_EMBARGO_NOT_HISTORICAL_PIT_EVIDENCE');
  if (!Object.keys(scales).length) diagnostics.push('NO_TRAINABLE_PIT_FEATURE_VARIATION_EMPIRICAL_PRIOR_ONLY');
  if (!tuning.folds.length) diagnostics.push('CHRONOLOGICAL_CALIBRATION_UNAVAILABLE');
  if (selected.some(record => record.synthetic)) diagnostics.push('SYNTHETIC_FIXTURE_TEST_ONLY_NOT_PRODUCTION_EVIDENCE');
  const artifact = {
    leagueId: 'NHL', modelVersion: NHL_MODEL_VERSION, featureSchemaVersion: NHL_FEATURE_SCHEMA_VERSION,
    gameType, trainingCutoff, availabilityMode, pointInTimeVerified: availabilityMode === 'STRICT_PIT',
    synthetic: selected.some(record => record.synthetic), sourceKinds: [...new Set(selected.map(record => record.sourceKind))],
    trainingGameIds: selected.map(record => record.gameId), trainingSourceHash: nhlContentHash(selected),
    excludedPreseasonCount: all.filter(record => record.gameType === 1).length,
    excludedOtherGameTypeCount: all.filter(record => record.gameType !== gameType && record.gameType !== 1).length,
    excludedUnavailableCount: all.filter(record => record.gameType === gameType && !usableBefore(record, cutoff, availabilityMode)).length,
    parameters: { bandwidth: tuning.bandwidth, scales, method: 'GAUSSIAN_CONDITIONAL_EMPIRICAL_PATHS' },
    calibrationEvidence: {
      kind: 'CHRONOLOGICAL_REGULATION_SCORE_BRIER', candidates: tuning.candidates, foldCount: tuning.folds.length,
      foldEvidence: tuning.folds, payoffCalibrationAvailable: false, forwardCalibrationAvailable: false,
      pointInTimeVerified: availabilityMode === 'STRICT_PIT',
    },
    featureCoverage: Object.fromEntries(NHL_FEATURE_NAMES.map(name => [name, observations.filter(row => row.features.values[name] != null).length])),
    observations, diagnostics, readyForFormal: false,
  };
  artifact.artifactId = `nhl-model-${nhlContentHash(artifact).slice(0, 24)}`;
  return artifact;
}

export function predictNhlDistribution(artifact, gameInput, { asOf, scenarioCount = 9, seed } = {}) {
  const game = queryIdentity(gameInput);
  const cutoff = nhlTimestamp(asOf);
  if (artifact?.leagueId !== 'NHL' || artifact?.modelVersion !== NHL_MODEL_VERSION || !Array.isArray(artifact?.observations) || !artifact.observations.length) {
    throw nhlModelError('NHL_MODEL_ARTIFACT_REQUIRED', 'An independently fitted NHL model artifact is required.');
  }
  const { artifactId, ...artifactContent } = artifact;
  if (artifactId !== `nhl-model-${nhlContentHash(artifactContent).slice(0, 24)}`) {
    throw nhlModelError('NHL_MODEL_ARTIFACT_HASH_MISMATCH', 'NHL fitted artifact content does not match its recorded hash.');
  }
  if (cutoff == null || cutoff > nhlTimestamp(game.startTimeUTC) || nhlTimestamp(artifact.trainingCutoff) > cutoff) {
    throw nhlModelError('NHL_PREDICTION_TIME_LEAKAGE', 'Prediction cannot use an artifact trained after the pregame cutoff.');
  }
  if (artifact.gameType !== game.gameType && game.gameType !== 1) throw nhlModelError('NHL_GAME_TYPE_MODEL_MISMATCH', 'Regular-season and playoff paths use distinct fitted models.');
  if (artifact.trainingGameIds.includes(game.gameId)) throw nhlModelError('NHL_TARGET_IN_TRAINING', 'Target game outcome cannot occur in its own training data.');
  if (artifact.observations.some(row => !usableBefore(row.record, cutoff, artifact.availabilityMode))) throw nhlModelError('NHL_TRAINING_RECORD_TIME_LEAKAGE', 'A training result was not available by prediction cutoff.');
  // A preseason preview may use a regular-season prior only as an explicitly
  // shifted Shadow diagnostic, and its outcomes never train this artifact.
  const featureGame = game.gameType === 1 ? { ...gameInput, gameType: artifact.gameType } : gameInput;
  const features = buildNhlModelFeatures(featureGame, artifact.observations.map(row => row.record), { asOf, availabilityMode: artifact.availabilityMode });
  const conditional = conditionalWeights(artifact.observations, features, artifact.parameters.scales, artifact.parameters.bandwidth);
  const diagnostics = [...artifact.diagnostics, ...features.diagnostics];
  if (conditional.empiricalPrior) diagnostics.push('UNCONDITIONAL_EMPIRICAL_NHL_PRIOR');
  if (features.missing.length) diagnostics.push(`FEATURES_UNAVAILABLE:${features.missing.join(',')}`);
  if (game.gameType === 1) diagnostics.push('PRESEASON_SHADOW_DOMAIN_SHIFT_EXCLUDED_FROM_LONG_TERM_PERFORMANCE');
  const snapshot = buildNhlLinkedDistribution({
    game, asOf, artifactId: artifact.artifactId, trainingCutoff: artifact.trainingCutoff,
    records: artifact.observations.map(row => row.record), weights: conditional.weights,
    scenarioCount, seed: seed ?? artifact.artifactId, diagnostics, calibrationEvidence: artifact.calibrationEvidence,
  });
  snapshot.features = features;
  snapshot.conditioningFeatures = conditional.usedFeatures;
  snapshot.performanceCohort = game.gameType === 1 ? 'NHL_PRESEASON_SHADOW' : game.gameType === 3 ? 'NHL_PLAYOFF_SHADOW' : 'NHL_REGULAR_SHADOW';
  snapshot.modelVersion = NHL_MODEL_VERSION;
  snapshot.synthetic = artifact.synthetic;
  snapshot.sourceKinds = artifact.sourceKinds;
  const { distributionId, distributionHash, qa, ...snapshotContent } = snapshot;
  snapshot.distributionHash = nhlContentHash(snapshotContent);
  snapshot.distributionId = `nhl-${snapshot.distributionHash.slice(0, 24)}`;
  return snapshot;
}

export function walkForwardNhlModel(history, { gameType = 2, availabilityMode = 'STRICT_PIT', initialTrainingGames = 1, scenarioCount = 1, allowSyntheticFixtures = false } = {}) {
  assertAvailabilityMode(availabilityMode);
  if (!Number.isSafeInteger(initialTrainingGames) || initialTrainingGames < 1) throw nhlModelError('NHL_WALKFORWARD_CONFIG_INVALID', 'Initial training game count must be positive.');
  const all = history.map(normalizeNhlModelGame);
  const ids = new Set();
  for (const record of all) {
    if (ids.has(record.gameId)) throw nhlModelError('NHL_DUPLICATE_HISTORY_GAME', `Duplicate official NHL game ID: ${record.gameId}`);
    ids.add(record.gameId);
  }
  const normalized = all.filter(record => record.gameType === gameType).sort((left, right) => nhlTimestamp(left.startTimeUTC) - nhlTimestamp(right.startTimeUTC));
  if (normalized.some(record => record.synthetic) && !allowSyntheticFixtures) throw nhlModelError('NHL_SYNTHETIC_TRAINING_NOT_AUTHORIZED', 'Synthetic NHL walk-forward fixtures require explicit test-only authorization.');
  const sourceById = new Map(history.map(row => [String(row.gameId ?? row.officialGameId), row]));
  const folds = [];
  const skipped = [];
  for (const target of normalized) {
    const cutoff = nhlTimestamp(target.startTimeUTC);
    const prior = normalized.filter(record => record.gameId !== target.gameId && usableBefore(record, cutoff, availabilityMode));
    if (prior.length < initialTrainingGames) { skipped.push({ gameId: target.gameId, reason: 'INSUFFICIENT_AVAILABLE_PRIOR_RESULTS' }); continue; }
    const artifact = fitNhlModel(prior.map(row => sourceById.get(row.gameId)), { trainingCutoff: target.startTimeUTC, gameType, availabilityMode, allowSyntheticFixtures });
    const snapshot = predictNhlDistribution(artifact, sourceById.get(target.gameId), { asOf: target.startTimeUTC, scenarioCount });
    const summary = summarizeNhlDistribution(snapshot);
    const observations = snapshot.scenarios.flatMap(scenario => scenario.paths.map(path => ({ record: { path }, probability: scenario.weight * path.probability })));
    const brier = scoreBrier(observations, observations.map(row => row.probability), target.path);
    folds.push({
      targetGameId: target.gameId, asOf: target.startTimeUTC, trainingGameIds: artifact.trainingGameIds,
      artifactId: artifact.artifactId, distributionId: snapshot.distributionId, regulationBrier: brier,
      regulationMeanSquaredError: (summary.REGULATION.awayGoals - target.path.regulation.away) ** 2 + (summary.REGULATION.homeGoals - target.path.regulation.home) ** 2,
      actual: { ...target.path.regulation }, predicted: summary.REGULATION,
    });
  }
  return {
    leagueId: 'NHL', modelVersion: NHL_MODEL_VERSION, gameType, availabilityMode,
    synthetic: normalized.some(record => record.synthetic),
    pointInTimeVerified: availabilityMode === 'STRICT_PIT', foldCount: folds.length, folds, skipped,
    meanRegulationBrier: folds.length ? folds.reduce((sum, fold) => sum + fold.regulationBrier, 0) / folds.length : null,
    meanRegulationSquaredError: folds.length ? folds.reduce((sum, fold) => sum + fold.regulationMeanSquaredError, 0) / folds.length : null,
    // Scores alone cannot validate historical Tai888 EV, actual injury/goalie
    // announcements, achieved returns, or bootstrap confidence coverage.
    verifiedTai888PayoffBacktest: false, historicalInjurySnapshotBacktest: false, readyForFormal: false,
    status: folds.length ? availabilityMode === 'STRICT_PIT' ? 'PIT_SCORE_BACKTEST_ONLY' : 'RETROSPECTIVE_SCORE_BACKTEST_ONLY' : 'NO_ELIGIBLE_FOLDS',
  };
}
