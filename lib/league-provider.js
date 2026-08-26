import { fetchFinalResult } from './mlb.js';
import { buildGameContextV13 } from './mlb-context-v13.js';
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
} from './analysis-v11.js';
import { isLeagueId, leagueConfig, requestedLeagueId } from './leagues.js';

export const LEAGUE_PROVIDER_VERSION = 'BASEBALL-LEAGUE-PROVIDER-2026-08-v1.6.0';

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

function officialDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function officialScore(value) {
  const score = Number(value);
  return Number.isSafeInteger(score) && score >= 0 ? score : null;
}

function finalResultRules(league, source) {
  if (league === 'MLB') {
    const scheduled = Number(source?.scheduledInnings);
    return {
      regulationInnings: Number.isSafeInteger(scheduled) && scheduled >= 5 && scheduled <= 9 ? scheduled : 9,
      extraInningsLimit: null,
      allowDraw: false,
    };
  }
  const rules = asianLeagueConfig(league).rules;
  return {
    regulationInnings: Number(rules.regulationInnings || 9),
    extraInningsLimit: Number.isSafeInteger(Number(rules.extraInningsLimit)) ? Number(rules.extraInningsLimit) : null,
    allowDraw: rules.allowDraw === true,
  };
}

export function validateLeagueFinalResult(value, requestedGamePk, source, options = {}) {
  const league = strictLeague(value);
  const gamePk = safePk(requestedGamePk);
  if (!gamePk) throw providerError('缺少或無效的 gamePk', 400, 'INVALID_GAME_PK');
  if (!source || typeof source !== 'object') throw providerError('官方賽果不存在', 503, 'OFFICIAL_RESULT_UNAVAILABLE');

  const sourceLeague = String(source.league || '').trim().toUpperCase();
  const sourcePk = safePk(source.gamePk);
  const date = officialDate(source.officialDate);
  const gameNumber = Number(source.gameNumber);
  const awayTeamId = safePk(source.awayTeamId);
  const homeTeamId = safePk(source.homeTeamId);
  const away = String(source.away || '').trim();
  const home = String(source.home || '').trim();
  const provider = String(source.provider || '').trim();
  const sourceRecord = String(source.sourceRecord || '').trim();
  if (sourceLeague !== league || sourcePk !== gamePk) {
    throw providerError('官方賽果聯盟或場次識別不一致', 409, 'OFFICIAL_IDENTITY_MISMATCH');
  }
  if (!date || !Number.isSafeInteger(gameNumber) || gameNumber <= 0
    || !awayTeamId || !homeTeamId || awayTeamId === homeTeamId || !away || !home || !provider || !sourceRecord) {
    throw providerError('官方賽果缺少日期、雙重賽、球隊或來源身分', 502, 'OFFICIAL_FINAL_RESULT_INVALID');
  }
  if (options.date && date !== options.date) {
    throw providerError('官方賽果日期與保存快照不一致', 409, 'OFFICIAL_IDENTITY_MISMATCH');
  }
  const expected = options.game;
  if (expected && (
    (safePk(expected.gamePk) && safePk(expected.gamePk) !== sourcePk)
    || (Number(expected.gameNumber || 1) !== gameNumber)
    || (safePk(expected.awayTeamId) && safePk(expected.awayTeamId) !== awayTeamId)
    || (safePk(expected.homeTeamId) && safePk(expected.homeTeamId) !== homeTeamId)
    || (officialDate(expected.officialDate) && officialDate(expected.officialDate) !== date)
  )) {
    throw providerError('官方賽果與保存的賽事身分不一致', 409, 'OFFICIAL_IDENTITY_MISMATCH');
  }

  const final = source.final === true;
  if (!final) {
    return {
      ...source,
      league,
      gamePk,
      gameNumber,
      officialDate: date,
      awayTeamId,
      homeTeamId,
      away,
      home,
      final: false,
      awayRuns: null,
      homeRuns: null,
      awayFirst5: null,
      homeFirst5: null,
      first5Complete: false,
      provider,
      sourceRecord,
    };
  }

  const awayRuns = officialScore(source.awayRuns);
  const homeRuns = officialScore(source.homeRuns);
  const innings = Number(source.innings);
  const rules = finalResultRules(league, source);
  if (awayRuns == null || homeRuns == null || !Number.isSafeInteger(innings) || innings < rules.regulationInnings) {
    throw providerError('官方終場比分或局數不完整，禁止自動結算', 502, 'OFFICIAL_FINAL_RESULT_INVALID');
  }
  if (rules.extraInningsLimit != null && innings > rules.extraInningsLimit) {
    throw providerError('官方終場局數超出已發布聯盟規則，禁止自動結算', 502, 'OFFICIAL_FINAL_RESULT_INVALID');
  }
  if (awayRuns === homeRuns && (!rules.allowDraw || (rules.extraInningsLimit != null && innings !== rules.extraInningsLimit))) {
    throw providerError('官方和局不符合已發布聯盟規則，禁止自動結算', 502, 'OFFICIAL_FINAL_RESULT_INVALID');
  }

  const first5Complete = source.first5Complete === true;
  const awayFirst5 = first5Complete ? officialScore(source.awayFirst5) : null;
  const homeFirst5 = first5Complete ? officialScore(source.homeFirst5) : null;
  if (first5Complete && (awayFirst5 == null || homeFirst5 == null || innings < 5)) {
    throw providerError('官方前五局比分不完整，禁止自動結算上半市場', 502, 'OFFICIAL_FIRST5_RESULT_INVALID');
  }
  if (!first5Complete && (source.awayFirst5 != null || source.homeFirst5 != null)) {
    throw providerError('未確認前五局完整性卻提供比分，禁止自動結算上半市場', 502, 'OFFICIAL_FIRST5_RESULT_INVALID');
  }

  return {
    ...source,
    league,
    gamePk,
    gameNumber,
    officialDate: date,
    awayTeamId,
    homeTeamId,
    away,
    home,
    final: true,
    awayRuns,
    homeRuns,
    innings,
    first5Complete,
    awayFirst5,
    homeFirst5,
    provider,
    sourceRecord,
  };
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

export function bindLeagueAnalysisContext(value, source = {}) {
  const league = strictLeague(value);
  const contract = leagueAnalysisContract(league);
  return {
    ...(source || {}),
    leagueId: league,
    analysisMode: contract.analysisMode,
    modelVersion: contract.modelVersion,
    rulesVersion: contract.rulesVersion,
    modelConfig: contract.modelConfig,
    betEligible: false,
    executable: false,
    formalScoringEnabled: false,
    provider: {
      ...(source?.provider || {}),
      leagueId: league,
      analysisMode: contract.analysisMode,
      modelVersion: contract.modelVersion,
      rulesVersion: contract.rulesVersion,
      betEligible: false,
      executable: false,
      formalScoringEnabled: false,
    },
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
  const context = league === 'MLB'
    ? await buildGameContextV13(game, options)
    : await buildAsianGameContext(league, game, options);
  return bindLeagueAnalysisContext(league, context);
}

export async function fetchLeagueFinalResult(value, gamePk, options = {}) {
  const league = strictLeague(value);
  const result = league === 'MLB'
    ? await fetchFinalResult(gamePk)
    : await fetchAsianFinalResult(league, gamePk, options.date, options);
  return validateLeagueFinalResult(league, gamePk, result, options);
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
