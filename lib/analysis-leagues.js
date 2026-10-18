import { LEAGUE_IDS, isLeagueId } from './leagues.js';

// Analysis orchestration is broader than the baseball execution registry.
// NBA and NHL entries never enable baseball models or their betting ledgers.
export const ANALYSIS_LEAGUE_IDS = Object.freeze([...LEAGUE_IDS, 'NBA', 'NHL']);
// NHL remains readable for saved jobs; new home-page runs follow active modules.
// Football is kept outside these model jobs until its own scoring is validated.
export const ACTIVE_ANALYSIS_LEAGUE_IDS = Object.freeze([...LEAGUE_IDS, 'NBA']);
export const isAnalysisLeagueId = value => ['NBA', 'NHL'].includes(String(value || '').trim().toUpperCase()) || isLeagueId(value);
export const analysisLeagueId = value => isAnalysisLeagueId(value) ? String(value).trim().toUpperCase() : null;
export const analysisLeagueIdsForRun = run => run?.leagues
  ? ANALYSIS_LEAGUE_IDS.filter(id => Object.hasOwn(run.leagues, id)) : ANALYSIS_LEAGUE_IDS;

export function analysisBatchScope(batchLeagues, requestedLeagues = ANALYSIS_LEAGUE_IDS) {
  if (!Array.isArray(requestedLeagues) || !requestedLeagues.length
    || !Array.isArray(batchLeagues) || !batchLeagues.length) return null;
  const ids = requestedLeagues.map(analysisLeagueId);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length
    || batchLeagues.some(id => !ids.includes(id))
    || new Set(batchLeagues).size !== batchLeagues.length) return null;
  return { leagueIds: ids, preflightFailures: ids.length - batchLeagues.length };
}
