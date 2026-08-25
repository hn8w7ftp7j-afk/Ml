import assert from 'node:assert/strict';
import { buildAsianGameContext } from '../lib/asian-baseball.js';
import { buildDistributionSnapshot, evaluateMarketsFromDistribution } from '../lib/analysis-v11.js';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';

const settings = { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5 };
const fixtures = {
  NPB: ['讀賣巨人', '橫濱DeNA灣星', 501, 503, '8平', '4.5'],
  KBO: ['KIA虎', 'LG雙子', 601, 603, '9.5', '5平'],
  CPBL: ['樂天桃猿', '味全龍', 703, 705, '9平', '5平'],
};

function gameFor(league, [away, home, awayTeamId, homeTeamId]) {
  return { league, leagueId: league, gamePk: 880000 + awayTeamId, gameDate: '2099-08-23T09:00:00.000Z', officialDate: '2099-08-23', taipeiDate: '2099-08-23', statusCode: 'S', scheduledInnings: 9, venue: '測試球場', away, home, awayTeamId, homeTeamId };
}

function historyFor(game) {
  return Array.from({ length: 18 }, (_, index) => {
    const date = `2099-08-${String(index + 1).padStart(2, '0')}`;
    return { ...game, gamePk: game.gamePk + index + 1, gameDate: `${date}T09:00:00.000Z`, officialDate: date, statusCode: 'F', awayScore: [2, 5, 1, 4, 3, 6][index % 6], homeScore: [3, 1, 5, 2, 4, 2][index % 6], innings: index % 7 === 0 ? 10 : 9 };
  });
}

function marketRows(game, [, , , , fullTotal, first5Total]) {
  const actual = (market, pick, water) => ({ market, pick, water, waterEstimated: false, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', lineFresh: true, executable: true, marketVerification: { verified: false, referencePriorEligible: false } });
  return [
    actual('全場讓分', `${game.away}受讓0平`, 0.95), actual('全場讓分', `${game.home}讓0平`, 0.95),
    actual('全場大小', `大${fullTotal}`, 0.94), actual('全場大小', `小${fullTotal}`, 0.94),
    actual('上半讓分', `${game.away}受讓0平`, 0.94), actual('上半讓分', `${game.home}讓0平`, 0.94),
    actual('上半大小', `大${first5Total}`, 0.93), actual('上半大小', `小${first5Total}`, 0.93),
  ];
}

async function analyze(league, fixture, historyGames) {
  const game = gameFor(league, fixture);
  const context = await buildAsianGameContext(league, game, { historyGames });
  assert.equal(context.dataGateV10.passedForShadowScore, true);
  const snapshot = buildDistributionSnapshot({ context, settings });
  const preliminary = evaluateMarketsFromDistribution({ context, markets: marketRows(game, fixture), settings, distributionSnapshot: snapshot });
  return { game, context, snapshot, preliminary, finalized: finalizeDeterministicAnalysis({ analysis: preliminary, game, settings }) };
}

for (const [league, fixture] of Object.entries(fixtures)) {
  const history = historyFor(gameFor(league, fixture));
  const base = await analyze(league, fixture, history);
  assert.equal(base.preliminary.results.length, 8);
  assert.ok(base.preliminary.results.every(row => row.evCalibration?.qualified === true));
  assert.ok(base.preliminary.results.every(row => Number.isFinite(row.weightedEV) && Number.isFinite(row.robustEV) && row.robustEV <= row.weightedEV + 1e-12));
  assert.ok(base.finalized.results.some(row => Number.isFinite(row.formulaDiagnosticScore)));
  assert.ok(base.finalized.results.every(row => row.score === null && row.betEligible === false));
  const changedWaterMarkets = marketRows(base.game, fixture).map((row, index) => ({ ...row, water: Number(row.water) + (index % 2 ? -0.02 : 0.03) }));
  const changedWater = evaluateMarketsFromDistribution({ context: base.context, markets: changedWaterMarkets, settings, distributionSnapshot: base.snapshot });
  assert.equal(changedWater.distributionId, base.preliminary.distributionId, `${league} water changes must reuse the same frozen score distribution`);
  for (const row of base.preliminary.results) {
    const repriced = changedWater.results.find(item => item.market === row.market && item.pick === row.pick);
    assert.ok(Math.abs(row.rawModelProbability - repriced.rawModelProbability) <= 1e-12, `${league} Tai888 water must not rewrite upstream baseball probability`);
  }
  for (const market of ['全場讓分', '全場大小', '上半讓分', '上半大小']) {
    const pair = base.preliminary.results.filter(row => row.market === market);
    assert.ok(Math.abs(pair[0].modelProbability + pair[1].modelProbability - 1) <= 0.012);
  }
  const changed = await analyze(league, fixture, history.map((row, index) => index === 0 ? { ...row, awayScore: row.awayScore + 1 } : row));
  const maxJump = Math.max(...base.preliminary.results.map((row, index) => Math.abs(row.weightedEV - changed.preliminary.results[index].weightedEV)));
  assert.ok(maxJump <= 0.05, `${league} EV jump ${(maxJump * 100).toFixed(2)}pp`);

  const extremeHistory = history.map((row, index) => ({
    ...row,
    awayScore: [7, 8, 6][index % 3],
    homeScore: [1, 2, 1][index % 3],
  }));
  const extreme = await analyze(league, fixture, extremeHistory);
  const maximumPositiveEV = Math.max(...extreme.preliminary.results.map(row => row.weightedEV));
  assert.ok(maximumPositiveEV <= 0.15, `${league} 小樣本極端近況不得產生不可信的長期EV ${(maximumPositiveEV * 100).toFixed(2)}%`);
}

console.log('Asian NPB/KBO/CPBL four-market EV stability and shadow-score contract PASS');
