import { LEAGUE_IDS } from './leagues.js';
import { validSoccerDate } from './soccer/contracts.js';

export const MAIN_SOCCER_LEAGUES = Object.freeze(['EPL', 'UCL']);

export function mainSportSelection(search = '') {
  const query = new URLSearchParams(search);
  const sport = String(query.get('sport') || '').toUpperCase();
  if (['NBA', ...MAIN_SOCCER_LEAGUES].includes(sport)) return sport;
  const legacy = String(query.get('league') || '').toUpperCase();
  return MAIN_SOCCER_LEAGUES.includes(legacy) ? legacy : 'BASEBALL';
}

// Every sport stays on the same root document. Football scope parameters must
// not leak into baseball or NBA, or get dropped from a saved-result deep link.
export function mainSportHref(sport, { league, date, view, runId } = {}) {
  const query = new URLSearchParams();
  if (sport === 'BASEBALL') query.set('league', LEAGUE_IDS.includes(league) ? league : 'MLB');
  else if (['NBA', ...MAIN_SOCCER_LEAGUES].includes(sport)) query.set('sport', sport);
  else return null;
  if (validSoccerDate(date)) query.set('date', date);
  if (MAIN_SOCCER_LEAGUES.includes(sport)) {
    if (['upcoming', 'standings'].includes(view)) query.set('view', view);
    if (typeof runId === 'string' && /^[a-zA-Z0-9_:-]{8,300}$/.test(runId)) query.set('runId', runId);
  }
  return `/?${query}`;
}
