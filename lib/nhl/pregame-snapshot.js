import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { nhlContentHash, summarizeNhlDistribution } from './distribution.js';
import { auditNhlDistribution, nhlTimestamp } from './model-qa.js';
import { validateNhlIdentity, nhlDate } from './identity.js';
import { NHL_MODEL_VERSION } from './model.js';

export const NHL_PREGAME_ANALYSIS_VERSION = 'NHL-PREGAME-SHADOW-v1';
const bytesHash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code, status: 422 }); };
// PostgreSQL JSONB does not retain object insertion order. Arrays and numerical
// values remain exact; canonical keys make durable hashes independent of that
// storage representation.
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const structuralHash = value => nhlContentHash(canonical(value));

// Preserve every numerical path. Repetitive chronological training ID lists
// are represented by their hash; the fitted artifact ID still identifies the
// unchanged full artifact. This is storage compaction, not model calibration.
export function archiveNhlPregameDistribution(input) {
  if (!auditNhlDistribution(input).passed) fail('NHL_ANALYSIS_DISTRIBUTION_INVALID');
  const distribution = structuredClone(input);
  const evidence = distribution.calibrationEvidence;
  if (Array.isArray(evidence?.foldEvidence)) {
    evidence.foldEvidenceHash = nhlContentHash(evidence.foldEvidence);
    evidence.foldEvidenceCount = evidence.foldEvidence.length;
    delete evidence.foldEvidence;
  }
  const { distributionHash, distributionId, qa, ...content } = distribution;
  distribution.distributionHash = nhlContentHash(content);
  distribution.distributionId = `nhl-${distribution.distributionHash.slice(0, 24)}`;
  distribution.qa = auditNhlDistribution(distribution);
  if (!distribution.qa.passed) fail('NHL_ANALYSIS_DISTRIBUTION_INVALID');
  const raw = Buffer.from(JSON.stringify(distribution));
  const compressed = gzipSync(raw);
  return { distribution, archive: { format: 'NHL-PREGAME-GZIP-JSON-v1',
    contentHash: bytesHash(raw), compressedHash: bytesHash(compressed),
    byteLength: raw.length, data: compressed.toString('base64') } };
}

export function restoreNhlPregameDistribution(archive) {
  if (archive?.format !== 'NHL-PREGAME-GZIP-JSON-v1' || !digest(archive.contentHash)
    || !digest(archive.compressedHash) || !Number.isSafeInteger(archive.byteLength)
    || archive.byteLength <= 0 || archive.byteLength > 32_000_000
    || typeof archive.data !== 'string' || archive.data.length > 12_000_000
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(archive.data)) fail('NHL_ANALYSIS_ARCHIVE_INVALID');
  try {
    const compressed = Buffer.from(archive.data, 'base64');
    if (bytesHash(compressed) !== archive.compressedHash) fail('NHL_ANALYSIS_ARCHIVE_HASH_MISMATCH');
    const raw = gunzipSync(compressed, { maxOutputLength: 32_000_000 });
    if (raw.length !== archive.byteLength || bytesHash(raw) !== archive.contentHash) fail('NHL_ANALYSIS_ARCHIVE_HASH_MISMATCH');
    const distribution = JSON.parse(raw.toString('utf8'));
    if (!auditNhlDistribution(distribution).passed) fail('NHL_ANALYSIS_DISTRIBUTION_INVALID');
    return distribution;
  } catch (error) {
    if (error.code?.startsWith('NHL_')) throw error;
    fail('NHL_ANALYSIS_ARCHIVE_INVALID');
  }
}

export function nhlPregameModelSummary(distribution) {
  const scopes = summarizeNhlDistribution(distribution);
  return { version: distribution.modelVersion, artifactId: distribution.modelArtifactId,
    distributionId: distribution.distributionId, distributionHash: distribution.distributionHash,
    trainingCutoff: distribution.trainingCutoff, expectedGoals: {
      away: scopes.REGULATION.awayGoals, home: scopes.REGULATION.homeGoals,
    }, finalExpectedGoals: { away: scopes.FINAL.awayGoals, home: scopes.FINAL.homeGoals },
    probabilities: { awayWin: scopes.FINAL.awayWinProbability, homeWin: scopes.FINAL.homeWinProbability,
      regulationAwayWin: scopes.REGULATION.awayWinProbability,
      regulationHomeWin: scopes.REGULATION.homeWinProbability, regulationDraw: scopes.REGULATION.tieProbability },
    scopes, features: distribution.features, conditioningFeatures: distribution.conditioningFeatures,
    readyForFormal: false, observedSupportOnly: distribution.observedSupportOnly,
    historicalPointInTimeVerified: distribution.features?.pointInTimeVerified === true,
  };
}

export function nhlPregameSnapshotHash(record) {
  const { snapshotHash, snapshotId, revision, persistence, ...content } = record;
  return structuralHash(content);
}

// Kept separate from the service/store to avoid a circular dependency. A past
// game may replay only a complete, immutable snapshot acquired before puck drop.
export function validateNhlAnalysisObservation(record, key, { now = Date.now() } = {}) {
  const errors = [];
  if (record?.league !== 'NHL' || record?.version !== NHL_PREGAME_ANALYSIS_VERSION
    || record?.mode !== 'PREGAME_SHADOW' || record?.gameId !== key
    || record?.game?.league !== 'NHL' || record.game.gameId !== key
    || !validateNhlIdentity(record?.game).ok || record.taipeiDate !== nhlDate(record.game.startTimeUTC)) errors.push('NHL_ANALYSIS_SNAPSHOT_IDENTITY_INVALID');
  const generated = nhlTimestamp(record?.generatedAt);
  const start = nhlTimestamp(record?.game?.startTimeUTC);
  if (generated == null || start == null || generated >= start || generated > now
    || record.observedAt !== record.generatedAt) errors.push('NHL_ANALYSIS_SNAPSHOT_NOT_PREGAME');
  if (!digest(record?.snapshotHash) || record.snapshotHash !== nhlPregameSnapshotHash(record)
    || record.snapshotId !== `nhl-pregame-${record.snapshotHash.slice(0, 24)}`) errors.push('NHL_ANALYSIS_SNAPSHOT_HASH_MISMATCH');
  if (record?.readiness?.formalRecommendations !== false || record?.readiness?.realBetExecutionEnabled !== false)
    errors.push('NHL_ANALYSIS_EXECUTION_NOT_VERIFIED');
  if (!Array.isArray(record?.sources) || !record.sources.length || record.sources.some(source => {
    const acquired = nhlTimestamp(source?.fetchedAt ?? source?.observedAt);
    const available = nhlTimestamp(source?.availableAt ?? source?.sourceUpdatedAt ?? source?.sourcePublishedAt ?? source?.fetchedAt ?? source?.observedAt);
    return acquired == null || available == null || acquired > generated || available > generated
      || !digest(source?.contentHash) || !['NHL', 'NHL_EDITORIAL'].includes(source?.provider)
      || !/^https:\/\/(?:api-web\.nhle\.com|api\.nhle\.com|www\.nhl\.com)\//.test(source?.url || '');
  })) errors.push('NHL_ANALYSIS_SOURCE_TIME_INVALID');
  try {
    const distribution = restoreNhlPregameDistribution(record?.distributionArchive);
    if (distribution.modelVersion !== NHL_MODEL_VERSION || distribution.asOf !== record.generatedAt
      || !validateNhlIdentity(record.game, distribution.game).ok
      || structuralHash(record.model) !== structuralHash(nhlPregameModelSummary(distribution))) errors.push('NHL_ANALYSIS_SNAPSHOT_MODEL_CONFLICT');
  } catch (error) { errors.push(error.code || 'NHL_ANALYSIS_ARCHIVE_INVALID'); }
  return { ok: !errors.length, errors: [...new Set(errors)] };
}
