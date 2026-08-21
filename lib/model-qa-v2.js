export const MODEL_QA_V2_VERSION = 'BASEBALL-MODEL-QA-DIAGNOSTIC-v2.0.0';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const unique = values => [...new Set(values.filter(Boolean))];

function issue(code, level, message, evidence = {}) {
  return { code, level, message, evidence };
}

export function auditModelDirection(row = {}) {
  const issues = [];
  const w = finite(row.weightedEV);
  const r = finite(row.robustEV);
  const probability = finite(row.modelProbability);
  const marketProbability = finite(row.marketAnchorProbability);
  const spread = finite(row.evCalibration?.rawScenarioSpread);
  const coverage = finite(row.distributionCoverage);
  const settlementCoverage = finite(row.settlementIdentityAudit?.equivalentCoverage ?? row.equivalentSettlementCoverage);

  if (w == null || r == null) issues.push(issue('EV_NOT_FINITE', 'ERROR', 'W/R無法建立有限數值', { weightedEV: row.weightedEV, robustEV: row.robustEV }));
  if (w != null && r != null && r > w + 1e-12) issues.push(issue('ROBUST_ABOVE_WEIGHTED', 'ERROR', 'R高於W，違反保守下界關係', { weightedEV: w, robustEV: r }));
  if (coverage != null && Math.abs(coverage - 1) > 1e-6) issues.push(issue('DISTRIBUTION_COVERAGE', 'ERROR', '比分分布覆蓋率偏離1', { coverage }));
  if (settlementCoverage != null && Math.abs(settlementCoverage - 1) > 1e-6) issues.push(issue('SETTLEMENT_COVERAGE', 'ERROR', '逐腿結算機率覆蓋率偏離1', { settlementCoverage }));

  // The following are diagnostics only. They deliberately do not mutate W/R/S,
  // do not cap scores, and do not decide shadow-ranking eligibility.
  if (spread != null && spread > 0.05) issues.push(issue('SCENARIO_SPREAD_WIDE', 'WARN', 'W/R情境差距偏大，應追查不確定性來源', { spread }));
  if (w != null && Math.abs(w) >= 0.15) issues.push(issue('EV_EXTREME', 'WARN', 'W絕對值達15%以上，應複核上游資料與比分分布', { weightedEV: w }));
  if (probability != null && marketProbability != null && Math.abs(probability - marketProbability) > 0.10) {
    issues.push(issue('MODEL_MARKET_DIVERGENCE', 'WARN', '模型條件勝率與Tai888去水診斷差距偏大，應追查模型輸入', {
      modelProbability: probability,
      marketProbability,
      gap: Math.abs(probability - marketProbability),
    }));
  }
  if (row.integrityWarning === true) issues.push(issue('UPSTREAM_INTEGRITY_WARNING', 'ERROR', row.integrityMessage || '上游資料或數值完整性警告'));
  if (row.numericalQA?.passed === false) issues.push(issue('NUMERICAL_QA', 'ERROR', '數值穩定性檢查未通過'));
  if (row.pairAudit?.passed === false) issues.push(issue('PAIR_MIRROR_QA', 'ERROR', '正反方向鏡像／互補檢查未通過', { failures: row.pairAudit?.failures || [] }));

  const errors = issues.filter(item => item.level === 'ERROR');
  const warnings = issues.filter(item => item.level === 'WARN');
  return {
    version: MODEL_QA_V2_VERSION,
    status: errors.length ? 'ERROR' : warnings.length ? 'WARN' : 'PASS',
    errors,
    warnings,
    issues,
    diagnosticOnly: true,
    mutatesModel: false,
    mutatesEV: false,
    mutatesScore: false,
    mutatesRanking: false,
  };
}

export function auditModelGame(rows = []) {
  const directions = (rows || []).map(row => ({ market: row.market, pick: row.pick, audit: auditModelDirection(row) }));
  const issues = directions.flatMap(item => item.audit.issues.map(entry => ({ ...entry, market: item.market, pick: item.pick })));
  const codes = unique(issues.map(item => item.code));
  return {
    version: MODEL_QA_V2_VERSION,
    status: issues.some(item => item.level === 'ERROR') ? 'ERROR' : issues.some(item => item.level === 'WARN') ? 'WARN' : 'PASS',
    directions,
    issueCodes: codes,
    issueCount: issues.length,
    diagnosticOnly: true,
  };
}
