import { summarizeHighScoreBets } from '../league-bet-status.js';
import { buildSoccerRanking, soccerResultCurrent } from './ranking.js';
import { soccerRecordKey } from './manual-record.js';

// Keep the reminder and durable ledger on the same displayed date range.
// Omitting through preserves single-date callers and exact record identities.
export function soccerHighScoreCandidates(games, states, { league, date, through = date, now = Date.now(), analysisReady = true } = {}) {
  const scoped = games.filter(game => game?.league === league && game.date >= date && game.date <= through);
  const waiting = scoped.some(game => {
    if (game.status !== 'scheduled' || Date.parse(game.startTime) <= now) return false;
    const state = states[game.id];
    if (state?.status === 'error' && state.analysisStatus === 'INSUFFICIENT_DATA') return false;
    return state?.status !== 'done' || !soccerResultCurrent(game, state.data, now);
  });
  return { candidates: buildSoccerRanking(scoped, states, { now }).order, analysisReady: analysisReady && !waiting };
}

export function summarizeSoccerHighScoreBets(candidates, { records = [], league, date, through = date, ledgerReady = false, analysisReady = true } = {}) {
  const scoped = candidates.filter(entry => entry?.candidate === true && entry.game?.league === league && entry.game.date >= date && entry.game.date <= through);
  const confirmed = new Set(records.filter(record => record.league === league && record.date >= date && record.date <= through && record.status !== 'CANCELLED').map(soccerRecordKey));
  const summary = summarizeHighScoreBets(scoped, {
    ledgerReady, analysisReady,
    isRecorded: entry => confirmed.has(soccerRecordKey({ ...entry.quote, league, date: entry.game.date, gameId: entry.game.id })),
  });
  return { league: String(league || '').toUpperCase(), date, ...summary };
}
