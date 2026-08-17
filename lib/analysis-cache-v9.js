import { isLeagueId } from './leagues.js';
import { sha256 } from './snapshot-v9.js';

export const ANALYSIS_CACHE_VERSION = 'BASEBALL-ANALYSIS-CACHE-GAME-CONTRACT-v2.0.0';
const SHADOW_ANALYSIS_MODE = 'EXPERIMENTAL_SHADOW';
const SHADOW_SCORE_TYPE = 'SHADOW_DIAGNOSTIC';
const SHADOW_RESULT_TAG = 'SHADOW｜影子評分｜不可下注';
const SHADOW_LEAGUES = new Set(['NPB', 'KBO', 'CPBL']);

function requiredLeague(value) {
  const league = String(value || '').trim().toUpperCase();
  if (!isLeagueId(league)) throw new Error('分析快取缺少有效 league');
  return league;
}

export function analysisContractSignature(leagueValue, game, markets) {
  const league = requiredLeague(leagueValue);
  return sha256({
    domain: 'baseball-positive-ev/analysis-contract/v2',
    league,
    gamePk: Number(game?.gamePk) || null,
    officialDate: game?.officialDate || null,
    gameNumber: Number(game?.gameNumber) || 1,
    contracts: (Array.isArray(markets) ? markets : []).map(row => ({
      market: row?.market || null,
      pick: row?.pick || null,
      water: row?.water ?? null,
      waterEstimated: Boolean(row?.waterEstimated),
      waterMissing: Boolean(row?.waterMissing),
      sourceType: row?.sourceType || null,
      lineAsOf: row?.lineAsOf || null,
      executable: row?.executable !== false,
    })).sort((left, right) => `${left.market}|${left.pick}`.localeCompare(`${right.market}|${right.pick}`)),
  });
}

export function analysisCacheKey(leagueValue, gamePk, inputHash) {
  const league = requiredLeague(leagueValue);
  const id = Number(gamePk);
  if (!Number.isInteger(id) || id <= 0 || !inputHash) throw new Error('分析快取鍵缺少gamePk或inputHash');
  return `${ANALYSIS_CACHE_VERSION}:${league}:${id}:${inputHash}`;
}

function emptyPortfolio(value) {
  return Array.isArray(value) && value.length === 0;
}

function shadowContextSafe(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.analysisMode === SHADOW_ANALYSIS_MODE
    && value.executable === false
    && value.betEligible === false;
}

function shadowResultSafe(row) {
  return row != null
    && typeof row === 'object'
    && !Array.isArray(row)
    && row.analysisMode === SHADOW_ANALYSIS_MODE
    && row.executable === false
    && row.betEligible === false
    && row.scoreType === SHADOW_SCORE_TYPE
    && row.tag === SHADOW_RESULT_TAG
    && row.unitSuggestion == null
    && row.recommendedUnit == null
    && row.portfolioUnit == null
    && String(row.portfolioRole || '') === '';
}

function shadowAnalysisSafe(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.analysisMode === SHADOW_ANALYSIS_MODE
    && value.executable === false
    && value.betEligible === false
    && value.scoreType === SHADOW_SCORE_TYPE
    && value.tag === SHADOW_RESULT_TAG
    && value.unitSuggestion == null
    && emptyPortfolio(value.portfolio)
    && Array.isArray(value.results)
    && value.results.every(shadowResultSafe)
    && (!value.context || shadowContextSafe(value.context))
    && (!value.frozenContext || shadowContextSafe(value.frozenContext));
}

function shadowRepriceSafe(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.analysisMode === SHADOW_ANALYSIS_MODE
    && value.executable === false
    && value.betEligible === false
    && emptyPortfolio(value.portfolio)
    && shadowContextSafe(value.frozenContext)
    && (!value.context || shadowContextSafe(value.context))
    && (!Array.isArray(value.results) || value.results.every(shadowResultSafe));
}

function shadowPayloadSafe(payload) {
  return payload.analysisMode === SHADOW_ANALYSIS_MODE
    && payload.executable === false
    && payload.betEligible === false
    && payload.scoreType === SHADOW_SCORE_TYPE
    && payload.tag === SHADOW_RESULT_TAG
    && payload.unitSuggestion == null
    && emptyPortfolio(payload.portfolio)
    && shadowContextSafe(payload.context)
    && (!payload.frozenContext || shadowContextSafe(payload.frozenContext))
    && Array.isArray(payload.results)
    && payload.results.every(shadowResultSafe)
    && shadowAnalysisSafe(payload.analysis)
    && shadowRepriceSafe(payload.repriceSnapshot);
}

export function analysisCachePayloadMatches(entry, { league: leagueValue, game, fingerprints, signature }) {
  const league = requiredLeague(leagueValue);
  const payload = entry?.payload;
  if (!payload || !fingerprints?.inputHash || !signature) return false;
  const gameLeague = String(game?.league || game?.leagueId || '').trim().toUpperCase();
  return gameLeague === league
    && payload?.league === league
    && payload?.game?.league === league
    && payload?.context?.game?.league === league
    && Number(payload?.game?.gamePk) === Number(game?.gamePk)
    && Number(payload?.context?.game?.gamePk) === Number(game?.gamePk)
    && payload?.analysis?.inputHash === fingerprints.inputHash
    && payload?.repriceSnapshot?.inputHash === fingerprints.inputHash
    && entry.signature === signature
    && (!SHADOW_LEAGUES.has(league) || shadowPayloadSafe(payload));
}
