import { soccerModelFamilyHash } from './model-family-uncertainty.js';

export const SOCCER_MODEL_FAMILY_DIAGNOSTICS_VERSION = 'SOCCER-MODEL-FAMILY-APPLICABILITY-DIAGNOSTICS-v1';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const metric = value => finite(value) ? { value, state: 'FINITE' }
  : { value: null, state: value === Infinity ? 'POSITIVE_INFINITY' : value === -Infinity ? 'NEGATIVE_INFINITY' : 'UNAVAILABLE' };
const restrictions = { accepted: false, formalEligible: false, calibrationEligible: false, promotionEligible: false,
  executable: false, coverageAssumptionsVerified: false, untouchedTestVerified: false,
  modelMisspecificationBound: null, formalModelError: null, W: null, R: null, S: null };
const seal = value => ({ ...value, contentHash: soccerModelFamilyHash(value) });

function moments(rows, side) {
  const goals = rows.reduce((sum, row) => sum + row.actualScore[side], 0);
  const exposure = rows.reduce((sum, row) => sum + row[`${side}Rate`], 0);
  const residuals = rows.map(row => row.actualScore[side] - row[`${side}Rate`]);
  const standardized = rows.map((row, index) => residuals[index] / Math.sqrt(row[`${side}Rate`]));
  const pearson = standardized.reduce((sum, value) => sum + value * value, 0);
  return { realGames: rows.length, goals, exposure, meanResidual: metric(rows.length ? (goals - exposure) / rows.length : NaN),
    meanStandardizedResidual: metric(rows.length ? standardized.reduce((sum, value) => sum + value, 0) / rows.length : NaN),
    pearsonSum: metric(rows.length ? pearson : NaN), pearsonPerGame: metric(rows.length ? pearson / rows.length : NaN) };
}

function timeDiagnostics(rows, side) {
  // Games with identical kickoffs do not have an observed ordering. Keep ties
  // together instead of making the ID sort order look like temporal evidence.
  const groups = new Map();
  for (const row of rows) {
    const key = instant(row.kickoff);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const cohorts = [...groups].sort(([left], [right]) => left - right).map(([at, values]) => ({ at, rows: values,
    mean: values.reduce((sum, row) => sum + (row.actualScore[side] - row[`${side}Rate`]) / Math.sqrt(row[`${side}Rate`]), 0) / values.length }));
  const left = cohorts.slice(0, -1).map(row => row.mean), right = cohorts.slice(1).map(row => row.mean);
  let lag = NaN;
  if (left.length >= 2 && left.every(finite) && right.every(finite)) {
    const a = left.reduce((sum, value) => sum + value, 0) / left.length;
    const b = right.reduce((sum, value) => sum + value, 0) / right.length;
    const cross = left.reduce((sum, value, index) => sum + (value - a) * (right[index] - b), 0);
    const av = left.reduce((sum, value) => sum + (value - a) ** 2, 0);
    const bv = right.reduce((sum, value) => sum + (value - b) ** 2, 0);
    if (av > 0 && bv > 0) lag = cross / Math.sqrt(av * bv);
  }
  const split = Math.floor(cohorts.length / 2);
  const early = moments(cohorts.slice(0, split).flatMap(row => row.rows), side);
  const late = moments(cohorts.slice(split).flatMap(row => row.rows), side);
  return { distinctKickoffCohorts: cohorts.length, lag1Pairs: left.length, lag1Correlation: metric(lag),
    lagUnit: 'ADJACENT_DISTINCT_KICKOFF_COHORT_MEAN_STANDARDIZED_RESIDUAL', early, late,
    residualMeanChange: metric(early.realGames && late.realGames ? late.meanResidual.value - early.meanResidual.value : NaN),
    splitPolicy: 'CHRONOLOGICAL_HALVES_OF_DISTINCT_KICKOFF_COHORTS_WITH_TIES_KEPT_TOGETHER' };
}

function cohortDiagnostics(rows) {
  return { realGames: rows.length, firstKickoff: rows[0]?.kickoff || null, lastKickoff: rows.at(-1)?.kickoff || null,
    sides: Object.fromEntries(['home', 'away'].map(side => [side, { ...moments(rows, side), time: timeDiagnostics(rows, side) }])),
    residualReference: 'ORIGINAL_FROZEN_BASELINE_RATES_WITHOUT_FITTED_MULTIPLIERS',
    interpretation: 'DESCRIPTIVE_RESIDUAL_SIGNALS_NOT_INDEPENDENCE_OR_POISSON_APPLICABILITY_TEST_PASS' };
}

/** Pure diagnostic projection over privately source-verified observations.
 * No fitted parameter, numeric threshold, model-error margin or acceptance is
 * produced. Even a true DB freeze verifier proves timing, not untouched labels
 * or validity of the Poisson/stability/independence assumptions. */
export function diagnoseSoccerModelFamily({ observations = [], baseline, protocol, now = Date.now(),
  requestedScopeComplete = false, freezeReceipt = null, frozenArtifactHash = null } = {}, { verifyFreezeReceipt } = {}) {
  const reasons = {}, add = code => { reasons[code] = (reasons[code] || 0) + 1; };
  const dates = ['registeredAt', 'calibrationFrom', 'calibrationBefore'].map(key => instant(protocol?.[key]));
  const scopeValid = ['epl', 'ucl'].includes(baseline?.league) && ['FT', 'HT'].includes(baseline?.period)
    && sha(baseline?.modelHash) && Array.isArray(baseline.sourceHashes) && baseline.sourceHashes.length > 0
    && baseline.sourceHashes.every(sha) && finite(now) && Number.isFinite(instant(baseline.createdAt))
    && Number.isFinite(instant(baseline.trainedThrough)) && instant(baseline.trainedThrough) < instant(baseline.createdAt);
  const protocolValid = scopeValid && dates.every(Number.isFinite) && dates[0] <= dates[1] && dates[1] < dates[2]
    && instant(baseline.createdAt) <= dates[1] && dates[2] <= now && finite(protocol?.alpha) && protocol.alpha > 0 && protocol.alpha < 1;
  const testFrom = instant(protocol?.testFrom), testBefore = instant(protocol?.testBefore);
  const hasTestWindow = Object.hasOwn(protocol || {}, 'testFrom') || Object.hasOwn(protocol || {}, 'testBefore');
  const testWindowValid = protocolValid && Number.isFinite(testFrom) && Number.isFinite(testBefore)
    && dates[2] <= testFrom && testFrom < testBefore;
  if (!scopeValid) add('MODEL_FAMILY_BASELINE_INVALID');
  if (!protocolValid) add('MODEL_FAMILY_DIAGNOSTIC_PROTOCOL_INVALID');
  if (hasTestWindow && !testWindowValid) add('MODEL_FAMILY_DIAGNOSTIC_TEST_WINDOW_INVALID');
  if (!Array.isArray(observations)) add('MODEL_FAMILY_DIAGNOSTIC_OBSERVATIONS_INVALID');
  const selected = new Map(), quarantined = new Set();
  let duplicateReceipts = 0;
  if (protocolValid && Array.isArray(observations)) for (const row of observations) {
    if (row?.league !== baseline.league || row?.period !== baseline.period || row?.baselineModelHash !== baseline.modelHash) {
      add('MODEL_FAMILY_OBSERVATION_OUTSIDE_SCOPE'); continue;
    }
    const kickoff = instant(row.kickoff), resultAt = instant(row.resultAvailableAt), predictedAt = instant(row.predictedAt);
    const inCalibration = kickoff >= dates[1] && kickoff < dates[2];
    const inTest = testWindowValid && kickoff >= testFrom && kickoff < testBefore;
    if (typeof row.gameId !== 'string' || !new RegExp(`^soccer:${baseline.league}:\\d{1,16}$`).test(row.gameId)
      || ![row.homeRate, row.awayRate].every(value => finite(value) && value > 0 && value <= 100)
      || !['home', 'away'].every(side => Number.isSafeInteger(row.actualScore?.[side]) && row.actualScore[side] >= 0 && row.actualScore[side] <= 100)
      || !Array.isArray(row.sourceHashes) || !row.sourceHashes.length || !row.sourceHashes.every(sha)
      || !Number.isFinite(kickoff) || !Number.isFinite(resultAt) || resultAt <= kickoff || resultAt > now
      || !Number.isFinite(predictedAt) || predictedAt < instant(baseline.createdAt) || predictedAt >= kickoff) {
      add('MODEL_FAMILY_OBSERVATION_INVALID'); continue;
    }
    if (!inCalibration && !inTest) add('MODEL_FAMILY_DIAGNOSTIC_OUTSIDE_WINDOWS');
    const identity = soccerModelFamilyHash({ kickoff: new Date(kickoff).toISOString(), homeRate: row.homeRate,
      awayRate: row.awayRate, actualScore: row.actualScore });
    const previous = selected.get(row.gameId);
    if (previous && previous.identity !== identity) quarantined.add(row.gameId);
    else if (previous) {
      duplicateReceipts++;
      if (resultAt < instant(previous.row.resultAvailableAt)
        || resultAt === instant(previous.row.resultAvailableAt) && soccerModelFamilyHash(row).localeCompare(soccerModelFamilyHash(previous.row)) < 0)
        selected.set(row.gameId, { row, identity, cohort: inCalibration ? 'calibration' : inTest ? 'test' : null });
    } else selected.set(row.gameId, { row, identity, cohort: inCalibration ? 'calibration' : inTest ? 'test' : null });
  }
  if (quarantined.size) reasons.MODEL_FAMILY_CONFLICTING_REAL_GAME = quarantined.size;
  const admitted = [...selected].filter(([key, value]) => value.cohort !== null && !quarantined.has(key)).map(([, value]) => value)
    .sort((a, b) => instant(a.row.kickoff) - instant(b.row.kickoff) || a.row.gameId.localeCompare(b.row.gameId));
  const calibration = admitted.filter(value => value.cohort === 'calibration').map(value => value.row);
  const test = admitted.filter(value => value.cohort === 'test').map(value => value.row);
  const testReceiptContext = { league: baseline?.league, period: baseline?.period, modelHash: baseline?.modelHash,
    protocolHash: soccerModelFamilyHash(protocol || null), artifactHash: frozenArtifactHash, receipt: freezeReceipt,
    calibrationBefore: protocol?.calibrationBefore, testFrom: protocol?.testFrom, testBefore: protocol?.testBefore,
    firstTestKickoff: test[0]?.kickoff || null, now };
  let pretestFreezeVerified = false;
  if (requestedScopeComplete === true && testWindowValid && test.length && sha(frozenArtifactHash)
    && typeof verifyFreezeReceipt === 'function') {
    try { pretestFreezeVerified = verifyFreezeReceipt(testReceiptContext) === true; } catch { add('MODEL_FAMILY_DIAGNOSTIC_FREEZE_CHECK_UNAVAILABLE'); }
  }
  if (test.length && !pretestFreezeVerified) add('MODEL_FAMILY_DIAGNOSTIC_PRETEST_FREEZE_UNVERIFIED');
  if (!calibration.length) add('MODEL_FAMILY_INDEPENDENT_GAMES_MISSING');
  return seal({ version: SOCCER_MODEL_FAMILY_DIAGNOSTICS_VERSION, ...restrictions,
    status: !protocolValid ? 'INVALID_SCOPE' : requestedScopeComplete !== true ? 'PARTIAL_SOURCE'
      : admitted.length ? 'DESCRIPTIVE_SIGNALS_AVAILABLE' : 'MISSING_VALID_OBSERVATIONS',
    league: baseline?.league || null, period: baseline?.period || null, modelHash: baseline?.modelHash || null,
    generatedAt: finite(now) ? new Date(now).toISOString() : null, protocolHash: soccerModelFamilyHash(protocol || null),
    requestedScopeComplete: requestedScopeComplete === true, duplicateReceipts, quarantinedGames: quarantined.size,
    calibration: cohortDiagnostics(calibration), test: { ...cohortDiagnostics(test), pretestFreezeVerified,
      evaluationMode: pretestFreezeVerified ? 'FROZEN_TEST_DIAGNOSTICS' : 'DESCRIPTIVE_REPLAY',
      windowComplete: testWindowValid && now >= testBefore },
    observationHashes: admitted.map(value => soccerModelFamilyHash(value.row)), excludedReasons: reasons,
    interpretation: 'DIAGNOSTIC_SIGNALS_ONLY_NO_PASS_THRESHOLD_FITTED_ERROR_MARGIN_OR_FORMAL_R' });
}
