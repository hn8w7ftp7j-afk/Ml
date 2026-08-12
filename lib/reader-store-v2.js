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

async function remoteSet(key, value, ttl = DEFAULT_TTL_SECONDS) {
  const cache = await runtimeCache();
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

export async function storeReaderSnapshot(snapshot, ttl = DEFAULT_TTL_SECONDS) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Reader snapshot is invalid');
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Reader snapshot exceeds safe storage size');
  const latestKey = keyFor();
  const dateKey = keyFor(snapshot.boardDate);
  memory.set(latestKey, snapshot);
  if (snapshot.boardDate) memory.set(dateKey, snapshot);
  const stored = await Promise.all([
    remoteSet(latestKey, snapshot, ttl),
    snapshot.boardDate ? remoteSet(dateKey, snapshot, ttl) : Promise.resolve(false),
  ]);
  return { runtimeCache: stored.some(Boolean), memory: true, bytes };
}

export async function refreshReaderSnapshot(previous, { observedAt, receivedAt, readerVersion } = {}) {
  if (!previous) return null;
  const nextObservedAt = observedAt || previous.observedAt;
  const nextReceivedAt = receivedAt || new Date().toISOString();
  const next = {
    ...previous,
    observedAt: nextObservedAt,
    receivedAt: nextReceivedAt,
    readerVersion: readerVersion || previous.readerVersion,
    games: (previous.games || []).map(game => ({
      ...game,
      source: {
        ...(game.source || {}),
        observedAt: nextObservedAt,
        receivedAt: nextReceivedAt,
      },
      markets: (game.markets || []).map(market => ({
        ...market,
        lineAsOf: nextObservedAt,
      })),
    })),
  };
  const storage = await storeReaderSnapshot(next);
  return { snapshot: next, storage };
}

export async function loadReaderSnapshot(date = '') {
  const dateKey = date ? keyFor(date) : '';
  if (dateKey) {
    const remoteDate = await remoteGet(dateKey);
    if (remoteDate) return remoteDate;
    const memoryDate = memory.get(dateKey);
    if (memoryDate) return memoryDate;
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
      ageSeconds: null,
      state: 'missing',
      message: '尚未收到 Tai888 Reader 盤口',
    };
  }
  const timestamp = Date.parse(snapshot.receivedAt || snapshot.observedAt || '');
  const ageSeconds = Number.isFinite(timestamp) ? Math.max(0, Math.floor((now - timestamp) / 1000)) : Number.POSITIVE_INFINITY;
  const fresh = ageSeconds <= Number(snapshot.freshnessTtlSeconds || FRESH_SECONDS);
  return {
    available: true,
    fresh,
    stale: !fresh,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
    state: fresh ? 'fresh' : 'stale',
    message: fresh
      ? `Tai888 Reader 已同步 ${snapshot.matchedGameCount || snapshot.games?.length || 0} 場`
      : 'Tai888 Reader 盤口已過期，請確認電腦、Chrome 與 Tai888 頁面仍保持開啟',
  };
}

export const READER_STORE_VERSION = 'TAI888-RUNTIME-CACHE-v2.0.2';
export const READER_FRESH_SECONDS = FRESH_SECONDS;
