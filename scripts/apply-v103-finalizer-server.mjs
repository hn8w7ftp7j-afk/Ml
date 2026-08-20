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

// 4) The finalizer uses only qualified W/R. Tai888 probability gap remains a
// diagnostic and is no longer a false hard QA rule for hole contracts.
{
  const path = 'lib/deterministic-finalizer-v10.js';
  let source = read(path);
  source = replaceExact(source, "export const FINAL_ENGINE_VERSION = 'BASEBALL-DETERMINISTIC-SHADOW-2026-08-v10.2.0';", "export const FINAL_ENGINE_VERSION = 'BASEBALL-DETERMINISTIC-SHADOW-2026-08-v10.3.0';", 'finalizer version');
  source = replaceExact(source, "export const UNCERTAINTY_SET_VERSION = 'BASEBALL-GH27-Q10-DATA-MARGIN-DIAGNOSTIC-UNCALIBRATED-v1.1.0';", "export const UNCERTAINTY_SET_VERSION = 'BASEBALL-GH27-Q10-DATA-MARGIN-INDEPENDENT-PRIOR-v1.2.0';", 'uncertainty version');
  source = replaceExact(
    source,
    "  if (Number.isFinite(Number(row.rawMarketProbabilityGap)) && Number(row.rawMarketProbabilityGap) >= 0.20) {\n    failures.push('棒球模型與Tai888去水市場差距達20%以上，需BLOCK而非調低分數');\n  }",
    "  if (row.evCalibration?.qualified === false) {\n    failures.push(`EV校準未通過：${(row.evCalibration?.reasons || []).join('；') || '極端EV或獨立市場先驗未通過'}`);\n  }",
    'replace false Tai888 probability gate',
  );
  source = replaceExact(
    source,
    "      const missingReason = !weightedCalculable || !robustCalculable ? '雙EV不是有限數值' : '水位未提供';",
    "      const missingReason = row.evCalibration?.qualified === false\n        ? `EV校準未通過：${(row.evCalibration?.reasons || []).join('；') || '極端EV或獨立市場先驗未通過'}`\n        : !weightedCalculable || !robustCalculable ? '雙EV不是有限數值' : '水位未提供';",
    'uns cored calibration reason',
  );
  source = replaceCount(source, 'V10固定雙EV短板公式｜影子模式', 'V10.3校準合格雙EV短板公式｜影子模式', 1, 'uns cored score source');
  source = replaceExact(source, "'Raw W EV未大於0'", "'加權EV未大於0'", 'ranking W wording');
  source = replaceExact(source, "'保守 R EV未大於0'", "'穩健EV未大於0'", 'ranking R wording');
  source = replaceExact(source, "row.scoreSource = 'V10 Raw Weighted/Robust EV固定雙EV短板公式｜影子模式';", "row.scoreSource = 'V10.3 Qualified Weighted/Robust EV固定雙EV短板公式｜影子模式';", 'qualified score source');
  source = replaceExact(
    source,
    '    row.scoreBreakdown = {\n      formulaVersion: SCORE_FORMULA_VERSION,\n      policyVersion: SCORE_POLICY_VERSION,\n      weightedEV: row.weightedEV,\n      robustEV: row.robustEV,\n      band: scoreResult.band,',
    '    row.scoreBreakdown = {\n      formulaVersion: SCORE_FORMULA_VERSION,\n      policyVersion: SCORE_POLICY_VERSION,\n      weightedEV: row.weightedEV,\n      robustEV: row.robustEV,\n      rawWeightedEV: row.rawWeightedEV,\n      rawRobustEV: row.rawRobustEV,\n      evCalibration: row.evCalibration || null,\n      band: scoreResult.band,',
    'score breakdown calibration',
  );
  source = replaceExact(source, "row.unitStatus = 'V10 Shadow｜正式Unit停用';", "row.unitStatus = 'V10.3 Shadow｜正式Unit停用';", 'unit status');
  source = replaceExact(
    source,
    "row.modelErrorStatus = '已納入情境Q10與資料誤差margin；該範圍尚未locked OOS校準，只作Shadow敏感度診斷';",
    "row.modelErrorStatus = '已納入情境Q10、資料誤差margin與可用的獨立同合約先驗；尚未locked OOS校準，仍只作Shadow診斷';",
    'model error status',
  );
  source = replaceExact(
    source,
    "      targetMarketCalibration: '停用；Tai888只作成交payoff',",
    "      targetMarketCalibration: '停用；Tai888只作成交payoff',\n      evCalibration: '極端EV需獨立半分盤去水先驗確認；不合格則不建立W/R與S分數',",
    'risk audit calibration',
  );
  write(path, source);
}

// 5) Server uses v2 independent reference verification and a clean cache namespace.
{
  const path = 'app/api/analyze/route.js';
  let source = read(path);
  source = replaceExact(source, "import { applyIndependentMarketVerification } from '../../../lib/market-verification-v1.js';", "import { applyIndependentMarketVerification } from '../../../lib/market-verification-v2.js';", 'market verification v2 import');
  source = replaceExact(source, '// A new namespace intentionally discards the poisoned v9.1-v9.3 runtime cache.', '// v10.3 namespace invalidates every pre-calibration model response.');
  source = replaceCount(source, '__BASEBALL_V960_ANALYSIS_CACHE__', '__BASEBALL_V1030_ANALYSIS_CACHE__', 2, 'analysis cache namespace');
  write(path, source);
}
