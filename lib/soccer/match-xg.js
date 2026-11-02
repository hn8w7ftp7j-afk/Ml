import { createHash } from 'node:crypto';

export const MATCH_XG_VERSION = 'SOCCER-STATSBOMB-MATCH-XG-RESEARCH-v1';
export const MATCH_XG_MODEL_VERSION = 'SOCCER-NPXG-SHRUNK-ATTACK-DEFENCE-v1';
const restrictions = { accepted: false, formalEligible: false, modelEffectApplied: false, executable: false, W: null, R: null, S: null };
const sha = value => createHash('sha256').update(value).digest('hex');
export const matchXgHash = value => sha(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));
const date = value => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const time = Date.parse(`${value}T00:00:00Z`); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value; };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const seal = value => ({ ...value, contentHash: matchXgHash(value) });
const validSeal = value => { if (!value) return false; const { contentHash, ...body } = value; return contentHash === matchXgHash(body); };
const fail = code => ({ ok: false, version: MATCH_XG_VERSION, code, ...restrictions });
const pinned = (value, path) => {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'raw.githubusercontent.com'
    && !u.search && !u.hash && !u.username && !u.password
    && new RegExp(`^/(?:statsbomb|hudl)/open-data/([a-f0-9]{40})/data/${path}$`).test(u.pathname)
    ? u.pathname.split('/')[3] : null; } catch { return null; }
};
function document(value, path, now) {
  if (typeof value?.text !== 'string' || Buffer.byteLength(value.text) > 8 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(value.source?.contentHash || '') || sha(value.text) !== value.source.contentHash) return null;
  const commit = pinned(value.source.url, path), fetched = Date.parse(value.source.fetchedAt);
  if (!commit || typeof value.source.fetchedAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.source.fetchedAt) || !Number.isFinite(fetched) || fetched > now || value.source.provider !== 'STATSBOMB_OPEN_DATA') return null;
  try { return { data: JSON.parse(value.text), source: value.source, commit }; } catch { return null; }
}

/** Actual provider shots only. Dates are provider-local match dates, not invented
 * UTC kickoffs. Source retrieval today never proves historical prematch access. */
export function normalizeStatsBombMatchXg({ matchId, matchesDocument, eventsDocument, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(matchId) || matchId < 1 || !Number.isFinite(now)) return fail('MATCH_XG_SCOPE_INVALID');
  const index = document(matchesDocument, 'matches/\\d+/\\d+\\.json', now);
  const events = document(eventsDocument, `events/${matchId}\\.json`, now);
  if (!index || !events || index.commit !== events.commit || !Array.isArray(index.data) || !Array.isArray(events.data)) return fail('MATCH_XG_SOURCE_DOCUMENT_INVALID');
  const games = index.data.filter(game => game?.match_id === matchId);
  if (games.length !== 1) return fail('MATCH_XG_MATCH_INDEX_CONFLICT');
  const game = games[0], competitionId = game.competition?.competition_id, seasonId = game.season?.season_id;
  const league = competitionId === 2 ? 'epl' : competitionId === 16 ? 'ucl' : null;
  if (!league || !date(game.match_date) || game.match_status !== 'available'
    || new URL(index.source.url).pathname.split('/').slice(-2).join('/') !== `${competitionId}/${seasonId}.json`
    || !Number.isSafeInteger(game.home_team?.home_team_id) || !Number.isSafeInteger(game.away_team?.away_team_id)
    || game.home_team.home_team_id === game.away_team.away_team_id) return fail('MATCH_XG_MATCH_SCOPE_INVALID');
  if (game.match_date >= new Date(now).toISOString().slice(0, 10)) return fail('MATCH_XG_MATCH_NOT_HISTORICAL_COMPLETED_DATE');
  const teams = { home: game.home_team.home_team_id, away: game.away_team.away_team_id }, seen = new Set(), shots = [];
  if (events.data.length < 1 || events.data.length > 20000) return fail('MATCH_XG_EVENT_BUDGET_INVALID');
  const halfEnd = new Set();
  for (const event of events.data) {
    if (typeof event?.id !== 'string' || seen.has(event.id) || !Number.isSafeInteger(event.period) || event.period < 1 || event.period > 5) return fail('MATCH_XG_EVENT_ID_OR_PERIOD_INVALID');
    seen.add(event.id);
    if (event.type?.id === 34 && event.type.name === 'Half End') halfEnd.add(event.period);
    if (event.type?.name !== 'Shot' && event.type?.id !== 16) continue;
    if (event.type?.name !== 'Shot' || event.type.id !== 16) return fail('MATCH_XG_SHOT_TYPE_CONFLICT');
    if (![1, 2].includes(event.period)) continue; // ET and shootout never enter FT/HT regulation observations.
    const side = Object.keys(teams).find(side => teams[side] === event.team?.id), shot = event.shot;
    if (!side || !finite(shot?.statsbomb_xg) || shot.statsbomb_xg < 0 || shot.statsbomb_xg > 1
      || !Number.isSafeInteger(shot.type?.id) || typeof shot.type?.name !== 'string'
      || !Array.isArray(event.location) || event.location.length !== 2
      || !event.location.every(finite)) return fail('MATCH_XG_SHOT_VALUE_OR_IDENTITY_INVALID');
    if ((shot.type.id === 88) !== (shot.type.name === 'Penalty')) return fail('MATCH_XG_PENALTY_TYPE_CONFLICT');
    shots.push({ id: event.id, side, teamId: event.team.id, period: event.period, minute: event.minute,
      xg: shot.statsbomb_xg, penalty: shot.type.id === 88, shotType: shot.type.name,
      bodyPart: shot.body_part?.name || null, playPattern: event.play_pattern?.name || null,
      location: [...event.location], locationInNominalPitch: event.location[0] >= 0 && event.location[0] <= 120 && event.location[1] >= 0 && event.location[1] <= 80, goal: shot.outcome?.name === 'Goal' });
  }
  if (!halfEnd.has(1) || !halfEnd.has(2)) return fail('MATCH_XG_REGULATION_COMPLETENESS_UNVERIFIED');
  const periods = {};
  for (const [period, included] of [['FT', [1, 2]], ['HT', [1]]]) periods[period] = Object.fromEntries(['home', 'away'].map(side => {
    const selected = shots.filter(shot => shot.side === side && included.includes(shot.period));
    const sum = predicate => selected.filter(predicate).reduce((total, shot) => total + shot.xg, 0);
    const xg = sum(() => true), npxg = sum(shot => !shot.penalty), penaltyXg = sum(shot => shot.penalty);
    return [side, { xg, npxg, penaltyXg, shots: selected.length, penaltyShots: selected.filter(shot => shot.penalty).length,
      meanXgPerShot: selected.length ? xg / selected.length : null,
      headedXg: sum(shot => shot.bodyPart === 'Head'), openPlayNpxg: sum(shot => !shot.penalty && shot.playPattern === 'Regular Play'),
      shotGoals: selected.filter(shot => shot.goal).length }];
  }));
  return seal({ ok: true, version: MATCH_XG_VERSION, type: 'ACTUAL_PROVIDER_SHOT_OBSERVATION', provider: 'STATSBOMB_OPEN_DATA',
    league, matchId: String(matchId), competitionId, seasonId, season: game.season.season_name,
    matchDate: game.match_date, dateSemantics: 'PROVIDER_MATCH_DATE_NOT_VERIFIED_UTC_KICKOFF',
    teams: { home: { providerId: String(teams.home), name: game.home_team.home_team_name }, away: { providerId: String(teams.away), name: game.away_team.away_team_name } },
    periods, shots, originalEventCount: events.data.length, regulationPeriodsComplete: true,
    sourceCommit: index.commit, sourceDocuments: [index.source, events.source].map(source => ({ ...source })),
    originalDocumentsRetained: false, representation: 'NORMALIZED_REGULATION_SHOTS_WITH_ORIGINAL_DOCUMENT_SHA256_AND_PINNED_URLS',
    firstFetchedAt: [index.source.fetchedAt, events.source.fetchedAt].sort().at(-1), historicalAvailabilityVerified: false,
    interpretation: 'RETROSPECTIVELY_FETCHED_PROVIDER_XG_NOT_PREMATCH_FORECAST_OR_OPTA_XG', ...restrictions });
}

const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function rowsFor(observations, period) {
  const rows = [], seen = new Map();
  for (const value of observations) {
    const validTotals = ['FT', 'HT'].every(key => ['home', 'away'].every(side => {
      const totals = value?.periods?.[key]?.[side];
      return totals && ['xg', 'npxg', 'penaltyXg'].every(field => finite(totals[field]) && totals[field] >= 0)
        && Math.abs(totals.xg - totals.npxg - totals.penaltyXg) < 1e-9
        && Number.isSafeInteger(totals.shots) && totals.shots >= 0
        && Number.isSafeInteger(totals.penaltyShots) && totals.penaltyShots >= 0 && totals.penaltyShots <= totals.shots;
    }));
    if (!validSeal(value) || value.ok !== true || value.version !== MATCH_XG_VERSION || !date(value.matchDate)
      || value.provider !== 'STATSBOMB_OPEN_DATA' || !validTotals || !['FT', 'HT'].includes(period)
      || ['home', 'away'].some(side => !/^[1-9]\d{0,12}$/.test(value.teams?.[side]?.providerId || ''))
      || value.teams.home.providerId === value.teams.away.providerId) throw Error('MATCH_XG_RESEARCH_OBSERVATION_INVALID');
    const key = `${value.league}:${value.matchId}`;
    if (seen.has(key)) { if (seen.get(key) !== value.contentHash) throw Error('MATCH_XG_RESEARCH_DUPLICATE_CONFLICT'); continue; }
    seen.set(key, value.contentHash); rows.push(value);
  }
  if (new Set(rows.map(row => row.league)).size > 1) throw Error('MATCH_XG_RESEARCH_LEAGUES_MUST_NOT_POOL');
  return rows.sort((a, b) => a.matchDate.localeCompare(b.matchDate) || a.matchId.localeCompare(b.matchId));
}
/** Fixed shrinkage estimator, fitted against observed npxG (not goals). */
export function fitMatchXgTeamModel(observations, { period = 'FT', beforeDate, priorGames = 8 } = {}) {
  if (!['FT', 'HT'].includes(period) || !date(beforeDate) || !finite(priorGames) || priorGames <= 0) throw Error('MATCH_XG_RESEARCH_FIT_SCOPE_INVALID');
  const rows = rowsFor(observations, period).filter(row => row.matchDate < beforeDate);
  if (!rows.length) throw Error('MATCH_XG_RESEARCH_TRAINING_EMPTY');
  const meanHome = average(rows.map(row => row.periods[period].home.npxg)), meanAway = average(rows.map(row => row.periods[period].away.npxg));
  const global = (meanHome + meanAway) / 2, teams = {};
  if (!(global > 0)) throw Error('MATCH_XG_RESEARCH_ZERO_TRAINING_RATE');
  for (const row of rows) for (const side of ['home', 'away']) {
    const key = row.teams[side].providerId, opponent = side === 'home' ? 'away' : 'home';
    const team = teams[key] ||= { name: row.teams[side].name, matches: 0, npxgFor: 0, npxgAgainst: 0 };
    team.matches++; team.npxgFor += row.periods[period][side].npxg; team.npxgAgainst += row.periods[period][opponent].npxg;
  }
  for (const team of Object.values(teams)) {
    team.attackRatio = (team.npxgFor + priorGames * global) / (team.matches + priorGames) / global;
    team.concededRatio = (team.npxgAgainst + priorGames * global) / (team.matches + priorGames) / global;
  }
  return seal({ version: MATCH_XG_MODEL_VERSION, status: 'RETROSPECTIVE_RESEARCH_MODEL', provider: 'STATSBOMB_OPEN_DATA', league: rows[0].league,
    period, beforeDate, priorGames, meanHome, meanAway, teams,
    trainingMatches: rows.length, trainingThroughDate: rows.at(-1).matchDate,
    trainingHashes: rows.map(row => row.contentHash), historicalAvailabilityVerified: false,
    method: 'LEAGUE_HOME_AWAY_NPXG_MEAN_TIMES_SHRUNK_TEAM_ATTACK_AND_OPPONENT_CONCESSION_RATIOS',
    target: 'PROVIDER_OBSERVED_NON_PENALTY_XG_NOT_REALIZED_GOALS', ...restrictions });
}
export function predictMatchXgResearch(model, { homeProviderId, awayProviderId, matchDate } = {}) {
  if (!validSeal(model) || model.version !== MATCH_XG_MODEL_VERSION || !date(matchDate) || matchDate < model.beforeDate
    || typeof homeProviderId !== 'string' || typeof awayProviderId !== 'string' || !/^[1-9]\d{0,12}$/.test(homeProviderId || '') || !/^[1-9]\d{0,12}$/.test(awayProviderId || '') || homeProviderId === awayProviderId) throw Error('MATCH_XG_RESEARCH_PREDICTION_SCOPE_INVALID');
  const home = model.teams[homeProviderId], away = model.teams[awayProviderId];
  return { version: MATCH_XG_MODEL_VERSION, modelHash: model.contentHash, period: model.period, matchDate,
    homeNpxg: model.meanHome * (home?.attackRatio ?? 1) * (away?.concededRatio ?? 1),
    awayNpxg: model.meanAway * (away?.attackRatio ?? 1) * (home?.concededRatio ?? 1),
    coldStartTeams: [!home ? homeProviderId : null, !away ? awayProviderId : null].filter(Boolean),
    historicalAvailabilityVerified: false, ...restrictions };
}
function evaluate(model, rows) {
  const errors = [], baselineErrors = [], coldStart = new Set();
  for (const row of rows) {
    // In-sample diagnostics evaluate the frozen parameters, without claiming a
    // prediction was available at the historical match time.
    const p = predictMatchXgResearch(model, { homeProviderId: row.teams.home.providerId, awayProviderId: row.teams.away.providerId, matchDate: row.matchDate < model.beforeDate ? model.beforeDate : row.matchDate });
    p.coldStartTeams.forEach(id => coldStart.add(id));
    for (const side of ['home', 'away']) { errors.push(p[`${side}Npxg`] - row.periods[model.period][side].npxg); baselineErrors.push(model[side === 'home' ? 'meanHome' : 'meanAway'] - row.periods[model.period][side].npxg); }
  }
  const metric = values => ({ mae: average(values.map(Math.abs)), mse: average(values.map(value => value ** 2)) });
  return { games: rows.length, teamObservations: errors.length, candidate: metric(errors), leagueMeanBaseline: metric(baselineErrors), coldStartTeams: coldStart.size };
}
export function fitMatchXgResearch(observations, { period = 'FT', trainingBefore = '2016-01-01', testBegins = '2016-03-01', priorGames = 8 } = {}) {
  if (!date(trainingBefore) || !date(testBegins) || trainingBefore >= testBegins) throw Error('MATCH_XG_RESEARCH_SPLIT_INVALID');
  const rows = rowsFor(observations, period), model = fitMatchXgTeamModel(rows, { period, beforeDate: trainingBefore, priorGames });
  const training = rows.filter(row => row.matchDate < trainingBefore), calibration = rows.filter(row => row.matchDate >= trainingBefore && row.matchDate < testBegins), test = rows.filter(row => row.matchDate >= testBegins);
  return seal({ version: MATCH_XG_MODEL_VERSION, period, status: 'RETROSPECTIVE_RESEARCH_DIAGNOSTIC', model,
    protocol: { trainingBefore, testBegins, priorGames, splitUnit: 'WHOLE_PROVIDER_LOCAL_MATCH_DATE', parameterSelection: 'EXPLICIT_PRIOR_GAMES_NO_HOLDOUT_TUNING',
      independentUntouchedTestVerified: false, testUsedToFit: false, calibrationUsedToFit: false },
    coverage: { provider: 'STATSBOMB_OPEN_DATA', league: model.league, games: rows.length,
      firstMatchDate: rows[0].matchDate, lastMatchDate: rows.at(-1).matchDate, seasonIds: [...new Set(rows.map(row => row.seasonId))] },
    training: evaluate(model, training), calibration: evaluate(model, calibration), test: evaluate(model, test),
    historicalAvailabilityVerified: false, interpretation: 'DESCRIPTIVE_CHRONOLOGICAL_HOLDOUT_USING_BACKFILLED_SOURCE_NOT_INDEPENDENT_PREMATCH_ACCEPTANCE', ...restrictions });
}

/** Live calls can expose research coverage, never attach decade-old observations
 * to today's fixture or match cross-provider teams by an unreviewed name. */
export function matchXgResearchForGame(game, artifact, { now = Date.now() } = {}) {
  const created = Date.parse(artifact?.createdAt), available = Number.isFinite(now) && typeof artifact?.createdAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(artifact.createdAt) && Number.isFinite(created) && created <= now
    && validSeal(artifact) && artifact.version === MATCH_XG_VERSION && artifact.provider === 'STATSBOMB_OPEN_DATA';
  const reports = available ? artifact.reports || {} : {}, report = reports[game?.league]?.FT || null;
  return { ok: false, version: MATCH_XG_VERSION, status: 'UNKNOWN', gameId: game?.id || null, league: game?.league || null,
    reason: !available ? 'MATCH_XG_ARTIFACT_UNAVAILABLE_AT_CUTOFF' : report ? 'MATCH_XG_CURRENT_SAME_PROVIDER_HISTORY_UNAVAILABLE' : 'MATCH_XG_LEAGUE_SOURCE_COVERAGE_UNAVAILABLE',
    researchAvailable: Boolean(report), artifactCreatedAt: available ? artifact.createdAt : null, artifactHash: available ? artifact.contentHash : null,
    researchCoverage: report?.coverage || null,
    researchMetrics: report ? { calibration: report.calibration, test: report.test } : null,
    provider: 'STATSBOMB_OPEN_DATA', sourceAttribution: 'StatsBomb Open Data', officialOpenDataUrl: 'https://github.com/statsbomb/open-data',
    originalDocumentsRetained: false, historicalAvailabilityVerified: false, ...restrictions };
}
