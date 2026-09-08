import { buildDistributionSnapshot, evaluateMarketsFromDistribution } from './analysis-v11.js';
import { auditAsianSourceEvidence } from './asian-source-evidence-v1.js';
import { replayEnvironmentSummary } from './replay-environment-evidence.js';

// Called only after the store verifies envelope hashes, identities and parent chain.
// Replays never fetch providers or write to original snapshots or betting ledgers.
export function auditSavedAsianPit(bundle) {
  const context = structuredClone(bundle.frozenContext);
  const saved = bundle.marketAnalysis;
  const settingsRecorded = typeof saved.calculationSettings?.rebateRate === 'number'
    && saved.calculationSettings.rebateRate >= 0 && saved.calculationSettings.rebateRate <= 0.1;
  const report = {
    replayEnvironment: replayEnvironmentSummary(saved.replayEnvironment),
    verificationLayers: { saved: 'CONFIRMED', integrity: 'PASS', distributionReplay: 'PENDING', evReplay: 'PENDING', scoreReplay: 'NOT_EXECUTED',
      sourceAudit: 'SEE_POINT_IN_TIME_VALIDITY', modelVersionAcceptance: saved.replayEnvironment?.modelValidation || { status: 'HISTORICAL_EVIDENCE_NOT_RECORDED', scope: 'MODEL_VERSION_COHORT_NOT_SINGLE_GAME' } },
    snapshotId: bundle.snapshotId, gameIdentity: bundle.gameIdentity,
    originalSnapshotModified: false, fetchedCurrentData: false,
    snapshotIntegrity: 'CONFIRMED',
    integrityScope: 'STORE_ENVELOPE_HASH_IDENTITY_AND_PARENT_CHAIN',
    snapshotSavedAt: bundle.databasePersistedAt || null,
    predictionAt: bundle.analysisAsOf || null,
    pointInTimeValidity: auditAsianSourceEvidence(context),
    sourceStorage: {
      mode: context.sourceEvidence?.contentStorage || 'INLINE_OR_LEGACY',
      writeReadback: context.sourceEvidence?.storageReadback || 'NOT_RECORDED',
      referencedContents: context.sourceEvidence?.contentHashes?.length || 0,
      loadedContents: Object.keys(context.sourceEvidence?.contents || {}).length,
      acquisitionEvents: context.sourceEvidence?.events?.length || 0,
    },
    predictiveAccuracyValidated: false, calibrationStatus: 'UNVALIDATED_SHADOW',
    originalEngineReplay: 'UNAVAILABLE_NO_ARCHIVED_ASIAN_ENGINE',
    settingsRecorded, replayRebateRate: settingsRecorded ? saved.calculationSettings.rebateRate : null,
    limitations: ['重播一致不代表輸入正確或預測已校準。',
      '目前引擎重算僅為相容性比較，沒有冒充保存當時的原始程式版本。'],
  };
  let rebuilt;
  try { rebuilt = buildDistributionSnapshot({ context }); }
  catch { return { ...report, status: 'CURRENT_ENGINE_INCOMPATIBLE' }; }
  report.currentEngineDistributionMatches = rebuilt.distributionHash === bundle.distributionHash;
  report.verificationLayers.distributionReplay = report.currentEngineDistributionMatches ? 'CURRENT_ENGINE_MATCH' : 'CURRENT_ENGINE_MISMATCH';
  report.currentEngineDistributionHash = rebuilt.distributionHash;
  if (!settingsRecorded) return { ...report, status: 'SAVED_CALCULATION_SETTINGS_MISSING', matrixReplay: 'PENDING' };
  try {
    const replay = evaluateMarketsFromDistribution({ context,
      markets: structuredClone(saved.suppliedMarkets), previousMarkets: structuredClone(saved.previousMarkets || []),
      settings: { rebateRate: report.replayRebateRate }, distributionSnapshot: structuredClone(bundle.distributionSnapshot) });
    const rows = (saved.results || []).map(row => {
      const matches = replay.results.filter(other => other.market === row.market && other.pick === row.pick && other.water === row.water);
      const other = matches.length === 1 ? matches[0] : null;
      const delta = key => Number.isFinite(row[key]) && Number.isFinite(other?.[key]) ? other[key] - row[key] : null;
      return { market: row.market, pick: row.pick, water: row.water,
        deltaW: delta('weightedEV'), deltaR: delta('robustEV') };
    });
    const matched = rows.length > 0 && rows.every(row => row.deltaW !== null && row.deltaR !== null
      && Math.abs(row.deltaW) <= 1e-9 && Math.abs(row.deltaR) <= 1e-9);
    report.verificationLayers.evReplay = matched ? 'CURRENT_ENGINE_MATCH' : 'MISMATCH_OR_MISSING';
    return { ...report, status: 'SAVED_MATRIX_RECALCULATED', matrixReplay: matched ? 'MATCH' : 'MISMATCH', rows };
  } catch { return { ...report, status: 'SAVED_MATRIX_ENGINE_INCOMPATIBLE', matrixReplay: 'PENDING' }; }
}
