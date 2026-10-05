import { validDate } from './identity.js';
import { parseCreditLine, evaluateWeightedContract } from './analysis-core/credit-total.js';
export const PRESEASON_VERSION = 'nba-preseason-history-ridge-v1';
export const PRESEASON_KEYS = ['fullTotal', 'fullRunline', 'firstHalfTotal', 'firstHalfRunline'];
const variables = ['fullTotal', 'fullMargin', 'halfTotal', 'halfMargin'];
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const teamId = id => /^nba:espn:team:(?:[1-9]|[12]\d|30)$/.test(id || '');
export function validatePreseasonRows(rows) {
  const ids = new Set();
  return Array.isArray(rows) && rows.length > 0 && rows.every(row => {
    if (!/^nba:espn:game:[1-9]\d+$/.test(row?.gameId || '') || ids.has(row.gameId) || !validDate(row.date)
      || !Number.isInteger(row.year) || !['regular', 'preseason'].includes(row.seasonType)
      || !teamId(row.homeId) || !teamId(row.awayId) || row.homeId === row.awayId
      || ![row.homeScore, row.awayScore].every(n => Number.isInteger(n) && n >= 0)
      || row.seasonType === 'preseason' && ![row.homeHalf, row.awayHalf].every((n, i) => Number.isInteger(n) && n >= 0 && n <= row[i === 0 ? 'homeScore' : 'awayScore'])) return false;
    ids.add(row.gameId); return true;
  });
}
export function priorSeasonBaseline(game, history) {
  const year = game.season?.year - 1, date = game.taipeiDate;
  const rows = history.filter(row => row.year === year && row.seasonType === 'regular' && row.date < date);
  const stats = id => {
    const selected = rows.filter(row => row.homeId === id || row.awayId === id);
    if (selected.length < 20) return null;
    return { games: selected.length, pointsFor: mean(selected.map(row => row.homeId === id ? row.homeScore : row.awayScore)), pointsAgainst: mean(selected.map(row => row.homeId === id ? row.awayScore : row.homeScore)) };
  };
  const home = stats(game.home?.id), away = stats(game.away?.id);
  if (!home || !away) return null;
  const hp = (home.pointsFor + away.pointsAgainst) / 2, ap = (away.pointsFor + home.pointsAgainst) / 2;
  return { home, away, year, through: rows.map(row => row.date).sort().at(-1), fullTotal: hp + ap, fullMargin: hp - ap, halfTotal: (hp + ap) / 2, halfMargin: (hp - ap) / 2 };
}
export function fitPreseason(rows, baseline) {
  if (rows.length < 30) return null;
  return Object.fromEntries(variables.map(key => {
    const xs = rows.map(row => row.baseline[key]), ys = rows.map(row => row.actual[key]);
    const xbar = mean(xs), ybar = mean(ys);
    // Fixed ridge penalty shrinks noisy previous-season team differences.
    const slope = xs.reduce((sum, x, i) => sum + (x - xbar) * (ys[i] - ybar), 0) / (1000 + xs.reduce((sum, x) => sum + (x - xbar) ** 2, 0));
    return [key, { value: ybar + slope * (baseline[key] - xbar), intercept: ybar - slope * xbar, slope }];
  }));
}
export function buildPreseasonTraining(history) {
  if (!validatePreseasonRows(history)) throw Error('NBA_PRESEASON_ARCHIVE_INVALID');
  const features = [], observations = [];
  for (const row of history.filter(row => row.seasonType === 'preseason').sort((a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId))) {
    const game = { taipeiDate: row.date, season: { year: row.year }, home: { id: row.homeId }, away: { id: row.awayId } };
    const baseline = priorSeasonBaseline(game, history);
    if (!baseline) continue;
    const actual = { fullTotal: row.homeScore + row.awayScore, fullMargin: row.homeScore - row.awayScore, halfTotal: row.homeHalf + row.awayHalf, halfMargin: row.homeHalf - row.awayHalf };
    const prior = features.filter(value => value.date < row.date);
    const fit = fitPreseason(prior, baseline);
    if (fit) observations.push({ gameId: row.gameId, date: row.date, year: row.year, errors: Object.fromEntries(variables.map(key => [key, actual[key] - fit[key].value])), prediction: Object.fromEntries(variables.map(key => [key, fit[key].value])), actual, baseline: Object.fromEntries(variables.map(key => [key, baseline[key]])), trainedThrough: prior.at(-1).date, trainedSamples: prior.length });
    features.push({ gameId: row.gameId, date: row.date, year: row.year, baseline, actual });
  }
  return { modelVersion: PRESEASON_VERSION, features, observations };
}
export function preseasonMarket(key, quote, predictions, observations, date) {
  if (!quote) return { status: 'unavailable', reason: '此盤口尚未開盤' };
  const total = key.endsWith('Total'), half = key.startsWith('firstHalf');
  const line = parseCreditLine(String(quote.line), total ? 'total' : 'spread');
  const waters = total ? { positive: quote.overWater, negative: quote.underWater } : { positive: quote[`${quote.lineSide}Water`], negative: quote[`${quote.lineSide === 'home' ? 'away' : 'home'}Water`] };
  if (!line || !Object.values(waters).every(n => Number.isFinite(n) && n > 0 && n <= 3) || !total && !['home', 'away'].includes(quote.lineSide)) return { status: 'blocked', reason: '盤口格式、讓分方或雙邊水位未核對' };
  const variable = `${half ? 'half' : 'full'}${total ? 'Total' : 'Margin'}`;
  const sign = total || quote.lineSide === 'home' ? 1 : -1;
  const residuals = observations.map(row => ({ date: row.date, error: sign * row.errors[variable] }));
  const valuation = evaluateWeightedContract(sign * predictions[variable], residuals, line, waters, date, 365, .015);
  const sides = total ? { over: valuation.positive, under: valuation.negative } : { [quote.lineSide]: valuation.positive, [quote.lineSide === 'home' ? 'away' : 'home']: valuation.negative };
  return { status: 'ready', quote: { ...quote }, quantity: predictions[variable], sides, samples: observations.length, effectiveN: valuation.effectiveN, through: observations.at(-1).date, unitStake: 100, rebateRate: .015, probabilityBasis: 'prequential_preseason_error_distribution_model_estimate', validatedBettingWinRate: null };
}
