export const PIT_DEGRADED_SHADOW_REASON = 'PIT永久保存未確認；只顯示唯讀影子診斷，禁止排名與下注';

function degradeResult(row, pitPersistence) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const reason = String(pitPersistence?.reason || 'PIT_WRITE_UNCONFIRMED');
  return {
    ...row,
    executable: false,
    betEligible: false,
    formalEligible: false,
    rankingQualified: false,
    rankingQualificationReason: `${PIT_DEGRADED_SHADOW_REASON}（${reason}）`,
    pitEvidenceEligible: false,
    // Reader freshness and PIT durability are independent proofs. A failed
    // database write must disable ranking/betting without falsely relabelling
    // a live Reader quote as stale or unverified.
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
        portfolio: [],
        rankingEnabled: false,
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
