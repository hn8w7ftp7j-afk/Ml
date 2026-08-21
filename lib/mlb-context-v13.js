import { buildGameContextV11, FEATURE_STATUS, parseBaseballInningsV11 } from './mlb-context-v11.js';
import { sha256 } from './snapshot-v9.js';

export const MLB_CONTEXT_V13_VERSION = 'MLB-PIT-LINEUP-PLATOON-RELIEF-CONTEXT-2026-08-v10.6.0';
export const MLB_FEATURE_CONTRACT_V13 = Object.freeze({
  starterExpectedInnings: true,
  starterHandedness: true,
  officialOrProjectedLineup: true,
  teamPlatoonSplits: true,
  reliefOnlyBullpen: true,
  marketTargetCalibration: false,
  platoonTemporalContract: 'CURRENT_SEASON_AS_FETCHED_NOT_HISTORICAL_ARCHIVE',
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

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
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
  return requestJson(`${MLB_LIVE_API}/${gamePk}/feed/live`, { ...options, ttlMs: options?.ttlMs ?? 60 * 1000 });
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

async function fetchActiveRoster(teamId, date, options) {
  const url = new URL(`${MLB_API}/teams/${teamId}/roster`);
  url.searchParams.set('rosterType', 'active');
  url.searchParams.set('date', date);
  return requestJson(url, { ...options, ttlMs: 10 * 60 * 1000 });
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

function battingStats(player) {
  const stat = player?.seasonStats?.batting || player?.stats?.batting || {};
  const obp = finite(stat.obp, 0.32);
  const slg = finite(stat.slg, 0.40);
  return {
    plateAppearances: finite(stat.plateAppearances || stat.atBats, 0) || 0,
    ops: finite(stat.ops, (obp || 0.32) + (slg || 0.40)) || 0.72,
    obp: obp || 0.32,
    slg: slg || 0.40,
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
  const players = ordered.map((row, index) => {
    const stats = battingStats(row);
    const reliability = clamp(stats.plateAppearances / 180, 0.30, 1);
    const weight = slotWeights[index] * reliability;
    totalWeight += weight;
    weightedLog += Math.log(clamp(stats.ops / Math.max(0.55, finite(teamOps, 0.72)), 0.72, 1.35)) * weight;
    return {
      id: Number(row?.person?.id || row?.id || 0) || null,
      name: clean(row?.person?.fullName || row?.name),
      position: clean(row?.position?.abbreviation || row?.position),
      battingOrder: Number(row?.battingOrder || (index + 1) * 100),
      ...stats,
    };
  });
  const status = official && players.length === 9
    ? FEATURE_STATUS.CONFIRMED
    : players.length >= 7 ? FEATURE_STATUS.PROJECTED : FEATURE_STATUS.MISSING;
  return {
    available: players.length >= 7,
    official: status === FEATURE_STATUS.CONFIRMED,
    projected: status === FEATURE_STATUS.PROJECTED || projected,
    status,
    source,
    sampleGames,
    players,
    catcher: players.find(player => player.position === 'C')?.name || '',
    offensiveIndex: totalWeight > 0 ? clamp(Math.exp(weightedLog / totalWeight), 0.88, 1.12) : 1,
    missingCoreCount: Math.max(0, 9 - players.length),
  };
}

export function parseOfficialLineupV13(feed, teamId, teamOps = 0.72) {
  const rows = teamPlayers(feed, teamId).filter(player => Number(player?.battingOrder || 0) > 0);
  return lineupFromRows(rows, teamOps, {
    official: rows.length >= 9,
    projected: rows.length > 0 && rows.length < 9,
    source: 'MLB_CURRENT_GAME_LIVE_FEED',
    sampleGames: rows.length >= 9 ? 1 : 0,
  });
}

export function projectLineupV13(feeds, teamId, teamOps = 0.72) {
  const appearances = new Map();
  const weights = [1, 0.86, 0.72, 0.58, 0.45, 0.34];
  (feeds || []).slice(0, 6).forEach((feed, index) => {
    const recencyWeight = weights[index] || 0.25;
    for (const player of teamPlayers(feed, teamId)) {
      if (!Number(player?.battingOrder || 0)) continue;
      const id = Number(player?.person?.id || 0) || null;
      if (!id) continue;
      const previous = appearances.get(id) || { player, appearanceWeight: 0, orderWeight: 0, orderTotal: 0, catcherWeight: 0 };
      previous.player = player;
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
    ...official.players.map(row => ({ ...row, person: { id: row.id, fullName: row.name }, position: { abbreviation: row.position }, stats: { batting: row } })),
    ...(projected?.players || [])
      .filter(row => !officialIds.has(row.id))
      .map(row => ({ ...row, person: { id: row.id, fullName: row.name }, position: { abbreviation: row.position }, stats: { batting: row } })),
  ].slice(0, 9);
  return lineupFromRows(rows, teamOps, {
    projected: true,
    source: 'MLB_PARTIAL_OFFICIAL_PLUS_RECENT_PROJECTION',
    sampleGames: projected?.sampleGames || 0,
  });
}

function normalizePlatoon(response, sitCode) {
  const split = statSplits(response?.data)?.[0] || null;
  const stat = split?.stat || {};
  const plateAppearances = finite(stat.plateAppearances || stat.atBats, 0) || 0;
  const obp = finite(stat.obp, null);
  const slg = finite(stat.slg, null);
  const ops = finite(stat.ops, obp != null && slg != null ? obp + slg : null);
  const available = response?.ok === true && plateAppearances > 0 && ops != null;
  return {
    available,
    status: available ? FEATURE_STATUS.PROJECTED : FEATURE_STATUS.MISSING,
    sitCode,
    plateAppearances,
    ops: available ? ops : null,
    sourceRecord: response?.sourceRecord || null,
    rawPayloadHash: response?.rawPayloadHash || null,
    temporalContract: 'CURRENT_SEASON_AS_FETCHED_NOT_HISTORICAL_ARCHIVE',
  };
}

export function expectedStarterInningsV13(starter, { probableId = null, scheduledInnings = 9 } = {}) {
  const innings = Math.max(0, finite(starter?.inningsPitched, 0) || 0);
  const starts = Math.max(0, finite(starter?.gamesStarted, 0) || 0);
  const games = Math.max(starts, finite(starter?.gamesPitched, starts) || starts);
  const raw = starts > 0 ? innings / starts : null;
  const fallback = probableId ? 5.2 : 4.8;
  const maximum = Math.min(7.2, Math.max(5, Number(scheduledInnings) || 9));
  const expectedInnings = clamp(raw ?? fallback, 1, maximum);
  return {
    expectedInnings,
    rawSeasonInningsPerStart: raw,
    gamesStarted: starts,
    gamesPitched: games,
    role: starts > 0 && (expectedInnings < 3.5 || starts / Math.max(1, games) < 0.45) ? 'OPENER_OR_BULK_RISK' : 'STARTER',
    expectedInningsStatus: probableId && starts >= 2 && raw != null ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.PROJECTED,
    source: 'MLB_PERSON_PIT_SEASON_IP_PER_START',
  };
}

function pitchingStats(player) {
  const stat = player?.seasonStats?.pitching || player?.stats?.pitching || {};
  const inningsPitched = parseBaseballInningsV11(stat.inningsPitched);
  return {
    inningsPitched,
    gamesPitched: finite(stat.gamesPitched, 0) || 0,
    gamesStarted: finite(stat.gamesStarted, 0) || 0,
    era: finite(stat.era, 4.25) || 4.25,
    whip: finite(stat.whip, 1.30) || 1.30,
    strikeOuts: finite(stat.strikeOuts, 0) || 0,
    baseOnBalls: finite(stat.baseOnBalls, 0) || 0,
    homeRuns: finite(stat.homeRuns, 0) || 0,
    saves: finite(stat.saves, 0) || 0,
    holds: finite(stat.holds, 0) || 0,
  };
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
  const kPer9 = innings > 0 ? finite(row?.strikeOuts, 0) * 9 / innings : finite(league?.kPer9, 8.6);
  const bbPer9 = innings > 0 ? finite(row?.baseOnBalls, 0) * 9 / innings : finite(league?.bbPer9, 3.2);
  const hrPer9 = innings > 0 ? finite(row?.homeRuns, 0) * 9 / innings : finite(league?.hrPer9, 1.15);
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
  let feedCount = 0;
  for (const feed of recentFeeds || []) {
    const feedDate = new Date(feed?.gameData?.datetime?.dateTime || feed?.gameData?.datetime?.officialDate || 0).getTime();
    const daysAgo = Number.isFinite(feedDate) && feedDate > 0 ? Math.max(1, Math.round((target - feedDate) / 86400000)) : feedCount + 1;
    const weight = daysAgo <= 1 ? 1 : daysAgo === 2 ? 0.65 : daysAgo === 3 ? 0.35 : 0.18;
    const usage = recentReliefUsage(feed, teamId);
    if (usage.length) feedCount += 1;
    for (const used of usage) {
      if (Number(used.id) === Number(probableStarterId)) continue;
      const row = byId.get(Number(used.id)) || { ...used, appearances: 0, weightedPitches: 0, pitchesLast1: 0, pitchesLast2: 0, daysUsed: new Set() };
      Object.assign(row, { ...used, id: Number(used.id) });
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
  const qualityFactor = clamp(baseQuality * (1 + fatigueIndex * 0.05 + (1 - highLeverageAvailability) * 0.04), 0.78, 1.30);
  const qualityCoverage = relievers.length
    ? relievers.filter(row => Math.max(0, finite(row?.inningsPitched, 0) || 0) > 0).length / relievers.length
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
    relievers,
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
  const asOf = shiftDate(game?.gameDate, -1);
  const startDate = seasonStart(asOf);
  const basePromise = buildGameContextV11(game, options);
  const currentFeedPromise = fetchLiveFeed(game?.gamePk, options);
  const splitPromises = [
    fetchPlatoon(game.awayTeamId, 'vl', startDate, asOf, options),
    fetchPlatoon(game.awayTeamId, 'vr', startDate, asOf, options),
    fetchPlatoon(game.homeTeamId, 'vl', startDate, asOf, options),
    fetchPlatoon(game.homeTeamId, 'vr', startDate, asOf, options),
  ];
  const [base, currentFeedResponse, awayVsLResponse, awayVsRResponse, homeVsLResponse, homeVsRResponse] = await Promise.all([
    basePromise,
    currentFeedPromise,
    ...splitPromises,
  ]);
  const currentFeed = currentFeedResponse?.data || null;
  const recentGamePks = [...new Set([
    ...(base?.away?.scoring?.recentGames || []).map(row => Number(row.gamePk)),
    ...(base?.home?.scoring?.recentGames || []).map(row => Number(row.gamePk)),
  ].filter(Boolean))];
  const recentResponses = await Promise.all(recentGamePks.map(gamePk => fetchLiveFeed(gamePk, { ...options, ttlMs: 6 * 60 * 60 * 1000 })));
  const feedMap = new Map(recentGamePks.map((gamePk, index) => [gamePk, recentResponses[index]?.data || null]).filter(([, feed]) => feed));
  const awayRecentFeeds = combineRecentFeeds(base, feedMap, 'away');
  const homeRecentFeeds = combineRecentFeeds(base, feedMap, 'home');

  const awayOfficial = parseOfficialLineupV13(currentFeed, game.awayTeamId, base?.away?.hitting?.ops);
  const homeOfficial = parseOfficialLineupV13(currentFeed, game.homeTeamId, base?.home?.hitting?.ops);
  const awayProjected = projectLineupV13(awayRecentFeeds, game.awayTeamId, base?.away?.hitting?.ops);
  const homeProjected = projectLineupV13(homeRecentFeeds, game.homeTeamId, base?.home?.hitting?.ops);
  const awayLineup = mergePartialOfficial(awayProjected, awayOfficial, base?.away?.hitting?.ops);
  const homeLineup = mergePartialOfficial(homeProjected, homeOfficial, base?.home?.hitting?.ops);

  let awayRoster = activePitchersFromFeed(currentFeed, game.awayTeamId, game.awayProbableId);
  let homeRoster = activePitchersFromFeed(currentFeed, game.homeTeamId, game.homeProbableId);
  let awayRosterComplete = awayRoster.length >= 6;
  let homeRosterComplete = homeRoster.length >= 6;
  if (!awayRosterComplete || !homeRosterComplete) {
    const [awayRosterResponse, homeRosterResponse] = await Promise.all([
      awayRosterComplete ? Promise.resolve(null) : fetchActiveRoster(game.awayTeamId, asOf, options),
      homeRosterComplete ? Promise.resolve(null) : fetchActiveRoster(game.homeTeamId, asOf, options),
    ]);
    if (!awayRosterComplete && awayRosterResponse?.ok) {
      awayRoster = activePitchersFromRoster(awayRosterResponse.data, game.awayProbableId);
      awayRosterComplete = awayRoster.length >= 6;
    }
    if (!homeRosterComplete && homeRosterResponse?.ok) {
      homeRoster = activePitchersFromRoster(homeRosterResponse.data, game.homeProbableId);
      homeRosterComplete = homeRoster.length >= 6;
    }
  }

  const awayBullpen = buildBullpenV13({ roster: awayRoster, recentFeeds: awayRecentFeeds, teamId: game.awayTeamId, gameDate: game.gameDate, probableStarterId: game.awayProbableId, league: base.league, rosterComplete: awayRosterComplete });
  const homeBullpen = buildBullpenV13({ roster: homeRoster, recentFeeds: homeRecentFeeds, teamId: game.homeTeamId, gameDate: game.gameDate, probableStarterId: game.homeProbableId, league: base.league, rosterComplete: homeRosterComplete });
  const awayExpected = expectedStarterInningsV13(base?.away?.starter, { probableId: game.awayProbableId, scheduledInnings: game.scheduledInnings });
  const homeExpected = expectedStarterInningsV13(base?.home?.starter, { probableId: game.homeProbableId, scheduledInnings: game.scheduledInnings });
  const awayThrows = starterHand(currentFeed, game.awayProbableId);
  const homeThrows = starterHand(currentFeed, game.homeProbableId);
  const awayVsLeft = normalizePlatoon(awayVsLResponse, 'vl');
  const awayVsRight = normalizePlatoon(awayVsRResponse, 'vr');
  const homeVsLeft = normalizePlatoon(homeVsLResponse, 'vl');
  const homeVsRight = normalizePlatoon(homeVsRResponse, 'vr');

  const away = {
    ...base.away,
    lineup: awayLineup,
    vsLeft: awayVsLeft,
    vsRight: awayVsRight,
    bullpen: awayBullpen,
    starter: { ...base.away.starter, id: game.awayProbableId || null, name: game.awayProbable || '', throws: awayThrows, throwsStatus: awayThrows ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.MISSING, ...awayExpected },
  };
  const home = {
    ...base.home,
    lineup: homeLineup,
    vsLeft: homeVsLeft,
    vsRight: homeVsRight,
    bullpen: homeBullpen,
    starter: { ...base.home.starter, id: game.homeProbableId || null, name: game.homeProbable || '', throws: homeThrows, throwsStatus: homeThrows ? FEATURE_STATUS.CONFIRMED : FEATURE_STATUS.MISSING, ...homeExpected },
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
  ];
  const dataGateV10 = buildGateV13(rows);
  const gamePk = Number(game?.gamePk || 0) || null;
  const addedProvenance = [
    feature(gamePk, 'awayLineup', awayLineup, awayLineup.status, awayLineup.source, { asOf, rawPayloadHash: sha256([currentFeedResponse?.rawPayloadHash, ...recentResponses.map(row => row?.rawPayloadHash)]) }),
    feature(gamePk, 'homeLineup', homeLineup, homeLineup.status, homeLineup.source, { asOf, rawPayloadHash: sha256([currentFeedResponse?.rawPayloadHash, ...recentResponses.map(row => row?.rawPayloadHash)]) }),
    feature(gamePk, 'starterExpectedInnings', { away: awayExpected, home: homeExpected }, rows.find(row => row.name === 'starterExpectedInnings').status, 'MLB_PERSON_PIT_SEASON_IP_PER_START', { asOf }),
    feature(gamePk, 'starterHandedness', { away: awayThrows || null, home: homeThrows || null }, rows.find(row => row.name === 'starterHandedness').status, 'MLB_CURRENT_GAME_LIVE_FEED', { asOf, rawPayloadHash: currentFeedResponse?.rawPayloadHash }),
    feature(gamePk, 'platoonSplits', { awayVsLeft, awayVsRight, homeVsLeft, homeVsRight }, rows.find(row => row.name === 'platoonSplits').status, 'MLB_TEAM_CURRENT_SEASON_STAT_SPLITS_AS_FETCHED', { asOf, rawPayloadHash: sha256([awayVsLResponse?.rawPayloadHash, awayVsRResponse?.rawPayloadHash, homeVsLResponse?.rawPayloadHash, homeVsRResponse?.rawPayloadHash]), qualityFlags: ['NOT_A_HISTORICAL_ARCHIVE'] }),
    feature(gamePk, 'reliefOnlyBullpen', { away: awayBullpen, home: homeBullpen }, rows.find(row => row.name === 'reliefOnlyBullpen').status, 'MLB_ACTIVE_ROSTER_PLUS_RECENT_GAME_RELIEF_USAGE', { asOf, rawPayloadHash: sha256(recentResponses.map(row => row?.rawPayloadHash)) }),
  ];
  const warnings = [
    ...(base?.warnings || []).filter(message => !/正式打線未公布|牛棚尚無可靠relief-only/.test(message)),
    awayLineup.official && homeLineup.official
      ? '兩隊正式打線已由當場MLB live feed確認。'
      : '至少一隊正式打線尚未完整公布，使用近六場打序投影並提高模型誤差。',
    awayBullpen.status === FEATURE_STATUS.CONFIRMED && homeBullpen.status === FEATURE_STATUS.CONFIRMED
      ? '兩隊牛棚已排除先發，並納入近期逐後援用量、疲勞及高張力可用性。'
      : '至少一隊純牛棚名單或近期用量不完整，採收縮代理並提高模型誤差。',
    '預計先發局數使用point-in-time球季每場先發局數；無可靠資料時回退中性值，不使用盤口反推。',
    '左右投拆分使用MLB當季statSplits即時快照並固定標記PROJECTED；StatsAPI不提供可驗證的歷史切片，因此不宣稱歷史PIT。',
  ];
  return {
    ...base,
    away,
    home,
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
