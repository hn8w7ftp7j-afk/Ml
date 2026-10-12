import { LEAGUE_IDS, isLeagueId } from './leagues.js';

// Analysis orchestration is broader than the baseball execution registry.
// NBA and NHL entries never enable baseball models or their betting ledgers.
export const ANALYSIS_LEAGUE_IDS = Object.freeze([...LEAGUE_IDS, 'NBA', 'NHL']);
export const isAnalysisLeagueId = value => ['NBA', 'NHL'].includes(String(value || '').trim().toUpperCase()) || isLeagueId(value);
export const analysisLeagueId = value => isAnalysisLeagueId(value) ? String(value).trim().toUpperCase() : null;
export const analysisLeagueIdsForRun = run => run?.leagues
  ? ANALYSIS_LEAGUE_IDS.filter(id => Object.hasOwn(run.leagues, id)) : ANALYSIS_LEAGUE_IDS;
