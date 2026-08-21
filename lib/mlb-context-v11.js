import { sha256 } from './snapshot-v9.js';

export const MLB_CONTEXT_V11_VERSION = 'MLB-STANDALONE-POINT-IN-TIME-CONTEXT-2026-08-v10.3.0';
export const FEATURE_STATUS = Object.freeze({ CONFIRMED: 'CONFIRMED', PROJECTED: 'PROJECTED', MISSING: 'MISSING', STALE: 'STALE' });

const MLB_API = 'https://statsapi.mlb.com/api/v1';
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const BASEBALL_SAVANT_PARK = 'https://baseballsavant.mlb.com/leaderboard/statcast-park-factors';
const cache = globalThis.__MLB_V11_CONTEXT_CACHE__ || new Map();
globalThis.__MLB_V11_CONTEXT_CACHE__ = cache;
const jsonInflight = globalThis.__MLB_V11_JSON_INFLIGHT__ || new Map();
const textInflight = globalThis.__MLB_V11_TEXT_INFLIGHT__ || new Map();
const fetchIdentities = globalThis.__MLB_V11_FETCH_IDENTITIES__ || new WeakMap();
globalThis.__MLB_V11_JSON_INFLIGHT__ = jsonInflight;
globalThis.__MLB_V11_TEXT_INFLIGHT__ = textInflight;
globalThis.__MLB_V11_FETCH_IDENTITIES__ = fetchIdentities;
let fetchIdentitySequence = globalThis.__MLB_V11_FETCH_ID_SEQUENCE__ || 0;

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const clean = value => String(value || '').trim();

function transportKey(fetchImpl) {
  if (!fetchIdentities.has(fetchImpl)) {
    fetchIdentitySequence += 1;
    globalThis.__MLB_V11_FETCH_ID_SEQUENCE__ = fetchIdentitySequence;
    fetchIdentities.set(fetchImpl, fetchIdentitySequence);
  }
  return fetchIdentities.get(fetchImpl);
}

function isoDate(value) {
  const date = new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function shiftDate(value, days) {
  const date = new Date(value || Date.now());
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function seasonStart(dateText) {
  const year = Number(String(dateText || '').slice(0, 4)) || new Date().getUTCFullYear();
  return `${year}-03-01`;
}

function cached(key) {
  const row = cache.get(key);
  if (!row || row.expiresAt <= Date.now()) {
    if (row) cache.delete(key);
    return null;
  }
  return row.value;
}

function remember(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function requestJson(url, { fetchImpl = fetch, timeoutMs = 12000, ttlMs = 300000 } = {}) {
  const sourceUrl = String(url);
  const key = `JSON:${transportKey(fetchImpl)}:${timeoutMs}:${sourceUrl}`;
  const hit = cached(key);
  if (hit) return hit;
  if (jsonInflight.has(key)) return jsonInflight.get(key);
  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fetchedAt = new Date().toISOString();
    try {
      const response = await fetchImpl(sourceUrl, { cache: 'no-store', signal: controller.signal, headers: { 'User-Agent': 'Baseball-Positive-EV-v10.1' } });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      const result = {
        ok: response.ok && data != null,
        statusCode: response.status,
        data,
        fetchedAt,
        rawPayloadHash: sha256(text || ''),
        sourceRecord: sourceUrl,
        error: response.ok ? (data == null ? '回傳不是JSON' : '') : `HTTP ${response.status}`,
      };
      return remember(key, result, result.ok ? ttlMs : Math.min(ttlMs, 60000));
    } catch (error) {
      return remember(key, {
        ok: false, statusCode: 0, data: null, fetchedAt, rawPayloadHash: null, sourceRecord: sourceUrl,
        error: error?.name === 'AbortError' ? '資料取得逾時' : clean(error?.message || error),
      }, 30000);
    } finally {
      clearTimeout(timer);
    }
  })();
  jsonInflight.set(key, request);
  try {
    return await request;
  } finally {
    if (jsonInflight.get(key) === request) jsonInflight.delete(key);
  }
}

async function requestText(url, { fetchImpl = fetch, timeoutMs = 12000, ttlMs = 6 * 60 * 60 * 1000 } = {}) {
  const sourceUrl = String(url);
  const key = `TEXT:${transportKey(fetchImpl)}:${timeoutMs}:${sourceUrl}`;
  const hit = cached(key);
  if (hit) return hit;
  if (textInflight.has(key)) return textInflight.get(key);
  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fetchedAt = new Date().toISOString();
    try {
      const response = await fetchImpl(sourceUrl, { cache: 'no-store', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 Baseball-Positive-EV-v10.2' } });
      const text = await response.text();
      const result = { ok: response.ok && text.length > 0, statusCode: response.status, text, fetchedAt, rawPayloadHash: sha256(text || ''), sourceRecord: sourceUrl, error: response.ok ? '' : `HTTP ${response.status}` };
      return remember(key, result, result.ok ? ttlMs : 60000);
    } catch (error) {
      return remember(key, { ok: false, statusCode: 0, text: '', fetchedAt, rawPayloadHash: null, sourceRecord: sourceUrl, error: error?.name === 'AbortError' ? '資料取得逾時' : clean(error?.message || error) }, 30000);
    } finally { clearTimeout(timer); }
  })();
  textInflight.set(key, request);
  try {
    return await request;
  } finally {
    if (textInflight.get(key) === request) textInflight.delete(key);
  }
}

function parseSavantParkFactor(response, venueId) {
  if (!response?.ok || !response.text) return { available: false, status: FEATURE_STATUS.MISSING, runFactor: 1, indexRuns: null, error: response?.error || 'Baseball Savant球場係數缺失', fetchedAt: response?.fetchedAt, rawPayloadHash: response?.rawPayloadHash, sourceRecord: response?.sourceRecord };
  try {
    const match = response.text.match(/var data\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) throw new Error('找不到Savant park factor payload');
    const rows = JSON.parse(match[1]);
    const row = rows.find(item => Number(item?.venue_id) === Number(venueId));
    const indexRuns = finite(row?.index_runs);
    if (!row || indexRuns == null || indexRuns < 70 || indexRuns > 140) throw new Error('Savant venueId或index_runs無效');
    return { available: true, status: FEATURE_STATUS.PROJECTED, runFactor: indexRuns / 100, indexRuns, venueName: clean(row.venue_name), sampleSize: finite(row.n_pa, 0), yearRange: clean(row.year_range), fetchedAt: response.fetchedAt, rawPayloadHash: response.rawPayloadHash, sourceRecord: response.sourceRecord, sourceProvider: 'BASEBALL_SAVANT_STATCAST_PARK_FACTORS_INDEX_RUNS' };
  } catch (error) {
    return { available: false, status: FEATURE_STATUS.MISSING, runFactor: 1, indexRuns: null, error: clean(error?.message || error), fetchedAt: response?.fetchedAt, rawPayloadHash: response?.rawPayloadHash, sourceRecord: response?.sourceRecord };
  }
}

async function fetchSavantParkFactor(venueId, asOf, options) {
  const year = Number(String(asOf || '').slice(0, 4)) || new Date().getUTCFullYear();
  const url = new URL(BASEBALL_SAVANT_PARK);
  url.searchParams.set('batSide', '');
  url.searchParams.set('condition', 'All');
  url.searchParams.set('parks', 'mlb');
  url.searchParams.set('rolling', '3');
  url.searchParams.set('stat', 'index_wOBA');
  url.searchParams.set('type', 'year');
  url.searchParams.set('year', String(year));
  return parseSavantParkFactor(await requestText(url, options), venueId);
}

export function parseBaseballInningsV11(value) {
  if (value == null || clean(value) === '') return 0;
  const match = clean(value).match(/^(-?\d+)(?:\.(\d+))?$/);
  if (!match) return finite(value, 0) || 0;
  const whole = Number(match[1]);
  const fraction = match[2] || '';
  if (!fraction || /^0+$/.test(fraction)) return whole;
  if (/^1(?:0*)$/.test(fraction)) return whole + 1 / 3;
  if (/^2(?:0*)$/.test(fraction)) return whole + 2 / 3;
  return finite(value, whole) ?? whole;
}

function statSplits(payload) {
  return (payload?.stats || []).flatMap(block => block?.splits || []);
}

function firstStat(payload) {
  return statSplits(payload)?.[0]?.stat || null;
}

function rate(value, denominator, scale = 1, fallback = null) {
  const number = finite(value);
  const divisor = finite(denominator);
  return number != null && divisor > 0 ? number * scale / divisor : fallback;
}

function normalizeHitting(stat, status = FEATURE_STATUS.CONFIRMED) {
  if (!stat) return { available: false, status: FEATURE_STATUS.MISSING, games: 0 };
  const games = finite(stat.gamesPlayed, 0) || 0;
  const plateAppearances = finite(stat.plateAppearances, 0) || 0;
  const runs = finite(stat.runs, 0) || 0;
  const obp = finite(stat.obp, null);
  const slg = finite(stat.slg, null);
  const ops = finite(stat.ops, obp != null && slg != null ? obp + slg : null);
  return {
    available: games > 0,
    status: games > 0 ? status : FEATURE_STATUS.MISSING,
    games,
    plateAppearances,
    runs,
    runsPerGame: games > 0 ? runs / games : null,
    avg: finite(stat.avg), obp, slg, ops,
    homeRuns: finite(stat.homeRuns, 0), baseOnBalls: finite(stat.baseOnBalls, 0), strikeOuts: finite(stat.strikeOuts, 0),
  };
}

function componentFip({ kPer9, bbPer9, hrPer9 }, league) {
  const lgEra = finite(league?.era, 4.25) ?? 4.25;
  const lgK = finite(league?.kPer9, 8.6) ?? 8.6;
  const lgBB = finite(league?.bbPer9, 3.2) ?? 3.2;
  const lgHR = finite(league?.hrPer9, 1.15) ?? 1.15;
  return clamp(lgEra + 0.60 * ((hrPer9 ?? lgHR) - lgHR) + 0.24 * ((bbPer9 ?? lgBB) - lgBB) - 0.16 * ((kPer9 ?? lgK) - lgK), 2.0, 7.5);
}

function normalizePitching(stat, league = {}, status = FEATURE_STATUS.CONFIRMED) {
  if (!stat) return { available: false, status: FEATURE_STATUS.MISSING, inningsPitched: 0 };
  const inningsPitched = parseBaseballInningsV11(stat.inningsPitched);
  const earnedRuns = finite(stat.earnedRuns, 0) || 0;
  const hits = finite(stat.hits, 0) || 0;
  const walks = finite(stat.baseOnBalls, 0) || 0;
  const strikeouts = finite(stat.strikeOuts, 0) || 0;
  const homeRuns = finite(stat.homeRuns, 0) || 0;
  const kPer9 = rate(strikeouts, inningsPitched, 9, finite(league?.kPer9, 8.6));
  const bbPer9 = rate(walks, inningsPitched, 9, finite(league?.bbPer9, 3.2));
  const hrPer9 = rate(homeRuns, inningsPitched, 9, finite(league?.hrPer9, 1.15));
  const era = inningsPitched > 0 ? earnedRuns * 9 / inningsPitched : finite(stat.era, finite(league?.era, 4.25));
  const whip = inningsPitched > 0 ? (hits + walks) / inningsPitched : finite(stat.whip, finite(league?.whip, 1.30));
  return {
    available: inningsPitched > 0,
    status: inningsPitched > 0 ? status : FEATURE_STATUS.MISSING,
    inningsPitched,
    gamesPitched: finite(stat.gamesPitched, 0), gamesStarted: finite(stat.gamesStarted, 0),
    earnedRuns, hits, baseOnBalls: walks, strikeOuts: strikeouts, homeRuns,
    era, whip, kPer9, bbPer9, hrPer9,
    fip: componentFip({ kPer9, bbPer9, hrPer9 }, league),
    fipStatus: FEATURE_STATUS.PROJECTED,
    fipSource: 'K_BB_HR_COMPONENT_ESTIMATE_NOT_ERA_COPY',
  };
}

function normalizeLeague(hittingPayload, pitchingPayload, metadata = {}) {
  const hitting = statSplits(hittingPayload);
  const pitching = statSplits(pitchingPayload);
  const byTeam = new Map();
  for (const split of hitting) {
    const id = Number(split?.team?.id || split?.split?.team?.id || 0);
    if (id) byTeam.set(id, split);
  }
  const totalRuns = [...byTeam.values()].reduce((sum, split) => sum + (finite(split?.stat?.runs, 0) || 0), 0);
  const totalGames = [...byTeam.values()].reduce((sum, split) => sum + (finite(split?.stat?.gamesPlayed, 0) || 0), 0);
  let innings = 0, earnedRuns = 0, hits = 0, walks = 0, strikeouts = 0, homeRuns = 0;
  for (const split of pitching) {
    const stat = split?.stat || {};
    innings += parseBaseballInningsV11(stat.inningsPitched);
    earnedRuns += finite(stat.earnedRuns, 0) || 0;
    hits += finite(stat.hits, 0) || 0;
    walks += finite(stat.baseOnBalls, 0) || 0;
    strikeouts += finite(stat.strikeOuts, 0) || 0;
    homeRuns += finite(stat.homeRuns, 0) || 0;
  }
  const teamCount = byTeam.size;
  const available = teamCount >= 26 && totalGames > 0 && totalRuns > 0;
  const obpValues = [...byTeam.values()].map(split => finite(split?.stat?.obp)).filter(Number.isFinite);
  const slgValues = [...byTeam.values()].map(split => finite(split?.stat?.slg)).filter(Number.isFinite);
  const obp = obpValues.length ? obpValues.reduce((a, b) => a + b, 0) / obpValues.length : 0.32;
  const slg = slgValues.length ? slgValues.reduce((a, b) => a + b, 0) / slgValues.length : 0.40;
  return {
    available,
    status: available ? (teamCount >= 30 ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED) : FEATURE_STATUS.MISSING,
    teamCount,
    sampleSize: totalGames,
    totalRuns,
    totalTeamGames: totalGames,
    runsPerTeamGame: available ? totalRuns / totalGames : null,
    era: innings > 0 ? earnedRuns * 9 / innings : null,
    whip: innings > 0 ? (hits + walks) / innings : null,
    kPer9: innings > 0 ? strikeouts * 9 / innings : null,
    bbPer9: innings > 0 ? walks * 9 / innings : null,
    hrPer9: innings > 0 ? homeRuns * 9 / innings : null,
    obp, slg, ops: obp + slg,
    asOf: metadata.asOf || null,
    sourceProvider: 'MLB_STATS_API_TEAM_BY_DATE_RANGE',
  };
}

function parseVenue(payload, expectedVenueId) {
  const venue = (payload?.venues || []).find(row => Number(row?.id) === Number(expectedVenueId)) || payload?.venues?.[0] || null;
  const coordinates = venue?.location?.defaultCoordinates || {};
  const latitude = finite(coordinates.latitude);
  const longitude = finite(coordinates.longitude);
  const roofText = clean(venue?.fieldInfo?.roofType).toLowerCase();
  const roof = /retract/.test(roofText) ? 'retractable' : /dome|closed|indoor/.test(roofText) ? 'dome' : /open|outdoor/.test(roofText) ? 'open' : 'unknown';
  const available = Boolean(venue?.id && latitude != null && longitude != null);
  return { available, status: available ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.MISSING, id: Number(venue?.id || expectedVenueId || 0) || null, name: clean(venue?.name), latitude, longitude, roof };
}

function parseInjuries(payload) {
  if (!Array.isArray(payload?.roster)) return { available: false, status: FEATURE_STATUS.MISSING, rows: [] };
  const rows = payload.roster.map(row => ({ id: Number(row?.person?.id || 0) || null, player: clean(row?.person?.fullName), position: clean(row?.position?.abbreviation), status: clean(row?.status?.description || row?.rosterStatus || 'Injured List') })).filter(row => row.id || row.player);
  return { available: true, status: FEATURE_STATUS.CONFIRMED, rows };
}

function parseScheduleScoring(payload, teamId, venueId = null) {
  const games = (payload?.dates || []).flatMap(day => day?.games || []).filter(game => game?.status?.abstractGameState === 'Final' || game?.status?.codedGameState === 'F');
  const scored = [];
  const allowed = [];
  const homeTotals = [];
  const roadTotals = [];
  for (const game of games) {
    const awayId = Number(game?.teams?.away?.team?.id || 0);
    const homeId = Number(game?.teams?.home?.team?.id || 0);
    const awayRuns = finite(game?.teams?.away?.score);
    const homeRuns = finite(game?.teams?.home?.score);
    if (awayRuns == null || homeRuns == null) continue;
    if (awayId === Number(teamId)) { scored.push(awayRuns); allowed.push(homeRuns); roadTotals.push(awayRuns + homeRuns); }
    if (homeId === Number(teamId)) {
      scored.push(homeRuns); allowed.push(awayRuns);
      if (!venueId || Number(game?.venue?.id || 0) === Number(venueId)) homeTotals.push(awayRuns + homeRuns);
    }
  }
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const variance = values => {
    const m = mean(values);
    return values.length > 1 ? values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1) : null;
  };
  return {
    games: scored.length,
    meanRuns: mean(scored), varianceRuns: variance(scored), meanAllowed: mean(allowed), varianceAllowed: variance(allowed),
    homeGames: homeTotals.length, roadGames: roadTotals.length,
    recentGames: [...games]
      .sort((left, right) => new Date(right?.gameDate || 0) - new Date(left?.gameDate || 0))
      .slice(0, 6)
      .map(row => ({ gamePk: Number(row?.gamePk || 0) || null, gameDate: row?.gameDate || null, innings: Number(row?.linescore?.currentInning || 9) || 9 }))
      .filter(row => row.gamePk),
  };
}

async function fetchStats(teamId, group, startDate, endDate, options) {
  const season = String(endDate || '').slice(0, 4);
  const url = new URL(`${MLB_API}/teams/${teamId}/stats`);
  url.searchParams.set('stats', 'byDateRange');
  url.searchParams.set('group', group);
  url.searchParams.set('season', season);
  url.searchParams.set('sportIds', '1');
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  return requestJson(url, options);
}

async function fetchLeague(group, startDate, endDate, options) {
  const season = String(endDate || '').slice(0, 4);
  const url = new URL(`${MLB_API}/teams/stats`);
  url.searchParams.set('stats', 'byDateRange');
  url.searchParams.set('group', group);
  url.searchParams.set('season', season);
  url.searchParams.set('sportIds', '1');
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  return requestJson(url, options);
}

async function fetchPersonPitching(personId, startDate, endDate, options) {
  if (!personId) return { ok: false, data: null, error: '未公布先發投手', fetchedAt: new Date().toISOString(), rawPayloadHash: null, sourceRecord: null };
  const url = new URL(`${MLB_API}/people/${personId}/stats`);
  url.searchParams.set('stats', 'byDateRange');
  url.searchParams.set('group', 'pitching');
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  return requestJson(url, options);
}

async function fetchTeamSchedule(teamId, startDate, endDate, options) {
  const url = new URL(`${MLB_API}/schedule`);
  url.searchParams.set('sportId', '1');
  url.searchParams.set('teamId', String(teamId));
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  url.searchParams.set('hydrate', 'venue');
  return requestJson(url, { ...options, ttlMs: 15 * 60 * 1000 });
}

async function fetchVenue(venueId, options) {
  if (!venueId) return { ok: false, data: null, error: '缺少venueId', fetchedAt: new Date().toISOString(), rawPayloadHash: null, sourceRecord: null };
  const url = new URL(`${MLB_API}/venues/${venueId}`);
  url.searchParams.set('hydrate', 'location,fieldInfo,timezone');
  return requestJson(url, { ...options, ttlMs: 24 * 60 * 60 * 1000 });
}

async function fetchInjuries(teamId, asOf, options) {
  const url = new URL(`${MLB_API}/teams/${teamId}/roster`);
  url.searchParams.set('rosterType', '40Man');
  url.searchParams.set('date', asOf);
  const response = await requestJson(url, { ...options, ttlMs: 10 * 60 * 1000 });
  if (!response.ok) return response;
  const roster = Array.isArray(response.data?.roster) ? response.data.roster : [];
  const hasStatusMetadata = roster.some(row => clean(row?.status?.description || row?.status?.code || row?.rosterStatus));
  if (!hasStatusMetadata) return { ...response, ok: false, data: null, error: '官方roster未提供可驗證傷停狀態欄位' };
  response.data = { roster: roster.filter(row => /injur|il|disabled/i.test(clean(row?.status?.description || row?.status?.code || row?.rosterStatus))) };
  return response;
}

async function fetchWeather(game, venue, options) {
  if (!venue?.available) return { available: false, status: FEATURE_STATUS.MISSING, meanRunFactor: 1, error: '場館座標缺失' };
  const target = new Date(game?.gameDate || Date.now());
  const historical = target.getTime() < Date.now() - 5 * 86400000;
  const url = new URL(historical ? OPEN_METEO_ARCHIVE : OPEN_METEO_FORECAST);
  url.searchParams.set('latitude', String(venue.latitude));
  url.searchParams.set('longitude', String(venue.longitude));
  url.searchParams.set('hourly', 'temperature_2m,relative_humidity_2m,precipitation_probability,surface_pressure,wind_speed_10m,wind_direction_10m');
  url.searchParams.set('timezone', 'UTC');
  if (historical) { url.searchParams.set('start_date', isoDate(target)); url.searchParams.set('end_date', isoDate(target)); }
  else { url.searchParams.set('past_days', '2'); url.searchParams.set('forecast_days', '3'); }
  const response = await requestJson(url, { ...options, ttlMs: 10 * 60 * 1000 });
  if (!response.ok) return { available: false, status: FEATURE_STATUS.MISSING, meanRunFactor: 1, error: response.error, fetchedAt: response.fetchedAt, rawPayloadHash: response.rawPayloadHash, sourceRecord: response.sourceRecord };
  const hourly = response.data?.hourly || {};
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  let best = -1, difference = Infinity;
  for (let index = 0; index < times.length; index += 1) {
    const timestamp = Date.parse(`${times[index]}${String(times[index]).endsWith('Z') ? '' : 'Z'}`);
    const current = Math.abs(timestamp - target.getTime());
    if (Number.isFinite(timestamp) && current < difference) { best = index; difference = current; }
  }
  if (best < 0) return { available: false, status: FEATURE_STATUS.MISSING, meanRunFactor: 1, error: '找不到開賽時段天氣' };
  const temperature = finite(hourly.temperature_2m?.[best], 21) ?? 21;
  const humidity = finite(hourly.relative_humidity_2m?.[best], 50) ?? 50;
  const pressure = finite(hourly.surface_pressure?.[best], 1013) ?? 1013;
  const temperatureFactor = clamp(1 + (temperature - 21) * 0.0024, 0.94, 1.06);
  const pressureFactor = clamp(1 + (1013 - pressure) * 0.00018, 0.97, 1.03);
  const humidityFactor = clamp(1 + (humidity - 50) * 0.00012, 0.99, 1.01);
  const openFactor = clamp(temperatureFactor * pressureFactor * humidityFactor, 0.93, 1.08);
  const closedProbability = venue.roof === 'dome' ? 1 : venue.roof === 'open' ? 0 : 0.35;
  return {
    available: true,
    status: historical ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED,
    temperature, relativeHumidity: humidity, surfacePressure: pressure,
    precipitationProbability: finite(hourly.precipitation_probability?.[best]), windSpeed: finite(hourly.wind_speed_10m?.[best]), windDirection: finite(hourly.wind_direction_10m?.[best]),
    meanRunFactor: closedProbability + (1 - closedProbability) * openFactor,
    directionalWindApplied: false,
    roofClosedProbability: closedProbability,
    fetchedAt: response.fetchedAt, rawPayloadHash: response.rawPayloadHash, sourceRecord: response.sourceRecord,
  };
}

function feature(gamePk, name, value, status, source, extra = {}) {
  return { gamePk, featureName: name, value, status, sourceProvider: source, normalizationVersion: MLB_CONTEXT_V11_VERSION, ...extra };
}

function gate(rows) {
  const missing = rows.filter(row => row.status === FEATURE_STATUS.MISSING);
  const projected = rows.filter(row => row.status === FEATURE_STATUS.PROJECTED);
  const blocking = rows.filter(row => row.core && row.status === FEATURE_STATUS.MISSING);
  const projectedCore = rows.filter(row => row.core && row.status === FEATURE_STATUS.PROJECTED);
  return {
    version: MLB_CONTEXT_V11_VERSION,
    rows,
    missing: missing.map(row => row.name), projected: projected.map(row => row.name), blocking: blocking.map(row => row.name),
    passedForShadowScore: blocking.length === 0,
    passedForFormalScore: blocking.length === 0 && missing.length === 0,
    quality: clamp(0.97 - missing.length * 0.045 - projected.length * 0.014, 0.55, 0.97),
    qualificationQuality: clamp(0.97 - blocking.length * 0.12 - projectedCore.length * 0.04, 0.5, 0.97),
    modelErrorMarginEV: clamp(0.004 + missing.length * 0.005 + projected.length * 0.0015, 0.004, 0.035),
  };
}

export async function buildGameContextV11(game, options = {}) {
  const asOf = shiftDate(game?.gameDate, -1);
  const startDate = seasonStart(asOf);
  const recentStart = shiftDate(asOf, -13);
  const teamStart = shiftDate(asOf, -90);
  const [leagueHitRes, leaguePitchRes, awayHitRes, homeHitRes, awayPitchRes, homePitchRes, awayRecentHitRes, homeRecentHitRes, awayRecentPitchRes, homeRecentPitchRes, awayStarterRes, homeStarterRes, awayScheduleRes, homeScheduleRes, venueRes, awayInjuryRes, homeInjuryRes, parkFactor] = await Promise.all([
    fetchLeague('hitting', startDate, asOf, options), fetchLeague('pitching', startDate, asOf, options),
    fetchStats(game.awayTeamId, 'hitting', startDate, asOf, options), fetchStats(game.homeTeamId, 'hitting', startDate, asOf, options),
    fetchStats(game.awayTeamId, 'pitching', startDate, asOf, options), fetchStats(game.homeTeamId, 'pitching', startDate, asOf, options),
    fetchStats(game.awayTeamId, 'hitting', recentStart, asOf, options), fetchStats(game.homeTeamId, 'hitting', recentStart, asOf, options),
    fetchStats(game.awayTeamId, 'pitching', recentStart, asOf, options), fetchStats(game.homeTeamId, 'pitching', recentStart, asOf, options),
    fetchPersonPitching(game.awayProbableId, startDate, asOf, options), fetchPersonPitching(game.homeProbableId, startDate, asOf, options),
    fetchTeamSchedule(game.awayTeamId, teamStart, asOf, options), fetchTeamSchedule(game.homeTeamId, teamStart, asOf, options),
    fetchVenue(game.venueId, options), fetchInjuries(game.awayTeamId, asOf, options), fetchInjuries(game.homeTeamId, asOf, options), fetchSavantParkFactor(game.venueId, asOf, options),
  ]);
  const league = normalizeLeague(leagueHitRes.data, leaguePitchRes.data, { asOf });
  const awaySchedule = parseScheduleScoring(awayScheduleRes.data, game.awayTeamId, null);
  const homeSchedule = parseScheduleScoring(homeScheduleRes.data, game.homeTeamId, game.venueId);
  const venue = parseVenue(venueRes.data, game.venueId);
  const weather = await fetchWeather(game, venue, options);
  const awayInjuries = parseInjuries(awayInjuryRes.data);
  const homeInjuries = parseInjuries(homeInjuryRes.data);
  const awayHitting = normalizeHitting(firstStat(awayHitRes.data));
  const homeHitting = normalizeHitting(firstStat(homeHitRes.data));
  const awayRecentHitting = normalizeHitting(firstStat(awayRecentHitRes.data), FEATURE_STATUS.PROJECTED);
  const homeRecentHitting = normalizeHitting(firstStat(homeRecentHitRes.data), FEATURE_STATUS.PROJECTED);
  const awayPitching = normalizePitching(firstStat(awayPitchRes.data), league);
  const homePitching = normalizePitching(firstStat(homePitchRes.data), league);
  const awayRecentPitching = normalizePitching(firstStat(awayRecentPitchRes.data), league, FEATURE_STATUS.PROJECTED);
  const homeRecentPitching = normalizePitching(firstStat(homeRecentPitchRes.data), league, FEATURE_STATUS.PROJECTED);
  const awayStarter = normalizePitching(firstStat(awayStarterRes.data), league, game.awayProbableId ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED);
  const homeStarter = normalizePitching(firstStat(homeStarterRes.data), league, game.homeProbableId ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED);
  if (!awayStarter.available) Object.assign(awayStarter, { ...awayPitching, status: FEATURE_STATUS.PROJECTED, projectedFromTeamPitching: true });
  if (!homeStarter.available) Object.assign(homeStarter, { ...homePitching, status: FEATURE_STATUS.PROJECTED, projectedFromTeamPitching: true });
  const expectedStarterInnings = starter => {
    if (starter?.projectedFromTeamPitching === true) return 5.0;
    const starts = Math.max(0, finite(starter?.gamesStarted, 0));
    const innings = Math.max(0, finite(starter?.inningsPitched, 0));
    return clamp(starts >= 2 ? innings / starts : 5.2, 1.0, 7.2);
  };
  awayStarter.expectedInnings = expectedStarterInnings(awayStarter);
  homeStarter.expectedInnings = expectedStarterInnings(homeStarter);
  const away = { teamId: game.awayTeamId, name: game.away, hitting: awayHitting, recentHitting: awayRecentHitting, pitching: awayPitching, recentPitching: awayRecentPitching, starter: awayStarter, injuriesAvailable: awayInjuries.available, injuries: awayInjuries.rows, scoring: awaySchedule };
  const home = { teamId: game.homeTeamId, name: game.home, hitting: homeHitting, recentHitting: homeRecentHitting, pitching: homePitching, recentPitching: homeRecentPitching, starter: homeStarter, injuriesAvailable: homeInjuries.available, injuries: homeInjuries.rows, scoring: homeSchedule };
  const park = { id: venue.id, name: venue.name || game.venue, lat: venue.latitude, lon: venue.longitude, roof: venue.roof, runFactor: parkFactor.runFactor, indexRuns: parkFactor.indexRuns, factorStatus: parkFactor.status, registryStatus: venue.status, sourceProvider: parkFactor.sourceProvider, yearRange: parkFactor.yearRange, sampleSize: parkFactor.sampleSize, fetchedAt: parkFactor.fetchedAt, rawPayloadHash: parkFactor.rawPayloadHash, sourceRecord: parkFactor.sourceRecord };
  const rows = [
    { name: 'leagueBaseline', status: league.status, core: true }, { name: 'awaySeasonHitting', status: awayHitting.status, core: true }, { name: 'homeSeasonHitting', status: homeHitting.status, core: true },
    { name: 'awaySeasonPitching', status: awayPitching.status, core: true }, { name: 'homeSeasonPitching', status: homePitching.status, core: true }, { name: 'venueRegistry', status: venue.status, core: true },
    { name: 'awayStarter', status: awayStarter.status, core: false }, { name: 'homeStarter', status: homeStarter.status, core: false }, { name: 'awayRecentHitting', status: awayRecentHitting.status, core: false }, { name: 'homeRecentHitting', status: homeRecentHitting.status, core: false },
    { name: 'awayRecentPitching', status: awayRecentPitching.status, core: false }, { name: 'homeRecentPitching', status: homeRecentPitching.status, core: false }, { name: 'parkFactor', status: park.factorStatus, core: false }, { name: 'weather', status: weather.status, core: false },
    { name: 'awayInjuries', status: awayInjuries.status, core: false }, { name: 'homeInjuries', status: homeInjuries.status, core: false }, { name: 'lineups', status: FEATURE_STATUS.MISSING, core: false }, { name: 'umpire', status: FEATURE_STATUS.MISSING, core: false }, { name: 'catcherFraming', status: FEATURE_STATUS.MISSING, core: false }, { name: 'defenseOAA', status: FEATURE_STATUS.MISSING, core: false },
  ];
  const dataGateV10 = gate(rows);
  const gamePk = Number(game.gamePk || 0) || null;
  const featureProvenance = [
    feature(gamePk, 'leagueBaseline', league, league.status, 'MLB_STATS_API_TEAM_BY_DATE_RANGE', { asOf, rawPayloadHash: sha256([leagueHitRes.rawPayloadHash, leaguePitchRes.rawPayloadHash]) }),
    feature(gamePk, 'awayTeamStats', { hitting: awayHitting, pitching: awayPitching, recentHitting: awayRecentHitting, recentPitching: awayRecentPitching }, awayHitting.available && awayPitching.available ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.MISSING, 'MLB_STATS_API_TEAM_BY_DATE_RANGE', { entityId: game.awayTeamId, asOf }),
    feature(gamePk, 'homeTeamStats', { hitting: homeHitting, pitching: homePitching, recentHitting: homeRecentHitting, recentPitching: homeRecentPitching }, homeHitting.available && homePitching.available ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.MISSING, 'MLB_STATS_API_TEAM_BY_DATE_RANGE', { entityId: game.homeTeamId, asOf }),
    feature(gamePk, 'awayStarter', awayStarter, awayStarter.status, 'MLB_STATS_API_PERSON_BY_DATE_RANGE', { entityId: game.awayProbableId || null, asOf, fallbackUsed: !game.awayProbableId || awayStarter.projectedFromTeamPitching === true }),
    feature(gamePk, 'homeStarter', homeStarter, homeStarter.status, 'MLB_STATS_API_PERSON_BY_DATE_RANGE', { entityId: game.homeProbableId || null, asOf, fallbackUsed: !game.homeProbableId || homeStarter.projectedFromTeamPitching === true }),
    feature(gamePk, 'venueRegistry', venue, venue.status, 'MLB_STATS_API_VENUE', { entityId: game.venueId }),
    feature(gamePk, 'parkFactor', parkFactor.available ? parkFactor : null, parkFactor.status, 'BASEBALL_SAVANT_STATCAST_PARK_FACTORS_INDEX_RUNS', { entityId: game.venueId, asOf, sampleSize: parkFactor.sampleSize || 0, providerObservedAt: parkFactor.fetchedAt, rawPayloadHash: parkFactor.rawPayloadHash, sourceRecord: parkFactor.sourceRecord, fallbackUsed: !parkFactor.available }),
    feature(gamePk, 'weather', weather.available ? weather : null, weather.status, 'OPEN_METEO_POINT_IN_TIME', { entityId: game.venueId, providerObservedAt: game.gameDate, fetchedAt: weather.fetchedAt, rawPayloadHash: weather.rawPayloadHash, fallbackUsed: !weather.available, qualityFlags: ['FIELD_ORIENTATION_NOT_AVAILABLE_WIND_DIRECTION_NOT_APPLIED'] }),
    feature(gamePk, 'awayInjuries', awayInjuries.rows, awayInjuries.status, 'MLB_STATS_API_ROSTER', { entityId: game.awayTeamId, asOf, fallbackUsed: !awayInjuries.available }),
    feature(gamePk, 'homeInjuries', homeInjuries.rows, homeInjuries.status, 'MLB_STATS_API_ROSTER', { entityId: game.homeTeamId, asOf, fallbackUsed: !homeInjuries.available }),
  ];
  const warnings = [
    'V10.3比分核心維持完全切離Legacy context與Legacy distribution。',
    '目前尚未建立可驗證的逐人projected lineup；中央值只使用球隊point-in-time進攻，打線未知以情境不確定性表示並標記MISSING。',
    '牛棚尚無可靠relief-only point-in-time切分時，只使用高度收縮的整隊投球代理並標記PROJECTED，避免重複計入先發。',
    '球場係數使用Baseball Savant三年滾動Statcast index_runs；來源失敗即MISSING，不再用單隊主客場總分比替代。',
    '傷停名單只作資料完整性與不確定性訊號；沒有可驗證個別run-value時不直接改寫平均得分。',
    'OAA／FRV、捕手framing、主審zone尚無可靠point-in-time來源時採中性分布並提高模型誤差，不當成0效果。',
    '缺少球場方位資料時不猜順逆風，風向不進平均得分。',
  ];
  return {
    game, league, away, home, park, weather,
    sourceStatuses: Object.fromEntries(rows.map(row => [row.name, row.status])),
    featureProvenance,
    dataGateV10,
    dataQualityV10: dataGateV10.quality,
    modelErrorMarginEV: dataGateV10.modelErrorMarginEV,
    dataVersion: MLB_CONTEXT_V11_VERSION,
    coreModelable: dataGateV10.passedForShadowScore,
    legacyContextUsed: false,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}
