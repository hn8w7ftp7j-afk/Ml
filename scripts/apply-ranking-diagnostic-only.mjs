import fs from 'node:fs';

const path = 'app/page.js';
let source = fs.readFileSync(path, 'utf8');
const oldFilter = `      && row.evCalibration?.qualified === true
      && row.shadowDiagnosticScore != null
      && Number.isFinite(Number(row.shadowDiagnosticScore))
      && row.scoreAudit?.ok === true
      && row.pairAudit?.passed !== false
      && row.scoreStatus === 'SHADOW_DIAGNOSTIC_UNCALIBRATED'
      && row.evCalibration?.scenarioStable === true
      && row.evCalibration?.extreme !== true
      && Number(row.weightedEV) > 0
      && Number(row.robustEV) > 0
      && Number(row.shadowDiagnosticScore) >= 7.2)`;
const newFilter = `      && row.formulaDiagnosticScore != null
      && Number.isFinite(Number(row.formulaDiagnosticScore)))`;
if (!source.includes(oldFilter)) throw new Error('ranking filter anchor missing');
source = source.replace(oldFilter, newFilter);
source = source.replace(`      water: row.water, score: Number(row.shadowDiagnosticScore), weightedEV: row.weightedEV, robustEV: row.robustEV })))`, `      water: row.water, score: Number(row.formulaDiagnosticScore), weightedEV: row.weightedEV, robustEV: row.robustEV,
      warning: row.evCalibration?.qualified !== true || row.scoreAudit?.ok !== true || row.pairAudit?.passed === false || row.evCalibration?.scenarioStable === false || row.evCalibration?.extreme === true })))`);
source = source.replace(`模型W {pct(entry.weightedEV)}｜模型穩健R {pct(entry.robustEV)}｜資料QA PASS｜影子診斷、非正式推薦`, `模型W {pct(entry.weightedEV)}｜模型穩健R {pct(entry.robustEV)}｜{entry.warning ? '⚠️ 診斷警告｜仍保留排名' : '資料QA PASS'}｜影子診斷、非正式推薦`);
source = source.replace(`目前沒有同時通過雙EV、5%情境穩定線與影子排名門檻的方向；所有有效盤口仍會在今日盤口顯示W/R與分數。`, `目前沒有可建立公式診斷分的有效Tai888方向。診斷警告不再取消影子排名資格。`);
source = source.replace(`W/R差距超過5%仍顯示分數但不列排名；尚未完成樣本外驗證`, `W/R差距、極端EV與其他診斷警告仍保留原始分數與影子排名；尚未完成樣本外驗證`);
fs.writeFileSync(path, source);
