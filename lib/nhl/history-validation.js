import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeNhlScheduleGame } from './data.js';
import { validateNhlIdentity } from './identity.js';
import { fitNhlModel, predictNhlDistribution, NHL_MODEL_VERSION } from './model.js';
import { normalizeNhlModelGame, auditNhlDistribution } from './model-qa.js';

export const NHL_HISTORY_VALIDATION_VERSION = 'NHL-HISTORY-COVERAGE-CHRONOLOGICAL-v1';
export const NHL_HISTORY_EMBARGO_MS = 48 * 60 * 60 * 1000;
export const nhlHistoryHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const score = value => Number.isSafeInteger(value) && value >= 0;
const phase = gameType => ({ 1: 'PRESEASON_SHADOW', 2: 'REGULAR', 3: 'PLAYOFFS' })[gameType];

export function verifyNhlHistorySource(checkpoint, expectedUrl) {
  return checkpoint?.ok === true && checkpoint.source?.provider === 'NHL' && checkpoint.source.url === expectedUrl
    && checkpoint.data != null && typeof checkpoint.data === 'object' && !Array.isArray(checkpoint.data)
    && timestamp(checkpoint.source.fetchedAt) != null && checkpoint.source.contentHash === nhlHistoryHash(checkpoint.data);
}

export function nhlPeriodReportUrl(season, start = 0, limit = 100, gameType = 2) {
  if (!Number.isSafeInteger(season) || season % 10000 !== Math.floor(season / 10000) + 1 || ![2, 3].includes(gameType)
    || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('NHL_HISTORY_PERIOD_REPORT_SCOPE_INVALID');
  const params = new URLSearchParams({ isAggregate: 'false', isGame: 'true', start: String(start), limit: String(limit),
    sort: JSON.stringify([{ property: 'gameId', direction: 'ASC' }, { property: 'teamId', direction: 'ASC' }]),
    cayenneExp: `seasonId=${season} and gameTypeId=${gameType}` });
  return `https://api.nhle.com/stats/rest/en/team/goalsbyperiod?${params}`;
}

// NHL's game-level goals-by-period report has two mutually corroborating rows
// per game. All identities and reciprocal period totals must match the already
// verified official schedule. No last-period inference or score splitting.
export function joinNhlOfficialPeriodReports(outcomes, checkpoints, { season, gameType = 2, limit = 100 } = {}) {
  const rows = new Map(); const invalid = []; const duplicate = new Set(); let expectedTotal = null;
  const ordered = [...checkpoints].sort((a, b) => a.start - b.start); const starts = new Set();
  for (let index = 0; index < ordered.length; index += 1) {
    const checkpoint = ordered[index];
    let requestedLimit = null;
    try { requestedLimit = Number(new URL(checkpoint.source.url).searchParams.get('limit')); } catch { /* Invalid source below. */ }
    const expectedUrl = requestedLimit && requestedLimit <= 1000 ? nhlPeriodReportUrl(season, checkpoint.start, requestedLimit, gameType) : null;
    if (starts.has(checkpoint.start) || !expectedUrl || !verifyNhlHistorySource(checkpoint, expectedUrl) || !Array.isArray(checkpoint.data?.data)
      || !Number.isSafeInteger(checkpoint.data.total) || checkpoint.data.total < 0
      // Actual NHL responses cap reports at 100 even when the request asks
      // for more. Retained older requests remain usable, but missing offsets
      // stay visible and can never satisfy complete coverage by row counts.
      || checkpoint.data.data.length !== Math.min(requestedLimit, 100, Math.max(0, checkpoint.data.total - checkpoint.start))
      || (expectedTotal != null && expectedTotal !== checkpoint.data.total)) { invalid.push({ code: 'NHL_HISTORY_PERIOD_PAGE_INVALID', start: checkpoint.start }); continue; }
    starts.add(checkpoint.start);
    expectedTotal = checkpoint.data.total;
    for (const row of checkpoint.data.data) {
      const key = `${row.gameId}:${row.teamId}`;
      if (rows.has(key) || duplicate.has(key)) { invalid.push({ code: 'NHL_HISTORY_PERIOD_DUPLICATE_ROW', key }); duplicate.add(key); rows.delete(key); continue; }
      rows.set(key, { row, source: checkpoint.source });
    }
  }
  const games = []; const missingGameIds = [];
  for (const outcome of outcomes.filter(row => row.season === season && row.gameType === gameType)) {
    const away = rows.get(`${outcome.gameId}:${outcome.awayTeamId}`); const home = rows.get(`${outcome.gameId}:${outcome.homeTeamId}`);
    if (!away || !home) { missingGameIds.push(outcome.gameId); continue; }
    const fields = [1, 2, 3].flatMap(period => [`period${period}GoalsFor`, `period${period}GoalsAgainst`]);
    const validRow = (value, side) => value.gameId === Number(outcome.gameId) && value.gamesPlayed === 1
      && value.teamId === outcome[`${side}TeamId`] && value.homeRoad === (side === 'away' ? 'R' : 'H')
      && value.opponentTeamAbbrev === outcome[`${side === 'away' ? 'home' : 'away'}Abbrev`]
      && value.gameDate === outcome.officialDate && fields.every(field => score(value[field]));
    const reciprocal = fields.every(field => away.row[field] === home.row[field.endsWith('For') ? field.replace(/For$/, 'Against') : field.replace(/Against$/, 'For')]);
    const periods = [1, 2, 3].map(period => ({ period, awayGoals: away.row[`period${period}GoalsFor`], homeGoals: home.row[`period${period}GoalsFor`] }));
    if (!validRow(away.row, 'away') || !validRow(home.row, 'home') || !reciprocal
      || ['away', 'home'].some(side => periods.reduce((sum, period) => sum + period[`${side}Goals`], 0) !== outcome.regulation[`${side}Goals`])) {
      invalid.push({ code: 'NHL_HISTORY_PERIOD_IDENTITY_OR_TOTAL_CONFLICT', gameId: outcome.gameId }); continue;
    }
    const game = { ...outcome, periods, periodCoverageVerified: true,
      // Source URL/hash remain the exact schedule response. The additional
      // official per-period evidence is retained in the model's source copy.
      source: { ...outcome.source, periodSources: [away.source, home.source] },
      sourceType: 'OFFICIAL_SCHEDULE_AND_GAME_PERIOD_REPORT',
      qa: { canUseHistoricalPeriods: true, status: 'WARNING', issues: ['RETROSPECTIVE_OFFICIAL_RESULTS_NOT_ARCHIVED_PREGAME_PIT'] } };
    try { normalizeNhlModelGame(game); games.push(game); }
    catch (error) { invalid.push({ code: error.code || 'NHL_HISTORY_PERIOD_PATH_INVALID', gameId: outcome.gameId }); }
  }
  const validGameIds = new Set(outcomes.filter(row => row.season === season && row.gameType === gameType).map(row => row.gameId));
  for (const { row } of rows.values()) if (!validGameIds.has(String(row.gameId))) invalid.push({ code: 'NHL_HISTORY_PERIOD_UNEXPECTED_GAME', gameId: String(row.gameId) });
  const expectedGames = validGameIds.size;
  return { games, report: { season, gameType, requestedGames: expectedGames, expectedReportRows: expectedTotal,
    acquiredReportRows: rows.size, completePeriodGames: games.length, missingGameIds, invalid,
    fullRequestedPeriodCoverage: !invalid.length && !missingGameIds.length && games.length === expectedGames && rows.size === expectedGames * 2
      && expectedTotal === expectedGames * 2, sourcePages: ordered.map(row => row.source),
    strictPointInTimeVerified: false } };
}

export function mergeNhlHistoricalPeriodSources(corpora) {
  const records = new Map(); const conflicts = new Set(); const corroborated = new Set();
  for (const raw of corpora.flat()) {
    const normalized = normalizeNhlModelGame(raw);
    if (normalized.synthetic || normalized.sourceKind !== 'OFFICIAL_NHL_RECORD') fail('NHL_HISTORY_PERIOD_MERGE_SOURCE_INVALID');
    if (conflicts.has(normalized.gameId)) continue;
    const prior = records.get(normalized.gameId);
    const signature = row => nhlHistoryHash([row.gameId, row.season, row.gameType, row.startTimeUTC, row.awayTeamId, row.homeTeamId, row.path]);
    if (prior && signature(prior.normalized) !== signature(normalized)) { records.delete(normalized.gameId); conflicts.add(normalized.gameId); continue; }
    if (prior) corroborated.add(normalized.gameId);
    records.set(normalized.gameId, { raw, normalized });
  }
  return { games: [...records.values()].map(row => row.raw).sort((a, b) => Date.parse(a.startTimeUTC) - Date.parse(b.startTimeUTC)),
    conflictingGameIds: [...conflicts], corroboratedGameIds: [...corroborated].filter(id => !conflicts.has(id)) };
}

export function hasCompleteNhlPeriodCoverage(outcomes, merged, { season, gameType = 2 } = {}) {
  const requested = new Set(outcomes.filter(row => row.season === season && row.gameType === gameType).map(row => row.gameId));
  const actual = new Set(merged.games.map(row => row.gameId));
  return requested.size > 0 && merged.conflictingGameIds.length === 0 && merged.games.length === requested.size
    && actual.size === merged.games.length && merged.games.every(row => row.season === season && row.gameType === gameType && requested.has(row.gameId));
}

// A schedule supplies the final score and explicit REG/OT/SO outcome. It does
// not supply three regulation periods. For OT/SO the one awarded winning goal
// can be removed to recover the regulation tie, but periods stay unavailable.
export function normalizeNhlHistoricalOutcome(raw, source) {
  const game = normalizeNhlScheduleGame(raw, source);
  if (!validateNhlIdentity(game).ok) fail('NHL_HISTORY_IDENTITY_INVALID');
  if (!['OFF', 'FINAL'].includes(game.gameState)) return null;
  if (!source || source.provider !== 'NHL' || timestamp(source.fetchedAt) == null
    || !/^https:\/\/api-web\.nhle\.com\/v1\/(?:club-schedule-season|gamecenter)\//.test(source.url || '')) fail('NHL_HISTORY_SOURCE_INVALID');
  const away = game.final?.awayGoals; const home = game.final?.homeGoals;
  if (!score(away) || !score(home) || away === home || !['REG', 'OT', 'SO'].includes(game.outcomeType)) fail('NHL_HISTORY_FINAL_INVALID');
  if ((game.outcomeType !== 'REG' && Math.abs(away - home) !== 1) || (game.gameType === 3 && game.outcomeType === 'SO')) fail('NHL_HISTORY_EXTRA_TIME_INVALID');
  const regulation = game.outcomeType === 'REG' ? { awayGoals: away, homeGoals: home }
    : { awayGoals: Math.min(away, home), homeGoals: Math.min(away, home) };
  return { leagueId: 'NHL', gameId: game.gameId, season: game.season, gameType: game.gameType,
    seasonPhase: phase(game.gameType), startTimeUTC: game.startTimeUTC, officialDate: game.officialDate, taipeiDate: game.taipeiDate,
    awayTeamId: game.awayTeamId, homeTeamId: game.homeTeamId, awayAbbrev: game.awayAbbrev, homeAbbrev: game.homeAbbrev,
    final: { awayGoals: away, homeGoals: home }, regulation, outcomeType: game.outcomeType,
    regulationDerivation: game.outcomeType === 'REG' ? 'OFFICIAL_REGULATION_FINAL' : 'OFFICIAL_EXTRA_TIME_FINAL_MINUS_ONE_AWARDED_WINNING_GOAL',
    periods: null, periodCoverageVerified: false, source, outcomeAvailableAt: null,
    pregamePointInTimeVerified: false, synthetic: false };
}

export function buildNhlHistoricalCoverage({ season, expectedTeams, schedules, attempts = [], observedAt = new Date().toISOString() }) {
  if (!Number.isSafeInteger(season) || !/^\d{8}$/.test(String(season)) || season % 10000 !== Math.floor(season / 10000) + 1
    || !Array.isArray(expectedTeams) || !expectedTeams.length || !Array.isArray(schedules) || timestamp(observedAt) == null) fail('NHL_HISTORY_SCOPE_INVALID');
  const expected = new Map();
  for (const team of expectedTeams) {
    if (!Number.isSafeInteger(team.teamId) || team.teamId <= 0 || !/^[A-Z]{2,3}$/.test(team.abbrev || '') || expected.has(team.abbrev)
      || [...expected.values()].some(row => row.teamId === team.teamId) || (team.gamesPlayed != null && (!Number.isSafeInteger(team.gamesPlayed) || team.gamesPlayed < 0))) fail('NHL_HISTORY_TEAM_REGISTRY_INVALID');
    expected.set(team.abbrev, team);
  }
  const unique = new Map(); const conflicts = new Set(); const invalid = []; const acquired = new Set();
  const sourceByGame = new Map(); const scheduledByTeam = new Map();
  for (const checkpoint of schedules) {
    const team = expected.get(checkpoint?.team);
    const url = `https://api-web.nhle.com/v1/club-schedule-season/${checkpoint?.team}/${season}`;
    if (!team || acquired.has(team.abbrev) || !verifyNhlHistorySource(checkpoint, url) || !Array.isArray(checkpoint.data?.games)) {
      invalid.push({ team: checkpoint?.team || null, code: 'NHL_HISTORY_SCHEDULE_SOURCE_INVALID' }); continue;
    }
    let validSchedule = true; const ownIds = new Set();
    for (const raw of checkpoint.data.games) {
      const identity = normalizeNhlScheduleGame(raw, checkpoint.source);
      if (!identity.identity.ok || identity.season !== season || ![identity.awayTeamId, identity.homeTeamId].includes(team.teamId) || ownIds.has(identity.gameId)) {
        invalid.push({ team: team.abbrev, gameId: identity.gameId, code: 'NHL_HISTORY_SCHEDULE_IDENTITY_INVALID' }); validSchedule = false; continue;
      }
      ownIds.add(identity.gameId);
      if (identity.gameType === 2) {
        if (!scheduledByTeam.has(team.abbrev)) scheduledByTeam.set(team.abbrev, new Set());
        scheduledByTeam.get(team.abbrev).add(identity.gameId);
      }
      let row;
      try { row = normalizeNhlHistoricalOutcome(raw, checkpoint.source); }
      catch (error) { invalid.push({ team: team.abbrev, gameId: identity.gameId, code: error.code }); validSchedule = false; continue; }
      if (!row || conflicts.has(row.gameId)) continue;
      const prior = unique.get(row.gameId);
      const signature = value => nhlHistoryHash([value.season, value.gameType, value.startTimeUTC, value.awayTeamId, value.homeTeamId, value.final, value.outcomeType]);
      if (prior && signature(prior) !== signature(row)) {
        unique.delete(row.gameId); conflicts.add(row.gameId); invalid.push({ gameId: row.gameId, code: 'NHL_HISTORY_DUPLICATE_CONFLICT' }); continue;
      }
      unique.set(row.gameId, row);
      if (!sourceByGame.has(row.gameId)) sourceByGame.set(row.gameId, []);
      sourceByGame.get(row.gameId).push(checkpoint.source.url);
    }
    if (validSchedule) acquired.add(team.abbrev);
  }
  const outcomes = [...unique.values()].sort((a, b) => Date.parse(a.startTimeUTC) - Date.parse(b.startTimeUTC) || a.gameId.localeCompare(b.gameId));
  for (const row of outcomes) row.corroboratingScheduleUrls = sourceByGame.get(row.gameId);
  const teamCoverage = [...expected.values()].map(team => {
    const regular = outcomes.filter(row => row.gameType === 2 && [row.awayTeamId, row.homeTeamId].includes(team.teamId));
    return { ...team, scheduleAcquired: acquired.has(team.abbrev), scheduledRegularGames: scheduledByTeam.get(team.abbrev)?.size ?? 0,
      acquiredRegularOutcomes: regular.length, officialRecordedGames: team.gamesPlayed ?? null,
      matchesOfficialRecordedGames: team.gamesPlayed != null && regular.length === team.gamesPlayed };
  });
  const allClubSchedules = acquired.size === expected.size && !invalid.length;
  const leagueRegularComplete = allClubSchedules && teamCoverage.every(row => row.matchesOfficialRecordedGames)
    && outcomes.filter(row => row.gameType === 2).every(row => row.corroboratingScheduleUrls.length === 2)
    && outcomes.filter(row => row.gameType === 2).length * 2 === teamCoverage.reduce((sum, team) => sum + team.gamesPlayed, 0);
  const byPhase = Object.fromEntries([1, 2, 3].map(type => [phase(type), { games: outcomes.filter(row => row.gameType === type).length,
    outcomes: Object.fromEntries(['REG', 'OT', 'SO'].map(kind => [kind, outcomes.filter(row => row.gameType === type && row.outcomeType === kind).length])) }]));
  return { outcomes, manifest: { leagueId: 'NHL', version: NHL_HISTORY_VALIDATION_VERSION, season, observedAt,
    requestedTeams: expected.size, acquiredTeams: acquired.size, missingTeams: [...expected.keys()].filter(team => !acquired.has(team)),
    requestedRegularGames: teamCoverage.every(team => team.gamesPlayed != null) ? teamCoverage.reduce((sum, team) => sum + team.gamesPlayed, 0) / 2 : null,
    acquiredOutcomes: outcomes.length, acquiredRegularOutcomes: byPhase.REGULAR.games, completeClubScheduleCoverage: allClubSchedules,
    completeOfficialRecordedRegularSeasonCoverage: leagueRegularComplete, coverageReference: 'OFFICIAL_STANDINGS_RECORDED_GAMES_AT_REQUESTED_DATE',
    teamCoverage, phases: byPhase, invalid, attempts, outcomeCorpusHash: nhlHistoryHash(outcomes),
    strictPointInTimeVerified: false, personnelHistoricalCoverageVerified: false, periodCoverageVerified: false,
    productionModelCalibrated: false, tai888HistoricalValidation: false } };
}

function cleanOutcomes(outcomes, gameType) {
  if (!Array.isArray(outcomes) || ![2, 3].includes(gameType)) fail('NHL_HISTORY_VALIDATION_SCOPE_INVALID');
  const ids = new Set();
  for (const row of outcomes) {
    if (!validateNhlIdentity(row).ok || row.synthetic !== false || timestamp(row.source?.fetchedAt) == null
      || row.source?.provider !== 'NHL' || !/^https:\/\/api-web\.nhle\.com\/v1\//.test(row.source?.url || '')
      || !score(row.regulation?.awayGoals) || !score(row.regulation?.homeGoals) || !score(row.final?.awayGoals) || !score(row.final?.homeGoals)
      || row.final.awayGoals === row.final.homeGoals || !['REG', 'OT', 'SO'].includes(row.outcomeType)
      || (row.outcomeType === 'REG' && (row.final.awayGoals !== row.regulation.awayGoals || row.final.homeGoals !== row.regulation.homeGoals))
      || (row.outcomeType !== 'REG' && (row.regulation.awayGoals !== row.regulation.homeGoals || Math.abs(row.final.awayGoals - row.final.homeGoals) !== 1
        || Math.min(row.final.awayGoals, row.final.homeGoals) !== row.regulation.awayGoals))
      || (row.gameType === 3 && row.outcomeType === 'SO') || ids.has(row.gameId)) fail('NHL_HISTORY_VALIDATION_RECORD_INVALID');
    ids.add(row.gameId);
  }
  return outcomes.filter(row => row.gameType === gameType).sort((a, b) => Date.parse(a.startTimeUTC) - Date.parse(b.startTimeUTC) || a.gameId.localeCompare(b.gameId));
}
function empiricalScoreDistribution(rows) {
  const bins = new Map(); let away = 0; let home = 0; let homeWin = 0;
  for (const row of rows) {
    const key = `${row.regulation.awayGoals}:${row.regulation.homeGoals}`;
    bins.set(key, (bins.get(key) || 0) + 1 / rows.length);
    away += row.regulation.awayGoals / rows.length; home += row.regulation.homeGoals / rows.length;
    homeWin += Number(row.regulation.homeGoals > row.regulation.awayGoals) / rows.length;
  }
  return { bins, mean: { away, home }, homeRegulationWinProbability: homeWin };
}
function empiricalFold(training, target) {
  const distribution = empiricalScoreDistribution(training);
  const mass = [...distribution.bins.values()].reduce((sum, value) => sum + value, 0);
  if (Math.abs(mass - 1) > 1e-10) fail('NHL_HISTORY_PROBABILITY_MASS_INVALID');
  const outcomeProbability = distribution.bins.get(`${target.regulation.awayGoals}:${target.regulation.homeGoals}`) || 0;
  return { targetGameId: target.gameId, asOf: target.startTimeUTC, trainingGames: training.length,
    trainingGameIds: training.map(row => row.gameId), latestTrainingStart: training.at(-1).startTimeUTC,
    regulationBrier: 1 + [...distribution.bins.values()].reduce((sum, value) => sum + value * value, 0) - 2 * outcomeProbability,
    regulationSquaredError: (distribution.mean.away - target.regulation.awayGoals) ** 2 + (distribution.mean.home - target.regulation.homeGoals) ** 2,
    observedScoreProbability: outcomeProbability, homeRegulationWinProbability: distribution.homeRegulationWinProbability,
    homeRegulationWinObserved: Number(target.regulation.homeGoals > target.regulation.awayGoals), mass,
    strictPointInTimeVerified: false };
}
export function summarizeNhlHistoricalFolds(folds) {
  const mean = key => folds.length ? folds.reduce((sum, fold) => sum + fold[key], 0) / folds.length : null;
  const reliability = Array.from({ length: 10 }, (_, i) => ({ lower: i / 10, upper: (i + 1) / 10, count: 0, sumPredicted: 0, sumObserved: 0 }));
  for (const row of folds) {
    const p = row.homeRegulationWinProbability;
    if (!(p >= 0 && p <= 1)) fail('NHL_HISTORY_PROBABILITY_INVALID');
    const bin = reliability[p === 1 ? 9 : Math.floor(p * 10)];
    bin.count += 1; bin.sumPredicted += p; bin.sumObserved += row.homeRegulationWinObserved;
  }
  return { folds: folds.length, regulationBrier: mean('regulationBrier'), regulationSquaredError: mean('regulationSquaredError'),
    unseenHeldOutScores: folds.filter(row => row.observedScoreProbability === 0).length,
    homeRegulationWinBrier: folds.length ? folds.reduce((sum, row) => sum + (row.homeRegulationWinProbability - row.homeRegulationWinObserved) ** 2, 0) / folds.length : null,
    reliability: reliability.map(bin => ({ lower: bin.lower, upper: bin.upper, count: bin.count,
      predicted: bin.count ? bin.sumPredicted / bin.count : null, observed: bin.count ? bin.sumObserved / bin.count : null })) };
}

// A transparent score-distribution BENCHMARK, not a replacement for model.js.
// No injury, roster, season totals or target-game events enter predictions.
// Hyperparameters are not selected on validation/test outcomes; the empirical
// reference has none. All concurrent starts stay in the same temporal block.
export function validateNhlHistoricalOutcomes(outcomes, { gameType = 2, initialTrainingGames = 100 } = {}) {
  if (!Number.isSafeInteger(initialTrainingGames) || initialTrainingGames < 1) fail('NHL_HISTORY_TRAINING_SIZE_INVALID');
  const rows = cleanOutcomes(outcomes, gameType); const walkForward = []; const skipped = [];
  for (const target of rows) {
    const training = rows.filter(row => Date.parse(row.startTimeUTC) + NHL_HISTORY_EMBARGO_MS <= Date.parse(target.startTimeUTC));
    if (training.length < initialTrainingGames) { skipped.push(target.gameId); continue; }
    walkForward.push(empiricalFold(training, target));
  }
  const distinctStarts = [...new Set(rows.map(row => new Date(row.startTimeUTC).toISOString()))];
  const validationCutoff = distinctStarts[Math.floor(distinctStarts.length * 0.6)] ?? null;
  const testCutoff = distinctStarts[Math.floor(distinctStarts.length * 0.8)] ?? null;
  const training = validationCutoff ? rows.filter(row => Date.parse(row.startTimeUTC) + NHL_HISTORY_EMBARGO_MS <= Date.parse(validationCutoff)) : [];
  const validation = []; const test = [];
  if (training.length >= initialTrainingGames) {
    for (const target of rows.filter(row => Date.parse(row.startTimeUTC) >= Date.parse(validationCutoff))) {
      const fold = empiricalFold(training, target);
      (Date.parse(target.startTimeUTC) < Date.parse(testCutoff) ? validation : test).push(fold);
    }
  }
  const compactFold = ({ trainingGameIds, ...fold }) => ({ ...fold, trainingGameIdsHash: nhlHistoryHash(trainingGameIds) });
  return { leagueId: 'NHL', version: NHL_HISTORY_VALIDATION_VERSION, gameType, seasons: [...new Set(rows.map(row => row.season))], games: rows.length,
    status: walkForward.length ? 'RETROSPECTIVE_SCORE_BENCHMARK_VALIDATED' : 'INSUFFICIENT_HISTORY',
    method: 'EXPANDING_EMPIRICAL_JOINT_REGULATION_SCORE_BENCHMARK', benchmarkOnly: true,
    modelFormulaChanged: false, embargoHours: 48, initialTrainingGames, outcomeCorpusHash: nhlHistoryHash(outcomes),
    walkForward: { ...summarizeNhlHistoricalFolds(walkForward), evidence: walkForward.map(compactFold), skipped },
    fixedHoldout: { validationCutoff, testCutoff, trainingGames: training.length, trainingGameIds: training.map(row => row.gameId),
      validation: { ...summarizeNhlHistoricalFolds(validation), evidence: validation.map(compactFold) },
      untouchedTest: { ...summarizeNhlHistoricalFolds(test), evidence: test.map(compactFold) },
      fitOnValidationOrTest: false },
    strictPointInTime: { eligiblePersonnelFolds: 0, status: 'NO_ARCHIVED_PREGAME_PERSONNEL_EVIDENCE' },
    preseasonExcluded: outcomes.filter(row => row.gameType === 1).length,
    strictPointInTimeVerified: false, productionModelCalibrated: false, tai888HistoricalValidation: false };
}

// Reuses the existing independent NHL model unchanged. Fit once at each block
// boundary, then evaluate every held-out complete-period path in that block.
// Training-cutoff hashes and actual game IDs make every fold reproducible.
export function validateNhlHistoricalModelBlocks(games, { gameType = 2, initialTrainingGames = 12, blockGames = 20, onProgress = () => {} } = {}) {
  if (![initialTrainingGames, blockGames].every(value => Number.isSafeInteger(value) && value > 0)) fail('NHL_HISTORY_BLOCK_CONFIG_INVALID');
  const seen = new Set();
  const rows = games.map(raw => ({ raw, normalized: normalizeNhlModelGame(raw) })).filter(row => row.normalized.gameType === gameType)
    .sort((a, b) => Date.parse(a.normalized.startTimeUTC) - Date.parse(b.normalized.startTimeUTC));
  for (const { normalized } of rows) {
    if (seen.has(normalized.gameId) || normalized.synthetic || normalized.sourceKind !== 'OFFICIAL_NHL_RECORD') fail('NHL_HISTORY_MODEL_SOURCE_INVALID');
    seen.add(normalized.gameId);
  }
  const scoreArtifact = (artifact, target) => {
    const cutoff = target.normalized.startTimeUTC;
    const snapshot = predictNhlDistribution(artifact, target.raw, { asOf: cutoff, scenarioCount: 1 });
    const audit = auditNhlDistribution(snapshot);
    if (!audit.passed) fail('NHL_HISTORY_MODEL_DISTRIBUTION_INVALID');
    const bins = new Map(); let away = 0; let home = 0; let homeWin = 0;
    for (const scenario of snapshot.scenarios) for (const scorePath of scenario.paths) {
      const probability = scenario.weight * scorePath.probability;
      const key = `${scorePath.regulation.away}:${scorePath.regulation.home}`;
      bins.set(key, (bins.get(key) || 0) + probability);
      away += scorePath.regulation.away * probability; home += scorePath.regulation.home * probability;
      homeWin += Number(scorePath.regulation.home > scorePath.regulation.away) * probability;
    }
    const actual = target.normalized.path.regulation;
    const observed = bins.get(`${actual.away}:${actual.home}`) || 0;
    return { targetGameId: target.normalized.gameId, asOf: cutoff, artifactId: artifact.artifactId,
      regulationBrier: 1 + [...bins.values()].reduce((sum, p) => sum + p * p, 0) - 2 * observed,
      regulationSquaredError: (away - actual.away) ** 2 + (home - actual.home) ** 2,
      observedScoreProbability: observed, homeRegulationWinProbability: homeWin,
      homeRegulationWinObserved: Number(actual.home > actual.away), distributionMass: audit.weightedPathMass };
  };
  const folds = []; const blocks = []; let artifact = null; let usedInBlock = 0;
  for (const target of rows) {
    const cutoff = target.normalized.startTimeUTC;
    const training = rows.filter(row => Date.parse(row.normalized.startTimeUTC) + NHL_HISTORY_EMBARGO_MS <= Date.parse(cutoff));
    if (training.length < initialTrainingGames) continue;
    if (!artifact || usedInBlock >= blockGames) {
      onProgress({ stage: 'fit_walk_forward_block', cutoff, trainingGames: training.length, scoredGames: folds.length });
      artifact = fitNhlModel(training.map(row => row.raw), { gameType, trainingCutoff: cutoff, availabilityMode: 'RETROSPECTIVE_48H_EMBARGO' });
      usedInBlock = 0;
      blocks.push({ cutoff, artifactId: artifact.artifactId, trainingGameIds: artifact.trainingGameIds, trainingSourceHash: artifact.trainingSourceHash,
        bandwidth: artifact.parameters.bandwidth, innerChronologicalTuningFolds: artifact.calibrationEvidence.foldCount });
    }
    folds.push(scoreArtifact(artifact, target));
    if (folds.length % 100 === 0) onProgress({ stage: 'score_walk_forward', scoredGames: folds.length });
    usedInBlock += 1;
  }
  const starts = [...new Set(rows.map(row => new Date(row.normalized.startTimeUTC).toISOString()))];
  const validationCutoff = starts[Math.floor(starts.length * 0.6)] || null;
  const testCutoff = starts[Math.floor(starts.length * 0.8)] || null;
  const holdoutTraining = validationCutoff ? rows.filter(row => Date.parse(row.normalized.startTimeUTC) + NHL_HISTORY_EMBARGO_MS <= Date.parse(validationCutoff)) : [];
  const validation = []; const untouchedTest = []; let holdoutArtifact = null;
  if (holdoutTraining.length >= initialTrainingGames) {
    onProgress({ stage: 'fit_fixed_holdout', cutoff: validationCutoff, trainingGames: holdoutTraining.length });
    holdoutArtifact = fitNhlModel(holdoutTraining.map(row => row.raw), { gameType, trainingCutoff: validationCutoff, availabilityMode: 'RETROSPECTIVE_48H_EMBARGO' });
    for (const target of rows.filter(row => Date.parse(row.normalized.startTimeUTC) >= Date.parse(validationCutoff))) {
      const scored = scoreArtifact(holdoutArtifact, target);
      (Date.parse(target.normalized.startTimeUTC) < Date.parse(testCutoff) ? validation : untouchedTest).push(scored);
      if ((validation.length + untouchedTest.length) % 100 === 0) onProgress({ stage: 'score_fixed_holdout', validationGames: validation.length, testGames: untouchedTest.length });
    }
  }
  return { leagueId: 'NHL', version: NHL_HISTORY_VALIDATION_VERSION, modelVersion: NHL_MODEL_VERSION, gameType,
    seasons: [...new Set(rows.map(row => Number(row.normalized.season)))], completePeriodGames: rows.length, initialTrainingGames, blockGames, embargoHours: 48,
    status: folds.length ? 'RETROSPECTIVE_EXISTING_MODEL_BLOCK_WALK_FORWARD' : 'INSUFFICIENT_COMPLETE_PERIOD_HISTORY',
    ...summarizeNhlHistoricalFolds(folds), blocks, evidence: folds,
    periodCorpusHash: nhlHistoryHash(games),
    fixedHoldout: { validationCutoff, testCutoff, trainingGames: holdoutTraining.length, artifactId: holdoutArtifact?.artifactId || null,
      trainingGameIds: holdoutTraining.map(row => row.normalized.gameId), fitOnValidationOrTest: false,
      validation: { ...summarizeNhlHistoricalFolds(validation), evidence: validation },
      untouchedTest: { ...summarizeNhlHistoricalFolds(untouchedTest), evidence: untouchedTest } },
    strictPointInTimeVerified: false, productionModelCalibrated: false, tai888HistoricalValidation: false };
}

export function verifyNhlBundledHistoricalReports({ coverage, benchmark, playoffs, model, outcomes, periods }) {
  if ([coverage, benchmark, playoffs, model].some(value => value?.leagueId !== 'NHL' || value.version !== NHL_HISTORY_VALIDATION_VERSION)
    || !Array.isArray(outcomes) || !Array.isArray(periods) || coverage.scoreValidationHash !== nhlHistoryHash(benchmark)
    || coverage.playoffValidationHash !== nhlHistoryHash(playoffs) || coverage.modelValidationHash !== nhlHistoryHash(model)
    || coverage.outcomeCorpusHash !== nhlHistoryHash(outcomes)
    || benchmark.outcomeCorpusHash !== coverage.outcomeCorpusHash || playoffs.outcomeCorpusHash !== coverage.outcomeCorpusHash
    || coverage.periodCorpusHash !== nhlHistoryHash(periods) || model.periodCorpusHash !== coverage.periodCorpusHash) fail('NHL_HISTORY_BUNDLED_REPORT_HASH_CONFLICT');
  if (benchmark.gameType !== 2 || playoffs.gameType !== 3 || model.gameType !== 2
    || [benchmark, playoffs, model].some(value => !Array.isArray(value.seasons) || value.seasons.some(season => season !== coverage.season))
    || outcomes.some(row => row.leagueId !== 'NHL' || row.season !== coverage.season)
    || coverage.acquiredOutcomes !== outcomes.length || coverage.acquiredRegularOutcomes !== outcomes.filter(row => row.gameType === 2).length
    || benchmark.games !== outcomes.filter(row => row.gameType === 2).length || playoffs.games !== outcomes.filter(row => row.gameType === 3).length
    || coverage.completePeriodGames !== model.completePeriodGames || periods.length !== model.completePeriodGames
    || periods.some(row => row.leagueId !== 'NHL' || row.season !== coverage.season || row.gameType !== 2)
    || [coverage, benchmark, playoffs, model].some(value => value.productionModelCalibrated !== false || value.strictPointInTimeVerified !== false)) fail('NHL_HISTORY_BUNDLED_REPORT_SCOPE_CONFLICT');
  return true;
}

export async function loadBundledNhlHistoryValidation() {
  try {
    // Literal file paths keep Next output tracing scoped to these six files,
    // not every raw acquisition checkpoint in the containing directory.
    const [coverage, benchmark, playoffs, model, outcomes, periods] = (await Promise.all([
      fs.readFile(path.join(process.cwd(), 'scripts/fixtures/nhl/history-expanded/coverage.json'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'scripts/fixtures/nhl/history-expanded/score-validation.json'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'scripts/fixtures/nhl/history-expanded/playoff-score-validation.json'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'scripts/fixtures/nhl/history-expanded/model-validation.json'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'scripts/fixtures/nhl/history-expanded/outcomes.json'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'scripts/fixtures/nhl/history-expanded/period-games.json'), 'utf8'),
    ])).map(value => JSON.parse(value));
    verifyNhlBundledHistoricalReports({ coverage, benchmark, playoffs, model, outcomes, periods });
    const { evidence, blocks, acquisition, ...modelSummary } = model;
    const compactPeriodCoverage = value => value ? { ...value, missingGameIds: value.missingGameIds.slice(0, 20),
      missingGameCount: value.missingGameIds.length, missingIdsTruncated: value.missingGameIds.length > 20 } : null;
    const summarizeBenchmark = value => ({ ...value, walkForward: { ...value.walkForward, evidence: undefined, skipped: undefined },
      fixedHoldout: { ...value.fixedHoldout, trainingGameIds: undefined,
        validation: { ...value.fixedHoldout.validation, evidence: undefined },
        untouchedTest: { ...value.fixedHoldout.untouchedTest, evidence: undefined } } });
    return { ok: true, leagueId: 'NHL', version: NHL_HISTORY_VALIDATION_VERSION,
      status: coverage.completeOfficialRecordedRegularSeasonCoverage ? 'OFFICIAL_OUTCOME_COVERAGE_COMPLETE' : 'PARTIAL_OFFICIAL_OUTCOME_COVERAGE',
      coverage: { ...coverage, attempts: undefined, batchPeriodCoverage: compactPeriodCoverage(coverage.batchPeriodCoverage) }, benchmark: summarizeBenchmark(benchmark), playoffs: summarizeBenchmark(playoffs),
      model: { ...modelSummary, fixedHoldout: { ...model.fixedHoldout, trainingGameIds: undefined,
        validation: { ...model.fixedHoldout.validation, evidence: undefined },
        untouchedTest: { ...model.fixedHoldout.untouchedTest, evidence: undefined } }, fitBlocks: blocks.length, acquisition: { ...acquisition, attempts: undefined,
        batchPeriodCoverage: compactPeriodCoverage(acquisition.batchPeriodCoverage) }, recentFolds: evidence.slice(-5) },
      strictPointInTimeVerified: false, productionModelCalibrated: false,
      message: '官方比分全季覆蓋與既有 NHL 模型回溯驗證分開計算；未使用賽後傷病、陣容或門將資訊冒充賽前資料。' };
  } catch (error) {
    return { ok: false, leagueId: 'NHL', version: NHL_HISTORY_VALIDATION_VERSION, status: 'UNAVAILABLE',
      code: error.code === 'ENOENT' ? 'NHL_HISTORY_BUNDLED_REPORT_NOT_READY' : error.code || 'NHL_HISTORY_BUNDLED_REPORT_INVALID',
      strictPointInTimeVerified: false, productionModelCalibrated: false };
  }
}
