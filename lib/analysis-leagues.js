import { LEAGUE_IDS, isLeagueId } from './leagues.js';

// Analysis orchestration is broader than the baseball execution registry.
// Sport-specific dispatch never enables another sport's models or ledgers.
export const SOCCER_ANALYSIS_LEAGUE_IDS = Object.freeze(['EPL', 'UCL']);
export const isSoccerAnalysisLeague = value => SOCCER_ANALYSIS_LEAGUE_IDS.includes(String(value || '').trim().toUpperCase());
const LEGACY_ANALYSIS_LEAGUE_IDS = Object.freeze([...LEAGUE_IDS, 'NBA', 'NHL']);
export const ANALYSIS_LEAGUE_IDS = Object.freeze([...LEGACY_ANALYSIS_LEAGUE_IDS, ...SOCCER_ANALYSIS_LEAGUE_IDS]);
// NHL remains readable for saved jobs; new home-page runs follow active modules.
// Football runs its existing research pipeline, retaining all formal-score gates.
export const ACTIVE_ANALYSIS_LEAGUE_IDS = Object.freeze([...LEAGUE_IDS, 'NBA', ...SOCCER_ANALYSIS_LEAGUE_IDS]);
export const isAnalysisLeagueId = value => ['NBA', 'NHL'].includes(String(value || '').trim().toUpperCase()) || isSoccerAnalysisLeague(value) || isLeagueId(value);
export const analysisLeagueId = value => isAnalysisLeagueId(value) ? String(value).trim().toUpperCase() : null;
export const analysisLeagueIdsForRun = run => run?.leagues
  ? ANALYSIS_LEAGUE_IDS.filter(id => Object.hasOwn(run.leagues, id)) : ANALYSIS_LEAGUE_IDS;

export function analysisBatchScope(batchLeagues, requestedLeagues = LEGACY_ANALYSIS_LEAGUE_IDS) {
  if (!Array.isArray(requestedLeagues) || !requestedLeagues.length
    || !Array.isArray(batchLeagues) || !batchLeagues.length) return null;
  const ids = requestedLeagues.map(analysisLeagueId);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length
    || batchLeagues.some(id => !ids.includes(id))
    || new Set(batchLeagues).size !== batchLeagues.length) return null;
  return { leagueIds: ids, preflightFailures: ids.length - batchLeagues.length };
}
