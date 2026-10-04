import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalReaderPayload } from '../../reader/parser.js';
import { validDate } from './identity.js';
import { resolveNbaReaderTeam } from './reader-teams.js';

export const NBA_READER_VERSION = 'NBA-READER-v1';
export const NBA_READER_MINIMUM_VERSION = '2.1.27';
export const NBA_READER_FRESH_MS = 180_000;
export const NBA_READER_MARKET_KEYS = Object.freeze(['fullRunline', 'fullTotal', 'firstHalfRunline', 'firstHalfTotal']);
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
const LINE = /^(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(?:平|[+-]\d{1,3})?$/;
const digest = value => createHash('sha256').update(value).digest('hex');

export function nbaReaderError(code, message, status = 400) {
  const error = new Error(message); error.code = code; error.status = status; return error;
}
function requireValue(condition, code, message, status = 400) {
  if (!condition) throw nbaReaderError(code, message, status);
}
function supportedReaderVersion(value) {
  if (typeof value !== 'string' || value.length > 80) return false;
  const match = typeof value === 'string' && value.match(/^(\d+)\.(\d+)\.(\d+)(?:[ -].*)?$/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 27)));
}
function timestamp(value, field) {
  requireValue(typeof value === 'string' && ISO_TIME.test(value) && validDate(value.slice(0, 10)), 'NBA_READER_TIME_INVALID', `${field} 時間格式錯誤`);
  const time = Date.parse(value);
  requireValue(Number.isFinite(time), 'NBA_READER_TIME_INVALID', `${field} 時間格式錯誤`);
  return time;
}
function source(payload) {
  let url;
  try { url = new URL(payload.pageUrl); } catch { throw nbaReaderError('NBA_READER_SOURCE_INVALID', 'Reader pageUrl 不是合法的 Tai888 HTTPS 網址'); }
  const host = typeof payload.sourceHost === 'string' ? payload.sourceHost.toLowerCase() : '';
  requireValue(url.protocol === 'https:' && !url.username && !url.password
    && (host === 'tai888.in' || /^(?:[a-z0-9-]+\.)+tai888\.in$/.test(host))
    && host === url.hostname.toLowerCase(), 'NBA_READER_SOURCE_INVALID', 'NBA Reader 來源必須是同一個 tai888.in HTTPS 網站');
  const marker = /^#\/(?:BS|BB)(?:$|[/?&])/i.test(url.hash) ? url.hash.match(/^#\/(?:BS|BB)/i)[0].toUpperCase() : '';
  return { sourceHost: host, pageUrl: `${url.origin}${url.pathname}${marker}`.slice(0, 500) };
}
function market(value, key) {
  if (value == null) return null;
  const total = key.endsWith('Total');
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.line === 'string' && value.line.length <= 32 && LINE.test(value.line), 'NBA_READER_MARKET_INVALID', `${key} 盤口格式錯誤`);
  const waters = total ? [value.overWater, value.underWater] : [value.awayWater, value.homeWater];
  requireValue(waters.every(water => typeof water === 'number' && Number.isFinite(water) && water >= 0.01 && water <= 3), 'NBA_READER_MARKET_INVALID', `${key} 雙方水位不完整`);
  if (total) return { line: value.line, overWater: value.overWater, underWater: value.underWater };
  requireValue(['away', 'home'].includes(value.lineSide), 'NBA_READER_MARKET_INVALID', `${key} 讓分方未確認`);
  return { lineSide: value.lineSide, line: value.line, awayWater: value.awayWater, homeWater: value.homeWater };
}
function normalizeGame(row, boardDate) {
  requireValue(row && typeof row === 'object' && !Array.isArray(row), 'NBA_READER_GAME_INVALID', 'NBA 場次格式錯誤');
  requireValue((row.league == null || row.league === 'NBA') && !Object.hasOwn(row, 'first5Runline') && !Object.hasOwn(row, 'first5Total'), 'NBA_READER_PERIOD_INVALID', 'NBA 上半場不可使用棒球前五局欄位');
  const away = resolveNbaReaderTeam(row.awayCode); const home = resolveNbaReaderTeam(row.homeCode);
  requireValue(away && home && away.id !== home.id, 'NBA_READER_TEAM_INVALID', 'NBA 球隊代碼無法唯一確認');
  requireValue(row.boardDate === boardDate && TIME.test(row.boardTime || ''), 'NBA_READER_GAME_INVALID', 'NBA 場次日期或台灣時間不一致');
  requireValue(['open', 'locked'].includes(row.marketStatus), 'NBA_READER_GAME_INVALID', 'NBA 盤口開盤狀態未確認');
  const markets = Object.fromEntries(NBA_READER_MARKET_KEYS.map(key => [key, market(row[key], key)]));
  const states = row.marketStates;
  requireValue(states == null || (typeof states === 'object' && !Array.isArray(states)
    && Object.keys(states).every(key => NBA_READER_MARKET_KEYS.includes(key))), 'NBA_READER_MARKET_INVALID', 'NBA 市場狀態欄位錯誤');
  const marketStates = Object.fromEntries(NBA_READER_MARKET_KEYS.map(key => {
    const state = states?.[key] ?? (markets[key] ? 'AVAILABLE' : 'UNAVAILABLE');
    requireValue(['AVAILABLE', 'UNAVAILABLE', 'BLOCKED'].includes(state)
      && (state === 'AVAILABLE') === Boolean(markets[key]), 'NBA_READER_MARKET_INVALID', `${key} 盤口與市場狀態不一致`);
    requireValue(state !== 'BLOCKED', 'NBA_READER_MARKET_BLOCKED', `${key} 原盤內容無法安全辨識，請重新擷取`, 409);
    return [key, state];
  }));
  const marketCount = Object.values(markets).filter(Boolean).length;
  requireValue(row.marketStatus === 'locked' ? marketCount === 0 : marketCount > 0, 'NBA_READER_MARKET_INVALID', 'NBA 鎖盤或開盤狀態與實際盤口不一致');
  return {
    captureKey: `nba:tai888:${boardDate}:${row.boardTime}:${away.sourceId}:${home.sourceId}`,
    league: 'NBA', awayCode: row.awayCode, homeCode: row.homeCode, away, home,
    boardDate, boardTime: row.boardTime, marketStatus: row.marketStatus, marketStates,
    ...markets, marketCount, identityStatus: 'team_mapped_game_unverified',
  };
}

export function normalizeNbaReaderPayload(payload, { now = Date.now(), deviceId, headerVersion } = {}) {
  requireValue(payload && typeof payload === 'object' && !Array.isArray(payload) && payload.league === 'NBA', 'NBA_READER_LEAGUE_INVALID', '此端點只接受 NBA Reader 盤口');
  requireValue(payload.version === 'TAI888-READER-DOM-v2.2.0' && supportedReaderVersion(payload.readerVersion), 'NBA_READER_VERSION_UNSUPPORTED', `NBA 需要 Reader ${NBA_READER_MINIMUM_VERSION} 以上版本`, 426);
  requireValue(headerVersion === undefined || headerVersion === payload.readerVersion, 'NBA_READER_VERSION_UNSUPPORTED', 'Reader 標頭與盤口版本不一致', 426);
  requireValue(payload.deviceId === deviceId, 'NBA_READER_DEVICE_INVALID', 'Reader 盤口與配對裝置不一致', 401);
  requireValue(validDate(payload.boardDate), 'NBA_READER_DATE_INVALID', 'NBA 盤口日期必須是有效的 YYYY-MM-DD');
  requireValue(Array.isArray(payload.games) && payload.games.length > 0 && payload.games.length <= 40, 'NBA_READER_COUNT_INVALID', 'NBA 盤口必須包含 1～40 場');
  requireValue(Number.isSafeInteger(payload.detectedGameCount) && payload.detectedGameCount === payload.games.length
    && Number.isSafeInteger(payload.expectedGameCount) && payload.expectedGameCount >= payload.games.length && payload.expectedGameCount <= 40, 'NBA_READER_COUNT_INVALID', 'NBA expectedGameCount／detectedGameCount 與擷取場數不一致');
  requireValue(payload.parseIssues == null || (Array.isArray(payload.parseIssues) && payload.parseIssues.length === 0), 'NBA_READER_PARSE_CONFLICT', 'NBA 原盤解析有衝突，請重新整理盤面', 409);
  const safeSource = source(payload);
  const observed = timestamp(payload.observedAt, 'observedAt'); const activity = timestamp(payload.pageActivityAt, 'pageActivityAt');
  requireValue(observed <= now + 90_000 && now - observed <= 600_000, 'NBA_READER_OBSERVATION_EXPIRED', 'NBA 盤口擷取時間過期或在未來');
  requireValue(activity <= observed + 5_000 && activity <= now + 5_000 && now - activity <= NBA_READER_FRESH_MS, 'NBA_READER_ACTIVITY_EXPIRED', 'NBA 原盤頁面活動時間過期或在未來', 409);
  requireValue(typeof payload.payloadHash === 'string' && /^[a-f0-9]{64}$/.test(payload.payloadHash), 'NBA_READER_HASH_INVALID', 'NBA payloadHash 格式錯誤');
  const expected = digest(canonicalReaderPayload(payload));
  requireValue(timingSafeEqual(Buffer.from(expected), Buffer.from(payload.payloadHash)), 'NBA_READER_HASH_INVALID', 'NBA 盤口雜湊不一致，請重新擷取原盤', 409);
  const games = payload.games.map(row => normalizeGame(row, payload.boardDate));
  requireValue(new Set(games.map(game => game.captureKey)).size === games.length, 'NBA_READER_DUPLICATE_GAME', 'NBA 盤口包含重複或別名重複的場次', 409);
  return {
    version: NBA_READER_VERSION, league: 'NBA', ...safeSource,
    boardDate: payload.boardDate, observedAt: new Date(observed).toISOString(),
    pageActivityAt: new Date(activity).toISOString(), receivedAt: new Date(now).toISOString(),
    readerVersion: payload.readerVersion, deviceId, clientPayloadHash: expected,
    expectedGameCount: payload.expectedGameCount, gameCount: games.length,
    marketCount: games.reduce((count, game) => count + game.marketCount, 0),
    games, executable: false,
  };
}

export function assertNbaReaderMonotonic(previous, snapshot) {
  if (!previous) return;
  requireValue(previous.league === 'NBA' && snapshot.league === 'NBA', 'NBA_READER_LEAGUE_INVALID', 'NBA Reader 快取聯盟不一致', 409);
  requireValue(Date.parse(snapshot.observedAt) > Date.parse(previous.observedAt)
    && Date.parse(snapshot.pageActivityAt) >= Date.parse(previous.pageActivityAt)
    && (snapshot.clientPayloadHash === previous.clientPayloadHash || Date.parse(snapshot.pageActivityAt) > Date.parse(previous.pageActivityAt)),
  'NBA_READER_REPLAY', 'NBA Reader 時間倒退或重播，已拒絕覆蓋', 409);
}

export function nbaReaderPublicView(snapshot, { now = Date.now(), boardDate = '' } = {}) {
  if (!snapshot) return { status: 'waiting', boardDate: boardDate || null, observedAt: null, receivedAt: null, readerVersion: null, games: [], gameCount: 0, marketCount: 0, executable: false };
  const activityAge = now - Date.parse(snapshot.pageActivityAt); const observedAge = now - Date.parse(snapshot.observedAt);
  const fresh = activityAge >= -5_000 && activityAge <= NBA_READER_FRESH_MS && observedAge >= -90_000 && observedAge <= NBA_READER_FRESH_MS;
  return { status: fresh ? 'fresh' : 'stale', boardDate: snapshot.boardDate, observedAt: snapshot.observedAt, receivedAt: snapshot.receivedAt,
    pageActivityAt: snapshot.pageActivityAt, readerVersion: snapshot.readerVersion, games: snapshot.games,
    gameCount: snapshot.gameCount, expectedGameCount: snapshot.expectedGameCount, marketCount: snapshot.marketCount,
    source: { provider: 'TAI888_READER', host: snapshot.sourceHost }, executable: false };
}
