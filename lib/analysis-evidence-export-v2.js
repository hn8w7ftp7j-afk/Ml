// Client-safe, read-only export. No fetching, normalization, scoring or clock reads.
export const ANALYSIS_EVIDENCE_EXPORT_VERSION = 'analysis-evidence-export-v2';
export function evidenceJSON(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'number' && !Number.isFinite(item)
    ? { value: null, evidenceError: 'NON_FINITE_NUMBER', suppliedValue: String(item) } : item, 2);
}
export function settlementEvidence(analysis = {}) {
  const fields = ['fullWinProbability', 'partialWinProbability', 'pushProbability', 'partialLossProbability', 'fullLossProbability', 'mixedNeutralProbability', 'exactLineProbability'];
  return {
    schemaVersion: ANALYSIS_EVIDENCE_EXPORT_VERSION,
    scope: 'SAVED_RESULT_FIELDS_NOT_INDEPENDENT_REPLAY',
    probabilityUnit: 'PROPORTION', evUnit: 'PROFIT_PER_UNIT_STAKE',
    calculationSettings: analysis.calculationSettings ?? null,
    directions: (analysis.results || []).map(row => ({
      market: row.market ?? null, pick: row.pick ?? null, water: row.water ?? null,
      modelEventProbabilities: Object.fromEntries(fields.map(key => [key, row[key] ?? null])),
      equivalentSettlementShares: { win: row.equivalentWinProbability ?? null, loss: row.equivalentLossProbability ?? null, push: row.equivalentPushProbability ?? null },
      settlementIdentityAudit: row.settlementIdentityAudit ?? null,
      settlementEvents: row.settlementEvents ?? null,
      settlementEvidenceVersion: row.settlementEvidenceVersion ?? null,
      robustEvidence: row.robustEvidence ?? null,
      modelEV: row.modelEV ?? null, robustEV: row.robustEV ?? null,
      note: '等效結算份額不是事件機率；缺少分盤逐腿證據時，不從顯示盤名推造。未捨入、未正規化；非有限值標為錯誤，不代表 QA 通過。',
    })),
  };
}
