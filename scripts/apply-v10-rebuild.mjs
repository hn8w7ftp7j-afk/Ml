import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replace(path, before, after) {
  const source = read(path);
  if (!source.includes(before)) throw new Error(`${path}: missing replacement source: ${before.slice(0, 100)}`);
  write(path, source.replace(before, after));
}
function replaceRegex(path, pattern, after) {
  const source = read(path);
  if (!pattern.test(source)) throw new Error(`${path}: regex did not match ${pattern}`);
  write(path, source.replace(pattern, after));
}

replace('lib/league-provider.js',
  "import { buildGameContext, fetchFinalResult } from './mlb.js';",
  "import { fetchFinalResult } from './mlb.js';\nimport { buildGameContextV10 } from './mlb-data-v10.js';");
replace('lib/league-provider.js', "} from './analysis.js';", "} from './analysis-v10.js';");
replace('lib/league-provider.js', '? await buildGameContext(game)', '? await buildGameContextV10(game, options)');

for (const path of ['app/api/analyze/route.js', 'app/api/reprice/route.js']) {
  replace(path, "from '../../../lib/analysis.js';", "from '../../../lib/analysis-v10.js';");
  replace(path, "from '../../../lib/deterministic-finalizer.js';", "from '../../../lib/deterministic-finalizer-v10.js';");
}
replace('app/api/health/route.js', "from '../../../lib/analysis.js';", "from '../../../lib/analysis-v10.js';");
replace('app/api/health/route.js', "from '../../../lib/deterministic-finalizer.js';", "from '../../../lib/deterministic-finalizer-v10.js';");
replace('app/api/health/route.js', "version: '9.7.0'", "version: '10.0.0'");
replace('app/api/analyze/route.js',
  "simulationsPerScenario: Math.max(500, Math.min(4000, Math.round(Number(body.settings?.simulationsPerScenario) || 1800)))",
  "simulationsPerScenario: 4000");

replace('lib/snapshot-v9.js',
  "export const DATA_VERSION = 'MLB-DATA-SNAPSHOT-2026-08-v1.2.0';",
  "export const DATA_VERSION = 'BASEBALL-POINT-IN-TIME-DATA-SNAPSHOT-2026-08-v10.0.0';");
replace('lib/snapshot-v9.js',
  "export const REPRICE_VERSION = 'MLB-FROZEN-CONTEXT-REPRICE-2026-08-v1.2.0';",
  "export const REPRICE_VERSION = 'BASEBALL-FROZEN-CONTEXT-REPRICE-2026-08-v10.0.0';");

replace('lib/analysis.js',
  "  const temperatureFactor = closedProbability * 1 + (1 - closedProbability) * openTemperatureFactor;\n  let factor = clamp(park * temperatureFactor, 0.86, 1.20);",
  "  const temperatureFactor = closedProbability * 1 + (1 - closedProbability) * openTemperatureFactor;\n  const suppliedMeanRunFactor = Number(weather.meanRunFactorV10);\n  const weatherMeanFactor = Number.isFinite(suppliedMeanRunFactor)\n    ? closedProbability * 1 + (1 - closedProbability) * clamp(suppliedMeanRunFactor, 0.90, 1.12)\n    : temperatureFactor;\n  let factor = clamp(park * weatherMeanFactor, 0.86, 1.20);");

let page = read('app/page.js');
const pageReplacements = [
  ["const VERSION = '9.7.0';", "const VERSION = '10.0.0';"],
  ["const STORAGE = 'sports-positive-ev-v9-7-0';", "const STORAGE = 'sports-positive-ev-v10-0-0';"],
  ["const LEGACY_KEYS = ['sports-positive-ev-v9-6-0'", "const LEGACY_KEYS = ['sports-positive-ev-v9-7-0', 'sports-positive-ev-v9-6-0'"],
  ['  simulationsPerScenario: 1800,', '  simulationsPerScenario: 4000,'],
  ["body: JSON.stringify({ action: 'settleOpen', league: targetLeague, limit: 40 })", "body: JSON.stringify({ action: 'settleOpen', league: targetLeague, limit: 500 })"],
  ["scoreStatus: 'LEGACY_INVALID',", "scoreStatus: 'SHADOW_DIAGNOSTIC_NOT_FORMAL',"],
  ["legacyDiagnosticScore: row.shadowDiagnosticScore ?? row.legacyDiagnosticScore ?? row.score ?? null,", "shadowDiagnosticScore: row.shadowDiagnosticScore ?? null,\n      legacyDiagnosticScore: row.legacyDiagnosticScore ?? null,"],
  [">正式排名</button>", ">影子排名</button>"],
  ["Tai888 Reader持續同步實際信用盤；正式模型分數已停用，實際下注、盤口比較、賽果結算與績效統計獨立運作。", "Tai888 Reader持續同步實際信用盤；V10影子分數來自原始聯合比分分布，正式推薦仍停用，下注紀錄、盤口比較、賽果結算與績效統計獨立運作。"],
  ["按下「紀錄實際下注」會永久保存當下盤口、水位、Reader版本與金額。", "V10影子分數只供驗證，不是正式下注建議；按下「紀錄實際下注」會永久保存當下盤口、水位、Reader版本與金額。"],
  ["<strong>Shadow Mode｜正式分數停用</strong><span>Reader與實際下注帳本可使用；模型完成外樣本驗證前不產生正式推薦</span>", "<strong>V10 Shadow｜影子分數可見</strong><span>Raw Weighted／Robust EV已重建；完成locked OOS與forward驗證前不產生正式推薦</span>"],
  ["<div className=\"setupHead\"><div><span className=\"kicker\">FORMAL SCORE OFF</span><h2>{config.label}目前為模型重建影子模式</h2></div><span className=\"state shadow\">可記錄實際下注</span></div>", "<div className=\"setupHead\"><div><span className=\"kicker\">V10 SHADOW SCORE</span><h2>{config.label}目前顯示可稽核影子分數</h2></div><span className=\"state shadow\">不可視為正式推薦</span></div>"],
  ["<p className=\"muted\">v9.4.4舊分數已作廢。Reader繼續同步實際信用盤，使用者可記錄真實下注、追蹤後續盤口並自動結算；模型數字只作診斷，不進入正式績效。</p>", "<p className=\"muted\">V10已改為point-in-time資料、同一上半／全場聯合比分分布與Tai888純payoff EV。畫面分數只作Shadow驗證；正式排名、Unit與模型推薦績效仍停用。</p>"],
  ["<label>診斷模擬次數／情境<select value={settings.simulationsPerScenario} onChange={event => setSettings(value => ({ ...value, simulationsPerScenario: Number(event.target.value) }))}><option value=\"1000\">1000</option><option value=\"1800\">1800</option><option value=\"2500\">2500</option></select></label>", "<label>V10模擬次數／情境<select value={settings.simulationsPerScenario} onChange={event => setSettings(value => ({ ...value, simulationsPerScenario: Number(event.target.value) }))}><option value=\"4000\">4000（固定）</option></select></label>"],
  ["目前全部聯盟均為Shadow。模型數字不形成正式分數、推薦或Unit；", "目前全部聯盟均為V10 Shadow。影子分數可見，但不形成正式推薦或Unit；"],
];
for (const [before, after] of pageReplacements) {
  if (!page.includes(before)) throw new Error(`app/page.js missing: ${before.slice(0, 90)}`);
  page = page.replace(before, after);
}

const resultRowAnchor = "  const breakEven = actualLine ? breakEvenProbability(row.water, 0.015) : null;\n  const exact = betState?.exact || null;";
if (!page.includes(resultRowAnchor)) throw new Error('app/page.js ResultRow anchor missing');
page = page.replace(resultRowAnchor,
  "  const breakEven = actualLine ? breakEvenProbability(row.water, 0.015) : null;\n  const shadowScore = row?.scoreAudit?.ok !== false && Number.isFinite(Number(row?.shadowDiagnosticScore))\n    ? Number(row.shadowDiagnosticScore) : null;\n  const scoreClass = shadowScore == null ? 'pass' : shadowScore >= 8.5 ? 'strongest' : shadowScore >= 7.2 ? 'candidate' : 'pass';\n  const scoreTitle = shadowScore == null\n    ? 'V10資料、數學或數值QA未通過，不顯示分數'\n    : `V10影子分數 ${shadowScore.toFixed(1)}｜不可視為正式下注建議`;\n  const exact = betState?.exact || null;");

const oldScoreDiv = "    <div className=\"score pass\" title=\"v9.4.4資料鏈已作廢，正式分數停用\">—</div>";
if (!page.includes(oldScoreDiv)) throw new Error('app/page.js old score div missing');
page = page.replace(oldScoreDiv,
  "    <div className={`score ${scoreClass}`} title={scoreTitle}>{shadowScore == null ? '—' : shadowScore.toFixed(1)}</div>");
page = page.replace(
  "舊模型方向機率 {pct(row.modelProbability)}｜損益兩平 {pct(breakEven)}｜診斷W EV {pct(row.weightedEV)}｜診斷R EV {pct(row.robustEV)}｜正式分數停用",
  "V10棒球分布勝率 {pct(row.modelProbability)}｜損益兩平 {pct(breakEven)}｜Raw W EV {pct(row.weightedEV)}｜保守 R EV {pct(row.robustEV)}｜影子分數不可下注");
page = page.replace(
  "BLOCK｜資料或數學QA未通過｜不評分；仍可記錄使用者自行下注'\n          : 'SHADOW｜舊模型資料鏈作廢｜正式分數停用｜可記錄實際下注'",
  "BLOCK｜資料、數學或數值QA未通過｜不評分；仍可記錄使用者自行下注'\n          : 'V10 SHADOW｜Tai888只作成交價｜正式推薦尚未啟用｜可記錄實際下注'");

const rankingAnchor = "  const readerPendingText = coveragePendingText(readerCoverage);\n";
if (!page.includes(rankingAnchor)) throw new Error('app/page.js ranking insert anchor missing');
page = page.replace(rankingAnchor, `${rankingAnchor}  const shadowRanking = useMemo(() => board.flatMap(item => (item.customData?.analysis?.results || [])\n    .filter(row => row.sourceType === 'ACTUAL_TW_CREDIT' && Number.isFinite(Number(row.shadowDiagnosticScore)))\n    .map(row => ({ gamePk: item.game.gamePk, matchup: matchup(item.game), market: row.market, pick: row.pick,\n      water: row.water, score: Number(row.shadowDiagnosticScore), weightedEV: row.weightedEV, robustEV: row.robustEV })))\n    .sort((left, right) => right.score - left.score || Number(right.robustEV || 0) - Number(left.robustEV || 0)), [board]);\n`);

const rankingPattern = /\{tab === 'ranking' && <section className="panel">[\s\S]*?<\/section>\}\n\n    \{tab === 'bets'/;
if (!rankingPattern.test(page)) throw new Error('app/page.js ranking section pattern missing');
page = page.replace(rankingPattern,
`{tab === 'ranking' && <section className="panel"><div className="panelHead"><h2>V10影子排名｜不可下注</h2><span className="state shadow">SHADOW</span></div>
      <div className="emptySmall">只列QA通過的影子分數；正式推薦、Unit與模型績效維持停用，直到locked OOS與forward Gate通過。</div>
      {shadowRanking.length ? shadowRanking.map((entry, index) => <div className="rankRow" key={\`${'${'}entry.gamePk}-${'${'}entry.market}-${'${'}entry.pick}\`}><b>{index + 1}</b><strong>{entry.score.toFixed(1)}</strong><div><span>{entry.matchup}｜{entry.market}｜{entry.pick}｜{waterText(entry.water)}</span><small>W EV {pct(entry.weightedEV)}｜R EV {pct(entry.robustEV)}｜影子分數不可下注</small></div></div>) : <div className="emptySmall">完成今日V10分析後，QA通過方向會出現在這裡。</div>}
    </section>}

    {tab === 'bets'`);
write('app/page.js', page);

const pkg = JSON.parse(read('package.json'));
pkg.version = '10.0.0';
if (!pkg.scripts.test.includes('scripts/mlb-data-v10-test.mjs')) {
  pkg.scripts.test = pkg.scripts.test.replace(
    'node scripts/deterministic-v9-test.mjs &&',
    'node scripts/deterministic-v9-test.mjs && node scripts/mlb-data-v10-test.mjs && node scripts/analysis-v10-test.mjs &&',
  );
}
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
write('DEPLOYMENT_VERSION', 'v10.0.0-point-in-time-raw-joint-ev-shadow-score\n');

let pageTest = read('scripts/page-reader-automation-v941-test.mjs');
const testPairs = [
  ["/const VERSION = '9\\.7\\.0'/", "/const VERSION = '10\\.0\\.0'/"],
  ["/sports-positive-ev-v9-7-0/", "/sports-positive-ev-v10-0-0/"],
  ["assert.match(page, /正式模型分數已停用/);", "assert.match(page, /V10影子分數/);"],
  ["assert.match(page, /正式下注排名已停用/);", "assert.match(page, /V10影子排名/);"],
  ["assert.match(page, /v9\\.4\\.4資料鏈已作廢/);", "assert.match(page, /Tai888只作成交價/);"],
  ["assert.match(page, /scoreStatus: 'LEGACY_INVALID'/);", "assert.match(page, /scoreStatus: 'SHADOW_DIAGNOSTIC_NOT_FORMAL'/);"],
  ["const finalizer = fs.readFileSync('lib/deterministic-finalizer.js', 'utf8');", "const finalizer = fs.readFileSync('lib/deterministic-finalizer-v10.js', 'utf8');"],
  ["assert.match(finalizer, /SCORE_RELEASE_STATUS = 'LEGACY_INVALID'/);", "assert.match(finalizer, /SCORE_RELEASE_STATUS = 'SHADOW_VALIDATED_NOT_FORMAL'/);"],
  ["assert.match(finalizer, /row\\.scoreStatus = SCORE_RELEASE_STATUS/);", "assert.match(finalizer, /row\\.scoreStatus = diagnosticScore == null \\? 'BLOCKED' : 'SHADOW_VALIDATED'/);"],
  ["console.log('Baseball v9.7 Shadow safety, Reader revision, settlement-based price comparison, cloud ledger and statistics audit PASS');", "console.log('Baseball v10 raw-EV Shadow score, Reader revision, settlement comparison, cloud ledger and statistics audit PASS');"],
];
for (const [before, after] of testPairs) {
  if (!pageTest.includes(before)) throw new Error(`page test missing: ${before}`);
  pageTest = pageTest.replace(before, after);
}
pageTest = pageTest.replace(
  "assert.match(page, /legacyDiagnosticScore/);",
  "assert.match(page, /shadowDiagnosticScore/);\nassert.match(page, /shadowScore\.toFixed\\(1\\)/);\nassert.match(page, /marketCalibrationApplied: false|Tai888只作成交價/);",
);
pageTest = pageTest.replace(
  "assert.doesNotMatch(page, /正式EV/);",
  "assert.doesNotMatch(page, /校準等值勝率/);",
);
write('scripts/page-reader-automation-v941-test.mjs', pageTest);

console.log('V10 integration patch applied');
