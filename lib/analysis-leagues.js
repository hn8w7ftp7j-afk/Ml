import { LEAGUE_IDS, isLeagueId } from './leagues.js';

// Analysis orchestration is broader than the baseball execution registry.
// Adding NBA here never enables baseball models or the betting ledger for NBA.
export const ANALYSIS_LEAGUE_IDS = Object.freeze([...LEAGUE_IDS, 'NBA']);
export const isAnalysisLeagueId = value => value === 'NBA' || isLeagueId(value);
export const analysisLeagueId = value => String(value || '').trim().toUpperCase() === 'NBA'
  ? 'NBA' : isLeagueId(value) ? String(value).trim().toUpperCase() : null;
export const analysisLeagueIdsForRun = run => run?.leagues
  ? ANALYSIS_LEAGUE_IDS.filter(id => Object.hasOwn(run.leagues, id)) : ANALYSIS_LEAGUE_IDS;
