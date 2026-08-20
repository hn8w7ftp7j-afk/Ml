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

// 6) UI: never present unqualified extreme raw EV as valid W/R, and hide
// unvalidated Asian-league EV/S values until their independent models exist.
{
  const path = 'app/page.js';
  let source = read(path);
  source = replaceExact(source, "const VERSION = '10.2.3';", "const VERSION = '10.3.0';", 'app version');
  source = replaceExact(
    source,
    "  if (formulaScore == null) return { icon: '⛔', label: '無法評分', ranking: false, reason: '缺少合法水位或雙EV' };",
    "  if (row?.evCalibration?.qualified === false) return { icon: '⚠️', label: 'EV校準阻擋', ranking: false, reason: '極端EV或獨立市場先驗未通過' };\n  if (formulaScore == null) return { icon: '⛔', label: '無法評分', ranking: false, reason: '缺少合法水位或雙EV' };",
    'calibration verdict',
  );
  source = replaceExact(
    source,
    "  const leagueValidated = row?.scoreStatus !== 'LEAGUE_MODEL_NOT_VALIDATED';\n  const qaFailures = scoreQaFailures(row);",
    "  const leagueValidated = row?.scoreStatus !== 'LEAGUE_MODEL_NOT_VALIDATED';\n  const calibrationBlocked = row?.evCalibration?.qualified === false;\n  const rawWeightedEV = Number.isFinite(Number(row?.rawWeightedEV)) ? Number(row.rawWeightedEV) : null;\n  const rawRobustEV = Number.isFinite(Number(row?.rawRobustEV)) ? Number(row.rawRobustEV) : null;\n  const qaFailures = scoreQaFailures(row);",
    'calibration UI state',
  );
  source = replaceExact(
    source,
    `  const scoreTitle = formulaScore == null
    ? '缺少合法水位或雙EV，不能補造分數'
    : !leagueValidated
      ? \`固定雙EV公式 S 分數 \${formulaScore.toFixed(1)}｜聯盟模型尚未獨立驗證｜不列排名、不可視為推薦\`
      : !qaPassed
        ? \`固定雙EV公式 S 分數 \${formulaScore.toFixed(1)}｜QA BLOCK｜不列排名、不可視為推薦\`
        : \`V10.2固定雙EV公式 S 分數 \${formulaScore.toFixed(1)}｜QA PASS｜不可視為正式下注建議\`;`,
    `  const scoreTitle = !leagueValidated
    ? '聯盟模型重建中｜EV與S分數暫停顯示'
    : calibrationBlocked
      ? \`原始模型EV未通過校準｜W \${pct(rawWeightedEV)}｜R \${pct(rawRobustEV)}｜不建立S分數\`
      : formulaScore == null
        ? '缺少合法水位或雙EV，不能補造分數'
        : !qaPassed
          ? \`固定雙EV公式 S 分數 \${formulaScore.toFixed(1)}｜QA BLOCK｜不列排名、不可視為推薦\`
          : \`V10.3固定雙EV公式 S 分數 \${formulaScore.toFixed(1)}｜QA PASS｜不可視為正式下注建議\`;`,
    'score title calibration',
  );
  source = replaceExact(
    source,
    "  const scoreLabel = formulaScore == null ? '—' : formulaScore.toFixed(1);",
    "  const scoreLabel = !leagueValidated || formulaScore == null ? '—' : formulaScore.toFixed(1);",
    'hide unvalidated league S score',
  );
  source = replaceExact(
    source,
    "  const exact = betState?.exact || null;",
    "  const scoreMetaText = !leagueValidated\n    ? '聯盟模型重建中｜EV與S分數暫停顯示'\n    : calibrationBlocked\n      ? `V10.3原始模型勝率 ${pct(row.modelProbability)}｜損益兩平 ${pct(breakEven)}｜原始W ${pct(rawWeightedEV)}｜原始R ${pct(rawRobustEV)}｜EV校準未通過，不建立加權EV／穩健EV`\n      : `V10.3棒球分布勝率 ${pct(row.modelProbability)}｜損益兩平 ${pct(breakEven)}｜加權EV ${pct(row.weightedEV)}｜穩健EV ${pct(row.robustEV)}`;\n  const exact = betState?.exact || null;",
    'score meta text',
  );
  source = replaceExact(
    source,
    '      <div className="scoreMeta">V10.2棒球分布勝率 {pct(row.modelProbability)}｜損益兩平 {pct(breakEven)}｜加權EV {pct(row.weightedEV)}｜穩健EV {pct(row.robustEV)}</div>',
    '      <div className="scoreMeta">{scoreMetaText}</div>',
    'score meta render',
  );
  source = replaceExact(source, '<div className="sourceBanner"><strong>V10.2 完整方向評估</strong>', '<div className="sourceBanner"><strong>V10.3 EV校準安全評估</strong>', 'game card banner');
  write(path, source);
}
