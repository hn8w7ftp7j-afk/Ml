import assert from 'node:assert/strict';
import {
  calculateProfit,
  evFromProbability,
  marketIsOpen,
  normalizeVisionGame,
  normalizeWater,
  outcomeFractionForScore,
  parseTaiwanLine,
  priceCLV,
  resultLabel,
  resultTag,
  scoreFromEV,
  validateMarketPair,
} from '../lib/markets.js';
import { analyzeMarkets, estimateRuns } from '../lib/analysis.js';

const away = '紐約大都會';
const home = '亞特蘭大勇士';

// 台灣盤解析：球隊名稱中的「大／小」不可再被當成大小盤標記移除。
assert.equal(parseTaiwanLine(`${home}受讓1+10`).team, home);
assert.equal(parseTaiwanLine(`${home}受讓1+10`).isReceiving, true);
assert.equal(parseTaiwanLine('芝加哥小熊讓1平').team, '芝加哥小熊');
assert.equal(parseTaiwanLine('芝加哥小熊讓1平').isGiving, true);
assert.equal(parseTaiwanLine('大8+90').isOver, true);
assert.equal(parseTaiwanLine('小8+90').isUnder, true);
assert.equal(parseTaiwanLine('亞特蘭大勇士1+10').valid, false);

// 台灣信用盤精確部分輸贏結算。
assert.equal(outcomeFractionForScore('大8+50', 4, 4, away, home), -0.5);
assert.equal(outcomeFractionForScore('小8+50', 4, 4, away, home), 0.5);
assert.equal(outcomeFractionForScore('大8-30', 4, 4, away, home), 0.3);
assert.equal(outcomeFractionForScore('小8-30', 4, 4, away, home), -0.3);
assert.equal(outcomeFractionForScore(`${home}讓1-20`, 3, 4, away, home), 0.2);
assert.equal(outcomeFractionForScore(`${away}受讓1-20`, 3, 4, away, home), -0.2);
assert.equal(outcomeFractionForScore(`${home}讓1+50`, 3, 4, away, home), -0.5);
assert.equal(outcomeFractionForScore(`${away}受讓1+50`, 3, 4, away, home), 0.5);
assert.equal(outcomeFractionForScore(`${away}受讓0.5/1`, 3, 4, away, home), -0.5);
assert.equal(outcomeFractionForScore('大8平', 4, 4, away, home), 0);
assert.equal(outcomeFractionForScore('勇士讓1平', 3, 4, '亞特蘭大勇士', '勇士隊'), null, '球隊名稱同時可能配到兩邊時必須拒絕');

assert.equal(resultLabel(0.65), '贏65%');
assert.equal(resultLabel(-0.3), '輸30%');
assert.equal(resultLabel(0), '走水');
let profit = calculateProfit({ stake: 10000, water: 0.95, fraction: 0.5, rebateRate: 0.015 });
assert.equal(profit.rebate, 75);
assert.equal(profit.profit, 4825);
assert.equal(profit.settledAmount, 5000);
profit = calculateProfit({ stake: 10000, water: 0.95, fraction: -0.3, rebateRate: 0.015 });
assert.equal(profit.rebate, 45);
assert.equal(profit.profit, -2955);
assert.equal(profit.settledAmount, 3000);
profit = calculateProfit({ stake: 10000, water: 0.95, fraction: 0, rebateRate: 0.015 });
assert.equal(profit.rebate, 0);
assert.equal(profit.profit, 0);

// 正式版評分尺度：最終 EV 約 4% 不再進入 7.2 下注候選。
assert.equal(normalizeWater(null, 0.95), 0.95);
assert.equal(normalizeWater('', 0.94), 0.94);
assert.ok(evFromProbability(0.55, 0.95) > evFromProbability(0.55, 0.90));
assert.ok(scoreFromEV(0.0406, 0.95, { robustEV: 0.03 }) < 7.2);
assert.ok(scoreFromEV(0.059, 0.95, { robustEV: 0.05 }) < 7.2);
assert.ok(scoreFromEV(0.06, 0.95, { robustEV: 0.05 }) >= 7.2);
assert.ok(scoreFromEV(0.11, 0.98, { robustEV: 0.08 }) >= 8.5);
assert.ok(scoreFromEV(0.11, 0.98, { robustEV: 0.079 }) < 8.5);
assert.ok(scoreFromEV(0.20, 0.98, { robustEV: 0.15, integrityWarning: true }) <= 6.8);
assert.ok(scoreFromEV(0.10, 0.98, { robustEV: -0.001 }) <= 5.9);
assert.equal(resultTag(8.5), '最強主推');
assert.equal(resultTag(7.2), '下注候選');
assert.ok(priceCLV(0.95, 0.90) > 0);

assert.equal(marketIsOpen([{ pick: '' }, { pick: '' }]), false);
assert.deepEqual(validateMarketPair('上半讓分', [{ pick: '', water: 0.95 }, { pick: '', water: 0.95 }]), []);
assert.deepEqual(validateMarketPair('全場大小', [{ pick: '大8+50', water: 0.94 }, { pick: '小8+50', water: 0.94 }]), []);
assert.ok(validateMarketPair('全場大小', [{ pick: '大8+50', water: 0.94 }, { pick: '小9+50', water: 0.94 }]).length);
assert.ok(validateMarketPair('全場讓分', [{ pick: `${home}讓1平`, water: '' }, { pick: `${away}受讓1平`, water: 0.95 }]).some(value => value.includes('水位')));
assert.ok(validateMarketPair('全場讓分', [{ pick: `${home}讓1平`, water: 0.95 }, { pick: `${home}受讓1平`, water: 0.95 }]).some(value => value.includes('同一隊')));

const visionGame = normalizeVisionGame({
  away,
  home,
  fullRunline: { favoriteSide: 'away', line: '1+10', favoriteWater: 0.95, underdogWater: 0.95, confidence: 0.94 },
  fullTotal: { line: '8+90', overWater: 0.94, underWater: 0.94, confidence: 0.92 },
  first5Runline: { favoriteSide: 'away', line: '0-70', favoriteWater: 0.95, underdogWater: 0.95, confidence: 0.93 },
  first5Total: { line: '4+50', overWater: 0.93, underWater: 0.93, confidence: 0.91 },
}, { gamePk: 1, away, home }, 0.95);
assert.equal(visionGame.markets.length, 4);
assert.equal(visionGame.markets.flatMap(row => row.directions).length, 8);
assert.equal(visionGame.markets[0].directions[1].pick, `${home}受讓1+10`);

const context = {
  game: { away, home, awayProbable: 'A', homeProbable: 'B' },
  away: {
    seasonHitting: { available: true, gamesPlayed: 110, runsPerGame: 4.7, ops: 0.75 },
    recentHitting: { available: true, gamesPlayed: 12, runsPerGame: 4.9, ops: 0.76 },
    seasonPitching: { available: true, gamesPlayed: 110, inningsPitched: 980, era: 4.0, whip: 1.27 },
    recentPitching: { available: true, inningsPitched: 22, era: 3.9, whip: 1.24 },
    starter: { available: true, throws: 'R', season: { inningsPitched: 118, era: 3.85, whip: 1.22, kMinusBB: 0.16 }, recent: { inningsPitched: 18, era: 3.6, whip: 1.18, kMinusBB: 0.18 } },
    vsLeft: { available: true, ops: 0.74 }, vsRight: { available: true, ops: 0.75 },
    lineup: { official: false, missingCoreCount: 0 }, rest: { days: 1, travelKm: 0 }, bullpen: { fatigueIndex: 0.18 }, injuries: [],
  },
  home: {
    seasonHitting: { available: true, gamesPlayed: 110, runsPerGame: 4.4, ops: 0.72 },
    recentHitting: { available: true, gamesPlayed: 12, runsPerGame: 4.3, ops: 0.71 },
    seasonPitching: { available: true, gamesPlayed: 110, inningsPitched: 980, era: 4.15, whip: 1.29 },
    recentPitching: { available: true, inningsPitched: 22, era: 4.2, whip: 1.30 },
    starter: { available: true, throws: 'L', season: { inningsPitched: 112, era: 4.15, whip: 1.29, kMinusBB: 0.14 }, recent: { inningsPitched: 17, era: 4.25, whip: 1.32, kMinusBB: 0.13 } },
    vsLeft: { available: true, ops: 0.70 }, vsRight: { available: true, ops: 0.72 },
    lineup: { official: false, missingCoreCount: 0 }, rest: { days: 1, travelKm: 0 }, bullpen: { fatigueIndex: 0.25 }, injuries: [],
  },
  weather: { available: true, temperature: 24, windSpeed: 8 },
  park: { runFactor: 1.01, roof: 'open' },
};

const runs = estimateRuns(context, false);
assert.ok(runs.away >= 2.3 && runs.away <= 7.1 && runs.home >= 2.3 && runs.home <= 7.1);
const markets = visionGame.markets.flatMap(row => row.directions.map(direction => ({ market: row.market, ...direction })));
const analysis = analyzeMarkets({ context, markets, settings: { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5 } });
assert.equal(analysis.modelVersion, '市場錨定穩健模型-2026-08-v5');
assert.equal(analysis.results.length, 8);
assert.ok(analysis.results.every(result => Number.isFinite(result.score) && Number.isFinite(result.ev) && Number.isFinite(result.rawEV)));
assert.ok(analysis.results.every(result => result.modelProbability > 0 && result.modelProbability < 1));
assert.ok(analysis.results.every(result => result.distributionCoverage > 0.999999));
assert.ok(analysis.results.every(result => !result.integrityWarning || result.score < 7.2));
assert.ok(analysis.results.every(result => result.tag !== '最強主推' || result.robustEV >= 0.08));

for (const marketName of ['全場讓分', '全場大小', '上半讓分', '上半大小']) {
  const pair = analysis.results.filter(result => result.market === marketName);
  assert.equal(pair.length, 2);
  assert.ok(Math.abs(pair[0].modelProbability + pair[1].modelProbability - 1) < 1e-8, `${marketName} 校準機率必須互補`);
  assert.ok(Math.abs(pair[0].marketAnchorProbability + pair[1].marketAnchorProbability - 1) < 1e-8, `${marketName} 市場基準必須互補`);
}

// 截圖中類似「亞特蘭大勇士受讓1+10」不得再出現 99.93% 的解析型異常。
const screenshotLike = analysis.results.find(result => result.pick === `${home}受讓1+10`);
assert.ok(screenshotLike);
assert.ok(screenshotLike.rawModelProbability > 0.08 && screenshotLike.rawModelProbability < 0.92);
assert.equal(screenshotLike.distributionCoverage > 0.999999, true);

// 極端輸入仍可顯示，但會被正式版安全閘門封鎖，不得列為下注候選。
const extreme = analyzeMarkets({
  context,
  markets: [
    { market: '全場大小', pick: '大2平', water: 0.95, confidence: 1 },
    { market: '全場大小', pick: '小2平', water: 0.95, confidence: 1 },
  ],
  settings: { rebateRate: 0.015 },
});
assert.ok(extreme.results.every(result => result.integrityWarning));
assert.ok(extreme.results.every(result => result.score < 7.2));
assert.ok(extreme.results.every(result => result.betEligible === false));
assert.ok(extreme.results.every(result => result.tag === '模型異常｜不下注'));

// 未開盤市場可完全省略，只分析實際開盤市場。
const partial = analyzeMarkets({ context, markets: markets.filter(row => row.market === '全場大小'), settings: { rebateRate: 0.015 } });
assert.equal(partial.results.length, 2);

// 同一合約水位更好時，EV 與評分不得更差。
const betterPrice = analyzeMarkets({
  context,
  markets: [
    { market: '全場大小', pick: '大8平', water: 0.95, confidence: 1 },
    { market: '全場大小', pick: '小8平', water: 0.95, confidence: 1 },
  ],
  settings: { rebateRate: 0.015 },
}).results.find(result => result.pick === '大8平');
const worsePrice = analyzeMarkets({
  context,
  markets: [
    { market: '全場大小', pick: '大8平', water: 0.90, confidence: 1 },
    { market: '全場大小', pick: '小8平', water: 0.95, confidence: 1 },
  ],
  settings: { rebateRate: 0.015 },
}).results.find(result => result.pick === '大8平');
assert.ok(betterPrice.ev >= worsePrice.ev);
assert.ok(betterPrice.score >= worsePrice.score);

console.log(JSON.stringify({
  ok: true,
  modelVersion: analysis.modelVersion,
  dataQuality: analysis.dataQuality,
  screenshotLike: {
    pick: screenshotLike.pick,
    rawProbability: screenshotLike.rawModelProbability,
    calibratedProbability: screenshotLike.modelProbability,
    robustEV: screenshotLike.robustEV,
    weightedEV: screenshotLike.weightedEV,
    score: screenshotLike.score,
  },
  maximumScore: Math.max(...analysis.results.map(result => result.score)),
}, null, 2));
