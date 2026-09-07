import { buildGameContextV11, FEATURE_STATUS, parseBaseballInningsV11, normalizePitchingV11, mlbSourceReceiptV11, scopedStatSplitsV11 } from './mlb-context-v11.js';
import { sha256 } from './snapshot-v9.js';
import { buildSavantAdvancedSnapshotV2 } from './mlb-savant-advanced-v2.js';
import { buildInjuryRunValueV2 } from './mlb-injury-run-value-v2.js';
import { buildCatcherUmpireZoneV2 } from './mlb-catcher-umpire-zone-v2.js';
import { buildParkWindOrientationV2 } from './mlb-park-wind-orientation-v2.js';

export const MLB_CONTEXT_V13_VERSION = 'MLB-PIT-LINEUP-PLATOON-RELIEF-CONTEXT-2026-09-v11.0.5';
export const MLB_FEATURE_CONTRACT_V13 = Object.freeze({
  starterExpectedInnings: true,
  starterHandedness: true,
  officialOrProjectedLineup: true,
  teamPlatoonSplits: true,
  reliefOnlyBullpen: true,
  marketTargetCalibration: false,
  platoonTemporalContract: 'CURRENT_SEASON_AS_FETCHED_NOT_HISTORICAL_ARCHIVE',
  advancedFeaturesV2: 'PIT_ONLY_FAIL_NEUTRAL',
});

const MLB_API = 'https://statsapi.mlb.com/api/v1';
const MLB_LIVE_API = 'https://statsapi.mlb.com/api/v1.1/game';
const cache = globalThis.__MLB_V13_CONTEXT_CACHE__ || new Map();
const inflight = globalThis.__MLB_V13_CONTEXT_INFLIGHT__ || new Map();
const fetchIdentities = globalThis.__MLB_V13_FETCH_IDENTITIES__ || new WeakMap();
globalThis.__MLB_V13_CONTEXT_CACHE__ = cache;
globalThis.__MLB_V13_CONTEXT_INFLIGHT__ = inflight;
globalThis.__MLB_V13_FETCH_IDENTITIES__ = fetchIdentities;
let fetchIdentitySequence = globalThis.__MLB_V13_FETCH_SEQUENCE__ || 0;

const finite = (value, fallback = null) => value == null || (typeof value === 'string' && value.trim() === '') || typeof value === 'boolean' ? fallback : Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const clean = value => String(value || '').trim();

function isoDate(value) {
  const date = new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function shiftDate(value, days) {
  const date = new Date(value || Date.now());
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function seasonStart(value) {
  const year = Number(String(value || '').slice(0, 4)) || new Date().getUTCFullYear();
  return `${year}-03-01`;
}

function transportKey(fetchImpl) {
  if (!fetchIdentities.has(fetchImpl)) {
    fetchIdentitySequence += 1;
    globalThis.__MLB_V13_FETCH_SEQUENCE__ = fetchIdentitySequence;
    fetchIdentities.set(fetchImpl, fetchIdentitySequence);
  }
  return fetchIdentities.get(fetchImpl);
}

function cacheGet(key) {
  const row = cache.get(key);
  if (!row || row.expiresAt <= Date.now()) {
    if (row) cache.delete(key);
    return null;
  }
  return row.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function requestJson(url, { fetchImpl = fetch, timeoutMs = 12000, ttlMs = 5 * 60 * 1000 } = {}) {
  const sourceUrl = String(url);
  const key = `${transportKey(fetchImpl)}:${timeoutMs}:${sourceUrl}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fetchedAt = new Date().toISOString();
    try {
      const response = await fetchImpl(sourceUrl, {
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'User-Agent': 'Baseball-Positive-EV-v10.3' },
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      return cacheSet(key, {
        ok: response.ok && data != null,
        statusCode: response.status,
        data,
        fetchedAt,
        rawPayloadHash: sha256(text || ''),
        sourceRecord: sourceUrl,
        error: response.ok ? (data == null ? '回傳不是JSON' : '') : `HTTP ${response.status}`,
      }, response.ok && data != null ? ttlMs : Math.min(ttlMs, 60000));
    } catch (error) {
      return cacheSet(key, {
        ok: false,
        statusCode: 0,
        data: null,
        fetchedAt,
        rawPayloadHash: null,
        sourceRecord: sourceUrl,
        error: error?.name === 'AbortError' ? '資料取得逾時' : clean(error?.message || error),
      }, 30000);
    } finally {
      clearTimeout(timer);
    }
  })();
  inflight.set(key, request);
  try {
    return await request;
  } finally {
    if (inflight.get(key) === request) inflight.delete(key);
  }
}

function statSplits(payload) {
  return (payload?.stats || []).flatMap(block => block?.splits || []);
}

async function fetchLiveFeed(gamePk, options) {
  if (!gamePk) return { ok: false, data: null, error: '缺少gamePk', rawPayloadHash: null, sourceRecord: null };
  const response = await requestJson(`${MLB_LIVE_API}/${gamePk}/feed/live`, { ...options, ttlMs: options?.ttlMs ?? 60 * 1000 });
  if (response.ok && response.data?.gamePk != null && Number(response.data.gamePk) !== Number(gamePk)) {
    return { ...response, ok: false, data: null, error: 'MLB_FEED_GAME_ID_MISMATCH' };
  }
  return response;
}

export function validateCurrentFeedIdentityV13(feed, game) {
  if (!feed) return;
  const mismatches = [];
  if (feed.gamePk != null && Number(feed.gamePk) !== Number(game.gamePk)) mismatches.push('gamePk');
  for (const side of ['away', 'home']) {
    const actual = feed.gameData?.teams?.[side]?.id;
    if (actual != null && Number(actual) !== Number(game[`${side}TeamId`])) mismatches.push(`${side}TeamId`);
  }
  const officialDate = feed.gameData?.datetime?.officialDate;
  if (officialDate && game.officialDate && officialDate !== game.officialDate) mismatches.push('officialDate');
  const season = feed.gameData?.game?.season;
  if (season && game.officialDate && String(season) !== String(game.officialDate).slice(0, 4)) mismatches.push('season');
  if (mismatches.length) throw new Error(`MLB_CURRENT_GAME_IDENTITY_MISMATCH:${mismatches.join(',')}`);
}

async function fetchPlatoon(teamId, sitCode, startDate, endDate, options) {
  const url = new URL(`${MLB_API}/teams/${teamId}/stats`);
  url.searchParams.set('stats', 'statSplits');
  url.searchParams.set('group', 'hitting');
  url.searchParams.set('sportIds', '1');
  url.searchParams.set('season', String(endDate).slice(0, 4));
  url.searchParams.set('sitCodes', sitCode);
  return requestJson(url, { ...options, ttlMs: 15 * 60 * 1000 });
}

async function fetchStarterGameLog(personId, season, options) {
  if (!personId) return { ok: false, data: null, error: '未公布先發投手', rawPayloadHash: null, sourceRecord: null };
  const url = new URL(`${MLB_API}/people/${personId}/stats`);
  url.searchParams.set('stats', 'gameLog');
  url.searchParams.set('group', 'pitching');
  url.searchParams.set('season', String(season));
  url.searchParams.set('sportIds', '1');
  return requestJson(url, { ...options, ttlMs: 15 * 60 * 1000 });
}

function baseballOuts(value) {
  const match = clean(value).match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return Math.max(0, Math.round(parseBaseballInningsV11(value) * 3));
  const whole = Number(match[1]);
  const fraction = match[2] || '0';
  return whole * 3 + (/^1(?:0*)$/.test(fraction) ? 1 : /^2(?:0*)$/.test(fraction) ? 2 : 0);
}

export function starterOnlyGameLogV13(payload, { teamId = null, endDate = '' } = {}) {
  const targetTeamId = Number(teamId);
  const cutoff = clean(endDate);
  const starts = statSplits(payload).filter(split => {
    if (Number(split?.stat?.gamesStarted || 0) < 1) return false;
    if (cutoff && clean(split?.date) > cutoff) return false;
    const splitTeamId = Number(split?.team?.id ?? split?.teamId);
    return !Number.isSafeInteger(targetTeamId) || targetTeamId <= 0 || splitTeamId === targetTeamId;
  });
  if (!starts.length) return { available: false, status: FEATURE_STATUS.MISSING, gamesStarted: 0, gamesPitched: 0, inningsPitched: 0, source: 'MLB_PERSON_GAME_LOG_STARTS_ONLY' };
  const outs = starts.reduce((sum, split) => sum + baseballOuts(split?.stat?.inningsPitched), 0);
  const inningsPitched = outs / 3;
  const sum = key => starts.every(split => finite(split?.stat?.[key]) != null)
    ? starts.reduce((total, split) => total + Math.max(0, Number(split.stat[key])), 0) : null;
  const earnedRuns = sum('earnedRuns');
  const hits = sum('hits');
  const baseOnBalls = sum('baseOnBalls');
  const strikeOuts = sum('strikeOuts');
  const homeRuns = sum('homeRuns');
  const rate9 = value => value != null && inningsPitched > 0 ? value * 9 / inningsPitched : null;
  return {
    available: inningsPitched > 0,
    status: inningsPitched > 0 ? ([earnedRuns, hits, baseOnBalls, strikeOuts, homeRuns].every(value => value != null) ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED) : FEATURE_STATUS.MISSING,
    inningsPitched,
    gamesStarted: starts.length,
    gamesPitched: starts.length,
    earnedRuns,
    hits,
    baseOnBalls,
    strikeOuts,
    homeRuns,
    era: rate9(earnedRuns),
    whip: inningsPitched > 0 && hits != null && baseOnBalls != null ? (hits + baseOnBalls) / inningsPitched : null,
    kPer9: rate9(strikeOuts),
    bbPer9: rate9(baseOnBalls),
    hrPer9: rate9(homeRuns),
    starterOnly: true,
    source: 'MLB_PERSON_GAME_LOG_STARTS_ONLY',
  };
}

async function fetchActiveRoster(teamId, date, options) {
  const url = new URL(`${MLB_API}/teams/${teamId}/roster`);
  url.searchParams.set('rosterType', 'active');
  url.searchParams.set('date', date);
  return requestJson(url, { ...options, ttlMs: 10 * 60 * 1000 });
}

async function fetchInjuredRoster(teamId, date, options) {
  const url = new URL(`${MLB_API}/teams/${teamId}/roster`);
  url.searchParams.set('rosterType', 'injuredList');
  url.searchParams.set('date', date);
  url.searchParams.set('hydrate', `person(stats(group=[hitting],type=[season],season=${String(date).slice(0, 4)}))`);
  const response = await requestJson(url, { ...options, ttlMs: 10 * 60 * 1000 });
  return { ...response, rosterDate: date, available: response?.ok === true && Array.isArray(response?.data?.roster), roster: response?.data?.roster || [],
    sourceReceipts: [mlbSourceReceiptV11(response, 'MLB_GAME_DAY_INJURED_ROSTER_WITH_SEASON_HITTING', { purpose: 'CURRENT_INJURED_MEMBERSHIP_AND_AS_FETCHED_SEASON_STATS', temporalContract: 'GAME_DAY_ROSTER_SEASON_STATS_AS_FETCHED_NOT_HISTORICAL_ARCHIVE' })].filter(Boolean) };
}

function sideForTeam(feed, teamId) {
  if (Number(feed?.gameData?.teams?.away?.id || 0) === Number(teamId)) return 'away';
  if (Number(feed?.gameData?.teams?.home?.id || 0) === Number(teamId)) return 'home';
  return '';
}

function teamPlayers(feed, teamId) {
  const side = sideForTeam(feed, teamId);
  return side ? Object.values(feed?.liveData?.boxscore?.teams?.[side]?.players || {}) : [];
}

function homePlateUmpire(feed) {
  const row = (feed?.liveData?.boxscore?.officials || []).find(item => item?.officialType === 'Home Plate');
  return row ? { id: Number(row?.official?.id || 0) || null, name: clean(row?.official?.fullName), status: FEATURE_STATUS.CONFIRMED } : { id: null, name: '', status: FEATURE_STATUS.MISSING };
}

function battingStats(player) {
  // Game batting totals are never a substitute for the player's pregame season ability.
  const stat = player?.seasonStats?.batting || player?.pregameBattingStats || {};
  const obp = finite(stat.obp);
  const slg = finite(stat.slg);
  const ops = finite(stat.ops, obp != null && slg != null ? obp + slg : null);
  const plateAppearances = finite(stat.plateAppearances);
  return {
    plateAppearances,
    ops,
    obp,
    slg,
    metricAvailable: plateAppearances > 0 && ops != null,
    metricSource: player?.metricSource || (player?.seasonStats?.batting ? 'MLB_FEED_SEASON_BATTING' : 'MISSING'),
    metricProvenance: player?.metricProvenance || null,
  };
}

function lineupFromRows(rows, teamOps, { official = false, projected = false, source = '', sampleGames = 0 } = {}) {
  const unique = new Map();
  for (const row of rows || []) {
    const id = Number(row?.person?.id || row?.id || 0) || null;
    const key = id || clean(row?.person?.fullName || row?.name).toLowerCase();
    if (!key || unique.has(key)) continue;
    unique.set(key, row);
  }
  const ordered = [...unique.values()]
    .filter(row => Number(row?.battingOrder || 0) > 0)
    .sort((left, right) => Number(left.battingOrder) - Number(right.battingOrder))
    .slice(0, 9);
  const slotWeights = [1.05, 1.03, 1.08, 1.10, 1.07, 1, 0.96, 0.93, 0.90];
  let weightedLog = 0;
  let totalWeight = 0;
  const teamBaseline = finite(teamOps);
  const players = ordered.map((row, index) => {
    const stats = battingStats(row);
    const modelMetricUsed = stats.metricAvailable && teamBaseline > 0;
    const reliability = modelMetricUsed ? clamp(stats.plateAppearances / 180, 0.30, 1) : 0;
    // Unknown slots stay in the denominator at neutral strength, so one observed
    // batter cannot masquerade as nine known hitters.
    const weight = slotWeights[index] * (modelMetricUsed ? reliability : 1);
    totalWeight += weight;
    if (modelMetricUsed) weightedLog += Math.log(clamp(stats.ops / Math.max(0.55, teamBaseline), 0.72, 1.35)) * weight;
    return {
      id: Number(row?.person?.id || row?.id || 0) || null,
      name: clean(row?.person?.fullName || row?.name),
      position: clean(row?.position?.abbreviation || row?.position),
      battingOrder: Number(row?.battingOrder || (index + 1) * 100),
      ...stats,
      reliability,
      modelMetricUsed,
    };
  });
  for (let index = players.length; index < 9; index += 1) totalWeight += slotWeights[index];
  const officialSlotsComplete = players.length === 9 && new Set(players.map(row => row.battingOrder)).size === 9
    && players.every(row => row.battingOrder >= 100 && row.battingOrder <= 900 && row.battingOrder % 100 === 0);
  const identityStatus = official && officialSlotsComplete
    ? FEATURE_STATUS.CONFIRMED
    : players.length >= 7 ? FEATURE_STATUS.PROJECTED : FEATURE_STATUS.MISSING;
  const metricCount = players.filter(row => row.metricAvailable).length;
  const modelMetricCount = players.filter(row => row.modelMetricUsed).length;
  const metricsStatus = metricCount === 9 ? FEATURE_STATUS.CONFIRMED : metricCount > 0 ? FEATURE_STATUS.PROJECTED : FEATURE_STATUS.MISSING;
  const status = identityStatus === FEATURE_STATUS.CONFIRMED && modelMetricCount === 9
    ? FEATURE_STATUS.CONFIRMED
    : identityStatus !== FEATURE_STATUS.MISSING && modelMetricCount > 0 ? FEATURE_STATUS.PROJECTED : FEATURE_STATUS.MISSING;
  return {
    available: players.length >= 7 && modelMetricCount > 0,
    identityAvailable: players.length >= 7,
    official: identityStatus === FEATURE_STATUS.CONFIRMED,
    projected: identityStatus === FEATURE_STATUS.PROJECTED || projected,
    identityStatus,
    metricsStatus,
    metricCount,
    metricCoverage: metricCount / 9,
    modelMetricCoverage: modelMetricCount / 9,
    metricComplete: metricCount === 9,
    teamBaselineAvailable: teamBaseline > 0,
    missingMetricPlayerIds: players.filter(row => !row.metricAvailable).map(row => row.id),
    status,
    source,
    sampleGames,
    players,
    catcher: players.find(player => player.position === 'C')?.name || '',
    offensiveIndex: totalWeight > 0 ? clamp(Math.exp(weightedLog / totalWeight), 0.88, 1.12) : 1,
    missingCoreCount: Math.max(0, 9 - players.length),
  };
}

export function parseOfficialLineupV13(feed, teamId, teamOps = null) {
  const rows = teamPlayers(feed, teamId).filter(player => {
    const order = Number(player?.battingOrder || 0);
    return order >= 100 && order <= 900 && order % 100 === 0;
  });
  return lineupFromRows(rows, teamOps, {
    official: rows.length >= 9,
    projected: rows.length > 0 && rows.length < 9,
    source: 'MLB_CURRENT_GAME_LIVE_FEED',
    sampleGames: rows.length >= 9 ? 1 : 0,
  });
}

export function projectLineupV13(feeds, teamId, teamOps = null) {
  const appearances = new Map();
  const weights = [1, 0.86, 0.72, 0.58, 0.45, 0.34];
  (feeds || []).slice(0, 6).forEach((feed, index) => {
    const recencyWeight = weights[index] || 0.25;
    for (const player of teamPlayers(feed, teamId)) {
      if (!Number(player?.battingOrder || 0)) continue;
      const id = Number(player?.person?.id || 0) || null;
      if (!id) continue;
      const previous = appearances.get(id) || { player, appearanceWeight: 0, orderWeight: 0, orderTotal: 0, catcherWeight: 0 };
      // Feeds are newest first; older appearances must not overwrite newer season metrics.
      if (!previous.player) previous.player = player;
      previous.appearanceWeight += recencyWeight;
      previous.orderWeight += Number(player.battingOrder) * recencyWeight;
      previous.orderTotal += recencyWeight;
      if (player?.position?.abbreviation === 'C') previous.catcherWeight += recencyWeight;
      appearances.set(id, previous);
    }
  });
  const rows = [...appearances.values()]
    .sort((left, right) => right.appearanceWeight - left.appearanceWeight)
    .slice(0, 9)
    .map(row => ({
      ...row.player,
      battingOrder: Math.max(100, Math.min(900, Math.round((row.orderWeight / Math.max(row.orderTotal, 1)) / 100) * 100)),
      position: row.catcherWeight > row.appearanceWeight * 0.45
        ? { ...(row.player.position || {}), abbreviation: 'C' }
        : row.player.position,
    }))
    .sort((left, right) => Number(left.battingOrder) - Number(right.battingOrder));
  return lineupFromRows(rows, teamOps, {
    projected: true,
    source: 'MLB_RECENT_SIX_GAME_FEEDS_WEIGHTED_PROJECTION',
    sampleGames: Math.min(6, (feeds || []).length),
  });
}

function mergePartialOfficial(projected, official, teamOps) {
  if (official?.official || !official?.players?.length) return official?.official ? official : projected;
  const officialIds = new Set(official.players.map(row => row.id).filter(Boolean));
  const rows = [
    ...official.players.map(row => ({ ...row, person: { id: row.id, fullName: row.name }, position: { abbreviation: row.position }, seasonStats: { batting: row } })),
    ...(projected?.players || [])
      .filter(row => !officialIds.has(row.id))
      .map(row => ({ ...row, person: { id: row.id, fullName: row.name }, position: { abbreviation: row.position }, seasonStats: { batting: row } })),
  ].slice(0, 9);
  return lineupFromRows(rows, teamOps, {
    projected: true,
    source: 'MLB_PARTIAL_OFFICIAL_PLUS_RECENT_PROJECTION',
    sampleGames: projected?.sampleGames || 0,
  });
}

function lineupRows(lineup) {
  return (lineup?.players || []).map(row => ({
    ...row,
    person: { id: row.id, fullName: row.name },
    position: { abbreviation: row.position },
    seasonStats: { batting: row },
  }));
}

export async function hydrateLineupBattingV13(lineup, teamId, teamOps, asOf, options = {}) {
  const missing = (lineup?.players || []).filter(row => row.id && !row.metricAvailable);
  if (!missing.length) return lineup;
  const responses = new Map();
  // One official request per missing identity, at most six concurrent transports.
  for (let offset = 0; offset < missing.length; offset += 6) {
    await Promise.all(missing.slice(offset, offset + 6).map(async player => {
      const url = new URL(`${MLB_API}/people/${player.id}/stats`);
      url.searchParams.set('stats', 'byDateRange');
      url.searchParams.set('group', 'hitting');
      url.searchParams.set('season', String(asOf).slice(0, 4));
      url.searchParams.set('sportIds', '1');
      url.searchParams.set('startDate', seasonStart(asOf));
      url.searchParams.set('endDate', asOf);
      const response = await requestJson(url, { ...options, ttlMs: 15 * 60 * 1000 });
      responses.set(player.id, response);
    }));
  }
  const rows = lineupRows(lineup).map(row => {
    const response = responses.get(row.id);
    if (!response) return row;
    const splits = response.ok ? scopedStatSplitsV11(response.data, { group: 'hitting', playerId: row.id, season: asOf.slice(0, 4) }) : [];
    const aggregates = splits.filter(split => !split?.team?.id && !split?.teamId);
    const currentTeam = splits.filter(item => Number(item?.team?.id ?? item?.teamId) === Number(teamId));
    const split = aggregates.length === 1 ? aggregates[0] : currentTeam.length === 1 ? currentTeam[0] : splits.length === 1 ? splits[0] : null;
    const fetchedStats = split?.stat || null;
    // Keep one dated statistical block intact: a new PA count must not
    // borrow OPS from a different, incompletely dated feed snapshot.
    const stats = fetchedStats || row.seasonStats.batting;
    return {
      ...row,
      seasonStats: { batting: stats },
      metricSource: fetchedStats ? 'MLB_PERSON_HITTING_BY_DATE_RANGE' : row.metricSource,
      metricProvenance: {
        sourceRecord: response.sourceRecord,
        rawPayloadHash: response.rawPayloadHash,
        fetchedAt: response.fetchedAt,
        asOf,
        temporalContract: 'OFFICIAL_STATS_THROUGH_PREVIOUS_GAME_DAY',
        teamScope: split && !split.team?.id && !split.teamId ? 'ALL_TEAMS' : Number(split?.team?.id ?? split?.teamId) || null,
        error: fetchedStats ? null : response.error || '官方賽前打者統計未提供可用split',
      },
    };
  });
  return lineupFromRows(rows, teamOps, { official: lineup.official, projected: lineup.projected, source: lineup.source, sampleGames: lineup.sampleGames });
}

export function normalizePlatoonV13(response, sitCode, { teamId, season } = {}) {
  const candidates = scopedStatSplitsV11(response?.data, { group: 'hitting', teamId, season, sitCode });
  const split = candidates.length === 1 ? candidates[0] : null;
  const stat = split?.stat || {};
  const plateAppearances = finite(stat.plateAppearances);
  const obp = finite(stat.obp, null);
  const slg = finite(stat.slg, null);
  const ops = finite(stat.ops, obp != null && slg != null ? obp + slg : null);
  const available = response?.ok === true && plateAppearances > 0 && ops != null;
  return {
    available,
    // Observed season totals and a forecast model's reliability are different facts.
    // Keep the established model status and shrinkage until separately validated.
    status: available ? FEATURE_STATUS.PROJECTED : FEATURE_STATUS.MISSING,
    observationStatus: available ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.MISSING,
    modelStatus: available ? FEATURE_STATUS.PROJECTED : FEATURE_STATUS.MISSING,
    statusReason: available ? 'OBSERVED_CURRENT_SEASON_MODEL_RELIABILITY_PROJECTED' : 'MISSING_OR_AMBIGUOUS_SPLIT_SCOPE',
    teamId, season: String(season || ''),
    sitCode,
    plateAppearances,
    atBats: finite(stat.atBats),
    ops: available ? ops : null,
    sourceRecord: response?.sourceRecord || null,
    fetchedAt: response?.fetchedAt || null,
    source: 'MLB_TEAM_CURRENT_SEASON_STAT_SPLITS_AS_FETCHED',
    rawPayloadHash: response?.rawPayloadHash || null,
    temporalContract: 'CURRENT_SEASON_AS_FETCHED_NOT_HISTORICAL_ARCHIVE',
    asOf: null,
    historicalReconstruction: false,
  };
}

export function expectedStarterInningsV13(starter, { probableId = null, scheduledInnings = 9 } = {}) {
  const teamProxyRejected = starter?.projectedFromTeamPitching === true
    || starter?.teamPitchingProxyRejected === true
    || starter?.individualPitcherStatsAvailable === false;
  if (teamProxyRejected) {
    return {
      expectedInnings: probableId ? 4.8 : 4.5,
      rawSeasonInningsPerStart: null,
      gamesStarted: 0,
      gamesPitched: 0,
      role: 'UNKNOWN_STARTER_NEUTRAL',
      expectedInningsStatus: FEATURE_STATUS.PROJECTED,
      source: 'TEAM_PITCHING_PROXY_REJECTED_NEUTRAL',
      individualPitcherStatsAvailable: false,
      teamPitchingProxyRejected: true,
    };
  }
  const innings = Math.max(0, finite(starter?.inningsPitched, 0) || 0);
  const starts = Math.max(0, finite(starter?.gamesStarted, 0) || 0);
  const games = Math.max(starts, finite(starter?.gamesPitched, starts) || starts);
  const starterOnly = starter?.starterOnly === true || starter?.source === 'MLB_PERSON_GAME_LOG_STARTS_ONLY';
  const mixedRoleAggregate = starts > 0 && starts / Math.max(1, games) < 0.80 && !starterOnly;
  const raw = starts > 0 && !mixedRoleAggregate ? innings / starts : null;
  const fallback = games > 0 && (starts === 0 || starts / Math.max(1, games) < 0.45)
    ? 3.0
    : probableId ? 4.8 : 4.5;
  const maximum = Math.min(7.2, Math.max(5, Number(scheduledInnings) || 9));
  const expectedInnings = clamp(raw ?? fallback, 1, maximum);
  return {
    expectedInnings,
    rawSeasonInningsPerStart: raw,
    gamesStarted: starts,
    gamesPitched: games,
    role: starts === 0 && games > 0
      ? 'OPENER_OR_BULK_RISK'
      : starts > 0 && (expectedInnings < 3.5 || starts / Math.max(1, games) < 0.45)
        ? 'OPENER_OR_BULK_RISK'
        : mixedRoleAggregate ? 'MIXED_ROLE_STARTER_PROJECTED' : 'STARTER',
    expectedInningsStatus: probableId && starts >= 2 && raw != null ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED,
    source: starterOnly ? 'MLB_PERSON_GAME_LOG_STARTS_ONLY' : mixedRoleAggregate ? 'MIXED_ROLE_AGGREGATE_REJECTED_NEUTRAL' : 'MLB_PERSON_PIT_SEASON_IP_PER_START',
    individualPitcherStatsAvailable: innings > 0,
    teamPitchingProxyRejected: false,
  };
}

function starterWithExpectedInnings(starter, identity, expected) {
  const qualityMissing = expected?.individualPitcherStatsAvailable === false;
  const quality = qualityMissing ? {
    available: false,
    inningsPitched: 0,
    gamesStarted: 0,
    gamesPitched: 0,
    earnedRuns: null,
    hits: null,
    baseOnBalls: null,
    strikeOuts: null,
    homeRuns: null,
    era: null,
    whip: null,
    kPer9: null,
    bbPer9: null,
    hrPer9: null,
    fip: null,
    fipStatus: FEATURE_STATUS.MISSING,
    fipSource: 'TEAM_PITCHING_PROXY_REJECTED_NEUTRAL',
  } : {};
  return { ...(starter || {}), ...quality, ...identity, ...expected };
}

function pitchingStats(player) {
  const stat = player?.seasonStats?.pitching || {};
  const normalized = normalizePitchingV11(stat);
  return {
    ...normalized,
    saves: finite(stat.saves),
    holds: finite(stat.holds),
    metricSource: Object.keys(stat).length ? 'MLB_FEED_SEASON_PITCHING' : 'MISSING',
  };
}

const completePitchingMetrics = row => finite(row?.inningsPitched, 0) > 0
  && ['era', 'whip', 'strikeOuts', 'baseOnBalls', 'homeRuns'].every(key => finite(row?.[key]) != null);

export async function hydrateBullpenPitchingV13(roster, asOf, options = {}) {
  const responses = new Map();
  const missing = [...new Map((roster || []).filter(row => row.id && !completePitchingMetrics(row)).map(row => [row.id, row])).values()];
  for (let offset = 0; offset < missing.length; offset += 4) {
    await Promise.all(missing.slice(offset, offset + 4).map(async row => {
      const url = new URL(`${MLB_API}/people/${row.id}/stats`);
      url.searchParams.set('stats', 'byDateRange');
      url.searchParams.set('group', 'pitching');
      url.searchParams.set('season', String(asOf).slice(0, 4));
      url.searchParams.set('sportIds', '1');
      url.searchParams.set('startDate', seasonStart(asOf));
      url.searchParams.set('endDate', asOf);
      responses.set(row.id, await requestJson(url, { ...options, ttlMs: 15 * 60 * 1000 }));
    }));
  }
  return (roster || []).map(row => {
    const response = responses.get(row.id);
    if (!response) return row;
    const candidates = response.ok ? scopedStatSplitsV11(response.data, { group: 'pitching', playerId: row.id, season: asOf.slice(0, 4) }) : [];
    // The live feed uses the individual's season totals across teams. Only an
    // official total (or a single team stint) can replace that entire block.
    const totals = candidates.filter(split => !split.team?.id && !split.teamId);
    const selected = totals.length === 1 ? totals[0] : candidates.length === 1 ? candidates[0] : null;
    const stat = selected?.stat;
    const normalized = stat ? normalizePitchingV11(stat) : null;
    const usable = normalized?.available === true;
    const receipt = mlbSourceReceiptV11(response, 'MLB_PERSON_PITCHING_BY_DATE_RANGE', {
      asOf, purpose: usable ? 'MISSING_BULLPEN_PITCHING_METRICS' : 'BULLPEN_PITCHING_METRICS_UNAVAILABLE',
      temporalContract: 'OFFICIAL_STATS_THROUGH_PREVIOUS_GAME_DAY',
    });
    return {
      ...row,
      ...(usable ? { ...normalized, saves: finite(stat.saves), holds: finite(stat.holds), metricSource: 'MLB_PERSON_PITCHING_BY_DATE_RANGE' } : {}),
      sourceReceipts: [...(row.sourceReceipts || []), ...(receipt ? [receipt] : [])],
      metricProvenance: { ...receipt, playerId: row.id, teamScope: selected?.team?.id || 'ALL_TEAMS', accepted: usable, error: usable ? null : response.error || 'NO_USABLE_SCOPED_PITCHING_STATS' },
    };
  });
}

function activePitchersFromFeed(feed, teamId, excludedStarterId) {
  return teamPlayers(feed, teamId)
    .filter(player => {
      const id = Number(player?.person?.id || 0);
      const position = clean(player?.position?.abbreviation).toUpperCase();
      const stats = pitchingStats(player);
      return id && id !== Number(excludedStarterId) && (/^(P|SP|RP)$/.test(position) || stats.gamesPitched > 0);
    })
    .map(player => ({
      id: Number(player.person.id),
      name: clean(player?.person?.fullName),
      position: clean(player?.position?.abbreviation),
      ...pitchingStats(player),
    }));
}

function activePitchersFromRoster(payload, excludedStarterId) {
  return (Array.isArray(payload?.roster) ? payload.roster : [])
    .filter(row => {
      const id = Number(row?.person?.id || 0);
      const position = clean(row?.position?.abbreviation).toUpperCase();
      return id && id !== Number(excludedStarterId) && /^(P|SP|RP)$/.test(position);
    })
    .map(row => ({ id: Number(row.person.id), name: clean(row?.person?.fullName), position: clean(row?.position?.abbreviation) }));
}

function recentReliefUsage(feed, teamId) {
  const side = sideForTeam(feed, teamId);
  const team = side ? feed?.liveData?.boxscore?.teams?.[side] : null;
  const pitcherIds = Array.isArray(team?.pitchers) ? team.pitchers.map(Number).filter(Boolean) : [];
  if (!pitcherIds.length) return [];
  const starterId = pitcherIds[0];
  const players = team?.players || {};
  return pitcherIds.slice(1).map(id => {
    const player = players[`ID${id}`] || {};
    const gameStats = player?.stats?.pitching || {};
    return {
      id,
      starterId,
      name: clean(player?.person?.fullName),
      position: clean(player?.position?.abbreviation),
      pitches: finite(gameStats.numberOfPitches, 0) || 0,
      innings: parseBaseballInningsV11(gameStats.inningsPitched),
      ...pitchingStats(player),
    };
  });
}

function pitcherQuality(row, league) {
  const innings = Math.max(0, finite(row?.inningsPitched, 0) || 0);
  const leagueEra = Math.max(2.5, finite(league?.era, 4.25));
  const leagueWhip = Math.max(0.8, finite(league?.whip, 1.30));
  const kPer9 = innings > 0 && finite(row?.strikeOuts) != null ? Number(row.strikeOuts) * 9 / innings : finite(row?.kPer9, finite(league?.kPer9, 8.6));
  const bbPer9 = innings > 0 && finite(row?.baseOnBalls) != null ? Number(row.baseOnBalls) * 9 / innings : finite(row?.bbPer9, finite(league?.bbPer9, 3.2));
  const hrPer9 = innings > 0 && finite(row?.homeRuns) != null ? Number(row.homeRuns) * 9 / innings : finite(row?.hrPer9, finite(league?.hrPer9, 1.15));
  const fip = leagueEra
    + 0.60 * (hrPer9 - finite(league?.hrPer9, 1.15))
    + 0.24 * (bbPer9 - finite(league?.bbPer9, 3.2))
    - 0.16 * (kPer9 - finite(league?.kPer9, 8.6));
  const composite = Math.pow(Math.max(1.5, finite(row?.era, leagueEra)) / leagueEra, 0.25)
    * Math.pow(clamp(fip, 2, 7.5) / leagueEra, 0.55)
    * Math.pow(Math.max(0.7, finite(row?.whip, leagueWhip)) / leagueWhip, 0.20);
  const reliability = clamp(innings / (innings + 25), 0, 0.90);
  return clamp(Math.exp(Math.log(clamp(composite, 0.55, 1.75)) * reliability), 0.78, 1.28);
}

export function buildBullpenV13({ roster = [], recentFeeds = [], teamId, gameDate, probableStarterId, league = {}, rosterComplete = false }) {
  const target = new Date(gameDate || Date.now()).getTime();
  const byId = new Map();
  for (const row of roster || []) {
    if (!row?.id || Number(row.id) === Number(probableStarterId)) continue;
    byId.set(Number(row.id), { ...row, appearances: 0, weightedPitches: 0, pitchesLast1: 0, pitchesLast2: 0, daysUsed: new Set() });
  }
  const historicalOnly = new Map();
  let feedCount = 0;
  for (const feed of recentFeeds || []) {
    const feedDate = new Date(feed?.gameData?.datetime?.dateTime || feed?.gameData?.datetime?.officialDate || 0).getTime();
    if (Number.isFinite(feedDate) && feedDate >= target) continue;
    const daysAgo = Number.isFinite(feedDate) && feedDate > 0 ? Math.max(1, Math.round((target - feedDate) / 86400000)) : feedCount + 1;
    const weight = daysAgo <= 1 ? 1 : daysAgo === 2 ? 0.65 : daysAgo === 3 ? 0.35 : 0.18;
    const usage = recentReliefUsage(feed, teamId);
    if (usage.length) feedCount += 1;
    for (const used of usage) {
      if (Number(used.id) === Number(probableStarterId)) continue;
      const row = byId.get(Number(used.id));
      if (!row) {
        const past = historicalOnly.get(Number(used.id)) || { id: Number(used.id), name: used.name, appearances: 0, pitches: 0, eligibility: rosterComplete ? 'NOT_IN_VERIFIED_CURRENT_ROSTER' : 'CURRENT_ROSTER_UNAVAILABLE', modelUsed: false };
        past.appearances += 1;
        past.pitches += used.pitches;
        historicalOnly.set(past.id, past);
        continue;
      }
      // Do not combine an old numerator with current innings or the reverse.
      // A missing current block may use one whole historical season block.
      if (!row.metricProvenance?.accepted && !completePitchingMetrics(row) && completePitchingMetrics(used)) {
        const { id, name, position, appearances, weightedPitches, pitchesLast1, pitchesLast2, daysUsed, sourceReceipts, metricProvenance } = row;
        Object.assign(row, used, { id, name, position, appearances, weightedPitches, pitchesLast1, pitchesLast2, daysUsed, sourceReceipts, metricProvenance,
          metricSource: 'MLB_PRIOR_GAME_FEED_SEASON_PITCHING', metricAsOf: feed?.gameData?.datetime?.officialDate || null });
      }
      row.appearances += 1;
      row.weightedPitches += used.pitches * weight;
      if (daysAgo <= 1) row.pitchesLast1 += used.pitches;
      if (daysAgo <= 2) row.pitchesLast2 += used.pitches;
      row.daysUsed.add(daysAgo);
      byId.set(Number(used.id), row);
    }
  }
  const relievers = [...byId.values()].filter(row => {
    const position = clean(row?.position).toUpperCase();
    const gamesPitched = Math.max(0, finite(row?.gamesPitched, 0) || 0);
    const gamesStarted = Math.max(0, finite(row?.gamesStarted, 0) || 0);
    const observedInRelief = (finite(row?.appearances, 0) || 0) > 0;
    const seasonReliefShare = gamesPitched > 0 ? 1 - gamesStarted / gamesPitched : null;
    if (observedInRelief || position === 'RP') return true;
    if (position === 'SP') return false;
    if (seasonReliefShare != null) return seasonReliefShare >= 0.65;
    return position === 'P';
  }).map(row => {
    const consecutiveUse = row.daysUsed.has(1) && row.daysUsed.has(2);
    let availability = row.pitchesLast1 >= 35 ? 0.25 : row.pitchesLast1 >= 25 ? 0.50 : row.pitchesLast1 >= 15 ? 0.78 : 1;
    if (consecutiveUse) availability *= 0.78;
    return {
      ...row,
      daysUsed: [...row.daysUsed].sort((a, b) => a - b),
      eligibility: rosterComplete ? 'VERIFIED_CURRENT_ACTIVE_ROSTER' : 'CURRENT_FEED_ROSTER_UNVERIFIED',
      availabilityStatus: feedCount >= 1 ? FEATURE_STATUS.PROJECTED : FEATURE_STATUS.MISSING,
      consecutiveUse,
      availability: clamp(availability, 0.20, 1),
      qualityFactor: pitcherQuality(row, league),
      leverageScore: 1 + Math.min(15, finite(row.saves, 0) + finite(row.holds, 0)) / 15,
    };
  });
  const weightedQualityRows = relievers.map(row => ({
    ...row,
    weight: Math.max(3, finite(row.inningsPitched, 0)) * row.availability,
  }));
  const qualityWeight = weightedQualityRows.reduce((sum, row) => sum + row.weight, 0);
  const baseQuality = qualityWeight > 0
    ? weightedQualityRows.reduce((sum, row) => sum + row.qualityFactor * row.weight, 0) / qualityWeight
    : 1;
  const totalWeightedPitches = relievers.reduce((sum, row) => sum + row.weightedPitches, 0);
  const consecutiveHeavy = relievers.filter(row => row.consecutiveUse && row.weightedPitches >= 28).length;
  const lastDayHeavy = relievers.filter(row => row.pitchesLast1 >= 25).length;
  const fatigueIndex = clamp(totalWeightedPitches / Math.max(220, relievers.length * 30) + consecutiveHeavy * 0.07 + lastDayHeavy * 0.06, 0, 1);
  const leverageRows = relievers.filter(row => row.leverageScore > 1.05);
  const leverageWeight = leverageRows.reduce((sum, row) => sum + row.leverageScore, 0);
  const highLeverageAvailability = leverageWeight > 0
    ? leverageRows.reduce((sum, row) => sum + row.availability * row.leverageScore, 0) / leverageWeight
    : relievers.length ? relievers.reduce((sum, row) => sum + row.availability, 0) / relievers.length : 0.75;
  const qualityFactor = relievers.length ? clamp(baseQuality * (1 + fatigueIndex * 0.05 + (1 - highLeverageAvailability) * 0.04), 0.78, 1.30) : 1;
  const qualityCoverage = relievers.length
    ? relievers.filter(row => Math.max(0, finite(row?.inningsPitched, 0) || 0) > 0 && [row.era, row.whip, row.strikeOuts, row.baseOnBalls, row.homeRuns].every(value => finite(value) != null)).length / relievers.length
    : 0;
  const status = rosterComplete && relievers.length >= 6 && feedCount >= 1 && qualityCoverage >= 0.65
    ? FEATURE_STATUS.CONFIRMED
    : relievers.length >= 3 ? FEATURE_STATUS.PROJECTED : FEATURE_STATUS.MISSING;
  return {
    pureRelief: true,
    status,
    rosterAvailable: relievers.length >= 3,
    rosterComplete: Boolean(rosterComplete && relievers.length >= 6),
    usageAvailable: feedCount >= 1,
    recentFeedCount: feedCount,
    rosterCount: relievers.length,
    qualityCoverage,
    fatigueIndex,
    highLeverageAvailability: clamp(highLeverageAvailability, 0.25, 1),
    qualityFactor,
    qualityFactorIncludesUsage: feedCount >= 1 && relievers.length > 0,
    qualityFactorUsageSource: feedCount >= 1 && relievers.length > 0 ? 'MLB_RECENT_GAME_RELIEF_USAGE' : 'MISSING_NEUTRAL',
    relievers,
    historicalOnlyRelievers: [...historicalOnly.values()],
    excludedHistoricalCount: historicalOnly.size,
    source: 'MLB_ACTIVE_ROSTER_PLUS_RECENT_GAME_RELIEF_USAGE',
  };
}

function feature(gamePk, name, value, status, source, extra = {}) {
  return { gamePk, featureName: name, value, status, sourceProvider: source, normalizationVersion: MLB_CONTEXT_V13_VERSION, ...extra };
}

function buildGateV13(rows) {
  const missing = rows.filter(row => row.status === FEATURE_STATUS.MISSING);
  const projected = rows.filter(row => row.status === FEATURE_STATUS.PROJECTED);
  const blocking = rows.filter(row => row.core && row.status === FEATURE_STATUS.MISSING);
  const projectedCore = rows.filter(row => row.core && row.status === FEATURE_STATUS.PROJECTED);
  return {
    version: MLB_CONTEXT_V13_VERSION,
    rows,
    missing: missing.map(row => row.name),
    projected: projected.map(row => row.name),
    blocking: blocking.map(row => row.name),
    passedForShadowScore: blocking.length === 0,
    passedForFormalScore: blocking.length === 0 && missing.length === 0,
    quality: clamp(0.97 - missing.length * 0.038 - projected.length * 0.012, 0.50, 0.97),
    qualificationQuality: clamp(0.97 - blocking.length * 0.12 - projectedCore.length * 0.04, 0.5, 0.97),
    modelErrorMarginEV: clamp(0.006 + missing.length * 0.0055 + projected.length * 0.0015, 0.006, 0.05),
  };
}

function starterHand(feed, personId) {
  const player = feed?.gameData?.players?.[`ID${personId}`] || null;
  const hand = clean(player?.pitchHand?.code).toUpperCase();
  return hand === 'L' || hand === 'R' ? hand : '';
}

function combineRecentFeeds(base, feedMap, side) {
  return (base?.[side]?.scoring?.recentGames || [])
    .map(row => feedMap.get(Number(row.gamePk)))
    .filter(Boolean);
}

export async function buildGameContextV13(game, options = {}) {
  const asOf = shiftDate(game?.officialDate || game?.gameDate, -1);
  const startDate = seasonStart(asOf);
  const basePromise = buildGameContextV11(game, options);
  const currentFeedPromise = fetchLiveFeed(game?.gamePk, options);
  const splitPromises = [
    fetchPlatoon(game.awayTeamId, 'vl', startDate, asOf, options),
    fetchPlatoon(game.awayTeamId, 'vr', startDate, asOf, options),
    fetchPlatoon(game.homeTeamId, 'vl', startDate, asOf, options),
    fetchPlatoon(game.homeTeamId, 'vr', startDate, asOf, options),
    fetchStarterGameLog(game.awayProbableId, String(asOf).slice(0, 4), options),
    fetchStarterGameLog(game.homeProbableId, String(asOf).slice(0, 4), options),
  ];
  const [base, currentFeedResponse, awayVsLResponse, awayVsRResponse, homeVsLResponse, homeVsRResponse, awayStarterLogResponse, homeStarterLogResponse] = await Promise.all([
    basePromise,
    currentFeedPromise,
    ...splitPromises,
  ]);
  const currentFeed = currentFeedResponse?.data || null;
  if (currentFeedResponse?.error === 'MLB_FEED_GAME_ID_MISMATCH') throw new Error(currentFeedResponse.error);
  validateCurrentFeedIdentityV13(currentFeed, game);
  const recentGamePks = [...new Set([
    ...(base?.away?.scoring?.recentGames || []).map(row => Number(row.gamePk)),
    ...(base?.home?.scoring?.recentGames || []).map(row => Number(row.gamePk)),
  ].filter(Boolean))];
  const recentResponses = await Promise.all(recentGamePks.map(gamePk => fetchLiveFeed(gamePk, { ...options, ttlMs: 6 * 60 * 60 * 1000 })));
  const feedMap = new Map(recentGamePks.map((gamePk, index) => [gamePk, recentResponses[index]?.data || null]).filter(([, feed]) => feed));
  const awayRecentFeeds = combineRecentFeeds(base, feedMap, 'away');
  const homeRecentFeeds = combineRecentFeeds(base, feedMap, 'home');
  const recentResponseMap = new Map(recentGamePks.map((gamePk, index) => [gamePk, recentResponses[index]]));
  const feedReceipt = (response, purpose) => mlbSourceReceiptV11(response, 'MLB_GAME_LIVE_FEED', {
    purpose,
    sourceGameId: response?.data?.gamePk || null,
    sourceGameDate: response?.data?.gameData?.datetime?.officialDate || null,
    temporalContract: 'LIVE_FEED_AS_FETCHED_NOT_HISTORICAL_ARCHIVE',
  });
  const recentReceipts = (side, purpose) => (base?.[side]?.scoring?.recentGames || [])
    .map(row => recentResponseMap.get(Number(row.gamePk)))
    .filter(response => response?.data)
    .map(response => feedReceipt(response, purpose)).filter(Boolean);

  const awayOfficial = parseOfficialLineupV13(currentFeed, game.awayTeamId, base?.away?.hitting?.ops);
  const homeOfficial = parseOfficialLineupV13(currentFeed, game.homeTeamId, base?.home?.hitting?.ops);
  const awayProjected = projectLineupV13(awayRecentFeeds, game.awayTeamId, base?.away?.hitting?.ops);
  const homeProjected = projectLineupV13(homeRecentFeeds, game.homeTeamId, base?.home?.hitting?.ops);
  const rosterDate = clean(game?.officialDate || currentFeed?.gameData?.datetime?.officialDate) || isoDate(game.gameDate);
  const battingAsOf = shiftDate(rosterDate, -1);
  const [awayLineup, homeLineup] = await Promise.all([
    hydrateLineupBattingV13(mergePartialOfficial(awayProjected, awayOfficial, base?.away?.hitting?.ops), game.awayTeamId, base?.away?.hitting?.ops, battingAsOf, options),
    hydrateLineupBattingV13(mergePartialOfficial(homeProjected, homeOfficial, base?.home?.hitting?.ops), game.homeTeamId, base?.home?.hitting?.ops, battingAsOf, options),
  ]);
  for (const [side, lineup] of [['away', awayLineup], ['home', homeLineup]]) {
    lineup.sourceReceipts = [
      feedReceipt(currentFeedResponse, 'CURRENT_LINEUP_IDENTITY_AND_AVAILABLE_BATTING'),
      ...(lineup.official ? [] : recentReceipts(side, 'PROJECTED_LINEUP_IDENTITY_AND_AVAILABLE_BATTING')),
    ].filter(Boolean);
  }

  const [awayRosterResponse, homeRosterResponse] = await Promise.all([
    fetchActiveRoster(game.awayTeamId, rosterDate, options),
    fetchActiveRoster(game.homeTeamId, rosterDate, options),
  ]);
  const rosterFor = (response, teamId, starterId) => {
    const rows = Array.isArray(response?.data?.roster) ? response.data.roster : [];
    const ids = rows.map(row => Number(row?.person?.id || 0));
    const complete = response?.ok === true && rows.length >= 9
      && ids.every(id => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length;
    const current = activePitchersFromFeed(currentFeed, teamId, starterId);
    if (!complete) return { roster: [], complete: false };
    const currentById = new Map(current.map(row => [row.id, row]));
    return {
      roster: activePitchersFromRoster(response.data, starterId).map(row => ({ ...(currentById.get(row.id) || {}), ...row })),
      complete: true,
    };
  };
  const awayRosterState = rosterFor(awayRosterResponse, game.awayTeamId, game.awayProbableId);
  const homeRosterState = rosterFor(homeRosterResponse, game.homeTeamId, game.homeProbableId);
  const [awayRoster, homeRoster] = await Promise.all([
    hydrateBullpenPitchingV13(awayRosterState.roster, asOf, options),
    hydrateBullpenPitchingV13(homeRosterState.roster, asOf, options),
  ]);
  const awayRosterComplete = awayRosterState.complete;
  const homeRosterComplete = homeRosterState.complete;

  const awayBullpen = buildBullpenV13({ roster: awayRoster, recentFeeds: awayRecentFeeds, teamId: game.awayTeamId, gameDate: game.gameDate, probableStarterId: game.awayProbableId, league: base.league, rosterComplete: awayRosterComplete });
  const homeBullpen = buildBullpenV13({ roster: homeRoster, recentFeeds: homeRecentFeeds, teamId: game.homeTeamId, gameDate: game.gameDate, probableStarterId: game.homeProbableId, league: base.league, rosterComplete: homeRosterComplete });
  for (const [side, bullpen, response] of [['away', awayBullpen, awayRosterResponse], ['home', homeBullpen, homeRosterResponse]]) {
    bullpen.sourceReceipts = [
      mlbSourceReceiptV11(response, 'MLB_GAME_DAY_ACTIVE_ROSTER', { asOf: rosterDate, purpose: 'CURRENT_ROSTER_MEMBERSHIP' }),
      feedReceipt(currentFeedResponse, 'CURRENT_ROSTER_PITCHING_METRICS'),
      ...recentReceipts(side, 'RECENT_RELIEF_USAGE_AND_MISSING_PITCHING_METRICS'),
    ].filter(Boolean);
  }
  const awayStarterOnly = starterOnlyGameLogV13(awayStarterLogResponse?.data, { teamId: game.awayTeamId, endDate: asOf });
  const homeStarterOnly = starterOnlyGameLogV13(homeStarterLogResponse?.data, { teamId: game.homeTeamId, endDate: asOf });
  const starterInput = (side, starts, response) => ({
    ...base?.[side]?.starter,
    ...(starts.available ? Object.fromEntries(Object.entries(starts).filter(([, value]) => value != null)) : {}),
    sourceReceipts: [
      ...(base?.[side]?.starter?.sourceReceipts || []),
      mlbSourceReceiptV11(response, 'MLB_PERSON_GAME_LOG_STARTS_ONLY', { asOf, purpose: starts.available ? 'STARTER_ONLY_METRICS' : 'STARTER_ONLY_METRICS_UNAVAILABLE', temporalContract: 'OFFICIAL_STATS_THROUGH_PREVIOUS_GAME_DAY' }),
      feedReceipt(currentFeedResponse, 'STARTER_HANDEDNESS'),
    ].filter(Boolean),
  });
  const awayStarterInput = starterInput('away', awayStarterOnly, awayStarterLogResponse);
  const homeStarterInput = starterInput('home', homeStarterOnly, homeStarterLogResponse);
  const awayExpected = expectedStarterInningsV13(awayStarterInput, { probableId: game.awayProbableId, scheduledInnings: game.scheduledInnings });
  const homeExpected = expectedStarterInningsV13(homeStarterInput, { probableId: game.homeProbableId, scheduledInnings: game.scheduledInnings });
  const awayThrows = starterHand(currentFeed, game.awayProbableId);
  const homeThrows = starterHand(currentFeed, game.homeProbableId);
  const awayVsLeft = normalizePlatoonV13(awayVsLResponse, 'vl', { teamId: game.awayTeamId, season: asOf.slice(0, 4) });
  const awayVsRight = normalizePlatoonV13(awayVsRResponse, 'vr', { teamId: game.awayTeamId, season: asOf.slice(0, 4) });
  const homeVsLeft = normalizePlatoonV13(homeVsLResponse, 'vl', { teamId: game.homeTeamId, season: asOf.slice(0, 4) });
  const homeVsRight = normalizePlatoonV13(homeVsRResponse, 'vr', { teamId: game.homeTeamId, season: asOf.slice(0, 4) });

  let away = {
    ...base.away,
    lineup: awayLineup,
    vsLeft: awayVsLeft,
    vsRight: awayVsRight,
    bullpen: awayBullpen,
    starter: starterWithExpectedInnings(awayStarterInput, { id: game.awayProbableId || null, name: game.awayProbable || '', throws: awayThrows, throwsStatus: awayThrows ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.MISSING }, awayExpected),
  };
  let home = {
    ...base.home,
    lineup: homeLineup,
    vsLeft: homeVsLeft,
    vsRight: homeVsRight,
    bullpen: homeBullpen,
    starter: starterWithExpectedInnings(homeStarterInput, { id: game.homeProbableId || null, name: game.homeProbable || '', throws: homeThrows, throwsStatus: homeThrows ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.MISSING }, homeExpected),
  };

  const umpire = { ...homePlateUmpire(currentFeed), sourceReceipts: [feedReceipt(currentFeedResponse, 'CURRENT_HOME_PLATE_UMPIRE_IDENTITY')].filter(Boolean) };
  const advancedSnapshot = await buildSavantAdvancedSnapshotV2({ game, away, home }, options);
  const [awayInjuredResponse, homeInjuredResponse] = await Promise.all([
    fetchInjuredRoster(game.awayTeamId, rosterDate, options),
    fetchInjuredRoster(game.homeTeamId, rosterDate, options),
  ]);
  const leagueOps = finite(base?.league?.ops, 0.72);
  const awayInjury = buildInjuryRunValueV2({ injuredRoster: awayInjuredResponse, lineup: awayLineup, teamOps: base?.away?.hitting?.ops, leagueOps, observedAt: awayInjuredResponse?.fetchedAt || advancedSnapshot.observedAt });
  const homeInjury = buildInjuryRunValueV2({ injuredRoster: homeInjuredResponse, lineup: homeLineup, teamOps: base?.home?.hitting?.ops, leagueOps, observedAt: homeInjuredResponse?.fetchedAt || advancedSnapshot.observedAt });
  const awayUmpireZone = buildCatcherUmpireZoneV2({ catcherFraming: advancedSnapshot.away.catcherFraming, umpire, gameStart: game.gameDate, observedAt: advancedSnapshot.observedAt });
  const homeUmpireZone = buildCatcherUmpireZoneV2({ catcherFraming: advancedSnapshot.home.catcherFraming, umpire, gameStart: game.gameDate, observedAt: advancedSnapshot.observedAt });
  away = { ...away, advanced: { ...advancedSnapshot.away, injuryRunValue: awayInjury, umpireZone: awayUmpireZone } };
  home = { ...home, advanced: { ...advancedSnapshot.home, injuryRunValue: homeInjury, umpireZone: homeUmpireZone } };
  const advancedEnvironment = {
    directionalWind: buildParkWindOrientationV2({ venueId: game.venueId, weather: base?.weather, gameStart: game.gameDate, observedAt: base?.weather?.fetchedAt || advancedSnapshot.observedAt }),
  };

  const baseRows = (base?.dataGateV10?.rows || []).filter(row => row.name !== 'lineups');
  const rows = [
    ...baseRows,
    { name: 'lineups', status: awayLineup.status === FEATURE_STATUS.CONFIRMED && homeLineup.status === FEATURE_STATUS.CONFIRMED ? FEATURE_STATUS.CONFIRMED : awayLineup.available && homeLineup.available ? FEATURE_STATUS.PROJECTED : FEATURE_STATUS.MISSING, core: false },
    { name: 'starterExpectedInnings', status: awayExpected.expectedInningsStatus === FEATURE_STATUS.CONFIRMED && homeExpected.expectedInningsStatus === FEATURE_STATUS.CONFIRMED ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED, core: false },
    { name: 'starterHandedness', status: awayThrows && homeThrows ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.MISSING, core: false },
    { name: 'platoonSplits', status: [awayVsLeft, awayVsRight, homeVsLeft, homeVsRight].every(row => row.available)
      ? ([awayVsLeft, awayVsRight, homeVsLeft, homeVsRight].every(row => row.status === FEATURE_STATUS.CONFIRMED) ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED)
      : FEATURE_STATUS.MISSING, core: false },
    { name: 'reliefOnlyBullpen', status: awayBullpen.status === FEATURE_STATUS.CONFIRMED && homeBullpen.status === FEATURE_STATUS.CONFIRMED ? FEATURE_STATUS.CONFIRMED : awayBullpen.rosterAvailable && homeBullpen.rosterAvailable ? FEATURE_STATUS.PROJECTED : FEATURE_STATUS.MISSING, core: false },
    { name: 'defenseFRV', status: advancedSnapshot.sourceStatus.fielding, core: false },
    { name: 'catcherFraming', status: advancedSnapshot.sourceStatus.catcherFraming, core: false },
    { name: 'pitchTypeMatchup', status: advancedSnapshot.sourceStatus.pitchTypeMatchup, core: false },
    { name: 'injuryRunValue', status: awayInjury.status === FEATURE_STATUS.MISSING || homeInjury.status === FEATURE_STATUS.MISSING ? FEATURE_STATUS.MISSING : awayInjury.status === FEATURE_STATUS.CONFIRMED && homeInjury.status === FEATURE_STATUS.CONFIRMED ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED, core: false },
    { name: 'umpireZone', status: awayUmpireZone.status === FEATURE_STATUS.MISSING || homeUmpireZone.status === FEATURE_STATUS.MISSING ? FEATURE_STATUS.MISSING : FEATURE_STATUS.PROJECTED, core: false },
    { name: 'parkWindOrientation', status: advancedEnvironment.directionalWind.status, core: false },
  ];
  const dataGateV10 = buildGateV13(rows);
  const gamePk = Number(game?.gamePk || 0) || null;
  const addedProvenance = [
    feature(gamePk, 'awayLineup', awayLineup, awayLineup.status, awayLineup.source, { asOf, rawPayloadHash: sha256([currentFeedResponse?.rawPayloadHash, ...recentResponses.map(row => row?.rawPayloadHash)]) }),
    feature(gamePk, 'homeLineup', homeLineup, homeLineup.status, homeLineup.source, { asOf, rawPayloadHash: sha256([currentFeedResponse?.rawPayloadHash, ...recentResponses.map(row => row?.rawPayloadHash)]) }),
    feature(gamePk, 'starterExpectedInnings', { away: awayExpected, home: homeExpected }, rows.find(row => row.name === 'starterExpectedInnings').status, 'MLB_PERSON_GAME_LOG_STARTS_ONLY_OR_FAIL_NEUTRAL', { asOf, rawPayloadHash: sha256([awayStarterLogResponse?.rawPayloadHash, homeStarterLogResponse?.rawPayloadHash]) }),
    feature(gamePk, 'starterHandedness', { away: awayThrows || null, home: homeThrows || null }, rows.find(row => row.name === 'starterHandedness').status, 'MLB_CURRENT_GAME_LIVE_FEED', { asOf, rawPayloadHash: currentFeedResponse?.rawPayloadHash }),
    feature(gamePk, 'platoonSplits', { awayVsLeft, awayVsRight, homeVsLeft, homeVsRight }, rows.find(row => row.name === 'platoonSplits').status, 'MLB_TEAM_CURRENT_SEASON_STAT_SPLITS_AS_FETCHED', { asOf: null, rawPayloadHash: sha256([awayVsLResponse?.rawPayloadHash, awayVsRResponse?.rawPayloadHash, homeVsLResponse?.rawPayloadHash, homeVsRResponse?.rawPayloadHash]), qualityFlags: ['NOT_A_HISTORICAL_ARCHIVE', 'STATISTICAL_CUTOFF_UNVERIFIED'] }),
    feature(gamePk, 'reliefOnlyBullpen', { away: awayBullpen, home: homeBullpen }, rows.find(row => row.name === 'reliefOnlyBullpen').status, 'MLB_ACTIVE_ROSTER_PLUS_RECENT_GAME_RELIEF_USAGE', { asOf, rosterDate, rawPayloadHash: sha256([awayRosterResponse?.rawPayloadHash, homeRosterResponse?.rawPayloadHash, ...recentResponses.map(row => row?.rawPayloadHash)]) }),
    feature(gamePk, 'advancedSavantSnapshot', advancedSnapshot, Object.values(advancedSnapshot.sourceStatus).every(value => value === FEATURE_STATUS.CONFIRMED) ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED, 'BASEBALL_SAVANT_ADVANCED_CSV', { asOf, qualityFlags: ['CURRENT_SNAPSHOT_NOT_HISTORICAL_ARCHIVE'] }),
    feature(gamePk, 'injuryRunValue', { away: awayInjury, home: homeInjury }, rows.find(row => row.name === 'injuryRunValue').status, 'MLB_INJURED_LIST_PLUS_SEASON_STATS', { asOf, rawPayloadHash: sha256([awayInjuredResponse?.rawPayloadHash, homeInjuredResponse?.rawPayloadHash]), qualityFlags: ['VALIDATION_PENDING_NEUTRAL'] }),
    feature(gamePk, 'umpireZone', { away: awayUmpireZone, home: homeUmpireZone }, rows.find(row => row.name === 'umpireZone').status, 'SAVANT_FRAMING_ZONE_PLUS_HOME_PLATE_UMPIRE_RESIDUAL', { asOf, qualityFlags: ['2026_ABS_CHALLENGE_REESTIMATION_REQUIRED', 'VALIDATION_PENDING_NEUTRAL'] }),
    feature(gamePk, 'parkWindOrientation', advancedEnvironment.directionalWind, rows.find(row => row.name === 'parkWindOrientation').status, 'OPEN_METEO_PLUS_PARK_BEARING', { asOf, qualityFlags: ['PARK_SPECIFIC_OOS_COEFFICIENT_PENDING', 'VALIDATION_PENDING_NEUTRAL'] }),
  ];
  const warnings = [
    ...(base?.warnings || []).filter(message => !/正式打線未公布|牛棚尚無可靠relief-only/.test(message)),
    awayLineup.official && homeLineup.official
      ? '兩隊正式打線已由當場MLB live feed確認。'
      : '至少一隊正式打線尚未完整公布，使用近六場打序投影並提高模型誤差。',
    ...(awayLineup.metricComplete && homeLineup.metricComplete ? [] : [`打線名單與能力資料分開核對：客隊${awayLineup.metricCount}/9、主隊${homeLineup.metricCount}/9位有可用賽前打擊統計；缺資料位置不做強弱調整。`]),
    awayBullpen.status === FEATURE_STATUS.CONFIRMED && homeBullpen.status === FEATURE_STATUS.CONFIRMED
      ? '兩隊牛棚已排除先發，並納入近期逐後援用量、疲勞及高張力可用性。'
      : '至少一隊純牛棚名單或近期用量不完整，採收縮代理並提高模型誤差。',
    '預計先發局數使用point-in-time球季每場先發局數；無可靠資料時回退中性值，不使用盤口反推。',
    '左右投拆分分開列出本季實測與模型收縮狀態；即時statSplits未證實統計截止日，不宣稱可重建歷史賽前資料。',
    'OAA／FRV、捕手framing與球種對戰已建立Savant PIT快照；FRV會先扣除framing避免重複，但歷史OOS驗證通過前仍維持中性。',
    '傷停run value已比較缺席球員與替代層並保存原始／回歸值；主審zone及球場方位風向仍待建立。六項在PIT歷史驗證通過前全部維持中性。',
  ];
  return {
    ...base,
    away,
    home,
    umpire,
    advancedEnvironment,
    sourceStatuses: Object.fromEntries(rows.map(row => [row.name, row.status])),
    featureProvenance: [...(base?.featureProvenance || []), ...addedProvenance],
    dataGateV10,
    dataQualityV10: dataGateV10.quality,
    modelErrorMarginEV: dataGateV10.modelErrorMarginEV,
    dataVersion: MLB_CONTEXT_V13_VERSION,
    modelFeatureContract: MLB_FEATURE_CONTRACT_V13,
    coreModelable: dataGateV10.passedForShadowScore,
    legacyContextUsed: false,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}
