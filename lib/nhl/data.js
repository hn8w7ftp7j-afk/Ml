import { createHash } from 'node:crypto';
import { nhlDate, validNhlDate, normalizeNhlTeam, normalizeNhlPlayer, validateNhlIdentity } from './identity.js';

export const NHL_DATA_VERSION = 'NHL-OFFICIAL-DATA-v1.0.1';
export const NHL_SOURCES = Object.freeze({
  schedule: { provider: 'NHL', url: 'https://api-web.nhle.com/v1/schedule/', role: 'official_schedule_identity_results' },
  gamecenter: { provider: 'NHL', url: 'https://api-web.nhle.com/v1/gamecenter/', role: 'official_periods_events_boxscore_results' },
  roster: { provider: 'NHL', url: 'https://api-web.nhle.com/v1/roster/', role: 'official_team_player_identity' },
  player: { provider: 'NHL', url: 'https://api-web.nhle.com/v1/player/', role: 'official_player_history_statistics' },
  statistics: { provider: 'NHL', url: 'https://api.nhle.com/stats/rest/en/', role: 'official_team_player_goalie_statistics' },
  lineupNews: { provider: 'NHL', url: 'https://www.nhl.com/news/nhl-lineup-projections-2025-26-season', role: 'dated_editorial_lineup_injury_evidence', structuredFeed: false },
  moneyPuck: { provider: 'MoneyPuck', url: 'https://moneypuck.com/data.htm', role: 'optional_xg_5v5_goalie', productionEnabled: false, reason: 'Provider permits listed downloads for non-commercial/ad-hoc journalism; other use requires provider permission. No automatic scraping.' },
});

const cacheByFetch = new WeakMap();
const integer = value => value !== null && value !== undefined && value !== '' && Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finalStates = new Set(['OFF', 'FINAL']);
function fail(code, details = {}) { return { ok: false, status: 'UNAVAILABLE', code, ...details }; }
function getStore(fetchImpl) { if (!cacheByFetch.has(fetchImpl)) cacheByFetch.set(fetchImpl, new Map()); return cacheByFetch.get(fetchImpl); }

// Bounded, deduplicated official reads. A 403 is never retried immediately; a
// 429/5xx/network failure gets at most one bounded retry and a negative cache.
export async function fetchNhlJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 6500, ttlMs = 60_000, negativeTtlMs = 30_000, now = Date.now, retry = true } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return fail('NHL_SOURCE_URL_NOT_ALLOWED'); }
  if (parsed.protocol !== 'https:' || !['api-web.nhle.com', 'api.nhle.com'].includes(parsed.hostname) || parsed.username || parsed.password) return fail('NHL_SOURCE_URL_NOT_ALLOWED');
  if (typeof fetchImpl !== 'function') return fail('NHL_FETCH_UNAVAILABLE');
  const store = getStore(fetchImpl);
  const cached = store.get(url);
  // Coalesce network work, never share mutable source payloads or their hashes
  // with consumers. Normalizers/UI may enrich a copy, not the retained evidence.
  if (cached?.inflight) return structuredClone(await cached.inflight);
  if (cached && cached.expiresAt > now()) return { ...structuredClone(cached.value), cached: true };
  const operation = (async () => {
    let result;
    for (let attempt = 0; attempt < (retry ? 2 : 1); attempt += 1) {
      const controller = new AbortController();
      let timer;
      const fetchedAt = new Date(now()).toISOString();
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('NHL source timeout'), { code: 'NHL_SOURCE_TIMEOUT' })); }, timeoutMs); });
        const response = await Promise.race([fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal, cache: 'no-store' }), timeout]);
        if (!response?.ok) {
          const status = Number(response?.status) || null;
          result = fail(status === 403 ? 'NHL_SOURCE_FORBIDDEN' : status === 429 ? 'NHL_SOURCE_RATE_LIMITED' : 'NHL_SOURCE_HTTP_ERROR', { httpStatus: status, source: { provider: 'NHL', url, fetchedAt }, attempts: attempt + 1 });
          if (status === 403 || status === 404 || (status && status < 500 && status !== 429)) break;
          // Do not wait past the request budget or defeat an upstream retry-after.
          if (status === 429) break;
          if (attempt === 0 && retry) continue;
        } else {
          let data;
          try { data = await Promise.race([response.json(), new Promise((_, reject) => { controller.signal.addEventListener('abort', () => reject(new Error('NHL body timeout')), { once: true }); })]); }
          catch { result = fail(controller.signal.aborted ? 'NHL_SOURCE_TIMEOUT' : 'NHL_SOURCE_FORMAT_CHANGED', { source: { provider: 'NHL', url, fetchedAt }, attempts: attempt + 1 }); break; }
          if (!data || typeof data !== 'object' || Array.isArray(data)) { result = fail('NHL_SOURCE_FORMAT_CHANGED', { source: { provider: 'NHL', url, fetchedAt }, attempts: attempt + 1 }); break; }
          const modified = Date.parse(response.headers?.get?.('last-modified'));
          result = { ok: true, status: 'OK', data, source: { provider: 'NHL', url, fetchedAt, sourceUpdatedAt: Number.isFinite(modified) && modified <= now() ? new Date(modified).toISOString() : null, contentHash: hash(data) }, attempts: attempt + 1 };
          break;
        }
      } catch (error) { result = fail(controller.signal.aborted ? 'NHL_SOURCE_TIMEOUT' : 'NHL_SOURCE_NETWORK_ERROR', { source: { provider: 'NHL', url, fetchedAt }, attempts: attempt + 1 }); }
      finally { clearTimeout(timer); }
    }
    const value = result || fail('NHL_SOURCE_UNAVAILABLE');
    store.set(url, { value, expiresAt: now() + (value.ok ? ttlMs : negativeTtlMs) });
    while (store.size > 256) store.delete(store.keys().next().value);
    return value;
  })();
  store.set(url, { inflight: operation, expiresAt: 0 });
  return structuredClone(await operation);
}

export function normalizeNhlScheduleGame(raw, source = null) {
  const away = normalizeNhlTeam(raw?.awayTeam);
  const home = normalizeNhlTeam(raw?.homeTeam);
  const game = { leagueId: 'NHL', gameId: String(raw?.id || ''), officialGameId: String(raw?.id || ''), season: Number(raw?.season), gameType: Number(raw?.gameType), startTimeUTC: raw?.startTimeUTC || null, taipeiDate: nhlDate(raw?.startTimeUTC), officialDate: raw?.gameDate || null, awayTeamId: away?.teamId || null, homeTeamId: home?.teamId || null, away, home, venue: raw?.venue?.default || null, venueTimezone: raw?.venueTimezone || null, neutralSite: raw?.neutralSite === true, gameState: raw?.gameState || 'UNKNOWN', gameScheduleState: raw?.gameScheduleState || 'UNKNOWN', final: finalStates.has(raw?.gameState) ? { awayGoals: integer(raw?.awayTeam?.score), homeGoals: integer(raw?.homeTeam?.score) } : null, outcomeType: raw?.gameOutcome?.lastPeriodType || (finalStates.has(raw?.gameState) ? raw?.periodDescriptor?.periodType : null) || null, source, seasonPhase: Number(raw?.gameType) === 1 ? 'PRESEASON_SHADOW' : Number(raw?.gameType) === 2 ? 'REGULAR' : 'PLAYOFFS', periods: null, regulation: null, outcomeAvailableAt: null, historical: finalStates.has(raw?.gameState) };
  game.identity = validateNhlIdentity(game);
  Object.assign(game, { league: 'NHL', northAmericaDate: game.officialDate, awayName: away?.name || null, homeName: home?.name || null, awayAbbrev: away?.abbrev || null, homeAbbrev: home?.abbrev || null, status: game.gameState });
  return game;
}

export function normalizeNhlSchedule(payload, source = null) {
  if (!Array.isArray(payload?.gameWeek) && !Array.isArray(payload?.games)) return fail('NHL_SCHEDULE_SCHEMA_INVALID', { games: [], source });
  const raws = Array.isArray(payload.games) ? payload.games : payload.gameWeek.flatMap(day => Array.isArray(day.games) ? day.games.map(g => ({ ...g, gameDate: g.gameDate || day.date })) : []);
  const unique = new Map(); const issues = []; const conflicts = new Set();
  for (const raw of raws) {
    const game = normalizeNhlScheduleGame(raw, source);
    if (!game.identity.ok) { issues.push(...game.identity.issues); continue; }
    if (conflicts.has(game.gameId)) continue;
    const prior = unique.get(game.gameId);
    if (prior && prior.identity.identityKey !== game.identity.identityKey) { issues.push('NHL_SCHEDULE_DUPLICATE_IDENTITY_CONFLICT'); conflicts.add(game.gameId); unique.delete(game.gameId); continue; }
    unique.set(game.gameId, game);
  }
  return { ok: !issues.length, status: issues.length ? 'BLOCK' : 'OK', games: [...unique.values()].sort((a, b) => a.startTimeUTC.localeCompare(b.startTimeUTC)), issues: [...new Set(issues)], source };
}

export async function fetchNhlSchedule(date, options = {}) {
  if (!validNhlDate(date)) return fail('NHL_INVALID_DATE', { date, leagueId: 'NHL', games: [] });
  const anchor = new Date(`${date}T00:00:00Z`); anchor.setUTCDate(anchor.getUTCDate() - 1);
  const result = await fetchNhlJson(`${NHL_SOURCES.schedule.url}${anchor.toISOString().slice(0, 10)}`, options);
  if (!result.ok) return { ...result, leagueId: 'NHL', date, games: [], issues: [result.code] };
  const normalized = normalizeNhlSchedule(result.data, result.source);
  return { ...normalized, leagueId: 'NHL', date, cached: result.cached === true, games: normalized.games.filter(game => game.taipeiDate === date) };
}

export async function fetchNhlClubSchedule(team, season, options = {}) {
  const abbrev = String(typeof team === 'object' ? team.abbrev : team).toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(abbrev) || !/^\d{8}$/.test(String(season))) return fail('NHL_INVALID_CLUB_SCHEDULE_IDENTITY', { games: [] });
  const result = await fetchNhlJson(`https://api-web.nhle.com/v1/club-schedule-season/${abbrev}/${season}`, { ttlMs: 5 * 60_000, ...options });
  if (!result.ok) return { ...result, games: [] };
  if (Number(result.data.currentSeason) !== Number(season) || !Array.isArray(result.data.games)) return fail('NHL_CLUB_SCHEDULE_SCHEMA_INVALID', { games: [], source: result.source });
  const normalized = normalizeNhlSchedule(result.data, result.source);
  if (normalized.games.some(game => Number(game.season) !== Number(season) || ![game.awayAbbrev, game.homeAbbrev].includes(abbrev))) return fail('NHL_CLUB_SCHEDULE_TEAM_MISMATCH', { games: [], source: result.source });
  // The endpoint is the complete published schedule for this club and season,
  // as observed at fetchedAt; it is not an archived pregame snapshot.
  const startYear = Number(String(season).slice(0, 4));
  return { ...normalized, abbrev, season: Number(season), coverage: { complete: normalized.ok, scope: 'ONE_CLUB_PUBLISHED_SEASON_SCHEDULE', teamAbbrev: abbrev, season: Number(season), from: `${startYear}-07-01T00:00:00Z`, to: `${startYear + 1}-07-01T00:00:00Z`, source: result.source, pregamePointInTime: false } };
}

export function normalizeNhlGame(landing, { source = null, boxscore = null, boxscoreSource = null, plays = null, playsSource = null, expected = null } = {}) {
  const game = normalizeNhlScheduleGame(landing, source);
  const identity = validateNhlIdentity(game, expected);
  const issues = [...identity.issues];
  const complete = finalStates.has(landing?.gameState);
  const scoring = landing?.summary?.scoring;
  if (complete && landing?.limitedScoring !== true && Array.isArray(scoring)) {
    const periods = Array.from({ length: 3 }, () => ({ awayGoals: 0, homeGoals: 0 }));
    let invalid = false;
    for (const period of scoring) {
      const n = Number(period?.periodDescriptor?.number);
      if (period?.periodDescriptor?.periodType !== 'REG' || n < 1 || n > 3) continue;
      if (!Array.isArray(period.goals)) { invalid = true; continue; }
      for (const goal of period.goals) {
        const abbrev = goal?.teamAbbrev?.default || goal?.teamAbbrev;
        if (abbrev === game.away?.abbrev) periods[n - 1].awayGoals += 1;
        else if (abbrev === game.home?.abbrev) periods[n - 1].homeGoals += 1;
        else invalid = true;
      }
    }
    const regulation = periods.reduce((a, p) => ({ awayGoals: a.awayGoals + p.awayGoals, homeGoals: a.homeGoals + p.homeGoals }), { awayGoals: 0, homeGoals: 0 });
    const final = game.final;
    const regValid = game.outcomeType === 'REG' && final?.awayGoals !== final?.homeGoals && final?.awayGoals === regulation.awayGoals && final?.homeGoals === regulation.homeGoals;
    const extraValid = ['OT', 'SO'].includes(game.outcomeType) && regulation.awayGoals === regulation.homeGoals && final?.awayGoals + final?.homeGoals === regulation.awayGoals + regulation.homeGoals + 1 && Math.abs(final?.awayGoals - final?.homeGoals) === 1;
    if (!invalid && (regValid || extraValid)) { game.periods = periods; game.regulation = regulation; }
    else issues.push('NHL_SCORING_PERIOD_TOTAL_MISMATCH');
  } else if (complete) issues.push('NHL_COMPLETE_PERIOD_DATA_MISSING');
  if (boxscore) {
    const check = validateNhlIdentity(normalizeNhlScheduleGame(boxscore, boxscoreSource), game);
    if (!check.ok) issues.push(...check.issues);
    else {
      const sideStats = side => {
        const rows = boxscore?.playerByGameStats?.[`${side}Team`] || {};
        return { skaters: [...(rows.forwards || []), ...(rows.defense || [])].map(row => ({ ...row, playerId: integer(row.playerId), teamId: game[`${side}TeamId`], source: boxscoreSource })), goalies: (rows.goalies || []).map(row => ({ ...row, playerId: integer(row.playerId), teamId: game[`${side}TeamId`], source: boxscoreSource, confirmationScope: 'OBSERVED_GAME_PARTICIPATION', pregameConfirmed: false })) };
      };
      game.playerStatistics = { away: sideStats('away'), home: sideStats('home') };
    }
  }
  game.teamStatistics = { away: { shotsOnGoal: integer(landing?.awayTeam?.sog) }, home: { shotsOnGoal: integer(landing?.homeTeam?.sog) }, source };
  game.goalie = { away: null, home: null, status: 'PREGAME_EVIDENCE_REQUIRED' };
  game.injury = { status: 'UNKNOWN', availableAt: null, players: null, source: null };
  game.lineup = { status: 'UNKNOWN', availableAt: null, players: null, source: null };
  game.advanced = { fiveOnFive: null, xGF: null, xGA: null, goalieGsax: null, status: 'SOURCE_NOT_CONNECTED' };
  game.qa = { status: issues.length ? 'BLOCK' : 'PASS', issues: [...new Set(issues)], warnings: ['NHL_PREGAME_INJURY_LINEUP_GOALIE_EVIDENCE_MISSING', 'NHL_XG_5V5_FEATURES_UNAVAILABLE'], canUseHistoricalPeriods: Boolean(game.periods && identity.ok && !issues.length), pregameModelReady: false };
  if (plays) {
    if (String(plays.id) !== game.gameId || plays?.awayTeam?.id !== game.awayTeamId || plays?.homeTeam?.id !== game.homeTeamId) { game.qa.issues.push('NHL_PBP_IDENTITY_MISMATCH'); game.qa.status = 'BLOCK'; game.qa.canUseHistoricalPeriods = false; }
    else {
      game.playByPlay = { events: Array.isArray(plays.plays) ? plays.plays : [], rosterSpots: Array.isArray(plays.rosterSpots) ? plays.rosterSpots : [], source: playsSource };
      game.observedSituationStatistics = deriveNhlEventStatistics(plays, playsSource);
    }
  }
  return game;
}

export async function fetchNhlGame(gameId, options = {}) {
  if (!/^\d{10}$/.test(String(gameId))) return fail('NHL_INVALID_GAME_ID', { game: null });
  const result = await fetchNhlJson(`${NHL_SOURCES.gamecenter.url}${gameId}/landing`, options);
  if (!result.ok) return { ...result, game: null, issues: [result.code] };
  const additional = options.includeDetails === true ? await Promise.all(['boxscore', 'play-by-play'].map(path => fetchNhlJson(`${NHL_SOURCES.gamecenter.url}${gameId}/${path}`, options))) : [];
  const [box, pbp] = additional;
  const game = normalizeNhlGame(result.data, { source: result.source, boxscore: box?.ok ? box.data : null, boxscoreSource: box?.source, plays: pbp?.ok ? pbp.data : null, playsSource: pbp?.source, expected: { gameId: String(gameId), ...options.expected } });
  const issues = [...game.qa.issues, ...additional.filter(row => !row.ok).map(row => row.code)];
  return { ok: game.qa.status !== 'BLOCK', status: game.qa.status, game, sources: [result.source, ...additional.map(row => row.source)].filter(Boolean), issues };
}

export async function fetchNhlRoster(team, season = 'current', options = {}) {
  const abbrev = String(typeof team === 'object' ? team.abbrev : team).toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(abbrev) || !/^(?:current|\d{8})$/.test(String(season))) return fail('NHL_INVALID_ROSTER_IDENTITY', { players: [] });
  const result = await fetchNhlJson(`${NHL_SOURCES.roster.url}${abbrev}/${season}`, { ttlMs: 5 * 60_000, ...options });
  if (!result.ok) return { ...result, players: [] };
  if (!['forwards', 'defensemen', 'goalies'].every(key => Array.isArray(result.data[key]))) return fail('NHL_ROSTER_SCHEMA_INVALID', { source: result.source, players: [] });
  const teamId = integer(typeof team === 'object' ? team.teamId : options.teamId);
  const rawPlayers = ['forwards', 'defensemen', 'goalies'].flatMap(key => result.data[key]);
  const players = rawPlayers.map(player => normalizeNhlPlayer(player, { teamId, source: result.source }));
  if (players.some(player => !player)
    || new Set(players.map(player => player?.playerId)).size !== players.length
    || rawPlayers.some(player => player?.id != null && player?.playerId != null && String(player.id) !== String(player.playerId))) {
    return fail('NHL_ROSTER_IDENTITY_INVALID', { status: 'BLOCK', issues: ['NHL_ROSTER_IDENTITY_INVALID'], source: result.source, players: [] });
  }
  return { ok: true, status: teamId ? 'OK' : 'IDENTITY_REQUIRED', leagueId: 'NHL', abbrev, teamId, season, players, source: result.source };
}

export async function fetchNhlPlayer(playerId, options = {}) {
  if (!/^\d{6,8}$/.test(String(playerId))) return fail('NHL_INVALID_PLAYER_ID');
  const result = await fetchNhlJson(`${NHL_SOURCES.player.url}${playerId}/landing`, { ttlMs: 5 * 60_000, ...options });
  if (!result.ok) return result;
  if (String(result.data.playerId) !== String(playerId)) return fail('NHL_PLAYER_IDENTITY_MISMATCH', { source: result.source });
  return { ok: true, status: 'OK', player: normalizeNhlPlayer(result.data, { source: result.source }), seasonTotals: result.data.seasonTotals || [], last5Games: result.data.last5Games || [], source: result.source };
}

export async function fetchNhlTeamStatistics(team, season, gameType = 2, options = {}) {
  const abbrev = String(typeof team === 'object' ? team.abbrev : team).toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(abbrev) || !/^\d{8}$/.test(String(season)) || ![1, 2, 3].includes(Number(gameType))) return fail('NHL_INVALID_TEAM_STATISTICS_IDENTITY');
  const url = `https://api-web.nhle.com/v1/club-stats/${abbrev}/${season}/${gameType}`;
  const result = await fetchNhlJson(url, { ttlMs: 5 * 60_000, ...options });
  if (!result.ok) return result;
  if (!Array.isArray(result.data.skaters) || !Array.isArray(result.data.goalies) || Number(result.data.season) !== Number(season) || Number(result.data.gameType) !== Number(gameType)) return fail('NHL_TEAM_STATISTICS_SCHEMA_INVALID', { source: result.source });
  // This official endpoint is player-level within a club. Do not mislabel the
  // sum of skater ice time as team TOI or infer PP opportunities from PP goals.
  return { ok: true, status: 'OK', league: 'NHL', leagueId: 'NHL', abbrev, teamId: typeof team === 'object' ? team.teamId : options.teamId ?? null, season: Number(season), gameType: Number(gameType), skaters: result.data.skaters, goalies: result.data.goalies, teamTotals: null, fiveOnFive: null, xGF: null, xGA: null, observedAt: result.source.fetchedAt, source: result.source, issues: ['NHL_CLUB_STATS_ARE_PLAYER_TOTALS_NOT_TEAM_POSSESSION_RATES'] };
}

export function deriveNhlEventStatistics(payload, source = null) {
  if (!Array.isArray(payload?.plays) || !integer(payload?.awayTeam?.id) || !integer(payload?.homeTeam?.id)) return { ok: false, status: 'UNAVAILABLE', issues: ['NHL_PBP_SCHEMA_INVALID'], source };
  const rows = { away: { teamId: payload.awayTeam.id, fiveOnFive: { shotsOnGoal: 0, goals: 0, missedShots: 0, blockedShots: 0 }, powerPlay: { shotsOnGoal: 0, goals: 0 }, shortHanded: { shotsOnGoal: 0, goals: 0 }, penaltyEvents: 0 }, home: { teamId: payload.homeTeam.id, fiveOnFive: { shotsOnGoal: 0, goals: 0, missedShots: 0, blockedShots: 0 }, powerPlay: { shotsOnGoal: 0, goals: 0 }, shortHanded: { shotsOnGoal: 0, goals: 0 }, penaltyEvents: 0 } };
  let unknownSituationEvents = 0;
  const seen = new Set();
  for (const event of payload.plays) {
    const eventKey = event.eventId;
    if (eventKey == null || seen.has(eventKey)) continue;
    seen.add(eventKey);
    if (event?.periodDescriptor?.periodType === 'SO') continue;
    const key = event?.details?.eventOwnerTeamId === rows.away.teamId ? 'away' : event?.details?.eventOwnerTeamId === rows.home.teamId ? 'home' : null;
    if (!key) continue;
    const team = rows[key]; const type = event.typeDescKey;
    if (type === 'penalty') team.penaltyEvents += 1;
    if (!['goal', 'shot-on-goal', 'missed-shot', 'blocked-shot'].includes(type)) continue;
    const situation = String(event.situationCode || '');
    if (!/^[01][0-6][0-6][01]$/.test(situation)) { unknownSituationEvents += 1; continue; }
    const awaySkaters = Number(situation[1]); const homeSkaters = Number(situation[2]);
    const bothGoalies = situation[0] === '1' && situation[3] === '1';
    const group = bothGoalies && awaySkaters === 5 && homeSkaters === 5 ? 'fiveOnFive' : bothGoalies && (key === 'away' ? awaySkaters > homeSkaters : homeSkaters > awaySkaters) ? 'powerPlay' : bothGoalies && awaySkaters !== homeSkaters ? 'shortHanded' : null;
    if (!group) continue;
    const counts = team[group];
    if (type === 'shot-on-goal' || type === 'goal') counts.shotsOnGoal += 1;
    if (type === 'goal') counts.goals += 1;
    if (group === 'fiveOnFive' && type === 'missed-shot') counts.missedShots += 1;
    // eventOwnerTeamId for a block is the defending team; do not label it as
    // the shooter's shot attempt without an independently resolved shooter.
    if (group === 'fiveOnFive' && type === 'blocked-shot') counts.blockedShots += 1;
  }
  return { ok: true, status: unknownSituationEvents ? 'WARNING' : 'OK', ...rows, unknownSituationEvents, source, powerPlayOpportunities: null, timeOnIce5v5: null, xGF: null, xGA: null, rateMetrics: null, issues: ['NHL_EVENT_COUNTS_ONLY_NOT_TIME_EXPOSURE_RATES', 'NHL_XG_NOT_AVAILABLE_FROM_RAW_PBP', 'NHL_PP_OPPORTUNITIES_REQUIRE_PENALTY_TIMELINE'] };
}

export function buildNhlScheduleContext(game, history, venueCoordinates = {}, { coverage = null } = {}) {
  const cutoff = Date.parse(game.startTimeUTC);
  const complete = coverage?.complete === true && coverage?.source?.url && Number.isFinite(Date.parse(coverage?.source?.fetchedAt)) && Date.parse(coverage.from) <= cutoff - 7 * 86400000 && Date.parse(coverage.to) >= cutoff;
  const context = teamId => {
    const prior = history.filter(row => row.leagueId === 'NHL' && (row.awayTeamId === teamId || row.homeTeamId === teamId) && Date.parse(row.startTimeUTC) < cutoff).sort((a, b) => Date.parse(b.startTimeUTC) - Date.parse(a.startTimeUTC));
    const previous = prior[0];
    if (!previous) return { restDays: null, backToBack: complete ? false : null, gamesPast7Days: complete ? 0 : null, previousGameId: null, travelKm: null, observedGamesPast7Days: 0, completeness: complete ? 'COMPLETE_7_DAY_COVERAGE_NO_PRIOR_GAME' : 'INCOMPLETE_SCHEDULE_COVERAGE', issues: complete ? [] : ['NHL_SCHEDULE_CONTEXT_INCOMPLETE'] };
    // Calendar rest is measured in the destination venue timezone; elapsed
    // hours are retained independently so DST does not create 0.96 day games.
    const timezone = game.venueTimezone || 'America/New_York';
    const localDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
    const days = (Date.parse(localDay(game.startTimeUTC)) - Date.parse(localDay(previous.startTimeUTC))) / 86400000;
    const from = venueCoordinates[previous.venue]; const to = venueCoordinates[game.venue]; let travelKm = null;
    if (from && to && [from.latitude, from.longitude, to.latitude, to.longitude].every(v => number(v) !== null)) {
      const rad = value => Number(value) * Math.PI / 180;
      const dlat = rad(to.latitude - from.latitude); const dlon = rad(to.longitude - from.longitude);
      const a = Math.sin(dlat / 2) ** 2 + Math.cos(rad(from.latitude)) * Math.cos(rad(to.latitude)) * Math.sin(dlon / 2) ** 2;
      travelKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    const previousCovered = complete && Date.parse(previous.startTimeUTC) >= Date.parse(coverage.from);
    const observedGamesPast7Days = prior.filter(row => cutoff - Date.parse(row.startTimeUTC) <= 7 * 86400000).length;
    return { restDays: previousCovered ? Math.max(0, days - 1) : null, backToBack: previousCovered ? days === 1 : null, elapsedHours: previousCovered ? (cutoff - Date.parse(previous.startTimeUTC)) / 3600000 : null, gamesPast7Days: complete ? observedGamesPast7Days : null, previousGameId: previousCovered ? previous.gameId : null, travelKm: previousCovered ? travelKm : null, travelSource: previousCovered && from && to ? { from: from.source || null, to: to.source || null } : null, observedPreviousGameId: previous.gameId, observedRestDays: Math.max(0, days - 1), observedElapsedHours: (cutoff - Date.parse(previous.startTimeUTC)) / 3600000, observedGamesPast7Days, observedTravelKm: travelKm, completeness: complete ? 'EXPLICIT_COMPLETE_SCHEDULE_COVERAGE' : 'INCOMPLETE_SCHEDULE_COVERAGE', issues: complete ? [] : ['NHL_SCHEDULE_CONTEXT_INCOMPLETE'], coverage: complete ? coverage : null };
  };
  return { away: context(game.awayTeamId), home: context(game.homeTeamId) };
}
