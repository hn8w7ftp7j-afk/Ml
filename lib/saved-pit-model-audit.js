import { buildDistributionSnapshot, evaluateMarketsFromDistribution } from './analysis-v11.js';
import { validateProductionPitSnapshotV109 } from './mlb-production-pit-replay-v109.js';

// Receives an integrity-checked bundle from loadAnalysisPitReplay. No providers,
// ledger writes, live inputs, or changes to the original prediction are allowed.
export function auditSavedPitModel(bundle) {
  const context = structuredClone(bundle.frozenContext);
  const saved = bundle.marketAnalysis;
  const markets = structuredClone(saved.suppliedMarkets);
  const validation = validateProductionPitSnapshotV109({
    context, markets, versions: bundle.versions, snapshotAsOf: bundle.analysisAsOf,
  });
  const report = {
    snapshotId: bundle.snapshotId, gameIdentity: bundle.gameIdentity,
    inputHash: bundle.inputHash, analysisAsOf: bundle.analysisAsOf, dataAsOf: bundle.dataAsOf,
    originalSnapshotModified: false, fetchedCurrentData: false,
    predictiveAccuracyValidated: false, snapshotIntegrity: 'PASS',
    pregameEvidence: validation, dataQualityReceipt: saved.dataQualityReceipt,
    savedExpectedRuns: saved.expectedRuns, parentChain: bundle.parentChain,
    calibrationEligibility: bundle.calibrationEligibility,
    limitations: ['重播一致不代表勝率已校準或資料內容正確。',
      'EV比較明示使用現行1.5%退水；原快照未獨立保存settings，不能據此宣稱完整設定精確重播。'],
  };
  if (!validation.compatibility.compatible) return { ...report, status: 'ORIGINAL_ENGINE_UNAVAILABLE' };
  // Evidence eligibility and deterministic reproduction are separate results.
  // A failed provenance check must remain visible even when reproduction agrees.
  const rebuilt = buildDistributionSnapshot({ context });
  const replay = evaluateMarketsFromDistribution({ context, markets,
    previousMarkets: structuredClone(saved.previousMarkets || []),
    settings: { rebateRate: 0.015 }, distributionSnapshot: rebuilt });
  const rows = (saved.results || []).map(row => {
    const matches = replay.results.filter(r => r.market === row.market && r.pick === row.pick && r.water === row.water);
    const other = matches.length === 1 ? matches[0] : null;
    const delta = key => Number.isFinite(row[key]) && Number.isFinite(other?.[key]) ? other[key] - row[key] : null;
    return { market: row.market, pick: row.pick, water: row.water,
      savedW: row.weightedEV, savedR: row.robustEV,
      replayW: other?.weightedEV ?? null, replayR: other?.robustEV ?? null,
      deltaW: delta('weightedEV'), deltaR: delta('robustEV'),
      savedGap: row.evCalibration?.rawScenarioSpread ?? null,
      robustVariants: row.robustVariants, worstVariant: row.worstVariant,
      modelErrorMarginEV: saved.dataGateV10?.modelErrorMarginEV ?? null,
      numericalQA: other?.numericalQA ?? null };
  });
  const distributionMatches = rebuilt.distributionHash === bundle.distributionHash;
  return { ...report, status: distributionMatches ? 'DISTRIBUTION_REPRODUCED' : 'DISTRIBUTION_MISMATCH',
    distributionMatches, savedDistributionHash: bundle.distributionHash,
    rebuiltDistributionHash: rebuilt.distributionHash, replayExpectedRuns: replay.expectedRuns,
    replayRebateRate: 0.015, rows,
    evMatchesUnderStatedSettings: rows.length > 0 && rows.every(r =>
      r.deltaW !== null && r.deltaR !== null && Math.abs(r.deltaW) <= 1e-9 && Math.abs(r.deltaR) <= 1e-9) };
}
