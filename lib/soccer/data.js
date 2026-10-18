import { createHash } from 'node:crypto';
import { SOCCER_DATA_VERSION, SOCCER_CAPABILITIES, SOCCER_TIME_ZONE, soccerLeague, soccerDate, validSoccerDate, shiftSoccerDate, soccerCacheKey } from './contracts.js';

const API_HOST = 'site.api.espn.com';
const cacheByFetch = new WeakMap();
const integer = value => (typeof value === 'number' || (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const fail = (code, details = {}) => ({ ok: false, code, ...details });
const missing = (field, reason) => ({ field, reason, fallbackSource: null });
const clone = value => structuredClone(value);
const sourceFor = (url, now, extra = {}) => ({ provider: 'ESPN', url, fetchedAt: new Date(now()).toISOString(), confidence: 'provider_reported', fallbackSource: null, ...extra });

/** Bounded public reads. No stale fallback is presented as a fresh successful result. */
export async function fetchSoccerJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000, ttlMs = 60_000, now = Date.now } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return fail('SOCCER_SOURCE_URL_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== API_HOST || parsed.port || parsed.username || parsed.password || parsed.hash || !/^\/apis\/(?:site\/)?v2\/sports\/soccer\//.test(parsed.pathname)) return fail('SOCCER_SOURCE_URL_INVALID');
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isFinite(now()) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(ttlMs) || ttlMs < 0) return fail('SOCCER_FETCH_OPTIONS_INVALID');
  if (!cacheByFetch.has(fetchImpl)) cacheByFetch.set(fetchImpl, new Map());
  const store = cacheByFetch.get(fetchImpl), cached = store.get(url);
  if (cached?.inflight) return clone(await cached.inflight);
  if (cached && cached.expiresAt > now()) return { ...clone(cached.value), cached: true };
  const operation = (async () => {
    const controller = new AbortController();
    let timer;
    const source = sourceFor(url, now, { requestedAt: new Date(now()).toISOString() });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('Soccer source timeout'), { code: 'SOCCER_SOURCE_TIMEOUT' })); }, timeoutMs); });
    let value;
    try {
      const response = await Promise.race([fetchImpl(url, { signal: controller.signal, redirect: 'manual', cache: 'no-store', headers: { Accept: 'application/json' } }), timeout]);
      if (response?.redirected || response?.type === 'opaqueredirect' || (response?.status >= 300 && response.status < 400)) value = fail('SOCCER_SOURCE_REDIRECT_REJECTED', { source, upstreamStatus: response.status });
      else if (response?.url && response.url !== parsed.href) value = fail('SOCCER_SOURCE_RESPONSE_URL_MISMATCH', { source });
      else if (!response?.ok) value = fail(response?.status === 429 ? 'SOCCER_SOURCE_RATE_LIMITED' : response?.status === 403 ? 'SOCCER_SOURCE_FORBIDDEN' : 'SOCCER_SOURCE_HTTP_ERROR', { source, upstreamStatus: response?.status || null });
      else {
        const data = await Promise.race([response.json(), timeout]);
        value = !data || typeof data !== 'object' || Array.isArray(data) ? fail('SOCCER_SOURCE_FORMAT_CHANGED', { source }) : { ok: true, data, source: { ...source, fetchedAt: new Date(now()).toISOString(), contentHash: createHash('sha256').update(JSON.stringify(data)).digest('hex') } };
      }
    } catch (error) { value = fail(controller.signal.aborted || error?.code === 'SOCCER_SOURCE_TIMEOUT' ? 'SOCCER_SOURCE_TIMEOUT' : error instanceof SyntaxError ? 'SOCCER_SOURCE_FORMAT_CHANGED' : 'SOCCER_SOURCE_UNAVAILABLE', { source }); }
    finally { clearTimeout(timer); }
    // Short negative caching coalesces refreshes but never converts failure to an empty schedule.
    store.set(url, { value, expiresAt: now() + (value.ok ? ttlMs : Math.min(ttlMs, 5000)) });
    while (store.size > 128) store.delete(store.keys().next().value);
    return value;
  })();
  store.set(url, { inflight: operation });
  return clone(await operation);
}

function leagueMatches(payload, league, { standings = false } = {}) {
  const supplied = Array.isArray(payload?.leagues) ? payload.leagues : standings ? [payload] : [];
  return supplied.some(item => {
    const names = [item?.slug, item?.abbreviation].filter(Boolean).map(x => String(x).toLowerCase());
    const namesMatch = names.includes(league.espnSlug) || (standings && [item?.name, item?.displayName].includes(league.englishName));
    return namesMatch && (!item?.id || String(item.id) === league.espnId);
  });
}
function normalizedTeam(raw, league, source, state) {
  const team = raw?.team;
  if (!team || !/^\d{1,16}$/.test(String(team.id || '')) || !String(team.displayName || team.name || '').trim()) return null;
  const score = state === 'live' || state === 'final' ? integer(raw.score?.value ?? raw.score) : null;
  const logo = team.logo || team.logos?.[0]?.href || null;
  return { id: `soccer:${league.id}:team:${team.id}`, sourceId: String(team.id), name: String(team.displayName || team.name), shortName: team.shortDisplayName || team.name || team.displayName, abbreviation: team.abbreviation || null, logo: /^https:\/\//.test(logo || '') ? logo : null, score };
}
function normalizedStatus(raw) {
  const type = raw?.type || {};
  const name = String(type.name || '').toUpperCase();
  if (/CANCEL|ABANDON/.test(name)) return 'cancelled';
  if (/POSTPON/.test(name)) return 'postponed';
  if (type.completed === true && type.state === 'post') return 'final';
  if (type.state === 'in') return 'live';
  if (type.state === 'pre') return 'scheduled';
  return 'unknown';
}
export function normalizeSoccerEvent(raw, leagueValue, source) {
  const league = soccerLeague(leagueValue);
  if (!league) return fail('SOCCER_INVALID_LEAGUE');
  if (!/^\d{1,16}$/.test(String(raw?.id || ''))) return fail('SOCCER_GAME_ID_INVALID');
  if (raw?.leagues?.some(item => !leagueMatches({ leagues: [item] }, league))) return fail('SOCCER_LEAGUE_IDENTITY_MISMATCH');
  const competition = raw.competitions?.[0];
  const teams = competition?.competitors;
  const start = raw.date || competition?.date;
  // Require an explicit time zone. Server local time must not change the selected Taipei day.
  if (typeof start !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(start) || !soccerDate(start)) return fail('SOCCER_GAME_START_INVALID');
  if (!Array.isArray(teams) || teams.length !== 2 || teams.filter(x => x.homeAway === 'home').length !== 1 || teams.filter(x => x.homeAway === 'away').length !== 1) return fail('SOCCER_GAME_TEAMS_INVALID');
  const rawStatus = raw.status || competition.status;
  const status = normalizedStatus(rawStatus);
  const rawHome = teams.find(x => x.homeAway === 'home'), rawAway = teams.find(x => x.homeAway === 'away');
  const home = normalizedTeam(rawHome, league, source, status), away = normalizedTeam(rawAway, league, source, status);
  if (!home || !away || home.id === away.id) return fail('SOCCER_TEAM_IDENTITY_INVALID');
  if (['live', 'final'].includes(status) && (home.score === null || away.score === null)) return fail('SOCCER_SCORE_MISSING');
  const issues = [];
  if (status === 'unknown') issues.push(missing('status', 'SOURCE_STATUS_UNKNOWN'));
  const firstHalf = team => { const period = team.linescores?.filter(item => Number(item.period) === 1); return period?.length === 1 ? integer(period[0].value) : null; };
  const halfHome = firstHalf(rawHome), halfAway = firstHalf(rawAway);
  const halfTime = (status === 'final' || (status === 'live' && Number(rawStatus?.period) >= 2)) && halfHome !== null && halfAway !== null && halfHome <= home.score && halfAway <= away.score ? { home: halfHome, away: halfAway, verified: true, source } : null;
  if (!halfTime) issues.push(missing('halfTime', halfHome !== null && halfAway !== null && (halfHome > home.score || halfAway > away.score) && ['live', 'final'].includes(status) ? 'FIRST_HALF_EXCEEDS_MATCH_SCORE' : 'VERIFIED_FIRST_HALF_SCORE_UNAVAILABLE'));
  return { ok: true, game: { id: `soccer:${league.id}:${raw.id}`, sourceId: String(raw.id), league: league.id, date: soccerDate(start), startTime: new Date(start).toISOString(), status, statusText: rawStatus?.type?.shortDetail || rawStatus?.type?.detail || null, home, away, halfTime, venue: competition.venue?.fullName || null, round: raw.season?.type?.name || raw.season?.slug || competition.notes?.[0]?.headline || null, neutralSite: competition.neutralSite === true, source, missing: issues } };
}
export function normalizeSoccerSchedule(payload, leagueValue, source = null) {
  const league = soccerLeague(leagueValue);
  if (!league) return fail('SOCCER_INVALID_LEAGUE');
  if (!Array.isArray(payload?.events)) return fail('SOCCER_SCHEDULE_SCHEMA_INVALID', { source });
  if (!leagueMatches(payload, league)) return fail('SOCCER_LEAGUE_IDENTITY_MISMATCH', { source });
  const games = new Map();
  for (const raw of payload.events) {
    const result = normalizeSoccerEvent(raw, league.id, source);
    if (!result.ok) return { ...result, source };
    const prior = games.get(result.game.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(result.game)) return fail('SOCCER_DUPLICATE_GAME_CONFLICT', { source });
    games.set(result.game.id, result.game);
  }
  // ESPN's calendar marks competition dates. Those dates are UTC instants, so convert rather than slicing.
  const calendarDates = (payload.leagues?.[0]?.calendar || []).flatMap(item => typeof item === 'string' ? [soccerDate(item)] : (item?.entries || []).map(entry => soccerDate(entry.startDate))).filter(Boolean);
  return { ok: true, games: [...games.values()].sort((a, b) => a.startTime.localeCompare(b.startTime)), calendarDates: [...new Set(calendarDates)].sort(), source };
}
export async function fetchSoccerSchedule(leagueValue, date, { windowDays = 1, ...options } = {}) {
  const league = soccerLeague(leagueValue);
  if (!league) return fail('SOCCER_INVALID_LEAGUE');
  if (!validSoccerDate(date) || !Number.isInteger(windowDays) || windowDays < 1 || windowDays > 21) return fail('SOCCER_INVALID_DATE_WINDOW');
  const until = shiftSoccerDate(date, windowDays - 1);
  // Taipei midnight is the previous UTC calendar day; include both source days then filter precisely.
  const query = `${shiftSoccerDate(date, -1).replaceAll('-', '')}-${until.replaceAll('-', '')}`;
  const url = `https://${API_HOST}/apis/site/v2/sports/soccer/${league.espnSlug}/scoreboard?dates=${query}&limit=1000`;
  const upstream = await fetchSoccerJson(url, options);
  const base = { version: SOCCER_DATA_VERSION, league, date, until, timeZone: SOCCER_TIME_ZONE, capabilities: SOCCER_CAPABILITIES, cacheNamespace: soccerCacheKey(league.id, 'schedule', `${date}:${windowDays}`), source: upstream.source };
  if (!upstream.ok) return { ...base, ...upstream, missing: [missing('games', upstream.code)] };
  const normalized = normalizeSoccerSchedule(upstream.data, league.id, upstream.source);
  if (!normalized.ok) return { ...base, ...normalized, missing: [missing('games', normalized.code)] };
  const games = normalized.games.filter(game => game.date >= date && game.date <= until);
  return { ...base, ok: true, games, availableDates: [...new Set(games.map(game => game.date))].sort(), calendarDates: normalized.calendarDates, cached: upstream.cached === true, freshness: { fetchedAt: upstream.source.fetchedAt, stale: false, maxAgeSeconds: 60 }, missing: games.length ? [] : [missing('games', 'NO_SCHEDULED_EVENTS_IN_CONFIRMED_SOURCE_WINDOW')] };
}

export function normalizeSoccerStandings(payload, leagueValue, source = null) {
  const league = soccerLeague(leagueValue);
  if (!league) return fail('SOCCER_INVALID_LEAGUE');
  if (!leagueMatches(payload, league, { standings: true })) return fail('SOCCER_LEAGUE_IDENTITY_MISMATCH', { source });
  const groups = [];
  function collect(item) {
    if (Array.isArray(item?.standings?.entries)) groups.push({ name: item.name || item.standings.name || league.shortName, entries: item.standings.entries });
    if (Array.isArray(item?.children)) item.children.forEach(collect);
  }
  collect(payload);
  if (!groups.length) return fail('SOCCER_STANDINGS_SCHEMA_INVALID', { source });
  const stat = (entry, names) => { const value = entry.stats?.find(item => names.includes(item.name))?.value; return (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))) || !Number.isFinite(Number(value)) ? null : Number(value); };
  const normalized = [];
  for (const group of groups) {
    const seen = new Set(), rows = [];
    for (const entry of group.entries) {
      if (!Array.isArray(entry.stats)) return fail('SOCCER_STANDINGS_STATS_INVALID', { source });
      const team = normalizedTeam({ team: entry.team }, league, source, 'scheduled');
      if (!team || seen.has(team.id)) return fail('SOCCER_STANDINGS_TEAM_IDENTITY_INVALID', { source });
      seen.add(team.id);
      rows.push({ team, rank: stat(entry, ['rank']), played: stat(entry, ['gamesPlayed']), won: stat(entry, ['wins']), drawn: stat(entry, ['ties', 'draws']), lost: stat(entry, ['losses']), goalsFor: stat(entry, ['pointsFor', 'goalsFor']), goalsAgainst: stat(entry, ['pointsAgainst', 'goalsAgainst']), goalDifference: stat(entry, ['pointDifferential', 'goalDifference']), points: stat(entry, ['points']), form: null, missing: [missing('form', 'VERIFIED_FORM_NOT_PROVIDED')] });
    }
    normalized.push({ name: group.name, rows });
  }
  return { ok: true, groups: normalized, standings: normalized, source };
}
export async function fetchSoccerStandings(leagueValue, options = {}) {
  const league = soccerLeague(leagueValue);
  if (!league) return fail('SOCCER_INVALID_LEAGUE');
  const url = `https://${API_HOST}/apis/v2/sports/soccer/${league.espnSlug}/standings`;
  const upstream = await fetchSoccerJson(url, { ttlMs: 5 * 60_000, ...options });
  const base = { version: SOCCER_DATA_VERSION, league, timeZone: SOCCER_TIME_ZONE, capabilities: SOCCER_CAPABILITIES, source: upstream.source };
  if (!upstream.ok) return { ...base, ...upstream, missing: [missing('standings', upstream.code)] };
  const result = normalizeSoccerStandings(upstream.data, league.id, upstream.source);
  return { ...base, ...result, cached: upstream.cached === true, season: upstream.data.season?.year || upstream.data.season || null, fetchedAt: upstream.source.fetchedAt, missing: result.ok ? [] : [missing('standings', result.code)] };
}
