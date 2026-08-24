import { MARKET_ORDER } from './markets.js';

export const BET_ORDER_MIN_SCORE = 7.0;

function gameKey(entry) {
  const game = entry?.item?.game || {};
  return [game.leagueId || game.league || '', game.gamePk || entry?.gamePk || '', game.gameDate || ''].join('|||');
}

function gameStart(entry) {
  const value = Date.parse(entry?.item?.game?.gameDate || '');
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function marketRank(market) {
  const index = MARKET_ORDER.indexOf(String(market || ''));
  return index >= 0 ? index : MARKET_ORDER.length;
}

export function buildBetOrderEntries(entries, { minimumScore = BET_ORDER_MIN_SCORE } = {}) {
  const threshold = Number.isFinite(Number(minimumScore)) ? Number(minimumScore) : BET_ORDER_MIN_SCORE;
  return (Array.isArray(entries) ? entries : [])
    .map((entry, sourceIndex) => ({
      entry,
      sourceIndex,
      score: Number(entry?.score),
      start: gameStart(entry),
      gameKey: gameKey(entry),
      marketRank: marketRank(entry?.market),
    }))
    .filter(candidate => Number.isFinite(candidate.score) && candidate.score >= threshold)
    .sort((left, right) => left.start - right.start
      || left.gameKey.localeCompare(right.gameKey, 'zh-Hant')
      || left.marketRank - right.marketRank
      || right.score - left.score
      || String(left.entry?.pick || '').localeCompare(String(right.entry?.pick || ''), 'zh-Hant')
      || left.sourceIndex - right.sourceIndex)
    .map((candidate, index) => ({
      ...candidate.entry,
      betOrderIndex: index + 1,
      betOrderStartAt: Number.isFinite(candidate.start) ? candidate.start : null,
    }));
}

export function groupBetOrderEntries(entries) {
  const groups = [];
  const byGame = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const game = entry?.item?.game || {};
    const key = gameKey(entry);
    let group = byGame.get(key);
    if (!group) {
      group = {
        key,
        gamePk: game.gamePk || entry?.gamePk || null,
        gameDate: game.gameDate || null,
        matchup: entry?.matchup || '',
        entries: [],
      };
      byGame.set(key, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}
