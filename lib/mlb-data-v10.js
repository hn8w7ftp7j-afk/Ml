import { buildGameContext as buildLegacyGameContext } from './mlb.js';
import { sha256 } from './snapshot-v9.js';

export const MLB_DATA_V10_VERSION = 'MLB-POINT-IN-TIME-DATA-2026-08-v10.0.0';
export const MLB_INNINGS_NORMALIZATION_VERSION = 'BASEBALL-INNINGS-THIRDS-v1.0.0';
export const MLB_PARK_FACTOR_VERSION = 'MLB-OFFICIAL-SCHEDULE-RUN-PARK-FACTOR-v1.0.0';
export const FEATURE_STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  PROJECTED: 'PROJECTED',
  MISSING: 'MISSING',
  STALE: 'STALE',
});

const MLB_API = 'https://statsapi.mlb.com/api';
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const responseCache = globalThis.__MLB_V10_DATA_CACHE__ || new Map();
globalThis.__MLB_V10_DATA_CACHE__ = responseCache;

const finite = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const clean = value => String(value || '').trim();

function isoDate(value) {
  const date = new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function dateShift(value, days) {
  const date = new Date(value || Date.now());
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function cacheGet(key) {
  const row = responseCache.get(key);
  if (!row || row.expiresAt <= Date.now()) {
    if (row) responseCache.delete(key);
    return null;
  }
  return row.value;
}

function cacheSet(key, value, ttlMs) {
  responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function requestJson(url, { fetchImpl = fetch, timeoutMs = 12000, ttlMs = 300000 } = {}) {
  const key = String(url);
  const cached = cacheGet(key);
  if (cached) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(key, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'User-Agent': 'Baseball-Positive-EV-v10/1.0' },
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    const result = {
      ok: response.ok && data != null,
      statusCode: response.status,
      data,
      fetchedAt,
      rawPayloadHash: sha256(text || ''),
      error: response.ok ? (data == null ? '回傳不是JSON' : '') : `HTTP ${response.status}`,
      url: key,
    };
    return cacheSet(key, result, result.ok ? ttlMs : Math.min(ttlMs, 60000));
  } catch (error) {
    return cacheSet(key, {
      ok: false,
      statusCode: 0,
      data: null,
      fetchedAt,
      rawPayloadHash: null,
      error: error?.name === 'AbortError' ? '資料取得逾時' : clean(error?.message || error),
      url: key,
    }, 30000);
  } finally {
    clearTimeout(timer);
  }
}

export function parseBaseballInnings(value) {
  if (value == null || clean(value) === '') return 0;
  const text = clean(value);
  const match = text.match(/^(-?\d+)(?:\.(\d+))?$/);
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

function uniqueTeamSplits(payload) {
  const rows = new Map();
  for (const split of statSplits(payload)) {
    const teamId = Number(split?.team?.id || split?.split?.team?.id || 0);
    if (!teamId) continue;
    rows.set(teamId, split);
  }
  return [...rows.values()];
}

export function parseLeagueBaselineV10(hittingPayload, pitchingPayload, metadata = {}) {
  const hitting = uniqueTeamSplits(hittingPayload);
  const pitching = uniqueTeamSplits(pitchingPayload);
  const totalRuns = hitting.reduce((sum, split) => sum + (finite(split?.stat?.runs, 0) || 0), 0);
  const totalTeamGames = hitting.reduce((sum, split) => sum + (finite(split?.stat?.gamesPlayed, 0) || 0), 0);
  const totalHits = pitching.reduce((sum, split) => sum + (finite(split?.stat?.hits, 0) || 0), 0);
  const totalWalks = pitching.reduce((sum, split) => sum + (finite(split?.stat?.baseOnBalls, 0) || 0), 0);
  const totalEarnedRuns = pitching.reduce((sum, split) => sum + (finite(split?.stat?.earnedRuns, 0) || 0), 0);
  const totalStrikeouts = pitching.reduce((sum, split) => sum + (finite(split?.stat?.strikeOuts, 0) || 0), 0);
  const totalHomeRuns = pitching.reduce((sum, split) => sum + (finite(split?.stat?.homeRuns, 0) || 0), 0);
  const totalInnings = pitching.reduce((sum, split) => sum + parseBaseballInnings(split?.stat?.inningsPitched), 0);
  const teamCount = new Set(hitting.map(split => Number(split?.team?.id || split?.split?.team?.id || 0))).size;
  const available = teamCount >= 26 && totalTeamGames > 0 && totalRuns > 0;
  const status = available ? (teamCount >= 30 ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED) : FEATURE_STATUS.MISSING;
  const runsPerTeamGame = available ? totalRuns / totalTeamGames : null;
  return {
    available,
    status,
    teamCount,
    sampleSize: totalTeamGames,
    totalRuns,
    totalTeamGames,
    runsPerTeamGame,
    era: totalInnings > 0 ? totalEarnedRuns * 9 / totalInnings : null,
    whip: totalInnings > 0 ? (totalHits + totalWalks) / totalInnings : null,
    kPer9: totalInnings > 0 ? totalStrikeouts * 9 / totalInnings : null,
    bbPer9: totalInnings > 0 ? totalWalks * 9 / totalInnings : null,
    hrPer9: totalInnings > 0 ? totalHomeRuns * 9 / totalInnings : null,
    asOf: metadata.asOf || null,
    season: metadata.season || null,
    sourceProvider: 'MLB_STATS_API_TEAM_AGGREGATE',
    sourceRecord: metadata.sourceRecord || null,
    rawPayloadHash: metadata.rawPayloadHash || null,
  };
}

export function parseVenuePayloadV10(payload, expectedVenueId = null) {
  const venue = (payload?.venues || []).find(row => !expectedVenueId || Number(row?.id) === Number(expectedVenueId))
    || payload?.venues?.[0]
    || null;
  const coordinates = venue?.location?.defaultCoordinates || venue?.location?.coordinates || {};
  const latitude = finite(coordinates.latitude ?? coordinates.lat);
  const longitude = finite(coordinates.longitude ?? coordinates.lon ?? coordinates.lng);
  const roofText = clean(venue?.fieldInfo?.roofType || venue?.fieldInfo?.roof || venue?.roofType).toLowerCase();
  const roof = /retract/.test(roofText) ? 'retractable'
    : /dome|closed|indoor/.test(roofText) ? 'dome'
      : /open|outdoor/.test(roofText) ? 'open' : 'unknown';
  const available = Boolean(venue?.id && Number.isFinite(latitude) && Number.isFinite(longitude));
  return {
    available,
    status: available ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.MISSING,
    id: Number(venue?.id || expectedVenueId || 0) || null,
    name: clean(venue?.name),
    latitude,
    longitude,
    roof,
    roofText: clean(venue?.fieldInfo?.roofType || venue?.fieldInfo?.roof || venue?.roofType),
    city: clean(venue?.location?.city),
    state: clean(venue?.location?.stateAbbrev || venue?.location?.state),
    country: clean(venue?.location?.country),
    timezone: clean(venue?.timeZone?.id || venue?.timezone?.id),
  };
}

export function parseInjuredListPayloadV10(payload) {
  const roster = Array.isArray(payload?.roster) ? payload.roster : null;
  if (!roster) return { available: false, status: FEATURE_STATUS.MISSING, rows: [], sampleSize: 0 };
  const rows = roster.map(item => ({
    id: Number(item?.person?.id || 0) || null,
    player: clean(item?.person?.fullName),
    position: clean(item?.position?.abbreviation || item?.position?.code),
    status: clean(item?.status?.description || item?.status?.code || item?.rosterStatus || 'Injured List'),
    date: clean(item?.statusDate || item?.date),
  })).filter(row => row.id || row.player);
  return { available: true, status: FEATURE_STATUS.CONFIRMED, rows, sampleSize: rows.length };
}

export function parseOfficialParkFactorV10(payload, { homeTeamId, venueId } = {}) {
  const games = (payload?.dates || []).flatMap(day => day?.games || []);
  const homeTotals = [];
  const roadTotals = [];
  for (const game of games) {
    const final = game?.status?.abstractGameState === 'Final' || game?.status?.codedGameState === 'F';
    const awayRuns = finite(game?.teams?.away?.score);
    const homeRuns = finite(game?.teams?.home?.score);
    if (!final || awayRuns == null || homeRuns == null) continue;
    const total = awayRuns + homeRuns;
    const officialHomeId = Number(game?.teams?.home?.team?.id || 0);
    const officialAwayId = Number(game?.teams?.away?.team?.id || 0);
    const officialVenueId = Number(game?.venue?.id || 0);
    if (officialHomeId === Number(homeTeamId) && (!venueId || officialVenueId === Number(venueId))) homeTotals.push(total);
    else if (officialAwayId === Number(homeTeamId)) roadTotals.push(total);
  }
  const homeAverage = homeTotals.length ? homeTotals.reduce((sum, value) => sum + value, 0) / homeTotals.length : null;
  const roadAverage = roadTotals.length ? roadTotals.reduce((sum, value) => sum + value, 0) / roadTotals.length : null;
  const sufficient = homeTotals.length >= 18 && roadTotals.length >= 18 && homeAverage > 0 && roadAverage > 0;
  if (!sufficient) {
    return {
      available: false,
      status: FEATURE_STATUS.MISSING,
      runFactor: 1,
      homeGames: homeTotals.length,
      roadGames: roadTotals.length,
      homeAverage,
      roadAverage,
      rawFactor: null,
      fallbackUsed: true,
      fallbackReason: '主客場完賽樣本不足',
    };
  }
  const rawFactor = clamp(homeAverage / roadAverage, 0.75, 1.30);
  const effectiveGames = Math.min(homeTotals.length, roadTotals.length);
  const priorGames = 80;
  const runFactor = clamp((rawFactor * effectiveGames + priorGames) / (effectiveGames + priorGames), 0.88, 1.15);
  return {
    available: true,
    status: FEATURE_STATUS.PROJECTED,
    runFactor,
    rawFactor,
    homeGames: homeTotals.length,
    roadGames: roadTotals.length,
    homeAverage,
    roadAverage,
    sampleSize: homeTotals.length + roadTotals.length,
    fallbackUsed: false,
    fallbackReason: '',
  };
}

function projectedComponentFip(block, league = {}) {
  const kPer9 = finite(block?.kPer9, finite(league?.kPer9, 8.5)) ?? 8.5;
  const bbPer9 = finite(block?.bbPer9, finite(league?.bbPer9, 3.2)) ?? 3.2;
  const hrPer9 = finite(block?.hrPer9, finite(league?.hrPer9, 1.15)) ?? 1.15;
  const leagueEra = finite(league?.era, 4.2) ?? 4.2;
  return clamp(leagueEra + 0.60 * (hrPer9 - (finite(league?.hrPer9, 1.15) ?? 1.15))
    + 0.24 * (bbPer9 - (finite(league?.bbPer9, 3.2) ?? 3.2))
    - 0.16 * (kPer9 - (finite(league?.kPer9, 8.5) ?? 8.5)), 2.0, 7.5);
}

export function normalizePitchingBlockV10(value, league = {}) {
  if (!value || typeof value !== 'object') return value;
  const inningsPitched = parseBaseballInnings(value.inningsPitched);
  const strikeOuts = finite(value.strikeOuts, 0) || 0;
  const baseOnBalls = finite(value.baseOnBalls, 0) || 0;
  const homeRuns = finite(value.homeRuns, 0) || 0;
  const normalized = {
    ...value,
    inningsPitched,
    kPer9: inningsPitched > 0 ? strikeOuts * 9 / inningsPitched : finite(value.kPer9, finite(league?.kPer9, 8.5)),
    bbPer9: inningsPitched > 0 ? baseOnBalls * 9 / inningsPitched : finite(value.bbPer9, finite(league?.bbPer9, 3.2)),
    hrPer9: inningsPitched > 0 ? homeRuns * 9 / inningsPitched : finite(value.hrPer9, finite(league?.hrPer9, 1.15)),
    inningsNormalizationVersion: MLB_INNINGS_NORMALIZATION_VERSION,
  };
  normalized.fip = projectedComponentFip(normalized, league);
  normalized.fipAvailable = false;
  normalized.fipStatus = FEATURE_STATUS.PROJECTED;
  normalized.fipSource = 'K_BB_HR_COMPONENT_ESTIMATE_NOT_ERA_COPY';
  return normalized;
}

function normalizeTeamPitchingV10(team, league) {
  if (!team || typeof team !== 'object') return team;
  const starter = team.starter && typeof team.starter === 'object'
    ? {
      ...team.starter,
      season: normalizePitchingBlockV10(team.starter.season, league),
      recent: normalizePitchingBlockV10(team.starter.recent, league),
    }
    : team.starter;
  if (starter?.season) {
    const starts = Math.max(1, finite(starter.season.gamesStarted, finite(starter.recent?.gamesStarted, 1)) || 1);
    starter.expectedInnings = clamp(starter.season.inningsPitched / starts || finite(starter.expectedInnings, 5.2), 3.2, 7.2);
  }
  const bullpen = team.bullpen && typeof team.bullpen === 'object' ? {
    ...team.bullpen,
    daily: (team.bullpen.daily || []).map(day => ({
      ...day,
      innings: parseBaseballInnings(day?.innings),
      relievers: (day?.relievers || []).map(row => ({ ...row, innings: parseBaseballInnings(row?.innings) })),
    })),
  } : team.bullpen;
  return {
    ...team,
    seasonPitching: normalizePitchingBlockV10(team.seasonPitching, league),
    recentPitching: normalizePitchingBlockV10(team.recentPitching, league),
    starter,
    bullpen,
  };
}

function estimateInjuryImpact(rows, missing = false) {
  if (missing) return 0.012;
  let impact = 0;
  for (const row of rows || []) {
    const position = clean(row.position).toUpperCase();
    impact += position === 'SP' ? 0.0045
      : position === 'RP' || position === 'P' ? 0.002
        : ['C', 'SS', 'CF'].includes(position) ? 0.004
          : 0.003;
  }
  return clamp(impact, 0, 0.045);
}

function standardFeature({ gamePk, featureName, entityId = null, value = null, unit = null, status, sourceProvider, sourceRecord = null,
  providerObservedAt = null, asOf = null, fetchedAt = null, expiresAt = null, sampleSize = null, fallbackUsed = false,
  fallbackReason = '', rawPayloadHash = null, normalizationVersion = MLB_DATA_V10_VERSION, qualityFlags = [] }) {
  return {
    gamePk,
    featureName,
    entityId,
    value,
    unit,
    status,
    sourceProvider,
    sourceRecord,
    providerObservedAt,
    asOf,
    fetchedAt,
    expiresAt,
    sampleSize,
    fallbackUsed,
    fallbackReason,
    rawPayloadHash,
    normalizationVersion,
    qualityFlags,
  };
}

async function fetchLeagueBaselineV10(game, options = {}) {
  const season = new Date(game?.gameDate || Date.now()).getUTCFullYear();
  const asOf = dateShift(game?.gameDate, -1);
  const regularSeasonStart = `${season}-03-01`;
  const endDate = asOf >= regularSeasonStart ? asOf : `${season - 1}-10-31`;
  const resolvedSeason = asOf >= regularSeasonStart ? season : season - 1;
  const startDate = `${resolvedSeason}-03-01`;
  const base = new URL(`${MLB_API}/v1/teams/stats`);
  for (const [key, value] of Object.entries({ stats: 'byDateRange', season: resolvedSeason, sportIds: 1, gameType: 'R', startDate, endDate })) {
    base.searchParams.set(key, String(value));
  }
  const hittingUrl = new URL(base); hittingUrl.searchParams.set('group', 'hitting');
  const pitchingUrl = new URL(base); pitchingUrl.searchParams.set('group', 'pitching');
  const [hitting, pitching] = await Promise.all([
    requestJson(hittingUrl, { ...options, ttlMs: 30 * 60 * 1000 }),
    requestJson(pitchingUrl, { ...options, ttlMs: 30 * 60 * 1000 }),
  ]);
  const parsed = parseLeagueBaselineV10(hitting.data, pitching.data, {
    asOf: endDate,
    season: resolvedSeason,
    sourceRecord: `${hittingUrl}|${pitchingUrl}`,
    rawPayloadHash: sha256([hitting.rawPayloadHash, pitching.rawPayloadHash]),
  });
  return {
    ...parsed,
    fetchedAt: [hitting.fetchedAt, pitching.fetchedAt].filter(Boolean).sort().at(-1) || null,
    error: [hitting.ok ? '' : hitting.error, pitching.ok ? '' : pitching.error].filter(Boolean).join('；'),
  };
}

async function fetchVenueV10(game, options = {}) {
  const venueId = Number(game?.venueId || 0);
  if (!venueId) return { available: false, status: FEATURE_STATUS.MISSING, id: null, error: '缺少venueId' };
  const url = new URL(`${MLB_API}/v1/venues/${venueId}`);
  url.searchParams.set('hydrate', 'location,fieldInfo,timezone');
  const response = await requestJson(url, { ...options, ttlMs: 24 * 60 * 60 * 1000 });
  return {
    ...parseVenuePayloadV10(response.data, venueId),
    fetchedAt: response.fetchedAt,
    rawPayloadHash: response.rawPayloadHash,
    sourceRecord: String(url),
    error: response.ok ? '' : response.error,
  };
}

async function fetchInjuriesV10(teamId, game, options = {}) {
  const season = new Date(game?.gameDate || Date.now()).getUTCFullYear();
  const asOf = dateShift(game?.gameDate, -1);
  const url = new URL(`${MLB_API}/v1/teams/${teamId}/roster`);
  url.searchParams.set('rosterType', 'injuredList');
  url.searchParams.set('season', String(season));
  url.searchParams.set('date', asOf);
  const response = await requestJson(url, { ...options, ttlMs: 15 * 60 * 1000 });
  return {
    ...parseInjuredListPayloadV10(response.data),
    fetchedAt: response.fetchedAt,
    rawPayloadHash: response.rawPayloadHash,
    sourceRecord: String(url),
    asOf,
    error: response.ok ? '' : response.error,
  };
}

async function fetchParkFactorV10(game, options = {}) {
  const season = new Date(game?.gameDate || Date.now()).getUTCFullYear();
  const endDate = dateShift(game?.gameDate, -1);
  const startDate = `${season - 1}-03-01`;
  const url = new URL(`${MLB_API}/v1/schedule`);
  for (const [key, value] of Object.entries({ sportId: 1, teamId: game?.homeTeamId, startDate, endDate, gameType: 'R', hydrate: 'linescore,venue,team' })) {
    url.searchParams.set(key, String(value));
  }
  const response = await requestJson(url, { ...options, timeoutMs: 16000, ttlMs: 6 * 60 * 60 * 1000 });
  return {
    ...parseOfficialParkFactorV10(response.data, { homeTeamId: game?.homeTeamId, venueId: game?.venueId }),
    fetchedAt: response.fetchedAt,
    rawPayloadHash: response.rawPayloadHash,
    sourceRecord: String(url),
    asOf: endDate,
    error: response.ok ? '' : response.error,
  };
}

async function fetchWeatherV10(game, venue, options = {}) {
  if (!venue?.available) return { available: false, status: FEATURE_STATUS.MISSING, error: '官方場館座標缺失', meanRunFactorV10: 1 };
  const target = new Date(game?.gameDate || Date.now());
  const targetDate = isoDate(target);
  const historical = target.getTime() < Date.now() - 5 * 86400000;
  const url = new URL(historical ? OPEN_METEO_ARCHIVE : OPEN_METEO_FORECAST);
  url.searchParams.set('latitude', String(venue.latitude));
  url.searchParams.set('longitude', String(venue.longitude));
  url.searchParams.set('hourly', 'temperature_2m,relative_humidity_2m,precipitation_probability,surface_pressure,wind_speed_10m,wind_direction_10m');
  url.searchParams.set('timezone', 'UTC');
  if (historical) {
    url.searchParams.set('start_date', targetDate);
    url.searchParams.set('end_date', targetDate);
  } else {
    url.searchParams.set('past_days', '2');
    url.searchParams.set('forecast_days', '3');
  }
  const response = await requestJson(url, { ...options, ttlMs: 10 * 60 * 1000 });
  const hourly = response.data?.hourly || {};
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  let index = -1;
  let difference = Infinity;
  times.forEach((value, currentIndex) => {
    const timestamp = Date.parse(`${value}${String(value).endsWith('Z') ? '' : 'Z'}`);
    const current = Math.abs(timestamp - target.getTime());
    if (Number.isFinite(timestamp) && current < difference) { difference = current; index = currentIndex; }
  });
  if (index < 0) {
    return {
      available: false,
      status: FEATURE_STATUS.MISSING,
      error: response.ok ? '找不到開賽時段天氣' : response.error,
      meanRunFactorV10: 1,
      fetchedAt: response.fetchedAt,
      rawPayloadHash: response.rawPayloadHash,
      sourceRecord: String(url),
    };
  }
  const temperature = finite(hourly.temperature_2m?.[index], 21) ?? 21;
  const humidity = finite(hourly.relative_humidity_2m?.[index], 50) ?? 50;
  const pressure = finite(hourly.surface_pressure?.[index], 1013) ?? 1013;
  const temperatureFactor = clamp(1 + (temperature - 21) * 0.0024, 0.94, 1.06);
  const pressureFactor = clamp(1 + (1013 - pressure) * 0.00018, 0.97, 1.03);
  const humidityFactor = clamp(1 + (humidity - 50) * 0.00012, 0.99, 1.01);
  return {
    available: true,
    status: historical ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED,
    temperature,
    relativeHumidity: humidity,
    surfacePressure: pressure,
    precipitationProbability: finite(hourly.precipitation_probability?.[index]),
    windSpeed: finite(hourly.wind_speed_10m?.[index]),
    windDirection: finite(hourly.wind_direction_10m?.[index]),
    directionalWindApplied: false,
    directionalWindStatus: FEATURE_STATUS.MISSING,
    meanRunFactorV10: clamp(temperatureFactor * pressureFactor * humidityFactor, 0.93, 1.08),
    time: times[index],
    roofClosedProbability: venue.roof === 'dome' ? 1 : venue.roof === 'open' ? 0 : 0.35,
    roofConfirmed: venue.roof === 'dome' || venue.roof === 'open',
    fetchedAt: response.fetchedAt,
    rawPayloadHash: response.rawPayloadHash,
    sourceRecord: String(url),
    error: '',
  };
}

function contextGateV10({ legacy, league, venue, parkFactor, weather, awayInjuries, homeInjuries }) {
  const rows = [
    { name: 'leagueBaseline', status: league.status, core: true },
    { name: 'venueRegistry', status: venue.status, core: true },
    { name: 'parkFactor', status: parkFactor.status, core: false },
    { name: 'weather', status: weather.status, core: false },
    { name: 'awayInjuries', status: awayInjuries.status, core: false },
    { name: 'homeInjuries', status: homeInjuries.status, core: false },
  ];
  if (legacy?.coreTeamData !== true) rows.push({ name: 'coreTeamStats', status: FEATURE_STATUS.MISSING, core: true });
  const missing = rows.filter(row => row.status === FEATURE_STATUS.MISSING);
  const projected = rows.filter(row => row.status === FEATURE_STATUS.PROJECTED);
  const blocking = rows.filter(row => row.core && row.status === FEATURE_STATUS.MISSING);
  const projectedCore = rows.filter(row => row.core && row.status === FEATURE_STATUS.PROJECTED);
  const passedForShadowScore = blocking.length === 0;
  const passedForFormalScore = passedForShadowScore && missing.length === 0;
  const quality = clamp(0.96 - missing.length * 0.055 - projected.length * 0.018, 0.55, 0.96);
  const modelErrorMarginEV = clamp(0.003 + missing.length * 0.006 + projected.length * 0.0015, 0.003, 0.035);
  return {
    version: MLB_DATA_V10_VERSION,
    rows,
    missing: missing.map(row => row.name),
    projected: projected.map(row => row.name),
    blocking: blocking.map(row => row.name),
    passedForShadowScore,
    passedForFormalScore,
    quality,
    qualificationQuality: clamp(0.96 - blocking.length * 0.12 - projectedCore.length * 0.04, 0.5, 0.96),
    modelErrorMarginEV,
  };
}

export async function buildGameContextV10(game, options = {}) {
  const [legacy, league, venue, awayInjuries, homeInjuries] = await Promise.all([
    buildLegacyGameContext(game),
    fetchLeagueBaselineV10(game, options),
    fetchVenueV10(game, options),
    fetchInjuriesV10(game?.awayTeamId, game, options),
    fetchInjuriesV10(game?.homeTeamId, game, options),
  ]);
  const [parkFactor, weather] = await Promise.all([
    fetchParkFactorV10(game, options),
    fetchWeatherV10(game, venue, options),
  ]);
  const resolvedLeague = league.available ? {
    ...legacy.league,
    ...league,
    runsPerTeamGame: league.runsPerTeamGame,
    source: 'MLB official 30-team point-in-time aggregate',
  } : {
    ...legacy.league,
    status: FEATURE_STATUS.MISSING,
    source: 'MLB official team aggregate unavailable; legacy value retained only as fallback',
  };
  const awayBase = normalizeTeamPitchingV10(legacy.away, resolvedLeague);
  const homeBase = normalizeTeamPitchingV10(legacy.home, resolvedLeague);
  const away = {
    ...awayBase,
    injuriesAvailable: awayInjuries.available,
    injuries: awayInjuries.rows,
    injuryStatus: awayInjuries.status,
    injuryImpact: estimateInjuryImpact(awayInjuries.rows, !awayInjuries.available),
  };
  const home = {
    ...homeBase,
    injuriesAvailable: homeInjuries.available,
    injuries: homeInjuries.rows,
    injuryStatus: homeInjuries.status,
    injuryImpact: estimateInjuryImpact(homeInjuries.rows, !homeInjuries.available),
  };
  const park = {
    ...legacy.park,
    id: venue.id || game?.venueId || null,
    name: venue.name || legacy.park?.name || game?.venue || '',
    nameEnglish: venue.name || game?.venueEnglish || '',
    lat: venue.latitude,
    lon: venue.longitude,
    roof: venue.roof,
    runFactor: parkFactor.available ? parkFactor.runFactor : 1,
    factorStatus: parkFactor.status,
    registryStatus: venue.status,
    factorSource: 'MLB official point-in-time home/road final scores with shrinkage',
    venueSource: 'MLB Stats API venue registry',
  };
  const gate = contextGateV10({ legacy, league, venue, parkFactor, weather, awayInjuries, homeInjuries });
  const gamePk = Number(game?.gamePk || 0) || null;
  const features = [
    standardFeature({ gamePk, featureName: 'leagueRunsPerTeamGame', value: league.runsPerTeamGame, unit: 'runs/team-game', status: league.status,
      sourceProvider: league.sourceProvider, sourceRecord: league.sourceRecord, asOf: league.asOf, fetchedAt: league.fetchedAt,
      sampleSize: league.sampleSize, fallbackUsed: !league.available, fallbackReason: league.error || '', rawPayloadHash: league.rawPayloadHash }),
    standardFeature({ gamePk, featureName: 'venueRegistry', entityId: venue.id, value: { name: venue.name, latitude: venue.latitude, longitude: venue.longitude, roof: venue.roof },
      status: venue.status, sourceProvider: 'MLB_STATS_API_VENUES', sourceRecord: venue.sourceRecord, fetchedAt: venue.fetchedAt,
      fallbackUsed: !venue.available, fallbackReason: venue.error || '', rawPayloadHash: venue.rawPayloadHash }),
    standardFeature({ gamePk, featureName: 'parkRunFactor', entityId: venue.id, value: park.runFactor, unit: 'multiplier', status: parkFactor.status,
      sourceProvider: 'MLB_STATS_API_SCHEDULE_DERIVED', sourceRecord: parkFactor.sourceRecord, asOf: parkFactor.asOf, fetchedAt: parkFactor.fetchedAt,
      sampleSize: parkFactor.sampleSize, fallbackUsed: !parkFactor.available, fallbackReason: parkFactor.fallbackReason || parkFactor.error || '', rawPayloadHash: parkFactor.rawPayloadHash,
      normalizationVersion: MLB_PARK_FACTOR_VERSION }),
    standardFeature({ gamePk, featureName: 'weather', entityId: venue.id, value: weather.available ? {
      temperature: weather.temperature, humidity: weather.relativeHumidity, pressure: weather.surfacePressure,
      windSpeed: weather.windSpeed, windDirection: weather.windDirection, meanRunFactor: weather.meanRunFactorV10,
    } : null, status: weather.status, sourceProvider: 'OPEN_METEO_POINT_IN_TIME', sourceRecord: weather.sourceRecord,
      providerObservedAt: weather.time || null, fetchedAt: weather.fetchedAt, fallbackUsed: !weather.available,
      fallbackReason: weather.error || '', rawPayloadHash: weather.rawPayloadHash,
      qualityFlags: weather.directionalWindApplied ? [] : ['WIND_DIRECTION_RELATIVE_TO_FIELD_MISSING'] }),
    standardFeature({ gamePk, featureName: 'awayInjuries', entityId: game?.awayTeamId, value: awayInjuries.rows, status: awayInjuries.status,
      sourceProvider: 'MLB_STATS_API_INJURED_LIST', sourceRecord: awayInjuries.sourceRecord, asOf: awayInjuries.asOf, fetchedAt: awayInjuries.fetchedAt,
      sampleSize: awayInjuries.sampleSize, fallbackUsed: !awayInjuries.available, fallbackReason: awayInjuries.error || '', rawPayloadHash: awayInjuries.rawPayloadHash }),
    standardFeature({ gamePk, featureName: 'homeInjuries', entityId: game?.homeTeamId, value: homeInjuries.rows, status: homeInjuries.status,
      sourceProvider: 'MLB_STATS_API_INJURED_LIST', sourceRecord: homeInjuries.sourceRecord, asOf: homeInjuries.asOf, fetchedAt: homeInjuries.fetchedAt,
      sampleSize: homeInjuries.sampleSize, fallbackUsed: !homeInjuries.available, fallbackReason: homeInjuries.error || '', rawPayloadHash: homeInjuries.rawPayloadHash }),
  ];
  const warnings = [...new Set([
    ...(legacy.warnings || []),
    ...(!parkFactor.available ? ['球場係數樣本不足，採中性1.00並提高模型誤差；不靜默視為已確認'] : []),
    ...(!awayInjuries.available || !homeInjuries.available ? ['傷停名單資料缺失，採非零中性傷停先驗並標示MISSING'] : []),
    ...(!weather.available ? ['官方場館座標或天氣資料缺失，環境因子採中性並標示MISSING'] : []),
    ...(!weather.directionalWindApplied ? ['缺少球場方位資料，風向只列為未建模風險，不猜測順逆風'] : []),
  ])];
  return {
    ...legacy,
    game,
    league: resolvedLeague,
    away,
    home,
    park,
    weather,
    warnings,
    featureProvenance: features,
    dataGateV10: gate,
    dataQualityV10: gate.quality,
    modelErrorMarginEV: gate.modelErrorMarginEV,
    dataVersion: MLB_DATA_V10_VERSION,
    coreModelable: Boolean(legacy.coreModelable && gate.passedForShadowScore),
    fetchedAt: new Date().toISOString(),
  };
}
