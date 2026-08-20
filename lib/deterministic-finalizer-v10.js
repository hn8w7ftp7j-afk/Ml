import { hasActualWater, parseTaiwanLine } from './markets.js';
import { mirrorSettlementAudit, SETTLEMENT_RULE_VERSION } from './taiwan-settlement-v9.js';
import {
  SCORE_FORMULA_VERSION,
  SCORE_POLICY_VERSION,
  deterministicScore,
  scoreBoundaryAudit,
} from './deterministic-score.js';

export const FINAL_ENGINE_VERSION = 'BASEBALL-DETERMINISTIC-SHADOW-2026-08-v10.4.0';
export const UNCERTAINTY_SET_VERSION = 'BASEBALL-INDEPENDENT-CROSS-BOOK-LOWER-v2.0.0';
export const FORMAL_SCORING_ENABLED = false;
export const SCORE_RELEASE_STATUS = 'SHADOW_DIAGNOSTIC_UNCALIBRATED_NOT_FORMAL';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clean = value => String(value || '').trim();
const unique = values => [...new Set((values || []).filter(Boolean))];

function baseQa(row) {
  const failures = [];
  if (!parseTaiwanLine(row.pick)?.valid) failures.push('盤口合約無法解析');
  if (Math.abs(finite(row.distributionCoverage, 0) - 1) > 1e-9) failures.push('比分分布機率總和不等於1');
  if (row.weightedEV == null || !Number.isFinite(Number(row.weightedEV))) failures.push('Weighted EV不是有限數值');
  if (row.robustEV == null || !Number.isFinite(Number(row.robustEV))) failures.push('Robust EV不是有限數值');
  if (row.weightedEV != null && row.robustEV != null
    && Number.isFinite(Number(row.weightedEV)) && Number.isFinite(Number(row.robustEV))
    && Number(row.robustEV) > Number(row.weightedEV) + 1e-12) failures.push('Robust EV高於Weighted EV');
  if (row.integrityWarning) failures.push(clean(row.integrityMessage) || '底層模型完整性警告');
  if (row.evDoubleCheck?.passed !== true) failures.push('EV逐比分、結果桶與情境加權三算未通過');
  if (row.dataGateV10?.passedForShadowScore !== true) {
    failures.push(`資料Gate未通過：${(row.dataGateV10?.blocking || []).join('、') || '核心資料缺失'}`);
  }
  if (finite(row.weightedEV, 0) > 0 && row.numericalQA?.passed !== true) failures.push('正EV數值信賴下界跨0');
  if (row.evCalibration?.qualified !== true) {
    failures.push(`EV校準未通過：${(row.evCalibration?.reasons || []).join('；') || '缺少合格獨立市場同合約共識'}`);
  }
  return { passed: failures.length === 0, failures };
}

function representativeScorePairs(row) {
  const parsed = parseTaiwanLine(row.pick);
  if (!parsed.valid) return [];
  const maximum = parsed.isTotal
    ? Math.max(18, Math.ceil(Math.max(...parsed.legs, 8) + 6))
    : Math.max(12, Math.ceil(Math.max(...parsed.legs, 1) + 6));
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
  const leftProbability = Number(left.modelProbability);
  const rightProbability = Number(right.modelProbability);
  const complementError = Number.isFinite(leftProbability) && Number.isFinite(rightProbability)
    ? Math.abs(leftProbability + rightProbability - 1)
    : null;
  if (complementError != null && complementError > 0.012) failures.push('同市場正反方向條件勝率未互補');
  let mirrorChecked = false;
  for (const [awayRuns, homeRuns] of representativeScorePairs(left)) {
    const audit = mirrorSettlementAudit(left.pick, right.pick, awayRuns, homeRuns, game?.away, game?.home);
    mirrorChecked = true;
    if (!audit.ok) {
      failures.push(`正反方向逐腿結算不鏡像：${awayRuns}-${homeRuns}`);
      break;
    }
  }
  return { passed: failures.length === 0, failures, complementError, mirrorChecked };
}

function thirdAudit(row, scoreResult, qaPassed) {
  const reasons = [];
  if (finite(row.weightedEV, 0) >= 0.05) reasons.push('Weighted EV≥5%');
  if (Number(scoreResult.score || 0) >= 8.5) reasons.push('影子評分≥8.5');
  if (row.specialMarket) reasons.push('特殊盤');
  if (row.arbitrageClaim) reasons.push('套利／鎖價聲稱');
  if (scoreResult.highScoreAnomaly) reasons.push('內部Raw Score達9.0');
  const required = reasons.length > 0;
  const checks = {
    contract: parseTaiwanLine(row.pick)?.valid === true,
    probabilityCoverage: Math.abs(finite(row.distributionCoverage, 0) - 1) <= 1e-9,
    robustNotAboveWeighted: finite(row.robustEV, 0) <= finite(row.weightedEV, 0) + 1e-12,
    baseQa: qaPassed,
    marketVerification: row.marketVerification?.referencePriorEligible === true,
    numericalSignStable: finite(row.weightedEV, 0) <= 0 || row.numericalQA?.signStable === true,
    targetMarketNotUsedForCalibration: row.marketCalibrationApplied === false,
    highScoreManualConfirmation: !scoreResult.highScoreAnomaly || row.highScoreManualConfirmed === true,
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    required,
    reasons,
    passed: failures.length === 0,
    checks,
    failures,
    manualConfirmationRequired: scoreResult.highScoreAnomaly,
  };
}

function shadowTag(score, label, { qaPassed = true, leagueValidated = true } = {}) {
  if (score == null) return '⛔ 無法建立固定 S 分數｜不下注';
  if (!leagueValidated) return `⚠️ ${score.toFixed(1)}｜${label}｜聯盟模型未驗證｜固定 S 分數僅供檢查｜不列排名｜不可下注`;
  if (!qaPassed) return `⚠️ ${score.toFixed(1)}｜${label}｜QA BLOCK｜固定 S 分數僅供檢查｜不列排名｜不可下注`;
  if (score >= 8.5) return `🧪 ${score.toFixed(1)}｜${label}｜影子分數｜不可下注`;
  if (score >= 7.2) return `🧪 ${score.toFixed(1)}｜${label}｜影子候選｜不可下注`;
  return `影子分數 ${score.toFixed(1)}｜${label}｜不可下注`;
}

export function finalizeDeterministicAnalysis({ analysis, game, settings = {} }) {
  const leagueId = String(analysis?.leagueId || game?.leagueId || game?.league || 'MLB').toUpperCase();
  const leagueScoreValidated = leagueId === 'MLB'
    && analysis?.alignmentAudit?.targetMarketCalibration === 'INDEPENDENT_EXACT_CONTRACT_ONLY';
  const candidateThreshold = Number(settings.candidateThreshold || 7.2);
  const failures = [];
  const corrections = [];
  const results = (analysis?.results || []).map(source => {
    const row = { ...source };
    const weightedCalculable = row.weightedEV != null && Number.isFinite(Number(row.weightedEV));
    const robustCalculable = row.robustEV != null && Number.isFinite(Number(row.robustEV));
    if (row.water == null || !hasActualWater(row.water) || !weightedCalculable || !robustCalculable) {
      const missingReason = row.evCalibration?.qualified !== true
        ? `EV校準未通過：${(row.evCalibration?.reasons || []).join('；') || '缺少合格獨立市場同合約共識'}`
        : !weightedCalculable || !robustCalculable ? '雙EV不是有限數值' : '水位未提供';
      row.formulaDiagnosticScore = null;
      row.shadowDiagnosticScore = null;
      row.score = null;
      row.scoreStatus = 'UNSCORED';
      row.scoreSource = 'V10.4.0獨立同合約共識雙EV短板公式｜影子模式';
      row.scoreFormulaVersion = SCORE_FORMULA_VERSION;
      row.scoreContractVersion = SCORE_FORMULA_VERSION;
      row.scoreType = 'SHADOW_DIAGNOSTIC';
      row.tag = `${missingReason}｜不評分`;
      row.betEligible = false;
      row.unitSuggestion = null;
      row.scoreAudit = { ok: false, skipped: true, reason: missingReason, formulaVersion: SCORE_FORMULA_VERSION };
      return row;
    }

    const qa = baseQa(row);
    const actualWater = !row.waterEstimated && row.sourceType === 'ACTUAL_TW_CREDIT';
    const executable = row.executable === true;
    const crossMarketVerified = row.marketVerification?.referencePriorEligible === true;
    const scoreResult = deterministicScore({
      weightedEV: row.weightedEV,
      robustEV: row.robustEV,
      // QA controls qualification and ranking, not whether the fixed dual-EV
      // formula can be inspected. Formal score/recommendation remain disabled.
      qaPassed: true,
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
    const third = thirdAudit(row, scoreResult, qa.passed && boundary.ok);
    const formulaDiagnosticScore = Number.isFinite(Number(scoreResult.score)) ? Number(scoreResult.score) : null;
    const qaQualified = leagueScoreValidated && qa.passed && boundary.ok && third.passed;
    const diagnosticScore = qaQualified ? formulaDiagnosticScore : null;

    row.formulaDiagnosticScore = formulaDiagnosticScore;
    row.shadowDiagnosticScore = diagnosticScore;
    row.formulaDiagnosticBand = scoreResult.band;
    row.formulaDiagnosticLabel = scoreResult.label;
    row.rankingQualified = diagnosticScore != null
      && formulaDiagnosticScore >= candidateThreshold
      && Number(row.weightedEV) > 0
      && Number(row.robustEV) > 0;
    row.rankingQualificationReason = !leagueScoreValidated ? '聯盟模型未驗證'
      : diagnosticScore == null ? '資料QA未通過'
        : Number(row.weightedEV) <= 0 ? '加權EV未大於0'
          : Number(row.robustEV) <= 0 ? '穩健EV未大於0'
            : formulaDiagnosticScore < candidateThreshold ? `公式分數未達${candidateThreshold.toFixed(1)}`
              : '雙EV為正、分數達門檻且資料QA通過';
    row.score = null;
    row.scoreStatus = !leagueScoreValidated
      ? 'LEAGUE_MODEL_NOT_VALIDATED'
      : diagnosticScore == null ? 'BLOCKED' : 'SHADOW_DIAGNOSTIC_UNCALIBRATED';
    row.scoreSource = 'V10.4.0獨立同合約市場價差 W/R 固定雙EV短板公式｜影子模式';
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
      rawWeightedEV: row.rawWeightedEV,
      rawRobustEV: row.rawRobustEV,
      evCalibration: row.evCalibration || null,
      band: scoreResult.band,
      rawScore: scoreResult.rawScore,
      formulaDiagnosticScore,
      qaQualifiedDiagnosticScore: diagnosticScore,
      diagnosticScore,
      finalScore: null,
      progress: scoreResult.progress,
      caps: scoreResult.caps,
      noGptScoring: true,
      targetMarketCalibrationDisabled: row.marketCalibrationApplied === false,
      qaOnlyAsGateOrBlock: true,
      qaControlsQualificationNotFormulaVisibility: true,
      formalScoringEnabled: FORMAL_SCORING_ENABLED,
      scoreReleaseStatus: SCORE_RELEASE_STATUS,
    };
    row.scoreAudit = {
      ok: diagnosticScore != null,
      leagueValidated: leagueScoreValidated,
      displayScoreAvailable: formulaDiagnosticScore != null,
      formulaVersion: SCORE_FORMULA_VERSION,
      baseQa: qa,
      boundary,
      thirdAudit: third,
      corrections: [],
      noGptScoring: true,
      formalScoringEnabled: FORMAL_SCORING_ENABLED,
    };
    row.thirdAudit = third;
    row.betEligible = false;
    row.unitSuggestion = null;
    row.unitStatus = 'V10.4.0 Shadow｜正式Unit停用';
    row.tag = shadowTag(formulaDiagnosticScore, scoreResult.label, {
      qaPassed: qa.passed && boundary.ok && third.passed,
      leagueValidated: leagueScoreValidated,
    });
    row.evFlipProbability = null;
    row.evFlipStatus = '情境權重診斷，不作頻率機率或額外扣分';
    row.modelErrorStatus = '有效W/R只取至少3家獨立國際市場同合約共識與跨莊下界；原始棒球模型只作一致性阻擋；尚未locked OOS校準，仍只作Shadow診斷';
    row.riskMetricOverlapAudit = {
      robustEV: '至少3家獨立市場同合約去水機率的跨莊保守下界；尚未完成locked OOS，只作影子價格診斷',
      dataQuality: '只決定QA PASS/BLOCK，不直接改寫分數',
      marketVerification: '沒有獨立同合約共識即不建立有效雙EV或分數',
      targetMarketCalibration: '停用；Tai888只作成交payoff',
      evCalibration: 'W/R直接來自獨立同合約共識價格與跨莊保守機率；原始模型不得單獨產生有效EV',
    };

    if (!leagueScoreValidated) {
      failures.push(`${row.market}｜${row.pick}：${leagueId}聯盟模型尚未完成獨立驗證`);
    } else if (diagnosticScore == null) {
      failures.push(`${row.market}｜${row.pick}：${[...qa.failures, ...boundary.errors, ...third.failures].join('；')}`);
    }
    if (scoreResult.caps.includes('TWO_INDEPENDENT_MARKETS_NOT_VERIFIED')) {
      corrections.push(`${row.market}｜${row.pick}：尚未接入兩個獨立同合約市場，影子分數最高8.4`);
    }
    return row;
  });

  for (const market of [...new Set(results.map(row => row.market))]) {
    const pair = results.filter(row => row.market === market && row.pick);
    if (pair.length !== 2) continue;
    const audit = pairQa(pair, game);
    const bothHigh = pair.filter(row => Number(row.shadowDiagnosticScore) >= candidateThreshold).length > 1;
    if (bothHigh) audit.failures.push('同一市場正反方向同時達7.2，必須整批BLOCK重算');
    audit.passed = audit.failures.length === 0;
    for (const row of pair) {
      row.pairAudit = audit;
      if (!audit.passed) {
        row.shadowDiagnosticScore = null;
        row.score = null;
        row.scoreStatus = leagueScoreValidated ? 'BLOCKED' : 'LEAGUE_MODEL_NOT_VALIDATED';
        row.betEligible = false;
        row.tag = shadowTag(row.formulaDiagnosticScore, row.scoreBreakdown?.band || '診斷', {
          qaPassed: false,
          leagueValidated: leagueScoreValidated,
        });
        row.scoreAudit = { ...(row.scoreAudit || {}), ok: false, pairAudit: audit };
        row.rankingQualified = false;
        row.rankingQualificationReason = `市場成對QA未通過：${audit.failures.join('；')}`;
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
    formalRecommendationsEnabled: false,
    scoreReleaseStatus: SCORE_RELEASE_STATUS,
    finalScoreModel: null,
    finalScoreVersion: null,
    scoreValidation: {
      version: SCORE_FORMULA_VERSION,
      passed: failures.length === 0,
      checkedDirections: results.filter(row => row.shadowDiagnosticScore != null).length,
      formulaDiagnosticDirections: results.filter(row => row.formulaDiagnosticScore != null).length,
      failures: unique(failures),
      corrections: unique(corrections),
      deterministic: true,
      sameInputSameScore: true,
      noGptScoring: true,
      targetMarketCalibrationDisabled: true,
      qaOnlyAsGateOrBlock: true,
      formalScoringEnabled: FORMAL_SCORING_ENABLED,
    },
    riskCalibrationStatus: {
      robustEV: 'independent-cross-book-lower-shadow-only',
      modelError: 'raw-baseball-model-can-block-but-cannot-create-ev',
      sensitivity: 'diagnostic-only',
      formalActivation: 'disabled-until-locked-oos-and-forward-gates-pass',
    },
  };
}
