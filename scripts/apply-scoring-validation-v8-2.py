from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text, start_marker, end_marker, replacement, label):
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f'{label}: start marker missing')
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f'{label}: end marker missing')
    return text[:start] + replacement.rstrip() + '\n\n' + text[end:]

# ---------------------------------------------------------------------------
# lib/markets.js — restore bounded GPT-style composite score and hard audit
# ---------------------------------------------------------------------------
p = Path('lib/markets.js')
t = p.read_text()
t = replace_once(
    t,
    "export const MARKET_ORDER = ['全場讓分', '全場大小', '上半讓分', '上半大小'];\n",
    "export const MARKET_ORDER = ['全場讓分', '全場大小', '上半讓分', '上半大小'];\nexport const SCORE_CONTRACT_VERSION = 'GPT-COMPOSITE-EVIDENCE-v8.2';\n",
    'score contract constant',
)

score_block = r'''export function scoreFromCompositeEV(conservativeEV, options = {}) {
  const conservative = Number.isFinite(Number(conservativeEV)) ? Number(conservativeEV) : 0;
  const weightedEV = Number.isFinite(Number(options.weightedEV)) ? Number(options.weightedEV) : conservative;
  const robustEV = Number.isFinite(Number(options.robustEV)) ? Number(options.robustEV) : conservative;
  const flipProbability = clamp(Number(options.flipProbability) || 0, 0, 1);
  const quality = clamp(Number(options.quality ?? options.confidence) || 0.72, 0.35, 1);
  const edgeStrength = clamp(Number(options.edgeStrength) || 0, -1, 1);
  const stability = clamp(Number(options.stability) || (1 - flipProbability), 0, 1);
  const modelErrorFloor = clamp(Number(options.modelErrorFloor) || 0.025, 0.005, 0.08);
  const independentEvidence = clamp(Number(options.independentEvidence) || 0.35, 0.10, 0.90);
  const divergenceRisk = clamp(Number(options.divergenceRisk) || 0, 0, 0.50);
  const integrityWarning = Boolean(options.integrityWarning || options.distributionInvalid);
  const waterEstimated = Boolean(options.waterEstimated);
  const edgeAboveError = conservative - modelErrorFloor;

  // GPT-style evidence score: EV matters, but it is saturated and combined with
  // robustness, uncertainty, data quality and model error. CEV is not a direct
  // linear 0–10 conversion.
  let score = 5.00;
  score += 0.95 * smooth(weightedEV, 0.055);
  score += 1.05 * smooth(robustEV, 0.045);
  score += 0.60 * smooth(edgeAboveError, 0.030);
  score += 0.55 * edgeStrength;
  score += 0.35 * ((stability - 0.5) * 2);
  score += 0.22 * ((quality - 0.70) / 0.30);
  score += 0.18 * ((independentEvidence - 0.40) / 0.45);
  score -= 0.45 * flipProbability;
  score -= 0.20 * divergenceRisk;

  let cap = 9.4;
  if (integrityWarning || waterEstimated) cap = 6.6;
  else if (weightedEV <= 0) cap = 6.6;
  else if (robustEV <= 0 || conservative <= 0) cap = 7.1;
  else if (conservative <= modelErrorFloor) cap = 7.4;
  else {
    if (robustEV < modelErrorFloor + 0.012 || conservative < modelErrorFloor + 0.004) cap = Math.min(cap, 7.4);
    else if (robustEV < modelErrorFloor + 0.027 || conservative < modelErrorFloor + 0.014) cap = Math.min(cap, 7.9);
    else if (robustEV < modelErrorFloor + 0.050 || conservative < modelErrorFloor + 0.030) cap = Math.min(cap, 8.4);

    if (flipProbability > 0.35) cap = Math.min(cap, 7.4);
    else if (flipProbability > 0.25) cap = Math.min(cap, 7.9);
    else if (flipProbability > 0.15) cap = Math.min(cap, 8.4);

    if (cap > 8.4 && (
      independentEvidence < 0.55
      || quality < 0.78
      || flipProbability > 0.12
      || edgeAboveError < 0.035
    )) cap = 8.4;
  }

  return clamp(score, 3.5, cap);
}

export function validateScoreContract(score, conservativeEV, options = {}) {
  const errors = [];
  const value = Number(score);
  const conservative = Number(conservativeEV);
  const weightedEV = Number(options.weightedEV);
  const robustEV = Number(options.robustEV);
  const flipProbability = clamp(Number(options.flipProbability) || 0, 0, 1);
  const quality = clamp(Number(options.quality ?? options.confidence) || 0.72, 0.35, 1);
  const modelErrorFloor = clamp(Number(options.modelErrorFloor) || 0.025, 0.005, 0.08);
  const independentEvidence = clamp(Number(options.independentEvidence) || 0.35, 0.10, 0.90);
  const integrityWarning = Boolean(options.integrityWarning || options.distributionInvalid);
  const waterEstimated = Boolean(options.waterEstimated);

  if (!Number.isFinite(value)) errors.push('評分不是有限數值');
  if (Number.isFinite(value) && (value < 3.5 - 1e-9 || value > 9.4 + 1e-9)) errors.push('評分超出 3.5～9.4 正式尺度');
  if (Number.isFinite(value) && (Math.abs(value) < 1e-9 || Math.abs(value - 10) < 1e-9)) errors.push('正式評分不可直接落在 0 或 10');
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
  };
}'''
t = replace_between(t, 'export function scoreFromCompositeEV(', '// Backward-compatible wrapper', score_block, 'replace scoring block')
p.write_text(t)

# ---------------------------------------------------------------------------
# lib/analysis.js — runtime verification, pair audit, and no false 0/10 output
# ---------------------------------------------------------------------------
p = Path('lib/analysis.js')
t = p.read_text()
t = replace_once(t, '  resultTag,\n  scoreFromCompositeEV,', '  resultTag,\n  SCORE_CONTRACT_VERSION,\n  scoreFromCompositeEV,\n  validateScoreContract,', 'analysis scoring imports')
t = t.replace("export const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.1.0';", "export const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.2.0';")
t = t.replace("export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.1.0';", "export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.2.0';")

old_score_call = '''      let score = scoreFromCompositeEV(conservativeEV, {
        weightedEV,
        robustEV: robust.robustEV,
        flipProbability: evFlipProbability,
        quality: profile.quality,
        edgeStrength,
        stability,
        integrityWarning: integrity.warning,
        waterEstimated,
        modelErrorFloor: profile.modelErrorFloor,
        independentEvidence: profile.independentEvidenceStrength,
        divergenceRisk: calibration.divergenceRisk,
        expertUsed: profile.expertLayerUsed,
      });
      const eligibleByEV = weightedEV > 0 && robust.robustEV > 0;'''
new_score_call = '''      let score = scoreFromCompositeEV(conservativeEV, {
        weightedEV,
        robustEV: robust.robustEV,
        flipProbability: evFlipProbability,
        quality: profile.quality,
        edgeStrength,
        stability,
        integrityWarning: integrity.warning,
        waterEstimated,
        modelErrorFloor: profile.modelErrorFloor,
        independentEvidence: profile.independentEvidenceStrength,
        divergenceRisk: calibration.divergenceRisk,
        expertUsed: profile.expertLayerUsed,
      });
      const scoreAudit = validateScoreContract(score, conservativeEV, {
        weightedEV,
        robustEV: robust.robustEV,
        flipProbability: evFlipProbability,
        quality: profile.quality,
        integrityWarning: integrity.warning,
        waterEstimated,
        modelErrorFloor: profile.modelErrorFloor,
        independentEvidence: profile.independentEvidenceStrength,
      });
      const scoreAuditFailed = !scoreAudit.ok;
      if (scoreAuditFailed) score = null;
      const eligibleByEV = weightedEV > 0 && robust.robustEV > 0 && conservativeEV > 0;'''
t = replace_once(t, old_score_call, new_score_call, 'analysis score audit')
t = replace_once(
    t,
    '      const betEligible = !waterEstimated && !integrity.warning && eligibleByEV && score >= candidateThreshold;',
    '      const betEligible = !waterEstimated && !integrity.warning && !scoreAuditFailed && eligibleByEV && score != null && score >= candidateThreshold;',
    'analysis eligibility audit gate',
)
t = t.replace("        scoreFormulaVersion: 'CEV20-5+50x-v1',", '        scoreFormulaVersion: SCORE_CONTRACT_VERSION,')
t = replace_once(t, '        integrityWarning: integrity.warning,', '        integrityWarning: integrity.warning || scoreAuditFailed,', 'result integrity warning')
t = replace_once(t, '        integrityMessage: integrity.message,', "        integrityMessage: scoreAuditFailed ? scoreAudit.errors.join('；') : integrity.message,", 'result integrity message')
t = replace_once(t, '        score,\n        scoreBand:', '        score,\n        scoreContractVersion: SCORE_CONTRACT_VERSION,\n        scoreAudit,\n        scoreBand:', 'result score audit metadata')
t = replace_once(
    t,
    "        tag: integrity.warning ? '模型異常｜不下注' : waterEstimated ? '暫估水位｜觀察' : resultTag(score, candidateThreshold, strongestThreshold),",
    "        tag: scoreAuditFailed ? '評分驗算失敗｜PASS' : integrity.warning ? '模型異常｜不下注' : waterEstimated ? '暫估水位｜觀察' : resultTag(score, candidateThreshold, strongestThreshold),",
    'result audit tag',
)

pair_start = t.find('    if (pair.length === 2) {')
pair_end_marker = '    }\n  }\n\n  const portfolio = buildPortfolio'
pair_end = t.find(pair_end_marker, pair_start)
if pair_start < 0 or pair_end < 0:
    raise SystemExit('pair audit block markers missing')
pair_block = r'''    if (pair.length === 2) {
      const complementError = Math.abs(pair[0].modelProbability + pair[1].modelProbability - 1);
      if (complementError > 0.012) {
        for (const result of pair) {
          result.integrityWarning = true;
          result.integrityMessage = '同市場兩方向機率未互補';
          result.score = null;
          result.tag = '模型異常｜不下注';
          result.betEligible = false;
          result.unitSuggestion = 0;
        }
      }

      const eligiblePair = pair.filter(result => result.betEligible);
      if (eligiblePair.length > 1) {
        const keep = [...eligiblePair].sort((left, right) => right.conservativeEV - left.conservativeEV || right.score - left.score)[0];
        for (const result of eligiblePair) {
          if (result === keep) continue;
          result.betEligible = false;
          result.unitSuggestion = 0;
          result.tag = '同市場次選｜不重複下注';
        }
      }

      const finiteScores = pair.map(result => Number(result.score)).filter(Number.isFinite);
      const scoreSpread = finiteScores.length === 2 ? Math.abs(finiteScores[0] - finiteScores[1]) : null;
      const pairAudit = {
        ok: complementError <= 0.012 && pair.filter(result => result.betEligible).length <= 1,
        complementError,
        scoreSpread,
        eligibleDirections: pair.filter(result => result.betEligible).length,
      };
      for (const result of pair) result.pairAudit = pairAudit;
    }'''
t = t[:pair_start] + pair_block + '\n  }\n\n  const portfolio = buildPortfolio' + t[pair_end + len(pair_end_marker):]

portfolio_marker = '  const portfolio = buildPortfolio(results, combinedJointCells, context, rebateRate);'
validation_code = '''  const scoreValidationFailures = results.flatMap(result => {
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
  };

'''
t = replace_once(t, portfolio_marker, validation_code + portfolio_marker, 'analysis validation summary')
t = replace_once(t, '    modelVersion: MODEL_VERSION,\n    rulesVersion: RULES_VERSION,', '    modelVersion: MODEL_VERSION,\n    rulesVersion: RULES_VERSION,\n    scoreContractVersion: SCORE_CONTRACT_VERSION,\n    scoreValidation,', 'analysis return validation')
t = t.replace("        { name: '實際開盤市場與單邊水位', status: '已實作；僅作價格/EV，不回灌過盤率' },", "        { name: '實際開盤市場與單邊水位', status: '已實作；有限市場先驗校準＋實際價格 EV' },")
t = t.replace("        { name: 'GPT 結構化研究判讀層', status: profile.expertLayerUsed ? '已使用' : '統計備援' },", "        { name: 'GPT 結構化研究判讀層', status: profile.expertLayerUsed ? '已使用' : '統計備援' },\n        { name: '評分雙層驗算與基準案例', status: scoreValidation.passed ? '已通過' : '失敗並封鎖下注' },")
p.write_text(t)

# ---------------------------------------------------------------------------
# app/page.js — visible validation status and complete evidence line
# ---------------------------------------------------------------------------
p = Path('app/page.js')
t = p.read_text().replace("const VERSION = '8.1.0';", "const VERSION = '8.2.0';")
t = replace_once(
    t,
    "            <div className=\"starterLine\">先發：{data.context?.away?.starter?.name || lock.game?.awayProbable || '未公布'} 對 {data.context?.home?.starter?.name || lock.game?.homeProbable || '未公布'}</div>",
    "            <div className=\"starterLine\">先發：{data.context?.away?.starter?.name || lock.game?.awayProbable || '未公布'} 對 {data.context?.home?.starter?.name || lock.game?.homeProbable || '未公布'}</div>\n            <div className=\"note\">評分驗算：{data.analysis.scoreValidation?.passed ? `通過（${data.analysis.scoreValidation.checkedDirections} 個方向）` : `失敗，已封鎖異常分數（${data.analysis.scoreValidation?.failures?.length || 0} 項）`}｜{data.analysis.scoreContractVersion}</div>",
    'analysis validation banner',
)
t = replace_once(
    t,
    "    {score != null && <div className=\"classicMeta\">穩健 EV {pct(result.robustEV)}｜建議 {unit} Unit</div>}",
    "    {score != null && <div className=\"classicMeta\">加權 EV {pct(result.weightedEV)}｜穩健 EV {pct(result.robustEV)}｜保守 EV {pct(result.conservativeEV)}｜驗算 {result.scoreAudit?.ok ? '通過' : '失敗'}｜建議 {unit} Unit</div>}\n    {result.scoreAudit?.ok === false && <div className=\"classicMeta\">評分已封鎖：{result.scoreAudit.errors?.join('；')}</div>}",
    'classic score validation display',
)
t = replace_once(
    t,
    "        <small>模型誤差門檻 {pct(result.modelErrorFloor)}｜獨立資料強度 {pct(result.independentEvidenceStrength)}｜分歧風險 {pct(result.divergenceRisk)}｜合理水位 {result.fairWater?.toFixed?.(3) || '—'}</small>",
    "        <small>模型誤差門檻 {pct(result.modelErrorFloor)}｜獨立資料強度 {pct(result.independentEvidenceStrength)}｜分歧風險 {pct(result.divergenceRisk)}｜合理水位 {result.fairWater?.toFixed?.(3) || '—'}</small>\n        <small>評分驗算 {result.scoreAudit?.ok ? '通過' : '失敗'}｜規則 {result.scoreContractVersion || result.scoreFormulaVersion || '—'}｜正反方向分差 {result.pairAudit?.scoreSpread == null ? '—' : Number(result.pairAudit.scoreSpread).toFixed(1)}</small>",
    'result validation detail',
)
p.write_text(t)

# ---------------------------------------------------------------------------
# health/version/package/readme
# ---------------------------------------------------------------------------
p = Path('app/api/health/route.js')
t = p.read_text()
t = replace_once(t, "import { BATCH_VERSION } from '../../../lib/batch.js';", "import { BATCH_VERSION } from '../../../lib/batch.js';\nimport { SCORE_CONTRACT_VERSION } from '../../../lib/markets.js';", 'health scoring import')
t = t.replace("version: '8.1.0'", "version: '8.2.0'")
t = replace_once(t, '    batchVersion: BATCH_VERSION,', '    batchVersion: BATCH_VERSION,\n    scoreContractVersion: SCORE_CONTRACT_VERSION,', 'health score contract')
p.write_text(t)

p = Path('package.json')
t = p.read_text().replace('"version": "8.1.0"', '"version": "8.2.0"')
t = t.replace('"test": "node scripts/test.mjs && node scripts/security-test.mjs"', '"test": "node scripts/scoring-parity.mjs && node scripts/test.mjs && node scripts/security-test.mjs"')
p.write_text(t)

Path('DEPLOYMENT_VERSION').write_text('8.2.0-scoring-validation-gpt-parity\n')
p = Path('README.md')
t = p.read_text().replace('# MLB 長期正期望值分析｜第 8.1.0 版', '# MLB 長期正期望值分析｜第 8.2.0 版', 1)
t += '''\n\n### 8.2.0 評分驗算與防呆\n\n撤除會把 CEV 直接線性換成 0 或 10 分的公式。正式評分改回 GPT 證據型綜合尺度：同時使用加權 EV、穩健 EV、保守 EV、翻負機率、資料品質、模型誤差、獨立證據與市場分歧，分數限制在 3.5～9.4。每個方向在輸出前都執行評分契約驗算；7.2+、8.5+ 各有硬性證據門檻，驗算失敗即不顯示分數且封鎖下注。CI 額外執行固定基準案例、單調性、微小擾動穩定性、正反方向互補、決定性與正式站 smoke test。\n'''
p.write_text(t)

# ---------------------------------------------------------------------------
# scripts/test.mjs — replace linear formula assertions with contract tests
# ---------------------------------------------------------------------------
p = Path('scripts/test.mjs')
t = p.read_text()
t = replace_once(t, '  resultTag,\n  scoreFromCompositeEV,', '  resultTag,\n  SCORE_CONTRACT_VERSION,\n  scoreFromCompositeEV,\n  validateScoreContract,', 'unit score imports')
start = t.find('assert.equal(scoreFromCompositeEV(0, { weightedEV: 0.01, robustEV: 0.01 }), 5);')
end = t.find("assert.equal(resultTag(6.9), '觀察');", start)
if start < 0 or end < 0:
    raise SystemExit('direct score tests markers missing')
end += len("assert.equal(resultTag(6.9), '觀察');")
score_tests = r'''const neutralScore = scoreFromCompositeEV(0, { weightedEV: -0.002, robustEV: -0.015, flipProbability: 0.55, quality: 0.78, edgeStrength: 0, stability: 0.40, modelErrorFloor: 0.025, independentEvidence: 0.50, divergenceRisk: 0.08 });
assert.ok(neutralScore >= 3.5 && neutralScore <= 5.2);
const candidateScore = scoreFromCompositeEV(0.041, { weightedEV: 0.052, robustEV: 0.043, flipProbability: 0.12, quality: 0.85, edgeStrength: 0.55, stability: 0.80, modelErrorFloor: 0.025, independentEvidence: 0.65, divergenceRisk: 0.05 });
assert.ok(candidateScore >= 7.2 && candidateScore < 8.0);
const strongestScore = scoreFromCompositeEV(0.090, { weightedEV: 0.112, robustEV: 0.086, flipProbability: 0.05, quality: 0.92, edgeStrength: 0.85, stability: 0.90, modelErrorFloor: 0.025, independentEvidence: 0.78, divergenceRisk: 0.03 });
assert.ok(strongestScore >= 8.5 && strongestScore <= 9.4);
const oldExplosiveCase = scoreFromCompositeEV(0.10, { weightedEV: 0.13, robustEV: 0.1179, flipProbability: 0.06, quality: 0.88, edgeStrength: 0.80, stability: 0.88, modelErrorFloor: 0.025, independentEvidence: 0.70, divergenceRisk: 0.04 });
assert.ok(oldExplosiveCase >= 8.2 && oldExplosiveCase < 9.4);
assert.notEqual(oldExplosiveCase, 10);
assert.ok(scoreFromCompositeEV(-0.12, { weightedEV: -0.14, robustEV: -0.15, flipProbability: 0.90, quality: 0.80, edgeStrength: -1, stability: 0.10 }) >= 3.5);
assert.ok(scoreFromCompositeEV(0.01, { weightedEV: 0.02, robustEV: -0.001 }) <= 7.1);
assert.ok(scoreFromCompositeEV(0.12, { weightedEV: 0.15, robustEV: 0.10, waterEstimated: true }) <= 6.6);
assert.equal(validateScoreContract(candidateScore, 0.041, { weightedEV: 0.052, robustEV: 0.043, flipProbability: 0.12, quality: 0.85, modelErrorFloor: 0.025, independentEvidence: 0.65 }).ok, true);
assert.equal(validateScoreContract(10, 0.10, { weightedEV: 0.13, robustEV: 0.12, flipProbability: 0.03, quality: 0.95, modelErrorFloor: 0.025, independentEvidence: 0.80 }).ok, false);
assert.equal(SCORE_CONTRACT_VERSION, 'GPT-COMPOSITE-EVIDENCE-v8.2');
assert.equal(resultTag(8.5), '最強主推');
assert.equal(resultTag(8.1), '主推');
assert.equal(resultTag(7.6), '正常下注');
assert.equal(resultTag(7.3), '小注候選');
assert.equal(resultTag(6.9), '觀察');'''
t = t[:start] + score_tests + t[end:]
t = t.replace('assert.ok(analysis.results.every(row => Number.isFinite(row.score) && row.score >= 0 && row.score <= 10));', 'assert.ok(analysis.results.every(row => Number.isFinite(row.score) && row.score >= 3.5 && row.score <= 9.4));')
t = t.replace("assert.ok(analysis.results.every(row => row.scoreFormulaVersion === 'CEV20-5+50x-v1'));", 'assert.ok(analysis.results.every(row => row.scoreFormulaVersion === SCORE_CONTRACT_VERSION));\nassert.equal(analysis.scoreContractVersion, SCORE_CONTRACT_VERSION);\nassert.equal(analysis.scoreValidation.passed, true);\nassert.ok(analysis.results.every(row => row.scoreAudit?.ok === true));')
t = t.replace("  assert.ok(!(Number(pair[0].score) > 5 && Number(pair[1].score) > 5), `${marketName} 相反方向不可同時高於5分`);", "  assert.ok(Math.abs(pair[0].score - pair[1].score) <= 5.900001, `${marketName} 分數超出正式尺度`);\n  assert.ok(pair.every(row => row.pairAudit?.ok === true), `${marketName} 正反方向驗算失敗`);")
old_loop = '''for (const result of analysis.results.filter(row => row.marketAnchorProbability != null)) {
  assert.equal(result.marketCalibrationApplied, true);
  assert.ok(result.marketCalibrationWeight >= 0.12 && result.marketCalibrationWeight <= 0.55);
  assert.ok(result.maximumCalibratedProbabilityEdge >= 0.05 && result.maximumCalibratedProbabilityEdge <= 0.12);
  assert.ok(result.calibratedMarketProbabilityGap <= result.maximumCalibratedProbabilityEdge + 1e-10);
  const expected = Math.min(result.integrityWarning || result.waterEstimated ? 6.6 : result.weightedEV <= 0 ? 6.6 : result.robustEV <= 0 ? 7.1 : 10, Math.max(0, Math.min(10, 5 + 50 * result.cev)));
  assert.ok(Math.abs(result.score - expected) < 1e-12);
}'''
new_loop = '''for (const result of analysis.results.filter(row => row.marketAnchorProbability != null)) {
  assert.equal(result.marketCalibrationApplied, true);
  assert.ok(result.marketCalibrationWeight >= 0.12 && result.marketCalibrationWeight <= 0.55);
  assert.ok(result.maximumCalibratedProbabilityEdge >= 0.05 && result.maximumCalibratedProbabilityEdge <= 0.12);
  assert.ok(result.calibratedMarketProbabilityGap <= result.maximumCalibratedProbabilityEdge + 1e-10);
  assert.equal(result.scoreAudit?.ok, true);
  assert.equal(result.scoreContractVersion, SCORE_CONTRACT_VERSION);
  if (result.score >= 7.2) assert.ok(result.weightedEV > 0 && result.robustEV > 0 && result.conservativeEV > 0);
  if (result.score >= 8.5) assert.ok(result.evFlipProbability <= 0.12 && result.confidence >= 0.78 && result.independentEvidenceStrength >= 0.55);
}'''
t = replace_once(t, old_loop, new_loop, 'analysis score contract assertions')
p.write_text(t)

# ---------------------------------------------------------------------------
# scripts/smoke.mjs — verify live score contract, no 0/10, and audit pass
# ---------------------------------------------------------------------------
p = Path('scripts/smoke.mjs')
t = p.read_text()
t = t.replace("const VERSION = '8.1.0';", "const VERSION = '8.2.0';")
t = t.replace("const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.1.0';", "const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.2.0';")
t = t.replace("const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.1.0';", "const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.2.0';")
t = replace_once(t, "const BATCH_VERSION = 'MLB-AUTO-ANALYZE-ALL-2026-08-v1';", "const BATCH_VERSION = 'MLB-AUTO-ANALYZE-ALL-2026-08-v1';\nconst SCORE_CONTRACT_VERSION = 'GPT-COMPOSITE-EVIDENCE-v8.2';", 'smoke score contract constant')
t = replace_once(t, '        && value.batchVersion === BATCH_VERSION', '        && value.batchVersion === BATCH_VERSION\n        && value.scoreContractVersion === SCORE_CONTRACT_VERSION', 'smoke wait score contract')
t = replace_once(t, 'assert.equal(health.batchVersion, BATCH_VERSION);', 'assert.equal(health.batchVersion, BATCH_VERSION);\nassert.equal(health.scoreContractVersion, SCORE_CONTRACT_VERSION);', 'smoke health score contract')
t = t.replace('/第\\s*8\\.1\\.0\\s*版/', '/第\\s*8\\.2\\.0\\s*版/')
t = replace_once(
    t,
    'assert.ok(analysis.results.every(row => Math.abs(row.score - Math.min(row.integrityWarning || row.waterEstimated ? 6.6 : row.weightedEV <= 0 ? 6.6 : row.robustEV <= 0 ? 7.1 : 10, Math.max(0, Math.min(10, 5 + 50 * row.cev)))) < 1e-12));',
    "assert.equal(analysis.scoreContractVersion, SCORE_CONTRACT_VERSION);\nassert.equal(analysis.scoreValidation.passed, true);\nassert.ok(analysis.results.every(row => row.scoreAudit?.ok === true));\nassert.ok(analysis.results.every(row => row.score >= 3.5 && row.score <= 9.4 && row.score !== 10 && row.score !== 0));",
    'smoke score validation assertions',
)
p.write_text(t)

print('v8.2 scoring validation patch applied')
