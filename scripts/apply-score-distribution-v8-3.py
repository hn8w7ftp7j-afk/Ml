from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    left = text.find(start)
    if left < 0:
        raise SystemExit(f'{label}: start marker missing')
    right = text.find(end, left)
    if right < 0:
        raise SystemExit(f'{label}: end marker missing')
    return text[:left] + replacement.rstrip() + '\n\n' + text[right:]

# ---------------------------------------------------------------------------
# lib/markets.js — remove the 3.5 sticky floor and expose a complete audit.
# ---------------------------------------------------------------------------
p = Path('lib/markets.js')
s = p.read_text()
s = replace_once(s, "export const SCORE_CONTRACT_VERSION = 'GPT-COMPOSITE-EVIDENCE-v8.2';", "export const SCORE_CONTRACT_VERSION = 'GPT-COMPOSITE-EVIDENCE-v8.3';", 'score contract version')

score_block = r'''export function scoreEvidenceBreakdown(conservativeEV, options = {}) {
  const conservative = Number.isFinite(Number(conservativeEV)) ? Number(conservativeEV) : 0;
  const weightedEV = Number.isFinite(Number(options.weightedEV)) ? Number(options.weightedEV) : conservative;
  const robustEV = Number.isFinite(Number(options.robustEV)) ? Number(options.robustEV) : conservative;
  const flipProbability = clamp(Number(options.flipProbability) || 0, 0, 1);
  const qualityValue = Number(options.quality ?? options.confidence);
  const quality = clamp(Number.isFinite(qualityValue) ? qualityValue : 0.72, 0.35, 1);
  const edgeStrength = clamp(Number(options.edgeStrength) || 0, -1, 1);
  const stabilityValue = Number(options.stability);
  const stability = clamp(Number.isFinite(stabilityValue) ? stabilityValue : (1 - flipProbability), 0, 1);
  const modelErrorFloor = clamp(Number(options.modelErrorFloor) || 0.025, 0.005, 0.08);
  const independentEvidence = clamp(Number(options.independentEvidence) || 0.35, 0.10, 0.90);
  const divergenceRisk = clamp(Number(options.divergenceRisk) || 0, 0, 0.50);
  const integrityWarning = Boolean(options.integrityWarning || options.distributionInvalid);
  const waterEstimated = Boolean(options.waterEstimated);
  const edgeAboveError = conservative - modelErrorFloor;

  const asymmetric = (value, positiveWeight, positiveScale, negativeWeight, negativeScale) => (
    value >= 0
      ? positiveWeight * smooth(value, positiveScale)
      : negativeWeight * smooth(value, negativeScale)
  );

  // The user's GPT scale is centred near 5.0. Positive evidence may build into
  // the 7.2/8.0/8.5 bands, while ordinary negative EV declines smoothly rather
  // than collapsing every weak direction onto the same artificial 3.5 floor.
  const components = {
    weightedEV: asymmetric(weightedEV, 0.95, 0.055, 0.62, 0.065),
    robustEV: asymmetric(robustEV, 1.05, 0.050, 0.72, 0.060),
    conservativeEV: asymmetric(conservative, 0.70, 0.045, 0.48, 0.075),
    edgeStrength: 0.45 * edgeStrength,
    stability: 0.32 * ((stability - 0.5) * 2),
    dataQuality: 0.24 * ((quality - 0.70) / 0.30),
    independentEvidence: 0.19 * ((independentEvidence - 0.40) / 0.45),
    flipRisk: -0.30 * flipProbability,
    divergenceRisk: -0.15 * divergenceRisk,
  };
  const rawScore = 5 + Object.values(components).reduce((sum, value) => sum + value, 0);

  let cap = 9.4;
  const capReasons = [];
  if (integrityWarning || waterEstimated) {
    cap = 6.6;
    capReasons.push(integrityWarning ? '資料完整性警告' : '暫估水位');
  } else if (weightedEV <= 0) {
    cap = 6.6;
    capReasons.push('加權 EV 非正');
  } else if (robustEV <= 0 || conservative <= 0) {
    cap = 7.1;
    capReasons.push('穩健或保守 EV 非正');
  } else if (conservative <= modelErrorFloor) {
    cap = 7.4;
    capReasons.push('保守 EV 未明顯超過模型誤差');
  } else {
    if (robustEV < modelErrorFloor + 0.012 || conservative < modelErrorFloor + 0.004) {
      cap = Math.min(cap, 7.4);
      capReasons.push('正 EV 證據偏薄');
    } else if (robustEV < modelErrorFloor + 0.027 || conservative < modelErrorFloor + 0.014) {
      cap = Math.min(cap, 7.9);
      capReasons.push('穩健優勢尚未達主推');
    } else if (robustEV < modelErrorFloor + 0.050 || conservative < modelErrorFloor + 0.030) {
      cap = Math.min(cap, 8.4);
      capReasons.push('優勢未達最強主推');
    }

    if (flipProbability > 0.35) {
      cap = Math.min(cap, 7.4);
      capReasons.push('EV 翻負風險高');
    } else if (flipProbability > 0.25) {
      cap = Math.min(cap, 7.9);
      capReasons.push('EV 翻負風險偏高');
    } else if (flipProbability > 0.15) {
      cap = Math.min(cap, 8.4);
      capReasons.push('EV 翻負風險未達最強門檻');
    }

    if (cap > 8.4 && (
      independentEvidence < 0.55
      || quality < 0.78
      || flipProbability > 0.12
      || edgeAboveError < 0.035
    )) {
      cap = 8.4;
      capReasons.push('獨立證據／品質／誤差優勢不足');
    }
  }

  const floor = 1.0;
  const score = clamp(rawScore, floor, cap);
  return {
    version: SCORE_CONTRACT_VERSION,
    score,
    rawScore,
    floor,
    cap,
    clampedLow: rawScore < floor,
    clampedHigh: rawScore > cap,
    capReasons,
    components,
    evidence: {
      weightedEV,
      robustEV,
      conservativeEV: conservative,
      flipProbability,
      quality,
      edgeStrength,
      stability,
      modelErrorFloor,
      edgeAboveError,
      independentEvidence,
      divergenceRisk,
      integrityWarning,
      waterEstimated,
    },
  };
}

export function scoreFromCompositeEV(conservativeEV, options = {}) {
  return scoreEvidenceBreakdown(conservativeEV, options).score;
}

export function validateScoreContract(score, conservativeEV, options = {}) {
  const errors = [];
  const value = Number(score);
  const conservative = Number(conservativeEV);
  const weightedEV = Number(options.weightedEV);
  const robustEV = Number(options.robustEV);
  const flipProbability = clamp(Number(options.flipProbability) || 0, 0, 1);
  const qualityValue = Number(options.quality ?? options.confidence);
  const quality = clamp(Number.isFinite(qualityValue) ? qualityValue : 0.72, 0.35, 1);
  const modelErrorFloor = clamp(Number(options.modelErrorFloor) || 0.025, 0.005, 0.08);
  const independentEvidence = clamp(Number(options.independentEvidence) || 0.35, 0.10, 0.90);
  const integrityWarning = Boolean(options.integrityWarning || options.distributionInvalid);
  const waterEstimated = Boolean(options.waterEstimated);
  const breakdown = scoreEvidenceBreakdown(conservative, options);

  if (!Number.isFinite(value)) errors.push('評分不是有限數值');
  if (Number.isFinite(value) && (value < 1 - 1e-9 || value > 9.4 + 1e-9)) errors.push('評分超出 1.0～9.4 正式尺度');
  if (Number.isFinite(value) && (Math.abs(value) < 1e-9 || Math.abs(value - 10) < 1e-9)) errors.push('正式評分不可直接落在 0 或 10');
  if (Number.isFinite(value) && Math.abs(value - breakdown.score) > 1e-9) errors.push('評分與固定公式重算不一致');
  if (!Number.isFinite(conservative) || !Number.isFinite(weightedEV) || !Number.isFinite(robustEV)) errors.push('EV 證據不完整');
  if ((integrityWarning || waterEstimated) && value > 6.600001) errors.push('資料或水位未確認卻高於 6.6');
  if (weightedEV <= 0 && value > 6.600001) errors.push('加權 EV 非正卻高於 6.6');
  if ((robustEV <= 0 || conservative <= 0) && value > 7.100001) errors.push('穩健／保守 EV 非正卻高於 7.1');
  if (value >= 7.2 && !(weightedEV > 0 && robustEV > 0 && conservative > 0 && !integrityWarning && !waterEstimated)) {
    errors.push('7.2+ 未通過正 EV 與完整性門檻');
  }
  if (value >= 8.5 && (
    robustEV < modelErrorFloor + 0.050
    || conservative < modelErrorFloor + 0.035
    || flipProbability > 0.12
    || quality < 0.78
    || independentEvidence < 0.55
  )) errors.push('8.5+ 未通過最強主推證據門檻');

  return {
    ok: errors.length === 0,
    version: SCORE_CONTRACT_VERSION,
    errors,
    expectedScore: breakdown.score,
    breakdown,
  };
}'''
s = replace_between(s, 'export function scoreFromCompositeEV(', '// Backward-compatible wrapper', score_block, 'score functions')
p.write_text(s)

# ---------------------------------------------------------------------------
# lib/analysis.js — add per-game anti-clustering validation and score details.
# ---------------------------------------------------------------------------
p = Path('lib/analysis.js')
s = p.read_text()
s = s.replace("export const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.2.0';", "export const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.3.0';")
s = s.replace("export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.2.0';", "export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.3.0';")

distribution_audit = r'''function scoreDistributionAudit(results) {
  const rows = (results || []).filter(result => Number.isFinite(Number(result.score)));
  const values = rows.map(result => Number(result.score));
  const displayedCounts = new Map();
  for (const value of values) {
    const key = value.toFixed(1);
    displayedCounts.set(key, (displayedCounts.get(key) || 0) + 1);
  }
  const displayedEntries = [...displayedCounts.entries()].sort((left, right) => right[1] - left[1] || Number(left[0]) - Number(right[0]));
  const dominant = displayedEntries[0] || [null, 0];
  const clampedLowCount = rows.filter(result => result.scoreAudit?.breakdown?.clampedLow).length;
  const clampedHighCount = rows.filter(result => result.scoreAudit?.breakdown?.clampedHigh).length;
  const minimum = values.length ? Math.min(...values) : null;
  const maximum = values.length ? Math.max(...values) : null;
  const spread = values.length ? maximum - minimum : null;
  const errors = [];

  // This specifically prevents the regression where five or six directions
  // all displayed as exactly 3.5 merely because the scorer hit a lower clamp.
  if (values.length >= 4 && dominant[1] > Math.ceil(values.length * 0.50)) {
    errors.push(`單一顯示分數 ${dominant[0]} 集中 ${dominant[1]}/${values.length}，疑似評分黏底或黏頂`);
  }
  if (values.length >= 6 && displayedCounts.size < 3) errors.push('同場評分有效分布少於 3 個級距');
  if (values.length >= 6 && spread != null && spread < 0.25) errors.push('同場評分差異過小，疑似公式退化');
  if (clampedLowCount > Math.max(1, Math.floor(values.length * 0.25))) errors.push('過多方向命中最低分界');
  if (clampedHighCount > Math.max(1, Math.floor(values.length * 0.25))) errors.push('過多方向命中最高分界');

  return {
    passed: errors.length === 0,
    checkedDirections: values.length,
    minimum,
    maximum,
    spread,
    uniqueDisplayedScores: displayedCounts.size,
    dominantDisplayedScore: dominant[0],
    dominantDisplayedCount: dominant[1],
    clampedLowCount,
    clampedHighCount,
    errors,
  };
}'''
s = replace_once(s, 'export function analyzeMarkets({ context, markets, previousMarkets = [], settings = {} }) {', distribution_audit + '\n\nexport function analyzeMarkets({ context, markets, previousMarkets = [], settings = {} }) {', 'insert score distribution audit')
s = replace_once(s, "        scoreAudit,\n        scoreBand: scoreBand(score),", "        scoreAudit,\n        scoreBreakdown: scoreAudit.breakdown,\n        scoreBand: scoreBand(score),", 'score breakdown result')

old_validation = '''  const scoreValidationFailures = results.flatMap(result => {
    const failures = [];
    if (result.score != null && result.scoreAudit?.ok !== true) failures.push(`${result.market}｜${result.pick}：${(result.scoreAudit?.errors || ['評分驗算未通過']).join('；')}`);
    if (result.pairAudit?.ok === false) failures.push(`${result.market}｜正反方向驗算失敗`);
    return failures;
  });
  const scoreValidation = {
    version: SCORE_CONTRACT_VERSION,
    passed: scoreValidationFailures.length === 0,
    checkedDirections: results.filter(result => result.score != null).length,
    failures: [...new Set(scoreValidationFailures)],
  };'''
new_validation = '''  const distributionAudit = scoreDistributionAudit(results);
  if (!distributionAudit.passed) {
    for (const result of results.filter(row => row.score != null)) {
      result.betEligible = false;
      result.unitSuggestion = 0;
      result.tag = '評分分布驗算失敗｜不下注';
      result.integrityWarning = true;
      result.integrityMessage = [...new Set([result.integrityMessage, ...distributionAudit.errors].filter(Boolean))].join('；');
    }
  }

  const scoreValidationFailures = results.flatMap(result => {
    const failures = [];
    if (result.score != null && result.scoreAudit?.ok !== true) failures.push(`${result.market}｜${result.pick}：${(result.scoreAudit?.errors || ['評分驗算未通過']).join('；')}`);
    if (result.pairAudit?.ok === false) failures.push(`${result.market}｜正反方向驗算失敗`);
    return failures;
  });
  if (!distributionAudit.passed) scoreValidationFailures.push(...distributionAudit.errors.map(error => `評分分布：${error}`));
  const scoreValidation = {
    version: SCORE_CONTRACT_VERSION,
    passed: scoreValidationFailures.length === 0,
    checkedDirections: results.filter(result => result.score != null).length,
    distributionAudit,
    failures: [...new Set(scoreValidationFailures)],
  };'''
s = replace_once(s, old_validation, new_validation, 'score validation block')
p.write_text(s)

# ---------------------------------------------------------------------------
# app/page.js — invalidate old sticky-floor snapshots and show distribution audit.
# ---------------------------------------------------------------------------
p = Path('app/page.js')
s = p.read_text()
s = s.replace("const VERSION = '8.2.5';", "const VERSION = '8.3.0';")
s = s.replace("cached?.visionVersion === 'MLB-VISION-2026-08-v8.2.2'", "cached?.visionVersion === 'MLB-VISION-2026-08-v8.2.5'")
s = s.replace('    && Number(result.score) >= 3.5\n    && Number(result.score) <= 9.4', '    && Number(result.score) >= 1\n    && Number(result.score) <= 9.4')
s = s.replace("  if (!analysis || analysis.scoreContractVersion !== SCORE_CONTRACT_VERSION || analysis.scoreValidation?.passed !== true) return false;", "  if (!analysis || analysis.scoreContractVersion !== SCORE_CONTRACT_VERSION || analysis.scoreValidation?.passed !== true || analysis.scoreValidation?.distributionAudit?.passed !== true) return false;")
old_note = '''            <div className="note">評分驗算：{data.analysis.scoreValidation?.passed ? `通過（${data.analysis.scoreValidation.checkedDirections} 個方向）` : `失敗，已封鎖異常分數（${data.analysis.scoreValidation?.failures?.length || 0} 項）`}｜{data.analysis.scoreContractVersion}</div>'''
new_note = '''            <div className="note">評分驗算：{data.analysis.scoreValidation?.passed ? `通過（${data.analysis.scoreValidation.checkedDirections} 個方向）` : `失敗，已封鎖異常分數（${data.analysis.scoreValidation?.failures?.length || 0} 項）`}｜分布 {data.analysis.scoreValidation?.distributionAudit?.passed ? `通過（${data.analysis.scoreValidation.distributionAudit.uniqueDisplayedScores} 種顯示分數）` : '失敗'}｜{data.analysis.scoreContractVersion}</div>'''
s = replace_once(s, old_note, new_note, 'analysis score note')
p.write_text(s)

# ---------------------------------------------------------------------------
# scripts/scoring-parity.mjs — fixed GPT benchmarks plus the user's screenshot regression.
# ---------------------------------------------------------------------------
Path('scripts/scoring-parity.mjs').write_text(r'''import assert from 'node:assert/strict';
import {
  SCORE_CONTRACT_VERSION,
  scoreEvidenceBreakdown,
  scoreFromCompositeEV,
  validateScoreContract,
} from '../lib/markets.js';

const cases = [
  {
    name: '中性／無優勢',
    cev: 0,
    options: { weightedEV: -0.002, robustEV: -0.015, flipProbability: 0.55, quality: 0.78, edgeStrength: 0, stability: 0.40, modelErrorFloor: 0.025, independentEvidence: 0.50, divergenceRisk: 0.08 },
    range: [4.4, 5.1],
  },
  {
    name: '明顯負 EV',
    cev: -0.035,
    options: { weightedEV: -0.025, robustEV: -0.045, flipProbability: 0.82, quality: 0.82, edgeStrength: -0.55, stability: 0.15, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.12 },
    range: [3.2, 3.9],
  },
  {
    name: '觀察區',
    cev: 0.012,
    options: { weightedEV: 0.018, robustEV: 0.002, flipProbability: 0.40, quality: 0.82, edgeStrength: 0.18, stability: 0.52, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.08 },
    range: [5.2, 6.2],
  },
  {
    name: '下注候選',
    cev: 0.041,
    options: { weightedEV: 0.052, robustEV: 0.043, flipProbability: 0.12, quality: 0.85, edgeStrength: 0.55, stability: 0.80, modelErrorFloor: 0.025, independentEvidence: 0.65, divergenceRisk: 0.05 },
    range: [7.2, 7.9],
  },
  {
    name: '主推',
    cev: 0.061,
    options: { weightedEV: 0.078, robustEV: 0.062, flipProbability: 0.08, quality: 0.88, edgeStrength: 0.70, stability: 0.86, modelErrorFloor: 0.025, independentEvidence: 0.70, divergenceRisk: 0.04 },
    range: [8.0, 8.49],
  },
  {
    name: '最強主推',
    cev: 0.090,
    options: { weightedEV: 0.112, robustEV: 0.086, flipProbability: 0.05, quality: 0.92, edgeStrength: 0.85, stability: 0.90, modelErrorFloor: 0.025, independentEvidence: 0.78, divergenceRisk: 0.03 },
    range: [8.5, 9.4],
  },
  {
    name: '舊版 10 分爆分案例',
    cev: 0.10,
    options: { weightedEV: 0.13, robustEV: 0.1179, flipProbability: 0.06, quality: 0.88, edgeStrength: 0.80, stability: 0.88, modelErrorFloor: 0.025, independentEvidence: 0.70, divergenceRisk: 0.04 },
    range: [8.3, 9.1],
  },
];

for (const row of cases) {
  const score = scoreFromCompositeEV(row.cev, row.options);
  assert.ok(score >= row.range[0] && score <= row.range[1], `${row.name} 分數 ${score.toFixed(3)} 不在 ${row.range.join('～')}`);
  assert.notEqual(score, 0, `${row.name} 不可為 0 分`);
  assert.notEqual(score, 10, `${row.name} 不可為 10 分`);
  const audit = validateScoreContract(score, row.cev, row.options);
  assert.equal(audit.ok, true, `${row.name} 驗算失敗：${audit.errors.join('；')}`);
  assert.ok(Math.abs(audit.expectedScore - score) < 1e-12);
  assert.equal(audit.breakdown.version, SCORE_CONTRACT_VERSION);
}

// 使用者 2026-08-09 截圖的黏底回歸：四個證據組不得再全部變成 3.5。
const screenshotCases = [
  { name: '全場讓分較差側', cev: -0.0758, options: { weightedEV: -0.0122, robustEV: -0.0470, flipProbability: 0.65, quality: 0.85, edgeStrength: -0.10, stability: 0.25, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.08 }, range: [3.5, 4.2] },
  { name: '全場讓分較佳側', cev: -0.0631, options: { weightedEV: -0.0078, robustEV: -0.0423, flipProbability: 0.60, quality: 0.85, edgeStrength: -0.07, stability: 0.30, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.08 }, range: [3.7, 4.4] },
  { name: '全場小分弱正訊號', cev: -0.0309, options: { weightedEV: 0.0226, robustEV: 0.0015, flipProbability: 0.42, quality: 0.85, edgeStrength: 0.15, stability: 0.52, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.05 }, range: [5.0, 5.8] },
  { name: '全場大分明顯負值', cev: -0.1179, options: { weightedEV: -0.0521, robustEV: -0.0729, flipProbability: 0.80, quality: 0.85, edgeStrength: -0.50, stability: 0.12, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.10 }, range: [2.5, 3.5] },
];
const screenshotScores = screenshotCases.map(row => {
  const score = scoreFromCompositeEV(row.cev, row.options);
  assert.ok(score >= row.range[0] && score <= row.range[1], `${row.name} 回歸分數 ${score.toFixed(3)} 不在 ${row.range.join('～')}`);
  return score;
});
assert.ok(screenshotScores[1] > screenshotScores[0], '較佳讓分證據不得與較差側同分');
assert.ok(screenshotScores[2] > screenshotScores[1], '弱正訊號大小盤應高於兩個負 EV 讓分方向');
assert.ok(screenshotScores[3] < screenshotScores[0], '明顯負 EV 應低於一般負 EV');
assert.ok(new Set(screenshotScores.map(value => value.toFixed(1))).size >= 4, `截圖回歸仍黏分：${screenshotScores.map(value => value.toFixed(1)).join(', ')}`);
assert.ok(screenshotScores.filter(value => Math.abs(value - 3.5) < 1e-9).length <= 1, '不可再次大量黏在 3.5');

// 單調性：所有正面證據同步改善時，分數不得下降。
const monotonicRows = [
  { cev: -0.02, weightedEV: -0.03, robustEV: -0.04, flipProbability: 0.75, quality: 0.72, edgeStrength: -0.45, stability: 0.20, independentEvidence: 0.35 },
  { cev: 0.00, weightedEV: -0.005, robustEV: -0.015, flipProbability: 0.55, quality: 0.76, edgeStrength: -0.10, stability: 0.40, independentEvidence: 0.45 },
  { cev: 0.02, weightedEV: 0.025, robustEV: 0.010, flipProbability: 0.35, quality: 0.80, edgeStrength: 0.20, stability: 0.58, independentEvidence: 0.55 },
  { cev: 0.045, weightedEV: 0.055, robustEV: 0.045, flipProbability: 0.15, quality: 0.85, edgeStrength: 0.55, stability: 0.78, independentEvidence: 0.65 },
  { cev: 0.075, weightedEV: 0.09, robustEV: 0.073, flipProbability: 0.08, quality: 0.90, edgeStrength: 0.78, stability: 0.88, independentEvidence: 0.75 },
].map(row => scoreFromCompositeEV(row.cev, { ...row, modelErrorFloor: 0.025, divergenceRisk: 0.05 }));
for (let index = 1; index < monotonicRows.length; index += 1) {
  assert.ok(monotonicRows[index] >= monotonicRows[index - 1] - 1e-12, `單調性失敗：${monotonicRows[index - 1]} → ${monotonicRows[index]}`);
}

// 微小擾動穩定性：正常資料的小幅變動不能讓分數跳一個完整級距。
const baseOptions = { weightedEV: 0.052, robustEV: 0.043, flipProbability: 0.12, quality: 0.85, edgeStrength: 0.55, stability: 0.80, modelErrorFloor: 0.025, independentEvidence: 0.65, divergenceRisk: 0.05 };
const baseScore = scoreFromCompositeEV(0.041, baseOptions);
const perturbations = [
  [0.039, { ...baseOptions, weightedEV: 0.050, robustEV: 0.041 }],
  [0.043, { ...baseOptions, weightedEV: 0.054, robustEV: 0.045 }],
  [0.041, { ...baseOptions, quality: 0.83, stability: 0.77 }],
  [0.041, { ...baseOptions, quality: 0.87, stability: 0.83 }],
];
for (const [cev, options] of perturbations) {
  const score = scoreFromCompositeEV(cev, options);
  assert.ok(Math.abs(score - baseScore) <= 0.45, `微小擾動跳分過大：${baseScore.toFixed(3)} → ${score.toFixed(3)}`);
}

// 連續負 EV 梯度不可因下限而變成同一分數。
const negativeLadder = [-0.12, -0.09, -0.06, -0.04, -0.02, 0].map((cev, index) => scoreFromCompositeEV(cev, {
  weightedEV: cev + 0.01,
  robustEV: cev - 0.005,
  flipProbability: 0.85 - index * 0.10,
  quality: 0.82,
  edgeStrength: -0.70 + index * 0.14,
  stability: 0.12 + index * 0.10,
  modelErrorFloor: 0.025,
  independentEvidence: 0.55,
  divergenceRisk: 0.08,
}));
for (let index = 1; index < negativeLadder.length; index += 1) assert.ok(negativeLadder[index] > negativeLadder[index - 1], `負 EV 梯度未遞增：${negativeLadder}`);
assert.ok(new Set(negativeLadder.map(value => value.toFixed(1))).size >= 5, `負 EV 梯度仍黏分：${negativeLadder}`);

// 硬閘門驗算。
assert.equal(validateScoreContract(7.3, 0.01, { weightedEV: -0.001, robustEV: 0.01 }).ok, false);
assert.equal(validateScoreContract(8.6, 0.04, { weightedEV: 0.06, robustEV: 0.04, flipProbability: 0.25, quality: 0.75, modelErrorFloor: 0.025, independentEvidence: 0.40 }).ok, false);
assert.equal(validateScoreContract(10, 0.10, { weightedEV: 0.13, robustEV: 0.12, flipProbability: 0.03, quality: 0.95, modelErrorFloor: 0.025, independentEvidence: 0.80 }).ok, false);
assert.equal(SCORE_CONTRACT_VERSION, 'GPT-COMPOSITE-EVIDENCE-v8.3');

console.log(JSON.stringify({
  ok: true,
  scoreContractVersion: SCORE_CONTRACT_VERSION,
  benchmarks: cases.map(row => ({ name: row.name, score: scoreFromCompositeEV(row.cev, row.options) })),
  screenshotRegression: screenshotCases.map((row, index) => ({ name: row.name, score: screenshotScores[index], breakdown: scoreEvidenceBreakdown(row.cev, row.options) })),
  negativeLadder,
  perturbationMaximum: Math.max(...perturbations.map(([cev, options]) => Math.abs(scoreFromCompositeEV(cev, options) - baseScore))),
}, null, 2));
''')

# ---------------------------------------------------------------------------
# scripts/test.mjs — update contracts and assert the distribution audit.
# ---------------------------------------------------------------------------
p = Path('scripts/test.mjs')
s = p.read_text()
s = s.replace("assert.ok(neutralScore >= 3.5 && neutralScore <= 5.2);", "assert.ok(neutralScore >= 4.4 && neutralScore <= 5.1);")
s = s.replace("assert.ok(scoreFromCompositeEV(-0.12, { weightedEV: -0.14, robustEV: -0.15, flipProbability: 0.90, quality: 0.80, edgeStrength: -1, stability: 0.10 }) >= 3.5);", "assert.ok(scoreFromCompositeEV(-0.12, { weightedEV: -0.14, robustEV: -0.15, flipProbability: 0.90, quality: 0.80, edgeStrength: -1, stability: 0.10 }) >= 1);")
s = s.replace("assert.equal(SCORE_CONTRACT_VERSION, 'GPT-COMPOSITE-EVIDENCE-v8.2');", "assert.equal(SCORE_CONTRACT_VERSION, 'GPT-COMPOSITE-EVIDENCE-v8.3');")
s = s.replace("assert.ok(analysis.results.every(row => Number.isFinite(row.score) && row.score >= 3.5 && row.score <= 9.4));", "assert.ok(analysis.results.every(row => Number.isFinite(row.score) && row.score >= 1 && row.score <= 9.4));")
s = s.replace("assert.equal(analysis.scoreValidation.passed, true);\nassert.ok(analysis.results.every(row => row.scoreAudit?.ok === true));", "assert.equal(analysis.scoreValidation.passed, true);\nassert.equal(analysis.scoreValidation.distributionAudit?.passed, true);\nassert.ok(analysis.scoreValidation.distributionAudit?.uniqueDisplayedScores >= 3);\nassert.ok(analysis.results.every(row => row.scoreAudit?.ok === true));\nassert.ok(analysis.results.every(row => row.scoreBreakdown?.version === SCORE_CONTRACT_VERSION));")
p.write_text(s)

# ---------------------------------------------------------------------------
# scripts/smoke.mjs — exact Production contract and live anti-clustering check.
# ---------------------------------------------------------------------------
p = Path('scripts/smoke.mjs')
s = p.read_text()
s = s.replace("const VERSION = '8.2.5';", "const VERSION = '8.3.0';")
s = s.replace("const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.2.0';", "const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.3.0';")
s = s.replace("const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.2.0';", "const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.3.0';")
s = s.replace("const SCORE_CONTRACT_VERSION = 'GPT-COMPOSITE-EVIDENCE-v8.2';", "const SCORE_CONTRACT_VERSION = 'GPT-COMPOSITE-EVIDENCE-v8.3';")
s = s.replace('/第\\s*8\\.2\\.5\\s*版/', '/第\\s*8\\.3\\.0\\s*版/')
s = s.replace("assert.ok(analysis.results.every(row => row.score >= 3.5 && row.score <= 9.4 && row.score !== 10 && row.score !== 0));", "assert.ok(analysis.results.every(row => row.score >= 1 && row.score <= 9.4 && row.score !== 10 && row.score !== 0));")
s = s.replace("assert.equal(analysis.scoreValidation.passed, true);\nassert.ok(analysis.results.every(row => row.scoreAudit?.ok === true));", "assert.equal(analysis.scoreValidation.passed, true);\nassert.equal(analysis.scoreValidation.distributionAudit?.passed, true);\nassert.ok(analysis.scoreValidation.distributionAudit?.uniqueDisplayedScores >= 3);\nassert.ok(analysis.results.every(row => row.scoreAudit?.ok === true));\nassert.ok(analysis.results.every(row => row.scoreBreakdown?.version === SCORE_CONTRACT_VERSION));")
p.write_text(s)

# Versions and documentation.
p = Path('package.json'); s = p.read_text().replace('"version": "8.2.5"', '"version": "8.3.0"'); p.write_text(s)
p = Path('app/api/health/route.js'); s = p.read_text().replace("version: '8.2.5'", "version: '8.3.0'"); p.write_text(s)
Path('DEPLOYMENT_VERSION').write_text('8.3.0-score-distribution-validation\n')
p = Path('README.md'); s = p.read_text().replace('# MLB 長期正期望值分析｜第 8.2.5 版', '# MLB 長期正期望值分析｜第 8.3.0 版', 1)
s += '''\n\n## 8.3.0 評分分布與黏底防錯\n\n- 移除舊版 `clamp(score, 3.5, cap)` 造成的大量 3.5 黏底。正式分數仍以 5.0 為中性中心，但負 EV 方向會依加權、穩健、保守 EV、翻負風險、穩定性、資料品質與獨立證據平滑分離。\n- 每個方向保存完整 `scoreBreakdown`，並由 `validateScoreContract` 重新計算固定公式；任何差異直接判定驗算失敗。\n- 每場新增 `distributionAudit`，檢查顯示分數種類、最大同分群、最低／最高界命中數與整體分差。超過一半方向黏在同一個顯示分數時，整場封鎖下注。\n- 加入 2026-08-09 實際畫面回歸案例，固定驗證一般負 EV、較佳負 EV、弱正訊號及明顯負 EV 必須分成不同級距。\n'''
p.write_text(s)

print('v8.3 score distribution patch applied')
