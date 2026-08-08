import assert from 'node:assert/strict';
import {
  calculateProfit,
  outcomeFractionForScore,
  parseTaiwanLine,
  priceCLV,
  resultLabel,
  validateMarketPair,
  normalizeVisionGame,
  normalizeWater,
  evFromProbability,
  scoreFromEV,
  resultTag,
} from '../lib/markets.js';
import { analyzeMarkets, estimateRuns } from '../lib/analysis.js';
import { cleanVisionJSON, matchScheduleGame, normalizeTeamName } from '../lib/vision.js';

const away = 'Oakland Athletics', home = 'Boston Red Sox';

// Vision JSON repair and conservative schedule matching.
assert.deepEqual(cleanVisionJSON('```json\n{"games":[],}\n```'), { games: [] });
assert.equal(normalizeTeamName('Boston Red Sox'), 'bostonredsox');
const schedule = [{ gamePk: 1, away: 'Oakland Athletics', home: 'Boston Red Sox' }, { gamePk: 2, away: 'New York Yankees', home: 'Toronto Blue Jays' }];
assert.equal(matchScheduleGame({ gamePk: 1 }, schedule)?.gamePk, 1);
assert.equal(matchScheduleGame({ away: 'Oakland', home: 'Boston' }, schedule)?.gamePk, 1);
assert.equal(matchScheduleGame({ away: 'Oakland', home: 'Toronto' }, schedule), null);

// Taiwan credit-line parsing and exact-line partial settlement.
assert.equal(parseTaiwanLine('大8+50').isOver, true);
assert.equal(parseTaiwanLine(`${home}讓1-20`).isGiving, true);
assert.equal(parseTaiwanLine(`${away}受讓0.5/1`).legs.length, 2);
assert.equal(outcomeFractionForScore('大8+50', 4, 4, away, home), -.5);
assert.equal(outcomeFractionForScore('小8+50', 4, 4, away, home), .5);
assert.equal(outcomeFractionForScore('大8-30', 4, 4, away, home), .3);
assert.equal(outcomeFractionForScore('小8-30', 4, 4, away, home), -.3);
assert.equal(outcomeFractionForScore(`${home}讓1-20`, 3, 4, away, home), .2);
assert.equal(outcomeFractionForScore(`${away}受讓1-20`, 3, 4, away, home), -.2);
assert.equal(outcomeFractionForScore(`${home}讓1+50`, 3, 4, away, home), -.5);
assert.equal(outcomeFractionForScore(`${away}受讓1+50`, 3, 4, away, home), .5);
assert.equal(outcomeFractionForScore(`${away}受讓0.5/1`, 3, 4, away, home), -.5);
assert.equal(outcomeFractionForScore('大8平', 4, 4, away, home), 0);
assert.equal(outcomeFractionForScore('大8平', 5, 4, away, home), 1);
assert.equal(outcomeFractionForScore('大8平', 3, 4, away, home), -1);
assert.equal(outcomeFractionForScore('大8平', '', 4, away, home), null);

// Rebate and profit are based only on the settled fraction.
assert.equal(resultLabel(.65), '贏65%');
assert.equal(resultLabel(-.3), '輸30%');
assert.equal(resultLabel(0), '走水');
let profit = calculateProfit({ stake: 10000, water: .95, fraction: .5, rebateRate: .015 });
assert.equal(profit.rebate, 75); assert.equal(profit.profit, 4825); assert.equal(profit.settledAmount, 5000);
profit = calculateProfit({ stake: 10000, water: .95, fraction: -.3, rebateRate: .015 });
assert.equal(profit.rebate, 45); assert.equal(profit.profit, -2955); assert.equal(profit.settledAmount, 3000);
profit = calculateProfit({ stake: 10000, water: .95, fraction: 0, rebateRate: .015 });
assert.equal(profit.rebate, 0); assert.equal(profit.profit, 0);

// Water, EV, score and CLV safety. Score mapping must not jump to 9.6 on ordinary edges.
assert.equal(normalizeWater(null, .95), .95);
assert.equal(normalizeWater('', .94), .94);
assert.equal(normalizeWater(0, .95), .5);
assert.ok(evFromProbability(.55, .95) > evFromProbability(.55, .90));
assert.ok(scoreFromEV(.08, .8) > scoreFromEV(.04, .8));
assert.ok(scoreFromEV(.08, .9) >= 7 && scoreFromEV(.08, .9) < 7.5);
assert.ok(scoreFromEV(.2, .9) < 9);
assert.ok(scoreFromEV(-.1, .9) < 4);
assert.equal(resultTag(8.5), '最強主推');
assert.equal(resultTag(7.2), '下注候選');
assert.ok(priceCLV(.95, .90) > 0);

// Contract-pair validation and eight-direction normalization.
assert.deepEqual(validateMarketPair('全場大小', [{ pick: '大8+50', water: .94 }, { pick: '小8+50', water: .94 }]), []);
assert.ok(validateMarketPair('全場大小', [{ pick: '大8+50', water: .94 }, { pick: '小9+50', water: .94 }]).length);
assert.ok(validateMarketPair('全場讓分', [{ pick: `${home}讓1平`, water: '' }, { pick: `${away}受讓1平`, water: .95 }]).some(x => x.includes('水位')));
const vg = normalizeVisionGame({ away, home, fullRunline: { favoriteSide: 'home', line: '1+50', favoriteWater: null, underdogWater: null }, fullTotal: { line: '8+50', overWater: .94, underWater: .94 }, first5Runline: { favoriteSide: 'home', line: '0-70', favoriteWater: .95, underdogWater: .95 }, first5Total: { line: '4+50', overWater: .93, underWater: .93 } }, null, .95);
assert.equal(vg.markets.length, 4); assert.equal(vg.markets.flatMap(x => x.directions).length, 8);
assert.equal(vg.markets[0].directions[0].water, .95);

// Model smoke, calibration and dominance checks.
const context = { game: { away, home, awayProbable: 'A', homeProbable: 'B' }, away: { seasonHitting: { available: true, runsPerGame: 4.5, ops: .73 }, recentHitting: { available: true, gamesPlayed: 10, runsPerGame: 4.8, ops: .75 }, seasonPitching: { available: true, era: 4.1, whip: 1.28 }, recentPitching: { available: true, inningsPitched: 20, era: 4, whip: 1.25 }, starter: { available: true, season: { era: 4, whip: 1.25, kMinusBB: .15 }, recent: { inningsPitched: 12, era: 3.8, whip: 1.2, kMinusBB: .16 } }, vsLeft: { available: false }, vsRight: { available: false }, lineup: { official: false }, rest: { days: 1, travelKm: 0 }, bullpen: { fatigueIndex: .2 }, injuries: [] }, home: { seasonHitting: { available: true, runsPerGame: 4.6, ops: .74 }, recentHitting: { available: true, gamesPlayed: 10, runsPerGame: 4.7, ops: .74 }, seasonPitching: { available: true, era: 4, whip: 1.27 }, recentPitching: { available: true, inningsPitched: 20, era: 3.9, whip: 1.24 }, starter: { available: true, season: { era: 3.9, whip: 1.22, kMinusBB: .16 }, recent: { inningsPitched: 12, era: 3.7, whip: 1.18, kMinusBB: .17 } }, vsLeft: { available: false }, vsRight: { available: false }, lineup: { official: false }, rest: { days: 1, travelKm: 0 }, bullpen: { fatigueIndex: .2 }, injuries: [] }, weather: { available: true, temperature: 24, windSpeed: 8 }, park: { runFactor: 1, roof: 'open' } };
const runs = estimateRuns(context, false); assert.ok(runs.away > 0 && runs.home > 0);
const markets = vg.markets.flatMap(m => m.directions.map(d => ({ market: m.market, ...d })));
const analysis = analyzeMarkets({ context, markets, settings: { rebateRate: .015, candidateThreshold: 7.2, strongestThreshold: 8.5 } });
assert.equal(analysis.modelVersion, 'calibrated-2026-08');
assert.equal(analysis.results.length, 8);
assert.ok(analysis.results.every(x => Number.isFinite(x.score) && Number.isFinite(x.ev) && Number.isFinite(x.rawEV)));
assert.ok(analysis.results.every(x => x.modelProbability >= .35 && x.modelProbability <= .65));
assert.ok(analysis.results.every(x => x.score <= 9.4));
const totalPair = analysis.results.filter(x => x.market === '全場大小');
assert.ok(Math.abs(totalPair[0].modelProbability + totalPair[1].modelProbability - 1) < 1e-8);
assert.ok(totalPair.every(x => Math.abs(x.weightedEV) <= Math.abs(x.rawEV) + .03));

// Deliberately absurd lines must be shrunk instead of becoming automatic 9.6 strongest plays.
const extremeMarkets = [
  { market: '全場大小', pick: '大2平', water: .95, confidence: 1 },
  { market: '全場大小', pick: '小2平', water: .95, confidence: 1 },
  { market: '全場讓分', pick: `${home}讓5平`, water: .95, confidence: 1 },
  { market: '全場讓分', pick: `${away}受讓5平`, water: .95, confidence: 1 },
];
const extreme = analyzeMarkets({ context, markets: extremeMarkets, settings: { rebateRate: .015 } });
assert.ok(extreme.results.every(x => x.modelProbability >= .39 && x.modelProbability <= .61));
assert.ok(extreme.results.every(x => x.score < 9));
assert.ok(extreme.results.some(x => x.edgeClipped));

const samePick = [
  { market: '全場大小', pick: '大8平', water: .95, confidence: 1 },
  { market: '全場大小', pick: '大8平', water: .90, confidence: 1 },
  { market: '全場讓分', pick: `${home}讓1平`, water: .95, confidence: 1 },
  { market: '全場讓分', pick: `${away}受讓1平`, water: .95, confidence: 1 },
  { market: '上半大小', pick: '大4平', water: .95, confidence: 1 },
  { market: '上半大小', pick: '小4平', water: .95, confidence: 1 },
  { market: '上半讓分', pick: `${home}讓0平`, water: .95, confidence: 1 },
  { market: '上半讓分', pick: `${away}受讓0平`, water: .95, confidence: 1 },
];
const dominance = analyzeMarkets({ context, markets: samePick, settings: { rebateRate: .015 } }).results.filter(x => x.market === '全場大小');
assert.ok(dominance[0].ev > dominance[1].ev);
assert.ok(dominance[0].score >= dominance[1].score);

console.log('All MLB Positive EV v3.1.1 calibrated-model tests passed');
