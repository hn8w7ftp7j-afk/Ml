import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BASE = String(process.env.PREVIEW_URL || '').replace(/\/$/, '');
assert.ok(BASE, 'PREVIEW_URL 未提供');

async function fetchText(path, options = {}, timeout = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(`${BASE}${path}`, {
      ...options,
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'Cache-Control': 'no-cache',
        ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}),
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function json(path, options = {}, timeout = 180000) {
  const response = await fetchText(path, options, timeout);
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${path} 非 JSON（${response.status}）：${text.slice(0, 500)}`); }
  if (!response.ok || value.ok === false) {
    throw new Error(`${path} 失敗（${response.status}）：${value.error || text.slice(0, 300)}｜${(value.details || []).join('；')}`);
  }
  return value;
}

const health = await json(`/api/health?t=${Date.now()}`, {}, 30000);
assert.equal(health.version, '8.2.4');
assert.equal(health.commit, '31de9603bf61405924349e49feeafaa5032bdb3c');
assert.equal(health.visionVersion, 'MLB-VISION-2026-08-v8.2.4');
assert.equal(health.scoreContractVersion, 'GPT-COMPOSITE-EVIDENCE-v8.2');

const fixture = readFileSync(new URL('./fixtures/dense-board-7games.b64', import.meta.url), 'utf8').replace(/\s+/g, '');
const schedule = [
  [990001,'克里夫蘭守護者','芝加哥白襪','Cleveland Guardians','Chicago White Sox'],
  [990002,'明尼蘇達雙城','密爾瓦基釀酒人','Minnesota Twins','Milwaukee Brewers'],
  [990003,'芝加哥小熊','堪薩斯市皇家','Chicago Cubs','Kansas City Royals'],
  [990004,'科羅拉多落磯','聖路易紅雀','Colorado Rockies','St. Louis Cardinals'],
  [990005,'巴爾的摩金鶯','德州遊騎兵','Baltimore Orioles','Texas Rangers'],
  [990006,'底特律老虎','舊金山巨人','Detroit Tigers','San Francisco Giants'],
  [990007,'洛杉磯道奇','亞利桑那響尾蛇','Los Angeles Dodgers','Arizona Diamondbacks'],
].map(([gamePk,away,home,awayEnglish,homeEnglish]) => ({ gamePk, away, home, awayEnglish, homeEnglish, gameNumber: 1, scheduledInnings: 9 }));

const vision = await json('/api/vision', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' },
  body: JSON.stringify({
    images: [`data:image/jpeg;base64,${fixture}`],
    schedule,
    boardPass: true,
    defaultWater: { 全場讓分: 0.95, 全場大小: 0.94, 上半讓分: 0.94, 上半大小: 0.93 },
  }),
}, 180000);

console.log('VISION_RESULT', JSON.stringify(vision, null, 2));
const matched = new Set((vision.games || []).map(row => String(row.gamePk || '')).filter(Boolean));
const discovered = new Set((vision.discoveredGamePks || []).map(String));
assert.equal(matched.size, 7, `只配對 ${matched.size}/7`);
assert.equal(discovered.size, 7, `只列舉 ${discovered.size}/7`);
const byId = new Map(vision.games.map(row => [Number(row.gamePk), row]));
const picksFor = id => (byId.get(id)?.markets || []).flatMap(row => row.directions || []).map(row => row.pick).filter(Boolean);
assert.ok(picksFor(990002).includes('密爾瓦基釀酒人讓2+60'), JSON.stringify(picksFor(990002)));
assert.ok(picksFor(990002).includes('明尼蘇達雙城受讓2+60'), JSON.stringify(picksFor(990002)));
assert.ok(picksFor(990003).includes('大10+10'), JSON.stringify(picksFor(990003)));
assert.ok(picksFor(990003).includes('小10+10'), JSON.stringify(picksFor(990003)));
assert.ok(picksFor(990007).includes('大4.5'), JSON.stringify(picksFor(990007)));

console.log(JSON.stringify({ ok: true, base: BASE, health, model: vision.model, matched: matched.size, discovered: discovered.size }, null, 2));
