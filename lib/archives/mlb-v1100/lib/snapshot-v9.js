import { createHash } from 'node:crypto';
import { isLeagueId } from './leagues.js';

export const DATA_VERSION = 'BASEBALL-POINT-IN-TIME-DATA-SNAPSHOT-2026-08-v11.0.0';
export const REPRICE_VERSION = 'BASEBALL-FROZEN-CONTEXT-W-FIRST-REPRICE-2026-08-v11.1.0';
export const SNAPSHOT_FINGERPRINT_VERSION = 'BASEBALL-SNAPSHOT-FINGERPRINT-v5.0.0';

const VOLATILE_KEYS = new Set([
  'fetchedAt',
  // Records when an otherwise identical frozen feature bundle was assembled.
  // Exact PIT keeps it, but semantic retry identity must not change with the clock.
  'featureSnapshotAsOf',
  'createdAt',
  'updatedAt',
  // Derived from lineAsOf and the current request clock. It changes every
  // second without changing the signed market or its executable state.
  'lineAgeSeconds',
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
    provider: row.provider || null,
    providerEventId: row.providerEventId || null,
    readerGameMarketHash: row.readerGameMarketHash || null,
    readerVersion: row.readerVersion || null,
    readerPayloadHash: row.readerPayloadHash || null,
    readerRawBoardHash: row.readerRawBoardHash || null,
    readerBoardDate: row.readerBoardDate || null,
    integrityOrigin: row.integrityOrigin || null,
    authorizationStatus: row.authorizationStatus || null,
    marketSignatureVersion: row.marketSignatureVersion || null,
    marketSignature: row.marketSignature || null,
    lineAsOf: row.lineAsOf || null,
    executable: row.executable !== false,
    integrityError: row.integrityError || null,
    marketVerification: row.marketVerification || null,
  })).sort((left, right) => `${left.market}|${left.pick}`.localeCompare(`${right.market}|${right.pick}`));
}

function pointInTimeSourceAsOf(context) {
  const times = (Array.isArray(context?.featureProvenance) ? context.featureProvenance : [])
    .flatMap(row => [row?.providerObservedAt, row?.observedAt, row?.fetchedAt])
    .map(value => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

export function buildSnapshotFingerprints({
  league: leagueValue,
  context,
  markets,
  versions = {},
  calculationSettings = {},
  auxiliaryInput = {},
}) {
  const league = String(leagueValue || '').trim().toUpperCase();
  if (!isLeagueId(league)) throw new Error('快照指紋缺少有效 league');
  const hasExplicitModelContract = context?.analysisMode !== undefined
    || context?.modelConfig !== undefined
    || context?.modelVersion !== undefined
    || context?.rulesVersion !== undefined;
  const corePayload = {
    domain: 'baseball-positive-ev/snapshot-core/v3',
    league,
    game: context?.game,
    leagueData: context?.league,
    away: context?.away,
    home: context?.home,
    weather: context?.weather,
    park: context?.park,
    umpire: context?.umpire,
    featureProvenance: context?.featureProvenance,
    pointInTimeSourceAsOf: pointInTimeSourceAsOf(context),
    starterModelingMode: context?.starterModelingMode,
    modelContract: hasExplicitModelContract ? {
      analysisMode: context?.analysisMode,
      modelConfig: context?.modelConfig,
      modelVersion: context?.modelVersion,
      rulesVersion: context?.rulesVersion,
    } : undefined,
    versions: {
      modelVersion: versions.modelVersion,
      dataVersion: versions.dataVersion || DATA_VERSION,
      uncertaintySetVersion: versions.uncertaintySetVersion,
    },
  };
  const pricePayload = {
    domain: 'baseball-positive-ev/snapshot-price/v4',
    league,
    markets: canonicalMarketRows(markets),
    versions: {
      settlementRuleVersion: versions.settlementRuleVersion,
      scoreFormulaVersion: versions.scoreFormulaVersion,
    },
  };
  const calculationPayload = {
    domain: 'baseball-positive-ev/snapshot-calculation/v2',
    league,
    rebateRate: calculationSettings.rebateRate ?? null,
    simulationsPerScenario: calculationSettings.simulationsPerScenario ?? null,
    candidateThreshold: calculationSettings.candidateThreshold ?? null,
    strongestThreshold: calculationSettings.strongestThreshold ?? null,
    expertMode: calculationSettings.expertMode || 'off',
  };
  const auxiliaryPayload = {
    domain: 'baseball-positive-ev/snapshot-auxiliary/v3',
    league,
    previousMarkets: canonicalMarketRows(auxiliaryInput.previousMarkets || []),
    contractRule: auxiliaryInput.contractRule || null,
  };
  const coreFingerprint = sha256(corePayload);
  const priceFingerprint = sha256(pricePayload);
  const calculationFingerprint = sha256(calculationPayload);
  const auxiliaryFingerprint = sha256(auxiliaryPayload);

  const inputHash = sha256([
    'BASEBALL-INPUT-HASH-LEAGUE-v4',
    league,
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
