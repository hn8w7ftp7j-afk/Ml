import { soccerLeague, validSoccerDate } from './contracts.js';

export function soccerAnalysisResultHref(league, date, runId = '') {
  const competition = soccerLeague(league);
  if (!competition || !validSoccerDate(date)
    || typeof runId !== 'string' || runId && !/^[a-zA-Z0-9_:-]{8,300}$/.test(runId)) return null;
  const query = new URLSearchParams({ sport: competition.id.toUpperCase(), date });
  if (runId) query.set('runId', runId);
  return `/?${query}`;
}
