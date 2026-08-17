import { isLeagueId } from './leagues.js';

const CACHE_PREFIX = 'baseball-ev:tai888-reader:v2';
const LEGACY_MLB_PREFIX = 'mlb-ev:tai888-reader:v2';
const DEFAULT_TTL_SECONDS = 60 * 60 * 12;
const FRESH_SECONDS = 180;
const MAX_SNAPSHOT_BYTES = 1_500_000;
const memory = globalThis.__BASEBALL_EV_READER_STORE_V2__
  || globalThis.__MLB_EV_READER_STORE_V2__
  || new Map();
globalThis.__BASEBALL_EV_READER_STORE_V2__ = memory;

function normalizedLeague(value) {
  const league = String(value || '').trim().toUpperCase();
  return isLeagueId(league) ? league : '';
}

async function runtimeCache() {
  if (process.env.READER_STORE_MEMORY_ONLY === 'true') return null;
  try {
    const module = await import('@vercel/functions');
    return module.getCache();
  } catch {
    return null;
  }
}

function keyFor(league, date = '') {
  return `${CACHE_PREFIX}:${league}:${date ? `date:${date}` : 'latest'}`;
}

function legacyMlbKeyFor(date = '') {
  return date ? `${LEGACY_MLB_PREFIX}:date:${date}` : `${LEGACY_MLB_PREFIX}:latest`;
}

async function remoteGet(cache, key) {
  if (!cache) return null;
  try { return await cache.get(key); }
  catch { return null; }
}

async function remoteSet(cache, key, value, ttl = DEFAULT_TTL_SECONDS) {
  if (!cache) return false;
  try {
    await cache.set(key, value, {
      ttl,
      tags: [
        'tai888-reader',
        `tai888-reader-${value?.league || 'unknown'}`,
        `tai888-reader-${value?.league || 'unknown'}-${value?.boardDate || 'unknown'}`,
      ],
      name: `Tai888 Reader ${value?.league || 'unknown'} board`,
    });
    return true;
  } catch {
    return false;
  }
}

function validBoardDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === text;
}

function optionalLeagueMatches(value, league) {
  if (value == null || String(value).trim() === '') return true;
  return normalizedLeague(value) === league;
}

function bindSnapshotLeague(snapshot, league, { allowMissingLeague = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const existing = normalizedLeague(snapshot.league);
  if ((!existing && !allowMissingLeague) || (existing && existing !== league)) return null;
  const rows = [
    ...(Array.isArray(snapshot.games) ? snapshot.games : []),
    ...(Array.isArray(snapshot.unopenedGames) ? snapshot.unopenedGames : []),
  ];
  if (rows.some(row => (
    !optionalLeagueMatches(row?.league, league)
    || !optionalLeagueMatches(row?.game?.league || row?.game?.leagueId, league)
    || !optionalLeagueMatches(row?.source?.league, league)
  ))) return null;
  const bindRow = row => ({
    ...row,
    league,
    game: row?.game ? { ...row.game, league } : row?.game,
    source: row?.source ? { ...row.source, league } : row?.source,
  });
  return {
    ...snapshot,
    league,
    games: Array.isArray(snapshot.games) ? snapshot.games.map(bindRow) : [],
    unopenedGames: Array.isArray(snapshot.unopenedGames) ? snapshot.unopenedGames.map(bindRow) : [],
  };
}

function storeResult({ bytes, memoryStored, cacheAvailable, cacheRequired, dateStored, latestStored }) {
  const runtimeCacheStored = cacheAvailable && dateStored && latestStored;
  const allRequiredWritesSucceeded = memoryStored && (!cacheRequired || runtimeCacheStored);
  return {
    bytes,
    memory: memoryStored,
    runtimeCache: runtimeCacheStored,
    allRequiredWritesSucceeded,
    writes: {
      memory: memoryStored,
      runtimeCache: {
        available: cacheAvailable,
        required: cacheRequired,
        date: dateStored,
        latest: latestStored,
        all: runtimeCacheStored,
      },
    },
  };
}

export async function storeReaderSnapshot(snapshot, ttl = DEFAULT_TTL_SECONDS, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Reader snapshot is invalid');
  const league = normalizedLeague(snapshot.league);
  if (!league) throw new Error('Reader snapshot league is invalid');
  if (!validBoardDate(snapshot.boardDate)) throw new Error('Reader snapshot boardDate is invalid');
  const normalized = bindSnapshotLeague(snapshot, league);
  if (!normalized) throw new Error('Reader snapshot nested league is invalid');
  const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Reader snapshot exceeds safe storage size');
  const latestKey = keyFor(league);
  const dateKey = keyFor(league, normalized.boardDate);
  const memoryOnly = process.env.READER_STORE_MEMORY_ONLY === 'true';
  const cacheRequired = options.requireRuntimeCache == null
    ? process.env.VERCEL === '1' && !memoryOnly
    : Boolean(options.requireRuntimeCache) && !memoryOnly;
  const cache = memoryOnly
    ? null
    : options.runtimeCache === undefined
      ? await runtimeCache()
      : options.runtimeCache;
  const cacheAvailable = Boolean(cache);

  const dateStored = cacheAvailable ? await remoteSet(cache, dateKey, normalized, ttl) : false;
  const latestStored = dateStored ? await remoteSet(cache, latestKey, normalized, ttl) : false;
  const remoteAll = cacheAvailable && dateStored && latestStored;
  const mayUseMemory = memoryOnly || remoteAll || (!cacheAvailable && !cacheRequired);
  if (!mayUseMemory) {
    return storeResult({ bytes, memoryStored: false, cacheAvailable, cacheRequired, dateStored, latestStored });
  }

  memory.set(dateKey, normalized);
  memory.set(latestKey, normalized);
  return storeResult({ bytes, memoryStored: true, cacheAvailable, cacheRequired, dateStored, latestStored });
}

function temporalError(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

export async function refreshReaderSnapshot(previous, {
  league: requestedLeague,
  observedAt,
  receivedAt,
  readerVersion,
  pageActivityAt,
  storeOptions,
} = {}) {
  if (!previous) return null;
  const league = normalizedLeague(requestedLeague || previous.league);
  if (!league || normalizedLeague(previous.league) !== league) {
    throw temporalError('Reader 心跳聯盟識別不一致');
  }
  const nextObservedAt = String(observedAt || '');
  const nextReceivedAt = String(receivedAt || new Date().toISOString());
  const nextPageActivityAt = String(pageActivityAt || '');
  const observedTime = Date.parse(nextObservedAt);
  const receivedTime = Date.parse(nextReceivedAt);
  const activityTime = Date.parse(nextPageActivityAt);
  const previousObservedTime = Date.parse(previous.observedAt || '');
  const previousActivityTime = Date.parse(previous.pageActivityAt || '');
  if (![observedTime, receivedTime, activityTime, previousObservedTime, previousActivityTime].every(Number.isFinite)) {
    throw temporalError('Reader 心跳時間資料不完整，已拒絕刷新');
  }
  if (observedTime <= previousObservedTime || activityTime < previousActivityTime) {
    throw temporalError('Reader 心跳時間未向前推進或頁面活動時間倒退，已拒絕舊盤重播');
  }
  if (observedTime > receivedTime + 90_000 || receivedTime - observedTime > 10 * 60_000) {
    throw temporalError('Reader observedAt 與伺服器時間差距過大');
  }
  if (activityTime > observedTime + 5_000
    || activityTime > receivedTime + 5_000
    || receivedTime - activityTime > FRESH_SECONDS * 1000) {
    throw temporalError('Tai888 頁面活動時間已過期，拒絕以心跳刷新舊盤');
  }
  const next = bindSnapshotLeague({
    ...previous,
    league,
    observedAt: nextObservedAt,
    receivedAt: nextReceivedAt,
    readerVersion: readerVersion || previous.readerVersion,
    pageActivityAt: nextPageActivityAt,
    games: (previous.games || []).map(game => ({
      ...game,
      source: {
        ...(game.source || {}),
        league,
        observedAt: nextObservedAt,
        receivedAt: nextReceivedAt,
        pageActivityAt: nextPageActivityAt,
      },
      markets: (game.markets || []).map(market => ({ ...market, lineAsOf: nextPageActivityAt })),
    })),
    unopenedGames: (previous.unopenedGames || []).map(game => ({
      ...game,
      source: {
        ...(game.source || {}),
        league,
        observedAt: nextObservedAt,
        receivedAt: nextReceivedAt,
        pageActivityAt: nextPageActivityAt,
      },
    })),
  }, league);
  const storage = await storeReaderSnapshot(next, DEFAULT_TTL_SECONDS, storeOptions || {});
  return { snapshot: storage.allRequiredWritesSucceeded ? next : null, attemptedSnapshot: next, storage };
}

async function readKey(cache, storageKey) {
  const remote = await remoteGet(cache, storageKey);
  return remote || memory.get(storageKey) || null;
}

async function readLegacyMlb(cache, date) {
  const legacy = await readKey(cache, legacyMlbKeyFor(date));
  const migrated = bindSnapshotLeague(legacy, 'MLB', { allowMissingLeague: true });
  if (!migrated || !validBoardDate(migrated.boardDate)) return null;
  if (date && migrated.boardDate !== date) return null;
  const newKey = keyFor('MLB', date || '');
  memory.set(newKey, migrated);
  if (cache) await remoteSet(cache, newKey, migrated);
  return migrated;
}

export async function loadReaderSnapshot(league, date = '', options = {}) {
  const normalized = normalizedLeague(league);
  if (!normalized || (date && !validBoardDate(date))) return null;
  const cache = process.env.READER_STORE_MEMORY_ONLY === 'true'
    ? null
    : options.runtimeCache === undefined ? await runtimeCache() : options.runtimeCache;
  const storageKey = keyFor(normalized, date);
  const value = bindSnapshotLeague(await readKey(cache, storageKey), normalized);
  if (value) return value;
  return normalized === 'MLB' ? readLegacyMlb(cache, date) : null;
}

function missingStatus(league, message = '尚未收到 Tai888 Reader 盤口') {
  return {
    league,
    available: false,
    fresh: false,
    stale: false,
    executable: false,
    ageSeconds: null,
    state: 'missing',
    message,
  };
}

export function readerSnapshotStatus(snapshot, now = Date.now(), expectedLeague = snapshot?.league) {
  const league = normalizedLeague(expectedLeague);
  if (!league) return missingStatus('', 'Reader 聯盟識別無效');
  if (!snapshot) return missingStatus(league);
  if (normalizedLeague(snapshot.league) !== league) {
    return missingStatus(league, `${league} 尚未收到獨立 Reader 盤口`);
  }
  const timestamp = Date.parse(snapshot.pageActivityAt || '');
  const rawAgeSeconds = Number.isFinite(timestamp) ? Math.floor((now - timestamp) / 1000) : Number.POSITIVE_INFINITY;
  const ageSeconds = rawAgeSeconds >= 0 ? rawAgeSeconds : Number.POSITIVE_INFINITY;
  const fresh = Number.isFinite(ageSeconds) && ageSeconds <= Number(snapshot.freshnessTtlSeconds || FRESH_SECONDS);
  return {
    league,
    available: true,
    fresh,
    stale: !fresh,
    executable: fresh,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
    state: fresh ? 'fresh' : Number.isFinite(timestamp) ? 'stale' : 'invalid',
    message: fresh
      ? `${league} Tai888 Reader 已同步 ${snapshot.matchedGameCount || snapshot.games?.length || 0} 場`
      : `${league} Tai888 Reader 盤口已過期，請確認電腦、Chrome 與 Tai888 頁面仍保持開啟`,
  };
}

export function readerSnapshotPublicView(snapshot, {
  complete = false,
  now = Date.now(),
  league: expectedLeague = snapshot?.league,
} = {}) {
  const league = normalizedLeague(expectedLeague);
  const rawStatus = readerSnapshotStatus(snapshot, now, league);
  const executable = rawStatus.fresh && complete;
  const status = executable ? rawStatus : {
    ...rawStatus,
    fresh: false,
    stale: Boolean(snapshot) && rawStatus.available,
    executable: false,
    state: snapshot && rawStatus.available ? (complete ? rawStatus.state : 'invalid') : rawStatus.state,
    message: snapshot && rawStatus.available && !complete
      ? `${league} Tai888 Reader 快照不完整，已禁止提供可執行盤口`
      : rawStatus.message,
  };
  const sameLeague = snapshot && normalizedLeague(snapshot.league) === league;
  return {
    ...status,
    boardDate: sameLeague ? snapshot?.boardDate || null : null,
    payloadHash: executable ? snapshot.payloadHash : null,
    rawBoardHash: executable ? snapshot.rawBoardHash : null,
    rawGameCount: executable ? snapshot.rawGameCount : 0,
    matchedGameCount: executable ? snapshot.matchedGameCount : 0,
    scheduleGameCount: executable ? snapshot.scheduleGameCount : 0,
    observedAt: sameLeague ? snapshot?.observedAt || null : null,
    receivedAt: sameLeague ? snapshot?.receivedAt || null : null,
    pageActivityAt: sameLeague ? snapshot?.pageActivityAt || null : null,
    readerVersion: sameLeague ? snapshot?.readerVersion || null : null,
    sourceHost: executable ? snapshot.sourceHost : null,
    unmatched: executable ? snapshot.unmatched : [],
  };
}

export const READER_STORE_VERSION = 'TAI888-RUNTIME-CACHE-LEAGUE-v2.0.0';
export const READER_FRESH_SECONDS = FRESH_SECONDS;
export const READER_STORE_PREFIX = CACHE_PREFIX;
