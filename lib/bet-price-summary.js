import { compareBetPrice } from './bet-price-comparison.js';
import { verifiedClosingPriceForBet } from './bet-price-feed.js';

const clean = value => String(value || '').trim().toUpperCase();

export function summarizeOriginalBetPrices(bets = [], priceFeed = {}, { now = Date.now() } = {}) {
  const summary = { total: 0, better: 0, worse: 0 };
  for (const bet of Array.isArray(bets) ? bets : []) {
    if (!bet?.id || clean(bet?.status) === 'CANCELLED'
      || clean(bet?.performanceEligibility).startsWith('EXCLUDED_')) continue;
    const reference = verifiedClosingPriceForBet(bet, { now }) || priceFeed?.[bet.id]?.current;
    if (!reference) continue;
    const comparison = compareBetPrice({ bet, row: reference, game: bet, rebateRate: 0.015 });
    if (comparison?.combinedStatus === 'BETTER') summary.better += 1;
    else if (comparison?.combinedStatus === 'WORSE') summary.worse += 1;
  }
  summary.total = summary.better + summary.worse;
  return summary;
}
