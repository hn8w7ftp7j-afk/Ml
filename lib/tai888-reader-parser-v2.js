import { createHash } from 'node:crypto';
import { isLeagueId } from './leagues.js';
import { normalizeTeamCode, resolveLeagueTeamId, TEAM_CODE_RE } from './league-teams.js';
import { validateMarketPair } from './markets.js';

export const TAI888_READER_PARSER_VERSION = 'TAI888-READER-PARSER-v2.1.0';
export const MINIMUM_READER_VERSION = '2.0.3';
export const MINIMUM_READER_VERSION_BY_LEAGUE = Object.freeze({
  MLB: MINIMUM_READER_VERSION,
  NPB: '2.1.0',
  KBO: '2.1.0',
  CPBL: '2.1.0',
});

const MARKET_ORDER = Object.freeze(['全場讓分', '全場大小', '上半讓分', '上半大小']);
const LINE_TOKEN = /^(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(平|[+-]\d{1,3})?$/;
const BOARD_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_GAME_TIME_DISTANCE_MINUTES = 90;
const MAX_OBSERVATION_AGE_MS = 10 * 60 * 1000;
const MAX_PAGE_ACTIVITY_AGE_MS = 180 * 1000;
const MAX_CLOCK_SKEW_MS = 90 * 1000;

const clean = (value, maximum = 300) => String(value ?? '')
  .replace(/[\u0000-\u001F\u007F]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximum);

function readerError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validBoardDate(value) {
  const text = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === text;
}

function actualWater(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0.01 && number <= 3 ? number : null;
}

function hashWater(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : clean(value, 30);
}

function lineToken(value) {
  const token = clean(value, 24).replace(/[＋]/g, '+').replace(/[－–—]/g, '-');
  return LINE_TOKEN.test(token) ? token : '';
}

function normalizedHost(value) {
  const candidate = clean(value, 500);
  if (!candidate) return '';
  try {
    const url = candidate.includes('://') ? new URL(candidate) : new URL(`https://${candidate}`);
    return url.hostname.toLowerCase();
  } catch {
    return '';
  }
}

function payloadSourceHost(payload) {
  return normalizedHost(payload?.sourceHost) || normalizedHost(sanitizeTai888PageUrl(payload?.pageUrl));
}

function validTai888Host(host) {
  return host === 'tai888.in' || host.endsWith('.tai888.in');
}

export function sanitizeTai888PageUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || !validTai888Host(host)) return '';
    const marker = /^#\/BS(?:$|[/?&])/i.test(parsed.hash || '') ? '#/BS' : '';
    return `${parsed.origin}${parsed.pathname || '/'}${marker}`.slice(0, 500);
  } catch {
    return '';
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function versionParts(value) {
  const match = clean(value, 100).match(/(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/);
  return match ? match.slice(1).map(Number) : null;
}

function normalizedLeague(value, { allowLegacyMlb = false } = {}) {
  if ((value == null || String(value).trim() === '') && allowLegacyMlb) return 'MLB';
  const league = String(value || '').trim().toUpperCase();
  return isLeagueId(league) ? league : '';
}

export function readerVersionSupported(value, league = 'MLB') {
  const normalized = normalizedLeague(league);
  if (!normalized) return false;
  const actual = versionParts(value);
  const minimum = versionParts(MINIMUM_READER_VERSION_BY_LEAGUE[normalized]);
  if (!actual || !minimum) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export function taipeiDateTime(gameDate) {
  const date = new Date(gameDate || '');
  if (!Number.isFinite(date.getTime())) return { date: '', time: '' };
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
  };
}

export function officialTaipeiBoardSchedule(schedule, boardDate, league = 'MLB') {
  if (!validBoardDate(boardDate) || !isLeagueId(league)) return [];
  const unique = new Map();
  for (const game of Array.isArray(schedule) ? schedule : []) {
    const gamePk = Number(game?.gamePk);
    const local = taipeiDateTime(game?.gameDate);
    const gameLeague = normalizedLeague(game?.league || game?.leagueId, { allowLegacyMlb: league === 'MLB' });
    if (gameLeague && gameLeague !== league) continue;
    if (!Number.isSafeInteger(gamePk) || gamePk <= 0 || local.date !== boardDate) continue;
    unique.set(gamePk, { ...game, league });
  }
  return [...unique.values()].sort((left, right) => (
    Date.parse(left.gameDate || '') - Date.parse(right.gameDate || '')
    || Number(left.gamePk) - Number(right.gamePk)
  ));
}

function normalizedRawMarket(raw, kind) {
  if (!raw || typeof raw !== 'object') return null;
  if (kind === 'runline') {
    return {
      lineSide: clean(raw.lineSide, 10).toLowerCase(),
      line: lineToken(raw.line) || clean(raw.line, 24),
      awayWater: hashWater(raw.awayWater),
      homeWater: hashWater(raw.homeWater),
    };
  }
  return {
    line: lineToken(raw.line) || clean(raw.line, 24),
    overWater: hashWater(raw.overWater),
    underWater: hashWater(raw.underWater),
  };
}

function normalizedRawGame(raw) {
  return {
    awayCode: normalizeTeamCode(clean(raw?.awayCode, 12)),
    homeCode: normalizeTeamCode(clean(raw?.homeCode, 12)),
    boardDate: clean(raw?.boardDate, 20),
    boardTime: clean(raw?.boardTime, 10),
    marketStatus: raw?.marketStatus === 'locked' ? 'locked' : 'open',
    fullRunline: normalizedRawMarket(raw?.fullRunline, 'runline'),
    fullTotal: normalizedRawMarket(raw?.fullTotal, 'total'),
    first5Runline: normalizedRawMarket(raw?.first5Runline, 'runline'),
    first5Total: normalizedRawMarket(raw?.first5Total, 'total'),
  };
}

export function rawTai888ReaderPayloadHash(payload) {
  const league = normalizedLeague(payload?.league, { allowLegacyMlb: true });
  const games = (Array.isArray(payload?.games) ? payload.games : [])
    .map(normalizedRawGame)
    .sort((left, right) => compareText(JSON.stringify(canonical(left)), JSON.stringify(canonical(right))));
  return sha256({
    domain: 'baseball-positive-ev/reader-raw-board/v2',
    league,
    sourceHost: payloadSourceHost(payload),
    boardDate: clean(payload?.boardDate, 20),
    games,
  });
}

function canonicalReaderPayloadForClientHash(payload, league) {
  const games = (Array.isArray(payload?.games) ? payload.games : [])
    .map(normalizedRawGame)
    .sort((left, right) => {
      const leftKey = `${left.boardDate}|${left.boardTime}|${left.awayCode}|${left.homeCode}`;
      const rightKey = `${right.boardDate}|${right.boardTime}|${right.awayCode}|${right.homeCode}`;
      return compareText(leftKey, rightKey);
    });
  return JSON.stringify({
    version: clean(payload?.version, 100),
    league,
    sourceHost: payloadSourceHost(payload),
    boardDate: clean(payload?.boardDate, 20),
    games,
  });
}

function validateClaimedPayloadHash(payload, league, readerVersion) {
  const actualVersion = versionParts(readerVersion);
  const v21OrLater = actualVersion
    && (actualVersion[0] > 2 || (actualVersion[0] === 2 && actualVersion[1] >= 1));
  if (!v21OrLater) {
    if (clean(payload?.version, 100) !== 'TAI888-READER-DOM-v2.0.3') {
      throw readerError('Reader DOM payload 版本不受支援', 426);
    }
    return;
  }
  if (clean(payload?.version, 100) !== 'TAI888-READER-DOM-v2.1.0') {
    throw readerError('Reader DOM payload 版本不受支援', 426);
  }
  const claimed = clean(payload?.payloadHash, 100).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(claimed)) throw readerError('Reader payloadHash 格式錯誤', 400);
  const expected = createHash('sha256')
    .update(canonicalReaderPayloadForClientHash(payload, league))
    .digest('hex');
  if (claimed !== expected) throw readerError('Reader payloadHash 與盤面內容不一致', 409);
}

export function validateTai888ReaderEnvelope(payload, {
  receivedAt = new Date().toISOString(),
  league: expectedLeague = '',
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw readerError('Reader payload 格式錯誤', 400);
  }
  const league = normalizedLeague(payload.league, { allowLegacyMlb: true });
  if (!league || (expectedLeague && league !== expectedLeague)) {
    throw readerError('Reader 聯盟識別錯誤', 400);
  }
  const readerVersion = clean(payload.readerVersion || payload.version, 100);
  const minimumVersion = MINIMUM_READER_VERSION_BY_LEAGUE[league];
  if (!readerVersionSupported(readerVersion, league)) {
    throw readerError(`Reader 版本過舊，${league} 最低需要 ${minimumVersion}`, 426);
  }
  const sourceHost = payloadSourceHost(payload);
  if (!validTai888Host(sourceHost)) throw readerError('Reader 來源不是 tai888.in', 400);
  const pageUrl = sanitizeTai888PageUrl(payload.pageUrl);
  if (!pageUrl) throw readerError('Reader pageUrl 不是合法的 Tai888 HTTPS 網址', 400);
  const boardDate = clean(payload.boardDate, 20);
  if (!validBoardDate(boardDate)) throw readerError('Reader 盤口日期格式錯誤', 400);
  if (!Array.isArray(payload.games) || payload.games.length < 1 || payload.games.length > 40) {
    throw readerError('Reader games 必須包含 1～40 場完整盤面', 400);
  }
  assertClientCounts(payload, payload.games.length);
  validateClaimedPayloadHash(payload, league, readerVersion);

  const receivedTime = Date.parse(receivedAt);
  const observedTime = Date.parse(payload.observedAt || '');
  const pageActivityTime = Date.parse(payload.pageActivityAt || '');
  if (![receivedTime, observedTime, pageActivityTime].every(Number.isFinite)) {
    throw readerError('Reader observedAt/pageActivityAt 格式錯誤', 400);
  }
  if (observedTime > receivedTime + MAX_CLOCK_SKEW_MS
    || receivedTime - observedTime > MAX_OBSERVATION_AGE_MS) {
    throw readerError('Reader 盤口時間與伺服器差距過大', 400);
  }
  if (pageActivityTime > observedTime + 5_000
    || pageActivityTime > receivedTime + 5_000
    || receivedTime - pageActivityTime > MAX_PAGE_ACTIVITY_AGE_MS) {
    throw readerError('Tai888 頁面活動時間已過期或不合理', 409);
  }

  return {
    league,
    readerVersion,
    sourceHost,
    pageUrl,
    boardDate,
    receivedAt: new Date(receivedTime).toISOString(),
    observedAt: new Date(observedTime).toISOString(),
    pageActivityAt: new Date(pageActivityTime).toISOString(),
    expectedGameCount: Number(payload.expectedGameCount),
    detectedGameCount: Number(payload.detectedGameCount),
    rawBoardHash: rawTai888ReaderPayloadHash(payload),
  };
}

function minutes(value) {
  const match = clean(value, 10).match(BOARD_TIME);
  return match ? Number(match[0].slice(0, 2)) * 60 + Number(match[0].slice(3, 5)) : null;
}

function circularMinuteDistance(left, right) {
  if (left == null || right == null) return null;
  const raw = Math.abs(left - right);
  return raw > 720 ? 1440 - raw : raw;
}

function matchupKey(awayTeamId, homeTeamId) {
  return `${Number(awayTeamId)}|${Number(homeTeamId)}`;
}

function assignMatchup(rawRows, officialRows) {
  if (rawRows.length > officialRows.length || rawRows.length > 4) return null;
  const orderedRaw = [...rawRows].sort((left, right) => (
    compareText(left.boardTime, right.boardTime) || left.index - right.index
  ));
  const orderedOfficial = [...officialRows].sort((left, right) => (
    Date.parse(left.gameDate || '') - Date.parse(right.gameDate || '')
    || Number(left.gamePk) - Number(right.gamePk)
  ));
  let bestScore = Number.POSITIVE_INFINITY;
  let bestAssignment = null;
  let bestCount = 0;
  const used = new Set();

  function visit(rawIndex, score, assignments) {
    if (score > bestScore) return;
    if (rawIndex === orderedRaw.length) {
      if (score < bestScore) {
        bestScore = score;
        bestAssignment = assignments.slice();
        bestCount = 1;
      } else if (score === bestScore) {
        bestCount += 1;
      }
      return;
    }
    const raw = orderedRaw[rawIndex];
    const rawMinutes = minutes(raw.boardTime);
    for (let index = 0; index < orderedOfficial.length; index += 1) {
      if (used.has(index)) continue;
      const local = taipeiDateTime(orderedOfficial[index].gameDate);
      const distance = circularMinuteDistance(rawMinutes, minutes(local.time));
      if (distance == null || distance > MAX_GAME_TIME_DISTANCE_MINUTES) continue;
      used.add(index);
      assignments.push([raw.index, orderedOfficial[index]]);
      visit(rawIndex + 1, score + distance, assignments);
      assignments.pop();
      used.delete(index);
    }
  }

  visit(0, 0, []);
  return bestAssignment && bestCount === 1 ? bestAssignment : null;
}

function matchCompleteBoard(rawGames, schedule, boardDate, league) {
  if (!rawGames.length) throw readerError('Reader 沒有可驗證的盤口場次');
  if (rawGames.length > schedule.length) {
    throw readerError(`Reader 場次異常：讀到 ${rawGames.length} 場，超過官方台北盤日 ${schedule.length} 場`);
  }

  const rawGroups = new Map();
  rawGames.forEach((row, index) => {
    const awayCode = normalizeTeamCode(clean(row?.awayCode, 12));
    const homeCode = normalizeTeamCode(clean(row?.homeCode, 12));
    const awayTeamId = resolveLeagueTeamId(league, awayCode);
    const homeTeamId = resolveLeagueTeamId(league, homeCode);
    const rawBoardDate = clean(row?.boardDate, 20);
    const boardTime = clean(row?.boardTime, 10);
    if (!TEAM_CODE_RE.test(awayCode) || !TEAM_CODE_RE.test(homeCode)
      || !awayTeamId || !homeTeamId || awayTeamId === homeTeamId) {
      throw readerError(`${awayCode || '?'}@${homeCode || '?'}：${league} 球隊代碼不支援`);
    }
    if (rawBoardDate !== boardDate) throw readerError(`${awayCode}@${homeCode}：盤口日期與 boardDate 不一致`);
    if (!BOARD_TIME.test(boardTime)) throw readerError(`${awayCode}@${homeCode}：盤口時間格式錯誤`);
    const normalized = { row, index, awayCode, homeCode, awayTeamId, homeTeamId, boardTime };
    const key = matchupKey(awayTeamId, homeTeamId);
    if (!rawGroups.has(key)) rawGroups.set(key, []);
    rawGroups.get(key).push(normalized);
  });

  const officialGroups = new Map();
  for (const game of schedule) {
    const key = matchupKey(game.awayTeamId, game.homeTeamId);
    if (!officialGroups.has(key)) officialGroups.set(key, []);
    officialGroups.get(key).push(game);
  }
  if ([...rawGroups.keys()].some(key => !officialGroups.has(key))) {
    throw readerError('Reader 場次與官方台北盤日賽程不一致');
  }

  const matches = new Map();
  for (const [key, rawRows] of rawGroups) {
    const officialRows = officialGroups.get(key) || [];
    const assignment = assignMatchup(rawRows, officialRows);
    if (!assignment) {
      const label = `${rawRows[0]?.awayCode || '?'}@${rawRows[0]?.homeCode || '?'}`;
      throw readerError(`${label}：日期／時間無法唯一配對，已拒絕跨場次合併`);
    }
    assignment.forEach(([rawIndex, game]) => matches.set(rawIndex, game));
  }
  if (matches.size !== rawGames.length
    || new Set([...matches.values()].map(game => Number(game.gamePk))).size !== rawGames.length) {
    throw readerError('Reader 場次未能一對一配對官方賽程');
  }
  return matches;
}

function direction({ market, pick, water, pageActivityAt, rawText, referenceSide }) {
  const actual = actualWater(water);
  return {
    market,
    pick,
    water: actual,
    waterEstimated: false,
    waterMissing: actual == null,
    confidence: 1,
    sourceType: 'ACTUAL_TW_CREDIT',
    sourceLabel: 'Tai888 Reader 自動信用盤',
    provider: 'TAI888_READER_AUTO',
    lineAsOf: pageActivityAt,
    executable: actual != null,
    marketVerification: null,
    rawText: clean(rawText, 300),
    referenceSide,
    sourceTemplateVersion: 'TAI888-DOM-TABLE-v2.1.0',
    authorizationStatus: 'USER_AUTHENTICATED_VISIBLE_PAGE',
  };
}

function runlineDirections(market, raw, game, pageActivityAt) {
  if (!raw || !['away', 'home'].includes(raw.lineSide)) return [];
  const token = lineToken(raw.line);
  if (!token) return [];
  const favoriteSide = raw.lineSide;
  const underdogSide = favoriteSide === 'away' ? 'home' : 'away';
  const water = { away: raw.awayWater, home: raw.homeWater };
  const rows = [
    direction({
      market,
      pick: `${game[favoriteSide]}讓${token}`,
      water: water[favoriteSide],
      pageActivityAt,
      rawText: raw.rawRows?.join(' | '),
      referenceSide: favoriteSide,
    }),
    direction({
      market,
      pick: `${game[underdogSide]}受讓${token}`,
      water: water[underdogSide],
      pageActivityAt,
      rawText: raw.rawRows?.join(' | '),
      referenceSide: favoriteSide,
    }),
  ];
  return validateMarketPair(market, rows).length ? [] : rows;
}

function totalDirections(market, raw, pageActivityAt) {
  if (!raw) return [];
  const token = lineToken(raw.line);
  if (!token) return [];
  const rows = [
    direction({ market, pick: `大${token}`, water: raw.overWater, pageActivityAt, rawText: raw.rawRows?.join(' | '), referenceSide: 'over' }),
    direction({ market, pick: `小${token}`, water: raw.underWater, pageActivityAt, rawText: raw.rawRows?.join(' | '), referenceSide: 'over' }),
  ];
  return validateMarketPair(market, rows).length ? [] : rows;
}

function orderedMarkets(markets) {
  return [...markets].sort((left, right) => (
    MARKET_ORDER.indexOf(left.market) - MARKET_ORDER.indexOf(right.market)
    || compareText(left.pick, right.pick)
  ));
}

export function readerMarketsComplete(markets) {
  if (!Array.isArray(markets) || markets.length !== 8) return false;
  const unique = new Set();
  for (const market of MARKET_ORDER) {
    const pair = markets.filter(row => row?.market === market);
    if (pair.length !== 2 || validateMarketPair(market, pair).length) return false;
    for (const row of pair) {
      const key = `${row.market}|${clean(row.pick, 120)}`;
      if (unique.has(key)
        || actualWater(row.water) == null
        || row.executable !== true
        || row.waterEstimated !== false
        || row.waterMissing !== false
        || !Number.isFinite(Date.parse(row.lineAsOf || ''))) return false;
      unique.add(key);
    }
  }
  return unique.size === 8;
}

export function readerSnapshotIsComplete(snapshot) {
  const league = normalizedLeague(snapshot?.league);
  const games = Array.isArray(snapshot?.games) ? snapshot.games : [];
  const unopenedGames = Array.isArray(snapshot?.unopenedGames) ? snapshot.unopenedGames : [];
  const count = games.length;
  const totalCount = count + unopenedGames.length;
  const observedTime = Date.parse(snapshot?.observedAt || '');
  const activityTime = Date.parse(snapshot?.pageActivityAt || '');
  const pageUrl = String(snapshot?.pageUrl || '');
  const privateMetadataSafe = !Object.hasOwn(snapshot || {}, 'pageTitle')
    && !Object.hasOwn(snapshot || {}, 'frameUrl')
    && (!pageUrl || pageUrl === sanitizeTai888PageUrl(pageUrl));
  return Boolean(league)
    && readerVersionSupported(snapshot?.readerVersion, league)
    && privateMetadataSafe
    && validTai888Host(normalizedHost(snapshot?.sourceHost))
    && validBoardDate(snapshot?.boardDate)
    && /^[a-f0-9]{64}$/.test(String(snapshot?.rawBoardHash || ''))
    && /^[a-f0-9]{64}$/.test(String(snapshot?.payloadHash || ''))
    && Number.isFinite(observedTime)
    && Number.isFinite(activityTime)
    && activityTime <= observedTime + 5_000
    && totalCount > 0
    && Number.isInteger(Number(snapshot.rawGameCount))
    && Number(snapshot.rawGameCount) > 0
    && Number(snapshot.rawGameCount) <= totalCount
    && Number(snapshot.matchedGameCount) === count
    && Number(snapshot.unopenedGameCount) === unopenedGames.length
    && Number(snapshot.scheduleGameCount) === totalCount
    && Array.isArray(snapshot.unmatched)
    && snapshot.unmatched.length === 0
    && new Set([...games, ...unopenedGames].map(game => Number(game.gamePk))).size === totalCount
    && games.every(game => (
      normalizedLeague(game?.game?.league || game?.league) === league
      && normalizedLeague(game?.source?.league) === league
      && game?.source?.executable === true
      && game?.source?.pageActivityAt === snapshot.pageActivityAt
      && readerMarketsComplete(game.markets)
      && game.markets.every(market => market.lineAsOf === snapshot.pageActivityAt)
    ))
    && unopenedGames.every(game => (
      Number.isInteger(Number(game?.gamePk))
      && normalizedLeague(game?.game?.league || game?.league) === league
      && normalizedLeague(game?.source?.league) === league
      && game?.marketStatus === 'locked'
      && game?.source?.executable === false
      && game?.source?.pageActivityAt === snapshot.pageActivityAt
      && (!Array.isArray(game?.markets) || game.markets.length === 0)
    ));
}

function assertClientCounts(payload, rawGameCount) {
  for (const name of ['expectedGameCount', 'detectedGameCount']) {
    if (payload?.[name] == null || payload[name] === '') {
      throw readerError(`Reader ${name} 缺失，無法證明完整盤面`, 400);
    }
    const count = Number(payload[name]);
    const valid = name === 'expectedGameCount'
      ? Number.isInteger(count) && count >= rawGameCount && count <= 40
      : Number.isInteger(count) && count === rawGameCount;
    if (!valid) {
      throw readerError(`Reader ${name} 與實際解析場次不一致`, 400);
    }
  }
}

export function normalizeTai888ReaderPayload(payload, schedule, options = {}) {
  const receivedAt = options.receivedAt || new Date().toISOString();
  const expectedLeague = normalizedLeague(options.league || payload?.league, { allowLegacyMlb: true });
  if (!expectedLeague) throw readerError('Reader 聯盟識別錯誤', 400);
  const envelope = options.envelope || validateTai888ReaderEnvelope(payload, {
    receivedAt,
    league: expectedLeague,
  });
  const league = envelope.league;
  const officialSchedule = officialTaipeiBoardSchedule(schedule, envelope.boardDate, league);
  if (!officialSchedule.length) throw readerError('官方台北盤日賽程為空，Reader 本次未寫入', 502);
  // Tai888's league count can exclude games whose board has not been rendered
  // yet, while the official Taipei slate still includes them.  Accept only a
  // smaller, internally complete Reader subset and keep every official game
  // absent from that subset non-executable.  A Reader count larger than the
  // official slate is still an identity error and must fail closed.
  const visibleRawGames = Array.isArray(payload.games) ? payload.games.slice(0, 40) : [];
  assertClientCounts(payload, visibleRawGames.length);
  let rawGames = visibleRawGames;
  if (envelope.expectedGameCount > officialSchedule.length) {
    const fullOfficialSchedule = officialTaipeiBoardSchedule(options.fullSchedule, envelope.boardDate, league);
    if (!fullOfficialSchedule.length || envelope.expectedGameCount > fullOfficialSchedule.length) {
      throw readerError(`Reader 顯示應有 ${envelope.expectedGameCount} 場，超過官方台北盤日 ${officialSchedule.length} 場`);
    }
    // Tai888 can retain rows briefly after their official start. Prove every
    // visible row against the complete official slate, then retain only the
    // identities that are still prestart. Started rows never become executable.
    const visibleMatches = matchCompleteBoard(visibleRawGames, fullOfficialSchedule, envelope.boardDate, league);
    const prestartPks = new Set(officialSchedule.map(game => Number(game.gamePk)));
    rawGames = visibleRawGames.filter((game, index) => (
      prestartPks.has(Number(visibleMatches.get(index)?.gamePk))
    ));
  }
  const matches = matchCompleteBoard(rawGames, officialSchedule, envelope.boardDate, league);
  const normalizedRows = rawGames.map((raw, index) => {
    const game = matches.get(index);
    const awayCode = normalizeTeamCode(clean(raw?.awayCode, 12));
    const homeCode = normalizeTeamCode(clean(raw?.homeCode, 12));
    const leagueGame = { ...game, league };
    const locked = raw?.marketStatus === 'locked';
    const markets = orderedMarkets([
      ...runlineDirections('全場讓分', raw.fullRunline, leagueGame, envelope.pageActivityAt),
      ...totalDirections('全場大小', raw.fullTotal, envelope.pageActivityAt),
      ...runlineDirections('上半讓分', raw.first5Runline, leagueGame, envelope.pageActivityAt),
      ...totalDirections('上半大小', raw.first5Total, envelope.pageActivityAt),
    ]);
    if (locked && markets.length) {
      throw readerError(`${awayCode}@${homeCode}：鎖盤場次不得夾帶盤口資料`);
    }
    if (!locked && !readerMarketsComplete(markets)) {
      throw readerError(`${awayCode}@${homeCode}：必須完整提供四個市場與八個可執行方向`);
    }
    return {
      gamePk: Number(game.gamePk),
      league,
      game: leagueGame,
      source: {
        league,
        provider: 'TAI888_READER_AUTO',
        label: 'Tai888 Reader 自動信用盤',
        sourceType: 'ACTUAL_TW_CREDIT',
        observedAt: envelope.observedAt,
        receivedAt: envelope.receivedAt,
        pageActivityAt: envelope.pageActivityAt,
        executable: !locked,
        deviceId: clean(options.deviceId, 100),
      },
      marketStatus: locked ? 'locked' : 'open',
      markets,
      readerMeta: {
        awayCode,
        homeCode,
        boardDate: envelope.boardDate,
        boardTime: clean(raw.boardTime, 10),
        gameNumber: Number(game.gameNumber || 1),
        doubleHeader: clean(game.doubleHeader, 10) || 'N',
      },
    };
  }).sort((left, right) => Number(left.gamePk) - Number(right.gamePk));
  const games = normalizedRows.filter(row => row.marketStatus === 'open');
  const explicitUnopenedGames = normalizedRows.filter(row => row.marketStatus === 'locked').map(row => ({
    ...row,
    markets: [],
  }));
  const representedGamePks = new Set(normalizedRows.map(row => Number(row.gamePk)));
  const inferredUnopenedGames = officialSchedule
    .filter(game => !representedGamePks.has(Number(game.gamePk)))
    .map(game => ({
      gamePk: Number(game.gamePk),
      league,
      game: { ...game, league },
      source: {
        league,
        provider: 'TAI888_READER_AUTO',
        label: 'Tai888 Reader 未呈現盤口',
        sourceType: 'ACTUAL_TW_CREDIT',
        observedAt: envelope.observedAt,
        receivedAt: envelope.receivedAt,
        pageActivityAt: envelope.pageActivityAt,
        executable: false,
        deviceId: clean(options.deviceId, 100),
      },
      marketStatus: 'locked',
      unavailableReason: 'not-rendered-by-reader',
      markets: [],
    }));
  const unopenedGames = [...explicitUnopenedGames, ...inferredUnopenedGames]
    .sort((left, right) => Number(left.gamePk) - Number(right.gamePk));

  const payloadHash = sha256({
    domain: 'baseball-positive-ev/reader-normalized-snapshot/v2',
    league,
    sourceHost: envelope.sourceHost,
    boardDate: envelope.boardDate,
    games: games.map(row => ({
      gamePk: row.gamePk,
      markets: row.markets.map(market => ({
        market: market.market,
        pick: market.pick,
        water: market.water,
      })),
    })),
    unopenedGamePks: unopenedGames.map(row => row.gamePk),
  });
  const normalized = {
    version: TAI888_READER_PARSER_VERSION,
    league,
    readerVersion: envelope.readerVersion,
    sourceHost: envelope.sourceHost,
    pageUrl: sanitizeTai888PageUrl(envelope.pageUrl || payload.pageUrl),
    boardDate: envelope.boardDate,
    observedAt: envelope.observedAt,
    receivedAt: envelope.receivedAt,
    pageActivityAt: envelope.pageActivityAt,
    freshnessTtlSeconds: 180,
    deviceId: clean(options.deviceId, 100),
    rawBoardHash: envelope.rawBoardHash,
    payloadHash,
    rawGameCount: rawGames.length,
    matchedGameCount: games.length,
    unopenedGameCount: unopenedGames.length,
    scheduleGameCount: officialSchedule.length,
    unmatched: [],
    games,
    unopenedGames,
  };
  if (!readerSnapshotIsComplete(normalized)) throw readerError('Reader 完整性驗證失敗，快照未寫入');
  return normalized;
}
