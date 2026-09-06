// Resumable official NHL acquisition. No proxy, credentials or fabricated data.
// node scripts/nhl-history-validation-runner.mjs --season 20232024 --out /absolute/path
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchNhlJson, normalizeNhlGame } from '../lib/nhl/data.js';
import { normalizeNhlModelGame } from '../lib/nhl/model-qa.js';
import { NHL_HISTORICAL_SAMPLES } from '../lib/nhl/historical-samples.js';
import { NHL_HISTORY_ARCHIVABLE_SOURCE, readNhlHistoryCheckpoint } from '../lib/nhl/history-source-archive.js';
import { buildNhlHistoricalCoverage, nhlHistoryHash, verifyNhlHistorySource,
  validateNhlHistoricalOutcomes, validateNhlHistoricalModelBlocks, nhlPeriodReportUrl, joinNhlOfficialPeriodReports, mergeNhlHistoricalPeriodSources, hasCompleteNhlPeriodCoverage } from '../lib/nhl/history-validation.js';

export const NHL_HISTORY_RUNNER_USAGE = `Usage: node scripts/nhl-history-validation-runner.mjs --season 20232024 --out /absolute/path
  [--teams TOR,BOS] [--standings-date 2024-04-18] [--timeout-ms 18000]
  [--min-interval-ms 2000]
  [--pbp-games 2023020001,2023020002] [--period-games 60] [--all-periods] [--offline]

Default standings date comes from the official standings-season index, not an
assumed calendar day (the dated endpoint can be empty after season end).
League membership comes from the official dated standings; every club
schedule is requested sequentially, with a checkpoint after each success.
403/429 stops all further provider requests for this run, without a bypass.
Other failures stay explicit and can resume later. --teams restricts scope and
cannot claim complete league coverage. --offline validates existing checkpoints.
Schedule final/REG/OT/SO scores and complete-period model paths are separate.
Today-fetched outcomes do not establish historical injury/goalie PIT evidence.
--period-games samples evenly through the acquired season (explicit coverage),
not the easiest-to-download successes. Default 60. --pbp-games preserves raw
official play-by-play for separately-labelled shot research. No real wagers.`;

export function parseNhlHistoryRunnerArgs(args) {
  if (args.includes('--help')) return { help: true };
  const valued = new Set(['--season', '--out', '--teams', '--standings-date', '--timeout-ms', '--min-interval-ms', '--pbp-games', '--period-games']);
  const values = {}; const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag) || (!valued.has(flag) && !['--offline', '--all-periods'].includes(flag))) throw new Error(`Invalid or duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === '--offline') { values.offline = true; continue; }
    if (flag === '--all-periods') { values.allPeriods = true; continue; }
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing argument: ${flag}`);
    values[flag.slice(2)] = args[++index];
  }
  const season = Number(values.season); const out = values.out;
  const teams = values.teams ? values.teams.split(',').map(team => team.trim().toUpperCase()) : null;
  const standingsDate = values['standings-date'] || null;
  const timeoutMs = Number(values['timeout-ms'] || 18000);
  const minIntervalMs = Number(values['min-interval-ms'] || 2000);
  const periodGames = Number(values['period-games'] ?? 60);
  const pbpGames = values['pbp-games'] ? values['pbp-games'].split(',') : [];
  if (!/^\d{8}$/.test(String(season)) || season % 10000 !== Math.floor(season / 10000) + 1 || !out || !path.isAbsolute(out)
    || (teams && (!teams.length || teams.some(team => !/^[A-Z]{2,3}$/.test(team)) || new Set(teams).size !== teams.length))
    || (standingsDate != null && (!/^\d{4}-\d{2}-\d{2}$/.test(standingsDate) || !Number.isFinite(Date.parse(`${standingsDate}T00:00:00Z`))
    || new Date(`${standingsDate}T00:00:00Z`).toISOString().slice(0, 10) !== standingsDate))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000
    || !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 2000 || minIntervalMs > 60000
    || !Number.isSafeInteger(periodGames) || periodGames < 0 || periodGames > 2000
    || pbpGames.some(id => !/^\d{10}$/.test(id) || id.slice(0, 4) !== String(season).slice(0, 4)) || new Set(pbpGames).size !== pbpGames.length) throw new Error('Invalid NHL history runner scope.');
  return { season, out, teams, standingsDate, timeoutMs, minIntervalMs, periodGames, pbpGames, offline: values.offline === true, allPeriods: values.allPeriods === true };
}

export function teamsFromNhlStandings(checkpoint, { season, standingsDate }) {
  const url = `https://api-web.nhle.com/v1/standings/${standingsDate}`;
  if (!verifyNhlHistorySource(checkpoint, url) || !Array.isArray(checkpoint.data?.standings) || !checkpoint.data.standings.length) throw new Error('NHL_HISTORY_STANDINGS_INVALID');
  const teams = checkpoint.data.standings.map(row => ({ teamId: row.teamId, abbrev: row.teamAbbrev?.default,
    gamesPlayed: row.gamesPlayed, seasonId: row.seasonId }));
  // Standings currently omit numerical teamId. Resolve only from that club's
  // official schedule below, never by importing another league's registry.
  if (teams.some(row => !/^[A-Z]{2,3}$/.test(row.abbrev || '') || !Number.isSafeInteger(row.gamesPlayed) || row.gamesPlayed < 0
    || row.seasonId !== season) || new Set(teams.map(row => row.abbrev)).size !== teams.length) throw new Error('NHL_HISTORY_STANDINGS_IDENTITY_INVALID');
  return teams;
}

function sampledIds(rows, count) {
  if (!count || !rows.length) return [];
  const wanted = Math.min(count, rows.length);
  return [...new Set(Array.from({ length: wanted }, (_, index) => rows[Math.floor(index * rows.length / wanted)].gameId))];
}

export async function runNhlHistoryValidation(options, { fetchImpl = globalThis.fetch, progress = console.log } = {}) {
  await fs.mkdir(options.out, { recursive: true });
  const startedAt = new Date().toISOString(); const attempts = []; let blocked = false; let previousRequestAt = 0;
  const save = async (name, data) => {
    const target = path.join(options.out, name); const temporary = `${target}.partial`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
    await fs.rename(temporary, target);
  };
  const read = async name => {
    try {
      return NHL_HISTORY_ARCHIVABLE_SOURCE.test(name) ? readNhlHistoryCheckpoint(name, { directory: options.out })
        : JSON.parse(await fs.readFile(path.join(options.out, name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'NHL_HISTORY_ARCHIVE_SOURCE_NOT_UNIQUE') return null;
      throw error;
    }
  };
  const priorCoverage = await read('coverage.json');
  const failureHistory = (await read('source-failures.json'))?.failures || [];
  let latestKnownSourceFailure = priorCoverage?.latestKnownSourceFailure || [...failureHistory, ...(priorCoverage?.attempts || [])].reverse().find(row => row.httpStatus === 403 || row.httpStatus === 429) || null;
  async function acquire(name, url, extra = {}) {
    const prior = await read(name);
    if (verifyNhlHistorySource(prior, url)) { progress(JSON.stringify({ step: name, cached: true })); return prior; }
    if (blocked || options.offline) { attempts.push({ url, code: blocked ? 'PROVIDER_STOPPED' : 'OFFLINE_CHECKPOINT_MISSING' }); return null; }
    const delayMs = Math.max(0, previousRequestAt + (options.minIntervalMs ?? 2000) - Date.now());
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    previousRequestAt = Date.now();
    let retryAfter = null;
    const observingFetch = async (target, init) => {
      const response = await fetchImpl(target, init);
      if (response.status === 429 || response.status === 503) {
        const value = response.headers?.get?.('retry-after');
        if (value != null) {
          const seconds = /^\d+$/.test(value) ? Number(value) : null;
          const at = seconds != null ? Date.now() + seconds * 1000 : Date.parse(value);
          retryAfter = { header: value, retryAfterAt: Number.isFinite(at) ? new Date(at).toISOString() : null };
        }
      }
      return response;
    };
    const result = await fetchNhlJson(url, { fetchImpl: observingFetch, timeoutMs: options.timeoutMs, retry: false, ttlMs: 0, negativeTtlMs: 0 });
    attempts.push({ url, ok: result.ok, code: result.code || null, httpStatus: result.httpStatus || null, fetchedAt: result.source?.fetchedAt || null, retryAfter });
    progress(JSON.stringify({ step: name, ok: result.ok, code: result.code || null }));
    if (['NHL_SOURCE_FORBIDDEN', 'NHL_SOURCE_RATE_LIMITED'].includes(result.code)) { blocked = true; latestKnownSourceFailure = attempts.at(-1); }
    if (!result.ok) {
      failureHistory.push(attempts.at(-1));
      await save('source-failures.json', { leagueId: 'NHL', failures: failureHistory });
      return null;
    }
    if (latestKnownSourceFailure && new URL(latestKnownSourceFailure.url).origin === new URL(url).origin)
      latestKnownSourceFailure = { ...latestKnownSourceFailure, recoveredAt: result.source.fetchedAt, recoverySourceUrl: url };
    const checkpoint = { ...result, ...extra, acquiredVia: 'OFFICIAL_PUBLIC_API_DIRECT', historicalPublicationTimeVerified: false };
    await save(name, checkpoint);
    return checkpoint;
  }
  let standingsDate = options.standingsDate;
  if (!standingsDate) {
    const seasonIndex = await acquire('standings-season-index.json', 'https://api-web.nhle.com/v1/standings-season');
    const matching = seasonIndex?.data?.seasons?.filter(row => row.id === options.season) || [];
    if (matching.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(matching[0].standingsEnd || '')
      && Number.isFinite(Date.parse(`${matching[0].standingsEnd}T00:00:00Z`))) standingsDate = matching[0].standingsEnd;
    else attempts.push({ step: 'season_standings_date', code: 'NHL_HISTORY_OFFICIAL_STANDINGS_DATE_UNAVAILABLE' });
  }
  const standings = standingsDate ? await acquire(`standings-${standingsDate}.json`, `https://api-web.nhle.com/v1/standings/${standingsDate}`) : null;
  let registry = [];
  try { if (standings) registry = teamsFromNhlStandings(standings, { ...options, standingsDate }); }
  catch (error) { attempts.push({ step: 'standings_identity', code: error.message }); }
  // If discovery is unavailable an explicit club list still permits useful
  // acquisition, but the resulting manifest can never claim league completeness.
  const selected = options.teams || registry.map(row => row.abbrev);
  const schedules = []; const expectedTeams = [];
  for (const team of selected) {
    const checkpoint = await acquire(`schedule-${team}-${options.season}.json`, `https://api-web.nhle.com/v1/club-schedule-season/${team}/${options.season}`, { team });
    const official = registry.find(row => row.abbrev === team);
    let teamId = official?.teamId;
    if (checkpoint) {
      schedules.push(checkpoint);
      const candidates = new Set((checkpoint.data?.games || []).flatMap(game => [game.awayTeam, game.homeTeam]).filter(row => row?.abbrev === team).map(row => row.id));
      if (candidates.size === 1 && Number.isSafeInteger([...candidates][0])) teamId = [...candidates][0];
    }
    if (teamId) expectedTeams.push({ teamId, abbrev: team, gamesPlayed: official?.gamesPlayed ?? null });
    else attempts.push({ step: 'team_identity', team, code: 'NHL_HISTORY_TEAM_ID_UNRESOLVED' });
    await save('acquisition-progress.json', { leagueId: 'NHL', startedAt, requestedTeams: selected, acquiredSchedules: schedules.map(row => row.team), attempts, blocked, finished: false });
  }
  if (!expectedTeams.length) {
    const report = { leagueId: 'NHL', startedAt, completedAt: new Date().toISOString(), status: 'NO_VERIFIED_TEAM_SCHEDULES',
      requestedTeams: selected, acquiredTeams: 0, attempts, blocked, completeOfficialRecordedRegularSeasonCoverage: false, strictPointInTimeVerified: false };
    await save('coverage.json', report); return report;
  }
  const coverage = buildNhlHistoricalCoverage({ season: options.season, expectedTeams, schedules, attempts });
  coverage.manifest.requestedTeams = selected.length;
  coverage.manifest.unresolvedTeamIdentities = selected.filter(team => !expectedTeams.some(row => row.abbrev === team));
  coverage.manifest.missingTeams = selected.filter(team => !schedules.some(row => row.team === team));
  coverage.manifest.registrySource = standings?.source || null;
  coverage.manifest.completeOfficialRecordedRegularSeasonCoverage &&= !options.teams && registry.length === selected.length && !coverage.manifest.unresolvedTeamIdentities.length;
  coverage.manifest.startedAt = startedAt; coverage.manifest.blocked = blocked;
  await save('outcomes.json', coverage.outcomes);
  // A valid previously published bundle stays intact until the newly computed
  // report hashes can be published below. Interrupted work is progress, not a
  // falsely completed new validation release.
  if (!priorCoverage?.completedAt) await save('coverage.json', coverage.manifest);
  const benchmark = validateNhlHistoricalOutcomes(coverage.outcomes, { initialTrainingGames: 100 });
  await save('score-validation.json', benchmark);
  const playoff = validateNhlHistoricalOutcomes(coverage.outcomes, { gameType: 3, initialTrainingGames: 20 });
  await save('playoff-score-validation.json', playoff);
  const periodIds = sampledIds(coverage.outcomes.filter(row => row.gameType === 2), options.periodGames);
  const periodGames = []; const periodFailures = [];
  for (const gameId of periodIds) {
    const checkpoint = await acquire(`landing-${gameId}.json`, `https://api-web.nhle.com/v1/gamecenter/${gameId}/landing`);
    if (!checkpoint) { periodFailures.push(gameId); continue; }
    try {
      const game = normalizeNhlGame(checkpoint.data, { source: checkpoint.source, expected: { gameId, season: options.season } });
      normalizeNhlModelGame(game);
      if (!game.qa?.canUseHistoricalPeriods) throw new Error('NHL_HISTORY_PERIODS_INCOMPLETE');
      periodGames.push(game);
    } catch (error) { periodFailures.push(gameId); attempts.push({ step: 'period_integrity', gameId, code: error.code || error.message }); }
  }
  const existing = NHL_HISTORICAL_SAMPLES.filter(row => row.season === options.season && row.gameType === 2);
  let batchPeriods = { games: [], report: null };
  if (options.allPeriods) {
    const pages = []; const expectedRows = coverage.outcomes.filter(row => row.gameType === 2).length * 2;
    for (let start = 0; start < expectedRows; start += 100) {
      const legacy = await read(`period-report-${options.season}-${start}.json`);
      if (verifyNhlHistorySource(legacy, nhlPeriodReportUrl(options.season, start, 1000))
        && Array.isArray(legacy.data?.data) && legacy.data.data.length === Math.min(100, Math.max(0, legacy.data.total - start))) {
        pages.push(legacy); progress(JSON.stringify({ step: `period-report-${options.season}-${start}.json`, cached: true })); continue;
      }
      const page = await acquire(`period-report-${options.season}-page100-${start}.json`, nhlPeriodReportUrl(options.season, start), { start });
      if (!page) continue;
      if (!Number.isSafeInteger(page.data?.total) || page.data.total < 0 || page.data.total > 10000) { attempts.push({ step: 'period_page', code: 'NHL_HISTORY_PERIOD_REPORT_TOTAL_INVALID' }); break; }
      pages.push(page);
    }
    // Reuse valid retained legacy pages without network requests. The provider
    // returned only 100 rows to each historical limit=1000 request. These do
    // not fill unrequested offsets; coverage QA explicitly reports those gaps.
    const legacyNames = (await fs.readdir(options.out)).filter(name => new RegExp(`^period-report-${options.season}-\\d+\\.json$`).test(name));
    for (const name of legacyNames) {
      const start = Number(name.match(/-(\d+)\.json$/)[1]);
      if (pages.some(page => page.start === start)) continue;
      const prior = await read(name);
      if (verifyNhlHistorySource(prior, nhlPeriodReportUrl(options.season, start, 1000))) pages.push(prior);
    }
    batchPeriods = joinNhlOfficialPeriodReports(coverage.outcomes, pages, { season: options.season });
    await save('period-report-coverage.json', batchPeriods.report);
  }
  const periodMerge = mergeNhlHistoricalPeriodSources([existing, periodGames, batchPeriods.games]);
  const fullPeriods = periodMerge.games;
  const exactFullPeriodCoverage = hasCompleteNhlPeriodCoverage(coverage.outcomes, periodMerge, { season: options.season });
  await save('period-games.json', fullPeriods);
  progress(JSON.stringify({ step: 'existing_model_block_walk_forward', completePeriodGames: fullPeriods.length, started: true }));
  const model = validateNhlHistoricalModelBlocks(fullPeriods, { initialTrainingGames: options.allPeriods ? 100 : 12, blockGames: options.allPeriods ? 300 : 20,
    onProgress: event => progress(JSON.stringify({ step: 'model_validation_progress', ...event })) });
  model.acquisition = { requestedGameIds: periodIds, acquiredRequestedGames: periodGames.length, missingGameIds: periodFailures,
    retainedExistingOfficialSamples: existing.length, fullSeasonPeriodCoverage: exactFullPeriodCoverage
      && coverage.manifest.completeOfficialRecordedRegularSeasonCoverage, sampling: options.allPeriods ? 'OFFICIAL_PAGINATED_FULL_SEASON_PERIOD_REPORT' : 'EVENLY_SPACED_CHRONOLOGICAL_GAME_INDEX_BEFORE_FETCH',
    batchPeriodCoverage: batchPeriods.report, attempts };
  model.acquisition.conflictingGameIds = periodMerge.conflictingGameIds;
  model.acquisition.corroboratedPeriodGameIds = periodMerge.corroboratedGameIds;
  await save('model-validation.json', model);
  const pbpManifest = [];
  for (const gameId of options.pbpGames) {
    const checkpoint = await acquire(`pbp-${gameId}.json`, `https://api-web.nhle.com/v1/gamecenter/${gameId}/play-by-play`);
    pbpManifest.push({ gameId, ok: Boolean(checkpoint), plays: checkpoint?.data?.plays?.length ?? null, source: checkpoint?.source || null });
  }
  await save('pbp-manifest.json', { leagueId: 'NHL', games: pbpManifest, strictPointInTimeVerified: false });
  coverage.manifest.completedAt = new Date().toISOString(); coverage.manifest.attempts = attempts; coverage.manifest.blocked = blocked;
  coverage.manifest.latestKnownSourceFailure = latestKnownSourceFailure;
  coverage.manifest.completePeriodGames = fullPeriods.length; coverage.manifest.periodGamesRequested = periodIds.length;
  coverage.manifest.periodCorpusHash = nhlHistoryHash(fullPeriods);
  coverage.manifest.periodCoverageVerified = model.acquisition.fullSeasonPeriodCoverage;
  coverage.manifest.batchPeriodCoverage = batchPeriods.report;
  coverage.manifest.periodGamesMissing = periodFailures; coverage.manifest.scoreValidationHash = nhlHistoryHash(benchmark);
  coverage.manifest.playoffValidationHash = nhlHistoryHash(playoff);
  coverage.manifest.periodConflictingGameIds = periodMerge.conflictingGameIds;
  coverage.manifest.modelValidationHash = nhlHistoryHash(model);
  await save('coverage.json', coverage.manifest);
  await save('acquisition-progress.json', { leagueId: 'NHL', startedAt, completedAt: coverage.manifest.completedAt, requestedTeams: selected,
    acquiredSchedules: schedules.map(row => row.team), attempts, blocked, finished: true });
  const result = { leagueId: 'NHL', season: options.season, coverage: coverage.manifest,
    scoreValidation: { folds: benchmark.walkForward.folds, brier: benchmark.walkForward.regulationBrier,
      testGames: benchmark.fixedHoldout.untouchedTest.folds }, modelValidation: { folds: model.folds, brier: model.regulationBrier }, output: options.out };
  progress(JSON.stringify({ step: 'completed', leagueId: 'NHL', season: options.season, output: options.out,
    requestedTeams: coverage.manifest.requestedTeams, acquiredTeams: coverage.manifest.acquiredTeams,
    requestedRegularGames: coverage.manifest.requestedRegularGames, acquiredRegularOutcomes: coverage.manifest.acquiredRegularOutcomes,
    completeOfficialRecordedRegularSeasonCoverage: coverage.manifest.completeOfficialRecordedRegularSeasonCoverage,
    completePeriodGames: fullPeriods.length, fullSeasonPeriodCoverage: model.acquisition.fullSeasonPeriodCoverage,
    missingPeriodReportGames: batchPeriods.report?.missingGameIds.length ?? null, periodConflicts: periodMerge.conflictingGameIds,
    blocked, latestKnownSourceFailure, scoreValidation: result.scoreValidation, modelValidation: result.modelValidation }));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseNhlHistoryRunnerArgs(process.argv.slice(2));
    if (options.help) console.log(NHL_HISTORY_RUNNER_USAGE);
    else {
      const result = await runNhlHistoryValidation(options);
      if (!result.coverage?.completeOfficialRecordedRegularSeasonCoverage || result.coverage?.blocked || result.coverage?.periodGamesMissing?.length
        || result.coverage?.periodConflictingGameIds?.length || (options.allPeriods && !result.coverage?.batchPeriodCoverage?.fullRequestedPeriodCoverage)) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
