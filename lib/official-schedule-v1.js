import { statusNameZh, teamNameZh, venueNameZh } from './i18n.js';

export const OFFICIAL_SCHEDULE_VERSION = 'MLB-OFFICIAL-SCHEDULE-INTEGRITY-v1.0.0';
const MLB_SCHEDULE = 'https://statsapi.mlb.com/api/v1/schedule';
const TAIPEI_ZONE = 'Asia/Taipei';

function httpError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function validDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function shiftedDate(value, offset) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function taipeiBoardDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TAIPEI_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function normalizeOfficialGame(game, requestedDate) {
  const awayEnglish = String(game?.teams?.away?.team?.name || '');
  const homeEnglish = String(game?.teams?.home?.team?.name || '');
  const venueEnglish = String(game?.venue?.name || '');
  const statusEnglish = String(game?.status?.detailedState || '');
  const gameDate = String(game?.gameDate || '');
  const start = Date.parse(gameDate);
  const normalized = {
    gamePk: Number(game?.gamePk) || null,
    gameDate: Number.isFinite(start) ? new Date(start).toISOString() : '',
    taipeiDate: Number.isFinite(start) ? taipeiBoardDate(start) : '',
    officialDate: String(game?.officialDate || requestedDate || ''),
    status: statusNameZh(statusEnglish),
    statusEnglish,
    statusCode: String(game?.status?.statusCode || ''),
    doubleHeader: String(game?.doubleHeader || 'N'),
    gameNumber: Math.max(1, Number(game?.gameNumber) || 1),
    scheduledInnings: Math.max(1, Number(game?.scheduledInnings) || 9),
    away: teamNameZh(awayEnglish),
    home: teamNameZh(homeEnglish),
    awayEnglish,
    homeEnglish,
    awayTeamId: Number(game?.teams?.away?.team?.id) || null,
    homeTeamId: Number(game?.teams?.home?.team?.id) || null,
    awayProbable: String(game?.teams?.away?.probablePitcher?.fullName || ''),
    homeProbable: String(game?.teams?.home?.probablePitcher?.fullName || ''),
    awayProbableId: Number(game?.teams?.away?.probablePitcher?.id) || null,
    homeProbableId: Number(game?.teams?.home?.probablePitcher?.id) || null,
    venue: venueNameZh(venueEnglish),
    venueEnglish,
    venueId: Number(game?.venue?.id) || null,
    awayScore: game?.teams?.away?.score ?? null,
    homeScore: game?.teams?.home?.score ?? null,
    innings: game?.linescore?.currentInning || null,
  };
  return normalized.gamePk && normalized.gameDate && normalized.awayTeamId && normalized.homeTeamId
    ? normalized
    : null;
}

async function fetchOfficialDate(date, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(MLB_SCHEDULE);
    url.searchParams.set('sportId', '1');
    url.searchParams.set('date', date);
    url.searchParams.set('hydrate', 'probablePitcher,team,venue,linescore');
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json', 'User-Agent': 'Baseball-Positive-EV/9.6.0' },
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw httpError(`MLB 官方賽程讀取失敗（${response?.status || 'network'}）`, 502, 'OFFICIAL_SCHEDULE_UNAVAILABLE');
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw httpError('MLB 官方賽程回傳格式錯誤', 502, 'OFFICIAL_SCHEDULE_UNAVAILABLE'); }
    if (!Array.isArray(payload?.dates)) {
      throw httpError('MLB 官方賽程回傳缺少 dates', 502, 'OFFICIAL_SCHEDULE_UNAVAILABLE');
    }
    return payload.dates.flatMap(day => Array.isArray(day?.games) ? day.games : [])
      .map(game => normalizeOfficialGame(game, date))
      .filter(Boolean);
  } catch (error) {
    if (error?.code === 'OFFICIAL_SCHEDULE_UNAVAILABLE') throw error;
    const timedOut = error?.name === 'AbortError' || controller.signal.aborted;
    throw httpError(timedOut ? 'MLB 官方賽程讀取逾時' : 'MLB 官方賽程目前無法讀取', 502, 'OFFICIAL_SCHEDULE_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOfficialTaipeiSlate(boardDate, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
} = {}) {
  if (!validDate(boardDate)) throw httpError('日期格式必須為 YYYY-MM-DD', 400, 'INVALID_BOARD_DATE');
  if (typeof fetchImpl !== 'function') throw httpError('MLB 官方賽程讀取器不存在', 502, 'OFFICIAL_SCHEDULE_UNAVAILABLE');
  const dates = [-1, 0, 1].map(offset => shiftedDate(boardDate, offset));
  const batches = await Promise.all(dates.map(date => fetchOfficialDate(date, { fetchImpl, timeoutMs })));
  const all = batches.flat();
  if (!all.length) {
    throw httpError('MLB 官方賽程目前無法確認', 502, 'OFFICIAL_SCHEDULE_UNAVAILABLE');
  }
  const byPk = new Map();
  for (const game of all) {
    if (game.taipeiDate === boardDate) byPk.set(Number(game.gamePk), game);
  }
  const slate = [...byPk.values()].sort((left, right) => (
    Date.parse(left.gameDate) - Date.parse(right.gameDate)
    || Number(left.gameNumber) - Number(right.gameNumber)
    || Number(left.gamePk) - Number(right.gamePk)
  ));
  if (!slate.length) {
    throw httpError('MLB 官方台北日期賽程目前無法確認', 502, 'OFFICIAL_SCHEDULE_UNAVAILABLE');
  }
  return slate;
}

function sameOfficialIdentity(client, official, expectedBoardDate) {
  const clientStart = Date.parse(client?.gameDate || '');
  const officialStart = Date.parse(official?.gameDate || '');
  return Number(client?.gamePk) === Number(official?.gamePk)
    && Number(client?.awayTeamId) === Number(official?.awayTeamId)
    && Number(client?.homeTeamId) === Number(official?.homeTeamId)
    && Number(client?.gameNumber || 1) === Number(official?.gameNumber || 1)
    && Number.isFinite(clientStart)
    && clientStart === officialStart
    && taipeiBoardDate(clientStart) === expectedBoardDate
    && official?.taipeiDate === expectedBoardDate;
}

export function validateOfficialScheduleSubset(requestedSchedule, officialSlate, boardDate) {
  const requested = Array.isArray(requestedSchedule) ? requestedSchedule : [];
  const officialByPk = new Map((Array.isArray(officialSlate) ? officialSlate : []).map(game => [Number(game.gamePk), game]));
  const seen = new Set();
  return requested.map(client => {
    const gamePk = Number(client?.gamePk);
    const official = officialByPk.get(gamePk);
    if (!official || seen.has(gamePk) || !sameOfficialIdentity(client, official, boardDate)) {
      throw httpError('請求賽事與 MLB 官方場次識別不一致，請重新整理賽程', 409, 'OFFICIAL_IDENTITY_MISMATCH');
    }
    seen.add(gamePk);
    return official;
  });
}

export async function resolveOfficialGame(clientGame, options = {}) {
  const boardDate = taipeiBoardDate(clientGame?.gameDate || '');
  if (!boardDate) throw httpError('賽事開打時間無效', 400, 'INVALID_GAME_TIME');
  const slate = await fetchOfficialTaipeiSlate(boardDate, options);
  const [official] = validateOfficialScheduleSubset([clientGame], slate, boardDate);
  return { game: official, slate, boardDate };
}

export function officialPrestartSlate(officialSlate, now = Date.now()) {
  const instant = Number(now);
  return (Array.isArray(officialSlate) ? officialSlate : []).filter(game => {
    const start = Date.parse(game?.gameDate || '');
    const status = `${game?.statusCode || ''} ${game?.statusEnglish || ''} ${game?.status || ''}`.toLowerCase();
    return Number.isFinite(instant)
      && Number.isFinite(start)
      && instant < start
      && !/in progress|game over|final|completed|live|postponed|cancelled/.test(status)
      && !['I', 'F', 'O', 'D', 'C'].includes(String(game?.statusCode || '').toUpperCase());
  });
}

export function assertGameHasNotStarted(game, now = Date.now()) {
  const start = Date.parse(game?.gameDate || '');
  if (!Number.isFinite(start)) throw httpError('MLB 官方開打時間無效', 502, 'OFFICIAL_SCHEDULE_UNAVAILABLE');
  const status = `${game?.statusCode || ''} ${game?.statusEnglish || ''} ${game?.status || ''}`.toLowerCase();
  if (Number(now) >= start || /in progress|game over|final|completed|live/.test(status) || ['I', 'F', 'O'].includes(String(game?.statusCode || '').toUpperCase())) {
    throw httpError('比賽已達官方預定開打時間或已開始｜賽前模型停止評分', 409, 'GAME_ALREADY_STARTED');
  }
}

export async function withClearedTimeout(promise, timeoutMs, message = '請求逾時') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(httpError(message, 504, 'REQUEST_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
