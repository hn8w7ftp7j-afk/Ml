export const PERFORMANCE_EVIDENCE_VERSION = 'PERFORMANCE-SAVED-CORE-EVIDENCE-v1';
export const QUALITY_GROUPS = Object.freeze({
  OBSERVED: '核心資料均為實際取得', PROJECTED: '含預測或替代', MISSING: '含缺失', STALE: '含舊資料', UNKNOWN: '未保存品質證據',
});
const states = ['observed', 'projected', 'missing', 'stale'];
const coreIds = new Set(['away', 'home'].flatMap(side => ['starter', 'lineup', 'bullpen', 'splits', 'injuries'].map(category => `${side}.${category}`)));

export function qualityReceiptFromAudit(audit) {
  if (audit?.coverageScope !== 'CORE_PERSONNEL' || !Array.isArray(audit.rows) || audit.rows.length !== 10
    || new Set(audit.rows.map(row => row.id)).size !== 10 || audit.rows.some(row => !coreIds.has(row.id) || !states.includes(row.status))) return null;
  return { version: PERFORMANCE_EVIDENCE_VERSION, scope: 'CORE_PERSONNEL', sourceAuditVersion: audit.schemaVersion || null,
    rows: audit.rows.map(row => ({ id: row.id, status: row.status })) };
}

export function qualityGroupForBet(bet) {
  const receipt = bet?.dataQualityReceipt;
  if (receipt?.version !== PERFORMANCE_EVIDENCE_VERSION || receipt.scope !== 'CORE_PERSONNEL'
    || !Array.isArray(receipt.rows) || receipt.rows.length !== 10 || new Set(receipt.rows.map(row => row.id)).size !== 10
    || receipt.rows.some(row => !coreIds.has(row.id) || !states.includes(row.status))) return 'UNKNOWN';
  return ['stale', 'missing', 'projected'].find(state => receipt.rows.some(row => row.status === state))?.toUpperCase() || 'OBSERVED';
}

export function savedVersionForBet(bet, field = 'modelVersion') {
  const value = bet?.[field];
  return typeof value === 'string' && value.trim() ? value.trim() : 'UNKNOWN';
}
