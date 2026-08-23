import crypto from 'node:crypto';

export const MLB_ADVANCED_OOS_V2_VERSION = 'MLB-ADVANCED-WALK-FORWARD-PIT-2026-08-v2.0.0';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const season = value => Number(String(value || '').slice(0, 4)) || null;
const logFactorial = value => {
  let total = 0;
  for (let index = 2; index <= Math.max(0, Math.floor(value)); index += 1) total += Math.log(index);
  return total;
};
const poissonLoss = (actual, mean) => {
  const y = Math.max(0, finite(actual) ?? 0);
  const mu = Math.max(0.05, finite(mean) ?? 0.05);
  return mu - y * Math.log(mu) + logFactorial(y);
};
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sha256 = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validateAdvancedPitRowV2(row) {
  const errors = [];
  const start = Date.parse(row?.gameStart || '');
  if (!Number.isFinite(start)) errors.push('INVALID_GAME_START');
  for (const [name, observedAt] of Object.entries(row?.featureObservedAts || {})) {
    const observed = Date.parse(observedAt || '');
    if (!Number.isFinite(observed)) errors.push(`INVALID_FEATURE_TIME:${name}`);
    else if (Number.isFinite(start) && observed >= start) errors.push(`FEATURE_FROM_FUTURE:${name}`);
  }
  for (const field of ['actualAway', 'actualHome', 'baselineAway', 'baselineHome', 'candidateAway', 'candidateHome']) {
    if (finite(row?.[field]) == null || finite(row?.[field]) < 0) errors.push(`INVALID_NUMBER:${field}`);
  }
  const validationSeason = season(row?.gameStart);
  if (!validationSeason) errors.push('INVALID_SEASON');
  if (Number(row?.coefficientTrainedThrough || 0) >= validationSeason) errors.push('COEFFICIENT_LOOKAHEAD');
  return { ok: errors.length === 0, errors };
}

function metrics(rows) {
  const baselineLoss = [];
  const candidateLoss = [];
  const baselineSquared = [];
  const candidateSquared = [];
  const baselineAbsolute = [];
  const candidateAbsolute = [];
  const calibrationRows = [];
  const lossDeltasByGame = [];
  for (const row of rows) {
    let gameBaselineLoss = 0;
    let gameCandidateLoss = 0;
    for (const side of ['Away', 'Home']) {
      const actual = Number(row[`actual${side}`]);
      const baseline = Number(row[`baseline${side}`]);
      const candidate = Number(row[`candidate${side}`]);
      baselineLoss.push(poissonLoss(actual, baseline));
      candidateLoss.push(poissonLoss(actual, candidate));
      gameBaselineLoss += poissonLoss(actual, baseline);
      gameCandidateLoss += poissonLoss(actual, candidate);
      baselineSquared.push((actual - baseline) ** 2);
      candidateSquared.push((actual - candidate) ** 2);
      baselineAbsolute.push(Math.abs(actual - baseline));
      candidateAbsolute.push(Math.abs(actual - candidate));
      calibrationRows.push({ actual, baseline, candidate });
    }
    lossDeltasByGame.push((gameCandidateLoss - gameBaselineLoss) / 2);
  }
  const baselineRmse = Math.sqrt(mean(baselineSquared));
  const candidateRmse = Math.sqrt(mean(candidateSquared));
  const calibrationError = key => {
    const ordered = [...calibrationRows].sort((left, right) => left[key] - right[key]);
    if (!ordered.length) return null;
    const binSize = Math.max(1, Math.ceil(ordered.length / 10));
    const bins = [];
    for (let index = 0; index < ordered.length; index += binSize) {
      const bin = ordered.slice(index, index + binSize);
      bins.push({ size: bin.length, error: Math.abs(mean(bin.map(row => row.actual)) - mean(bin.map(row => row[key]))) });
    }
    return bins.reduce((sum, bin) => sum + bin.error * bin.size, 0) / ordered.length;
  };
  const baselineCalibrationError = calibrationError('baseline');
  const candidateCalibrationError = calibrationError('candidate');
  const lossDeltaMean = mean(lossDeltasByGame);
  const lossDeltaVariance = lossDeltasByGame.length > 1
    ? lossDeltasByGame.reduce((sum, value) => sum + (value - lossDeltaMean) ** 2, 0) / (lossDeltasByGame.length - 1)
    : 0;
  const lossDeltaStandardError = Math.sqrt(lossDeltaVariance / Math.max(1, lossDeltasByGame.length));
  return {
    games: rows.length,
    baselinePoissonLoss: mean(baselineLoss),
    candidatePoissonLoss: mean(candidateLoss),
    poissonLossDelta: mean(candidateLoss) - mean(baselineLoss),
    poissonLossDeltaStandardError: lossDeltaStandardError,
    poissonLossDeltaLower95: lossDeltaMean - 1.96 * lossDeltaStandardError,
    poissonLossDeltaUpper95: lossDeltaMean + 1.96 * lossDeltaStandardError,
    baselineRmse,
    candidateRmse,
    rmseDelta: candidateRmse - baselineRmse,
    baselineMae: mean(baselineAbsolute),
    candidateMae: mean(candidateAbsolute),
    maeDelta: mean(candidateAbsolute) - mean(baselineAbsolute),
    baselineCalibrationError,
    candidateCalibrationError,
    calibrationErrorDelta: candidateCalibrationError - baselineCalibrationError,
  };
}

export function buildAdvancedOosValidationV2(rows, { minimumGamesPerSeason = 200, requiredSeasons = [2022, 2023, 2024, 2025] } = {}) {
  const accepted = [];
  const rejected = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const check = validateAdvancedPitRowV2(row);
    if (check.ok) accepted.push(row);
    else rejected.push({ observationId: row?.observationId || null, errors: check.errors });
  }
  const folds = requiredSeasons.map(validationSeason => {
    const validation = accepted.filter(row => season(row.gameStart) === validationSeason);
    return {
      validationSeason,
      trainedThrough: validation.length ? Math.max(...validation.map(row => Number(row.coefficientTrainedThrough || 0))) : null,
      sufficient: validation.length >= minimumGamesPerSeason,
      metrics: metrics(validation),
    };
  });
  const sufficient = folds.every(fold => fold.sufficient);
  const allImproveLoss = sufficient && folds.every(fold => fold.metrics.poissonLossDelta < 0);
  const allStatisticallySupportedLoss = sufficient && folds.every(fold => fold.metrics.poissonLossDeltaUpper95 < 0);
  const allNonWorseRmse = sufficient && folds.every(fold => fold.metrics.rmseDelta <= 0);
  const allNonWorseCalibration = sufficient && folds.every(fold => fold.metrics.calibrationErrorDelta <= 0);
  const artifact = {
    version: MLB_ADVANCED_OOS_V2_VERSION,
    createdAt: new Date().toISOString(),
    status: sufficient ? 'OOS_DIAGNOSTIC_COMPLETE_REQUIRES_REVIEW' : 'OOS_SAMPLE_INSUFFICIENT',
    eligibleForManualPromotion: allImproveLoss && allStatisticallySupportedLoss && allNonWorseRmse && allNonWorseCalibration,
    automaticActivation: false,
    acceptedRows: accepted.length,
    rejectedRows: rejected.length,
    folds,
    rejected: rejected.slice(0, 100),
  };
  return { ...artifact, artifactHash: sha256(artifact) };
}
