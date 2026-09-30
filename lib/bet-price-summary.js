import { compareBetPrice } from './bet-price-comparison.js';
import { verifiedClosingPriceForBet } from './bet-price-feed.js';

const clean = value => String(value || '').trim().toUpperCase();

const eligible = bet => bet?.id && clean(bet.status) !== 'CANCELLED'
  && !clean(bet.performanceEligibility).startsWith('EXCLUDED_');
function addComparison(summary, comparison) {
  if (comparison?.combinedStatus === 'BETTER') summary.better += 1;
  else if (comparison?.combinedStatus === 'WORSE') summary.worse += 1;
}

export function summarizeOriginalBetPrices(bets = [], priceFeed = {}, { now = Date.now() } = {}) {
  const summary = { total: 0, better: 0, worse: 0 };
  for (const bet of Array.isArray(bets) ? bets : []) {
    if (!eligible(bet)) continue;
    const reference = verifiedClosingPriceForBet(bet, { now }) || priceFeed?.[bet.id]?.current;
    if (!reference) continue;
    const comparison = compareBetPrice({ bet, row: reference, game: bet, rebateRate: 0.015 });
    addComparison(summary, comparison);
  }
  summary.total = summary.better + summary.worse;
  return summary;
}

// Yield cold payoff comparisons so a large history cannot monopolize the UI.
// Only a complete, uncancelled scope returns a summary; no partial total escapes.
export async function summarizeOriginalBetPricesAsync(bets = [], priceFeed = {}, {
  now = Date.now(), cancelled = () => false,
  yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)),
  chunkSize = 2, compare = compareBetPrice,
} = {}) {
  const values = Array.isArray(bets) ? bets : [];
  const width = Math.max(1, Math.min(10, Math.trunc(Number(chunkSize) || 2)));
  const summary = { total: 0, better: 0, worse: 0 };
  // The initial yield keeps even the first cold chunk outside React rendering.
  if (cancelled()) return null;
  await yieldControl();
  for (let index = 0; index < values.length; index += 1) {
    if (cancelled()) return null;
    const bet = values[index];
    if (eligible(bet)) {
      const reference = verifiedClosingPriceForBet(bet, { now }) || priceFeed?.[bet.id]?.current;
      if (reference) addComparison(summary, compare({ bet, row: reference, game: bet, rebateRate: 0.015 }));
    }
    if ((index + 1) % width === 0 && index + 1 < values.length) await yieldControl();
  }
  if (cancelled()) return null;
  summary.total = summary.better + summary.worse;
  return summary;
}
