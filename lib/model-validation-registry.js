// Server-owned registry. Entries require a version/cohort-specific reviewed report;
// empty is intentional, never infer acceptance from a snapshot's arithmetic QA.
export const MODEL_VALIDATION_REGISTRY_VERSION = 'MODEL-COHORT-ACCEPTANCE-v1';
export const MODEL_VALIDATION_REPORTS = Object.freeze([]);
export function modelValidationLink(league, modelVersion) {
  const report = MODEL_VALIDATION_REPORTS.find(row => row.league === league && row.modelVersion === modelVersion);
  return { registryVersion: MODEL_VALIDATION_REGISTRY_VERSION, scope: 'MODEL_VERSION_COHORT_NOT_SINGLE_GAME',
    league, modelVersion, status: report?.status || 'NOT_REGISTERED', report: report || null,
    url: `/api/model-validation?league=${encodeURIComponent(league)}&modelVersion=${encodeURIComponent(modelVersion || '')}`,
    note: '尚無登錄報告不等於沒有進行過研究；不代表已通過歷史成效驗收。' };
}
