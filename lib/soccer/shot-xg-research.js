import { createHash } from 'node:crypto';
import { validateSoccerWyscoutShotDataset } from './wyscout-shot-source.js';

// Research only. The source normalizer owns the private raw-document proof;
// neither a saved JSON flag nor this model can authorize a production score.
export const SOCCER_SHOT_XG_RESEARCH_VERSION = 'SOCCER-WYSCOUT-XY-SHOT-RESEARCH-v1';
export const SOCCER_SHOT_XG_PROTOCOL = Object.freeze({
  version: 'SOCCER-WYSCOUT-XY-SHOT-PROTOCOL-2017-18-v1',
  provider: 'WYSCOUT_OPEN_DATA', league: 'epl',
  coordinateContract: 'WYSCOUT_ATTACK_RIGHT_UNIT_SQUARE-v1',
  trainingBefore: '2018-01-01', calibrationBefore: '2018-03-01', testBefore: '2018-06-01',
  splitUnit: 'WHOLE_MATCH_PROVIDER_DATE_WITH_VERIFIED_UTC_KICKOFF_BUFFER',
  embargoHours: 48, strictEmbargo: true,
  candidate: 'DEPTH_LATERAL_DEPTH_SQUARED_LATERAL_SQUARED_LOGIT',
  locationBaseline: 'DEPTH_ONLY_LOGIT', constantBaseline: 'TRAINING_NONPENALTY_SHOT_GOAL_RATE',
  objective: 'MEAN_TRAINING_LOG_LOSS_PLUS_HALF_L2_TIMES_NONINTERCEPT_SLOPE_NORM',
  l2: 0.01, calibration: 'FROZEN_TRAINED_LOGIT_PLUS_CALIBRATION_ONLY_INTERCEPT_SHIFT',
  featureSelection: 'FIXED_BEFORE_CORPUS_METRICS_NO_TEST_TUNING',
  featureScaling: 'TRAINING_ONLY_POPULATION_MEAN_STD_NONINTERCEPT',
  interpretation: 'RETROSPECTIVE_CHRONOLOGICAL_HOLDOUT_NOT_PREREGISTERED_PREMATCH_OOS',
});
const policy = SOCCER_SHOT_XG_PROTOCOL;
const restrictions = Object.freeze({ accepted: false, formalEligible: false, calibrationEligible: false,
  promotionEligible: false, modelEffectApplied: false, executable: false,
  independentUntouchedTestVerified: false, historicalAvailabilityVerified: false,
  providerXgReconstructed: false, currentSeasonCoverageVerified: false, uclCoverageVerified: false,
  formalExpectedReturnErrorEstimate: null, W: null, R: null, S: null });
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const soccerShotXgHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const seal = value => ({ ...value, contentHash: soccerShotXgHash(value) });
const fail = code => { throw Error(code); };
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(deepFreeze); Object.freeze(value);
} return value; };
const models = new WeakMap(), reports = new WeakMap();
const featureNames = kind => kind === 'XY_POLYNOMIAL' ? ['INTERCEPT', 'DEPTH', 'LATERAL', 'DEPTH_SQUARED', 'LATERAL_SQUARED']
  : kind === 'DEPTH_ONLY' ? ['INTERCEPT', 'DEPTH'] : kind === 'CONSTANT' ? ['INTERCEPT'] : null;
const features = (shot, kind) => {
  if (!finite(shot?.x) || !finite(shot?.y) || shot.x < 0 || shot.x > 1 || shot.y < 0 || shot.y > 1)
    fail('SHOT_XG_COORDINATE_CONTRACT_INVALID');
  // Native percentage geometry only: no metres, stadium dimensions, goal
  // width or undocumented cross-provider angle/orientation conversion.
  const depth = 1 - shot.x, lateral = Math.abs(shot.y - 0.5);
  return kind === 'XY_POLYNOMIAL' ? [1, depth, lateral, depth * depth, lateral * lateral]
    : kind === 'DEPTH_ONLY' ? [1, depth] : kind === 'CONSTANT' ? [1] : fail('SHOT_XG_MODEL_KIND_INVALID');
};
const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
const softplus = value => value > 0 ? value + Math.log1p(Math.exp(-value)) : Math.log1p(Math.exp(value));
const sigmoid = value => value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
const logLoss = (logit, goal) => goal ? softplus(-logit) : softplus(logit);
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function solve(matrix, vector) {
  const size = vector.length, rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    if (!finite(rows[pivot][column]) || Math.abs(rows[pivot][column]) <= Number.EPSILON)
      fail('SHOT_XG_OPTIMIZER_SINGULAR');
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    for (let row = column + 1; row < size; row++) {
      const ratio = rows[row][column] / rows[column][column];
      for (let index = column; index <= size; index++) rows[row][index] -= ratio * rows[column][index];
    }
  }
  const answer = Array(size).fill(0);
  for (let row = size - 1; row >= 0; row--)
    answer[row] = (rows[row][size] - rows[row].slice(row + 1, size).reduce((sum, value, index) => sum + value * answer[row + 1 + index], 0)) / rows[row][row];
  if (!answer.every(finite)) fail('SHOT_XG_OPTIMIZER_NONFINITE');
  return answer;
}

function optimize(rows, kind, { offsets = null, l2 = policy.l2, featureRows = null } = {}) {
  const goals = rows.reduce((sum, row) => sum + Number(row.goal), 0), size = featureNames(kind)?.length;
  if (!size || !rows.length || goals === 0 || goals === rows.length) fail('SHOT_XG_FIT_NEEDS_BOTH_OUTCOMES');
  const values = featureRows || rows.map(row => features(row, kind)), targets = rows.map(row => Number(row.goal));
  if (values.length !== rows.length || values.some(row => !Array.isArray(row) || row.length !== size || !row.every(finite)))
    fail('SHOT_XG_FIT_FEATURES_INVALID');
  const fixed = offsets || rows.map(() => 0);
  if (fixed.length !== rows.length || !fixed.every(finite)) fail('SHOT_XG_OFFSET_INVALID');
  let weights = Array(size).fill(0);
  if (!offsets) weights[0] = Math.log(goals / (rows.length - goals));
  const objective = candidate => values.reduce((sum, value, index) => sum + logLoss(dot(value, candidate) + fixed[index], targets[index]), 0) / rows.length
    + 0.5 * l2 * candidate.slice(1).reduce((sum, value) => sum + value * value, 0);
  let iterations = 0, converged = false, maxGradient = Infinity;
  for (; iterations < 100; iterations++) {
    const gradient = Array(size).fill(0), hessian = Array.from({ length: size }, () => Array(size).fill(0));
    for (let index = 0; index < rows.length; index++) {
      const x = values[index], probability = sigmoid(dot(x, weights) + fixed[index]);
      for (let j = 0; j < size; j++) {
        gradient[j] += x[j] * (probability - targets[index]) / rows.length;
        for (let k = 0; k < size; k++) hessian[j][k] += x[j] * x[k] * probability * (1 - probability) / rows.length;
      }
    }
    for (let j = 1; j < size; j++) { gradient[j] += l2 * weights[j]; hessian[j][j] += l2; }
    maxGradient = Math.max(...gradient.map(Math.abs));
    if (maxGradient < 1e-9) { converged = true; break; }
    const step = solve(hessian, gradient), previous = objective(weights);
    let scale = 1, accepted;
    for (let attempt = 0; attempt < 45; attempt++, scale /= 2) {
      const candidate = weights.map((value, index) => value - scale * step[index]);
      if (candidate.every(finite) && objective(candidate) <= previous) { accepted = candidate; break; }
    }
    if (!accepted) fail('SHOT_XG_OPTIMIZER_LINE_SEARCH_FAILED');
    const change = Math.max(...weights.map((value, index) => Math.abs(value - accepted[index])));
    weights = accepted;
    if (change < 1e-10) { converged = true; iterations++; break; }
  }
  // Recompute stationarity at the returned weights, including the rare
  // floating-point small-step exit. An old iterate's gradient is not proof.
  const finalGradient = Array(size).fill(0);
  for (let index = 0; index < rows.length; index++) {
    const difference = sigmoid(dot(values[index], weights) + fixed[index]) - targets[index];
    for (let j = 0; j < size; j++) finalGradient[j] += values[index][j] * difference / rows.length;
  }
  for (let j = 1; j < size; j++) finalGradient[j] += l2 * weights[j];
  maxGradient = Math.max(...finalGradient.map(Math.abs));
  converged = converged && maxGradient < 1e-8;
  if (!converged) fail('SHOT_XG_OPTIMIZER_DID_NOT_CONVERGE');
  return { weights, optimization: { method: 'DETERMINISTIC_NEWTON_WITH_DESCENT_LINE_SEARCH',
    converged, iterations, objective: objective(weights), maxGradient, probabilityClipping: false, l2 } };
}

const recordIdentity = row => [row.matchId, row.matchDate, row.kickoff, row.teamId, row.shotId, row.period, row.x, row.y, row.goal];
const scaleFeatures = (values, scaling) => values.map((value, index) => index ? (value - scaling.mean[index]) / scaling.std[index] : value);
function trainingModel(rows, kind, scope) {
  const raw = rows.map(row => features(row, kind));
  const zeroVariance = raw[0].map((_value, index) => index > 0 && raw.every(row => row[index] === raw[0][index]));
  const mean = raw[0].map((_value, index) => !index ? 0 : zeroVariance[index] ? raw[0][index]
    : raw.reduce((sum, row) => sum + row[index], 0) / raw.length);
  const variance = mean.map((_value, index) => index
    ? raw.reduce((sum, row) => sum + (row[index] - mean[index]) ** 2, 0) / raw.length : 1);
  if (variance.some((value, index) => !zeroVariance[index] && !(value > 0 && finite(value))))
    fail('SHOT_XG_TRAINING_VARIANCE_UNREPRESENTABLE');
  const scaling = { method: policy.featureScaling, mean, std: variance.map((value, index) => zeroVariance[index] ? 1 : Math.sqrt(value)),
    zeroVariance, fittedOn: 'TRAINING_SHOTS_ONLY' };
  const fitted = optimize(rows, kind, { featureRows: raw.map(row => scaleFeatures(row, scaling)) });
  const model = deepFreeze(seal({ version: SOCCER_SHOT_XG_RESEARCH_VERSION, kind, featureNames: featureNames(kind),
    provider: scope.provider, league: scope.league, coordinateContract: scope.coordinateContract,
    synthetic: scope.synthetic, sourceAuthenticationVerified: scope.sourceAuthenticationVerified,
    trainingInputHash: soccerShotXgHash(rows.map(recordIdentity)), trainingShots: rows.length,
    trainingGames: new Set(rows.map(row => row.matchId)).size, trainingGoals: rows.filter(row => row.goal).length,
    trainingBefore: policy.trainingBefore, embargoHours: policy.embargoHours,
    trainedThrough: rows.reduce((latest, row) => row.kickoff > latest ? row.kickoff : latest, ''),
    scaling, ...fitted, ...restrictions }));
  models.set(model, { hash: model.contentHash, availableAt: scope.availableAt });
  return model;
}

function modelLogit(model, shot) {
  if (!model || models.get(model)?.hash !== model.contentHash) fail('SHOT_XG_MODEL_NOT_PRIVATELY_FITTED');
  if (shot?.provider !== model.provider || shot?.league !== model.league || shot?.coordinateContract !== model.coordinateContract)
    fail('SHOT_XG_PREDICTION_SOURCE_SCOPE_MISMATCH');
  if (shot.penalty !== false || ![1, 2].includes(shot.period)) fail('SHOT_XG_PREDICTION_NONPENALTY_REGULATION_SCOPE_REQUIRED');
  const parent = model.kind === 'CALIBRATED_XY' ? model.baseModel : model;
  return dot(scaleFeatures(features(shot, parent.kind), parent.scaling), parent.weights) + (model.kind === 'CALIBRATED_XY' ? model.offset : 0);
}
export function predictSoccerShotXgResearch(model, shot) {
  const logit = modelLogit(model, shot);
  return { version: SOCCER_SHOT_XG_RESEARCH_VERSION, modelHash: model.contentHash,
    provider: model.provider, league: model.league, coordinateContract: model.coordinateContract,
    synthetic: model.synthetic, trainingSourceAuthenticationVerified: model.sourceAuthenticationVerified,
    sourceAuthenticationVerified: false, predictionSourceAuthenticationVerified: false, hypotheticalLocation: true,
    modelAvailableAt: models.get(model).availableAt,
    xg: sigmoid(logit), logit, interpretation: 'HYPOTHETICAL_XY_SHOT_GOAL_PROBABILITY_NOT_PROVIDER_XG_OR_VERIFIED_TARGET_SOURCE', ...restrictions };
}

function metrics(model, rows, scope) {
  const bins = Array.from({ length: 10 }, (_, index) => ({ lower: index / 10, upper: (index + 1) / 10,
    count: 0, sumProbability: 0, goals: 0 }));
  let squared = 0, loss = 0, predicted = 0, goals = 0;
  const perGame = new Map();
  for (const row of rows) {
    const logit = modelLogit(model, { ...row, ...scope }), probability = sigmoid(logit), target = Number(row.goal);
    squared += (probability - target) ** 2; loss += logLoss(logit, target); predicted += probability; goals += target;
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.count++; bin.sumProbability += probability; bin.goals += target;
    const game = perGame.get(row.matchId) || { predictedGoals: 0, observedShotGoals: 0, shots: 0 };
    game.predictedGoals += probability; game.observedShotGoals += target; game.shots++; perGame.set(row.matchId, game);
  }
  return { games: perGame.size, shots: rows.length, observedShotGoals: goals,
    brier: rows.length ? squared / rows.length : null, logLoss: rows.length ? loss / rows.length : null,
    predictedShotGoals: rows.length ? predicted : null,
    observedGoalRate: rows.length ? goals / rows.length : null, predictedMean: rows.length ? predicted / rows.length : null,
    calibrationError: rows.length ? bins.reduce((sum, bin) => sum + Math.abs(bin.sumProbability - bin.goals), 0) / rows.length : null,
    calibrationBins: bins.map(bin => ({ lower: bin.lower, upper: bin.upper, count: bin.count,
      predictedMean: bin.count ? bin.sumProbability / bin.count : null, observedRate: bin.count ? bin.goals / bin.count : null })),
    gameGoalCountMae: average([...perGame.values()].map(game => Math.abs(game.predictedGoals - game.observedShotGoals))),
    interpretation: 'SHOT_OUTCOME_HOLDOUT_DIAGNOSTICS_GAME_GOAL_RESIDUAL_INCLUDES_OUTCOME_NOISE_NOT_TRUE_NPXG_ERROR',
  };
}

/** Whole games are assigned by their provider date, with a strict verified UTC
 * kickoff + 48h embargo before each fitting cutoff. Source retrieval occurred
 * retrospectively: chronological separation is not historical PIT evidence. */
export function fitSoccerShotXgResearch(dataset, { protocol = policy, now = Date.now() } = {}) {
  const proof = validateSoccerWyscoutShotDataset(dataset);
  if (proof !== true && proof?.ok !== true) fail('SHOT_XG_SOURCE_DATASET_UNVERIFIED');
  if (canonical(protocol) !== canonical(policy)) fail('SHOT_XG_PROTOCOL_NOT_THE_FROZEN_RESEARCH_PLAN');
  if (!finite(now) || (dataset.provider !== policy.provider
      && !(dataset.synthetic === true && dataset.provider === 'SYNTHETIC_ENGINEERING_FIXTURE')) || dataset.league !== policy.league
    || dataset.coordinateContract !== policy.coordinateContract || !sha(dataset.sourceManifestHash)
    || !Array.isArray(dataset.sourceHashes) || !dataset.sourceHashes.length || !dataset.sourceHashes.every(sha)
    || !Array.isArray(dataset.matches) || dataset.matches.length > 1000) fail('SHOT_XG_DATASET_SCOPE_INVALID');
  const availability = proof?.trustedDatasetAvailableAt ?? proof?.sourceAvailableAt ?? proof?.availableAt ?? dataset.availableAt ?? dataset.normalizedAt ?? dataset.createdAt;
  const available = finite(availability) ? availability : instant(availability);
  if (!Number.isFinite(available) || available > now) fail('SHOT_XG_SOURCE_NOT_AVAILABLE_AT_FIT');
  const scope = { provider: dataset.provider, league: dataset.league, coordinateContract: dataset.coordinateContract,
    synthetic: dataset.synthetic === true, sourceAuthenticationVerified: dataset.sourceAuthenticationVerified === true,
    availableAt: new Date(now).toISOString() };
  const rows = { training: [], calibration: [], test: [] }, matches = new Set(), ids = new Set(), excludedReasons = {};
  const excludedMatches = new Set(), count = code => { excludedReasons[code] = (excludedReasons[code] || 0) + 1; };
  const train = Date.parse(`${policy.trainingBefore}T00:00:00Z`), calibration = Date.parse(`${policy.calibrationBefore}T00:00:00Z`);
  const embargo = policy.embargoHours * 3600000;
  let sourceShots = 0, penaltyShotsExcluded = 0;
  for (const match of dataset.matches) {
    if (typeof match.matchId !== 'string' || !match.matchId || matches.has(match.matchId) || !validDate(match.matchDate)
      || !Array.isArray(match.shots) || !match.teams || typeof match.teams.home !== 'string' || typeof match.teams.away !== 'string'
      || match.teams.home === match.teams.away) fail('SHOT_XG_MATCH_SCOPE_INVALID');
    matches.add(match.matchId);
    const kickoff = instant(match.kickoff);
    if (Number.isFinite(kickoff) && new Date(kickoff).toISOString().slice(0, 10) !== match.matchDate)
      fail('SHOT_XG_MATCH_UTC_DATE_MISMATCH');
    let split = match.matchDate < policy.trainingBefore ? 'training'
      : match.matchDate < policy.calibrationBefore ? 'calibration' : match.matchDate < policy.testBefore ? 'test' : null;
    if (!Number.isFinite(kickoff) || kickoff > now) { split = null; count('MATCH_KICKOFF_UNVERIFIED'); }
    else if (split === 'training' && !(kickoff + embargo < train)
      || split === 'calibration' && !(kickoff >= train && kickoff + embargo < calibration)
      || split === 'test' && kickoff < calibration) { split = null; count('STRICT_48H_FIT_BOUNDARY_EMBARGO'); }
    else if (!split) count('OUTSIDE_FIXED_RESEARCH_WINDOWS');
    if (!split) excludedMatches.add(match.matchId);
    for (const shot of match.shots) {
      sourceShots++;
      if (sourceShots > 100000) fail('SHOT_XG_SOURCE_SHOT_CAPACITY');
      const key = `${match.matchId}:${shot.shotId}`;
      if (typeof shot.shotId !== 'string' || !shot.shotId || ids.has(key) || typeof shot.goal !== 'boolean'
        || typeof shot.penalty !== 'boolean' || ![1, 2].includes(shot.period)
        || ![match.teams.home, match.teams.away].includes(shot.teamId)) fail('SHOT_XG_SHOT_SCOPE_OR_OUTCOME_INVALID');
      ids.add(key); features(shot, 'XY_POLYNOMIAL');
      if (shot.penalty) { penaltyShotsExcluded++; continue; }
      if (split) rows[split].push({ ...shot, matchId: match.matchId, matchDate: match.matchDate, kickoff: match.kickoff });
    }
  }
  if (!rows.training.length) fail('SHOT_XG_TRAINING_EMPTY');
  const candidate = trainingModel(rows.training, 'XY_POLYNOMIAL', scope);
  const locationBaseline = trainingModel(rows.training, 'DEPTH_ONLY', scope);
  const constantBaseline = trainingModel(rows.training, 'CONSTANT', scope);
  let calibrated = null, calibrationStatus = 'CALIBRATION_EMPTY';
  if (rows.calibration.length) {
    const goals = rows.calibration.filter(row => row.goal).length;
    if (!goals || goals === rows.calibration.length) calibrationStatus = 'CALIBRATION_NEEDS_BOTH_OUTCOMES';
    else {
      const offsets = rows.calibration.map(row => modelLogit(candidate, { ...row, ...scope }));
      const fitted = optimize(rows.calibration, 'CONSTANT', { offsets, l2: 0 });
      calibrated = deepFreeze(seal({ version: SOCCER_SHOT_XG_RESEARCH_VERSION, kind: 'CALIBRATED_XY',
        provider: scope.provider, league: scope.league, coordinateContract: scope.coordinateContract,
        synthetic: scope.synthetic, sourceAuthenticationVerified: scope.sourceAuthenticationVerified,
        baseModel: candidate, baseModelHash: candidate.contentHash, offset: fitted.weights[0],
        optimization: fitted.optimization, calibrationBefore: policy.calibrationBefore,
        calibrationInputHash: soccerShotXgHash(rows.calibration.map(recordIdentity)),
        calibrationShots: rows.calibration.length, calibrationGames: new Set(rows.calibration.map(row => row.matchId)).size,
        ...restrictions }));
      models.set(calibrated, { hash: calibrated.contentHash, availableAt: scope.availableAt }); calibrationStatus = 'CALIBRATION_FIT_RESEARCH_ONLY';
    }
  }
  const definitions = { candidate, calibratedCandidate: calibrated, locationBaseline, constantBaseline };
  const evaluation = Object.fromEntries(Object.entries(rows).map(([split, selected]) => [split,
    Object.fromEntries(Object.entries(definitions).map(([name, model]) => [name, model ? metrics(model, selected, scope) : null]))]));
  const completedAt = new Date(scope.synthetic ? now : Date.now()).toISOString();
  for (const model of Object.values(definitions)) if (model) models.set(model, { hash: model.contentHash, availableAt: completedAt });
  const report = deepFreeze(seal({ version: SOCCER_SHOT_XG_RESEARCH_VERSION, type: 'PRIVATE_SHOT_XG_RESEARCH_REPORT',
    status: 'RETROSPECTIVE_RESEARCH_FIT_NOT_ACCEPTED', ...scope, createdAt: completedAt, availableAt: completedAt,
    season: scope.synthetic ? 'SYNTHETIC_ENGINEERING_FIXTURE' : '2017/2018',
    sourceAttribution: scope.synthetic ? { license: null, description: 'Explicit synthetic engineering fixture, not observed football data' }
      : { name: 'Wyscout public event dataset', authors: 'Pappalardo et al. (2019)',
      paperUrl: 'https://doi.org/10.1038/s41597-019-0247-7', license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      changes: 'Origin coordinates changed from percentages to fractions; regulation non-penalty shots selected under the reviewed source contract; a new XY-only shot-goal model is fitted. These are not Wyscout xG values.' },
    sourceCollection: dataset.coverage && Object.fromEntries(['sourceMatches', 'eligibleMatches', 'quarantinedMatches', 'sourceEvents',
      'retainedNativeEvents', 'fullPublishedCohortVerified', 'currentSeasonCoverage', 'uclCoverage', 'shotUniverse'].map(key => [key, dataset.coverage[key]])),
    protocol, protocolHash: soccerShotXgHash(protocol), sourceManifestHash: dataset.sourceManifestHash,
    sourceHashes: [...dataset.sourceHashes], datasetHash: soccerShotXgHash(dataset), calibrationStatus,
    coverage: { sourceMatches: dataset.matches.length, sourceShots, includedMatches: new Set(Object.values(rows).flat().map(row => row.matchId)).size,
      includedNonPenaltyShots: Object.values(rows).reduce((sum, value) => sum + value.length, 0), penaltyShotsExcluded,
      excludedMatches: excludedMatches.size, excludedReasons, independentSampleUnit: 'REAL_MATCH_NOT_SHOT_OR_QUOTE' },
    models: definitions, evaluation, interpretation: policy.interpretation,
    limitations: [
      'The source files were fetched after the historical games; this is not a prospectively frozen independent test.',
      'Only one provider and league are fitted. No undocumented ESPN or other-provider coordinate mapping is allowed.',
      'The model predicts shot goals from origin XY only; it is not the provider xG, a prematch team model or a complete score distribution.',
      'Penalties, extra time and shootouts cannot enter regulation non-penalty totals.',
      'Calibration bins and realized game-goal residuals do not establish true npxG accuracy or conditional expected-return uncertainty.',
      'Source completeness, current-season transfer, injuries, personnel effects, football calibration and formal W/R/S remain separate checks.',
    ], ...restrictions }));
  reports.set(report, report.contentHash);
  return report;
}

/** Public output deliberately excludes observations, source/player statistics,
 * fitted coefficients and per-game values. The source corpus stays private. */
export function soccerShotXgAggregateReport(report) {
  if (!report || reports.get(report) !== report.contentHash) fail('SHOT_XG_REPORT_NOT_PRIVATELY_FITTED');
  const { models: fitted, contentHash, datasetHash, ...body } = report;
  return deepFreeze(seal({ ...body, type: 'AGGREGATE_SHOT_XG_RESEARCH_REPORT',
    modelHashes: Object.fromEntries(Object.entries(fitted).map(([key, value]) => [key, value?.contentHash || null])),
    privateReportHash: contentHash, rawRowsIncluded: false, fittedCoefficientsIncluded: false }));
}
