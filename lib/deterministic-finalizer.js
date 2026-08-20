import { hasActualWater, parseTaiwanLine } from './markets.js';
import { mirrorSettlementAudit, SETTLEMENT_RULE_VERSION } from './taiwan-settlement-v9.js';
import {
  SCORE_FORMULA_VERSION,
  SCORE_POLICY_VERSION,
  deterministicScore,
  scoreBoundaryAudit,
} from './deterministic-score.js';

export const FINAL_ENGINE_VERSION = 'MLB-DETERMINISTIC-EXECUTION-2026-08-v9.7.0';
export const UNCERTAINTY_SET_VERSION = 'MLB-SEVEN-PRECOMMITTED-STRESS-SETS-v1';
export const FORMAL_SCORING_ENABLED = false;
export const SCORE_RELEASE_STATUS = 'LEGACY_INVALID';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clean = value => String(value || '').trim();
const unique = values => [...new Set((values || []).filter(Boolean))];

function resultKey(row) {
  return `${row?.market || ''}|||${row?.pick || ''}`;
}

function baseQa(row) {
  const failures = [];
  if (!parseTaiwanLine(row.pick)?.valid) failures.push('盤口合約無法解析');
  if (finite(row.distributionCoverage, 0) < 0.999) failures.push('比分分布機率覆蓋未達100%');
  if (!Number.isFinite(Number(row.weightedEV))) failures.push('加權EV不是有限數值');
  if (!Number.isFinite(Number(row.robustEV))) failures.push('穩健EV不是有限數值');
  if (Number.isFinite(Number(row.weightedEV)) && Number.isFinite(Number(row.robustEV))
    && Number(row.robustEV) > Number(row.weightedEV) + 0.0000000001) failures.push('穩健EV高於加權EV');
  if (row.integrityWarning) failures.push(clean(row.integrityMessage) || '底層模型完整性警告');
  if (row.evDoubleCheck?.passed !== true) failures.push('EV逐比分與結果桶雙算未通過');
  return { passed: failures.length === 0, failures };
}

function representativeScorePairs(row) {
  const parsed = parseTaiwanLine(row.pick);
  if (!parsed.valid) return [];
  const maximum = parsed.isTotal
    ? Math.max(15, Math.ceil(Math.max(...parsed.legs, 8) + 5))
    : Math.max(10, Math.ceil(Math.max(...parsed.legs, 1) + 5));
  const rows = [];
  for (let away = 0; away <= maximum; away += 1) {
    for (let home = 0; home <= maximum; home += 1) rows.push([away, home]);
  }
  return rows;
}

function pairQa(pair, game) {
  const failures = [];
  if (pair.length !== 2) return { passed: true, failures, complementError: null, mirrorChecked: false };
  const [left, right] = pair;
  const leftProbability = left.modelProbability;
  const rightProbability = right.modelProbability;
  const complementError = leftProbability != null && rightProbability != null
    && Number.isFinite(Number(leftProbability)) && Number.isFinite(Number(rightProbability))
    ? Math.abs(Number(leftProbability) + Number(rightProbability) - 1)
    : null;
  if (complementError != null && complementError > 0.012) failures.push('同市場正反方向機率未互補');

  let mirrorChecked = false;
  for (const [awayRuns, homeRuns] of representativeScorePairs(left)) {
    const audit = mirrorSettlementAudit(left.pick, right.pick, awayRuns, homeRuns, game?.away, game?.home);
    mirrorChecked = true;
    if (!audit.ok) {
      failures.push(`正反方向結算不鏡像：${awayRuns}-${homeRuns}`);
      break;
    }
  }
  return { passed: failures.length === 0, failures, complementError, mirrorChecked };
}

function thirdAudit(row, scoreResult, qaPassed) {
  const reasons = [];
  if (finite(row.weightedEV, 0) >= 0.05) reasons.push('加權EV≥5%');
  if (Number(scoreResult.score || 0) >= 8.5) reasons.push('評分≥8.5');
  if (row.specialMarket) reasons.push('特殊盤');
  if (row.arbitrageClaim) reasons.push('套利／鎖價聲稱');
  if (scoreResult.highScoreAnomaly) reasons.push('內部Raw Score達9.0');
  const required = reasons.length > 0;
  const checks = {
    contract: parseTaiwanLine(row.pick)?.valid === true,
    probabilityCoverage: finite(row.distributionCoverage, 0) >= 0.999,
    robustNotAboveWeighted: finite(row.robustEV, 0) <= finite(row.weightedEV, 0) + 0.0000000001,
    baseQa: qaPassed,
    marketVerification: Number(scoreResult.score || 0) < 8.5 || row.marketVerification?.verified === true,
    highScoreManualConfirmation: !scoreResult.highScoreAnomaly || row.highScoreManualConfirmed === true,
    evDoubleCheck: row.evDoubleCheck?.passed !== false,
    modelMarketAgreement: finite(row.rawMarketProbabilityGap, 0) < 0.18,
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    required,
    reasons,
    passed: !required || failures.length === 0,
    checks,
    failures,
    manualConfirmationRequired: scoreResult.highScoreAnomaly,
  };
}

export function finalizeDeterministicAnalysis({ analysis, game, settings = {} }) {
  const candidateThreshold = Number(settings.candidateThreshold || 7.2);
  const failures = [];
  const corrections = [];
  const results = (analysis?.results || []).map(source => {
    const row = { ...source };
    if (row.water == null || !hasActualWater(row.water) || row.weightedEV == null || row.robustEV == null) {
      row.legacyDiagnosticScore = row.score ?? null;
      row.shadowDiagnosticScore = null;
      row.score = null;
      row.scoreStatus = 'UNSCORED';
      row.scoreSource = '固定雙EV短板公式｜Shadow診斷';
      row.scoreFormulaVersion = SCORE_FORMULA_VERSION;
      row.scoreContractVersion = SCORE_FORMULA_VERSION;
      row.scoreType = 'SHADOW_DIAGNOSTIC';
      row.tag = '水位未提供｜不評分';
      row.betEligible = false;
      row.unitSuggestion = null;
      row.scoreAudit = { ok: true, skipped: true, reason: '水位未提供', formulaVersion: SCORE_FORMULA_VERSION };
      row.evFlipProbability = null;
      row.evFlipStatus = '無法可靠估計';
      return row;
    }

    const qa = baseQa(row);
    const actualWater = !row.waterEstimated && row.sourceType === 'ACTUAL_TW_CREDIT';
    const executable = row.executable === true;
    const crossMarketVerified = row.marketVerification?.verified === true;
    const scoreResult = deterministicScore({
      weightedEV: row.weightedEV,
      robustEV: row.robustEV,
      qaPassed: qa.passed,
      actualWater,
      executable,
      crossMarketVerified,
      rawMarketProbabilityGap: row.rawMarketProbabilityGap,
    });
    const boundary = scoreBoundaryAudit(scoreResult, {
      weightedEV: row.weightedEV,
      robustEV: row.robustEV,
      crossMarketVerified,
      rawMarketProbabilityGap: row.rawMarketProbabilityGap,
    });
    const diagnosticScore = qa.passed && boundary.ok ? scoreResult.score : null;
    const third = thirdAudit(row, scoreResult, qa.passed && boundary.ok);
    const excessiveModelMarketGap = finite(row.rawMarketProbabilityGap, 0) >= 0.18;

    row.legacyDiagnosticScore = row.score ?? null;
    row.shadowDiagnosticScore = diagnosticScore;
    row.score = null;
    row.scoreStatus = SCORE_RELEASE_STATUS;
    row.scoreSource = '固定雙EV短板公式｜Shadow診斷';
    row.scoreFormulaVersion = SCORE_FORMULA_VERSION;
    row.scoreContractVersion = SCORE_FORMULA_VERSION;
    row.scorePolicyVersion = SCORE_POLICY_VERSION;
    row.settlementRuleVersion = SETTLEMENT_RULE_VERSION;
    row.uncertaintySetVersion = UNCERTAINTY_SET_VERSION;
    row.scoreType = 'SHADOW_DIAGNOSTIC';
    row.scoreBreakdown = {
      formulaVersion: SCORE_FORMULA_VERSION,
      policyVersion: SCORE_POLICY_VERSION,
      weightedEV: row.weightedEV,
      robustEV: row.robustEV,
      band: scoreResult.band,
      rawScore: scoreResult.rawScore,
      diagnosticScore,
      finalScore: null,
      progress: scoreResult.progress,
      caps: scoreResult.caps,
      noGptScoring: true,
      qaOnlyAsGateOrBlock: true,
      formalScoringEnabled: FORMAL_SCORING_ENABLED,
      scoreReleaseStatus: SCORE_RELEASE_STATUS,
    };
    row.scoreAudit = {
      ok: qa.passed && boundary.ok,
      formulaVersion: SCORE_FORMULA_VERSION,
      baseQa: qa,
      boundary,
      corrections: [],
      noGptScoring: true,
      formalScoringEnabled: FORMAL_SCORING_ENABLED,
    };
    row.thirdAudit = third;
    row.betEligible = false;
    row.unitSuggestion = null;
    row.unitStatus = 'Shadow Mode｜Unit停用';
    row.tag = !qa.passed || !boundary.ok
      ? '⛔ QA未通過｜不評分｜不下注'
      : excessiveModelMarketGap
        ? 'SHADOW｜模型與市場差距過大｜正式分數停用'
        : !third.passed
          ? 'SHADOW｜第三次驗算未完成｜正式分數停用'
          : 'SHADOW｜v9.4.4資料鏈作廢｜正式分數停用｜可記錄實際下注';
    row.evFlipProbability = null;
    row.evFlipStatus = '無法可靠估計｜目前情境集合不視為獨立機率抽樣母體';
    row.modelErrorStatus = '待歷史Out-of-sample回測校準';
    row.riskMetricOverlapAudit = {
      robustEV: '診斷用；正式定義待歷史覆蓋率驗證',
      conservativeEV: '診斷用，不再次加扣分',
      evFlipProbability: '暫不作評分或封頂',
      sensitivity: '診斷主要翻轉因子，不加減分',
      dataQuality: '只決定QA PASS/BLOCK，不直接加減分',
      marketVerification: '只作正式資格，不改寫雙EV分數',
    };

    if (!qa.passed || !boundary.ok) failures.push(`${row.market}｜${row.pick}：${[...qa.failures, ...boundary.errors].join('；')}`);
    if (scoreResult.caps.includes('TWO_INDEPENDENT_MARKETS_NOT_VERIFIED')) {
      corrections.push(`${row.market}｜${row.pick}：未完成兩個真實獨立相同合約市場驗證，診斷分數最高8.4`);
    }
    return row;
  });

  for (const market of [...new Set(results.map(row => row.market))]) {
    const pair = results.filter(row => row.market === market && row.pick);
    if (pair.length !== 2) continue;
    const audit = pairQa(pair, game);
    const bothHigh = pair.filter(row => Number(row.shadowDiagnosticScore) >= candidateThreshold).length > 1;
    if (bothHigh) audit.failures.push('同一市場正反方向同時達7.2，必須整批重算');
    audit.passed = audit.failures.length === 0;
    for (const row of pair) {
      row.pairAudit = audit;
      if (!audit.passed) {
        row.shadowDiagnosticScore = null;
        row.score = null;
        row.betEligible = false;
        row.tag = '⛔ QA未通過｜不評分｜不下注';
        row.scoreAudit = { ...(row.scoreAudit || {}), ok: false, pairAudit: audit };
      }
    }
    if (!audit.passed) failures.push(`${market}：${audit.failures.join('；')}`);
  }

  for (const row of results) {
    row.portfolioRole = '';
    row.portfolioUnit = null;
  }

  return {
    ...analysis,
    results,
    portfolio: [],
    finalEngineVersion: FINAL_ENGINE_VERSION,
    scoreFormulaVersion: SCORE_FORMULA_VERSION,
    scoreContractVersion: SCORE_FORMULA_VERSION,
    scorePolicyVersion: SCORE_POLICY_VERSION,
    settlementRuleVersion: SETTLEMENT_RULE_VERSION,
    uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
    formalScoringEnabled: FORMAL_SCORING_ENABLED,
    scoreReleaseStatus: SCORE_RELEASE_STATUS,
    finalScoreModel: null,
    finalScoreVersion: null,
    scoreValidation: {
      version: SCORE_FORMULA_VERSION,
      passed: failures.length === 0,
      checkedDirections: results.filter(row => row.shadowDiagnosticScore != null).length,
      failures: unique(failures),
      corrections: unique(corrections),
      deterministic: true,
      sameInputSameScore: true,
      noGptScoring: true,
      qaOnlyAsGateOrBlock: true,
      formalScoringEnabled: FORMAL_SCORING_ENABLED,
    },
    riskCalibrationStatus: {
      robustEV: 'shadow-diagnostic-only',
      evFlipProbability: 'not-reliably-estimable',
      modelError: 'historical-backtest-required',
      sensitivity: 'diagnostic-only',
      tailLossThreshold: 'historical-backtest-required',
    },
  };
}
