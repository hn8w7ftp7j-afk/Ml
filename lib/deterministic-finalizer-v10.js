import { hasActualWater, parseTaiwanLine } from './markets.js';
import { mirrorSettlementAudit, SETTLEMENT_RULE_VERSION } from './taiwan-settlement-v9.js';
import {
  SCORE_FORMULA_VERSION,
  SCORE_POLICY_VERSION,
  deterministicScore,
  scoreBoundaryAudit,
} from './deterministic-score.js';

export const FINAL_ENGINE_VERSION = 'BASEBALL-DETERMINISTIC-SHADOW-2026-08-v10.5.1';
export const UNCERTAINTY_SET_VERSION = 'BASEBALL-CORRELATED-SCENARIO-LOWER-v2.2.0';
export const FORMAL_SCORING_ENABLED = false;
export const SCORE_RELEASE_STATUS = 'SHADOW_DIAGNOSTIC_UNCALIBRATED_NOT_FORMAL';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clean = value => String(value || '').trim();
const unique = values => [...new Set((values || []).filter(Boolean))];

function baseQa(row) {
  const failures = [];
  if (!parseTaiwanLine(row.pick)?.valid) failures.push('盤口合約無法解析');
  if (row.weightedEV == null || !Number.isFinite(Number(row.weightedEV))) failures.push('Weighted EV不是有限數值');
  if (row.robustEV == null || !Number.isFinite(Number(row.robustEV))) failures.push('Robust EV不是有限數值');
  if (row.weightedEV != null && row.robustEV != null
    && Number.isFinite(Number(row.weightedEV)) && Number.isFinite(Number(row.robustEV))
    && Number(row.robustEV) > Number(row.weightedEV) + 1e-12) failures.push('Robust EV高於Weighted EV');
  if (finite(row.weightedEV, 0) > 0 && row.numericalQA?.passed !== true) failures.push('正EV數值信賴下界跨0');
  if (row.evCalibration?.qualified !== true) {
    failures.push(`模型評分未通過：${(row.evCalibration?.reasons || []).join('；') || 'Reader、核心資料或數學未通過'}`);
  }
  if (row.evCalibration?.qualified === true && row.evCalibration?.actualReaderEligible !== true) {
    failures.push('Tai888 Reader 實際盤來源或新鮮度未通過');
  }
  if (row.dataGateV10?.passedForShadowScore !== true) failures.push('核心棒球資料Gate未通過');
  if (row.integrityWarning === true) failures.push(row.integrityMessage || '模型資料或數值完整性未通過');
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
    probabilityCoverage: true,
    robustNotAboveWeighted: finite(row.robustEV, 0) <= finite(row.weightedEV, 0) + 1e-12,
    baseQa: qaPassed,
    marketVerification: true,
    // W>0/R<=0 is an intentional fixed 7.1 observation band. It must stay
    // visible without entering the ranking; only a positive-R candidate needs
    // the numerical lower-bound sign check.
    numericalSignStable: finite(row.weightedEV, 0) <= 0
      || finite(row.robustEV, 0) <= 0
      || row.numericalQA?.signStable === true,
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
    && analysis?.alignmentAudit?.targetMarketCalibration === 'DISABLED_EXECUTION_PRICE_ONLY'
    && analysis?.dataGateV10?.passedForShadowScore === true;
  const candidateThreshold = Number(settings.candidateThreshold || 7.2);
  const failures = [];
  const corrections = [];
  const results = (analysis?.results || []).map(source => {
    const row = { ...source };
    const weightedCalculable = row.weightedEV != null && Number.isFinite(Number(row.weightedEV));
    const robustCalculable = row.robustEV != null && Number.isFinite(Number(row.robustEV));
    const readerExecutionQualified = row.evCalibration?.qualified !== true
      || row.evCalibration?.actualReaderEligible === true;
    if (row.water == null || !hasActualWater(row.water) || !weightedCalculable || !robustCalculable || !readerExecutionQualified) {
      const missingReason = !readerExecutionQualified
        ? 'Tai888 Reader 實際盤已過期、來源不符或尚未完成最新版本驗證'
        : row.evCalibration?.qualified !== true
        ? `模型評分未通過：${(row.evCalibration?.reasons || []).join('；') || 'Reader、核心資料或數學未通過'}`
        : !weightedCalculable || !robustCalculable ? '雙EV不是有限數值' : '水位未提供';
      row.formulaDiagnosticScore = null;
      row.shadowDiagnosticScore = null;
      row.score = null;
      row.scoreStatus = 'UNSCORED';
      row.scoreSource = 'V10.5.1模型聯合比分分布雙EV短板公式｜影子模式';
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
    const actualWater = !row.waterEstimated
      && row.sourceType === 'ACTUAL_TW_CREDIT'
      && row.evCalibration?.actualReaderEligible === true;
    // The shadow safety wrapper deliberately rewrites row.executable=false
    // after analysis. Preserve the pre-wrapper Reader execution proof in the
    // signed calibration object instead of mistaking shadow mode for staleness.
    const executable = row.evCalibration?.actualReaderEligible === true;
    // A fresh three-book consensus qualifies W/R. The 8.5+ band is stricter:
    // it additionally requires a genuinely separate external market check,
    // which is not inferred from the same three-book snapshot.
    const crossMarketVerified = row.marketVerification?.referencePriorEligible === true
      && row.marketVerification?.secondaryIndependentMarketVerified === true;
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
    const rawCalculatedScore = Number.isFinite(Number(scoreResult.score)) ? Number(scoreResult.score) : null;
    const scenarioSpread = Number(row.evCalibration?.rawScenarioSpread);
    const scenarioStable = row.evCalibration?.scenarioStable !== false
      && (!Number.isFinite(scenarioSpread) || scenarioSpread <= 0.05);
    const extremeModelReview = row.evCalibration?.extreme === true;
    // Scenario instability and an uncalibrated 15%+ W are QA/ranking gates.
    // They must never rewrite the score produced by the locked dual-EV formula.
    const calculatedScore = rawCalculatedScore;
    const qaQualified = leagueScoreValidated && qa.passed && boundary.ok && third.passed;
    const formulaDiagnosticScore = qaQualified ? calculatedScore : null;
    const diagnosticScore = formulaDiagnosticScore;

    row.formulaDiagnosticScore = formulaDiagnosticScore;
    row.shadowDiagnosticScore = diagnosticScore;
    row.formulaDiagnosticBand = qaQualified ? scoreResult.band : null;
    row.formulaDiagnosticLabel = qaQualified ? scoreResult.label : null;
    row.rankingQualified = diagnosticScore != null
      && formulaDiagnosticScore >= candidateThreshold
      && Number(row.weightedEV) > 0
      && Number(row.robustEV) > 0
      && scenarioStable
      && !extremeModelReview;
    row.rankingQualificationReason = !leagueScoreValidated ? '聯盟模型未驗證'
      : diagnosticScore == null ? '資料QA未通過'
        : extremeModelReview ? '未校準模型W達15%以上，待複核'
          : !scenarioStable ? '模型W/R情境差距超過5%穩定線'
          : Number(row.weightedEV) <= 0 ? '加權EV未大於0'
          : Number(row.robustEV) <= 0 ? '穩健EV未大於0'
            : formulaDiagnosticScore < candidateThreshold ? `公式分數未達${candidateThreshold.toFixed(1)}`
              : '雙EV為正、分數達門檻且資料QA通過';
    row.score = null;
    row.scoreStatus = !leagueScoreValidated
      ? 'LEAGUE_MODEL_NOT_VALIDATED'
      : diagnosticScore == null ? 'BLOCKED' : 'SHADOW_DIAGNOSTIC_UNCALIBRATED';
    row.scoreSource = 'V10.5.1相關風險聯合比分模型 W/R 固定雙EV短板公式｜影子模式';
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
      scenarioSpread: row.evCalibration?.rawScenarioSpread ?? null,
      scenarioStable,
      band: scoreResult.band,
      rawScore: qaQualified ? scoreResult.rawScore : null,
      formulaDiagnosticScore,
      qaQualifiedDiagnosticScore: diagnosticScore,
      diagnosticScore,
      finalScore: null,
      progress: scoreResult.progress,
      caps: [...scoreResult.caps, ...(!scenarioStable ? ['SCENARIO_SPREAD_OVER_5_PERCENT'] : []), ...(extremeModelReview ? ['UNCALIBRATED_W_OVER_15_PERCENT'] : [])],
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
    row.unitStatus = 'V10.4.3 Shadow｜正式Unit停用';
    row.tag = shadowTag(formulaDiagnosticScore, row.formulaDiagnosticLabel || scoreResult.label, {
      qaPassed: qa.passed && boundary.ok && third.passed,
      leagueValidated: leagueScoreValidated,
    });
    row.evFlipProbability = null;
    row.evFlipStatus = '情境權重診斷，不作頻率機率或額外扣分';
    row.modelErrorStatus = 'W/R只來自棒球聯合比分分布；獨立市場只作可選外部稽核；尚未locked OOS校準，仍只作Shadow診斷';
    row.riskMetricOverlapAudit = {
      robustEV: '模型情境Q10與資料誤差下界；尚未完成locked OOS，只作影子模型診斷',
      dataQuality: '只決定QA PASS/BLOCK，不直接改寫分數',
      marketVerification: '獨立同合約共識只作外部稽核，不取代模型EV',
      targetMarketCalibration: '停用；Tai888只作成交payoff',
      evCalibration: 'Weighted/Robust EV來自同一份聯合比分分布與情境壓力測試',
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
      modelError: 'raw-baseball-model-audit-only-cannot-qualify-veto-or-create-ev',
      sensitivity: 'diagnostic-only',
      formalActivation: 'disabled-until-locked-oos-and-forward-gates-pass',
    },
  };
}
