import { validNhlDate, validateNhlIdentity } from './identity.js';
import { fetchNhlClubSchedule, fetchNhlRoster, fetchNhlTeamStatistics } from './data.js';
import { fetchNhlPersonnel, mergeNhlPersonnelIdentitySources } from './personnel-feed.js';
import { NHL_FEATURE_NAMES } from './model.js';

export const NHL_PREGAME_EVIDENCE_VERSION = 'NHL-OFFICIAL-LIVE-PREGAME-EVIDENCE-v1';
const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && validNhlDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const cancelled = new Set(['CANCELED', 'CANCELLED', 'CANC', 'PPD', 'POSTPONED', 'SUSP', 'SUSPENDED']);
const participating = new Set(['OFF', 'FINAL', 'FUT', 'PRE', 'LIVE', 'CRIT']);
const sides = ['away', 'home'];

function sourceEligible(source, asOf, maxAgeMs, provider = 'NHL') {
  const observed = stamp(source?.fetchedAt);
  return source?.provider === provider && /^[a-f0-9]{64}$/.test(source?.contentHash || '')
    && observed != null && observed <= asOf && asOf - observed <= maxAgeMs
    && ['sourceUpdatedAt', 'sourcePublishedAt', 'availableAt', 'requestedAt', 'observedAt'].every(key =>
      source[key] == null || (stamp(source[key]) != null && stamp(source[key]) <= observed));
}

// Only an acquired, complete exact-club schedule can establish a previous game
// or a seven-day count. Elapsed hours mean scheduled start-to-start hours;
// neither estimated final whistles nor invented travel distances are used.
export function buildNhlPregameScheduleFeatures(game, side, schedule, { asOf, maxAgeMs = 5 * 60_000 } = {}) {
  const empty = reason => ({ teamId: game?.[`${side}TeamId`] ?? null, restHours: null, gamesLastSevenDays: null,
    precedingGameId: null, estimated: false, source: schedule?.source || null, features: {}, issues: [reason] });
  const cutoff = stamp(asOf); const start = stamp(game?.startTimeUTC);
  if (!sides.includes(side) || !validateNhlIdentity(game).ok || cutoff == null || start == null || cutoff >= start
    || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return empty('NHL_PREGAME_SCHEDULE_TIME_OR_IDENTITY_INVALID');
  const teamId = game[`${side}TeamId`]; const abbrev = game[side]?.abbrev || game[`${side}Abbrev`];
  const source = schedule?.source; const coverage = schedule?.coverage;
  const expectedUrl = `https://api-web.nhle.com/v1/club-schedule-season/${abbrev}/${game.season}`;
  const coverageFrom = stamp(coverage?.from); const coverageTo = stamp(coverage?.to);
  if (schedule?.ok !== true || !Array.isArray(schedule.games) || schedule.season !== game.season
    || schedule.abbrev !== abbrev || coverage?.complete !== true || coverage.teamAbbrev !== abbrev
    || coverage.season !== game.season || source?.url !== expectedUrl || coverage.source?.contentHash !== source.contentHash
    || coverage.source?.url !== source.url || coverage.source?.fetchedAt !== source.fetchedAt
    || !sourceEligible(source, cutoff, maxAgeMs) || coverageFrom == null || coverageTo == null
    || coverageFrom > start - 7 * 86_400_000 || coverageTo <= start) return empty('NHL_PREGAME_SCHEDULE_COVERAGE_UNVERIFIED');
  const ids = new Map();
  for (const row of schedule.games) {
    if (!validateNhlIdentity(row).ok || row.season !== game.season || ![row.awayTeamId, row.homeTeamId].includes(teamId)) return empty('NHL_PREGAME_SCHEDULE_IDENTITY_CONFLICT');
    const prior = ids.get(row.gameId);
    if (prior && (prior.startTimeUTC !== row.startTimeUTC || prior.awayTeamId !== row.awayTeamId || prior.homeTeamId !== row.homeTeamId)) return empty('NHL_PREGAME_SCHEDULE_DUPLICATE_CONFLICT');
    ids.set(row.gameId, row);
  }
  const target = ids.get(String(game.gameId));
  if (!target || stamp(target.startTimeUTC) !== start || target.awayTeamId !== game.awayTeamId || target.homeTeamId !== game.homeTeamId
    || target.gameType !== game.gameType) return empty('NHL_PREGAME_SCHEDULE_TARGET_CONFLICT');
  const priorRows = [...ids.values()].filter(row => row.gameId !== String(game.gameId) && stamp(row.startTimeUTC) < start
    && !cancelled.has(row.gameState ?? row.status) && !cancelled.has(row.gameScheduleState));
  if (priorRows.some(row => !participating.has(row.gameState ?? row.status) || row.gameScheduleState !== 'OK')) return empty('NHL_PREGAME_SCHEDULE_PARTICIPATION_UNCERTAIN');
  const prior = priorRows
    .sort((a, b) => stamp(b.startTimeUTC) - stamp(a.startTimeUTC));
  const recent = prior.filter(row => stamp(row.startTimeUTC) >= start - 7 * 86_400_000);
  const preceding = prior[0];
  const restHours = preceding && stamp(preceding.startTimeUTC) >= coverageFrom ? (start - stamp(preceding.startTimeUTC)) / 3_600_000 : null;
  const estimated = [...recent, ...(preceding ? [preceding] : [])].some(row => !['OFF', 'FINAL'].includes(row.gameState ?? row.status));
  const entry = (value, basis) => ({ value, availableAt: source.fetchedAt, source, basis });
  return { teamId, restHours, gamesLastSevenDays: recent.length, precedingGameId: preceding?.gameId || null,
    precedingGameStatus: preceding?.gameState ?? preceding?.status ?? null, estimated, source, coverage,
    features: { ...(restHours == null ? {} : { [`${side}RestHours`]: entry(restHours, 'SCHEDULED_START_TO_START_HOURS') }),
      [`${side}GamesLastSevenDays`]: entry(recent.length, 'PRIOR_SCHEDULED_GAMES_IN_168_HOURS_EXCLUDING_TARGET') },
    issues: restHours == null ? ['NHL_PREGAME_PRECEDING_GAME_NOT_IN_COVERAGE'] : [],
    warnings: estimated ? ['NHL_PREGAME_SCHEDULE_CONTAINS_UNPLAYED_GAMES'] : [] };
}

const blocked = (game, asOf, code) => ({ ok: false, status: 'BLOCK', league: 'NHL', leagueId: 'NHL',
  version: NHL_PREGAME_EVIDENCE_VERSION, gameId: String(game?.gameId || ''), asOf, features: {}, sources: [], personnel: null,
  context: null, teamStatistics: null, missing: [...NHL_FEATURE_NAMES], missingSources: [], issues: [code], warnings: [], code });

// Acquisition begins only for an unplayed target and ends with another cutoff
// check. A request straddling puck drop is blocked, never backdated.
export async function fetchNhlPregameEvidence(game, { now = Date.now, fetchImpl = globalThis.fetch,
  timeoutMs = 10_000, maxSourceAgeMs = 5 * 60_000 } = {}) {
  const started = typeof now === 'function' ? now() : NaN;
  const asOfStart = Number.isFinite(started) && Number.isFinite(new Date(started).getTime()) ? new Date(started).toISOString() : null;
  if (!validateNhlIdentity(game).ok || !asOfStart || stamp(game.startTimeUTC) == null
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 20_000
    || !Number.isFinite(maxSourceAgeMs) || maxSourceAgeMs < 0) return blocked(game, asOfStart, 'NHL_PREGAME_EVIDENCE_OPTIONS_OR_IDENTITY_INVALID');
  if (started >= stamp(game.startTimeUTC) || !['FUT', 'PRE'].includes(game.gameState ?? game.status)
    || game.gameScheduleState !== 'OK') return blocked(game, asOfStart, 'NHL_PREGAME_TARGET_ALREADY_STARTED_OR_UNAVAILABLE');
  const opts = { now, fetchImpl, timeoutMs, ttlMs: Math.min(60_000, maxSourceAgeMs), retry: false };
  const tasks = sides.map(async side => {
    const team = { ...(game[side] || {}), teamId: game[`${side}TeamId`], abbrev: game[side]?.abbrev || game[`${side}Abbrev`] };
    const results = await Promise.allSettled([
      fetchNhlClubSchedule(team, game.season, opts), fetchNhlRoster(team, game.season, opts),
      fetchNhlTeamStatistics(team, game.season, game.gameType, opts),
    ]);
    const [schedule, roster, statistics] = results.map(result => result.status === 'fulfilled' ? result.value
      : { ok: false, code: 'NHL_PREGAME_SOURCE_READ_FAILED' });
    return { side, schedule, roster, statistics, identities: mergeNhlPersonnelIdentitySources(roster, statistics, game, side) };
  });
  const rowsPromise = Promise.all(tasks);
  const personnelPromise = fetchNhlPersonnel(game, { ...opts, loadRoster: async (_team, _season, side) =>
    (await rowsPromise).find(row => row.side === side)?.identities });
  const [rows, personnel] = await Promise.all([rowsPromise, personnelPromise.catch(() => ({ ok: false, code: 'NHL_PREGAME_PERSONNEL_READ_FAILED' }))]);
  const finished = now();
  const asOf = Number.isFinite(finished) && Number.isFinite(new Date(finished).getTime()) ? new Date(finished).toISOString() : null;
  if (!asOf || finished < started) return blocked(game, asOf, 'NHL_PREGAME_EVIDENCE_CLOCK_INVALID');
  if (finished >= stamp(game.startTimeUTC)) return blocked(game, asOf, 'NHL_PREGAME_EVIDENCE_ACQUIRED_AFTER_START');
  const context = {}; const features = {}; const sources = []; const missingSources = []; const warnings = []; const issues = [];
  const teamStatistics = {};
  for (const row of rows) {
    context[row.side] = buildNhlPregameScheduleFeatures(game, row.side, row.schedule, { asOf, maxAgeMs: maxSourceAgeMs });
    Object.assign(features, context[row.side].features);
    warnings.push(...context[row.side].issues, ...(context[row.side].warnings || []));
    for (const response of [row.schedule, row.roster, row.statistics]) {
      if (response.ok && sourceEligible(response.source, finished, maxSourceAgeMs)) sources.push(response.source);
      else {
        const code = response.code || (response.ok ? 'NHL_PREGAME_SOURCE_TIME_OR_HASH_INVALID' : 'NHL_PREGAME_SOURCE_UNAVAILABLE');
        warnings.push(`${row.side}:${code}`);
        missingSources.push({ side: row.side, code, source: response.source || null, httpStatus: response.httpStatus || null });
      }
    }
    // Club player totals inform identity/display only. They do not override
    // regulation-goal training features or masquerade as possession/xG rates.
    teamStatistics[row.side] = row.statistics.ok && sourceEligible(row.statistics.source, finished, maxSourceAgeMs)
      ? { ...row.statistics, usage: 'PERSONNEL_IDENTITY_AND_SOURCE_DISPLAY_ONLY' } : null;
  }
  if (personnel.ok && sourceEligible(personnel.source, finished, maxSourceAgeMs, 'NHL_EDITORIAL')) sources.push(personnel.source);
  else missingSources.push({ code: personnel.code || 'NHL_PREGAME_PERSONNEL_SOURCE_TIME_OR_HASH_INVALID', source: personnel.source || null });
  if (!personnel.ok || !personnel.matched || !personnel.pointInTimeEligible || personnel.freshness?.fresh !== true)
    warnings.push(personnel.code || 'NHL_PREGAME_PERSONNEL_EVIDENCE_MISSING_OR_INELIGIBLE');
  warnings.push(...(personnel.qa?.warnings || []));
  issues.push(...(personnel.qa?.issues || []));
  const missing = NHL_FEATURE_NAMES.filter(name => features[name] == null);
  return { ok: true, status: issues.length ? 'PARTIAL' : missing.length || warnings.length ? 'WARNING' : 'OK',
    league: 'NHL', leagueId: 'NHL', version: NHL_PREGAME_EVIDENCE_VERSION, gameId: String(game.gameId), asOf,
    features, sources: [...new Map(sources.map(source => [`${source.url}:${source.contentHash || source.fetchedAt}`, source])).values()],
    personnel, context, teamStatistics, missing, missingSources, issues: [...new Set(issues)], warnings: [...new Set(warnings)],
    pointInTimeEligible: true, advancedMetricsAvailable: false };
}
