import { nbaResultQuoteCurrent, validPreseasonResult } from './analysis-job-display.js';
export const NBA_RANK_MARKETS = [
  ['fullTotal', '全場大小'], ['fullRunline', '全場讓分'],
  ['firstHalfTotal', '上半大小'], ['firstHalfRunline', '上半讓分'],
];
// Display-only: retain both sides, including negative estimates. No S score or
// bet qualification is fabricated from the NBA probability/contract estimates.
export function buildNbaShadowRanking(rows, date, now = Date.now(), marketFilter = 'all') {
  const entries = [], seen = new Set();
  let currentGames = 0, outdatedGames = 0, pendingGames = 0;
  for (const row of rows) {
    const game = row?.game, result = row?.result;
    if (game?.league !== 'NBA' || !/^nba:espn:game:[1-9]\d+$/.test(game.id || '') || seen.has(game.id)) continue;
    seen.add(game.id);
    if (result?.status !== 'ready' || result.league !== 'NBA' || result.gameId !== game.id || result.date !== date || result.executable !== false) { pendingGames++; continue; }
    const preseason = result.modelVersion === 'nba-preseason-history-ridge-v1';
    if (preseason ? !validPreseasonResult(result, date) : result.modelVersion !== 'nba-total-pace-rest-v1') { pendingGames++; continue; }
    if (!nbaResultQuoteCurrent(row, now)) { outdatedGames++; continue; }
    currentGames++;
    for (const [key, label] of NBA_RANK_MARKETS) {
      if (marketFilter !== 'all' && marketFilter !== key) continue;
      const total = key.endsWith('Total');
      const market = preseason ? result.marketAnalyses[key] : key === 'fullTotal' ? {
        status: 'ready', quote: result.quote, sides: { over: { expectedNet: result.assessment?.positiveExpectedNet }, under: { expectedNet: result.assessment?.negativeExpectedNet } }, samples: result.assessment?.distributionSamples,
      } : null;
      if (market?.status !== 'ready') continue;
      for (const side of total ? ['over', 'under'] : ['away', 'home']) {
        const estimate = market.sides?.[side], quote = market.quote;
        const water = total ? quote?.[side === 'over' ? 'overWater' : 'underWater'] : quote?.[`${side}Water`];
        if (!Number.isFinite(estimate?.expectedNet) || !Number.isFinite(water)) continue;
        entries.push({ stableKey: `${game.id}:${key}:${side}`, game, marketKey: key, market: label, side,
          role: total ? side === 'over' ? '大分' : '小分' : side === quote.lineSide ? '讓分' : '受讓',
          line: quote.line, water, expectedNet: estimate.expectedNet,
          winProbability: Number.isFinite(estimate.winProbability) ? estimate.winProbability : null,
          pushProbability: Number.isFinite(estimate.pushProbability) ? estimate.pushProbability : null,
          samples: market.samples, observedAt: row.observedAt, modelVersion: result.modelVersion });
      }
    }
  }
  entries.sort((a, b) => b.expectedNet - a.expectedNet || (b.winProbability ?? -1) - (a.winProbability ?? -1)
    || Date.parse(a.game.startTime) - Date.parse(b.game.startTime) || a.stableKey.localeCompare(b.stableKey));
  return { entries, currentGames, outdatedGames, pendingGames };
}
