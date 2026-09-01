import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip as gzipCallback, gzipSync, gunzipSync } from 'node:zlib';
import { waitUntil } from '@vercel/functions';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';
import { isDatabaseError, markDatabaseError } from './database-error.js';
import { isLeagueId } from './leagues.js';
import {
  loadAnalysisDirectionHistory,
  persistAnalysisDirectionHistoryBestEffort,
} from './analysis-direction-history-v1.js';
import { MODEL_EV_FORMULA_VERSION, ROBUST_EV_VERSION } from './analysis-v11.js';
import { DIRECTION_SLOT_CONTRACT_VERSION } from './direction-slots-v1.js';
import { sha256 as stableSha256 } from './snapshot-v9.js';

export const ANALYSIS_PIT_SNAPSHOT_SCHEMA_VERSION = 'BASEBALL-ANALYSIS-PIT-SNAPSHOT-v1.0.0';
const LEGACY_ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION = 'BASEBALL-PIT-JSON-PAYLOAD-v1.0.0';
export const ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION = 'BASEBALL-PIT-JSON-PAYLOAD-v1.2.0';
export const ANALYSIS_PIT_ANALYSIS_TYPES = Object.freeze(['FULL', 'PRICE_ONLY_REPRICE']);

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DISTRIBUTION_RAW_LIMIT_BYTES = 16_000_000;
const DISTRIBUTION_INLINE_LIMIT_BYTES = 256_000;
const DISTRIBUTION_COMPRESSED_LIMIT_BYTES = 2_000_000;
const FROZEN_CONTEXT_RAW_LIMIT_BYTES = 4_000_000;
const FROZEN_CONTEXT_COMPRESSED_LIMIT_BYTES = 1_000_000;
const MARKET_ANALYSIS_RAW_LIMIT_BYTES = 2_000_000;
const MARKET_ANALYSIS_COMPRESSED_LIMIT_BYTES = 750_000;
// Base64 expands exact JSON by roughly one third. Real frozen contexts and
// market-analysis payloads are highly repetitive, so storing medium payloads
// inline was needlessly consuming the database even though the existing gzip
// envelope is byte-exact and fully replayable. Keep tiny payloads inline to
// avoid compression overhead; gzip everything larger when it actually saves
// space.
const ADAPTIVE_GZIP_MIN_RAW_BYTES = 8_192;
const gzipAsync = promisify(gzipCallback);

let sqlClient;
let schemaReady;
const inflightWrites = globalThis.__BASEBALL_ANALYSIS_PIT_INFLIGHT_WRITES__ || new Map();
globalThis.__BASEBALL_ANALYSIS_PIT_INFLIGHT_WRITES__ = inflightWrites;

function exactSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function cleanText(value, maximum = 500) {
  return String(value ?? '').trim().slice(0, maximum);
}

function requiredText(value, label, maximum = 500) {
  const text = cleanText(value, maximum);
  if (!text) throw new Error(`PIT快照缺少${label}`);
  return text;
}

function requiredHash(value, label) {
  const hash = cleanText(value, 64).toLowerCase();
  if (!HASH_PATTERN.test(hash)) throw new Error(`PIT快照${label}不是有效SHA-256`);
  return hash;
}

function isoInstant(value, label) {
  const milliseconds = Date.parse(value || '');
  if (!Number.isFinite(milliseconds)) throw new Error(`PIT快照${label}時間無效`);
  return new Date(milliseconds).toISOString();
}

function jsonText(value, label) {
  let text;
  try { text = JSON.stringify(value); }
  catch (error) { throw new Error(`PIT快照${label}無法序列化：${String(error?.message || error)}`); }
  if (text === undefined) throw new Error(`PIT快照${label}無法序列化`);
  return text;
}

function analysisPitIntegrityError(error, code = 'PIT_REPLAY_INTEGRITY_FAILED') {
  if (isAnalysisPitIntegrityError(error)) return error;
  const source = error instanceof Error ? error : new Error(String(error || 'PIT replay integrity failed'));
  const wrapped = new Error(String(source.message || source), { cause: source });
  wrapped.name = 'AnalysisPitIntegrityError';
  wrapped.code = code;
  wrapped.status = 409;
  return wrapped;
}

export function isAnalysisPitIntegrityError(error) {
  const seen = new Set();
  let current = error;
  while (current != null && !seen.has(current)) {
    if (current?.code === 'PIT_PAYLOAD_INTEGRITY_FAILED' || current?.code === 'PIT_REPLAY_INTEGRITY_FAILED') return true;
    if ((typeof current !== 'object' && typeof current !== 'function') || current.cause == null) return false;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

function exactJsonBase64Envelope(raw, rawBytes, payloadHash) {
  const data = raw.toString('base64');
  return {
    version: ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
    encoding: 'JSON_BASE64',
    rawBytes,
    compressedBytes: null,
    base64Bytes: Buffer.byteLength(data, 'ascii'),
    payloadHash,
    data,
  };
}

export function encodeAnalysisPitPayload(value, {
  label = '內容',
  inlineLimitBytes,
  rawLimitBytes,
  compressedLimitBytes,
  allowOmit = false,
} = {}) {
  const text = jsonText(value, label);
  const raw = Buffer.from(text, 'utf8');
  const rawBytes = raw.byteLength;
  const payloadHash = exactSha256(raw);
  if (rawBytes <= Number(inlineLimitBytes) && rawBytes < ADAPTIVE_GZIP_MIN_RAW_BYTES) {
    // PostgreSQL JSONB reorders object keys. Store the exact UTF-8 bytes instead
    // of a nested JSON value so an immutable PIT hash survives a DB round-trip.
    return exactJsonBase64Envelope(raw, rawBytes, payloadHash);
  }
  if (rawBytes > Number(rawLimitBytes)) {
    if (allowOmit) return {
      version: ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
      encoding: 'OMITTED_HASH_ONLY',
      rawBytes,
      compressedBytes: null,
      payloadHash,
      reason: 'RAW_SIZE_LIMIT',
    };
    throw new Error(`PIT快照${label}超過安全原始大小上限`);
  }
  const compressed = gzipSync(raw, { level: 9 });
  const compressedBase64Bytes = Math.ceil(compressed.byteLength / 3) * 4;
  const rawBase64Bytes = Math.ceil(rawBytes / 3) * 4;
  if (compressed.byteLength <= Number(compressedLimitBytes)
    && (rawBytes > Number(inlineLimitBytes) || compressedBase64Bytes < rawBase64Bytes)) {
    return {
      version: ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
      encoding: 'GZIP_BASE64',
      rawBytes,
      compressedBytes: compressed.byteLength,
      base64Bytes: compressedBase64Bytes,
      payloadHash,
      data: compressed.toString('base64'),
    };
  }
  if (rawBytes <= Number(inlineLimitBytes)) return exactJsonBase64Envelope(raw, rawBytes, payloadHash);
  if (allowOmit) return {
    version: ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
    encoding: 'OMITTED_HASH_ONLY',
    rawBytes,
    compressedBytes: compressed.byteLength,
    payloadHash,
    reason: 'COMPRESSED_SIZE_LIMIT',
  };
  throw new Error(`PIT快照${label}壓縮後仍超過安全大小上限`);
}

export async function encodeAnalysisPitPayloadAsync(value, options = {}) {
  const {
    label = '內容',
    inlineLimitBytes,
    rawLimitBytes,
    compressedLimitBytes,
    allowOmit = false,
  } = options;
  const text = jsonText(value, label);
  const raw = Buffer.from(text, 'utf8');
  const rawBytes = raw.byteLength;
  const payloadHash = exactSha256(raw);
  if (rawBytes <= Number(inlineLimitBytes) && rawBytes < ADAPTIVE_GZIP_MIN_RAW_BYTES) {
    return exactJsonBase64Envelope(raw, rawBytes, payloadHash);
  }
  if (rawBytes > Number(rawLimitBytes)) {
    if (allowOmit) return {
      version: ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
      encoding: 'OMITTED_HASH_ONLY',
      rawBytes,
      compressedBytes: null,
      base64Bytes: null,
      payloadHash,
      reason: 'RAW_SIZE_LIMIT',
    };
    throw new Error(`PIT快照${label}超過安全原始大小上限`);
  }
  const compressed = await gzipAsync(raw, { level: 9 });
  const compressedBase64Bytes = Math.ceil(compressed.byteLength / 3) * 4;
  const rawBase64Bytes = Math.ceil(rawBytes / 3) * 4;
  if (compressed.byteLength <= Number(compressedLimitBytes)
    && (rawBytes > Number(inlineLimitBytes) || compressedBase64Bytes < rawBase64Bytes)) {
    const data = compressed.toString('base64');
    return {
      version: ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
      encoding: 'GZIP_BASE64',
      rawBytes,
      compressedBytes: compressed.byteLength,
      base64Bytes: Buffer.byteLength(data, 'ascii'),
      payloadHash,
      data,
    };
  }
  if (rawBytes <= Number(inlineLimitBytes)) return exactJsonBase64Envelope(raw, rawBytes, payloadHash);
  if (allowOmit) return {
    version: ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
    encoding: 'OMITTED_HASH_ONLY',
    rawBytes,
    compressedBytes: compressed.byteLength,
    base64Bytes: null,
    payloadHash,
    reason: 'COMPRESSED_SIZE_LIMIT',
  };
  throw new Error(`PIT快照${label}壓縮後仍超過安全大小上限`);
}

function decodeAnalysisPitPayloadUnsafe(envelope) {
  if (!envelope || ![
    LEGACY_ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
    ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
  ].includes(envelope.version)) {
    throw new Error('PIT快照內容編碼版本不相容');
  }
  const expectedRawBytes = Number(envelope.rawBytes);
  if (envelope.encoding !== 'OMITTED_HASH_ONLY'
    && (!Number.isSafeInteger(expectedRawBytes) || expectedRawBytes < 0 || expectedRawBytes > DISTRIBUTION_RAW_LIMIT_BYTES)) {
    throw new Error('PIT快照宣告的原始大小超過安全上限');
  }
  if (envelope.encoding === 'OMITTED_HASH_ONLY') return null;
  let text;
  if (envelope.encoding === 'JSON') {
    if (envelope.version !== LEGACY_ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION) {
      throw new Error('PIT快照新版內容不得使用會受JSONB鍵序影響的內嵌JSON');
    }
    text = jsonText(envelope.value, '內嵌內容');
  } else if (envelope.encoding === 'JSON_BASE64') {
    const base64Bytes = Number(envelope.base64Bytes);
    const data = requiredText(envelope.data, '原始JSON內容', 4_000_000);
    if (!Number.isSafeInteger(base64Bytes) || base64Bytes !== Buffer.byteLength(data, 'ascii')) {
      throw new Error('PIT快照Base64大小宣告不一致');
    }
    const raw = Buffer.from(data, 'base64');
    if (raw.byteLength !== expectedRawBytes || raw.toString('base64') !== data) {
      throw new Error('PIT快照Base64／原始JSON內容不一致');
    }
    text = raw.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(raw)) throw new Error('PIT快照原始JSON不是有效UTF-8');
  }
  else if (envelope.encoding === 'GZIP_BASE64') {
    const compressedBytes = Number(envelope.compressedBytes);
    const base64Bytes = Number(envelope.base64Bytes);
    if (!Number.isSafeInteger(compressedBytes) || compressedBytes <= 0 || compressedBytes > DISTRIBUTION_COMPRESSED_LIMIT_BYTES) {
      throw new Error('PIT快照壓縮大小宣告無效');
    }
    const data = requiredText(envelope.data, '壓縮內容', 4_000_000);
    if (!Number.isSafeInteger(base64Bytes) || base64Bytes !== Buffer.byteLength(data, 'ascii')) {
      throw new Error('PIT快照Base64大小宣告不一致');
    }
    const compressed = Buffer.from(data, 'base64');
    if (compressed.byteLength !== compressedBytes || compressed.toString('base64') !== data) {
      throw new Error('PIT快照Base64／gzip內容不一致');
    }
    text = gunzipSync(
      compressed,
      { maxOutputLength: DISTRIBUTION_RAW_LIMIT_BYTES + 1 },
    ).toString('utf8');
  } else throw new Error('PIT快照內容編碼不支援');
  const raw = Buffer.from(text, 'utf8');
  if (raw.byteLength !== Number(envelope.rawBytes) || exactSha256(raw) !== envelope.payloadHash) {
    throw new Error('PIT快照內容雜湊或大小不一致');
  }
  return JSON.parse(text);
}

export function decodeAnalysisPitPayload(envelope) {
  try { return decodeAnalysisPitPayloadUnsafe(envelope); }
  catch (error) { throw analysisPitIntegrityError(error, 'PIT_PAYLOAD_INTEGRITY_FAILED'); }
}

function leagueId(value) {
  const league = cleanText(value, 8).toUpperCase();
  if (!isLeagueId(league)) throw new Error('PIT快照缺少有效league_id');
  return league;
}

export function analysisPitSnapshotId({ league: leagueValue, gamePk: gamePkValue, analysisType: typeValue, inputHash: hashValue }) {
  const league = leagueId(leagueValue);
  const gamePk = Number(gamePkValue);
  const analysisType = cleanText(typeValue, 40).toUpperCase();
  const inputHash = requiredHash(hashValue, 'input hash');
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) throw new Error('PIT快照缺少有效gamePk');
  if (!ANALYSIS_PIT_ANALYSIS_TYPES.includes(analysisType)) throw new Error('PIT快照分析類型無效');
  return `${league}:${gamePk}:${analysisType}:${inputHash}`;
}

function gameIdentity(league, game, context) {
  const source = game || context?.game || {};
  const embeddedLeague = cleanText(source?.leagueId || source?.league || context?.leagueId, 8).toUpperCase();
  if (embeddedLeague && embeddedLeague !== league) throw new Error('PIT快照聯盟與賽事識別不一致');
  const gamePk = Number(source?.gamePk);
  const awayTeamId = Number(source?.awayTeamId);
  const homeTeamId = Number(source?.homeTeamId);
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) throw new Error('PIT快照缺少有效gamePk');
  if (!Number.isSafeInteger(awayTeamId) || awayTeamId <= 0 || !Number.isSafeInteger(homeTeamId) || homeTeamId <= 0) {
    throw new Error('PIT快照缺少有效球隊識別');
  }
  return {
    leagueId: league,
    gamePk,
    gameNumber: Math.max(1, Number(source?.gameNumber) || 1),
    gameDate: isoInstant(source?.gameDate, '開打'),
    officialDate: cleanText(source?.officialDate, 20) || null,
    awayTeamId,
    homeTeamId,
    away: cleanText(source?.away, 100) || null,
    home: cleanText(source?.home, 100) || null,
    venueId: Number.isSafeInteger(Number(source?.venueId)) && Number(source.venueId) > 0 ? Number(source.venueId) : null,
    venue: cleanText(source?.venue, 120) || null,
  };
}

function providerTimestamps(context) {
  const sources = (Array.isArray(context?.featureProvenance) ? context.featureProvenance : []).slice(0, 500).map(row => ({
    feature: cleanText(row?.featureName || row?.feature, 120) || null,
    provider: cleanText(row?.sourceProvider || row?.source, 180) || null,
    asOf: cleanText(row?.asOf, 40) || null,
    observedAt: cleanText(row?.observedAt, 40) || null,
    providerObservedAt: cleanText(row?.providerObservedAt, 40) || null,
    fetchedAt: cleanText(row?.fetchedAt, 40) || null,
    sourceRecord: cleanText(row?.sourceRecord, 500) || null,
  }));
  return {
    contextFetchedAt: cleanText(context?.fetchedAt, 40) || null,
    weatherFetchedAt: cleanText(context?.weather?.fetchedAt, 40) || null,
    parkFetchedAt: cleanText(context?.park?.fetchedAt, 40) || null,
    sources,
  };
}

function analysisVersions(versions, analysis, context) {
  const source = versions || {};
  const firstCalculated = (Array.isArray(analysis?.directionSlots) ? analysis.directionSlots : analysis?.results || [])
    .find(row => row?.status === 'CALCULATED' || Number.isFinite(Number(row?.modelEV ?? row?.rawWeightedEV ?? row?.weightedEV)));
  return {
    modelVersion: requiredText(source.modelVersion || analysis?.modelVersion || context?.modelVersion, '模型版本', 180),
    rulesVersion: requiredText(source.rulesVersion || analysis?.rulesVersion || context?.rulesVersion, '規則版本', 180),
    dataVersion: requiredText(source.dataVersion || analysis?.dataVersion || context?.dataVersion, '資料版本', 180),
    scoreFormulaVersion: requiredText(source.scoreFormulaVersion, '評分公式版本', 180),
    settlementRuleVersion: requiredText(source.settlementRuleVersion, '結算版本', 180),
    uncertaintySetVersion: requiredText(source.uncertaintySetVersion, '不確定性版本', 180),
    modelEvFormulaVersion: requiredText(
      source.modelEvFormulaVersion || analysis?.modelEVFormulaVersion || firstCalculated?.modelEVFormulaVersion || MODEL_EV_FORMULA_VERSION,
      '模型EV公式版本',
      180,
    ),
    robustEvVersion: requiredText(
      source.robustEvVersion || analysis?.robustEVVersion || firstCalculated?.robustEVVersion || ROBUST_EV_VERSION,
      '穩健EV版本',
      180,
    ),
    directionSlotContractVersion: requiredText(
      source.directionSlotContractVersion || analysis?.directionSlotContractVersion || DIRECTION_SLOT_CONTRACT_VERSION,
      '八方向槽位契約版本',
      180,
    ),
    repriceVersion: cleanText(source.repriceVersion || analysis?.repriceVersion, 180) || null,
    pitPayloadEncodingVersion: cleanText(source.pitPayloadEncodingVersion, 180) || undefined,
  };
}

function compactMarketAnalysis(analysis, markets, previousMarkets) {
  return {
    leagueId: analysis?.leagueId || null,
    analysisType: analysis?.analysisType || null,
    analysisMode: analysis?.analysisMode || null,
    analysisStatus: analysis?.analysisStatus || null,
    betEligible: analysis?.betEligible === true,
    expectedRuns: analysis?.expectedRuns || null,
    dataQuality: analysis?.dataQuality ?? null,
    dataQualificationQuality: analysis?.dataQualificationQuality ?? null,
    dataGateV10: analysis?.dataGateV10 || null,
    scenarioSummary: analysis?.scenarioSummary || null,
    alignmentAudit: analysis?.alignmentAudit || null,
    results: Array.isArray(analysis?.results) ? analysis.results : [],
    directionSlots: Array.isArray(analysis?.directionSlots) ? analysis.directionSlots : [],
    marketCoverage: analysis?.marketCoverage || null,
    readerVersion: cleanText(analysis?.readerVersion, 180) || null,
    readerPayloadHash: cleanText(analysis?.readerPayloadHash, 64) || null,
    readerRawBoardHash: cleanText(analysis?.readerRawBoardHash, 64) || null,
    readerGameMarketHash: cleanText(analysis?.readerGameMarketHash, 64) || null,
    readerBoardDate: cleanText(analysis?.readerBoardDate, 20) || null,
    portfolio: Array.isArray(analysis?.portfolio) ? analysis.portfolio : [],
    suppliedMarkets: Array.isArray(markets) ? markets : [],
    previousMarkets: Array.isArray(previousMarkets) ? previousMarkets : [],
  };
}

function metadataHash(value) {
  return exactSha256(jsonText(value, 'metadata'));
}

function featureContract(context) {
  const contract = {
    sourceStatuses: context?.sourceStatuses || {},
    dataGateVersion: context?.dataGateV10?.version || null,
    starterModelingMode: context?.starterModelingMode || null,
    contextVersion: context?.contextVersion || context?.dataVersion || null,
    featureProvenance: Array.isArray(context?.featureProvenance) ? context.featureProvenance : [],
  };
  return { ...contract, contractHash: metadataHash(contract) };
}

function scenarioContract(analysis, distributionSnapshot, distributionPayload) {
  const contract = {
    distributionId: analysis?.distributionId || null,
    distributionHash: analysis?.distributionHash || null,
    distributionStorage: distributionPayload?.encoding || null,
    scenarioSummary: analysis?.scenarioSummary || null,
    scenarioCount: Number(analysis?.scenarioSummary?.count ?? distributionSnapshot?.scenarios?.length ?? 0),
    exactDistribution: analysis?.scenarioSummary?.exactDistribution === true || distributionSnapshot?.exactDistribution === true,
    linkedSegmentPath: analysis?.scenarioSummary?.linkedSegmentPath === true || distributionSnapshot?.linkedSegmentPath === true,
    stateAwareBottomNinth: distributionSnapshot?.stateAwareBottomNinth === true,
    stateAwareWalkoff: distributionSnapshot?.stateAwareWalkoff === true,
  };
  return { ...contract, contractHash: metadataHash(contract) };
}

function calibrationContract(analysis) {
  const marketCalibration = (Array.isArray(analysis?.results) ? analysis.results : []).map(row => ({
    market: row?.market || null,
    pick: row?.pick || null,
    calibrationQualified: row?.calibrationQualified === true,
    evCalibrationVersion: row?.evCalibration?.version || row?.evCalibration?.calibrationVersion || null,
    reasons: Array.isArray(row?.evCalibration?.reasons) ? row.evCalibration.reasons : [],
    weightedEV: Number.isFinite(Number(row?.weightedEV)) ? Number(row.weightedEV) : null,
    robustEV: Number.isFinite(Number(row?.robustEV)) ? Number(row.robustEV) : null,
  }));
  const contract = {
    status: 'PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE',
    evCalibrationVersion: analysis?.scenarioSummary?.evCalibrationVersion || null,
    scoreStatus: analysis?.scoreStatus || null,
    marketCalibration,
  };
  return { ...contract, contractHash: metadataHash(contract) };
}

function ruleContract(context, analysis, versions) {
  const contract = {
    versions,
    gameStateModel: context?.gameStateModel || null,
    alignmentAudit: analysis?.alignmentAudit || null,
    settlementRuleVersion: versions.settlementRuleVersion,
    scoreFormulaVersion: versions.scoreFormulaVersion,
  };
  return { ...contract, contractHash: metadataHash(contract) };
}

function quarantineContract(context, analysis, distributionSnapshot) {
  const legacyUnverifiable = context?.legacyContextUsed === true
    || analysis?.legacyContextUsed === true
    || distributionSnapshot?.legacyDistributionUsed === true;
  const explicitReasons = [
    ...(Array.isArray(analysis?.quarantineReasons) ? analysis.quarantineReasons : []),
    ...(legacyUnverifiable ? ['LEGACY_OR_UNVERIFIABLE_PIT_INPUT'] : []),
  ].map(value => cleanText(value, 300)).filter(Boolean);
  const contract = {
    status: legacyUnverifiable || explicitReasons.length ? 'QUARANTINED' : 'NOT_QUARANTINED',
    reasons: [...new Set(explicitReasons)],
    legacyEvidenceStatus: legacyUnverifiable ? 'EXCLUDED_UNVERIFIABLE_LEGACY' : 'CURRENT_IMMUTABLE_PIT_CAPTURE',
    calibrationEligibility: legacyUnverifiable ? 'EXCLUDED_UNVERIFIABLE_LEGACY' : 'PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE',
    mayEnterCalibration: false,
  };
  return { ...contract, contractHash: metadataHash(contract) };
}

function replayIdentity(record) {
  // PostgreSQL JSONB does not preserve object key order. Keep the replay
  // identity in the original contract order so a database round-trip cannot
  // turn identical immutable evidence into a different hash.
  const orderedGameIdentity = {
    leagueId: record.gameIdentity?.leagueId,
    gamePk: record.gameIdentity?.gamePk,
    gameNumber: record.gameIdentity?.gameNumber,
    gameDate: record.gameIdentity?.gameDate,
    officialDate: record.gameIdentity?.officialDate,
    awayTeamId: record.gameIdentity?.awayTeamId,
    homeTeamId: record.gameIdentity?.homeTeamId,
    away: record.gameIdentity?.away,
    home: record.gameIdentity?.home,
    venueId: record.gameIdentity?.venueId,
    venue: record.gameIdentity?.venue,
  };
  const orderedVersions = {
    modelVersion: record.versions?.modelVersion,
    rulesVersion: record.versions?.rulesVersion,
    dataVersion: record.versions?.dataVersion,
    scoreFormulaVersion: record.versions?.scoreFormulaVersion,
    settlementRuleVersion: record.versions?.settlementRuleVersion,
    uncertaintySetVersion: record.versions?.uncertaintySetVersion,
    modelEvFormulaVersion: record.versions?.modelEvFormulaVersion,
    robustEvVersion: record.versions?.robustEvVersion,
    directionSlotContractVersion: record.versions?.directionSlotContractVersion,
    repriceVersion: record.versions?.repriceVersion,
    pitPayloadEncodingVersion: record.versions?.pitPayloadEncodingVersion,
  };
  return {
    schemaVersion: record.schemaVersion,
    leagueId: record.leagueId,
    gameIdentity: orderedGameIdentity,
    analysisType: record.analysisType,
    inputHash: record.inputHash,
    coreFingerprint: record.coreFingerprint,
    distributionId: record.distributionId,
    distributionHash: record.distributionHash,
    parentSnapshotId: record.parentSnapshotId,
    parentAnalysisType: record.parentAnalysisType,
    parentInputHash: record.parentInputHash,
    parentDistributionId: record.parentDistributionId,
    parentDistributionHash: record.parentDistributionHash,
    frozenContextHash: record.frozenContextPayload?.payloadHash,
    marketAnalysisHash: record.marketAnalysisPayload?.payloadHash,
    featureContractHash: record.featureContract?.contractHash,
    scenarioContractHash: record.scenarioContract?.contractHash,
    calibrationContractHash: record.calibrationContract?.contractHash,
    ruleContractHash: record.ruleContract?.contractHash,
    quarantineContractHash: record.quarantineContract?.contractHash,
    versions: orderedVersions,
  };
}

export function replayIdentityHash(record) {
  return exactSha256(jsonText(replayIdentity(record), '重播識別'));
}

function semanticContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { contractHash: omittedContractHash, ...contract } = value;
  return contract;
}

export function analysisPitSemanticIdentityHash(record) {
  validateAnalysisPitSnapshotRecord(record);
  return stableSha256({
    schemaVersion: record.schemaVersion,
    snapshotId: record.snapshotId,
    leagueId: record.leagueId,
    gameIdentity: record.gameIdentity,
    analysisType: record.analysisType,
    inputHash: record.inputHash,
    coreFingerprint: record.coreFingerprint,
    priceFingerprint: record.priceFingerprint,
    calculationFingerprint: record.calculationFingerprint,
    auxiliaryFingerprint: record.auxiliaryFingerprint,
    distributionId: record.distributionId,
    distributionHash: record.distributionHash,
    distributionPayloadHash: record.distributionPayload?.payloadHash || null,
    parentSnapshotId: record.parentSnapshotId,
    parentAnalysisType: record.parentAnalysisType,
    parentInputHash: record.parentInputHash,
    parentDistributionId: record.parentDistributionId,
    parentDistributionHash: record.parentDistributionHash,
    frozenContext: decodeAnalysisPitPayload(record.frozenContextPayload),
    marketAnalysis: decodeAnalysisPitPayload(record.marketAnalysisPayload),
    featureContract: semanticContract(record.featureContract),
    scenarioContract: semanticContract(record.scenarioContract),
    calibrationContract: semanticContract(record.calibrationContract),
    ruleContract: semanticContract(record.ruleContract),
    quarantineContract: semanticContract(record.quarantineContract),
    evidenceStatus: record.evidenceStatus,
    quarantineStatus: record.quarantineStatus,
    calibrationEligibility: record.calibrationEligibility,
    versions: record.versions,
  });
}

export function assertAnalysisPitReplayIdentity(record, expected = {}) {
  validateAnalysisPitSnapshotRecord(record);
  const checks = {
    leagueId: expected.leagueId,
    gamePk: expected.gamePk,
    inputHash: expected.inputHash,
    coreFingerprint: expected.coreFingerprint,
    distributionId: expected.distributionId,
    distributionHash: expected.distributionHash,
    parentInputHash: expected.parentInputHash,
    parentSnapshotId: expected.parentSnapshotId,
    parentAnalysisType: expected.parentAnalysisType,
    parentDistributionId: expected.parentDistributionId,
  };
  const actual = {
    leagueId: record.leagueId,
    gamePk: record.gameIdentity.gamePk,
    inputHash: record.inputHash,
    coreFingerprint: record.coreFingerprint,
    distributionId: record.distributionId,
    distributionHash: record.distributionHash,
    parentInputHash: record.parentInputHash,
    parentSnapshotId: record.parentSnapshotId,
    parentAnalysisType: record.parentAnalysisType,
    parentDistributionId: record.parentDistributionId,
  };
  for (const [key, value] of Object.entries(checks)) {
    if (value != null && String(actual[key]) !== String(value)) throw new Error(`PIT快照重播識別不一致：${key}`);
  }
  return true;
}

export function validateAnalysisPitSnapshotRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('PIT快照格式無效');
  const league = leagueId(record.leagueId);
  if (record.schemaVersion !== ANALYSIS_PIT_SNAPSHOT_SCHEMA_VERSION) throw new Error('PIT快照schema版本不相容');
  if (!ANALYSIS_PIT_ANALYSIS_TYPES.includes(record.analysisType)) throw new Error('PIT快照分析類型無效');
  if (record.gameIdentity?.leagueId !== league) throw new Error('PIT快照game identity聯盟不一致');
  if (!Number.isSafeInteger(Number(record.gameIdentity?.gamePk)) || Number(record.gameIdentity.gamePk) <= 0) throw new Error('PIT快照game identity無效');
  requiredHash(record.inputHash, 'input hash');
  requiredHash(record.coreFingerprint, 'core fingerprint');
  requiredHash(record.distributionHash, 'distribution hash');
  requiredHash(record.replayIdentityHash, 'replay identity hash');
  requiredText(record.distributionId, '比分分布識別', 300);
  const gameStart = Date.parse(record.gameStart || '');
  const dataAsOf = Date.parse(record.dataAsOf || '');
  const analysisAsOf = Date.parse(record.analysisAsOf || '');
  const lineAsOf = Date.parse(record.lineAsOf || '');
  if (![gameStart, dataAsOf, analysisAsOf, lineAsOf].every(Number.isFinite)) throw new Error('PIT快照賽前時間鏈無效');
  if (dataAsOf > analysisAsOf || lineAsOf > analysisAsOf || analysisAsOf >= gameStart) throw new Error('PIT快照不是完整賽前point-in-time資料');
  if (record.analysisType === 'FULL') {
    if (record.parentSnapshotId || record.parentAnalysisType || record.parentInputHash || record.parentDistributionId || record.parentDistributionHash) throw new Error('FULL快照不得有父分布');
  } else {
    requiredText(record.parentSnapshotId, '父快照識別', 500);
    if (!ANALYSIS_PIT_ANALYSIS_TYPES.includes(record.parentAnalysisType)) throw new Error('快速重算父分析類型無效');
    requiredHash(record.parentInputHash, '父input hash');
    requiredHash(record.parentDistributionHash, '父distribution hash');
    if (record.parentDistributionId !== record.distributionId || record.parentDistributionHash !== record.distributionHash) {
      throw new Error('快速重算必須連結同一父比分分布');
    }
    const expectedParent = analysisPitSnapshotId({
      league: record.leagueId,
      gamePk: record.gameIdentity.gamePk,
      analysisType: record.parentAnalysisType,
      inputHash: record.parentInputHash,
    });
    if (record.parentSnapshotId !== expectedParent) throw new Error('快速重算父快照識別不一致');
  }
  const expectedSnapshotId = analysisPitSnapshotId({
    league: record.leagueId,
    gamePk: record.gameIdentity.gamePk,
    analysisType: record.analysisType,
    inputHash: record.inputHash,
  });
  if (record.snapshotId !== expectedSnapshotId) throw new Error('PIT快照識別與聯盟／賽事／輸入不一致');
  if (record.analysisType === 'PRICE_ONLY_REPRICE'
    && (record.parentSnapshotId === record.snapshotId
      || record.parentInputHash === record.inputHash)) {
    throw new Error('快速重算不得建立self-parent或無變更父子快照');
  }
  if (!record.frozenContextPayload || record.frozenContextPayload.encoding === 'OMITTED_HASH_ONLY') throw new Error('PIT快照缺少可重播的凍結情境');
  if (!record.marketAnalysisPayload || record.marketAnalysisPayload.encoding === 'OMITTED_HASH_ONLY') throw new Error('PIT快照缺少市場分析');
  if (record.analysisType === 'FULL' && record.distributionPayload?.encoding === 'OMITTED_HASH_ONLY') {
    throw new Error('FULL PIT快照必須永久保存完整或壓縮比分分布');
  }
  for (const name of ['featureContract', 'scenarioContract', 'calibrationContract', 'ruleContract', 'quarantineContract']) {
    requiredHash(record?.[name]?.contractHash, `${name} hash`);
  }
  if (record.quarantineContract.legacyEvidenceStatus === 'EXCLUDED_UNVERIFIABLE_LEGACY'
    && record.quarantineContract.mayEnterCalibration !== false) {
    throw new Error('不可驗證Legacy資料不得進入校準');
  }
  if (record.evidenceStatus !== record.quarantineContract.legacyEvidenceStatus
    || record.quarantineStatus !== record.quarantineContract.status
    || record.calibrationEligibility !== record.quarantineContract.calibrationEligibility) {
    throw new Error('PIT快照可驗證性／隔離／校準資格欄位不一致');
  }
  if (replayIdentityHash(record) !== record.replayIdentityHash) throw new Error('PIT快照重播識別雜湊不一致');
  return record;
}

export function buildAnalysisPitSnapshotRecord({
  league: leagueValue,
  game,
  frozenContext,
  analysis,
  distributionSnapshot = null,
  repriceSnapshot = null,
  versions = {},
  markets = [],
  previousMarkets = [],
  encodedPayloads = null,
}) {
  const league = leagueId(leagueValue);
  if (!frozenContext || typeof frozenContext !== 'object' || Array.isArray(frozenContext)) throw new Error('PIT快照缺少凍結情境');
  const embeddedContextLeague = cleanText(frozenContext?.leagueId || frozenContext?.game?.leagueId || frozenContext?.game?.league, 8).toUpperCase();
  if (embeddedContextLeague && embeddedContextLeague !== league) throw new Error('PIT快照聯盟與凍結情境不一致');
  const identity = gameIdentity(league, game, frozenContext);
  const contextGamePk = Number(frozenContext?.game?.gamePk);
  if (contextGamePk !== identity.gamePk) throw new Error('PIT快照賽事與凍結情境gamePk不一致');
  const analysisLeague = cleanText(analysis?.leagueId || league, 8).toUpperCase();
  if (analysisLeague !== league) throw new Error('PIT快照聯盟與分析結果不一致');
  const analysisType = cleanText(analysis?.analysisType || 'FULL', 40).toUpperCase();
  if (!ANALYSIS_PIT_ANALYSIS_TYPES.includes(analysisType)) throw new Error('PIT快照分析類型無效');
  const gameStart = identity.gameDate;
  const analysisAsOf = isoInstant(analysis?.analysisAsOf || analysis?.createdAt, '分析');
  const dataAsOf = isoInstant(analysis?.dataAsOf || repriceSnapshot?.dataAsOf || frozenContext?.fetchedAt, '資料截點');
  const lineAsOf = isoInstant(analysis?.lineAsOf || analysisAsOf, '盤口截點');
  const versionContract = analysisVersions(versions, analysis, frozenContext);
  const inputHash = requiredHash(analysis?.inputHash || repriceSnapshot?.inputHash, 'input hash');
  const coreFingerprint = requiredHash(analysis?.coreFingerprint || repriceSnapshot?.coreFingerprint || frozenContext?.coreFingerprint, 'core fingerprint');
  const distributionId = requiredText(analysis?.distributionId || repriceSnapshot?.distributionId, '比分分布識別', 300);
  const distributionHash = requiredHash(analysis?.distributionHash || repriceSnapshot?.distributionHash, 'distribution hash');
  if (distributionSnapshot && (distributionSnapshot.distributionId !== distributionId || distributionSnapshot.distributionHash !== distributionHash)) {
    throw new Error('PIT快照比分分布payload與識別不一致');
  }
  const parentInputHash = analysisType === 'PRICE_ONLY_REPRICE'
    ? requiredHash(analysis?.parentInputHash || repriceSnapshot?.parentInputHash, '父input hash')
    : null;
  const parentAnalysisType = analysisType === 'PRICE_ONLY_REPRICE'
    ? cleanText(analysis?.parentAnalysisType || repriceSnapshot?.parentAnalysisType || 'FULL', 40).toUpperCase()
    : null;
  if (parentAnalysisType && !ANALYSIS_PIT_ANALYSIS_TYPES.includes(parentAnalysisType)) throw new Error('PIT快照父分析類型無效');
  const derivedParentSnapshotId = analysisType === 'PRICE_ONLY_REPRICE'
    ? analysisPitSnapshotId({ league, gamePk: identity.gamePk, analysisType: parentAnalysisType, inputHash: parentInputHash })
    : null;
  const parentSnapshotId = analysisType === 'PRICE_ONLY_REPRICE'
    ? cleanText(analysis?.parentPitSnapshotId || repriceSnapshot?.parentPitSnapshotId || derivedParentSnapshotId, 500)
    : null;
  if (parentSnapshotId && parentSnapshotId !== derivedParentSnapshotId) throw new Error('PIT快照父快照識別與父輸入不一致');
  const parentDistributionId = analysisType === 'PRICE_ONLY_REPRICE'
    ? requiredText(analysis?.parentDistributionId || repriceSnapshot?.parentDistributionId || distributionId, '父比分分布識別', 300)
    : null;
  const parentDistributionHash = analysisType === 'PRICE_ONLY_REPRICE' ? distributionHash : null;
  const frozenContextPayload = encodedPayloads?.frozenContextPayload || encodeAnalysisPitPayload(frozenContext, {
    label: '凍結情境',
    inlineLimitBytes: 256_000,
    rawLimitBytes: FROZEN_CONTEXT_RAW_LIMIT_BYTES,
    compressedLimitBytes: FROZEN_CONTEXT_COMPRESSED_LIMIT_BYTES,
  });
  const marketAnalysisPayload = encodedPayloads?.marketAnalysisPayload || encodeAnalysisPitPayload(compactMarketAnalysis(analysis, markets, previousMarkets), {
    label: '市場分析',
    inlineLimitBytes: 192_000,
    rawLimitBytes: MARKET_ANALYSIS_RAW_LIMIT_BYTES,
    compressedLimitBytes: MARKET_ANALYSIS_COMPRESSED_LIMIT_BYTES,
  });
  if (analysisType === 'FULL' && !distributionSnapshot) throw new Error('FULL PIT快照缺少永久比分分布payload');
  const distributionPayload = encodedPayloads?.distributionPayload || (distributionSnapshot ? encodeAnalysisPitPayload(distributionSnapshot, {
    label: '比分分布',
    inlineLimitBytes: DISTRIBUTION_INLINE_LIMIT_BYTES,
    rawLimitBytes: DISTRIBUTION_RAW_LIMIT_BYTES,
    compressedLimitBytes: DISTRIBUTION_COMPRESSED_LIMIT_BYTES,
    allowOmit: analysisType !== 'FULL',
  }) : {
    version: ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
    encoding: 'OMITTED_HASH_ONLY',
    rawBytes: null,
    compressedBytes: null,
    payloadHash: distributionHash,
    reason: 'NOT_SUPPLIED_REBUILDABLE_FROM_FROZEN_CONTEXT',
  });
  const record = {
    schemaVersion: ANALYSIS_PIT_SNAPSHOT_SCHEMA_VERSION,
    leagueId: league,
    gameIdentity: identity,
    gameStart,
    dataAsOf,
    analysisAsOf,
    lineAsOf,
    providerTimestamps: providerTimestamps(frozenContext),
    analysisType,
    inputHash,
    coreFingerprint,
    priceFingerprint: requiredHash(analysis?.priceFingerprint || repriceSnapshot?.priceFingerprint, 'price fingerprint'),
    calculationFingerprint: requiredHash(analysis?.calculationFingerprint || repriceSnapshot?.calculationFingerprint, 'calculation fingerprint'),
    auxiliaryFingerprint: requiredHash(analysis?.auxiliaryFingerprint || repriceSnapshot?.auxiliaryFingerprint, 'auxiliary fingerprint'),
    distributionId,
    distributionHash,
    distributionStorage: ['JSON', 'JSON_BASE64'].includes(distributionPayload.encoding) ? 'FULL_JSON'
      : distributionPayload.encoding === 'GZIP_BASE64' ? 'GZIP_BASE64' : 'HASH_ONLY_REBUILDABLE',
    distributionPayload,
    parentInputHash,
    parentSnapshotId,
    parentAnalysisType,
    parentDistributionId,
    parentDistributionHash,
    frozenContextPayload,
    marketAnalysisPayload,
    versions: versionContract,
  };
  record.featureContract = featureContract(frozenContext);
  record.scenarioContract = scenarioContract(analysis, distributionSnapshot, distributionPayload);
  record.calibrationContract = calibrationContract(analysis);
  record.ruleContract = ruleContract(frozenContext, analysis, versionContract);
  record.quarantineContract = quarantineContract(frozenContext, analysis, distributionSnapshot);
  record.evidenceStatus = record.quarantineContract.legacyEvidenceStatus;
  record.quarantineStatus = record.quarantineContract.status;
  record.calibrationEligibility = record.quarantineContract.calibrationEligibility;
  record.replayIdentityHash = replayIdentityHash(record);
  record.snapshotId = analysisPitSnapshotId({ league, gamePk: identity.gamePk, analysisType, inputHash });
  return validateAnalysisPitSnapshotRecord(record);
}

export async function buildAnalysisPitSnapshotRecordAsync(input) {
  const analysisType = cleanText(input?.analysis?.analysisType || 'FULL', 40).toUpperCase();
  if (!ANALYSIS_PIT_ANALYSIS_TYPES.includes(analysisType)) throw new Error('PIT快照分析類型無效');
  if (analysisType === 'FULL' && !input?.distributionSnapshot) throw new Error('FULL PIT快照缺少永久比分分布payload');
  const [frozenContextPayload, marketAnalysisPayload, distributionPayload] = await Promise.all([
    encodeAnalysisPitPayloadAsync(input?.frozenContext, {
      label: '凍結情境', inlineLimitBytes: 256_000,
      rawLimitBytes: FROZEN_CONTEXT_RAW_LIMIT_BYTES,
      compressedLimitBytes: FROZEN_CONTEXT_COMPRESSED_LIMIT_BYTES,
    }),
    encodeAnalysisPitPayloadAsync(compactMarketAnalysis(input?.analysis, input?.markets, input?.previousMarkets), {
      label: '市場分析', inlineLimitBytes: 192_000,
      rawLimitBytes: MARKET_ANALYSIS_RAW_LIMIT_BYTES,
      compressedLimitBytes: MARKET_ANALYSIS_COMPRESSED_LIMIT_BYTES,
    }),
    input?.distributionSnapshot ? encodeAnalysisPitPayloadAsync(input.distributionSnapshot, {
      label: '比分分布', inlineLimitBytes: DISTRIBUTION_INLINE_LIMIT_BYTES,
      rawLimitBytes: DISTRIBUTION_RAW_LIMIT_BYTES,
      compressedLimitBytes: DISTRIBUTION_COMPRESSED_LIMIT_BYTES,
      allowOmit: analysisType !== 'FULL',
    }) : Promise.resolve({
      version: ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
      encoding: 'OMITTED_HASH_ONLY',
      rawBytes: null,
      compressedBytes: null,
      base64Bytes: null,
      payloadHash: requiredHash(input?.analysis?.distributionHash || input?.repriceSnapshot?.distributionHash, 'distribution hash'),
      reason: 'NOT_SUPPLIED_REBUILDABLE_FROM_FROZEN_CONTEXT',
    }),
  ]);
  return buildAnalysisPitSnapshotRecord({
    ...input,
    encodedPayloads: { frozenContextPayload, marketAnalysisPayload, distributionPayload },
  });
}

export function analysisPitDatabaseConfigured() {
  return durableDatabaseConfigured();
}

export function analysisPitProductionPersistenceRequired(env = process.env) {
  const vercelEnvironment = cleanText(env?.VERCEL_ENV, 40).toLowerCase();
  const nodeEnvironment = cleanText(env?.NODE_ENV, 40).toLowerCase();
  const runningOnVercel = Boolean(cleanText(env?.VERCEL, 40));
  return vercelEnvironment === 'production'
    || (nodeEnvironment === 'production' && runningOnVercel);
}

function sql() {
  if (!sqlClient) sqlClient = neon(durableDatabaseUrl());
  return sqlClient;
}

async function ensureAnalysisPitSchema() {
  if (!schemaReady) schemaReady = (async () => {
    await sql()`
      CREATE TABLE IF NOT EXISTS baseball_analysis_pit_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        league_id TEXT NOT NULL CHECK (league_id IN ('MLB', 'NPB', 'KBO', 'CPBL')),
        external_game_id BIGINT NOT NULL,
        game_number INTEGER NOT NULL,
        game_identity JSONB NOT NULL,
        game_start TIMESTAMPTZ NOT NULL,
        data_as_of TIMESTAMPTZ NOT NULL,
        analysis_as_of TIMESTAMPTZ NOT NULL,
        line_as_of TIMESTAMPTZ NOT NULL,
        provider_timestamps JSONB NOT NULL,
        analysis_type TEXT NOT NULL CHECK (analysis_type IN ('FULL', 'PRICE_ONLY_REPRICE')),
        input_hash CHAR(64) NOT NULL,
        core_fingerprint CHAR(64) NOT NULL,
        price_fingerprint CHAR(64) NOT NULL,
        calculation_fingerprint CHAR(64) NOT NULL,
        auxiliary_fingerprint CHAR(64) NOT NULL,
        distribution_id TEXT NOT NULL,
        distribution_hash CHAR(64) NOT NULL,
        distribution_storage TEXT NOT NULL CHECK (distribution_storage IN ('FULL_JSON', 'GZIP_BASE64', 'HASH_ONLY_REBUILDABLE')),
        distribution_payload JSONB NOT NULL,
        parent_snapshot_id TEXT REFERENCES baseball_analysis_pit_snapshots(snapshot_id) DEFERRABLE INITIALLY DEFERRED,
        parent_analysis_type TEXT CHECK (parent_analysis_type IS NULL OR parent_analysis_type IN ('FULL', 'PRICE_ONLY_REPRICE')),
        parent_input_hash CHAR(64),
        parent_distribution_id TEXT,
        parent_distribution_hash CHAR(64),
        frozen_context_payload JSONB NOT NULL,
        market_analysis_payload JSONB NOT NULL,
        feature_contract JSONB NOT NULL,
        scenario_contract JSONB NOT NULL,
        calibration_contract JSONB NOT NULL,
        rule_contract JSONB NOT NULL,
        quarantine_contract JSONB NOT NULL,
        evidence_status TEXT NOT NULL CHECK (evidence_status IN ('CURRENT_IMMUTABLE_PIT_CAPTURE', 'EXCLUDED_UNVERIFIABLE_LEGACY')),
        quarantine_status TEXT NOT NULL CHECK (quarantine_status IN ('NOT_QUARANTINED', 'QUARANTINED')),
        calibration_eligibility TEXT NOT NULL CHECK (calibration_eligibility IN ('PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE', 'EXCLUDED_UNVERIFIABLE_LEGACY')),
        model_version TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        data_version TEXT NOT NULL,
        score_formula_version TEXT NOT NULL,
        settlement_rule_version TEXT NOT NULL,
        uncertainty_set_version TEXT NOT NULL,
        reprice_version TEXT,
        versions JSONB NOT NULL,
        replay_identity_hash CHAR(64) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (league_id, analysis_type, input_hash),
        CHECK (data_as_of <= analysis_as_of),
        CHECK (line_as_of <= analysis_as_of),
        CHECK (analysis_as_of < game_start),
        CHECK (created_at < game_start),
        CHECK (
          (analysis_type = 'FULL' AND parent_snapshot_id IS NULL AND parent_analysis_type IS NULL AND parent_input_hash IS NULL AND parent_distribution_id IS NULL AND parent_distribution_hash IS NULL)
          OR
          (analysis_type = 'PRICE_ONLY_REPRICE' AND parent_snapshot_id IS NOT NULL AND parent_analysis_type IS NOT NULL AND parent_input_hash IS NOT NULL AND parent_distribution_id = distribution_id AND parent_distribution_hash = distribution_hash)
        ),
        CONSTRAINT analysis_pit_reprice_not_self CHECK (
          analysis_type <> 'PRICE_ONLY_REPRICE'
          OR (parent_snapshot_id <> snapshot_id AND parent_input_hash <> input_hash)
        )
      )
    `;
    // CREATE TABLE IF NOT EXISTS does not evolve a table from a previous
    // deployment. Additive columns keep rolling Production deploys compatible;
    // any pre-v1 row is explicitly quarantined from calibration.
    await sql()`
      ALTER TABLE baseball_analysis_pit_snapshots
        ADD COLUMN IF NOT EXISTS parent_snapshot_id TEXT REFERENCES baseball_analysis_pit_snapshots(snapshot_id) DEFERRABLE INITIALLY DEFERRED,
        ADD COLUMN IF NOT EXISTS parent_analysis_type TEXT,
        ADD COLUMN IF NOT EXISTS feature_contract JSONB NOT NULL DEFAULT '{"legacyMigration":true}'::jsonb,
        ADD COLUMN IF NOT EXISTS scenario_contract JSONB NOT NULL DEFAULT '{"legacyMigration":true}'::jsonb,
        ADD COLUMN IF NOT EXISTS calibration_contract JSONB NOT NULL DEFAULT '{"status":"EXCLUDED_UNVERIFIABLE_LEGACY"}'::jsonb,
        ADD COLUMN IF NOT EXISTS rule_contract JSONB NOT NULL DEFAULT '{"legacyMigration":true}'::jsonb,
        ADD COLUMN IF NOT EXISTS quarantine_contract JSONB NOT NULL DEFAULT '{"status":"QUARANTINED","legacyEvidenceStatus":"EXCLUDED_UNVERIFIABLE_LEGACY","calibrationEligibility":"EXCLUDED_UNVERIFIABLE_LEGACY","mayEnterCalibration":false}'::jsonb,
        ADD COLUMN IF NOT EXISTS evidence_status TEXT NOT NULL DEFAULT 'EXCLUDED_UNVERIFIABLE_LEGACY',
        ADD COLUMN IF NOT EXISTS quarantine_status TEXT NOT NULL DEFAULT 'QUARANTINED',
        ADD COLUMN IF NOT EXISTS calibration_eligibility TEXT NOT NULL DEFAULT 'EXCLUDED_UNVERIFIABLE_LEGACY'
    `;
    await sql()`
      DO $pit_noop_constraint$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('analysis_pit_reprice_not_self'));
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'analysis_pit_reprice_not_self'
            AND conrelid = 'baseball_analysis_pit_snapshots'::regclass
        ) THEN
          ALTER TABLE baseball_analysis_pit_snapshots
            ADD CONSTRAINT analysis_pit_reprice_not_self
            CHECK (
              analysis_type <> 'PRICE_ONLY_REPRICE'
              OR (parent_snapshot_id <> snapshot_id AND parent_input_hash <> input_hash)
            ) NOT VALID;
        END IF;
      END
      $pit_noop_constraint$
    `;
    await sql()`CREATE INDEX IF NOT EXISTS idx_analysis_pit_league_game_time ON baseball_analysis_pit_snapshots(league_id, external_game_id, analysis_as_of DESC)`;
    await sql()`CREATE INDEX IF NOT EXISTS idx_analysis_pit_distribution ON baseball_analysis_pit_snapshots(league_id, distribution_hash)`;
    await sql()`CREATE INDEX IF NOT EXISTS idx_analysis_pit_parent ON baseball_analysis_pit_snapshots(parent_snapshot_id)`;
    await sql()`CREATE INDEX IF NOT EXISTS idx_analysis_pit_calibration_gate ON baseball_analysis_pit_snapshots(league_id, calibration_eligibility, game_start)`;
    await sql()`
      CREATE OR REPLACE FUNCTION reject_baseball_analysis_pit_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Baseball analysis PIT snapshots are immutable'; END $$
    `;
    await sql()`
      DO $pit_trigger$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('baseball_analysis_pit_immutable'));
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'baseball_analysis_pit_immutable'
            AND tgrelid = 'baseball_analysis_pit_snapshots'::regclass
            AND NOT tgisinternal
        ) THEN
          EXECUTE 'CREATE TRIGGER baseball_analysis_pit_immutable BEFORE UPDATE OR DELETE ON baseball_analysis_pit_snapshots FOR EACH ROW EXECUTE FUNCTION reject_baseball_analysis_pit_mutation()';
        END IF;
      END
      $pit_trigger$
    `;
  })().catch(error => { schemaReady = null; throw error; });
  await schemaReady;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForStoredParent(record) {
  if (!record.parentSnapshotId) return true;
  for (const pauseMs of [0, 25, 100, 300, 900]) {
    if (pauseMs) await delay(pauseMs);
    const rows = await sql()`SELECT snapshot_id FROM baseball_analysis_pit_snapshots WHERE snapshot_id = ${record.parentSnapshotId} LIMIT 1`;
    if (rows.length) return true;
  }
  return false;
}

function storedIdentity(row) {
  return {
    snapshotId: row?.snapshot_id,
    leagueId: row?.league_id,
    gamePk: Number(row?.external_game_id),
    analysisType: row?.analysis_type,
    inputHash: row?.input_hash,
    coreFingerprint: row?.core_fingerprint,
    distributionId: row?.distribution_id,
    distributionHash: row?.distribution_hash,
    parentInputHash: row?.parent_input_hash || null,
    parentSnapshotId: row?.parent_snapshot_id || null,
    parentAnalysisType: row?.parent_analysis_type || null,
    parentDistributionId: row?.parent_distribution_id || null,
    replayIdentityHash: row?.replay_identity_hash,
  };
}

export function assertStoredAnalysisPitIdentity(record, row) {
  const actual = storedIdentity(row);
  const expected = {
    snapshotId: record.snapshotId,
    leagueId: record.leagueId,
    gamePk: record.gameIdentity.gamePk,
    analysisType: record.analysisType,
    inputHash: record.inputHash,
    coreFingerprint: record.coreFingerprint,
    distributionId: record.distributionId,
    distributionHash: record.distributionHash,
    parentInputHash: record.parentInputHash,
    parentSnapshotId: record.parentSnapshotId,
    parentAnalysisType: record.parentAnalysisType,
    parentDistributionId: record.parentDistributionId,
    replayIdentityHash: record.replayIdentityHash,
  };
  for (const key of Object.keys(expected)) {
    if (String(actual[key] ?? '') !== String(expected[key] ?? '')) throw new Error(`PIT資料庫重播識別衝突：${key}`);
  }
  return true;
}

function jsonColumn(value) {
  if (value == null || typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

export function analysisPitRecordFromDatabaseRow(row) {
  if (!row || typeof row !== 'object') throw new Error('PIT資料庫列格式無效');
  const record = {
    snapshotId: row.snapshot_id,
    schemaVersion: row.schema_version,
    leagueId: row.league_id,
    gameIdentity: jsonColumn(row.game_identity),
    gameStart: isoInstant(row.game_start, '開打'),
    dataAsOf: isoInstant(row.data_as_of, '資料截點'),
    analysisAsOf: isoInstant(row.analysis_as_of, '分析'),
    lineAsOf: isoInstant(row.line_as_of, '盤口截點'),
    providerTimestamps: jsonColumn(row.provider_timestamps),
    analysisType: row.analysis_type,
    inputHash: row.input_hash,
    coreFingerprint: row.core_fingerprint,
    priceFingerprint: row.price_fingerprint,
    calculationFingerprint: row.calculation_fingerprint,
    auxiliaryFingerprint: row.auxiliary_fingerprint,
    distributionId: row.distribution_id,
    distributionHash: row.distribution_hash,
    distributionStorage: row.distribution_storage,
    distributionPayload: jsonColumn(row.distribution_payload),
    parentSnapshotId: row.parent_snapshot_id || null,
    parentAnalysisType: row.parent_analysis_type || null,
    parentInputHash: row.parent_input_hash || null,
    parentDistributionId: row.parent_distribution_id || null,
    parentDistributionHash: row.parent_distribution_hash || null,
    frozenContextPayload: jsonColumn(row.frozen_context_payload),
    marketAnalysisPayload: jsonColumn(row.market_analysis_payload),
    featureContract: jsonColumn(row.feature_contract),
    scenarioContract: jsonColumn(row.scenario_contract),
    calibrationContract: jsonColumn(row.calibration_contract),
    ruleContract: jsonColumn(row.rule_contract),
    quarantineContract: jsonColumn(row.quarantine_contract),
    evidenceStatus: row.evidence_status,
    quarantineStatus: row.quarantine_status,
    calibrationEligibility: row.calibration_eligibility,
    versions: jsonColumn(row.versions),
    replayIdentityHash: row.replay_identity_hash,
  };
  return validateAnalysisPitSnapshotRecord(record);
}

export function buildAnalysisPitReplayBundle(record, { parentRecords = [], expected = {} } = {}) {
  assertAnalysisPitReplayIdentity(record, expected);
  const bySnapshotId = new Map((Array.isArray(parentRecords) ? parentRecords : []).map(parent => [parent?.snapshotId, parent]));
  const chain = [record];
  const seen = new Set([record.snapshotId]);
  let cursor = record;
  while (cursor.analysisType === 'PRICE_ONLY_REPRICE') {
    const parent = bySnapshotId.get(cursor.parentSnapshotId);
    if (!parent) throw new Error(`PIT重播缺少父快照：${cursor.parentSnapshotId}`);
    validateAnalysisPitSnapshotRecord(parent);
    if (seen.has(parent.snapshotId)) throw new Error('PIT重播父快照鏈形成循環');
    if (parent.snapshotId !== cursor.parentSnapshotId
      || parent.analysisType !== cursor.parentAnalysisType
      || parent.inputHash !== cursor.parentInputHash
      || parent.leagueId !== cursor.leagueId
      || parent.gameIdentity.gamePk !== cursor.gameIdentity.gamePk
      || parent.coreFingerprint !== cursor.coreFingerprint
      || parent.distributionId !== cursor.distributionId
      || parent.distributionHash !== cursor.distributionHash) {
      throw new Error('PIT重播父快照身分、核心或比分分布不一致');
    }
    seen.add(parent.snapshotId);
    chain.push(parent);
    cursor = parent;
    if (chain.length > 100) throw new Error('PIT重播父快照鏈超過安全上限');
  }
  if (cursor.analysisType !== 'FULL') throw new Error('PIT重播找不到FULL根快照');
  const distributionSnapshot = decodeAnalysisPitPayload(cursor.distributionPayload);
  if (!distributionSnapshot
    || distributionSnapshot.distributionId !== record.distributionId
    || distributionSnapshot.distributionHash !== record.distributionHash) {
    throw new Error('PIT重播永久比分分布與識別不一致');
  }
  return {
    snapshotId: record.snapshotId,
    leagueId: record.leagueId,
    gameIdentity: record.gameIdentity,
    inputHash: record.inputHash,
    coreFingerprint: record.coreFingerprint,
    priceFingerprint: record.priceFingerprint,
    calculationFingerprint: record.calculationFingerprint,
    auxiliaryFingerprint: record.auxiliaryFingerprint,
    distributionId: record.distributionId,
    distributionHash: record.distributionHash,
    dataAsOf: record.dataAsOf,
    analysisAsOf: record.analysisAsOf,
    lineAsOf: record.lineAsOf,
    evidenceStatus: record.evidenceStatus,
    calibrationEligibility: record.calibrationEligibility,
    frozenContext: decodeAnalysisPitPayload(record.frozenContextPayload),
    marketAnalysis: decodeAnalysisPitPayload(record.marketAnalysisPayload),
    distributionSnapshot,
    distributionSourceSnapshotId: cursor.snapshotId,
    parentChain: chain.map(row => row.snapshotId),
    versions: record.versions,
    quarantineContract: record.quarantineContract,
  };
}

async function selectAnalysisPitSnapshot(snapshotId, league) {
  let rows;
  try {
    rows = await sql()`
      SELECT snapshot_id, schema_version, league_id, external_game_id, game_number, game_identity,
             game_start, data_as_of, analysis_as_of, line_as_of, provider_timestamps, analysis_type,
             input_hash, core_fingerprint, price_fingerprint, calculation_fingerprint, auxiliary_fingerprint,
             distribution_id, distribution_hash, distribution_storage, distribution_payload,
             parent_snapshot_id, parent_analysis_type, parent_input_hash, parent_distribution_id, parent_distribution_hash,
             frozen_context_payload, market_analysis_payload, feature_contract, scenario_contract,
             calibration_contract, rule_contract, quarantine_contract, evidence_status, quarantine_status,
             calibration_eligibility, versions, replay_identity_hash
      FROM baseball_analysis_pit_snapshots
      WHERE snapshot_id = ${snapshotId} AND league_id = ${league}
      LIMIT 1
    `;
  } catch (error) {
    throw markDatabaseError(error, 'ANALYSIS_PIT_REPLAY_ROW_READ_FAILED');
  }
  if (!rows.length) return null;
  try { return analysisPitRecordFromDatabaseRow(rows[0]); }
  catch (error) { throw analysisPitIntegrityError(error); }
}

export async function loadAnalysisPitReplay({ league: leagueValue, snapshotId, expected = {} }) {
  const league = leagueId(leagueValue);
  const id = requiredText(snapshotId, 'snapshot id', 500);
  if (!analysisPitDatabaseConfigured()) throw new Error('PIT重播需要DATABASE_URL');
  try { await ensureAnalysisPitSchema(); }
  catch (error) { throw markDatabaseError(error, 'ANALYSIS_PIT_REPLAY_SCHEMA_READ_FAILED'); }
  try {
    const record = await selectAnalysisPitSnapshot(id, league);
    if (!record) return null;
    const parents = [];
    const seen = new Set([record.snapshotId]);
    let cursor = record;
    while (cursor.analysisType === 'PRICE_ONLY_REPRICE') {
      if (seen.has(cursor.parentSnapshotId)) throw new Error('PIT重播父快照鏈形成循環');
      const parent = await selectAnalysisPitSnapshot(cursor.parentSnapshotId, league);
      if (!parent) throw new Error(`PIT重播缺少父快照：${cursor.parentSnapshotId}`);
      parents.push(parent);
      seen.add(parent.snapshotId);
      cursor = parent;
      if (parents.length > 100) throw new Error('PIT重播父快照鏈超過安全上限');
    }
    return buildAnalysisPitReplayBundle(record, { parentRecords: parents, expected: { ...expected, leagueId: league } });
  } catch (error) {
    if (isDatabaseError(error)) throw error;
    throw analysisPitIntegrityError(error);
  }
}

export async function loadLatestAnalysisPitIdentity({ league: leagueValue, gamePk: gamePkValue }) {
  const league = leagueId(leagueValue);
  const gamePk = Number(gamePkValue);
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) throw new Error('最新PIT查核缺少有效場次');
  if (!analysisPitDatabaseConfigured()) throw new Error('最新PIT查核需要DATABASE_URL');
  await ensureAnalysisPitSchema();
  const rows = await sql()`
    SELECT snapshot_id, input_hash, analysis_as_of, line_as_of
    FROM baseball_analysis_pit_snapshots
    WHERE league_id = ${league}
      AND external_game_id = ${gamePk}
      AND evidence_status = 'CURRENT_IMMUTABLE_PIT_CAPTURE'
      AND quarantine_status = 'NOT_QUARANTINED'
      AND calibration_eligibility = 'PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE'
    ORDER BY analysis_as_of DESC, created_at DESC, snapshot_id DESC
    LIMIT 1
  `;
  if (!rows.length) return null;
  return {
    snapshotId: cleanText(rows[0].snapshot_id, 500),
    inputHash: requiredHash(rows[0].input_hash, '最新PIT input hash'),
    analysisAsOf: isoInstant(rows[0].analysis_as_of, '最新PIT分析截點'),
    lineAsOf: isoInstant(rows[0].line_as_of, '最新PIT盤口截點'),
  };
}

export async function persistAnalysisPitSnapshot(record) {
  validateAnalysisPitSnapshotRecord(record);
  if (!analysisPitDatabaseConfigured()) return { stored: false, reason: 'DATABASE_NOT_CONFIGURED', snapshotId: record.snapshotId };
  await ensureAnalysisPitSchema();
  if (!(await waitForStoredParent(record))) {
    return { stored: false, reason: 'PARENT_SNAPSHOT_NOT_STORED', snapshotId: record.snapshotId, parentSnapshotId: record.parentSnapshotId };
  }
  const inserted = await sql()`
    INSERT INTO baseball_analysis_pit_snapshots (
      snapshot_id, schema_version, league_id, external_game_id, game_number, game_identity,
      game_start, data_as_of, analysis_as_of, line_as_of, provider_timestamps, analysis_type,
      input_hash, core_fingerprint, price_fingerprint, calculation_fingerprint, auxiliary_fingerprint,
      distribution_id, distribution_hash, distribution_storage, distribution_payload,
      parent_snapshot_id, parent_analysis_type, parent_input_hash, parent_distribution_id, parent_distribution_hash,
      frozen_context_payload, market_analysis_payload, feature_contract, scenario_contract,
      calibration_contract, rule_contract, quarantine_contract, evidence_status, quarantine_status, calibration_eligibility,
      model_version, rules_version, data_version, score_formula_version, settlement_rule_version,
      uncertainty_set_version, reprice_version, versions, replay_identity_hash
    )
    SELECT
      ${record.snapshotId}, ${record.schemaVersion}, ${record.leagueId}, ${record.gameIdentity.gamePk}, ${record.gameIdentity.gameNumber}, ${JSON.stringify(record.gameIdentity)}::jsonb,
      ${record.gameStart}, ${record.dataAsOf}, ${record.analysisAsOf}, ${record.lineAsOf}, ${JSON.stringify(record.providerTimestamps)}::jsonb, ${record.analysisType},
      ${record.inputHash}, ${record.coreFingerprint}, ${record.priceFingerprint}, ${record.calculationFingerprint}, ${record.auxiliaryFingerprint},
      ${record.distributionId}, ${record.distributionHash}, ${record.distributionStorage}, ${JSON.stringify(record.distributionPayload)}::jsonb,
      ${record.parentSnapshotId}, ${record.parentAnalysisType}, ${record.parentInputHash}, ${record.parentDistributionId}, ${record.parentDistributionHash},
      ${JSON.stringify(record.frozenContextPayload)}::jsonb, ${JSON.stringify(record.marketAnalysisPayload)}::jsonb,
      ${JSON.stringify(record.featureContract)}::jsonb, ${JSON.stringify(record.scenarioContract)}::jsonb,
      ${JSON.stringify(record.calibrationContract)}::jsonb, ${JSON.stringify(record.ruleContract)}::jsonb, ${JSON.stringify(record.quarantineContract)}::jsonb,
      ${record.evidenceStatus}, ${record.quarantineStatus}, ${record.calibrationEligibility},
      ${record.versions.modelVersion}, ${record.versions.rulesVersion}, ${record.versions.dataVersion}, ${record.versions.scoreFormulaVersion}, ${record.versions.settlementRuleVersion},
      ${record.versions.uncertaintySetVersion}, ${record.versions.repriceVersion}, ${JSON.stringify(record.versions)}::jsonb, ${record.replayIdentityHash}
    WHERE ${record.gameStart}::timestamptz > NOW()
    ON CONFLICT DO NOTHING
    RETURNING snapshot_id
  `;
  const storedRecord = await selectAnalysisPitSnapshot(record.snapshotId, record.leagueId);
  if (!storedRecord) return { stored: false, reason: 'POSTGAME_WRITE_REJECTED', snapshotId: record.snapshotId };
  if (storedRecord.replayIdentityHash !== record.replayIdentityHash
    && analysisPitSemanticIdentityHash(storedRecord) !== analysisPitSemanticIdentityHash(record)) {
    throw new Error('PIT資料庫重播識別衝突：semanticIdentityHash');
  }
  return {
    stored: true,
    inserted: inserted.length > 0,
    idempotent: inserted.length === 0,
    snapshotId: record.snapshotId,
    record: storedRecord,
  };
}

export async function persistAnalysisPitSnapshotBestEffort(record) {
  try { return await persistAnalysisPitSnapshot(record); }
  catch (error) {
    console.error('[ANALYSIS_PIT_SNAPSHOT_WRITE_FAILED]', {
      league: record?.leagueId,
      gamePk: record?.gameIdentity?.gamePk,
      snapshotId: record?.snapshotId,
      error: String(error?.message || error),
    });
    return { stored: false, reason: 'WRITE_FAILED', snapshotId: record?.snapshotId || null };
  }
}

export async function persistAnalysisPitSnapshotForResponse(input, { requiredWhenConfigured = true } = {}) {
  const configured = analysisPitDatabaseConfigured();
  const productionRequired = analysisPitProductionPersistenceRequired();
  const required = productionRequired || (configured && requiredWhenConfigured);
  const fallbackSnapshotId = cleanText(input?.analysis?.pitSnapshotId, 500) || null;
  if (!configured) return {
    status: productionRequired ? 'FAILED' : 'UNAVAILABLE',
    confirmed: false,
    required,
    reason: 'DATABASE_NOT_CONFIGURED',
    snapshotId: fallbackSnapshotId,
  };
  try {
    const record = await buildAnalysisPitSnapshotRecordAsync(input);
    const result = await persistAnalysisPitSnapshot(record);
    if (result.stored === true) {
      // Direction-history persistence is deliberately best-effort at the
      // response boundary.  A database/schema failure is surfaced as QA
      // provenance, but it must never erase or rewrite the already calculated
      // public W/R values.
      let directionHistory = null;
      if (result.idempotent) {
        try {
          const existing = await loadAnalysisDirectionHistory(record.snapshotId);
          if (existing) directionHistory = {
            status: 'CONFIRMED', confirmed: true, stored: true, inserted: 0,
            idempotent: true, reason: 'IDEMPOTENT_EXISTING', snapshotId: record.snapshotId,
            historyHash: existing.historyHash, storedCount: existing.directionSlots.length,
          };
        } catch {
          // A missing or partial direction set is completed below from the
          // canonical immutable PIT row. Existing conflicting rows still fail closed.
        }
      }
      if (!directionHistory) {
        const canonicalRecord = result.record || record;
        const canonicalAnalysis = result.idempotent
          ? decodeAnalysisPitPayload(canonicalRecord.marketAnalysisPayload)
          : input?.analysis;
        directionHistory = await persistAnalysisDirectionHistoryBestEffort({
          snapshotRecord: canonicalRecord,
          analysis: canonicalAnalysis,
          readerSnapshot: result.idempotent ? null : input?.readerSnapshot || null,
        });
      }
      const directionHistoryConfirmed = directionHistory.confirmed === true;
      return {
        status: directionHistoryConfirmed ? 'CONFIRMED' : 'FAILED',
        confirmed: directionHistoryConfirmed,
        required,
        reason: directionHistoryConfirmed
          ? result.idempotent ? 'IDEMPOTENT_EXISTING' : 'INSERTED'
          : `DIRECTION_HISTORY_${directionHistory.reason || directionHistory.status || 'UNCONFIRMED'}`,
        snapshotId: record.snapshotId,
        directionHistory,
      };
    }
    return {
      status: 'FAILED',
      confirmed: false,
      required,
      reason: result.reason || 'WRITE_NOT_CONFIRMED',
      snapshotId: record.snapshotId,
      parentSnapshotId: result.parentSnapshotId || record.parentSnapshotId || null,
    };
  } catch (error) {
    console.error('[ANALYSIS_PIT_SNAPSHOT_REQUIRED_WRITE_FAILED]', {
      league: input?.league,
      gamePk: input?.game?.gamePk || input?.frozenContext?.game?.gamePk,
      snapshotId: fallbackSnapshotId,
      error: String(error?.message || error),
    });
    return {
      status: 'FAILED',
      confirmed: false,
      required,
      reason: 'WRITE_FAILED',
      snapshotId: fallbackSnapshotId,
    };
  }
}

export function scheduleAnalysisPitSnapshotPersistence(input, { waitUntilFn = waitUntil } = {}) {
  let snapshotId;
  try {
    snapshotId = cleanText(input?.analysis?.pitSnapshotId, 500) || analysisPitSnapshotId({
      league: input?.league,
      gamePk: input?.game?.gamePk || input?.frozenContext?.game?.gamePk,
      analysisType: input?.analysis?.analysisType || 'FULL',
      inputHash: input?.analysis?.inputHash || input?.repriceSnapshot?.inputHash,
    });
  }
  catch (error) {
    console.error('[ANALYSIS_PIT_SNAPSHOT_BUILD_FAILED]', {
      league: input?.league,
      gamePk: input?.game?.gamePk || input?.frozenContext?.game?.gamePk,
      error: String(error?.message || error),
    });
    return { scheduled: false, reason: 'BUILD_FAILED', snapshotId: null };
  }
  const persistence = (async () => {
    let record;
    try { record = await buildAnalysisPitSnapshotRecordAsync(input); }
    catch (error) {
      console.error('[ANALYSIS_PIT_SNAPSHOT_BUILD_FAILED]', {
        league: input?.league,
        gamePk: input?.game?.gamePk || input?.frozenContext?.game?.gamePk,
        snapshotId,
        error: String(error?.message || error),
      });
      return { stored: false, reason: 'BUILD_FAILED', snapshotId };
    }
    const parentWrite = record.parentSnapshotId ? inflightWrites.get(record.parentSnapshotId) : null;
    if (parentWrite) await parentWrite;
    return persistAnalysisPitSnapshotBestEffort(record);
  })();
  inflightWrites.set(snapshotId, persistence);
  persistence.finally(() => {
    if (inflightWrites.get(snapshotId) === persistence) inflightWrites.delete(snapshotId);
  });
  try { waitUntilFn(persistence); }
  catch (error) {
    console.error('[ANALYSIS_PIT_SNAPSHOT_WAIT_UNTIL_FAILED]', { snapshotId, error: String(error?.message || error) });
  }
  return { scheduled: true, snapshotId };
}
