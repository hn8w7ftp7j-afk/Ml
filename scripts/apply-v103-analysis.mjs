import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceExact(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  return source.replace(before, after);
}
function replaceCount(source, before, after, expected, label) {
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`${label}: expected ${expected} matches, found ${count}`);
  return source.split(before).join(after);
}

// 3) Analysis: raw model EV is retained for audit, but unverified extremes do
// not become decision W/R; independent no-vig prior enters Robust EV only.
{
  const path = 'lib/analysis-v11.js';
  let source = read(path);
  source = replaceExact(
    source,
    "import { buildJointScoreSnapshotV12, scoreDistributionForScenario, JOINT_SCORE_V12_VERSION } from './joint-score-v12.js';",
    "import { buildJointScoreSnapshotV12, scoreDistributionForScenario, JOINT_SCORE_V12_VERSION } from './joint-score-v12.js';\nimport { qualifyEvV103, EV_CALIBRATION_V103_VERSION } from './ev-calibration-v103.js';",
    'EV qualification import',
  );
  source = replaceExact(source, "export const MODEL_VERSION = 'BASEBALL-EXACT-JOINT-SCORE-DISTRIBUTION-2026-08-v10.2.0';", "export const MODEL_VERSION = 'BASEBALL-EXACT-JOINT-SCORE-DISTRIBUTION-2026-08-v10.3.0';", 'model version');
  source = replaceExact(source, "export const RULES_VERSION = 'BASEBALL-TW-EXACT-EV-NO-TARGET-CALIBRATION-2026-08-v10.2.0';", "export const RULES_VERSION = 'BASEBALL-TW-EXACT-EV-NO-TARGET-CALIBRATION-2026-08-v10.3.0';", 'rules version');
  source = replaceExact(source, "export const ANALYSIS_V11_VERSION = 'BASEBALL-EXACT-WEIGHTED-ROBUST-EV-2026-08-v10.2.0';", "export const ANALYSIS_V11_VERSION = 'BASEBALL-EXACT-WEIGHTED-ROBUST-EV-2026-08-v10.3.0';", 'analysis version');
  source = replaceExact(source, "export const ROBUST_EV_VERSION = 'GH27-Q10-DATA-MARGIN-DIAGNOSTIC-UNCALIBRATED-v1.1.0';", "export const ROBUST_EV_VERSION = 'GH27-Q10-DATA-MARGIN-INDEPENDENT-PRIOR-v1.2.0';", 'robust version');
  source = replaceExact(source, "throw new Error('V10.2獨立比分分布版本不相容，必須完整重算');", "throw new Error('V10.3獨立比分分布版本不相容，必須完整重算');", 'snapshot compatibility error');

  source = replaceExact(
    source,
    `      const weightedEV = weighted.ev;
      const robust = robustEvaluation(scenarioRows, gate, weightedEV);
      const rawGap = anchor.probability == null ? null : Math.abs(weighted.modelProbability - anchor.probability);
      const integrityFailures = [];
      if (Math.abs(weighted.coverage - 1) > 1e-9) integrityFailures.push('聯合比分分布總和不等於1');
      if (!Number.isFinite(weightedEV) || !Number.isFinite(robust.robustEV)) integrityFailures.push('EV不是有限數值');
      if (robust.robustEV > weightedEV + 1e-12) integrityFailures.push('Robust EV高於Weighted EV');
      if (!gate.passedForShadowScore) integrityFailures.push(\`資料Gate未通過：\${(gate.blocking || []).join('、')}\`);
      const previous = previousRow(previousMarkets, row);
      let movement = { available: false, reason: '無可比較舊盤' };
      if (previous && clean(previous.pick) === clean(row.pick) && hasActualWater(previous.water)) {
        const old = summarizeAcrossScenarios({ scenarios, first5, pick: previous.pick, water: normalizeWater(previous.water), context, rebateRate }).weighted;
        movement = { available: true, lineChanged: false, previousPick: previous.pick, previousWater: Number(previous.water), currentPick: row.pick, currentWater: water, previousWeightedEV: old.ev, deltaEV: weightedEV - old.ev, method: '同一V10.2獨立凍結比分分布直接重算成交價格' };
      } else if (previous) movement = { available: true, lineChanged: true, previousPick: previous.pick, previousWater: previous.water, currentPick: row.pick, currentWater: water, verdict: '合約改變，由下注帳本逐比分payoff比較' };`,
    `      const rawWeightedEV = weighted.ev;
      const rawRobust = robustEvaluation(scenarioRows, gate, rawWeightedEV);
      const evCalibration = qualifyEvV103({
        row,
        rawWeightedEV,
        rawRobustEV: rawRobust.robustEV,
        modelProbability: weighted.modelProbability,
        rebateRate,
        gate,
      });
      const weightedEV = evCalibration.weightedEV;
      const robustEV = evCalibration.robustEV;
      const rawGap = anchor.probability == null ? null : Math.abs(weighted.modelProbability - anchor.probability);
      const integrityFailures = [];
      if (Math.abs(weighted.coverage - 1) > 1e-9) integrityFailures.push('聯合比分分布總和不等於1');
      if (!Number.isFinite(rawWeightedEV) || !Number.isFinite(rawRobust.robustEV)) integrityFailures.push('原始EV不是有限數值');
      if (rawRobust.robustEV > rawWeightedEV + 1e-12) integrityFailures.push('原始Robust EV高於原始Weighted EV');
      if (!gate.passedForShadowScore) integrityFailures.push(\`資料Gate未通過：\${(gate.blocking || []).join('、')}\`);
      const previous = previousRow(previousMarkets, row);
      let movement = { available: false, reason: '無可比較舊盤' };
      if (previous && clean(previous.pick) === clean(row.pick) && hasActualWater(previous.water)) {
        const old = summarizeAcrossScenarios({ scenarios, first5, pick: previous.pick, water: normalizeWater(previous.water), context, rebateRate }).weighted;
        movement = { available: true, lineChanged: false, previousPick: previous.pick, previousWater: Number(previous.water), currentPick: row.pick, currentWater: water, previousWeightedEV: old.ev, deltaEV: rawWeightedEV - old.ev, method: '同一V10.3獨立凍結比分分布直接重算成交價格' };
      } else if (previous) movement = { available: true, lineChanged: true, previousPick: previous.pick, previousWater: previous.water, currentPick: row.pick, currentWater: water, verdict: '合約改變，由下注帳本逐比分payoff比較' };`,
    'analysis EV qualification block',
  );

  source = replaceExact(source, "outcomeProbabilitiesSource: 'V10.2獨立point-in-time棒球資料＋精確NB分段聯合比分分布；Tai888只作成交payoff'", "outcomeProbabilitiesSource: 'V10.3去重複計權point-in-time棒球資料＋精確NB分段聯合比分分布；Tai888只作成交payoff'", 'probability source wording');
  source = replaceExact(
    source,
    '        distributionCoverage: weighted.coverage, weightedEV, robustEV: robust.robustEV, conservativeEV: robust.q10, cev: robust.q10, rawEV: weightedEV, ev: weightedEV,',
    '        distributionCoverage: weighted.coverage, rawWeightedEV, rawRobustEV: rawRobust.robustEV, weightedEV, robustEV, conservativeEV: rawRobust.q10, cev: rawRobust.q10, rawEV: rawWeightedEV, ev: weightedEV, evCalibration, calibrationQualified: evCalibration.qualified,',
    'result EV fields',
  );
  source = replaceExact(
    source,
    "        evFlipProbabilityDiagnostic: robust.flipWeight, evFlipStatus: 'Gauss-Hermite 27情境參數不確定性權重；尚未以locked OOS校準覆蓋率，不當成歷史頻率', worstVariant: robust.variants[0]?.id || '', robustVariants: robust.variants,",
    "        evFlipProbabilityDiagnostic: rawRobust.flipWeight, evFlipStatus: 'Gauss-Hermite 27情境參數不確定性權重；尚未以locked OOS校準覆蓋率，不當成歷史頻率', worstVariant: [...rawRobust.variants, ...(evCalibration.robustVariants || [])].sort((a, b) => a.value - b.value)[0]?.id || '', robustVariants: [...rawRobust.variants, ...(evCalibration.robustVariants || [])].sort((a, b) => a.value - b.value),",
    'robust variants',
  );
  source = replaceExact(
    source,
    '        robustEVVersion: ROBUST_EV_VERSION, numericStandardError: 0, numericLower95: weightedEV, modelErrorMarginEV: robust.modelErrorMarginEV,',
    '        robustEVVersion: ROBUST_EV_VERSION, numericStandardError: 0, numericLower95: rawWeightedEV, modelErrorMarginEV: rawRobust.modelErrorMarginEV,',
    'robust numeric fields',
  );
  source = replaceExact(
    source,
    "        primaryRisks: [...(gate.projected || []).map(name => `預估資料：${name}`), ...(gate.missing || []).map(name => `缺失資料：${name}`), ...(rawGap != null && rawGap >= .08 ? [`模型與Tai888去水市場差距 ${(rawGap*100).toFixed(1)}%，只作QA診斷，不反校準`] : [])],",
    "        primaryRisks: [...(gate.projected || []).map(name => `預估資料：${name}`), ...(gate.missing || []).map(name => `缺失資料：${name}`), ...(rawGap != null && rawGap >= .08 ? [`模型與Tai888去水市場差距 ${(rawGap*100).toFixed(1)}%，只作診斷，不拿下注盤反校準`] : []), ...(evCalibration.qualified ? [] : evCalibration.reasons.map(reason => `EV校準阻擋：${reason}`))],",
    'primary calibration risks',
  );
  source = replaceExact(
    source,
    '        numericalQA: { passed: true, exactDistribution: true, standardError: 0, lower95: weightedEV, signStable: true, simulationsPerScenario: 0 },',
    '        numericalQA: { passed: Number.isFinite(rawWeightedEV) && Number.isFinite(rawRobust.robustEV), exactDistribution: true, standardError: 0, lower95: rawWeightedEV, signStable: Number.isFinite(rawWeightedEV), simulationsPerScenario: 0 },',
    'numerical QA',
  );
  source = replaceExact(
    source,
    "        evDoubleCheck: { passed: true, directEV: weightedEV, scenarioWeightedEV: scenarioRows.reduce((sum, scenario) => sum + scenario.weight * scenario.value, 0), combinedDistributionEV: weightedEV, tolerance: 1e-9, methods: ['每情境精確比分PMF逐比分逐腿損益', '27情境Gauss-Hermite權重精確加總'] },",
    "        evDoubleCheck: { passed: true, directEV: rawWeightedEV, scenarioWeightedEV: scenarioRows.reduce((sum, scenario) => sum + scenario.weight * scenario.value, 0), combinedDistributionEV: rawWeightedEV, tolerance: 1e-9, methods: ['每情境精確比分PMF逐比分逐腿損益', '27情境Gauss-Hermite權重精確加總'] },",
    'EV double check',
  );
  source = replaceExact(source, "analysisStatus: gate.passedForShadowScore ? 'V10.2獨立精確比分模型｜Shadow Diagnostic' : '資料Gate BLOCK'", "analysisStatus: gate.passedForShadowScore ? 'V10.3去重複計權精確比分模型｜EV Calibration Safety' : '資料Gate BLOCK'", 'analysis status');
  source = replaceExact(
    source,
    "scenarioSummary: { count: scenarios.length, simulationsPerScenario: 0, conservativeQuantile: .10, sharedDistribution: true, jointPortfolioDistribution: true, exactDistribution: true, quadratureVersion: distributionSnapshot.quadratureVersion, persistedForReprice: true, targetPriceCalibratesDistribution: false, marketProbabilityCalibrationApplied: false, legacyDistributionUsed: false },",
    "scenarioSummary: { count: scenarios.length, simulationsPerScenario: 0, conservativeQuantile: .10, sharedDistribution: true, jointPortfolioDistribution: true, exactDistribution: true, quadratureVersion: distributionSnapshot.quadratureVersion, runProfileVersion: distributionSnapshot.runProfileVersion, evCalibrationVersion: EV_CALIBRATION_V103_VERSION, persistedForReprice: true, targetPriceCalibratesDistribution: false, marketProbabilityCalibrationApplied: false, legacyDistributionUsed: false },",
    'scenario summary versions',
  );
  source = replaceExact(
    source,
    "alignmentAudit: { instructionVersion: 'V10.2獨立資料→精確分段NB聯合比分→台灣盤逐腿結算→Weighted/Robust EV→QA→影子雙EV分數'",
    "alignmentAudit: { instructionVersion: 'V10.3正確資料→去重複計權run profile→精確分段NB聯合比分→台灣盤逐腿結算→EV校準資格→固定雙EV分數'",
    'alignment audit version',
  );
  source = replaceExact(source, "if (!distributionSnapshot) throw new Error('缺少V10.1凍結比分分布');", "if (!distributionSnapshot) throw new Error('缺少V10.3凍結比分分布');", 'reprice error');
  write(path, source);
}
