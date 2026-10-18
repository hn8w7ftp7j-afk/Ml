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

// ESPN UID tokens use namespaces: sport, league, event, competition, team.
// Validate every supplied identity token against its corresponding provider ID;
// missing UID fields are permitted when the enclosing competition is verified.
function uidMatches(value, expected, required = Object.keys(expected)) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string' || !value) return false;
  const tokens = new Map();
  for (const token of value.split('~')) {
    const match = /^([a-z]):([^~:]+)$/.exec(token);
    if (!match || tokens.has(match[1])) return false;
    tokens.set(match[1], match[2]);
  }
  for (const key of required) if (!tokens.has(key)) return false;
  for (const [key, wanted] of Object.entries(expected)) if (tokens.has(key) && tokens.get(key) !== String(wanted)) return false;
  return true;
}

function leagueMatches(payload, league, { standings = false } = {}) {
  const supplied = Array.isArray(payload?.leagues) ? payload.leagues : standings ? [payload] : [];
  return supplied.length === 1 && supplied.every(item => {
    if (standings) {
      // Standings root IDs are a different ESPN namespace (EPL 23, UCL 2).
      // Its sport/league UID, rather than the unrelated root ID, proves scope.
      return String(item?.uid || '') === `s:600~l:${league.espnId}` && [item?.name, item?.displayName].includes(league.englishName);
    }
    const names = [item?.slug, item?.abbreviation].filter(Boolean).map(x => String(x).toLowerCase());
    return names.includes(league.espnSlug) && (!item?.id || String(item.id) === league.espnId) && uidMatches(item?.uid, { s: '600', l: league.espnId });
  });
}
function normalizedTeam(raw, league, source, state) {
  const team = raw?.team;
  if (!team || !/^\d{1,16}$/.test(String(team.id || '')) || typeof (team.displayName || team.name) !== 'string' || !(team.displayName || team.name).trim() || !uidMatches(team.uid, { s: '600', t: String(team.id), l: league.espnId }, ['s', 't'])) return null;
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

/** ESPN ordered displayValue lines are period totals, never assumed cumulative.
 * Ordered lines require an independently matching scoring-event timeline. */
export function extractSoccerHalfTime({ competition, status, format, keyEvents, source } = {}) {
  const teams = competition?.competitors;
  if (!Array.isArray(teams) || teams.length !== 2 || teams.filter(t => t.homeAway === 'home').length !== 1 || teams.filter(t => t.homeAway === 'away').length !== 1) return { halfTime: null, reason: 'HALF_TIME_TEAMS_INVALID' };
  const home = teams.find(t => t.homeAway === 'home'), away = teams.find(t => t.homeAway === 'away');
  const state = normalizedStatus(status || competition?.status);
  if (!home || !away || !['live', 'final'].includes(state)) return { halfTime: null, reason: 'VERIFIED_FIRST_HALF_SCORE_UNAVAILABLE' };
  const full = [home, away].map(t => integer(t.score?.value ?? t.score));
  const explicit = [home, away].map(t => {
    const lines = Array.isArray(t.linescores) ? t.linescores.filter(line => Number(line.period) === 1) : null;
    return lines?.length === 1 ? integer(lines[0].value ?? lines[0].displayValue) : null;
  });
  if (explicit.every(x => x !== null) && (state === 'final' || Number((status || competition?.status)?.period) >= 2)) {
    if (explicit.some((x, i) => full[i] === null || x > full[i])) return { halfTime: null, reason: 'FIRST_HALF_EXCEEDS_MATCH_SCORE' };
    return { halfTime: { home: explicit[0], away: explicit[1], verified: true, source, evidence: { method: 'EXPLICIT_PERIOD_1' } }, reason: null };
  }
  if (state !== 'final' || (status || competition?.status)?.type?.name !== 'STATUS_FULL_TIME' || format?.regulation?.periods !== 2 || format?.regulation?.clock !== 2700 || !Array.isArray(keyEvents)) return { halfTime: null, reason: 'HALF_TIME_PERIOD_CONTEXT_UNVERIFIED' };
  const lines = [home, away].map(t => t.linescores);
  if (!lines.every(x => Array.isArray(x) && x.length === 2 && x.every(l => l.period === undefined && integer(l.displayValue) !== null))) return { halfTime: null, reason: 'HALF_TIME_LINESCORE_SCHEMA_UNVERIFIED' };
  const values = lines.map(x => x.map(l => integer(l.displayValue)));
  if (values.some((v, i) => v[0] + v[1] !== full[i])) return { halfTime: null, reason: 'HALF_TIME_PERIOD_SUM_MISMATCH' };
  const eventType = e => e.type?.type;
  const half = keyEvents.find(e => eventType(e) === 'halftime' && Number(e.period?.number) === 1);
  const end = keyEvents.find(e => eventType(e) === 'end-regular-time' && Number(e.period?.number) === 2);
  const kickoff = keyEvents.find(e => eventType(e) === 'kickoff' && Number(e.period?.number) === 1);
  if (!half || !end || !kickoff || keyEvents.some(e => Number(e.period?.number) > 2)) return { halfTime: null, reason: 'HALF_TIME_TIMELINE_INCOMPLETE' };
  const goals = keyEvents.filter(e => e.scoringPlay === true);
  const ids = new Set();
  const bySide = [home, away].map(t => [1, 2].map(period => goals.filter(e => String(e.team?.id) === String(t.team?.id) && Number(e.period?.number) === period).length));
  const invalidGoal = goals.some(e => {
    if (!e.id || ids.has(String(e.id))) return true;
    ids.add(String(e.id));
    return !/^(?:goal(?:---.*)?|own-goal(?:---.*)?|penalty---scored)$/.test(eventType(e) || '') || ![1, 2].includes(Number(e.period?.number)) || ![home, away].some(t => String(t.team?.id) === String(e.team?.id));
  });
  if (invalidGoal || bySide.some((v, i) => v.some((n, p) => n !== values[i][p]))) return { halfTime: null, reason: 'HALF_TIME_SCORING_TIMELINE_MISMATCH' };
  return { halfTime: { home: values[0][0], away: values[1][0], verified: true, source, evidence: { method: 'ORDERED_PERIOD_TOTALS_WITH_SCORING_TIMELINE', periodTotals: { home: values[0], away: values[1] }, firstHalfScoringEventIds: goals.filter(e => Number(e.period?.number) === 1).map(e => String(e.id)), halftimeEventId: String(half.id), endRegularEventId: String(end.id), scoringEventCount: goals.length } }, reason: null };
}
export function normalizeSoccerEvent(raw, leagueValue, source) {
  const league = soccerLeague(leagueValue);
  if (!league) return fail('SOCCER_INVALID_LEAGUE');
  if (!/^\d{1,16}$/.test(String(raw?.id || ''))) return fail('SOCCER_GAME_ID_INVALID');
  if (raw?.leagues?.some(item => !leagueMatches({ leagues: [item] }, league))) return fail('SOCCER_LEAGUE_IDENTITY_MISMATCH');
  const competition = raw.competitions?.[0];
  const uidExpected = { s: '600', l: league.espnId, e: String(raw.id) };
  if (!uidMatches(raw.uid, uidExpected) || !uidMatches(competition?.uid, { ...uidExpected, ...(competition?.id !== undefined && competition?.id !== null ? { c: String(competition.id) } : {}) }, ['s', 'l', 'e'])) return fail('SOCCER_GAME_UID_IDENTITY_MISMATCH');
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
  const { halfTime, reason: halfTimeReason } = extractSoccerHalfTime({ competition, status: rawStatus, format: raw.format || competition.format, keyEvents: raw.keyEvents, source });
  if (!halfTime) issues.push(missing('halfTime', halfTimeReason));
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
  const base = { version: SOCCER_DATA_VERSION, league, date, until, timeZone: SOCCER_TIME_ZONE, capabilities: SOCCER_CAPABILITIES, cacheNamespace: soccerCacheKey(league.id, 'schedule', `${date}:${windowDays}`) };
  // ESPN soccer rejects date ranges. Each single UTC date is a separate,
  // attributed read; the previous UTC day covers Taipei midnight correctly.
  const sourceDates = Array.from({ length: windowDays + 1 }, (_, index) => shiftSoccerDate(date, index - 1));
  const results = Array(sourceDates.length);
  let cursor = 0, failed = null;
  async function worker() {
    while (!failed && cursor < sourceDates.length) {
      const index = cursor++;
      const url = `https://${API_HOST}/apis/site/v2/sports/soccer/${league.espnSlug}/scoreboard?dates=${sourceDates[index].replaceAll('-', '')}`;
      results[index] = await fetchSoccerJson(url, options);
      if (!results[index].ok) failed ||= results[index];
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, sourceDates.length) }, worker));
  const sources = results.filter(Boolean).map(item => item.source).filter(Boolean);
  if (failed) return { ...base, ...failed, sources, coverage: { complete: false, requiredSourceDates: sourceDates, fetchedSourceDates: sourceDates.filter((_, index) => results[index]?.ok) }, missing: [missing('games', failed.code)] };
  const primary = results[1]?.source || sources[0];
  const source = { ...primary, fetchedAt: sources.map(item => item.fetchedAt).sort()[0], scope: 'COMBINED_SINGLE_DAY_SNAPSHOTS', urls: sources.map(item => item.url), contentHash: createHash('sha256').update(JSON.stringify(sources.map(item => ({ url: item.url, contentHash: item.contentHash })))).digest('hex') };
  const unique = new Map(), calendarDates = new Set();
  const comparable = game => JSON.stringify({ ...game, source: null, sources: null, halfTime: game.halfTime ? { ...game.halfTime, source: null } : null });
  for (const result of results) {
    const normalized = normalizeSoccerSchedule(result.data, league.id, result.source);
    if (!normalized.ok) return { ...base, ...normalized, sources, missing: [missing('games', normalized.code)] };
    normalized.calendarDates.forEach(value => calendarDates.add(value));
    for (const game of normalized.games) {
      const prior = unique.get(game.id);
      if (prior && comparable(prior) !== comparable(game)) return { ...base, ok: false, code: 'SOCCER_DUPLICATE_GAME_CONFLICT', source, sources, missing: [missing('games', 'SOCCER_DUPLICATE_GAME_CONFLICT')] };
      const observed = prior ? [...(prior.sources || [prior.source]), game.source] : [game.source];
      unique.set(game.id, { ...game, sources: observed });
    }
  }
  const games = [...unique.values()].filter(game => game.date >= date && game.date <= until).sort((a, b) => a.startTime.localeCompare(b.startTime));
  return { ...base, ok: true, games, source, sources, availableDates: [...new Set(games.map(game => game.date))].sort(), calendarDates: [...calendarDates].sort(), cached: results.every(item => item.cached === true), freshness: { fetchedAt: source.fetchedAt, stale: false, maxAgeSeconds: 60 }, coverage: { complete: true, sourceDates }, missing: games.length ? [] : [missing('games', 'NO_SCHEDULED_EVENTS_IN_CONFIRMED_SOURCE_WINDOW')] };
}

export function normalizeSoccerStandings(payload, leagueValue, source = null) {
  const league = soccerLeague(leagueValue);
  if (!league) return fail('SOCCER_INVALID_LEAGUE');
  if (!leagueMatches(payload, league, { standings: true })) return fail('SOCCER_LEAGUE_IDENTITY_MISMATCH', { source });
  const groups = [];
  let mixedGroup = false;
  function collect(item) {
    if (item?.uid && !new RegExp(`^s:600~l:${league.espnId}(?:~|$)`).test(String(item.uid))) mixedGroup = true;
    if (Array.isArray(item?.standings?.entries)) groups.push({ name: item.name || item.standings.name || league.shortName, entries: item.standings.entries });
    if (Array.isArray(item?.children)) item.children.forEach(collect);
  }
  collect(payload);
  if (mixedGroup) return fail('SOCCER_LEAGUE_IDENTITY_MISMATCH', { source });
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
