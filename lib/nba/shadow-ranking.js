import { buildBetOrderEntries, groupBetOrderEntries } from '../bet-order.js';
import { nbaMarketScore } from './market-score.js';
import { nbaResultQuoteCurrent, validPreseasonResult, validRegularResult } from './analysis-job-display.js';
export const NBA_RANK_MARKETS = [
  ['fullTotal', '全場大小'], ['fullRunline', '全場讓分'],
  ['firstHalfTotal', '上半大小'], ['firstHalfRunline', '上半讓分'],
];
// Retain both sides and use the shared S formula only with verified NBA W/R inputs.
export function buildNbaShadowRanking(rows, date, now = Date.now(), marketFilter = 'all') {
  const entries = [], seen = new Set();
  let currentGames = 0, outdatedGames = 0, pendingGames = 0;
  for (const row of rows) {
    const game = row?.game, result = row?.result;
    if (game?.league !== 'NBA' || !/^nba:espn:game:[1-9]\d+$/.test(game.id || '') || seen.has(game.id)) continue;
    seen.add(game.id);
    if (result?.status !== 'ready' || result.league !== 'NBA' || result.gameId !== game.id || result.date !== date || result.executable !== false) { pendingGames++; continue; }
    const preseason = result.modelVersion === 'nba-preseason-history-ridge-v1';
    const regular = result.modelVersion === 'nba-regular-four-market-v1';
    if (regular ? !validRegularResult(result,date) : preseason ? !validPreseasonResult(result, date) : result.modelVersion !== 'nba-total-pace-rest-v1') { pendingGames++; continue; }
    if (!nbaResultQuoteCurrent(row, now)) { outdatedGames++; continue; }
    currentGames++;
    for (const [key, label] of NBA_RANK_MARKETS) {
      if (marketFilter !== 'all' && marketFilter !== key) continue;
      const total = key.endsWith('Total');
      const market = preseason || regular ? result.marketAnalyses[key] : key === 'fullTotal' ? {
        status: 'ready', quote: result.quote, sides: { over: { expectedNet: result.assessment?.positiveExpectedNet }, under: { expectedNet: result.assessment?.negativeExpectedNet } }, samples: result.assessment?.distributionSamples,
      } : null;
      if (market?.status !== 'ready') continue;
      for (const side of total ? ['over', 'under'] : ['away', 'home']) {
        const estimate = market.sides?.[side], quote = market.quote;
        const water = total ? quote?.[side === 'over' ? 'overWater' : 'underWater'] : quote?.[`${side}Water`];
        if (!Number.isFinite(estimate?.expectedNet) || !Number.isFinite(water)) continue;
        const scoring = nbaMarketScore(estimate);
        entries.push({ stableKey: `${game.id}:${key}:${side}`, game, marketKey: key, market: label, side,
          role: total ? side === 'over' ? '大分' : '小分' : side === quote.lineSide ? '讓分' : '受讓',
          line: quote.line, lineSide: total ? null : quote.lineSide, water, expectedNet: estimate.expectedNet,
          winProbability: Number.isFinite(estimate.winProbability) ? estimate.winProbability : null,
          pushProbability: Number.isFinite(estimate.pushProbability) ? estimate.pushProbability : null,
          score: scoring?.score ?? null, robustExpectedNet: scoring ? estimate.robustExpectedNet : null,
          samples: market.samples, observedAt: row.observedAt, modelVersion: result.modelVersion });
      }
    }
  }
  entries.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || b.expectedNet - a.expectedNet || (b.robustExpectedNet ?? -Infinity) - (a.robustExpectedNet ?? -Infinity)
    || Date.parse(a.game.startTime) - Date.parse(b.game.startTime) || a.stableKey.localeCompare(b.stableKey));
  return { entries, currentGames, outdatedGames, pendingGames };
}

export function buildNbaShadowOrder(entries) {
  const adapted = entries.map(entry => ({ ...entry,
    item: { game: { league: 'NBA', gamePk: entry.game.id, gameDate: entry.game.startTime } },
    matchup: `${entry.game.away?.name || ''} @ ${entry.game.home?.name || ''}`,
    pick: `${entry.side}:${entry.stableKey}`,
  }));
  return groupBetOrderEntries(buildBetOrderEntries(adapted));
}
