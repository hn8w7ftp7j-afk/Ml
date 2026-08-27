import assert from 'node:assert/strict';
import { buildAsianGameContext } from '../lib/asian-baseball.js';
import {
  analyzeMarkets,
  buildDistributionSnapshot,
  evaluateMarketsFromDistribution,
  repriceMarkets,
} from '../lib/analysis-v11.js';

const leagues = {
  NPB: ['讀賣巨人', '橫濱DeNA灣星', 501, 503, 'YOM', 'YDB'],
  KBO: ['KIA虎', 'LG雙子', 601, 603, 'KIA', 'LGT'],
  CPBL: ['樂天桃猿', '味全龍', 703, 705, 'RKM', 'WCD'],
};

for (const [league, [away, home, awayTeamId, homeTeamId, awayCode, homeCode]] of Object.entries(leagues)) {
  const game = {
    league, leagueId: league, gamePk: 880000 + awayTeamId,
    gameDate: '2099-08-23T09:00:00.000Z', officialDate: '2099-08-23', taipeiDate: '2099-08-23',
    statusCode: 'S', scheduledInnings: 9, venue: '測試球場',
    away, home, awayCode, homeCode, awayTeamId, homeTeamId,
  };
  const historyGames = Array.from({ length: 18 }, (_, index) => ({
    ...game,
    gamePk: game.gamePk + index + 1,
    gameDate: `2099-08-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
    statusCode: 'F', awayScore: 3 + (index % 2), homeScore: 2 + (index % 3), innings: 9,
  }));
  const context = await buildAsianGameContext(league, game, { historyGames });
  assert.equal(context.coreModelable, false, `${league}官方賽程＋整隊比分不得建立方向`);
  assert.equal(context.dataGateV10.passedForShadowScore, false);
  assert.equal(context.betEligible, false);
  assert.equal(context.executable, false);
  assert.equal(context.asianProxyAudit.mlbFallbackUsed, false);

  for (const call of [
    () => buildDistributionSnapshot({ context }),
    () => analyzeMarkets({ context, markets: [] }),
    () => evaluateMarketsFromDistribution({ context, markets: [], distributionSnapshot: {} }),
    () => repriceMarkets({ context, markets: [], distributionSnapshot: {} }),
  ]) {
    assert.throws(call, error => error?.code === 'ASIAN_DISTRIBUTION_INPUT_GATE_BLOCKED'
      && /禁止回退analysis-v10或MLB參數/.test(error.message));
  }
}

console.log('Asian NPB/KBO/CPBL runtime PIT fail closed: no legacy/MLB fallback or incomplete-input EV PASS');
