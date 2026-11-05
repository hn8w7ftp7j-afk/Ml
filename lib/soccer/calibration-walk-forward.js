import { fitScoreModel, predictScoreModel, scoreDistribution, soccerScoreLogProbability } from './score-model.js';
import { fitHalfTimeModel, predictHalfTimeDistribution, soccerHalfTimeLogProbability } from './half-time-model.js';
import { SOCCER_CALIBRATION_METHOD, soccerCalibrationHash } from './calibration-research.js';
import { soccerLeague } from './contracts.js';

export const SOCCER_CALIBRATION_WALK_FORWARD_VERSION = 'SOCCER-CALIBRATION-CHRONOLOGICAL-RETROSPECTIVE-v1';
export const SOCCER_CALIBRATION_WALK_FORWARD_FOLDS = Object.freeze([
  Object.freeze({ id: 'calibrate-2023-test-2024', baseBefore: '2023-01-01T00:00:00.000Z', calibrationBefore: '2024-01-01T00:00:00.000Z', testBefore: '2025-01-01T00:00:00.000Z' }),
  Object.freeze({ id: 'calibrate-2024-test-2025', baseBefore: '2024-01-01T00:00:00.000Z', calibrationBefore: '2025-01-01T00:00:00.000Z', testBefore: '2026-01-01T00:00:00.000Z' }),
]);
const DAY = 86400000, names = ['scoreLogLoss', 'logLoss', 'brier'];
const restrictions = { accepted: false, formalEligible: false, promotionEligible: false, executable: false,
  baselineChanged: false, historicalPitVerified: false, durableFreezeVerified: false, untouchedTestVerified: false,
  improvementEstablished: false, W: null, R: null, S: null, empiricalErrorMargin: null };
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const id = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const seal = value => ({ ...value, contentHash: soccerCalibrationHash(value) });
const errorCode = error => /^[A-Z][A-Z0-9_]{0,160}$/.test(error?.message || '') ? error.message : 'WALK_FORWARD_MODEL_FAILURE';
const reasonCounts = rows => rows.reduce((value, row) => { if (row.reason) value[row.reason] = (value[row.reason] || 0) + 1; return value; }, {});
const withoutHalfTime = ({ halfTime: _halfTime, ...row }) => row;

function sourceValid(source, league, eventId, kind, generatedAt) {
  if (source?.provider !== 'ESPN' || !sha(source.contentHash) || !Number.isFinite(instant(source.fetchedAt))
    || instant(source.fetchedAt) > generatedAt) return false;
  try {
    const url = new URL(source.url), expected = `/apis/site/v2/sports/soccer/${soccerLeague(league).espnSlug}/${kind}`;
    return url.protocol === 'https:' && url.hostname === 'site.api.espn.com' && !url.port && !url.username && !url.password && !url.hash
      && url.pathname === expected && (kind === 'summary' ? url.searchParams.get('event') === eventId
        : /^\d{4}$/.test(url.searchParams.get('dates') || ''));
  } catch { return false; }
}

function normalizedPopulation({ league, fullTimeHistory, halfTimeHistory, generatedAt }) {
  if (!soccerLeague(league) || soccerLeague(league).id !== league || !Number.isFinite(generatedAt)
    || ![fullTimeHistory, halfTimeHistory].every(value => Array.isArray(value?.rows) && Array.isArray(value?.excluded)))
    throw Error('WALK_FORWARD_HISTORY_SCOPE_INVALID');
  const full = new Map(), half = new Map(), missing = new Map(); let duplicateFullTimeRows = 0, duplicateHalfTimeRows = 0;
  for (const row of fullTimeHistory.rows) {
    if (row?.league !== league || !id(row.eventId) || !id(row.homeId) || !id(row.awayId) || row.homeId === row.awayId
      || row.period !== 'REGULATION_FT' || !Number.isFinite(instant(row.startTime)) || instant(row.startTime) >= generatedAt
      || typeof row.neutralSite !== 'boolean' || ![row.homeGoals, row.awayGoals].every(value => Number.isInteger(value) && value >= 0 && value <= 30)
      || !sourceValid(row.source, league, row.eventId, 'scoreboard', generatedAt)
      || new URL(row.source.url).searchParams.get('dates') !== row.startTime.slice(0, 4)) throw Error('WALK_FORWARD_FULL_TIME_ROW_INVALID');
    if (full.has(row.eventId)) {
      if (soccerCalibrationHash(full.get(row.eventId)) !== soccerCalibrationHash(row)) throw Error('WALK_FORWARD_FULL_TIME_REVISION_CONFLICT');
      duplicateFullTimeRows++;
    } else full.set(row.eventId, row);
  }
  for (const row of halfTimeHistory.rows) {
    if (!full.has(row?.eventId) || row.league !== league
      || soccerCalibrationHash(withoutHalfTime(row)) !== soccerCalibrationHash(withoutHalfTime(full.get(row.eventId))))
      throw Error('WALK_FORWARD_HALF_TIME_GAME_OR_FT_CONFLICT');
    const value = row.halfTime;
    if (value?.verified !== true || value.period != null && value.period !== 'REGULATION_HT'
      || !value.evidence || ![value.home, value.away].every(value => Number.isInteger(value) && value >= 0)
      || value.home > row.homeGoals || value.away > row.awayGoals
      || !sourceValid(value.source, league, row.eventId, 'summary', generatedAt)) throw Error('WALK_FORWARD_HALF_TIME_ROW_INVALID');
    if (half.has(row.eventId)) {
      if (soccerCalibrationHash(half.get(row.eventId)) !== soccerCalibrationHash(row)) throw Error('WALK_FORWARD_HALF_TIME_REVISION_CONFLICT');
      duplicateHalfTimeRows++;
    } else half.set(row.eventId, row);
  }
  for (const row of halfTimeHistory.excluded) {
    if (!id(row?.eventId) || row.league != null && row.league !== league || typeof row.reason !== 'string'
      || !full.has(row.eventId) || half.has(row.eventId) || missing.has(row.eventId)) throw Error('WALK_FORWARD_HALF_TIME_EXCLUSION_CONFLICT');
    missing.set(row.eventId, row.reason);
  }
  const excluded = [];
  for (const row of fullTimeHistory.excluded) {
    if (!id(row?.eventId) || row.league != null && row.league !== league || typeof row.reason !== 'string'
      || row.startTime != null && !Number.isFinite(instant(row.startTime)) || full.has(row.eventId))
      throw Error('WALK_FORWARD_FULL_TIME_EXCLUSION_CONFLICT');
    excluded.push({ ...row, league });
  }
  const rows = [...full.values()].map(row => half.get(row.eventId) || { ...row, halfTime: null,
    halfTimeMissingReason: missing.get(row.eventId) || 'WALK_FORWARD_HALF_TIME_NOT_RETAINED' })
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.eventId.localeCompare(b.eventId));
  return { rows, excluded, coverage: { acceptedFullTimeGames: rows.length, acceptedHalfTimeGames: half.size,
    missingHalfTimeGames: rows.length - half.size, sourceExcludedRecords: excluded.length,
    duplicateFullTimeRows, duplicateHalfTimeRows, sourcePopulationCompletenessVerified: false,
    normalizedHistoryHashes: { fullTime: soccerCalibrationHash(fullTimeHistory), halfTime: soccerCalibrationHash(halfTimeHistory) },
    sourceHashMeaning: 'RETAINED_NORMALIZED_ROW_SOURCE_REFERENCES_NOT_RECOMPUTED_ORIGINAL_HTTP_DOCUMENTS',
    originalSourceDocumentHashesRecomputed: false, pointInTimeAvailabilityVerified: false } };
}

function encode(value) { return { value: Number.isFinite(value) ? value : null,
  state: Number.isFinite(value) ? 'FINITE' : value === Infinity ? 'POSITIVE_INFINITY' : value === -Infinity ? 'NEGATIVE_INFINITY' : 'UNAVAILABLE' }; }
function metricSummary(values) {
  const result = { games: values.length };
  for (const key of names) { const metric = encode(values.length ? values.reduce((sum, row) => sum + row[key], 0) / values.length : NaN);
    result[key] = metric.value; result[`${key}State`] = values.length && metric.state === 'UNAVAILABLE' ? 'INDETERMINATE' : metric.state; }
  return result;
}
function loss(actual, distribution, exactLogProbability) {
  const outcome = actual.home > actual.away ? 'home' : actual.home === actual.away ? 'draw' : 'away';
  if (Number.isNaN(exactLogProbability) || exactLogProbability > 1e-10 || !['home', 'draw', 'away'].every(key =>
    Number.isFinite(distribution.outcomes?.[key]) && distribution.outcomes[key] >= 0 && distribution.outcomes[key] <= 1 + 1e-10))
    throw Error('WALK_FORWARD_PROBABILITY_INVALID');
  return { scoreLogLoss: -exactLogProbability, logLoss: -Math.log(distribution.outcomes[outcome]),
    brier: ['home', 'draw', 'away'].reduce((sum, key) => sum + (distribution.outcomes[key] - Number(key === outcome)) ** 2, 0) };
}
const predictionSummary = distribution => ({ homeRate: distribution.homeRate, awayRate: distribution.awayRate, rho: distribution.rho,
  outcomes: distribution.outcomes, retainedMass: distribution.retainedMass, tailMass: distribution.tailMass });
function evaluateArm(row, fullTime, halfTimeModel, deps) {
  const result = {};
  try { result.FT = { status: 'EVALUATED', actual: { home: row.homeGoals, away: row.awayGoals }, distribution: predictionSummary(fullTime),
    metrics: loss({ home: row.homeGoals, away: row.awayGoals }, fullTime,
      soccerScoreLogProbability(row.homeGoals, row.awayGoals, fullTime.homeRate, fullTime.awayRate, fullTime.rho)) }; }
  catch (error) { result.FT = { status: 'FAILED', reason: errorCode(error) }; }
  try {
    if (row.halfTime?.verified !== true) throw Error(row.halfTimeMissingReason || 'WALK_FORWARD_HALF_TIME_NOT_RETAINED');
    if (!halfTimeModel) throw Error('WALK_FORWARD_HALF_TIME_MODEL_UNAVAILABLE');
    const distribution = deps.predictHalfTime(fullTime, halfTimeModel, row);
    result.HT = { status: 'EVALUATED', actual: { home: row.halfTime.home, away: row.halfTime.away }, distribution: predictionSummary(distribution),
      metrics: loss({ home: row.halfTime.home, away: row.halfTime.away }, distribution,
        soccerHalfTimeLogProbability(row.halfTime.home, row.halfTime.away, fullTime, halfTimeModel)) };
  } catch (error) { result.HT = { status: 'FAILED', reason: errorCode(error) }; }
  return result;
}
function reportPeriods(ledger) {
  return Object.fromEntries(['FT', 'HT'].map(period => {
    const before = ledger.filter(row => row.before[period].status === 'EVALUATED'), after = ledger.filter(row => row.after[period].status === 'EVALUATED');
    const paired = ledger.filter(row => row.before[period].status === 'EVALUATED' && row.after[period].status === 'EVALUATED');
    const differences = paired.map(row => Object.fromEntries(names.map(key => [key, row.after[period].metrics[key] - row.before[period].metrics[key]])));
    return [period, { populationGames: ledger.length, before: metricSummary(before.map(row => row.before[period].metrics)),
      after: metricSummary(after.map(row => row.after[period].metrics)), paired: { games: paired.length,
        before: metricSummary(paired.map(row => row.before[period].metrics)), after: metricSummary(paired.map(row => row.after[period].metrics)),
        differenceAfterMinusBefore: metricSummary(differences), interpretation: 'NEGATIVE_IS_BETTER_ON_THE_SAME_REAL_GAMES_NO_SIGNIFICANCE_OR_ACCEPTANCE_CLAIM',
        gameIds: paired.map(row => row.gameId) },
      beforeFailures: reasonCounts(ledger.filter(row => row.before[period].status !== 'EVALUATED').map(row => row.before[period])),
      afterFailures: reasonCounts(ledger.filter(row => row.after[period].status !== 'EVALUATED').map(row => row.after[period])),
      missingAnyArmGames: ledger.length - paired.length }];
  }));
}
function validateFolds(folds, generatedAt) {
  if (!Array.isArray(folds) || !folds.length || new Set(folds.map(fold => fold.id)).size !== folds.length) throw Error('WALK_FORWARD_SPLIT_INVALID');
  const testWindows = [];
  for (const fold of folds) {
    const times = [fold.baseBefore, fold.calibrationBefore, fold.testBefore].map(instant);
    if (typeof fold.id !== 'string' || !fold.id || !times.every(Number.isFinite) || !(times[0] < times[1] && times[1] < times[2])
      || times[2] > generatedAt || testWindows.some(([start, end]) => times[1] < end && times[2] > start)) throw Error('WALK_FORWARD_SPLIT_INVALID');
    testWindows.push([times[1], times[2]]);
  }
}

/** Offline historical reconstruction only. Historical cutoffs are label-use
 * boundaries, never invented model publication/freeze/source availability times.
 * Reuses the existing MLE method and prediction functions without registry writes. */
export function buildSoccerCalibrationWalkForward({ league, fullTimeHistory, halfTimeHistory, hyperparameters,
  folds = SOCCER_CALIBRATION_WALK_FORWARD_FOLDS, generatedAt = new Date().toISOString() } = {}, overrides = {}) {
  const now = instant(generatedAt); validateFolds(folds, now);
  if (!Number.isFinite(now) || ![hyperparameters?.fullTime?.halfLifeDays, hyperparameters?.fullTime?.penalty, hyperparameters?.halfTime?.halfLifeDays]
    .every(value => Number.isFinite(value) && value > 0)
    || Object.keys(hyperparameters.fullTime).sort().join(',') !== 'halfLifeDays,penalty'
    || Object.keys(hyperparameters.halfTime).join(',') !== 'halfLifeDays') throw Error('WALK_FORWARD_CONTEXT_INVALID');
  const deps = { fitFullTime: fitScoreModel, fitHalfTime: fitHalfTimeModel, predictFullTime: predictScoreModel,
    predictHalfTime: predictHalfTimeDistribution, ...overrides };
  const population = normalizedPopulation({ league, fullTimeHistory, halfTimeHistory, generatedAt: now }), results = [];
  const modelSummary = model => model ? { modelHash: soccerCalibrationHash(model), trainingHash: model.trainingHash,
    cutoff: model.cutoff, trainedThrough: model.trainedThrough, trainingCount: model.trainingCount, fit: model.fit || null,
    ...(model.shares ? { shares: model.shares, excludedCount: model.excludedCount, excluded: model.excluded } : {}) } : null;
  for (const fold of folds) {
    const baseAt = instant(fold.baseBefore), calibrationAt = instant(fold.calibrationBefore), testAt = instant(fold.testBefore);
    const training = population.rows.filter(row => instant(row.startTime) + DAY < baseAt);
    const calibrationPopulation = population.rows.filter(row => instant(row.startTime) >= baseAt && instant(row.startTime) < calibrationAt);
    const testPopulation = population.rows.filter(row => instant(row.startTime) >= calibrationAt && instant(row.startTime) < testAt);
    const eligibleCalibration = [], calibrationLedger = [], fitFailures = []; let model = null, halfTimeModel = null;
    try {
      model = deps.fitFullTime(training.map(withoutHalfTime), { league, cutoff: fold.baseBefore, ...hyperparameters.fullTime, maxIterations: 6000, tolerance: 1e-6 });
      if (model.league !== league || model.cutoff !== fold.baseBefore || model.fit?.converged !== true) throw Error('WALK_FORWARD_BASE_MODEL_NOT_CONVERGED_OR_SCOPE_INVALID');
    } catch (error) { fitFailures.push({ component: 'FT', reason: errorCode(error) }); model = null; }
    try {
      halfTimeModel = deps.fitHalfTime(training, { league, cutoff: fold.baseBefore, ...hyperparameters.halfTime });
      if (halfTimeModel.league !== league || halfTimeModel.cutoff !== fold.baseBefore) throw Error('WALK_FORWARD_HT_MODEL_SCOPE_INVALID');
    } catch (error) { fitFailures.push({ component: 'HT', reason: errorCode(error) }); halfTimeModel = null; }
    for (const row of calibrationPopulation) {
      let reason = null;
      if (instant(row.startTime) + DAY >= calibrationAt) reason = 'WALK_FORWARD_CALIBRATION_LABEL_INSIDE_RESULT_LAG';
      else if (!model) reason = 'WALK_FORWARD_BASE_MODEL_UNAVAILABLE';
      else if (!halfTimeModel) reason = 'WALK_FORWARD_HALF_TIME_MODEL_UNAVAILABLE';
      else if (row.halfTime?.verified !== true) reason = row.halfTimeMissingReason;
      else try {
        const fullTime = deps.predictFullTime(model, row); deps.predictHalfTime(fullTime, halfTimeModel, row);
        eligibleCalibration.push({ row, fullTime });
      } catch (error) { reason = errorCode(error); }
      calibrationLedger.push({ gameId: `soccer:${league}:${row.eventId}`, kickoff: row.startTime, status: reason ? 'EXCLUDED' : 'USED', ...(reason ? { reason } : {}) });
    }
    const totals = { games: eligibleCalibration.length, homeGoals: 0, awayGoals: 0, homeHalfGoals: 0, awayHalfGoals: 0, predictedHomeGoals: 0, predictedAwayGoals: 0 };
    for (const { row, fullTime } of eligibleCalibration) {
      totals.homeGoals += row.homeGoals; totals.awayGoals += row.awayGoals; totals.homeHalfGoals += row.halfTime.home; totals.awayHalfGoals += row.halfTime.away;
      totals.predictedHomeGoals += fullTime.homeRate; totals.predictedAwayGoals += fullTime.awayRate;
    }
    // Exactly the existing unweighted marginal rate MLE / conditional share MLE.
    // No test scores, shrinkage, tuning, clipping or replacement rho enters fit.
    const parameters = totals.games && totals.homeGoals > 0 && totals.awayGoals > 0 ? {
      fullTimeRateScales: { home: totals.homeGoals / totals.predictedHomeGoals, away: totals.awayGoals / totals.predictedAwayGoals },
      halfTimeGoalShares: { home: totals.homeHalfGoals / totals.homeGoals, away: totals.awayHalfGoals / totals.awayGoals }, rho: model.rho } : null;
    const ledger = [];
    for (const row of testPopulation) {
      const unavailable = reason => Object.fromEntries(['FT', 'HT'].map(period => [period, { status: 'FAILED', reason }]));
      let before = unavailable('WALK_FORWARD_BASE_MODEL_UNAVAILABLE'), after = unavailable('WALK_FORWARD_CALIBRATION_PARAMETERS_UNAVAILABLE');
      if (model) try {
        const original = deps.predictFullTime(model, row); before = evaluateArm(row, original, halfTimeModel, deps);
        if (parameters) try {
          const calibrated = scoreDistribution(original.homeRate * parameters.fullTimeRateScales.home,
            original.awayRate * parameters.fullTimeRateScales.away, original.rho, original.tolerance);
          after = evaluateArm(row, calibrated, { ...halfTimeModel, shares: parameters.halfTimeGoalShares }, deps);
        } catch (error) { after = unavailable(errorCode(error)); }
      } catch (error) { before = unavailable(errorCode(error)); after = unavailable(errorCode(error)); }
      // Encode infinities explicitly in JSON; no score epsilon or hidden removal.
      for (const arm of [before, after]) for (const period of ['FT', 'HT']) if (arm[period].metrics)
        arm[period].metricStates = Object.fromEntries(names.map(key => [key, encode(arm[period].metrics[key]).state]));
      ledger.push({ gameId: `soccer:${league}:${row.eventId}`, kickoff: row.startTime,
        resultSourceHashes: [row.source.contentHash, ...(row.halfTime ? [row.halfTime.source.contentHash] : [])], before, after });
    }
    const periods = reportPeriods(ledger);
    for (const row of ledger) for (const arm of [row.before, row.after]) for (const period of ['FT', 'HT']) if (arm[period].metrics)
      for (const key of names) if (!Number.isFinite(arm[period].metrics[key])) arm[period].metrics[key] = null;
    const inWindow = (row, from, through) => Number.isFinite(instant(row.startTime)) && instant(row.startTime) >= from && instant(row.startTime) < through;
    const sourceExcluded = { training: population.excluded.filter(row => inWindow(row, -Infinity, baseAt)),
      calibration: population.excluded.filter(row => inWindow(row, baseAt, calibrationAt)), test: population.excluded.filter(row => inWindow(row, calibrationAt, testAt)) };
    results.push({ ...fold, status: 'RESEARCH_ONLY', fitStatus: fitFailures.length ? 'PARTIAL_BASE_FIT' : parameters ? 'DIAGNOSTIC_AVAILABLE' : 'CALIBRATION_FIT_UNAVAILABLE',
      training: { acceptedFullTimeGames: training.length, gameIds: training.map(row => `soccer:${league}:${row.eventId}`),
        resultLagBoundaryExcludedGameIds: population.rows.filter(row => instant(row.startTime) < baseAt && instant(row.startTime) + DAY >= baseAt).map(row => `soccer:${league}:${row.eventId}`),
        fullTime: modelSummary(model), halfTime: modelSummary(halfTimeModel) },
      calibration: { populationGames: calibrationPopulation.length, usedGames: eligibleCalibration.length,
        excludedGames: calibrationPopulation.length - eligibleCalibration.length, excludedReasons: reasonCounts(calibrationLedger), totals, parameters,
        parameterHash: parameters ? soccerCalibrationHash(parameters) : null, ledger: calibrationLedger },
      test: { populationGames: testPopulation.length, periods, ledger }, sourceExcluded, fitFailures, ...restrictions });
  }
  return seal({ version: SOCCER_CALIBRATION_WALK_FORWARD_VERSION, type: 'OFFLINE_CALIBRATION_WALK_FORWARD_DIAGNOSTICS', league, generatedAt,
    status: 'RESEARCH_ONLY', method: SOCCER_CALIBRATION_METHOD, hyperparameters,
    protocol: { splitUnit: 'WHOLE_REAL_GAME_BY_UTC_KICKOFF', resultLagHours: 24, baseRefitPolicy: 'PAST_LABELS_ONLY_THEN_FIXED_THROUGH_CALIBRATION_AND_TEST',
      calibrationPolicy: 'EXISTING_RATE_MLE_AND_HT_SHARE_METHOD_NO_TEST_LABELS', testWeighting: 'ONE_WEIGHT_PER_REAL_GAME_PER_PERIOD_AND_FOLD',
      pairing: 'INTERSECTION_REPORTED_WITH_ALL_ARM_FAILURES_AND_FULL_SOURCE_DENOMINATORS',
      distributionPolicy: 'EXISTING_SCORE_AND_HT_FUNCTIONS_UNCHANGED_RETAINED_MASS_AND_OMITTED_TAIL_REPORTED_NO_EXTRA_RENORMALIZATION',
      hyperparameterProvenance: 'REUSED_EXISTING_BASELINE_SELECTION_PREVIOUSLY_INSPECTED_2024_RESULTS_NOT_PAST_PREREGISTRATION',
      interpretation: 'CHRONOLOGICAL_RETROSPECTIVE_DIAGNOSTICS_NOT_NEW_UNTOUCHED_OOS_OR_FORMAL_ACCEPTANCE' },
    coverage: population.coverage, sourceExcludedWithoutKickoff: population.excluded.filter(row => row.startTime == null), folds: results,
    limitations: ['Historical source responses were collected after these matches; label chronology is not historical availability or durable model freeze proof.',
      'Existing hyperparameters used 2024 for selection and 2025 was previously inspected; neither window is a new untouched final test.',
      'Unseen teams, absent HT labels, invalid calibrated dependence and fit failures retain their denominators; common-cohort comparisons do not prove improvement for omitted games.',
      'No use of the new 18-game prospective UCL cohort, market returns, candidate authorization or formal W/R/S.'], ...restrictions });
}
