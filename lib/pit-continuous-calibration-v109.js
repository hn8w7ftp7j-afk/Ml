import crypto from 'node:crypto';

export const PIT_PREDICTION_SCHEMA_V109 = 'baseball-pit-prediction-v2';
export const PIT_OBSERVATION_SCHEMA_V109 = 'baseball-pit-observation-v2';
export const CONTINUOUS_CALIBRATION_V109_VERSION = 'baseball-continuous-hierarchical-isotonic-v2';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const iso = value => {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const monthOf = value => String(value || '').slice(0, 7);
const dayOf = value => String(value || '').slice(0, 10);
const groupKey = row => [row.league, row.marketFamily, row.contractType].join('|');
const quantile = (values, probability) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

function validHash(value) {
  return /^[a-f0-9]{64}$/.test(String(value || '').toLowerCase());
}

export function validatePitPredictionV109(input) {
  const errors = [];
  const value = {
    schemaVersion: input?.schemaVersion,
    observationId: String(input?.observationId || ''),
    league: String(input?.league || '').toUpperCase(),
    gameId: String(input?.gameId || ''),
    gameStart: iso(input?.gameStart),
    lineAsOf: iso(input?.lineAsOf),
    decisionAsOf: iso(input?.decisionAsOf),
    modelAsOf: iso(input?.modelAsOf),
    marketFamily: String(input?.marketFamily || ''),
    contractType: String(input?.contractType || ''),
    rawWeightedEv: finite(input?.rawWeightedEv),
    rawRobustEv: finite(input?.rawRobustEv),
    water: finite(input?.water),
    sourcePayloadHash: String(input?.sourcePayloadHash || '').toLowerCase(),
    modelInputHash: String(input?.modelInputHash || '').toLowerCase(),
    featureObservedAts: Object.fromEntries(Object.entries(input?.featureObservedAts || {}).map(([key, time]) => [key, iso(time)])),
    modelVersion: String(input?.modelVersion || ''),
    settlementRuleVersion: String(input?.settlementRuleVersion || ''),
  };
  if (value.schemaVersion !== PIT_PREDICTION_SCHEMA_V109) errors.push('SCHEMA_VERSION_INVALID');
  if (!value.observationId || !value.gameId) errors.push('IDENTITY_MISSING');
  if (!/^(MLB|NPB|KBO|CPBL)$/.test(value.league)) errors.push('LEAGUE_INVALID');
  if (!value.gameStart || !value.lineAsOf || !value.decisionAsOf || !value.modelAsOf) errors.push('TIMESTAMP_INVALID');
  if (value.lineAsOf && value.decisionAsOf && value.lineAsOf > value.decisionAsOf) errors.push('LINE_FROM_FUTURE');
  if (value.modelAsOf && value.decisionAsOf && value.modelAsOf > value.decisionAsOf) errors.push('MODEL_FROM_FUTURE');
  if (value.decisionAsOf && value.gameStart && value.decisionAsOf >= value.gameStart) errors.push('DECISION_NOT_PIT');
  for (const [key, time] of Object.entries(value.featureObservedAts)) {
    if (!time) errors.push(`FEATURE_TIMESTAMP_INVALID:${key}`);
    else if (value.modelAsOf && time > value.modelAsOf) errors.push(`FEATURE_FROM_FUTURE:${key}`);
  }
  if (!value.marketFamily || !value.contractType) errors.push('CONTRACT_IDENTITY_MISSING');
  if (value.rawWeightedEv == null || Math.abs(value.rawWeightedEv) > 1) errors.push('RAW_EV_INVALID');
  if (value.rawRobustEv == null || Math.abs(value.rawRobustEv) > 1) errors.push('ROBUST_EV_INVALID');
  if (value.water == null || value.water <= 0 || value.water > 2) errors.push('WATER_INVALID');
  if (!validHash(value.sourcePayloadHash)) errors.push('SOURCE_HASH_INVALID');
  if (!validHash(value.modelInputHash)) errors.push('MODEL_HASH_INVALID');
  if (!value.modelVersion || !value.settlementRuleVersion) errors.push('VERSION_IDENTITY_MISSING');
  return { ok: errors.length === 0, errors, value: errors.length ? null : value };
}

export function validatePitObservationV109(input) {
  const prediction = validatePitPredictionV109(input);
  const errors = [...prediction.errors];
  const settledAt = iso(input?.settledAt);
  const realizedNetReturn = finite(input?.realizedNetReturn);
  if (!settledAt) errors.push('SETTLEMENT_TIME_INVALID');
  if (settledAt && prediction.value?.gameStart && settledAt < prediction.value.gameStart) errors.push('SETTLEMENT_FROM_FUTURE');
  if (realizedNetReturn == null || realizedNetReturn < -1.1 || realizedNetReturn > 2) errors.push('RETURN_INVALID');
  return {
    ok: errors.length === 0,
    errors,
    value: errors.length ? null : {
      ...prediction.value,
      schemaVersion: PIT_OBSERVATION_SCHEMA_V109,
      predictionSchemaVersion: PIT_PREDICTION_SCHEMA_V109,
      settledAt,
      realizedNetReturn,
    },
  };
}

function recencyWeight(gameStart, through, halfLifeDays) {
  const ageDays = Math.max(0, (Date.parse(through) - Date.parse(gameStart)) / 86_400_000);
  return Math.pow(0.5, ageDays / Math.max(30, halfLifeDays));
}

export function fitWeightedIsotonicV109(rows, { maximumBins = 20, minimumBinSize = 20, through = null, halfLifeDays = 730 } = {}) {
  const sorted = [...rows].sort((a, b) => a.rawWeightedEv - b.rawWeightedEv);
  const binCount = Math.max(1, Math.min(maximumBins, Math.floor(sorted.length / minimumBinSize)));
  const trainedThrough = through || sorted.at(-1)?.gameStart || new Date().toISOString();
  const bins = [];
  for (let index = 0; index < binCount; index += 1) {
    const from = Math.floor(index * sorted.length / binCount);
    const to = Math.floor((index + 1) * sorted.length / binCount);
    const members = sorted.slice(from, to);
    if (!members.length) continue;
    let weight = 0;
    let sum = 0;
    for (const row of members) {
      const rowWeight = recencyWeight(row.gameStart, trainedThrough, halfLifeDays);
      weight += rowWeight;
      sum += row.realizedNetReturn * rowWeight;
    }
    bins.push({ minX: members[0].rawWeightedEv, maxX: members.at(-1).rawWeightedEv, sum, weight, sampleSize: members.length });
  }
  const blocks = [];
  for (const bin of bins) {
    blocks.push(bin);
    while (blocks.length > 1 && blocks.at(-2).sum / blocks.at(-2).weight > blocks.at(-1).sum / blocks.at(-1).weight) {
      const right = blocks.pop();
      const left = blocks.pop();
      blocks.push({
        minX: left.minX,
        maxX: right.maxX,
        sum: left.sum + right.sum,
        weight: left.weight + right.weight,
        sampleSize: left.sampleSize + right.sampleSize,
      });
    }
  }
  return blocks.map(block => ({
    minRawEv: block.minX,
    maxRawEv: block.maxX,
    calibratedEv: block.sum / block.weight,
    effectiveWeight: block.weight,
    sampleSize: block.sampleSize,
  }));
}

export function predictWeightedIsotonicV109(model, rawWeightedEv) {
  if (!Array.isArray(model) || !model.length || !Number.isFinite(Number(rawWeightedEv))) return null;
  const hit = model.find(block => Number(rawWeightedEv) <= block.maxRawEv);
  return Number((hit || model.at(-1)).calibratedEv);
}

function fitHierarchy(rows, options = {}) {
  const globalModel = fitWeightedIsotonicV109(rows, options);
  const groupModels = {};
  for (const key of new Set(rows.map(groupKey))) {
    const groupRows = rows.filter(row => groupKey(row) === key);
    if (groupRows.length < (options.minimumGroupRows || 60)) continue;
    groupModels[key] = {
      sampleSize: groupRows.length,
      blendWeight: groupRows.length / (groupRows.length + (options.groupPriorRows || 160)),
      model: fitWeightedIsotonicV109(groupRows, options),
    };
  }
  return { globalModel, groupModels };
}

function predictHierarchy(hierarchy, row) {
  const global = predictWeightedIsotonicV109(hierarchy?.globalModel, row.rawWeightedEv);
  const group = hierarchy?.groupModels?.[groupKey(row)];
  const local = predictWeightedIsotonicV109(group?.model, row.rawWeightedEv);
  if (global == null) return null;
  if (local == null || !group) return global;
  return global * (1 - group.blendWeight) + local * group.blendWeight;
}

function residualBlocks(predictions, keyFn) {
  const blocks = new Map();
  for (const row of predictions) {
    const key = keyFn(row.gameStart);
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(row.realizedNetReturn - row.calibratedW);
  }
  return [...blocks.entries()].map(([key, values]) => ({ key, residual: mean(values), sampleSize: values.length }));
}

function lower95ByDay(rows) {
  const blocks = residualBlocks(rows.map(row => ({ ...row, calibratedW: 0 })), dayOf).map(row => row.residual);
  if (!blocks.length) return null;
  const average = mean(blocks);
  if (blocks.length === 1) return average;
  const variance = blocks.reduce((sum, value) => sum + (value - average) ** 2, 0) / (blocks.length - 1);
  return average - 1.96 * Math.sqrt(variance / blocks.length);
}

export function buildContinuousOosCalibrationV109(inputs, options = {}) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const input of inputs || []) {
    const checked = validatePitObservationV109({ ...input, schemaVersion: PIT_PREDICTION_SCHEMA_V109 });
    if (!checked.ok) { rejected.push({ observationId: input?.observationId || null, errors: checked.errors }); continue; }
    if (seen.has(checked.value.observationId)) { rejected.push({ observationId: checked.value.observationId, errors: ['DUPLICATE_OBSERVATION'] }); continue; }
    seen.add(checked.value.observationId);
    accepted.push(checked.value);
  }
  const rows = accepted.sort((a, b) => a.gameStart.localeCompare(b.gameStart));
  const minimumTrainRows = options.minimumTrainRows || 200;
  const minimumValidationRows = options.minimumValidationRows || 80;
  const months = [...new Set(rows.map(row => monthOf(row.gameStart)))].sort();
  const predictions = [];
  const folds = [];
  for (const month of months) {
    const train = rows.filter(row => monthOf(row.gameStart) < month);
    const validation = rows.filter(row => monthOf(row.gameStart) === month);
    if (train.length < minimumTrainRows || validation.length < (options.minimumRowsPerFold || 10)) continue;
    const hierarchy = fitHierarchy(train, { ...options, through: train.at(-1).gameStart });
    const foldRows = validation.map(row => ({ ...row, calibratedW: predictHierarchy(hierarchy, row), validationMonth: month }));
    predictions.push(...foldRows);
    folds.push({ validationMonth: month, trainedThrough: train.at(-1).gameStart, trainRows: train.length, validationRows: validation.length });
  }
  if (rows.length < minimumTrainRows || predictions.length < minimumValidationRows) {
    return { ok: false, status: 'FORWARD_SAMPLE_INSUFFICIENT', acceptedRows: rows.length, rejected, folds, oosSampleSize: predictions.length };
  }
  const monthlyResiduals = residualBlocks(predictions, monthOf);
  const dailyResiduals = residualBlocks(predictions, dayOf);
  const robustAdjustment = Math.min(
    quantile(monthlyResiduals.map(row => row.residual), options.robustQuantile || 0.10) ?? 0,
    quantile(dailyResiduals.map(row => row.residual), options.robustQuantile || 0.10) ?? 0,
  );
  const withRobust = predictions.map(row => ({ ...row, robustR: row.calibratedW + robustAdjustment }));
  const positive = withRobust.filter(row => row.calibratedW > 0 && row.robustR > 0);
  const uniqueGames = new Set(rows.map(row => row.gameId)).size;
  const observedMonths = new Set(rows.map(row => monthOf(row.gameStart))).size;
  const positiveLower95 = lower95ByDay(positive);
  const releaseChecks = {
    sampleSize: rows.length >= minimumTrainRows,
    oosSampleSize: withRobust.length >= minimumValidationRows,
    uniqueGames: uniqueGames >= (options.minimumUniqueGames || 100),
    timeBlocks: observedMonths >= (options.minimumMonths || 3),
    positiveCandidates: positive.length >= (options.minimumPositiveCandidates || 30),
    positiveReturnLower95: positiveLower95 != null && positiveLower95 > 0,
  };
  const hierarchy = fitHierarchy(rows, { ...options, through: rows.at(-1).gameStart });
  const artifactCore = {
    schemaVersion: PIT_OBSERVATION_SCHEMA_V109,
    calibrationVersion: CONTINUOUS_CALIBRATION_V109_VERSION,
    trainedThrough: rows.at(-1).gameStart,
    sampleSize: rows.length,
    oosSampleSize: withRobust.length,
    uniqueGames,
    observedMonths,
    folds,
    hierarchy,
    robustQuantile: options.robustQuantile || 0.10,
    robustAdjustment,
    releaseEligible: Object.values(releaseChecks).every(Boolean),
    automaticActivation: false,
    releaseChecks,
    diagnostics: {
      rejectedRows: rejected.length,
      rawMeanEv: mean(rows.map(row => row.rawWeightedEv)),
      realizedMeanReturn: mean(rows.map(row => row.realizedNetReturn)),
      oosMeanW: mean(withRobust.map(row => row.calibratedW)),
      oosMeanR: mean(withRobust.map(row => row.robustR)),
      oosMae: mean(withRobust.map(row => Math.abs(row.realizedNetReturn - row.calibratedW))),
      dailyBlocks: dailyResiduals.length,
      monthlyBlocks: monthlyResiduals.length,
      positiveCandidates: positive.length,
      positiveMeanReturn: mean(positive.map(row => row.realizedNetReturn)),
      positiveReturnLower95: positiveLower95,
    },
  };
  return {
    ok: true,
    status: artifactCore.releaseEligible ? 'FORWARD_CALIBRATED_RELEASE_REVIEW_REQUIRED' : 'FORWARD_CALIBRATED_DIAGNOSTIC_ONLY',
    artifact: { ...artifactCore, artifactHash: hash(artifactCore) },
    predictions: withRobust,
    rejected,
  };
}

export function applyContinuousCalibrationV109(artifact, row) {
  if (!artifact || artifact.calibrationVersion !== CONTINUOUS_CALIBRATION_V109_VERSION) return { ok: false, status: 'CALIBRATION_ARTIFACT_INVALID', calibratedW: null, robustR: null };
  const core = Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== 'artifactHash'));
  if (artifact.artifactHash !== hash(core)) return { ok: false, status: 'CALIBRATION_ARTIFACT_INVALID', calibratedW: null, robustR: null };
  const calibratedW = predictHierarchy(artifact.hierarchy, row);
  return {
    ok: calibratedW != null,
    status: calibratedW == null ? 'RAW_EV_INVALID' : artifact.releaseEligible ? 'FORWARD_CALIBRATED' : 'DIAGNOSTIC_ONLY',
    calibratedW,
    robustR: calibratedW == null ? null : calibratedW + artifact.robustAdjustment,
    artifactHash: artifact.artifactHash,
    releaseEligible: artifact.releaseEligible === true,
  };
}
