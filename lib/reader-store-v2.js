const CACHE_PREFIX = 'mlb-ev:tai888-reader:v2';
const DEFAULT_TTL_SECONDS = 60 * 60 * 12;
const FRESH_SECONDS = 180;
const MAX_SNAPSHOT_BYTES = 1_500_000;
const memory = globalThis.__MLB_EV_READER_STORE_V2__ || new Map();
globalThis.__MLB_EV_READER_STORE_V2__ = memory;

async function runtimeCache() {
  if (process.env.READER_STORE_MEMORY_ONLY === 'true') return null;
  try {
    const module = await import('@vercel/functions');
    return module.getCache();
  } catch {
    return null;
  }
}

function keyFor(date) {
  return date ? `${CACHE_PREFIX}:date:${date}` : `${CACHE_PREFIX}:latest`;
}

async function remoteGet(key) {
  const cache = await runtimeCache();
  if (!cache) return null;
  try { return await cache.get(key); }
  catch { return null; }
}

async function remoteSet(cache, key, value, ttl = DEFAULT_TTL_SECONDS) {
  if (!cache) return false;
  try {
    await cache.set(key, value, {
      ttl,
      tags: ['tai888-reader', `tai888-reader-${value?.boardDate || 'unknown'}`],
      name: 'Tai888 Reader latest board',
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

function storeResult({ bytes, memoryStored, cacheAvailable, cacheRequired, dateStored, latestStored }) {
  const runtimeCacheStored = cacheAvailable && dateStored && latestStored;
  const allRequiredWritesSucceeded = memoryStored
    && (!cacheRequired || runtimeCacheStored);
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
  if (!validBoardDate(snapshot.boardDate)) throw new Error('Reader snapshot boardDate is invalid');
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Reader snapshot exceeds safe storage size');
  const latestKey = keyFor();
  const dateKey = keyFor(snapshot.boardDate);
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

  // Runtime Cache is not transactional. Write the exact-date key first and the
  // latest pointer second, then expose the snapshot to this process only after
  // every required durable write has succeeded.
  const dateStored = cacheAvailable ? await remoteSet(cache, dateKey, snapshot, ttl) : false;
  const latestStored = dateStored ? await remoteSet(cache, latestKey, snapshot, ttl) : false;
  const remoteAll = cacheAvailable && dateStored && latestStored;
  const mayUseMemory = memoryOnly || remoteAll || (!cacheAvailable && !cacheRequired);
  if (!mayUseMemory) {
    return storeResult({
      bytes,
      memoryStored: false,
      cacheAvailable,
      cacheRequired,
      dateStored,
      latestStored,
    });
  }

  memory.set(dateKey, snapshot);
  memory.set(latestKey, snapshot);
  return storeResult({
    bytes,
    memoryStored: true,
    cacheAvailable,
    cacheRequired,
    dateStored,
    latestStored,
  });
}

function temporalError(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

export async function refreshReaderSnapshot(previous, {
  observedAt,
  receivedAt,
  readerVersion,
  pageActivityAt,
  storeOptions,
} = {}) {
  if (!previous) return null;
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
  const next = {
    ...previous,
    observedAt: nextObservedAt,
    receivedAt: nextReceivedAt,
    readerVersion: readerVersion || previous.readerVersion,
    pageActivityAt: nextPageActivityAt,
    games: (previous.games || []).map(game => ({
      ...game,
      source: {
        ...(game.source || {}),
        observedAt: nextObservedAt,
        receivedAt: nextReceivedAt,
        pageActivityAt: nextPageActivityAt,
      },
      markets: (game.markets || []).map(market => ({
        ...market,
        lineAsOf: nextPageActivityAt,
      })),
    })),
  };
  const storage = await storeReaderSnapshot(next, DEFAULT_TTL_SECONDS, storeOptions || {});
  return {
    snapshot: storage.allRequiredWritesSucceeded ? next : null,
    attemptedSnapshot: next,
    storage,
  };
}

export async function loadReaderSnapshot(date = '') {
  if (date) {
    if (!validBoardDate(date)) return null;
    const dateKey = keyFor(date);
    const remoteDate = await remoteGet(dateKey);
    if (remoteDate) return remoteDate;
    const memoryDate = memory.get(dateKey);
    if (memoryDate) return memoryDate;
    return null;
  }
  const remoteLatest = await remoteGet(keyFor());
  if (remoteLatest) return remoteLatest;
  return memory.get(keyFor()) || null;
}

export function readerSnapshotStatus(snapshot, now = Date.now()) {
  if (!snapshot) {
    return {
      available: false,
      fresh: false,
      stale: false,
      executable: false,
      ageSeconds: null,
      state: 'missing',
      message: '尚未收到 Tai888 Reader 盤口',
    };
  }
  const timestamp = Date.parse(snapshot.pageActivityAt || '');
  const rawAgeSeconds = Number.isFinite(timestamp) ? Math.floor((now - timestamp) / 1000) : Number.POSITIVE_INFINITY;
  const ageSeconds = rawAgeSeconds >= 0 ? rawAgeSeconds : Number.POSITIVE_INFINITY;
  const fresh = Number.isFinite(ageSeconds)
    && ageSeconds <= Number(snapshot.freshnessTtlSeconds || FRESH_SECONDS);
  return {
    available: true,
    fresh,
    stale: !fresh,
    executable: fresh,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
    state: fresh ? 'fresh' : Number.isFinite(timestamp) ? 'stale' : 'invalid',
    message: fresh
      ? `Tai888 Reader 已同步 ${snapshot.matchedGameCount || snapshot.games?.length || 0} 場`
      : 'Tai888 Reader 盤口已過期，請確認電腦、Chrome 與 Tai888 頁面仍保持開啟',
  };
}

export function readerSnapshotPublicView(snapshot, { complete = false, now = Date.now() } = {}) {
  const rawStatus = readerSnapshotStatus(snapshot, now);
  const executable = rawStatus.fresh && complete;
  const status = executable ? rawStatus : {
    ...rawStatus,
    fresh: false,
    stale: Boolean(snapshot),
    executable: false,
    state: snapshot ? (complete ? rawStatus.state : 'invalid') : rawStatus.state,
    message: snapshot && !complete
      ? 'Tai888 Reader 快照不完整，已禁止提供可執行盤口'
      : rawStatus.message,
  };
  return {
    ...status,
    boardDate: snapshot?.boardDate || null,
    payloadHash: executable ? snapshot.payloadHash : null,
    rawBoardHash: executable ? snapshot.rawBoardHash : null,
    rawGameCount: executable ? snapshot.rawGameCount : 0,
    matchedGameCount: executable ? snapshot.matchedGameCount : 0,
    scheduleGameCount: executable ? snapshot.scheduleGameCount : 0,
    observedAt: snapshot?.observedAt || null,
    receivedAt: snapshot?.receivedAt || null,
    pageActivityAt: snapshot?.pageActivityAt || null,
    readerVersion: snapshot?.readerVersion || null,
    sourceHost: executable ? snapshot.sourceHost : null,
    unmatched: executable ? snapshot.unmatched : [],
  };
}

export const READER_STORE_VERSION = 'TAI888-RUNTIME-CACHE-v2.0.3';
export const READER_FRESH_SECONDS = FRESH_SECONDS;
