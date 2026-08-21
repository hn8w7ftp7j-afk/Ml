import crypto from 'node:crypto';

export const PIT_SCHEMA_VERSION = 'pit-observation-v1';
export const OOS_CALIBRATION_VERSION = 'pit-oos-isotonic-block-bootstrap-v1';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const iso = value => {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quantile = (values, probability) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const lower = Math.floor(position); const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const seasonOf = value => Number(String(value).slice(0, 4));
const monthOf = value => String(value).slice(0, 7);

export function validatePitObservation(input) {
  const errors = [];
  const row = {
    schemaVersion: input?.schemaVersion,
    observationId: String(input?.observationId || ''),
    league: String(input?.league || '').toUpperCase(),
    gameId: String(input?.gameId || ''),
    gameStart: iso(input?.gameStart),
    snapshotAsOf: iso(input?.snapshotAsOf),
    modelAsOf: iso(input?.modelAsOf),
    settledAt: iso(input?.settledAt),
    marketFamily: String(input?.marketFamily || ''),
    contractType: String(input?.contractType || ''),
    rawWeightedEv: finite(input?.rawWeightedEv),
    realizedNetReturn: finite(input?.realizedNetReturn),
    water: finite(input?.water),
    sourcePayloadHash: String(input?.sourcePayloadHash || '').toLowerCase(),
    modelInputHash: String(input?.modelInputHash || '').toLowerCase(),
    featureObservedAts: Object.fromEntries(Object.entries(input?.featureObservedAts || {}).map(([key, value]) => [key, iso(value)])),
  };
  if (row.schemaVersion !== PIT_SCHEMA_VERSION) errors.push('SCHEMA_VERSION_INVALID');
  if (!row.observationId || !row.gameId) errors.push('IDENTITY_MISSING');
  if (!/^(MLB|NPB|KBO|CPBL)$/.test(row.league)) errors.push('LEAGUE_INVALID');
  if (!row.gameStart || !row.snapshotAsOf || !row.modelAsOf || !row.settledAt) errors.push('TIMESTAMP_INVALID');
  if (row.snapshotAsOf && row.gameStart && row.snapshotAsOf >= row.gameStart) errors.push('LINE_NOT_PIT');
  if (row.modelAsOf && row.snapshotAsOf && row.modelAsOf > row.snapshotAsOf) errors.push('MODEL_FROM_FUTURE');
  if (row.settledAt && row.gameStart && row.settledAt < row.gameStart) errors.push('RESULT_FROM_FUTURE');
  for (const [key, value] of Object.entries(row.featureObservedAts)) {
    if (!value) errors.push(`FEATURE_TIMESTAMP_INVALID:${key}`);
    else if (row.modelAsOf && value > row.modelAsOf) errors.push(`FEATURE_FROM_FUTURE:${key}`);
  }
  if (!row.marketFamily || !row.contractType) errors.push('CONTRACT_IDENTITY_MISSING');
  if (row.rawWeightedEv == null || Math.abs(row.rawWeightedEv) > 1) errors.push('RAW_EV_INVALID');
  if (row.realizedNetReturn == null || row.realizedNetReturn < -1.1 || row.realizedNetReturn > 2) errors.push('RETURN_INVALID');
  if (row.water == null || row.water <= 0 || row.water > 2) errors.push('WATER_INVALID');
  if (!/^[a-f0-9]{64}$/.test(row.sourcePayloadHash)) errors.push('SOURCE_HASH_INVALID');
  if (!/^[a-f0-9]{64}$/.test(row.modelInputHash)) errors.push('MODEL_HASH_INVALID');
  return { ok: errors.length === 0, errors, value: errors.length ? null : row };
}

export function validatePitDataset(inputs) {
  const accepted = []; const rejected = []; const identities = new Set();
  for (const input of inputs || []) {
    const checked = validatePitObservation(input);
    if (!checked.ok) { rejected.push({ observationId: input?.observationId || null, errors: checked.errors }); continue; }
    const identity = checked.value.observationId;
    if (identities.has(identity)) { rejected.push({ observationId: identity, errors: ['DUPLICATE_OBSERVATION'] }); continue; }
    identities.add(identity); accepted.push(checked.value);
  }
  return { ok: rejected.length === 0, accepted, rejected };
}

export function fitIsotonic(rows, { maximumBins = 20, minimumBinSize = 25 } = {}) {
  const sorted = [...rows].sort((a, b) => a.rawWeightedEv - b.rawWeightedEv);
  const binCount = Math.max(1, Math.min(maximumBins, Math.floor(sorted.length / minimumBinSize)));
  const binned = [];
  for (let index = 0; index < binCount; index += 1) {
    const from = Math.floor(index * sorted.length / binCount);
    const to = Math.floor((index + 1) * sorted.length / binCount);
    const members = sorted.slice(from, to);
    if (members.length) binned.push({ minX: members[0].rawWeightedEv, maxX: members.at(-1).rawWeightedEv, sum: members.reduce((sum, row) => sum + row.realizedNetReturn, 0), weight: members.length });
  }
  const blocks = [];
  for (const bin of binned) {
    blocks.push(bin);
    while (blocks.length > 1 && blocks.at(-2).sum / blocks.at(-2).weight > blocks.at(-1).sum / blocks.at(-1).weight) {
      const right = blocks.pop(); const left = blocks.pop();
      blocks.push({ minX: left.minX, maxX: right.maxX, sum: left.sum + right.sum, weight: left.weight + right.weight });
    }
  }
  return blocks.map(block => ({ minRawEv: block.minX, maxRawEv: block.maxX, calibratedEv: block.sum / block.weight, sampleSize: block.weight }));
}

export function predictIsotonic(model, rawWeightedEv) {
  if (!model?.length || !Number.isFinite(rawWeightedEv)) return null;
  const hit = model.find(block => rawWeightedEv <= block.maxRawEv);
  return (hit || model.at(-1)).calibratedEv;
}

function groupKey(row) { return [row.league, row.marketFamily, row.contractType].join('|'); }
function blockResiduals(predictions) {
  const blocks = new Map();
  for (const row of predictions) {
    const key = monthOf(row.gameStart);
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(row.realizedNetReturn - row.calibratedW);
  }
  return [...blocks.entries()].map(([key, values]) => ({ key, residual: mean(values), sampleSize: values.length }));
}

export function buildOosCalibration(inputs, { minimumTrainRows = 200, minimumValidationRows = 50, robustQuantile = 0.10 } = {}) {
  const checked = validatePitDataset(inputs);
  if (!checked.ok) return { ok: false, status: 'PIT_DATA_REJECTED', rejected: checked.rejected };
  const rows = checked.accepted.sort((a, b) => a.gameStart.localeCompare(b.gameStart));
  const seasons = [...new Set(rows.map(row => seasonOf(row.gameStart)))].sort();
  const predictions = []; const folds = [];
  for (const validationSeason of seasons) {
    const train = rows.filter(row => seasonOf(row.gameStart) < validationSeason);
    const validation = rows.filter(row => seasonOf(row.gameStart) === validationSeason);
    if (train.length < minimumTrainRows || validation.length < minimumValidationRows) continue;
    const globalModel = fitIsotonic(train);
    const groupModels = new Map();
    for (const key of new Set(train.map(groupKey))) {
      const groupRows = train.filter(row => groupKey(row) === key);
      if (groupRows.length >= minimumTrainRows) groupModels.set(key, fitIsotonic(groupRows));
    }
    const foldPredictions = validation.map(row => ({ ...row, calibratedW: predictIsotonic(groupModels.get(groupKey(row)) || globalModel, row.rawWeightedEv), validationSeason }));
    predictions.push(...foldPredictions);
    folds.push({ validationSeason, trainRows: train.length, validationRows: validation.length, trainedThrough: validationSeason - 1 });
  }
  if (predictions.length < minimumValidationRows) return { ok: false, status: 'OOS_SAMPLE_INSUFFICIENT', acceptedRows: rows.length, folds };
  const residualBlocks = blockResiduals(predictions);
  if (residualBlocks.length < 3) return { ok: false, status: 'OOS_TIME_BLOCKS_INSUFFICIENT', acceptedRows: rows.length, folds };
  const robustAdjustment = quantile(residualBlocks.map(row => row.residual), robustQuantile);
  const withRobust = predictions.map(row => ({ ...row, robustR: row.calibratedW + robustAdjustment }));
  const finalModel = fitIsotonic(rows);
  const artifactCore = {
    schemaVersion: PIT_SCHEMA_VERSION, calibrationVersion: OOS_CALIBRATION_VERSION,
    trainedThrough: rows.at(-1).gameStart, sampleSize: rows.length, oosSampleSize: withRobust.length,
    folds, isotonicModel: finalModel, robustQuantile, robustAdjustment,
    diagnostics: {
      rawMeanEv: mean(rows.map(row => row.rawWeightedEv)), realizedMeanReturn: mean(rows.map(row => row.realizedNetReturn)),
      oosMeanW: mean(withRobust.map(row => row.calibratedW)), oosMeanR: mean(withRobust.map(row => row.robustR)),
      oosMae: mean(withRobust.map(row => Math.abs(row.realizedNetReturn - row.calibratedW))),
      timeBlocks: residualBlocks.length,
      blockCoverage: mean(residualBlocks.map(block => block.residual >= robustAdjustment ? 1 : 0)),
    },
  };
  return { ok: true, status: 'OOS_CALIBRATED', artifact: { ...artifactCore, artifactHash: hash(artifactCore) }, predictions: withRobust };
}

export function applyOosCalibration(artifact, rawWeightedEv) {
  if (!artifact || artifact.calibrationVersion !== OOS_CALIBRATION_VERSION || artifact.artifactHash !== hash(Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== 'artifactHash')))) {
    return { ok: false, status: 'CALIBRATION_ARTIFACT_INVALID', calibratedW: null, robustR: null };
  }
  const calibratedW = predictIsotonic(artifact.isotonicModel, Number(rawWeightedEv));
  return { ok: calibratedW != null, status: calibratedW == null ? 'RAW_EV_INVALID' : 'OOS_CALIBRATED', calibratedW, robustR: calibratedW == null ? null : calibratedW + artifact.robustAdjustment, artifactHash: artifact.artifactHash };
}
