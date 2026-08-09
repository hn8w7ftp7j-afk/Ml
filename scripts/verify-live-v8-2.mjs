import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BASE = 'https://mlb-positive-ev.vercel.app';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestJSON(path, options = {}, timeout = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${BASE}${path}`, { ...options, signal: controller.signal, headers: { 'Cache-Control': 'no-cache', ...(options.headers || {}) } });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { throw new Error(`${path} 非 JSON（${response.status}）：${text.slice(0, 400)}`); }
    if (!response.ok || value.ok === false) throw new Error(`${path} 失敗（${response.status}）：${value.error || text.slice(0, 400)}｜${(value.details || []).join('；')}`);
    return value;
  } finally {
    clearTimeout(timer);
  }
}

const health = await requestJSON(`/api/health?t=${Date.now()}`, {}, 30000);
assert.equal(health.version, '8.2.0');
assert.equal(health.commit, 'b08f4cad8473d1824e04bdd09b02824f7db8a9cb');
assert.equal(health.scoreContractVersion, 'GPT-COMPOSITE-EVIDENCE-v8.2');
assert.equal(health.modelVersion, 'GPT完整指令聯合情境模型-2026-08-v8.2.0');

const originHeaders = { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
const fixture = readFileSync(new URL('./fixtures/dense-board-7games.b64', import.meta.url), 'utf8').replace(/\s+/g, '');
const visionSchedule = [
  [990001,'克里夫蘭守護者','芝加哥白襪','Cleveland Guardians','Chicago White Sox'],
  [990002,'明尼蘇達雙城','密爾瓦基釀酒人','Minnesota Twins','Milwaukee Brewers'],
  [990003,'芝加哥小熊','堪薩斯市皇家','Chicago Cubs','Kansas City Royals'],
  [990004,'科羅拉多落磯','聖路易紅雀','Colorado Rockies','St. Louis Cardinals'],
  [990005,'巴爾的摩金鶯','德州遊騎兵','Baltimore Orioles','Texas Rangers'],
  [990006,'底特律老虎','舊金山巨人','Detroit Tigers','San Francisco Giants'],
  [990007,'洛杉磯道奇','亞利桑那響尾蛇','Los Angeles Dodgers','Arizona Diamondbacks'],
].map(([gamePk,away,home,awayEnglish,homeEnglish]) => ({ gamePk, away, home, awayEnglish, homeEnglish, gameNumber: 1, scheduledInnings: 9 }));

let bestVision = null;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const value = await requestJSON('/api/vision', {
    method: 'POST',
    headers: originHeaders,
    body: JSON.stringify({
      images: [`data:image/jpeg;base64,${fixture}`],
      schedule: visionSchedule,
      boardPass: true,
      defaultWater: { 全場讓分: 0.95, 全場大小: 0.94, 上半讓分: 0.94, 上半大小: 0.93 },
    }),
  });
  const matched = new Set((value.games || []).map(row => String(row.gamePk || '')).filter(Boolean));
  const discovered = new Set((value.discoveredGamePks || []).map(String));
  const summary = {
    attempt,
    model: value.model,
    matched: matched.size,
    discovered: discovered.size,
    warnings: value.warnings || [],
    gamePks: [...matched],
  };
  console.log('VISION_ATTEMPT', JSON.stringify(summary));
  if (!bestVision || matched.size > bestVision.matched) bestVision = { ...summary, value };
  if (matched.size === 7) break;
  await sleep(1200);
}
assert.equal(bestVision?.matched, 7, `密集盤口驗證只辨識 ${bestVision?.matched || 0}/7：${JSON.stringify(bestVision?.warnings || [])}`);

function taipeiDate(offset = 0) {
  const date = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

let game = null;
for (let offset = 0; offset < 8 && !game; offset += 1) {
  const schedule = await requestJSON(`/api/mlb?date=${taipeiDate(offset)}&t=${Date.now()}`, {}, 30000);
  game = (schedule.games || []).find(row => row.gamePk && row.away && row.home && row.awayProbableId && row.homeProbableId) || null;
}
assert.ok(game, '未來八天找不到雙方先發皆可建模的 MLB 賽事');

const markets = [
  { market: '全場讓分', pick: `${game.home}讓1+50`, water: 0.95, confidence: 1 },
  { market: '全場讓分', pick: `${game.away}受讓1+50`, water: 0.95, confidence: 1 },
  { market: '全場大小', pick: '大8+50', water: 0.94, confidence: 1 },
  { market: '全場大小', pick: '小8+50', water: 0.94, confidence: 1 },
  { market: '上半讓分', pick: `${game.home}讓0平`, water: 0.94, confidence: 1 },
  { market: '上半讓分', pick: `${game.away}受讓0平`, water: 0.94, confidence: 1 },
  { market: '上半大小', pick: '大4+50', water: 0.93, confidence: 1 },
  { market: '上半大小', pick: '小4+50', water: 0.93, confidence: 1 },
];
const settings = { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, simulationsPerScenario: 500, expertMode: 'off' };

async function analyze(inputMarkets) {
  const value = await requestJSON('/api/analyze', {
    method: 'POST',
    headers: originHeaders,
    body: JSON.stringify({ game, markets: inputMarkets, settings }),
  });
  return value.analysis;
}

const first = await analyze(markets);
assert.equal(first.scoreContractVersion, 'GPT-COMPOSITE-EVIDENCE-v8.2');
assert.equal(first.scoreValidation?.passed, true, JSON.stringify(first.scoreValidation));
assert.equal(first.results.length, 8);
for (const row of first.results) {
  assert.ok(Number.isFinite(row.score), `${row.market} ${row.pick} 無有效分數`);
  assert.ok(row.score >= 3.5 && row.score <= 9.4, `${row.market} ${row.pick} 分數越界：${row.score}`);
  assert.notEqual(row.score, 0);
  assert.notEqual(row.score, 10);
  assert.equal(row.scoreAudit?.ok, true, `${row.market} ${row.pick}：${(row.scoreAudit?.errors || []).join('；')}`);
  if (row.score >= 7.2) assert.ok(row.weightedEV > 0 && row.robustEV > 0 && row.conservativeEV > 0, `${row.market} ${row.pick} 7.2+ 未過正 EV 門檻`);
  if (row.score >= 8.5) assert.ok(row.evFlipProbability <= 0.12 && row.confidence >= 0.78 && row.independentEvidenceStrength >= 0.55, `${row.market} ${row.pick} 8.5+ 未過最強證據門檻`);
}
for (const marketName of ['全場讓分','全場大小','上半讓分','上半大小']) {
  const pair = first.results.filter(row => row.market === marketName);
  assert.equal(pair.length, 2);
  assert.ok(Math.abs(pair[0].modelProbability + pair[1].modelProbability - 1) < 0.012, `${marketName} 機率未互補`);
  assert.ok(pair.filter(row => row.betEligible).length <= 1, `${marketName} 兩邊同時進下注池`);
  assert.ok(pair.every(row => row.pairAudit?.ok === true), `${marketName} pair audit 失敗`);
}

const repeat = await analyze(markets);
for (const row of first.results) {
  const again = repeat.results.find(item => item.market === row.market && item.pick === row.pick);
  assert.ok(again);
  assert.ok(Math.abs(again.score - row.score) < 1e-12, `${row.market} ${row.pick} 重算分數不一致`);
  assert.ok(Math.abs(again.weightedEV - row.weightedEV) < 1e-12, `${row.market} ${row.pick} 重算 EV 不一致`);
}

const perturbedMarkets = markets.map(row => ({ ...row, water: Math.min(1.5, Number(row.water) + 0.01) }));
const perturbed = await analyze(perturbedMarkets);
let maximumScoreMove = 0;
for (const row of first.results) {
  const changed = perturbed.results.find(item => item.market === row.market && item.pick === row.pick);
  assert.ok(changed && Number.isFinite(changed.score));
  maximumScoreMove = Math.max(maximumScoreMove, Math.abs(changed.score - row.score));
}
assert.ok(maximumScoreMove <= 0.8, `水位微調造成跳分 ${maximumScoreMove.toFixed(3)}`);

console.log(JSON.stringify({
  ok: true,
  health,
  vision: { matched: bestVision.matched, discovered: bestVision.discovered, model: bestVision.model },
  scoring: {
    scoreContractVersion: first.scoreContractVersion,
    validation: first.scoreValidation,
    scores: first.results.map(row => ({ market: row.market, pick: row.pick, score: row.score, weightedEV: row.weightedEV, robustEV: row.robustEV, conservativeEV: row.conservativeEV })),
    maximumScoreMove,
  },
}, null, 2));
