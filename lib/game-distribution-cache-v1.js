export const GAME_DISTRIBUTION_CACHE_VERSION = 'BASEBALL-GAME-DISTRIBUTION-CACHE-v1.0.0';
export const GAME_DISTRIBUTION_CACHE_TTL_MS = 5 * 60 * 1000;

const maximumEntries = 64;
const cache = globalThis.__BASEBALL_GAME_DISTRIBUTION_CACHE_V1__ || new Map();
globalThis.__BASEBALL_GAME_DISTRIBUTION_CACHE_V1__ = cache;

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`比分分布快取缺少${label}`);
  return normalized;
}

export function gameDistributionCacheKey({ league, gamePk, coreFingerprint, modelVersion, rulesVersion }) {
  const normalizedLeague = required(league, '聯盟').toUpperCase();
  const normalizedGamePk = Number(gamePk);
  if (!Number.isInteger(normalizedGamePk) || normalizedGamePk <= 0) throw new Error('比分分布快取缺少有效gamePk');
  return [
    GAME_DISTRIBUTION_CACHE_VERSION,
    normalizedLeague,
    normalizedGamePk,
    required(coreFingerprint, '核心資料指紋'),
    required(modelVersion, '模型版本'),
    required(rulesVersion, '規則版本'),
  ].join(':');
}

function prune(now) {
  for (const [key, row] of cache) {
    if (!row || row.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > maximumEntries) cache.delete(cache.keys().next().value);
}

export function getOrBuildGameDistribution({
  league,
  gamePk,
  coreFingerprint,
  modelVersion,
  rulesVersion,
  build,
  now = Date.now(),
  ttlMs = GAME_DISTRIBUTION_CACHE_TTL_MS,
}) {
  if (typeof build !== 'function') throw new Error('比分分布快取缺少建立函式');
  const key = gameDistributionCacheKey({ league, gamePk, coreFingerprint, modelVersion, rulesVersion });
  const timestamp = Number(now);
  prune(timestamp);
  const hit = cache.get(key);
  if (hit?.snapshot) return { snapshot: hit.snapshot, cacheStatus: 'HIT', key };

  const snapshot = build();
  if (!snapshot?.distributionId || !snapshot?.distributionHash) throw new Error('比分分布建立結果缺少識別或雜湊');
  if (Number(snapshot.gamePk) !== Number(gamePk)) throw new Error('比分分布快取gamePk不一致');
  if (String(snapshot.modelVersion) !== String(modelVersion) || String(snapshot.rulesVersion) !== String(rulesVersion)) {
    throw new Error('比分分布快取模型或規則版本不一致');
  }
  cache.set(key, {
    snapshot,
    createdAt: timestamp,
    expiresAt: timestamp + Math.max(1, Number(ttlMs) || GAME_DISTRIBUTION_CACHE_TTL_MS),
  });
  prune(timestamp);
  return { snapshot, cacheStatus: 'MISS', key };
}

export function clearGameDistributionCacheForTest() {
  cache.clear();
}
