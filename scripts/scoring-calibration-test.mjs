import assert from 'node:assert/strict';
import { analyzeMarkets } from '../lib/analysis.js';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer.js';
import { breakEvenProbability, evFromProbability } from '../lib/markets.js';

const team = () => ({
  seasonHitting: { gamesPlayed: 120, runsPerGame: 4.35, ops: 0.72, iso: 0.15, kRate: 0.225, bbRate: 0.085 },
  recentHitting: { gamesPlayed: 12, runsPerGame: 4.35, ops: 0.72, iso: 0.15, kRate: 0.225, bbRate: 0.085 },
  vsLeft: { available: true, ops: 0.72 },
  vsRight: { available: true, ops: 0.72 },
  lineup: { projected: true, offensiveIndex: 1, players: [] },
  injuryImpact: 0,
  baserunning: { runIndex: 1 },
  defense: { available: true, fieldingPercentage: 0.985, errorsPerGame: 0.55 },
  recentPitching: { inningsPitched: 50, era: 4.2, whip: 1.3 },
  bullpen: { usageAvailable: true, fatigueIndex: 0.2, highLeverageAvailability: 0.75, qualityFactor: 1 },
  rest: { available: true, days: 1, travelKm: 0 },
  starter: {
    available: true,
    confirmed: true,
    throws: 'R',
    expectedInnings: 5.2,
    season: { gamesStarted: 20, inningsPitched: 110, era: 4.2, fip: 4.2, whip: 1.3, kMinusBB: 0.14, hrPer9: 1.15 },
    recent: { gamesStarted: 5, inningsPitched: 27, era: 4.2, fip: 4.2, whip: 1.3, kMinusBB: 0.14, hrPer9: 1.15 },
    pitchQuality: { available: true, runFactor: 1 },
  },
});

const context = {
  coreModelable: true,
  coreFingerprint: 'scoring-calibration-regression-v1',
  game: { gamePk: 990001, away: '客隊', home: '主隊' },
  league: { runsPerTeamGame: 4.35 },
  away: team(),
  home: team(),
  park: { runFactor: 1, roof: 'open' },
  weather: { available: true, temperature: 21, windSpeed: 0, precipitationProbability: 0, roofConfirmed: true },
  umpire: { name: 'Regression Umpire' },
  featureProvenance: [],
};

const settings = {
  rebateRate: 0.015,
  candidateThreshold: 7.2,
  strongestThreshold: 8.5,
  simulationsPerScenario: 500,
};

const direction = (market, pick, water) => ({
  market,
  pick,
  water,
  waterEstimated: false,
  sourceType: 'ACTUAL_TW_CREDIT',
  executable: true,
});

const markets = [
  direction('全場讓分', '客隊讓1平', 0.95),
  direction('全場讓分', '主隊受讓1平', 0.95),
  direction('全場大小', '大8.5', 0.94),
  direction('全場大小', '小8.5', 0.94),
  direction('上半讓分', '客隊讓0.5', 0.94),
  direction('上半讓分', '主隊受讓0.5', 0.94),
  direction('上半大小', '大4.5', 0.93),
  direction('上半大小', '小4.5', 0.93),
];

// Taiwanese credit settlement: at 0.94 water a 50/50 proposition still loses
// 1.5% after the 1.5% turnover rebate.  The true break-even is about 50.7732%.
assert.ok(Math.abs(evFromProbability(0.5, 0.94, 0.015) - (-0.015)) < 1e-12);
assert.ok(Math.abs(breakEvenProbability(0.94, 0.015) - (0.985 / 1.94)) < 1e-12);
assert.ok(Math.abs(evFromProbability(0.55, 0.94, 0.015) - 0.082) < 1e-12);

const previousMarkets = markets.map(row => ({ ...row, water: Math.max(0.5, row.water - 0.04) }));
const preliminary = analyzeMarkets({ context, markets, previousMarkets, settings });
const finalized = finalizeDeterministicAnalysis({ analysis: preliminary, game: context.game, settings });

assert.equal(finalized.results.length, 8);
for (const row of finalized.results) {
  assert.equal(row.marketCalibrationApplied, true, `${row.market} ${row.pick}`);
  assert.ok(row.marketCalibrationWeight > 0 && row.marketCalibrationWeight < 1, `${row.market} ${row.pick}`);
  assert.ok(row.maximumCalibratedProbabilityEdge <= 0.07, `${row.market} ${row.pick}`);
  assert.ok(Number.isFinite(row.rawEV), `${row.market} ${row.pick}`);
  assert.ok(Number.isFinite(row.weightedEV), `${row.market} ${row.pick}`);
  assert.equal(row.evDoubleCheck?.passed, true, `${row.market} ${row.pick}`);
  assert.equal(row.movement?.available, true, `${row.market} ${row.pick}`);
  assert.ok(Number.isFinite(row.movement?.deltaEV), `${row.market} ${row.pick}`);
  assert.ok(row.movement.deltaEV > 0 && row.movement.deltaEV < 0.04, `${row.market} ${row.pick} 新舊水位EV比較異常`);
  assert.match(row.movement.method, /同一校準勝率/);
}

for (const market of ['全場讓分', '全場大小', '上半讓分', '上半大小']) {
  const pair = finalized.results.filter(row => row.market === market);
  assert.equal(pair.length, 2);
  assert.ok(Math.abs(pair[0].modelProbability + pair[1].modelProbability - 1) <= 0.012, market);
  assert.ok(pair.filter(row => row.betEligible).length <= 1, `${market} 同市場不可兩邊同時可下注`);
}

// A neutral, realistically priced four-market card must not manufacture an
// 8-point recommendation in every market.  Before the regression fix, raw
// model EVs around 5%-18% flowed straight into the formal score.
const scoresAtLeastEight = finalized.results.filter(row => Number(row.score) >= 8).length;
assert.ok(scoresAtLeastEight <= 1, `中性基準出現過多8+方向：${scoresAtLeastEight}`);
assert.ok(Math.max(...finalized.results.map(row => row.weightedEV)) < 0.04, '中性基準正式EV不應達4%');

const positiveRaw = finalized.results.filter(row => row.rawEV > 0.04);
assert.ok(positiveRaw.length >= 2, '測試必須涵蓋未校準時會產生高EV的方向');
for (const row of positiveRaw) {
  assert.ok(row.weightedEV < row.rawEV, `${row.market} ${row.pick} 正式EV應低於raw診斷EV`);
}

// Even a deliberately stale/extreme line may remain a candidate, but the raw
// 30%-50% model edge must not be published unchanged as formal EV.
const extremeMarkets = [
  direction('全場大小', '大6.5', 0.94),
  direction('全場大小', '小6.5', 0.94),
  direction('上半大小', '大3.5', 0.93),
  direction('上半大小', '小3.5', 0.93),
];
const extreme = finalizeDeterministicAnalysis({
  analysis: analyzeMarkets({
    context: { ...context, coreFingerprint: 'scoring-calibration-extreme-v1' },
    markets: extremeMarkets,
    settings,
  }),
  game: context.game,
  settings,
});
const extremePositive = extreme.results.filter(row => row.rawEV > 0.20);
assert.ok(extremePositive.length >= 1, '極端案例必須涵蓋raw EV 20%+');
for (const row of extremePositive) {
  assert.ok(row.weightedEV <= 0.12, `${row.market} ${row.pick} 正式EV超過12%`);
  assert.ok(row.rawEV - row.weightedEV >= 0.15, `${row.market} ${row.pick} 未充分收縮raw EV`);
  assert.ok(row.score <= 7.4, `${row.market} ${row.pick} 極端模型分歧不應成為8+正式訊號`);
  assert.equal(row.betEligible, false, `${row.market} ${row.pick} 模型與市場差距18%+必須封鎖正式下注`);
  assert.match(row.tag, /模型與市場差距過大/);
}

console.log(JSON.stringify({
  ok: true,
  breakEvenAt094: breakEvenProbability(0.94, 0.015),
  scoresAtLeastEight,
  extremePositive: extremePositive.map(row => ({ pick: row.pick, rawEV: row.rawEV, calibratedEV: row.weightedEV, score: row.score })),
  rows: finalized.results.map(row => ({
    market: row.market,
    pick: row.pick,
    rawEV: row.rawEV,
    calibratedEV: row.weightedEV,
    robustEV: row.robustEV,
    score: row.score,
    eligible: row.betEligible,
  })),
}, null, 2));
