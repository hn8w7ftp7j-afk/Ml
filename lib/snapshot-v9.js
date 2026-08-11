import { createHash } from 'node:crypto';

export const DATA_VERSION = 'MLB-DATA-SNAPSHOT-2026-08-v1.2.0';
export const REPRICE_VERSION = 'MLB-FROZEN-CONTEXT-REPRICE-2026-08-v1.2.0';

const VOLATILE_KEYS = new Set([
  'fetchedAt',
  'createdAt',
  'updatedAt',
  'time',
  'snapshotId',
  'analysis_as_of',
  'analysisAsOf',
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

function canonicalMarketRows(markets) {
  return (markets || []).map(row => ({
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
}

export function buildSnapshotFingerprints({
  context,
  markets,
  versions = {},
  calculationSettings = {},
  auxiliaryInput = {},
}) {
  const corePayload = {
    game: context?.game,
    league: context?.league,
    away: context?.away,
    home: context?.home,
    weather: context?.weather,
    park: context?.park,
    umpire: context?.umpire,
    featureProvenance: context?.featureProvenance,
    starterModelingMode: context?.starterModelingMode,
    versions: {
      modelVersion: versions.modelVersion,
      dataVersion: versions.dataVersion || DATA_VERSION,
      uncertaintySetVersion: versions.uncertaintySetVersion,
    },
  };
  const pricePayload = {
    markets: canonicalMarketRows(markets),
    versions: {
      settlementRuleVersion: versions.settlementRuleVersion,
      scoreFormulaVersion: versions.scoreFormulaVersion,
    },
  };
  const calculationPayload = {
    rebateRate: calculationSettings.rebateRate ?? null,
    simulationsPerScenario: calculationSettings.simulationsPerScenario ?? null,
    candidateThreshold: calculationSettings.candidateThreshold ?? null,
    strongestThreshold: calculationSettings.strongestThreshold ?? null,
    expertMode: calculationSettings.expertMode || 'off',
  };
  const auxiliaryPayload = {
    previousMarkets: canonicalMarketRows(auxiliaryInput.previousMarkets || []),
    contractRule: auxiliaryInput.contractRule || null,
  };
  const coreFingerprint = sha256(corePayload);
  const priceFingerprint = sha256(pricePayload);
  const calculationFingerprint = sha256(calculationPayload);
  const auxiliaryFingerprint = sha256(auxiliaryPayload);

  const inputHash = sha256([
    'MLB-INPUT-HASH-v3',
    coreFingerprint,
    priceFingerprint,
    calculationFingerprint,
    auxiliaryFingerprint,
    sha256(versions),
  ].join('|'));

  return {
    coreFingerprint,
    priceFingerprint,
    calculationFingerprint,
    auxiliaryFingerprint,
    inputHash,
    corePayload,
    pricePayload,
    calculationPayload,
    auxiliaryPayload,
  };
}
