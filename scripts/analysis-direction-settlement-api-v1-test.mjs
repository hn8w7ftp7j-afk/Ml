import assert from 'node:assert/strict';
import fs from 'node:fs';

const betsRoute = fs.readFileSync(new URL('../app/api/bets/route.js', import.meta.url), 'utf8');
const cronRoute = fs.readFileSync(new URL('../app/api/cron/analysis-direction-settlements/route.js', import.meta.url), 'utf8');
const statsRoute = fs.readFileSync(new URL('../app/api/analysis-directions/stats/route.js', import.meta.url), 'utf8');
const middleware = fs.readFileSync(new URL('../middleware.js', import.meta.url), 'utf8');
const historyStore = fs.readFileSync(new URL('../lib/analysis-direction-history-v1.js', import.meta.url), 'utf8');

assert.match(betsRoute, /action === 'settleOpen'[\s\S]*settlePendingAnalysisDirections/, '頁面自動結算必須同時處理全部CALCULATED方向');
assert.match(cronRoute, /process\.env\.CRON_SECRET/);
assert.match(cronRoute, /Bearer \$\{secret\}/);
assert.match(cronRoute, /settlePendingAnalysisDirections\(\{[\s\S]*limitGames: 500[\s\S]*concurrency: 4[\s\S]*timeBudgetMs: 240_000/);
assert.match(cronRoute, /Array\.isArray\(settlement\?\.failures\)/, 'Cron降級結果不得因缺少failures陣列二次崩潰');
assert.match(cronRoute, /catch \(error\)[\s\S]*status: 503/, 'Cron必須把執行失敗穩定回報為503');
assert.match(middleware, /\/api\/cron\/analysis-direction-settlements/);

assert.match(statsRoute, /requireApiAuth\(request\)/, '長期統計API必須驗證');
assert.match(statsRoute, /checkRateLimit\(request/);
assert.match(statsRoute, /loadAnalysisDirectionStats/);
for (const filter of ['league', 'market', 'wMin', 'wMax', 'rSign', 'qaStatus', 'lineType', 'minLeadMinutes', 'maxLeadMinutes']) {
  assert.match(statsRoute, new RegExp(filter), `長期統計API缺少${filter}篩選`);
}
assert.match(statsRoute, /MISSING/);
assert.doesNotMatch(statsRoute, /params\.get\('limit'\)/, '長期統計API不得用靜默limit產生不完整ROI');
const statsImplementation = historyStore.slice(historyStore.indexOf('export async function loadAnalysisDirectionStats'));
assert.doesNotMatch(statsImplementation, /LIMIT\s+\$\{cap\}/, '長期統計不得靜默截斷樣本');
assert.match(statsImplementation, /GROUP BY GROUPING SETS/, '長期統計必須在DB完整aggregate，避免逐方向payload傳輸');
assert.match(historyStore, /correctionLookbackDays = 14/);
assert.match(historyStore, /latest_official_result_hash/);
assert.match(historyStore, /eventsSkippedUnchanged/);
assert.match(historyStore, /insertedIds/, '結算計數必須以實際INSERT RETURNING為準');
assert.doesNotMatch(middleware, /PUBLIC_PATHS[^;]*analysis-directions\/stats/, '長期統計不得公開匿名讀取');

console.log('analysis direction settlement trigger, cron auth and stats API tests passed');
