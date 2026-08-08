import assert from 'node:assert/strict';

const BASE = (process.env.SMOKE_URL || 'https://mlb-positive-ev.vercel.app').replace(/\/$/, '');
const EXPECTED_SHA = process.env.GITHUB_SHA || '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function response(url, options = {}, timeout = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, redirect: 'manual', signal: controller.signal, headers: { 'Cache-Control': 'no-cache', ...(options.headers || {}) } });
  } finally { clearTimeout(timer); }
}

async function json(url, options = {}, timeout = 90000) {
  const r = await response(url, options, timeout);
  const text = await r.text();
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${url} returned non-JSON (${r.status}): ${text.slice(0, 300)}`); }
  if (!r.ok || value.ok === false) throw new Error(`${url} failed (${r.status}): ${value.error || text.slice(0, 300)}`);
  return { response: r, value };
}

async function waitForDeployment() {
  let last = '';
  for (let i = 0; i < 36; i += 1) {
    try {
      const { value } = await json(`${BASE}/api/health?t=${Date.now()}`, {}, 20000);
      last = JSON.stringify(value);
      const shaReady = !EXPECTED_SHA || !value.commit || value.commit === EXPECTED_SHA;
      if (value.ok && value.version === '3.1.1' && value.modelVersion === 'calibrated-2026-08' && value.aiGatewayConfigured && shaReady) return value;
    } catch (error) { last = String(error?.message || error); }
    await sleep(10000);
  }
  throw new Error(`Production deployment was not ready: ${last}`);
}

function taipeiDate(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const health = await waitForDeployment();
assert.equal(health.ok, true);
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
assert.match(home, /MLB Positive EV/);
assert.equal(homeResponse.headers.get('x-content-type-options'), 'nosniff');
assert.equal(homeResponse.headers.get('x-frame-options'), 'DENY');
assert.ok(homeResponse.headers.get('content-security-policy'));

let games = [], scheduleDate = taipeiDate();
for (let i = 0; i < 4 && !games.length; i += 1) {
  scheduleDate = taipeiDate(i);
  const result = await json(`${BASE}/api/mlb?date=${scheduleDate}&t=${Date.now()}`, {}, 30000);
  assert.equal(Array.isArray(result.value.games), true);
  games = result.value.games;
}
assert.ok(games.length > 0, 'No MLB games found in the next four days');
const game = games[0];
assert.ok(game.gamePk && game.away && game.home);

const originHeaders = { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
const visionText = `${game.away} @ ${game.home}\n全場讓分：${game.home}讓1平 0.950；${game.away}受讓1平 0.950\n全場大小：大8+50 0.940；小8+50 0.940\n上半讓分：${game.home}讓0平 0.950；${game.away}受讓0平 0.950\n上半大小：大4+50 0.930；小4+50 0.930`;
const vision = await json(`${BASE}/api/vision`, { method: 'POST', headers: originHeaders, body: JSON.stringify({ text: visionText, schedule: [game], defaultWater: 0.95 }) }, 90000);
assert.ok(Array.isArray(vision.value.games) && vision.value.games.length >= 1);
const parsed = vision.value.games[0];
assert.equal(parsed.markets.length, 4);
assert.equal(parsed.markets.flatMap(m => m.directions).length, 8);

const fullMarkets = [
  { market: '全場讓分', pick: `${game.home}讓1平`, water: 0.95, confidence: 1 },
  { market: '全場讓分', pick: `${game.away}受讓1平`, water: 0.95, confidence: 1 },
  { market: '全場大小', pick: '大8+50', water: 0.94, confidence: 1 },
  { market: '全場大小', pick: '小8+50', water: 0.94, confidence: 1 },
  { market: '上半讓分', pick: `${game.home}讓0平`, water: 0.95, confidence: 1 },
  { market: '上半讓分', pick: `${game.away}受讓0平`, water: 0.95, confidence: 1 },
  { market: '上半大小', pick: '大4+50', water: 0.93, confidence: 1 },
  { market: '上半大小', pick: '小4+50', water: 0.93, confidence: 1 },
];
const analyzed = await json(`${BASE}/api/analyze`, { method: 'POST', headers: originHeaders, body: JSON.stringify({ game, markets: fullMarkets, settings: { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5 } }) }, 120000);
assert.equal(analyzed.value.analysis.modelVersion, 'calibrated-2026-08');
assert.equal(analyzed.value.analysis.results.length, 8);
assert.ok(analyzed.value.analysis.results.every(row => Number.isFinite(row.score) && Number.isFinite(row.ev) && Number.isFinite(row.rawEV)));
assert.ok(analyzed.value.analysis.results.every(row => row.modelProbability >= .35 && row.modelProbability <= .65));
assert.ok(analyzed.value.analysis.results.every(row => row.score <= 9.4));
const fullTotalPair = analyzed.value.analysis.results.filter(row => row.market === '全場大小');
assert.ok(Math.abs(fullTotalPair[0].modelProbability + fullTotalPair[1].modelProbability - 1) < 1e-6);

const partial = await json(`${BASE}/api/analyze`, { method: 'POST', headers: originHeaders, body: JSON.stringify({ game, markets: fullMarkets.filter(row => row.market === '全場大小'), settings: { rebateRate: 0.015 } }) }, 120000);
assert.equal(partial.value.analysis.results.length, 2);
assert.deepEqual(partial.value.openMarkets, ['全場大小']);
assert.ok(partial.value.analysis.results.every(row => row.score < 9.4));

const result = await json(`${BASE}/api/result?gamePk=${game.gamePk}&t=${Date.now()}`, {}, 30000);
assert.equal(typeof result.value.final, 'boolean');

console.log(JSON.stringify({ ok: true, base: BASE, commit: health.commit, version: health.version, modelVersion: health.modelVersion, scheduleDate, game: `${game.away} @ ${game.home}`, visionDirections: 8, fullAnalysisResults: 8, partialAnalysisResults: 2, probabilityRange: [Math.min(...analyzed.value.analysis.results.map(row => row.modelProbability)), Math.max(...analyzed.value.analysis.results.map(row => row.modelProbability))], maximumScore: Math.max(...analyzed.value.analysis.results.map(row => row.score)), resultEndpoint: true }, null, 2));
