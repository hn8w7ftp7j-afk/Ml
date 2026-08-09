import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BASE = (process.env.SMOKE_URL || 'https://mlb-positive-ev.vercel.app').replace(/\/$/, '');
const EXPECTED_SHA = process.env.GITHUB_SHA || '';
const VERSION = '8.2.1';
const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.2.0';
const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.2.0';
const EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v2.2';
const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.1';
const BATCH_VERSION = 'MLB-AUTO-ANALYZE-ALL-2026-08-v1';
const SCORE_CONTRACT_VERSION = 'GPT-COMPOSITE-EVIDENCE-v8.2';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function response(url, options = {}, timeout = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      ...options,
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'Cache-Control': 'no-cache', ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function json(url, options = {}, timeout = 90000) {
  const result = await response(url, options, timeout);
  const text = await result.text();
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${url} 回傳非 JSON（${result.status}）：${text.slice(0, 300)}`); }
  if (!result.ok || value.ok === false) {
    const detail = Array.isArray(value.details) && value.details.length ? `｜${value.details.join('；')}` : '';
    throw new Error(`${url} 失敗（${result.status}）：${value.error || text.slice(0, 300)}${detail}`);
  }
  return { response: result, value };
}

async function waitForDeployment() {
  let last = '';
  for (let index = 0; index < 60; index += 1) {
    try {
      const { value } = await json(`${BASE}/api/health?t=${Date.now()}`, {}, 20000);
      last = JSON.stringify(value);
      const shaReady = !EXPECTED_SHA || !value.commit || value.commit === EXPECTED_SHA;
      if (
        value.ok
        && value.version === VERSION
        && value.modelVersion === MODEL_VERSION
        && value.rulesVersion === RULES_VERSION
        && value.expertVersion === EXPERT_VERSION
        && value.visionVersion === VISION_VERSION
        && value.batchVersion === BATCH_VERSION
        && value.scoreContractVersion === SCORE_CONTRACT_VERSION
        && value.aiGatewayConfigured
        && shaReady
      ) return value;
    } catch (error) {
      last = String(error?.message || error);
    }
    await sleep(10000);
  }
  throw new Error(`正式部署尚未就緒：${last}`);
}

function taipeiDate(offset = 0) {
  const date = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

const health = await waitForDeployment();
assert.equal(health.ok, true);
assert.equal(health.version, VERSION);
assert.equal(health.modelVersion, MODEL_VERSION);
assert.equal(health.rulesVersion, RULES_VERSION);
assert.equal(health.expertVersion, EXPERT_VERSION);
assert.equal(health.visionVersion, VISION_VERSION);
assert.equal(health.batchVersion, BATCH_VERSION);
assert.equal(health.scoreContractVersion, SCORE_CONTRACT_VERSION);
assert.equal(health.aiGatewayConfigured, true);
if (EXPECTED_SHA && health.commit) assert.equal(health.commit, EXPECTED_SHA);

const homeResponse = await response(`${BASE}/?smoke=${Date.now()}`, {}, 30000);
if (health.authConfigured) {
  assert.ok([302, 307, 308].includes(homeResponse.status));
  console.log(JSON.stringify({ ok: true, base: BASE, commit: health.commit, authProtected: true }, null, 2));
  process.exit(0);
}
const home = await homeResponse.text();
assert.equal(homeResponse.ok, true);
assert.match(home, /MLB 長期正期望值分析/);
const renderedHome = home.replace(/<!--.*?-->/g, '');
assert.match(renderedHome, /第\s*8\.2\.0\s*版/);
assert.match(renderedHome, /上傳全部圖片/);
assert.match(renderedHome, /自動辨識全部盤口/);
assert.match(renderedHome, /自動分析全部場次/);
assert.equal(homeResponse.headers.get('x-content-type-options'), 'nosniff');
assert.equal(homeResponse.headers.get('x-frame-options'), 'DENY');
assert.ok(homeResponse.headers.get('content-security-policy'));

let game = null;
let scheduleDate = taipeiDate();
for (let index = 0; index < 8 && !game; index += 1) {
  scheduleDate = taipeiDate(index);
  const result = await json(`${BASE}/api/mlb?date=${scheduleDate}&t=${Date.now()}`, {}, 30000);
  assert.equal(Array.isArray(result.value.games), true);
  game = (result.value.games || []).find(row => row.gamePk && row.away && row.home && row.awayProbableId && row.homeProbableId) || null;
}
assert.ok(game, '未來八天找不到雙方先發皆可建模的 MLB 賽事');
assert.ok(/[\u4e00-\u9fff]/.test(game.away));
assert.ok(/[\u4e00-\u9fff]/.test(game.home));

const originHeaders = { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
const visionFixture = readFileSync(new URL('./fixtures/dense-board-7games.b64', import.meta.url), 'utf8').replace(/\s+/g, '');
assert.match(visionFixture, /^[A-Za-z0-9+/]+={0,2}$/);
const visionSchedule = [
  [990001,'克里夫蘭守護者','芝加哥白襪','Cleveland Guardians','Chicago White Sox'],
  [990002,'明尼蘇達雙城','密爾瓦基釀酒人','Minnesota Twins','Milwaukee Brewers'],
  [990003,'芝加哥小熊','堪薩斯市皇家','Chicago Cubs','Kansas City Royals'],
  [990004,'科羅拉多落磯','聖路易紅雀','Colorado Rockies','St. Louis Cardinals'],
  [990005,'巴爾的摩金鶯','德州遊騎兵','Baltimore Orioles','Texas Rangers'],
  [990006,'底特律老虎','舊金山巨人','Detroit Tigers','San Francisco Giants'],
  [990007,'洛杉磯道奇','亞利桑那響尾蛇','Los Angeles Dodgers','Arizona Diamondbacks'],
].map(([gamePk,away,home,awayEnglish,homeEnglish]) => ({ gamePk, away, home, awayEnglish, homeEnglish, gameNumber:1, scheduledInnings:9 }));
const visionCapture = await json(`${BASE}/api/vision`, {
  method: 'POST', headers: originHeaders,
  body: JSON.stringify({ images: [`data:image/jpeg;base64,${visionFixture}`], schedule: visionSchedule, boardPass: true, defaultWater: { 全場讓分:0.95, 全場大小:0.94, 上半讓分:0.94, 上半大小:0.93 } }),
}, 180000);
assert.equal(visionCapture.value.visionVersion, VISION_VERSION);
assert.ok(visionCapture.value.model && visionCapture.value.model !== '本地信用盤解析器');
assert.equal(new Set(visionCapture.value.discoveredGamePks.map(String)).size, 7);
assert.equal(visionCapture.value.games.filter(row => row.gamePk).length, 7);
const visionById = new Map(visionCapture.value.games.map(row => [Number(row.gamePk), row]));
const picksFor = id => (visionById.get(id)?.markets || []).flatMap(row => row.directions || []).map(row => row.pick).filter(Boolean);
assert.ok(picksFor(990002).includes('密爾瓦基釀酒人讓2+60'));
assert.ok(picksFor(990002).includes('明尼蘇達雙城受讓2+60'));
assert.ok(picksFor(990003).includes('大10+10'));
assert.ok(picksFor(990003).includes('小10+10'));
assert.ok(picksFor(990007).includes('大4.5'));
const visionPicks = [...visionById.values()].flatMap(row => (row.markets || []).flatMap(market => market.directions || [])).map(row => row.pick).filter(Boolean);

const fullMarkets = [
  { market: '全場讓分', pick: `${game.home}讓1+50`, water: 0.95, confidence: 1 },
  { market: '全場讓分', pick: `${game.away}受讓1+50`, water: 0.95, confidence: 1 },
  { market: '全場大小', pick: '大8+50', water: 0.94, confidence: 1 },
  { market: '全場大小', pick: '小8+50', water: 0.94, confidence: 1 },
  { market: '上半讓分', pick: `${game.home}讓0平`, water: 0.94, confidence: 1 },
  { market: '上半讓分', pick: `${game.away}受讓0平`, water: 0.94, confidence: 1 },
  { market: '上半大小', pick: '大4+50', water: 0.93, confidence: 1 },
  { market: '上半大小', pick: '小4+50', water: 0.93, confidence: 1 },
];
const previousMarkets = fullMarkets.map(row => ({ ...row, water: Math.max(0.5, row.water - 0.02) }));
const settings = { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, simulationsPerScenario: 500, expertMode: 'off' };

const analyzed = await json(`${BASE}/api/analyze`, {
  method: 'POST',
  headers: originHeaders,
  body: JSON.stringify({ game, markets: fullMarkets, previousMarkets, settings }),
}, 180000);
const analysis = analyzed.value.analysis;
assert.equal(analysis.modelVersion, MODEL_VERSION);
assert.equal(analysis.rulesVersion, RULES_VERSION);
assert.equal(analysis.results.length, 8);
assert.equal(analysis.scenarioSummary.count, 27);
assert.equal(analysis.scenarioSummary.robustVariantCount, 7);
assert.equal(analysis.scenarioSummary.sharedDistribution, true);
assert.equal(analysis.scenarioSummary.jointPortfolioDistribution, true);
assert.ok(analysis.scenarioSummary.jointCellCount > 0);
assert.ok(analysis.results.every(row => Number.isFinite(row.score) && Number.isFinite(row.weightedEV) && Number.isFinite(row.robustEV) && Number.isFinite(row.conservativeEV)));
assert.ok(analysis.results.every(row => row.robustEV <= row.weightedEV + 1e-10));
assert.ok(analysis.results.every(row => row.cev === row.conservativeEV));
assert.ok(analysis.results.every(row => row.evFlipProbability >= 0 && row.evFlipProbability <= 1));
assert.ok(analysis.results.every(row => row.distributionCoverage > 0.999));
assert.ok(analysis.results.every(row => row.movement?.available));
assert.ok(analysis.results.every(row => Number.isFinite(row.rawEV)));
assert.ok(analysis.results.every(row => row.marketCalibrationWeight >= 0.12 && row.marketCalibrationWeight <= 0.55));
assert.equal(analysis.scoreContractVersion, SCORE_CONTRACT_VERSION);
assert.equal(analysis.scoreValidation.passed, true);
assert.ok(analysis.results.every(row => row.scoreAudit?.ok === true));
assert.ok(analysis.results.every(row => row.score >= 3.5 && row.score <= 9.4 && row.score !== 10 && row.score !== 0));
assert.ok(analysis.results.every(row => row.calibratedMarketProbabilityGap <= row.maximumCalibratedProbabilityEdge + 1e-10));
assert.equal(analysis.alignmentAudit.expertLayer.used, false);
assert.ok(analysis.alignmentAudit.unmodeled.length > 0);
assert.ok(analysis.results.every(row => Number.isFinite(row.modelErrorFloor)));
assert.ok(analysis.portfolio.reduce((sum, row) => sum + row.recommendedUnit, 0) <= 2.0001);

for (const marketName of ['全場讓分', '全場大小', '上半讓分', '上半大小']) {
  const pair = analysis.results.filter(row => row.market === marketName);
  assert.equal(pair.length, 2);
  assert.ok(Math.abs(pair[0].modelProbability + pair[1].modelProbability - 1) < 0.012, `${marketName} 機率不互補`);
  assert.ok(pair.filter(row => row.betEligible).length <= 1, `${marketName} 正反方向同時進下注池`);
  assert.ok(Math.abs(pair[0].score - pair[1].score) < 6, `${marketName} 分數落差過度機械化`);
}

const partial = await json(`${BASE}/api/analyze`, {
  method: 'POST',
  headers: originHeaders,
  body: JSON.stringify({ game, markets: fullMarkets.filter(row => row.market === '全場大小'), settings }),
}, 180000);
assert.equal(partial.value.analysis.results.length, 2);
assert.deepEqual(partial.value.openMarkets, ['全場大小']);

const missingWater = await json(`${BASE}/api/analyze`, {
  method: 'POST',
  headers: originHeaders,
  body: JSON.stringify({
    game,
    markets: [
      { market: '全場大小', pick: '大8+50', water: 0.94, confidence: 1 },
      { market: '全場大小', pick: '小8+50', water: null, confidence: 1 },
    ],
    settings,
  }),
}, 180000);
const noScore = missingWater.value.analysis.results.find(row => row.pick === '小8+50');
assert.equal(noScore.score, null);
assert.equal(noScore.tag, '水位未提供｜不評分');

const estimated = await json(`${BASE}/api/analyze`, {
  method: 'POST',
  headers: originHeaders,
  body: JSON.stringify({
    game,
    markets: [
      { market: '全場大小', pick: '大8+50', water: 0.94, waterEstimated: true, confidence: 1 },
      { market: '全場大小', pick: '小8+50', water: 0.94, waterEstimated: true, confidence: 1 },
    ],
    settings,
  }),
}, 180000);
assert.ok(estimated.value.analysis.results.every(row => row.score <= 6.6 && row.betEligible === false));

const expertSettings = { ...settings, expertMode: 'required' };
const expertAnalyzed = await json(`${BASE}/api/analyze`, {
  method: 'POST',
  headers: originHeaders,
  body: JSON.stringify({
    game,
    markets: fullMarkets.filter(row => row.market === '全場大小'),
    settings: expertSettings,
  }),
}, 180000);
assert.equal(expertAnalyzed.value.expertAssessment.used, true);
assert.equal(expertAnalyzed.value.expertAssessment.status, 'complete');
assert.ok(expertAnalyzed.value.expertAssessment.model);
assert.equal(expertAnalyzed.value.analysis.alignmentAudit.expertLayer.used, true);
assert.equal(expertAnalyzed.value.analysis.results.length, 2);

const result = await json(`${BASE}/api/result?gamePk=${game.gamePk}&t=${Date.now()}`, {}, 30000);
assert.equal(typeof result.value.final, 'boolean');

console.log(JSON.stringify({
  ok: true,
  base: BASE,
  commit: health.commit,
  version: health.version,
  modelVersion: health.modelVersion,
  scheduleDate,
  game: `${game.away} 對 ${game.home}`,
  fullAnalysisResults: analysis.results.length,
  partialAnalysisResults: partial.value.analysis.results.length,
  scenarioCount: analysis.scenarioSummary.count,
  robustVariantCount: analysis.scenarioSummary.robustVariantCount,
  maximumScore: Math.max(...analysis.results.map(row => row.score)),
  expertLayerUsed: expertAnalyzed.value.expertAssessment.used,
  expertModel: expertAnalyzed.value.expertAssessment.model,
  visionModel: visionCapture.value.model,
  visionPicks: visionPicks.length,
  resultEndpoint: true,
}, null, 2));
