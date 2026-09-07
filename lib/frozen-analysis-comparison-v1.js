import { validateAnalysisPitSnapshotRecord, decodeAnalysisPitPayload } from './analysis-pit-snapshot-store-v1.js';
import { stableStringify } from './snapshot-v9.js';

// Compare stored outputs only. Never fetch today's data or execute an unavailable
// old model, and never turn a two-record comparison into a backtest claim.
export function compareFrozenAnalyses(before, after) {
  const unavailable = [];
  const read = (record, label) => {
    try {
      validateAnalysisPitSnapshotRecord(record);
      return { record, context: decodeAnalysisPitPayload(record.frozenContextPayload), analysis: decodeAnalysisPitPayload(record.marketAnalysisPayload) };
    } catch (error) { unavailable.push({ side: label, reason: String(error.message) }); return null; }
  };
  const left = read(before, 'before'), right = read(after, 'after');
  const base = { version: 'FROZEN-ANALYSIS-COMPARISON-v1', diagnosticOnly: true, historicalValidationPassed: false, fetchedCurrentData: false, recomputedHistoricalModel: false, unavailable };
  if (!left || !right) return { ...base, status: 'UNRECONSTRUCTABLE_MISSING_OR_INVALID_SNAPSHOT' };
  if (before.leagueId !== after.leagueId || stableStringify(before.gameIdentity) !== stableStringify(after.gameIdentity)) return { ...base, status: 'GAME_IDENTITY_MISMATCH' };
  const sameFrozenContext = stableStringify(left.context) === stableStringify(right.context);
  const sameMarket = stableStringify(left.analysis.suppliedMarkets) === stableStringify(right.analysis.suppliedMarkets);
  const versions = { before: before.versions, after: after.versions };
  const changes = [];
  for (const period of ['full', 'first5']) for (const side of ['away', 'home', 'total']) {
    const a = left.analysis.expectedRuns?.[period]?.[side], b = right.analysis.expectedRuns?.[period]?.[side];
    if (typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b)) changes.push({ field: `${period}.${side}`, before: a, after: b, delta: b - a });
  }
  const receipt = record => ({ analysisAsOf: record.analysisAsOf, dataAsOf: record.dataAsOf,
    lineAsOf: record.lineAsOf, gameStart: record.gameStart, evidenceStatus: record.evidenceStatus,
    quarantineStatus: record.quarantineStatus, calibrationEligibility: record.calibrationEligibility });
  const changedContextSections = [...new Set([...Object.keys(left.context || {}), ...Object.keys(right.context || {})])]
    .filter(key => stableStringify(left.context?.[key]) !== stableStringify(right.context?.[key]));
  return { ...base, status: sameFrozenContext && sameMarket ? 'SAME_SAVED_INPUTS_OUTPUT_COMPARISON' : 'INPUTS_DIFFER_NOT_CONTROLLED_COMPARISON',
    sameFrozenContext, sameMarket, versions, snapshotIds: [before.snapshotId, after.snapshotId], changes,
    receipts: { before: receipt(before), after: receipt(after) }, changedContextSections,
    chronologicalOrder: Date.parse(before.analysisAsOf) <= Date.parse(after.analysisAsOf),
    limitation: '僅比較原始保存輸出；不證明歷史來源可重建、勝率提升或版本差异造成盈虧。' };
}
