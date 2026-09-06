import { createHash } from 'node:crypto';
import { auditNhlDistribution, nhlModelError } from './model-qa.js';

export const NHL_DISTRIBUTION_VERSION = 'NHL-CONDITIONAL-EMPIRICAL-LINKED-PERIODS-2026-09-v1';

export function nhlContentHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// This normalization defines model weights; it is never used to repair a
// malformed supplied probability snapshot. No score support is discarded.
export function normalizeNhlWeights(weights) {
  if (!Array.isArray(weights) || !weights.length || weights.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw nhlModelError('NHL_WEIGHTS_INVALID', 'Model weights must be finite and non-negative.');
  }
  const largest = Math.max(...weights);
  if (!(largest > 0)) throw nhlModelError('NHL_WEIGHTS_EMPTY', 'At least one model weight must be positive.');
  const scaled = weights.map(value => value / largest);
  const total = scaled.reduce((sum, value) => sum + value, 0);
  return scaled.map(value => value / total);
}

function seededGenerator(seed) {
  let state = Number.parseInt(nhlContentHash(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildNhlLinkedDistribution({ game, asOf, artifactId, trainingCutoff, records, weights, scenarioCount = 9, seed = artifactId, diagnostics = [], calibrationEvidence = null }) {
  if (!Array.isArray(records) || !records.length || records.length !== weights?.length) {
    throw nhlModelError('NHL_TRAINING_SUPPORT_MISSING', 'NHL joint distribution requires observed historical paths and matching weights.');
  }
  if (!Number.isSafeInteger(scenarioCount) || scenarioCount < 1) throw nhlModelError('NHL_SCENARIO_COUNT_INVALID', 'Scenario count must be a positive integer.');
  const centralWeights = normalizeNhlWeights(weights);
  // A changed observation clock alone must not change a frozen model's
  // predictions; inputs and artifact content determine the random stream.
  const random = seededGenerator({ seed, gameId: game.gameId });
  const blocks = [...new Set(records.map(record => record.startTimeUTC.slice(0, 10)))];
  const scenarios = Array.from({ length: scenarioCount }, (_, index) => {
    // Bayesian block bootstrap of observed game dates: model uncertainty,
    // not quantiles of an individual wager's realized profit.
    const blockWeights = new Map(blocks.map(block => [block, index === 0 ? 1 : -Math.log((random() + Number.EPSILON) / (1 + Number.EPSILON))]));
    const probabilities = normalizeNhlWeights(centralWeights.map((weight, row) => weight * blockWeights.get(records[row].startTimeUTC.slice(0, 10))));
    return {
      id: index === 0 ? 'empirical-central' : `empirical-date-bootstrap-${index}`,
      weight: 1 / scenarioCount,
      paths: records.map((record, row) => ({ ...structuredClone(record.path), probability: probabilities[row] })),
    };
  });
  const snapshot = {
    leagueId: 'NHL', gameType: game.gameType, game: structuredClone(game), asOf, modelArtifactId: artifactId, trainingCutoff,
    distributionVersion: NHL_DISTRIBUTION_VERSION, linkedPeriodPath: true,
    exactDistribution: true, distributionMethod: 'EXACT_FINITE_EMPIRICAL_MIXTURE',
    targetMarketCalibratesDistribution: false, outcomeTailTruncated: false,
    // Empirical support is a statistical limitation, not a numerical score cap.
    observedSupportOnly: true, readyForFormal: false, calibrationEvidence,
    uncertaintyMethod: 'BAYESIAN_GAME_DATE_BOOTSTRAP_UNCALIBRATED',
    diagnostics: [...diagnostics, 'EMPIRICAL_SUPPORT_ONLY', 'BOOTSTRAP_COVERAGE_NOT_FORWARD_CALIBRATED'], scenarios,
  };
  snapshot.distributionHash = nhlContentHash(snapshot);
  snapshot.distributionId = `nhl-${snapshot.distributionHash.slice(0, 24)}`;
  snapshot.qa = auditNhlDistribution(snapshot);
  if (!snapshot.qa.passed) throw nhlModelError('NHL_DISTRIBUTION_QA_BLOCKED', snapshot.qa.errors.join('; '));
  return snapshot;
}

export function getNhlScoreForPath(path, scope) {
  switch (scope) {
    case 'REGULATION': return { ...path.regulation };
    case 'FINAL': return { ...path.final };
    case 'INCLUDING_OT_EXCLUDING_SO': return { ...(path.outcome.shootout ? path.regulation : path.final) };
    case 'P1': case 'P2': case 'P3': {
      const period = path.periodScores[Number(scope.slice(1)) - 1];
      return { away: period.away, home: period.home };
    }
    default: throw nhlModelError('NHL_SCORE_SCOPE_UNVERIFIED', `Unknown NHL score scope: ${scope}`);
  }
}

export function nhlMarginalDistribution(snapshot, scope) {
  const qa = auditNhlDistribution(snapshot);
  if (!qa.passed) throw nhlModelError('NHL_DISTRIBUTION_QA_BLOCKED', qa.errors.join('; '));
  const cells = new Map();
  for (const scenario of snapshot.scenarios) {
    for (const path of scenario.paths) {
      const score = getNhlScoreForPath(path, scope);
      const key = `${score.away}:${score.home}`;
      const cell = cells.get(key) || { ...score, probability: 0 };
      cell.probability += scenario.weight * path.probability;
      cells.set(key, cell);
    }
  }
  return [...cells.values()];
}

export function summarizeNhlDistribution(snapshot) {
  return Object.fromEntries(['P1', 'P2', 'P3', 'REGULATION', 'INCLUDING_OT_EXCLUDING_SO', 'FINAL'].map(scope => {
    const cells = nhlMarginalDistribution(snapshot, scope);
    return [scope, {
      awayGoals: cells.reduce((sum, cell) => sum + cell.probability * cell.away, 0),
      homeGoals: cells.reduce((sum, cell) => sum + cell.probability * cell.home, 0),
      awayWinProbability: cells.filter(cell => cell.away > cell.home).reduce((sum, cell) => sum + cell.probability, 0),
      homeWinProbability: cells.filter(cell => cell.home > cell.away).reduce((sum, cell) => sum + cell.probability, 0),
      tieProbability: cells.filter(cell => cell.home === cell.away).reduce((sum, cell) => sum + cell.probability, 0),
    }];
  }));
}
