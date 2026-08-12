import { createHash } from 'node:crypto';
import { validateMarketPair } from './markets.js';

export const TAI888_READER_PARSER_VERSION = 'TAI888-READER-PARSER-v2.0.2';

const TEAM_IDS = Object.freeze({
  LAA: 108, ARI: 109, AZ: 109, BAL: 110, BOS: 111, CHC: 112, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, KCR: 118, KAN: 118,
  LAD: 119, WSH: 120, WAS: 120, WSN: 120, NYM: 121, OAK: 133, ATH: 133,
  PIT: 134, SD: 135, SDP: 135, SDG: 135, SEA: 136, SF: 137, SFG: 137,
  SFO: 137, STL: 138, TB: 139, TBR: 139, TAM: 139, TEX: 140, TOR: 141,
  MIN: 142, PHI: 143, ATL: 144, CWS: 145, CHW: 145, MIA: 146, NYY: 147,
  MIL: 158,
});

const LINE_TOKEN = /^(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(平|[+-]\d{1,3})?$/;
const clean = (value, maximum = 300) => String(value || '')
  .replace(/[\u0000-\u001F\u007F]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximum);

function actualWater(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0.5 && number <= 1.5 ? number : null;
}

function lineToken(value) {
  const token = clean(value, 24).replace(/[＋]/g, '+').replace(/[－–—]/g, '-');
  return LINE_TOKEN.test(token) ? token : '';
}

function taipeiDateTime(gameDate) {
  const date = new Date(gameDate || '');
  if (!Number.isFinite(date.getTime())) return { date: '', time: '' };
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

function minutes(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function circularMinuteDistance(left, right) {
  if (left == null || right == null) return null;
  const raw = Math.abs(left - right);
  return raw > 720 ? 1440 - raw : raw;
}

function matchReaderGame(raw, schedule) {
  const awayId = TEAM_IDS[String(raw.awayCode || '').toUpperCase()];
  const homeId = TEAM_IDS[String(raw.homeCode || '').toUpperCase()];
  const candidates = (schedule || []).filter(game => (
    Number(game.awayTeamId) === awayId && Number(game.homeTeamId) === homeId
  ));
  if (!candidates.length) return null;

  const boardMinutes = minutes(raw.boardTime);
  const scored = candidates.map(game => {
    const local = taipeiDateTime(game.gameDate);
    const timeDistance = circularMinuteDistance(minutes(local.time), boardMinutes);
    const dateMatches = !raw.boardDate || local.date === raw.boardDate;
    const score = (dateMatches ? 0 : 1440) + (timeDistance == null ? 0 : timeDistance);
    return { game, local, timeDistance, dateMatches, score };
  }).sort((left, right) => left.score - right.score);

  const best = scored[0];
  if (!best) return null;
  if (raw.boardDate && !best.dateMatches) return null;
  if (boardMinutes != null && best.timeDistance != null && best.timeDistance > 180) return null;
  return best.game;
}

function direction({ market, pick, water, observedAt, rawText, referenceSide }) {
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
    lineAsOf: observedAt,
    executable: actual != null,
    marketVerification: null,
    rawText: clean(rawText, 300),
    referenceSide,
    sourceTemplateVersion: 'TAI888-DOM-TABLE-v2.0.2',
    authorizationStatus: 'USER_AUTHENTICATED_VISIBLE_PAGE',
  };
}

function runlineDirections(market, raw, game, observedAt) {
  if (!raw || !['away', 'home'].includes(raw.lineSide)) return [];
  const token = lineToken(raw.line);
  if (!token) return [];
  const favoriteSide = raw.lineSide;
  const underdogSide = favoriteSide === 'away' ? 'home' : 'away';
  const favoriteTeam = game[favoriteSide];
  const underdogTeam = game[underdogSide];
  const water = {
    away: actualWater(raw.awayWater),
    home: actualWater(raw.homeWater),
  };
  const rows = [
    direction({ market, pick: `${favoriteTeam}讓${token}`, water: water[favoriteSide], observedAt, rawText: raw.rawRows?.join(' | '), referenceSide: favoriteSide }),
    direction({ market, pick: `${underdogTeam}受讓${token}`, water: water[underdogSide], observedAt, rawText: raw.rawRows?.join(' | '), referenceSide: favoriteSide }),
  ];
  return validateMarketPair(market, rows).length ? [] : rows;
}

function totalDirections(market, raw, observedAt) {
  if (!raw) return [];
  const token = lineToken(raw.line);
  if (!token) return [];
  const rows = [
    direction({ market, pick: `大${token}`, water: raw.overWater, observedAt, rawText: raw.rawRows?.join(' | '), referenceSide: 'over' }),
    direction({ market, pick: `小${token}`, water: raw.underWater, observedAt, rawText: raw.rawRows?.join(' | '), referenceSide: 'over' }),
  ];
  return validateMarketPair(market, rows).length ? [] : rows;
}

function normalizedHost(value) {
  try { return new URL(`https://${clean(value, 200)}`).hostname.toLowerCase(); }
  catch { return ''; }
}

function validTai888Host(host) {
  return host === 'tai888.in' || host.endsWith('.tai888.in');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function normalizeTai888ReaderPayload(payload, schedule, { deviceId = '', receivedAt = new Date().toISOString() } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Reader payload 格式錯誤');
  const sourceHost = normalizedHost(payload.sourceHost || new URL(payload.pageUrl || 'https://invalid.local').hostname);
  if (!validTai888Host(sourceHost)) throw new Error('Reader 來源不是 tai888.in');
  const observedAt = clean(payload.observedAt, 60);
  const observedTime = Date.parse(observedAt);
  if (!Number.isFinite(observedTime)) throw new Error('Reader observedAt 格式錯誤');
  const receivedTime = Date.parse(receivedAt);
  if (observedTime > receivedTime + 90 * 1000 || observedTime < receivedTime - 10 * 60 * 1000) {
    throw new Error('Reader 盤口時間與伺服器差距過大');
  }

  const rawGames = Array.isArray(payload.games) ? payload.games.slice(0, 40) : [];
  const gameByPk = new Map();
  const unmatched = [];
  for (const raw of rawGames) {
    const awayCode = clean(raw?.awayCode, 8).toUpperCase();
    const homeCode = clean(raw?.homeCode, 8).toUpperCase();
    if (!TEAM_IDS[awayCode] || !TEAM_IDS[homeCode]) {
      unmatched.push(`${awayCode || '?'}@${homeCode || '?'}：球隊代碼不支援`);
      continue;
    }
    const matched = matchReaderGame({ ...raw, awayCode, homeCode }, schedule);
    if (!matched) {
      unmatched.push(`${awayCode}@${homeCode}：日期／時間無法唯一配對`);
      continue;
    }
    const markets = [
      ...runlineDirections('全場讓分', raw.fullRunline, matched, observedAt),
      ...totalDirections('全場大小', raw.fullTotal, observedAt),
      ...runlineDirections('上半讓分', raw.first5Runline, matched, observedAt),
      ...totalDirections('上半大小', raw.first5Total, observedAt),
    ];
    if (!markets.length) continue;

    const existing = gameByPk.get(Number(matched.gamePk));
    const combinedMarkets = existing
      ? [...existing.markets, ...markets]
      : markets;
    const marketMap = new Map(combinedMarkets.map(row => [`${row.market}|${row.pick}`, row]));
    gameByPk.set(Number(matched.gamePk), {
      gamePk: matched.gamePk,
      game: matched,
      source: {
        provider: 'TAI888_READER_AUTO',
        label: 'Tai888 Reader 自動信用盤',
        sourceType: 'ACTUAL_TW_CREDIT',
        observedAt,
        receivedAt,
        executable: true,
        deviceId: clean(deviceId, 100),
      },
      markets: [...marketMap.values()],
      readerMeta: {
        awayCode,
        homeCode,
        boardDate: clean(raw.boardDate, 20),
        boardTime: clean(raw.boardTime, 10),
      },
    });
  }

  const games = [...gameByPk.values()];
  const boardDate = clean(payload.boardDate, 20) || games[0]?.readerMeta?.boardDate || '';
  const hashSource = canonical({
    version: clean(payload.version, 80),
    sourceHost,
    boardDate,
    games: games.map(game => ({
      gamePk: game.gamePk,
      markets: game.markets.map(row => ({ market: row.market, pick: row.pick, water: row.water })),
    })),
  });
  const payloadHash = createHash('sha256').update(JSON.stringify(hashSource)).digest('hex');
  return {
    version: TAI888_READER_PARSER_VERSION,
    readerVersion: clean(payload.readerVersion || payload.version, 80),
    sourceHost,
    pageTitle: clean(payload.pageTitle, 200),
    pageUrl: clean(payload.pageUrl, 500),
    boardDate,
    observedAt,
    receivedAt,
    freshnessTtlSeconds: 180,
    deviceId: clean(deviceId, 100),
    payloadHash,
    rawGameCount: rawGames.length,
    matchedGameCount: games.length,
    scheduleGameCount: Array.isArray(schedule) ? schedule.length : 0,
    unmatched: unmatched.slice(0, 20),
    games,
  };
}
