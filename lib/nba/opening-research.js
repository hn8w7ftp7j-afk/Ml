import { createHash } from 'node:crypto';
import { validateOpeningHistory } from './opening-core.js';
import { auditOpeningResearchArchive } from './opening-history-evidence.js';

// This module is deliberately not imported by the production model. A research
// comparison cannot change acceptance flags, market scores, settlement or rebate.
export const OPENING_RESEARCH_VERSION = 'nba-opening-totals-research-v2';
export const OPENING_RESEARCH_BASELINE_VERSION = 'canonical_prior20_phase_independent_v1';
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const OPENING_RESEARCH_PROTOCOL = freeze({
  version: OPENING_RESEARCH_VERSION, developmentYear: 2021,
  viewedRegressionYears: [2023, 2024, 2025, 2026], independentHoldoutYear: 2022,
  selection: 'per_target_common_cohort_brier_then_logloss_then_early_mae',
  minimumSamples: 1000, minimumEarlySamples: 100, minimumProbabilitySamples: 1000,
  minimumFitSamples: 30, minimumResidualSamples: 50, trainingSeasons: 3,
  residualHalfLifeDays: 365, earlyPriorGames: 10, leaguePriorGames: 120,
  requiredSourceYears: [2018, 2019, 2020, 2021, 2022],
  probabilityBaseline: 'canonical_prior20_all_phase_previous_3_closed_seasons_no_candidate_fit_requirement',
  revision: 'v1_comparator_bug_corrected_before_any_real_2022_prediction_metrics; candidates_and_selection_unchanged',
  candidateDefinitions: {
    fullTotal: [
      { name: 'legacy_linear', priorWeight: 20, ridgePenalty: 1000, centered: false, phaseAware: false },
      { name: 'league_centered', priorWeight: 10, ridgePenalty: 1000, centered: true, phaseAware: false },
      { name: 'phase_league_centered', priorWeight: 20, ridgePenalty: 1000, centered: true, phaseAware: true },
    ],
    halfTotal: [
      { name: 'legacy_linear', priorWeight: 20, ridgePenalty: 1000, centered: false, phaseAware: false },
      { name: 'league_centered', priorWeight: 10, ridgePenalty: 1000, centered: true, phaseAware: false },
      { name: 'phase_league_centered', priorWeight: 20, ridgePenalty: 1000, centered: true, phaseAware: true },
    ],
  },
});
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const OPENING_RESEARCH_PROTOCOL_HASH = hash(OPENING_RESEARCH_PROTOCOL);
// Frozen before observing any 2022 candidate prediction metrics. Changing this
// manifest requires a new research version/protocol review, not a silent retune.
export const OPENING_RESEARCH_EXPECTED_PROTOCOL_HASH = 'e05fedb0d480e057d89df085918ba9894c8f2d579c74c52e238a9fabed7a57a4';
if (OPENING_RESEARCH_PROTOCOL_HASH !== OPENING_RESEARCH_EXPECTED_PROTOCOL_HASH) throw Error('NBA_OPENING_RESEARCH_PROTOCOL_DRIFT');
const order = (a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId);
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const total = (row, target) => target === 'fullTotal' ? row.homeScore + row.awayScore : row.homeHalf + row.awayHalf;
const early = row => row.currentGames.home < 10 && row.currentGames.away < 10;

export function openingResearchCandidate(target, definition) {
  if (!['fullTotal', 'halfTotal'].includes(target)
    || !OPENING_RESEARCH_PROTOCOL.candidateDefinitions[target].some(value => JSON.stringify(value) === JSON.stringify(definition))) {
    throw Error('NBA_OPENING_RESEARCH_CANDIDATE_UNREGISTERED');
  }
  const specification = { protocol: OPENING_RESEARCH_PROTOCOL, target, definition };
  return freeze({ ...definition, target, modelVersion: OPENING_RESEARCH_VERSION,
    candidateId: `${target}:${definition.name}:${hash(specification)}` });
}

function validatedHistory(history) {
  if (!validateOpeningHistory(history) || history.some(row => row.league != null && row.league !== 'NBA')) throw Error('NBA_OPENING_RESEARCH_HISTORY_INVALID');
  const rows = [...history].sort(order), bounds = new Map();
  for (const row of rows) {
    const previous = bounds.get(row.year);
    bounds.set(row.year, { first: previous?.first || row.date, last: row.date });
  }
  const years = [...bounds.keys()].sort((a, b) => a - b);
  if (years.some((year, index) => index && bounds.get(years[index - 1]).last >= bounds.get(year).first)) throw Error('NBA_OPENING_RESEARCH_SEASON_OVERLAP');
  return rows;
}

// Aggregate each past game once. Every game on a date is projected before that
// date's results update the league/team state. This is also practical for the
// expanded archive, without repeatedly scanning it for every candidate/game.
function buildInputs(rows) {
  const years = new Map(), frames = new Map();
  const season = year => {
    if (!years.has(year)) years.set(year, { games: 0, fullTotal: 0, halfTotal: 0, teams: new Map(), through: null });
    return years.get(year);
  };
  const team = (state, id) => state?.teams.get(id) || { games: 0, fullFor: 0, fullAgainst: 0, halfFor: 0, halfAgainst: 0 };
  for (let start = 0; start < rows.length;) {
    let end = start + 1; while (end < rows.length && rows[end].date === rows[start].date) end++;
    for (const row of rows.slice(start, end)) {
      const old = years.get(row.year - 1), current = season(row.year);
      const homeOld = team(old, row.homeId), awayOld = team(old, row.awayId);
      if (!old?.games || homeOld.games < 20 || awayOld.games < 20) continue;
      const home = team(current, row.homeId), away = team(current, row.awayId), inputs = {};
      for (const priorWeight of [10, 20]) {
        inputs[priorWeight] = {};
        for (const target of ['fullTotal', 'halfTotal']) {
          const prefix = target === 'fullTotal' ? 'full' : 'half';
          const rate = (past, fresh, key) => (priorWeight * past[key] / past.games + fresh[key]) / (priorWeight + fresh.games);
          const baseline = (rate(homeOld, home, `${prefix}For`) + rate(awayOld, away, `${prefix}Against`)
            + rate(awayOld, away, `${prefix}For`) + rate(homeOld, home, `${prefix}Against`)) / 2;
          const previousLeague = old[target] / old.games;
          const leagueEstimate = (OPENING_RESEARCH_PROTOCOL.leaguePriorGames * previousLeague + current[target]) / (OPENING_RESEARCH_PROTOCOL.leaguePriorGames + current.games);
          inputs[priorWeight][target] = { baseline, previousLeague, leagueEstimate,
            priorShare: (priorWeight / (priorWeight + home.games) + priorWeight / (priorWeight + away.games)) / 2,
            currentGames: { home: home.games, away: away.games }, featureThrough: [old.through, current.through].filter(Boolean).sort().at(-1) };
        }
      }
      frames.set(row.gameId, inputs);
    }
    for (const row of rows.slice(start, end)) {
      const state = season(row.year); state.games++; state.fullTotal += total(row, 'fullTotal'); state.halfTotal += total(row, 'halfTotal'); state.through = row.date;
      for (const side of ['home', 'away']) {
        const other = side === 'home' ? 'away' : 'home', value = { ...team(state, row[`${side}Id`]) };
        value.games++; value.fullFor += row[`${side}Score`]; value.fullAgainst += row[`${other}Score`];
        value.halfFor += row[`${side}Half`]; value.halfAgainst += row[`${other}Half`]; state.teams.set(row[`${side}Id`], value);
      }
    }
    start = end;
  }
  return frames;
}

function fit(features, x, penalty) {
  const xbar = average(features.map(row => row.x)), ybar = average(features.map(row => row.y));
  const slope = features.reduce((sum, row) => sum + (row.x - xbar) * (row.y - ybar), 0)
    / (penalty + features.reduce((sum, row) => sum + (row.x - xbar) ** 2, 0));
  const intercept = ybar - slope * xbar;
  return { value: intercept + slope * x, slope, intercept };
}

function buildObservations(rows, candidate, frames) {
  const registered = openingResearchCandidate(candidate?.target,
    OPENING_RESEARCH_PROTOCOL.candidateDefinitions[candidate?.target]?.find(value => value.name === candidate?.name));
  if (JSON.stringify(registered) !== JSON.stringify(candidate)) throw Error('NBA_OPENING_RESEARCH_CANDIDATE_MISMATCH');
  const features = [], observations = [], fits = new Map();
  for (const row of rows) {
    const input = frames.get(row.gameId)?.[candidate.priorWeight]?.[candidate.target];
    const reference = frames.get(row.gameId)?.[20]?.[candidate.target];
    if (!input || !reference) continue;
    const phaseCorrection = candidate.phaseAware ? input.priorShare * (input.leagueEstimate - input.previousLeague) : 0;
    const center = candidate.centered ? input.leagueEstimate : 0;
    const x = input.baseline + phaseCorrection - center;
    const actual = total(row, candidate.target);
    if (!fits.has(row.year)) {
      const prior = features.filter(value => value.date < row.date && value.year < row.year && value.year >= row.year - OPENING_RESEARCH_PROTOCOL.trainingSeasons);
      fits.set(row.year, prior.length >= OPENING_RESEARCH_PROTOCOL.minimumFitSamples ? {
        ...fit(prior, 0, candidate.ridgePenalty), through: prior.at(-1).date, samples: prior.length,
        years: [...new Set(prior.map(value => value.year))] } : null);
    }
    const fitted = fits.get(row.year);
    if (fitted) {
      const prediction = fitted.intercept + fitted.slope * x + center;
      if (!Number.isFinite(prediction)) throw Error('NBA_OPENING_RESEARCH_NONFINITE_PREDICTION');
      observations.push({ gameId: row.gameId, date: row.date, year: row.year, target: candidate.target,
        modelVersion: OPENING_RESEARCH_VERSION, candidateId: candidate.candidateId,
        prediction, actual, error: actual - prediction, baseline: reference.baseline,
        currentGames: input.currentGames, phase: early(input) ? 'early' : 'mature',
        featureThrough: input.featureThrough, fitThrough: fitted.through,
        fitSamples: fitted.samples, fitSeasonYears: fitted.years,
        feature: { baseline: input.baseline, center, phaseCorrection, leagueEstimate: input.leagueEstimate,
          previousLeague: input.previousLeague, priorShare: input.priorShare },
        fit: { slope: fitted.slope, intercept: fitted.intercept } });
    }
    features.push({ date: row.date, year: row.year, x, y: actual - center });
  }
  return { candidate, observations, sourceGames: rows.length };
}

export function buildOpeningResearchObservations(history, candidate) {
  const rows = validatedHistory(history);
  return buildObservations(rows, candidate, buildInputs(rows));
}

function buildBaselineObservations(rows, frames, target) {
  if (!['fullTotal', 'halfTotal'].includes(target)) throw Error('NBA_OPENING_RESEARCH_BASELINE_TARGET_INVALID');
  return rows.flatMap(row => {
    const input = frames.get(row.gameId)?.[20]?.[target];
    return input ? [{ gameId: row.gameId, date: row.date, year: row.year, target,
      baselineVersion: OPENING_RESEARCH_BASELINE_VERSION, baseline: input.baseline,
      featureThrough: input.featureThrough, actual: total(row, target) }] : [];
  });
}

export function buildOpeningResearchBaselineObservations(history, target) {
  const rows = validatedHistory(history);
  return buildBaselineObservations(rows, buildInputs(rows), target);
}

export function openingResearchProbability(row, observations, candidate, baselineObservations) {
  if (row?.candidateId !== candidate?.candidateId || row?.target !== candidate.target
    || row?.modelVersion !== OPENING_RESEARCH_VERSION || !(row.fitThrough < row.date) || !(row.featureThrough < row.date)
    || ![row.prediction, row.actual, row.baseline].every(Number.isFinite)) {
    throw Error('NBA_OPENING_RESEARCH_PROBABILITY_SCOPE_INVALID');
  }
  const previous = observations.filter(value => value.date < row.date && value.year < row.year
    && value.year >= row.year - OPENING_RESEARCH_PROTOCOL.trainingSeasons
    && value.candidateId === candidate.candidateId && value.modelVersion === OPENING_RESEARCH_VERSION
    && value.target === candidate.target && value.fitThrough < value.date && value.featureThrough < value.date
    && [value.error, value.actual, value.baseline].every(Number.isFinite)
    && (!candidate.phaseAware || value.phase === row.phase));
  // The benchmark never inherits a candidate's phase filter, fit availability,
  // prior weight or model-version residuals. Every candidate is compared with
  // the exact same independently built prior20 reference distribution.
  const previousBaseline = (baselineObservations || []).filter(value => value.date < row.date && value.year < row.year
    && value.year >= row.year - OPENING_RESEARCH_PROTOCOL.trainingSeasons
    && value.target === candidate.target && value.baselineVersion === OPENING_RESEARCH_BASELINE_VERSION
    && value.featureThrough < value.date && [value.actual, value.baseline].every(Number.isFinite));
  if ([previous.length, previousBaseline.length].some(count => count < OPENING_RESEARCH_PROTOCOL.minimumResidualSamples)) return null;
  const threshold = Math.floor(row.baseline) + .5;
  let sum = 0, predicted = 0, baselineSum = 0, baseline = 0;
  for (const value of previous) {
    const weight = 2 ** (-(Date.parse(row.date) - Date.parse(value.date)) / 86400000 / OPENING_RESEARCH_PROTOCOL.residualHalfLifeDays);
    sum += weight;
    predicted += weight * Number(Math.round(row.prediction + value.error) > threshold);
  }
  for (const value of previousBaseline) {
    const weight = 2 ** (-(Date.parse(row.date) - Date.parse(value.date)) / 86400000 / OPENING_RESEARCH_PROTOCOL.residualHalfLifeDays);
    baselineSum += weight;
    baseline += weight * Number(Math.round(row.baseline + value.actual - value.baseline) > threshold);
  }
  if (![sum, baselineSum].every(value => value > 0 && Number.isFinite(value))) return null;
  return { gameId: row.gameId, date: row.date, p: predicted / sum, baselineP: baseline / baselineSum,
    y: Number(row.actual > threshold), threshold, candidateId: candidate.candidateId,
    calibrationSamples: previous.length, calibrationThrough: previous.at(-1).date,
    calibrationCandidateId: candidate.candidateId, calibrationBasis: candidate.phaseAware ? 'prior_closed_seasons_same_phase' : 'prior_closed_seasons',
    baselineCalibrationVersion: OPENING_RESEARCH_BASELINE_VERSION,
    baselineCalibrationSamples: previousBaseline.length, baselineCalibrationThrough: previousBaseline.at(-1).date,
    calibrationFitWindows: [...new Set(previous.map(value => value.fitSeasonYears.join(',')))] };
}

function metrics(rows, probabilities) {
  const first = rows.filter(early);
  const logLoss = field => {
    const values = probabilities.map(row => row.y ? -Math.log(row[field]) : -Math.log1p(-row[field]));
    return values.length && values.every(Number.isFinite) ? average(values) : null;
  };
  return { samples: rows.length, earlySamples: first.length, probabilitySamples: probabilities.length,
    modelMAE: average(rows.map(row => Math.abs(row.error))), baselineMAE: average(rows.map(row => Math.abs(row.actual - row.baseline))),
    earlyModelMAE: average(first.map(row => Math.abs(row.error))), earlyBaselineMAE: average(first.map(row => Math.abs(row.actual - row.baseline))),
    modelBias: average(rows.map(row => -row.error)), earlyModelBias: average(first.map(row => -row.error)),
    modelBrier: average(probabilities.map(row => (row.p - row.y) ** 2)), baselineBrier: average(probabilities.map(row => (row.baselineP - row.y) ** 2)),
    modelLogLoss: logLoss('p'), baselineLogLoss: logLoss('baselineP'),
    meanProbability: average(probabilities.map(row => row.p)), observedRate: average(probabilities.map(row => row.y)) };
}

export function openingResearchReadiness(value) {
  const minimums = { samples: OPENING_RESEARCH_PROTOCOL.minimumSamples,
    earlySamples: OPENING_RESEARCH_PROTOCOL.minimumEarlySamples,
    probabilitySamples: OPENING_RESEARCH_PROTOCOL.minimumProbabilitySamples };
  const reasons = Object.entries(minimums).filter(([key, minimum]) => !Number.isInteger(value?.[key]) || value[key] < minimum).map(([key]) => `${key}_insufficient`);
  for (const [model, baseline] of [['modelMAE', 'baselineMAE'], ['earlyModelMAE', 'earlyBaselineMAE'], ['modelBrier', 'baselineBrier'], ['modelLogLoss', 'baselineLogLoss']]) {
    if (![value?.[model], value?.[baseline]].every(number => Number.isFinite(number) && number >= 0)) reasons.push(`${model}_unavailable`);
    else if (value[model] > value[baseline]) reasons.push(`${model}_worse_than_baseline`);
  }
  return { readyForIndependentValidation: reasons.length === 0, reasons };
}

export function evaluateOpeningResearch(history, { archiveEvidence = null } = {}) {
  const protocolHash = hash(OPENING_RESEARCH_PROTOCOL), targets = {};
  const historyRows = validatedHistory(history), inputs = buildInputs(historyRows);
  const developmentHistory = historyRows.filter(row => row.year <= OPENING_RESEARCH_PROTOCOL.developmentYear);
  for (const target of ['fullTotal', 'halfTotal']) {
    const baselineObservations = buildBaselineObservations(historyRows, inputs, target);
    const candidates = OPENING_RESEARCH_PROTOCOL.candidateDefinitions[target].map(definition => {
      const candidate = openingResearchCandidate(target, definition);
      const built = buildObservations(developmentHistory, candidate, inputs);
      const rows = built.observations.filter(row => row.year === OPENING_RESEARCH_PROTOCOL.developmentYear);
      return { candidate, built, rows, probabilities: rows.flatMap(row => openingResearchProbability(row, built.observations, candidate, baselineObservations) || []) };
    });
    // Compare candidates on exactly the same events. A candidate with no prior
    // probability cohort must never win an incomparable/empty Brier comparison.
    const common = key => candidates.reduce((ids, candidate) => {
      const next = new Set(candidate[key].map(row => row.gameId));
      return ids == null ? next : new Set([...ids].filter(id => next.has(id)));
    }, null);
    const pointIds = common('rows'), probabilityIds = common('probabilities');
    const summaries = candidates.map(({ candidate, built, rows, probabilities }) => {
      const development = metrics(rows.filter(row => pointIds.has(row.gameId)), probabilities.filter(row => probabilityIds.has(row.gameId)));
      return { candidate, development, readiness: openingResearchReadiness(development) };
    });
    const eligible = summaries.filter(row => row.readiness.readyForIndependentValidation).sort((a, b) =>
      a.development.modelBrier - b.development.modelBrier || a.development.modelLogLoss - b.development.modelLogLoss
      || a.development.earlyModelMAE - b.development.earlyModelMAE || a.candidate.candidateId.localeCompare(b.candidate.candidateId));
    const selected = eligible[0];
    // Do not even generate alternative holdout forecasts. Only a candidate
    // selected from the development cohort may reach holdout/regression scoring.
    const selectedBuilt = selected ? buildObservations(historyRows, selected.candidate, inputs) : null;
    const holdoutRows = selectedBuilt?.observations
      .filter(row => row.year === OPENING_RESEARCH_PROTOCOL.independentHoldoutYear) || [];
    const holdoutMetrics = selectedBuilt ? metrics(holdoutRows, holdoutRows.flatMap(row => openingResearchProbability(row, selectedBuilt.observations, selected.candidate, baselineObservations) || [])) : null;
    const holdoutReadiness = openingResearchReadiness(holdoutMetrics);
    const viewedRegression = Object.fromEntries(OPENING_RESEARCH_PROTOCOL.viewedRegressionYears.map(year => {
      const rows = selectedBuilt?.observations.filter(row => row.year === year) || [];
      return [year, { role: 'VIEWED_REGRESSION_ONLY_NOT_NEW_OOS', evaluatedCandidateId: selected?.candidate.candidateId || null,
        metrics: selectedBuilt ? metrics(rows, rows.flatMap(row => openingResearchProbability(row, selectedBuilt.observations, selected.candidate, baselineObservations) || [])) : null }];
    }));
    targets[target] = { developmentYear: OPENING_RESEARCH_PROTOCOL.developmentYear,
      commonPointSamples: pointIds.size, commonProbabilitySamples: probabilityIds.size,
      selectedForIndependentValidation: selected?.candidate.candidateId || null, candidates: summaries, viewedRegression,
      independentHoldout: { year: OPENING_RESEARCH_PROTOCOL.independentHoldoutYear,
        role: 'NEW_EXTERNAL_RETROSPECTIVE_HOLDOUT_NOT_CONTEMPORANEOUS_PIT',
        evaluationStatus: selected ? 'EVALUATED_FROZEN_DEVELOPMENT_SELECTION' : 'NOT_EVALUATED_DEVELOPMENT_FAILED',
        evaluatedCandidateId: selected?.candidate.candidateId || null, metrics: holdoutMetrics,
        passed: !!selected && holdoutReadiness.readyForIndependentValidation,
        reasons: selected ? holdoutReadiness.reasons : ['DEVELOPMENT_MUST_PASS_BEFORE_HOLDOUT_EVALUATION'] } };
  }
  const sourceAudit = auditOpeningResearchArchive(history, archiveEvidence,
    { requiredYears: OPENING_RESEARCH_PROTOCOL.requiredSourceYears });
  const developmentReady = Object.values(targets).every(target => target.selectedForIndependentValidation);
  const holdoutReady = Object.values(targets).every(target => target.independentHoldout.passed);
  const sourceReady = sourceAudit.every(value => value.verified);
  const reasons = [
    ...(!developmentReady ? ['DEVELOPMENT_VALIDATION_INCOMPLETE_OR_FAILED'] : []),
    ...(!holdoutReady ? ['INDEPENDENT_HOLDOUT_INCOMPLETE_OR_FAILED'] : []),
    ...(!sourceReady ? ['COMPLETE_YEAR_SOURCE_AUDIT_REQUIRED'] : []),
    'PRODUCTION_PROMOTION_REQUIRES_EXPLICIT_REVIEW_AND_NO_REGRESSION',
  ];
  return { version: OPENING_RESEARCH_VERSION, league: 'NBA', scope: 'regular_season_full_and_half_totals_research',
    protocol: OPENING_RESEARCH_PROTOCOL, protocolHash, historyHash: hash(history), sourceGames: history.length, targets,
    sourceAudit,
    promotion: { status: developmentReady && holdoutReady && sourceReady ? 'REQUIRES_REVIEW' : 'BLOCKED', executable: false, promotionEligible: false,
      reasons,
      viewed2026MayAuthorizePromotion: false },
    limitations: ['Reference thresholds are not recovered market quotes or betting win rates.',
      'Candidate/protocol-matched prequential errors retain distinct historical fit windows; coefficient identity is not claimed.',
      'Historical score archives do not prove a contemporaneous point-in-time source snapshot.'] };
}
