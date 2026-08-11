import { createHash } from 'node:crypto';

export const DATA_VERSION = 'MLB-DATA-SNAPSHOT-2026-08-v1.1.0';
export const REPRICE_VERSION = 'MLB-FROZEN-CONTEXT-REPRICE-2026-08-v1.1.0';

const VOLATILE_KEYS = new Set([
  'fetchedAt',
  'createdAt',
  'updatedAt',
  'time',
  'snapshotId',
  'analysis_as_of',
  'coreFingerprint',
  'priceFingerprint',
  'inputHash',
]);

function normalize(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value)
      .filter(key => !VOLATILE_KEYS.has(key))
      .sort()
      .map(key => [key, normalize(value[key])]));
  }
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toPrecision(15)) : String(value);
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(normalize(value));
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

export function buildSnapshotFingerprints({ context, markets, versions = {} }) {
  const corePayload = {
    game: context?.game,
    league: context?.league,
    away: context?.away,
    home: context?.home,
    weather: context?.weather,
    park: context?.park,
    umpire: context?.umpire,
    featureProvenance: context?.featureProvenance,
    versions: {
      modelVersion: versions.modelVersion,
      dataVersion: versions.dataVersion || DATA_VERSION,
      uncertaintySetVersion: versions.uncertaintySetVersion,
    },
  };
  const canonicalMarkets = (markets || []).map(row => ({
    market: row.market,
    pick: row.pick,
    water: row.water,
    waterEstimated: Boolean(row.waterEstimated),
    waterMissing: Boolean(row.waterMissing),
    sourceType: row.sourceType || null,
    lineAsOf: row.lineAsOf || null,
    executable: row.executable !== false,
    marketVerification: row.marketVerification || null,
  })).sort((left, right) => `${left.market}|${left.pick}`.localeCompare(`${right.market}|${right.pick}`));
  const pricePayload = {
    markets: canonicalMarkets,
    versions: {
      settlementRuleVersion: versions.settlementRuleVersion,
      scoreFormulaVersion: versions.scoreFormulaVersion,
    },
  };
  const coreFingerprint = sha256(corePayload);
  const priceFingerprint = sha256(pricePayload);

  // Never hash an object whose property names are intentionally removed by
  // normalize(). The previous implementation hashed only `versions` here,
  // causing every game in the same release to share one inputHash and cache.
  const inputHash = sha256([
    'MLB-INPUT-HASH-v2',
    coreFingerprint,
    priceFingerprint,
    sha256(versions),
  ].join('|'));

  return {
    coreFingerprint,
    priceFingerprint,
    inputHash,
    corePayload,
    pricePayload,
  };
}
