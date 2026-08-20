import { buildGameContext, fetchFinalResult } from './mlb.js';
import {
  assertGameHasNotStarted,
  fetchOfficialTaipeiSlate,
  officialPrestartSlate,
  resolveOfficialGame,
  taipeiBoardDate,
  validateOfficialScheduleSubset,
  withClearedTimeout,
} from './official-schedule-v1.js';
import {
  ASIAN_ANALYSIS_MODE,
  ASIAN_BASEBALL_VERSION,
  asianLeagueConfig,
  buildAsianGameContext,
  fetchAsianFinalResult,
  fetchAsianTaipeiSlate,
} from './asian-baseball.js';
import {
  DEFAULT_MODEL_CONFIG,
  MODEL_VERSION,
  RULES_VERSION,
  SHADOW_ANALYSIS_MODE,
} from './analysis.js';
import { isLeagueId, leagueConfig, requestedLeagueId } from './leagues.js';

export const LEAGUE_PROVIDER_VERSION = 'BASEBALL-LEAGUE-PROVIDER-2026-08-v1.1.0';

function providerError(message, status = 502, code = 'LEAGUE_PROVIDER_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function strictLeague(value) {
  const league = requestedLeagueId(value);
  if (!league || !isLeagueId(league)) throw providerError('不支援的聯盟', 400, 'UNKNOWN_LEAGUE');
  return league;
}

function safePk(value) {
  const gamePk = Number(value);
  return Number.isSafeInteger(gamePk) && gamePk > 0 ? gamePk : null;
}

function asianIdentityMatches(client, official, boardDate) {
  const clientStart = Date.parse(client?.gameDate || '');
  const officialStart = Date.parse(official?.gameDate || '');
  const clientLeague = String(client?.leagueId || client?.league || '').trim().toUpperCase();
  const officialLeague = String(official?.leagueId || official?.league || '').trim().toUpperCase();
  return safePk(client?.gamePk) === safePk(official?.gamePk)
    && Number(client?.awayTeamId) === Number(official?.awayTeamId)
    && Number(client?.homeTeamId) === Number(official?.homeTeamId)
    && Number(client?.gameNumber || 1) === Number(official?.gameNumber || 1)
    && Number.isFinite(clientStart)
    && clientStart === officialStart
    && official?.officialDate === boardDate
    && official?.taipeiDate === boardDate
    && (!client?.officialDate || client.officialDate === boardDate)
    && (!clientLeague || clientLeague === officialLeague);
}

export function leagueAnalysisContract(value) {
  const league = strictLeague(value);
  if (league === 'MLB') {
    return {
      leagueId: league,
      analysisMode: SHADOW_ANALYSIS_MODE,
      modelVersion: MODEL_VERSION,
      rulesVersion: RULES_VERSION,
      modelConfig: DEFAULT_MODEL_CONFIG,
      betEligible: false,
      executable: false,
      formalScoringEnabled: false,
    };
  }
  const config = asianLeagueConfig(league);
  return {
    leagueId: league,
    analysisMode: ASIAN_ANALYSIS_MODE,
    modelVersion: config.modelVersion,
    rulesVersion: config.rulesVersion,
    modelConfig: config.modelConfig,
    betEligible: false,
    executable: false,
    formalScoringEnabled: false,
  };
}

export function getLeagueProvider(value) {
  const league = strictLeague(value);
  const registry = leagueConfig(league);
  const contract = leagueAnalysisContract(league);
  return {
    id: league,
    league,
    status: registry.status,
    scheduleProvider: registry.scheduleProvider,
    readerProvider: registry.readerProvider,
    analysisMode: contract.analysisMode,
    modelVersion: contract.modelVersion,
    rulesVersion: contract.rulesVersion,
    modelConfig: contract.modelConfig,
    betEligible: false,
    executable: false,
    formalScoringEnabled: false,
    version: league === 'MLB' ? LEAGUE_PROVIDER_VERSION : `${LEAGUE_PROVIDER_VERSION}+${ASIAN_BASEBALL_VERSION}`,
  };
}

export async function fetchLeagueTaipeiSlate(value, date, options = {}) {
  const league = strictLeague(value);
  const slate = league === 'MLB'
    ? await fetchOfficialTaipeiSlate(date, options)
    : await fetchAsianTaipeiSlate(league, date, options);
  return slate.map(game => ({ ...game, league, leagueId: league }));
}

export function filterLeaguePrestartGames(value, games, now = Date.now()) {
  strictLeague(value);
  return officialPrestartSlate(games, now);
}

export function validateLeagueScheduleSubset(value, requestedSchedule, officialSlate, boardDate) {
  const league = strictLeague(value);
  if (league === 'MLB') return validateOfficialScheduleSubset(requestedSchedule, officialSlate, boardDate);
  const requested = Array.isArray(requestedSchedule) ? requestedSchedule : [];
  const officialByPk = new Map((Array.isArray(officialSlate) ? officialSlate : []).map(game => [safePk(game?.gamePk), game]));
  const seen = new Set();
  return requested.map(client => {
    const gamePk = safePk(client?.gamePk);
    const official = officialByPk.get(gamePk);
    if (!gamePk || !official || seen.has(gamePk) || !asianIdentityMatches(client, official, boardDate)) {
      throw providerError(`請求賽事與 ${league} 官方場次識別不一致，請重新整理賽程`, 409, 'OFFICIAL_IDENTITY_MISMATCH');
    }
    seen.add(gamePk);
    return official;
  });
}

export async function resolveLeagueGame(value, clientGame, options = {}) {
  const league = strictLeague(value);
  if (league === 'MLB') {
    const resolved = await resolveOfficialGame(clientGame, options);
    return { ...resolved, game: { ...resolved.game, league, leagueId: league }, slate: resolved.slate.map(game => ({ ...game, league, leagueId: league })) };
  }
  const boardDate = options.date
    || clientGame?.officialDate
    || clientGame?.taipeiDate
    || taipeiBoardDate(clientGame?.gameDate || '');
  if (!boardDate) throw providerError('賽事開打時間無效', 400, 'INVALID_GAME_TIME');
  const slate = await fetchLeagueTaipeiSlate(league, boardDate, options);
  const [game] = validateLeagueScheduleSubset(league, [clientGame], slate, boardDate);
  return { game, slate, boardDate };
}

export function assertLeagueGamePrestart(value, game, now = Date.now()) {
  const league = strictLeague(value);
  if (league === 'MLB') return assertGameHasNotStarted(game, now);
  if (!filterLeaguePrestartGames(league, [game], now).length) {
    throw providerError('比賽已達官方預定開打時間或已開始｜賽前模型停止評分', 409, 'GAME_ALREADY_STARTED');
  }
}

export async function buildLeagueGameContext(value, game, options = {}) {
  const league = strictLeague(value);
  if (league === 'MLB') return buildGameContext(game);
  return buildAsianGameContext(league, game, options);
}

export async function fetchLeagueFinalResult(value, gamePk, options = {}) {
  const league = strictLeague(value);
  if (league === 'MLB') return fetchFinalResult(gamePk);
  return fetchAsianFinalResult(league, gamePk, options.date, options);
}

export function withLeagueProviderTimeout(value, promise, timeoutMs, message = '') {
  const league = strictLeague(value);
  const label = leagueConfig(league).shortLabel;
  return withClearedTimeout(promise, timeoutMs, message || `${label}資料取得逾時，請稍後重試`);
}

export const resolveProviderGame = resolveLeagueGame;
export const assertProviderGamePrestart = assertLeagueGamePrestart;
export const buildProviderGameContext = buildLeagueGameContext;
export const fetchProviderFinalResult = fetchLeagueFinalResult;
