export const PIT_DEGRADED_SHADOW_REASON = 'PIT永久保存未確認；模型分析與排名保留，實際下注紀錄暫停';

function degradeResult(row, pitPersistence) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const reason = String(pitPersistence?.reason || 'PIT_WRITE_UNCONFIRMED');
  return {
    ...row,
    executable: false,
    betEligible: false,
    formalEligible: false,
    pitPersistenceWarning: `${PIT_DEGRADED_SHADOW_REASON}（${reason}）`,
    pitEvidenceEligible: false,
    // Reader freshness and PIT durability are independent proofs. A failed
    // database write must disable durable bet recording without relabelling a
    // live Reader quote as stale or changing its model score/ranking status.
    pitPersistenceEligible: false,
    pitPersistenceReason: `PIT_UNCONFIRMED:${reason}`,
  };
}

export function enforceUnconfirmedPitShadowSafety(payload, pitPersistence) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (pitPersistence?.confirmed === true) return { ...payload, pitPersistence };
  const analysis = payload.analysis && typeof payload.analysis === 'object'
    ? {
        ...payload.analysis,
        results: (Array.isArray(payload.analysis.results) ? payload.analysis.results : []).map(row => degradeResult(row, pitPersistence)),
        directionSlots: (Array.isArray(payload.analysis.directionSlots) ? payload.analysis.directionSlots : []).map(row => degradeResult(row, pitPersistence)),
        portfolio: [],
        pitEvidenceEligible: false,
      }
    : payload.analysis;
  return {
    ...payload,
    analysis,
    pitPersistence,
    pitDegraded: true,
    executable: false,
    betEligible: false,
    warnings: [...new Set([
      ...(Array.isArray(payload.warnings) ? payload.warnings : []),
      PIT_DEGRADED_SHADOW_REASON,
    ])],
  };
}
