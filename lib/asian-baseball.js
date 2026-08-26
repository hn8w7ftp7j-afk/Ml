import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { ASIAN_LEAGUE_CONTRACTS } from './asian-league-contracts.js';
import {
  ASIAN_LEAGUE_READINESS_VERSION,
  asianDistributionEngineBlocker,
  asianFeatureBlockerDetails,
  asianLeagueReleaseReadiness,
} from './asian-league-readiness.js';
import { resolveLeagueTeamId } from './league-teams.js';

export const ASIAN_BASEBALL_VERSION = 'ASIAN-BASEBALL-OFFICIAL-PROVIDERS-2026-08-v2.1.0';
export const ASIAN_SCHEDULE_VERSION = 'ASIAN-OFFICIAL-SCHEDULE-2026-08-v1.1.0';
export const ASIAN_CONTEXT_VERSION = 'ASIAN-SHADOW-CONTEXT-2026-08-v2.1.0';
export const ASIAN_ANALYSIS_MODE = 'EXPERIMENTAL_SHADOW';

const ASIAN_LEAGUES = new Set(['NPB', 'KBO', 'CPBL']);
const USER_AGENT = 'Baseball-Positive-EV/9.6.2 (+official-schedule-only)';

const TEAM_DEFINITIONS = Object.freeze({
  NPB: Object.freeze({
    YOM: ['讀賣巨人', 'Yomiuri Giants', ['Yomiuri', 'Giants', 'G']],
    HAN: ['阪神虎', 'Hanshin Tigers', ['Hanshin', 'Tigers', 'T']],
    YDB: ['橫濱DeNA灣星', 'Yokohama DeNA BayStars', ['DeNA', 'Yokohama', 'BayStars', 'DB']],
    HIR: ['廣島東洋鯉魚', 'Hiroshima Toyo Carp', ['Hiroshima', 'Carp', 'C']],
    YAK: ['東京養樂多燕子', 'Tokyo Yakult Swallows', ['Yakult', 'Swallows', 'S']],
    CHU: ['中日龍', 'Chunichi Dragons', ['Chunichi', 'Dragons', 'D']],
    SOF: ['福岡軟銀鷹', 'Fukuoka SoftBank Hawks', ['SoftBank', 'Softbank', 'Hawks', 'H']],
    NIP: ['北海道日本火腿鬥士', 'Hokkaido Nippon-Ham Fighters', ['Nippon-Ham', 'Nippon Ham', 'Fighters', 'F']],
    LOM: ['千葉羅德海洋', 'Chiba Lotte Marines', ['Lotte', 'Marines', 'M']],
    RAK: ['東北樂天金鷲', 'Tohoku Rakuten Golden Eagles', ['Rakuten', 'Eagles', 'E']],
    ORI: ['歐力士猛牛', 'ORIX Buffaloes', ['ORIX', 'Orix', 'Buffaloes', 'B']],
    SEI: ['埼玉西武獅', 'Saitama Seibu Lions', ['Seibu', 'Lions', 'L']],
  }),
  KBO: Object.freeze({
    KIA: ['KIA虎', 'KIA Tigers', ['KIA', 'KIA TIGERS']],
    SAM: ['三星獅', 'Samsung Lions', ['SAMSUNG', 'SAMSUNG LIONS', '삼성']],
    LGT: ['LG雙子', 'LG Twins', ['LG', 'LG TWINS']],
    DOO: ['斗山熊', 'Doosan Bears', ['DOOSAN', 'DOOSAN BEARS', '두산']],
    KTW: ['KT巫師', 'KT Wiz', ['KT', 'KT WIZ']],
    SSG: ['SSG登陸者', 'SSG Landers', ['SSG', 'SSG LANDERS']],
    LOG: ['樂天巨人', 'Lotte Giants', ['LOTTE', 'LOTTE GIANTS', '롯데']],
    HAN: ['韓華鷹', 'Hanwha Eagles', ['HANWHA', 'HANWHA EAGLES', '한화']],
    NCD: ['NC恐龍', 'NC Dinos', ['NC', 'NC DINOS']],
    KIW: ['培證英雄', 'Kiwoom Heroes', ['KIWOOM', 'KIWOOM HEROES', '키움']],
  }),
  CPBL: Object.freeze({
    CTB: ['中信兄弟', 'CTBC Brothers', ['ACN011', '中信兄弟', 'CTBC Brothers']],
    UNI: ['統一7-ELEVEn獅', 'Uni-President 7-Eleven Lions', ['ADD011', '統一7-ELEVEn獅', '統一獅']],
    RKM: ['樂天桃猿', 'Rakuten Monkeys', ['AJL011', '樂天桃猿']],
    FUB: ['富邦悍將', 'Fubon Guardians', ['AEO011', '富邦悍將']],
    WCD: ['味全龍', 'Wei Chuan Dragons', ['AAA011', '味全龍']],
    TSG: ['台鋼雄鷹', 'TSG Hawks', ['AKP011', '台鋼雄鷹']],
  }),
});

const SOURCE_CONFIG = Object.freeze(Object.fromEntries(
  Object.entries(ASIAN_LEAGUE_CONTRACTS).map(([id, contract]) => [id, Object.freeze({
    id: contract.provider.id,
    label: contract.provider.label,
    zoneOffset: contract.provider.zoneOffset,
    mlbFallbackAllowed: contract.provider.mlbFallbackAllowed,
    modelVersion: contract.modelVersion,
    rulesVersion: contract.rulesVersion,
    baselineRuns: contract.baselineRuns,
    modelConfig: contract.modelConfig,
    featureContract: contract.featureContract,
    rules: contract.rules,
  })]),
));

function providerError(message, status = 502, code = 'ASIAN_PROVIDER_UNAVAILABLE') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function leagueId(value) {
  const id = String(value || '').trim().toUpperCase();
  if (!ASIAN_LEAGUES.has(id)) throw providerError('不支援的亞洲棒球聯盟', 400, 'UNKNOWN_LEAGUE');
  return id;
}

function validDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function cleanText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function numericScore(value) {
  const text = cleanText(value);
  if (!/^\d+$/.test(text)) return null;
  const score = Number(text);
  return Number.isSafeInteger(score) && score >= 0 ? score : null;
}

function stableSafeInteger(value) {
  const hex = createHash('sha256').update(String(value)).digest('hex').slice(0, 13);
  return Number.parseInt(hex, 16) || 1;
}

export function stableAsianGamePk(league, sourceIdentity) {
  return stableSafeInteger(`baseball-positive-ev/game/${leagueId(league)}/${sourceIdentity}`);
}

function stableVenueId(league, venue) {
  return stableSafeInteger(`baseball-positive-ev/venue/${league}/${cleanText(venue)}`);
}

function localIso(date, time, offset) {
  const normalizedTime = /^\d{1,2}:\d{2}$/.test(cleanText(time))
    ? cleanText(time).split(':').map(value => value.padStart(2, '0')).join(':')
    : '18:00';
  const instant = new Date(`${date}T${normalizedTime}:00${offset}`);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : '';
}

function teamIndex(league) {
  const byAlias = new Map();
  for (const [code, [name, english, aliases]] of Object.entries(TEAM_DEFINITIONS[league] || {})) {
    const team = Object.freeze({ code, id: resolveLeagueTeamId(league, code), name, english });
    for (const alias of [code, name, english, ...aliases]) byAlias.set(cleanText(alias).toUpperCase(), team);
  }
  return byAlias;
}

const TEAM_INDEXES = Object.freeze(Object.fromEntries([...ASIAN_LEAGUES].map(id => [id, teamIndex(id)])));

function resolveTeam(league, value) {
  return TEAM_INDEXES[league].get(cleanText(value).toUpperCase()) || null;
}

function statusFields(status) {
  const value = cleanText(status).toUpperCase();
  if (/POSTPON|CANCEL|SUSPEND|RAIN|NO GAME|취소|연기|중단|우천/.test(value)) {
    return { status: '延期／取消', statusEnglish: value || 'Postponed', statusCode: 'D' };
  }
  if (/IN PROGRESS|PLAYING|LIVE|START|진행|경기중|회초|회말/.test(value) && !/SCHEDULE/.test(value)) {
    return { status: '比賽進行中', statusEnglish: value || 'In Progress', statusCode: 'I' };
  }
  if (/FINISH|FINAL|COMPLETED|GAME END|종료|경기종료/.test(value)) {
    return { status: '比賽結束', statusEnglish: value || 'Final', statusCode: 'F' };
  }
  return { status: '尚未開賽', statusEnglish: value || 'Scheduled', statusCode: 'S' };
}

function normalizedGame({
  league, sourceId, date, time, awayTeam, homeTeam, venue = '', status = '', awayScore = null,
  homeScore = null, innings = null, gameNumber = 1,
}) {
  const scoresPresent = Number.isFinite(awayScore) && Number.isFinite(homeScore);
  const state = statusFields(status);
  const officialScoresPresent = state.statusCode === 'F' && scoresPresent;
  const gameDate = localIso(date, time, SOURCE_CONFIG[league].zoneOffset);
  if (!awayTeam?.id || !homeTeam?.id || !gameDate) return null;
  const identity = sourceId || `${date}|${time}|${awayTeam.code}|${homeTeam.code}|${gameNumber}`;
  return {
    league,
    leagueId: league,
    providerGameId: cleanText(sourceId || identity),
    gamePk: stableAsianGamePk(league, identity),
    gameDate,
    taipeiDate: date,
    officialDate: date,
    ...state,
    doubleHeader: 'N',
    gameNumber: Math.max(1, Number(gameNumber) || 1),
    scheduledInnings: 9,
    away: awayTeam.name,
    home: homeTeam.name,
    awayEnglish: awayTeam.english,
    homeEnglish: homeTeam.english,
    awayCode: awayTeam.code,
    homeCode: homeTeam.code,
    awayTeamId: awayTeam.id,
    homeTeamId: homeTeam.id,
    awayProbable: '',
    homeProbable: '',
    awayProbableId: null,
    homeProbableId: null,
    venue: cleanText(venue) || '場地待確認',
    venueEnglish: cleanText(venue),
    venueId: stableVenueId(league, venue || 'TBD'),
    awayScore: officialScoresPresent ? awayScore : null,
    homeScore: officialScoresPresent ? homeScore : null,
    innings: Number.isFinite(Number(innings)) && Number(innings) > 0 ? Number(innings) : null,
    scheduleProvider: SOURCE_CONFIG[league].id,
    scheduleVersion: ASIAN_SCHEDULE_VERSION,
    analysisMode: ASIAN_ANALYSIS_MODE,
    betEligible: false,
  };
}

export function asianLeagueConfig(value) {
  const league = leagueId(value);
  const config = SOURCE_CONFIG[league];
  return {
    ...config,
    releaseReadiness: asianLeagueReleaseReadiness(league),
    featureContract: JSON.parse(JSON.stringify(config.featureContract)),
    rules: JSON.parse(JSON.stringify(config.rules)),
    modelConfig: {
      ...config.modelConfig,
      baselineBounds: { full: { ...config.modelConfig.baselineBounds.full }, first5: { ...config.modelConfig.baselineBounds.first5 } },
      scoreClamps: { full: { ...config.modelConfig.scoreClamps.full }, first5: { ...config.modelConfig.scoreClamps.first5 } },
      homeCoefficient: { ...config.modelConfig.homeCoefficient },
      shrink: { ...config.modelConfig.shrink },
    },
  };
}

export const asianAnalysisContract = asianLeagueConfig;

export function parseNpbScheduleHtml(html, date) {
  if (!validDate(date)) throw providerError('日期格式必須為 YYYY-MM-DD', 400, 'INVALID_BOARD_DATE');
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  $('.unit').each((index, element) => {
    const unit = $(element);
    const teams = unit.find('.team_name').map((_, node) => cleanText($(node).text())).get();
    if (teams.length < 2) return;
    // NPB's daily game card renders the home club on the left and the
    // visiting club on the right. Keep our normalized contract as away/home.
    const homeTeam = resolveTeam('NPB', teams[0]);
    const awayTeam = resolveTeam('NPB', teams[1]);
    if (!awayTeam || !homeTeam) return;
    const middleParts = unit.find('.round').html()?.split(/<br\s*\/?>/i).map(value => cleanText(cheerio.load(value).text())).filter(Boolean) || [];
    const time = middleParts.find(value => /^\d{1,2}:\d{2}$/.test(value)) || '18:00';
    const venue = middleParts.find(value => !/^\d{1,2}:\d{2}$/.test(value) && !/^Game\s+\d+/i.test(value)) || '';
    const gameNumber = Number(middleParts.join(' ').match(/Game\s+(\d+)/i)?.[1]) || 1;
    const homeScore = numericScore(unit.find('.score_left').first().text());
    const awayScore = numericScore(unit.find('.score_right').first().text());
    const href = unit.closest('a[href], .link_box').attr('href') || unit.find('a[href]').first().attr('href') || '';
    const sourceId = href.match(/\/(s\d+)\.html/i)?.[1] || `${date}|${awayTeam.code}|${homeTeam.code}|${time}|${gameNumber}`;
    const game = normalizedGame({ league: 'NPB', sourceId, date, time, awayTeam, homeTeam, venue, awayScore, homeScore, gameNumber });
    if (game) rows.push(game);
  });
  return uniqueGames(rows);
}

const NPB_LOGO_CODES = Object.freeze({
  g: 'YOM', t: 'HAN', db: 'YDB', c: 'HIR', s: 'YAK', d: 'CHU',
  h: 'SOF', f: 'NIP', m: 'LOM', e: 'RAK', b: 'ORI', l: 'SEI',
});

export function parseNpbProbableStartersHtml(html, expectedDate = '') {
  const $ = cheerio.load(String(html || ''));
  const heading = cleanText($('h4').first().text());
  const announced = heading.match(/(\d{1,2})月(\d{1,2})日/);
  if (expectedDate && announced) {
    const [, month, day] = expectedDate.match(/^\d{4}-(\d{2})-(\d{2})$/) || [];
    if (Number(month) !== Number(announced[1]) || Number(day) !== Number(announced[2])) return [];
  }
  const rows = [];
  $('.starting_wrap_cl .unit').each((_, element) => {
    const unit = $(element);
    const pitcher = side => {
      const node = unit.find(`.team_${side}`).first();
      const logo = String(node.find('img').attr('src') || '').match(/logo_([a-z]+)_/i)?.[1]?.toLowerCase();
      const code = NPB_LOGO_CODES[logo];
      const link = node.find('a[href*="/players/"]').first();
      const name = cleanText(link.text());
      const id = String(link.attr('href') || '').match(/\/players\/(\d+)\.html/i)?.[1] || null;
      return code && name ? { code, name, id, source: 'NPB_OFFICIAL_PROBABLE_STARTER' } : null;
    };
    // Official starter card is home-left, away-right.
    const home = pitcher('left');
    const away = pitcher('right');
    if (!home || !away) return;
    const time = cleanText(unit.find('.info').text()).match(/\d{1,2}:\d{2}/)?.[0] || '';
    rows.push({
      awayCode: away.code,
      homeCode: home.code,
      time,
      away: { name: away.name, id: away.id, source: away.source },
      home: { name: home.name, id: home.id, source: home.source },
    });
  });
  return rows;
}

export function parseNpbMonthHtml(html, year, month) {
  const normalizedYear = Number(year);
  const normalizedMonth = Number(month);
  if (!Number.isInteger(normalizedYear) || !Number.isInteger(normalizedMonth) || normalizedMonth < 1 || normalizedMonth > 12) return [];
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  $('.stschedule').each((_, cell) => {
    const day = Number(cleanText($(cell).find('.teschedate').first().text()));
    if (!Number.isInteger(day) || day < 1 || day > 31) return;
    const date = `${normalizedYear}-${String(normalizedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    $(cell).find('.stvsteam > div').each((index, element) => {
      const text = cleanText($(element).text());
      let match = text.match(/^([A-Z]+)\s+(\d+|\*)\s*-\s*(\d+|\*)\s+([A-Z]+)$/i);
      let awayAlias;
      let homeAlias;
      let awayScore = null;
      let homeScore = null;
      let time = '18:00';
      let status = '';
      if (match) {
        [, awayAlias, , , homeAlias] = match;
        awayScore = numericScore(match[2]);
        homeScore = numericScore(match[3]);
        status = awayScore == null || homeScore == null ? 'POSTPONED' : 'FINAL';
      } else {
        match = text.match(/^([A-Z]+)\s*-\s*([A-Z]+)\s+(\d{1,2}:\d{2})$/i);
        if (!match) return;
        [, awayAlias, homeAlias, time] = match;
      }
      const awayTeam = resolveTeam('NPB', awayAlias);
      const homeTeam = resolveTeam('NPB', homeAlias);
      if (!awayTeam || !homeTeam) return;
      const href = $(element).find('a[href]').attr('href') || '';
      const sourceId = href.match(/\/(s\d+)\.html/i)?.[1] || `${date}|${awayTeam.code}|${homeTeam.code}|${time}|${index + 1}`;
      const game = normalizedGame({ league: 'NPB', sourceId, date, time, awayTeam, homeTeam, status, awayScore, homeScore, gameNumber: 1 });
      if (game) rows.push(game);
    });
  });
  return uniqueGames(rows);
}

export function parseKboScheduleHtml(html, yearOrDate, monthValue) {
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(yearOrDate || ''));
  const year = fromDate ? Number(String(yearOrDate).slice(0, 4)) : Number(yearOrDate);
  const requestedMonth = fromDate ? Number(String(yearOrDate).slice(5, 7)) : Number(monthValue);
  if (!Number.isInteger(year) || !Number.isInteger(requestedMonth) || requestedMonth < 1 || requestedMonth > 12) return [];
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const matchupOccurrences = new Map();
  let currentDate = '';
  $('table tbody tr').each((_, element) => {
    const row = $(element);
    const dateText = cleanText(row.find('td[title="DATE"]').first().text());
    const dateMatch = dateText.match(/(\d{1,2})\.(\d{1,2})/);
    if (dateMatch) currentDate = `${year}-${dateMatch[1].padStart(2, '0')}-${dateMatch[2].padStart(2, '0')}`;
    if (!currentDate || Number(currentDate.slice(5, 7)) !== requestedMonth) return;
    const awayTeam = resolveTeam('KBO', row.find('td[title="GAME"].loop_r').first().text());
    const homeTeam = resolveTeam('KBO', row.find('td[title="GAME"].loop_l').first().text());
    if (!awayTeam || !homeTeam) return;
    const time = cleanText(row.find('td.TIME').first().text()) || '18:30';
    const scoreText = cleanText(row.find('.score_schedule').first().text());
    const scoreMatch = scoreText.match(/^(\d+)\s*:\s*(\d+)$/);
    const awayScore = scoreMatch ? Number(scoreMatch[1]) : null;
    const homeScore = scoreMatch ? Number(scoreMatch[2]) : null;
    const venue = cleanText(row.find('td.LOCATION').first().text());
    const status = cleanText(row.find('td.ETC').first().text());
    const matchupKey = `${currentDate}|${awayTeam.code}|${homeTeam.code}`;
    const gameNumber = (matchupOccurrences.get(matchupKey) || 0) + 1;
    matchupOccurrences.set(matchupKey, gameNumber);
    const sourceId = `${currentDate}|${awayTeam.code}|${homeTeam.code}|${time}|${venue}|${gameNumber}`;
    const game = normalizedGame({ league: 'KBO', sourceId, date: currentDate, time, awayTeam, homeTeam, venue, status, awayScore, homeScore, gameNumber });
    if (gameNumber > 1 && game) game.doubleHeader = 'Y';
    if (game) rows.push(game);
  });
  const games = uniqueGames(rows);
  return fromDate ? games.filter(game => game.officialDate === yearOrDate) : games;
}

export function parseKboOfficialSchedulePayload(payload, yearOrDate, monthValue) {
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(yearOrDate || ''));
  const year = fromDate ? Number(String(yearOrDate).slice(0, 4)) : Number(yearOrDate);
  const requestedMonth = fromDate ? Number(String(yearOrDate).slice(5, 7)) : Number(monthValue);
  if (!Number.isInteger(year) || !Number.isInteger(requestedMonth) || requestedMonth < 1 || requestedMonth > 12) return [];
  const rows = [];
  const matchupOccurrences = new Map();
  let currentDate = '';
  for (const raw of Array.isArray(payload?.rows) ? payload.rows : []) {
    const cells = Array.isArray(raw?.row) ? raw.row : [];
    const dateCell = cells.find(cell => cleanText(cell?.Class).toLowerCase() === 'day');
    const dateText = cleanText(cheerio.load(String(dateCell?.Text || '')).text());
    const dateMatch = dateText.match(/(\d{1,2})\.(\d{1,2})/);
    if (dateMatch) currentDate = `${year}-${dateMatch[1].padStart(2, '0')}-${dateMatch[2].padStart(2, '0')}`;
    if (!currentDate || Number(currentDate.slice(5, 7)) !== requestedMonth) continue;
    const timeCell = cells.find(cell => cleanText(cell?.Class).toLowerCase() === 'time');
    const playCell = cells.find(cell => cleanText(cell?.Class).toLowerCase() === 'play');
    if (!playCell) continue;
    const play = cheerio.load(String(playCell.Text || ''));
    const directTeams = play('body').children('span').map((_, node) => cleanText(play(node).text())).get();
    const awayTeam = resolveTeam('KBO', directTeams[0]);
    const homeTeam = resolveTeam('KBO', directTeams.at(-1));
    if (!awayTeam || !homeTeam) continue;
    // KBO renders scheduled games as `<span class="same">0</span> vs
    // <span class="same">0</span>`.  Those zeroes are placeholders, not a
    // real 0-0 score.  Only score spans carrying a result class are official
    // scores; otherwise the game must remain scheduled.
    const scoreValues = play('em span.win, em span.lose, em span.draw')
      .map((_, node) => cleanText(play(node).text()))
      .get()
      .filter(value => /^\d+$/.test(value));
    const awayScore = scoreValues.length >= 2 ? Number(scoreValues[0]) : null;
    const homeScore = scoreValues.length >= 2 ? Number(scoreValues.at(-1)) : null;
    const time = cleanText(cheerio.load(String(timeCell?.Text || '')).text()) || '18:30';
    const allHtml = cells.map(cell => String(cell?.Text || '')).join(' ');
    const officialGameId = allHtml.match(/[?&]gameId=([^&'"\s]+)/i)?.[1] || '';
    const playIndex = cells.indexOf(playCell);
    const venue = cleanText(cheerio.load(String(cells.at(-2)?.Text || '')).text());
    const rawStatus = cleanText(cheerio.load(String(cells.at(-1)?.Text || '')).text());
    const status = /취소|연기|중단|우천/.test(rawStatus) ? 'POSTPONED' : rawStatus;
    const matchupKey = `${currentDate}|${awayTeam.code}|${homeTeam.code}`;
    const gameNumber = (matchupOccurrences.get(matchupKey) || 0) + 1;
    matchupOccurrences.set(matchupKey, gameNumber);
    const sourceId = officialGameId || `${currentDate}|${awayTeam.code}|${homeTeam.code}|${time}|${venue}|${playIndex}|${gameNumber}`;
    const game = normalizedGame({ league: 'KBO', sourceId, date: currentDate, time, awayTeam, homeTeam, venue, status, awayScore, homeScore, gameNumber });
    if (gameNumber > 1 && game) game.doubleHeader = 'Y';
    if (game) rows.push(game);
  }
  const games = uniqueGames(rows);
  return fromDate ? games.filter(game => game.officialDate === yearOrDate) : games;
}

export function parseCpblSchedulePayload(payload, requestedDate = '') {
  const games = payload?.Data?.Games || payload?.data?.games || payload?.Data?.games || payload?.data?.Games || [];
  if (!Array.isArray(games)) return [];
  const rows = games.map(raw => {
    const sourceGameId = cleanText(raw?.GameId || raw?.gameId);
    const kindCode = cleanText(raw?.KindCode || raw?.kindCode).toUpperCase();
    if (kindCode ? kindCode !== 'A' : !/-A-/i.test(sourceGameId)) return null;
    const start = cleanText(raw?.PreExeDate || raw?.preExeDate || raw?.GameDate || raw?.gameDate);
    const date = /^\d{4}-\d{2}-\d{2}/.test(start) ? start.slice(0, 10) : requestedDate;
    if (!validDate(date)) return null;
    const time = start.match(/T(\d{2}:\d{2})/)?.[1] || '18:35';
    const awayRaw = raw?.Visiting || raw?.visiting || raw?.Away || raw?.away || {};
    const homeRaw = raw?.Home || raw?.home || {};
    const awayTeamRaw = awayRaw?.Team || awayRaw?.team || {};
    const homeTeamRaw = homeRaw?.Team || homeRaw?.team || {};
    const awayTeam = resolveTeam('CPBL', awayTeamRaw?.Code || awayTeamRaw?.code || awayTeamRaw?.Name || awayTeamRaw?.name);
    const homeTeam = resolveTeam('CPBL', homeTeamRaw?.Code || homeTeamRaw?.code || homeTeamRaw?.Name || homeTeamRaw?.name);
    if (!awayTeam || !homeTeam) return null;
    const rawStatus = cleanText(raw?.GameStatus || raw?.gameStatus || raw?.Status || raw?.status);
    const finalStatus = /FINISH|FINAL|COMPLETED|END/i.test(rawStatus);
    const awayScore = finalStatus ? numericScore(awayRaw?.Score ?? awayRaw?.score) : null;
    const homeScore = finalStatus ? numericScore(homeRaw?.Score ?? homeRaw?.score) : null;
    const venue = cleanText(raw?.Field?.Abbe || raw?.field?.abbe || raw?.Field?.Name || raw?.field?.name);
    const sourceId = sourceGameId || `${date}|A|${raw?.GameSno || raw?.gameSno || 1}`;
    return normalizedGame({
      league: 'CPBL', sourceId, date, time, awayTeam, homeTeam, venue, status: rawStatus,
      awayScore, homeScore, innings: raw?.InningSeq ?? raw?.inningSeq,
      gameNumber: Number(raw?.DoubleHeaderNo || raw?.doubleHeaderNo) || 1,
    });
  }).filter(Boolean);
  return uniqueGames(requestedDate ? rows.filter(game => game.officialDate === requestedDate) : rows);
}

export const parseCpblScheduleJson = parseCpblSchedulePayload;

function uniqueGames(rows) {
  const byPk = new Map();
  for (const game of rows) byPk.set(game.gamePk, game);
  return [...byPk.values()].sort((left, right) => (
    Date.parse(left.gameDate) - Date.parse(right.gameDate)
    || Number(left.gameNumber) - Number(right.gameNumber)
    || Number(left.gamePk) - Number(right.gamePk)
  ));
}

async function fetchResponse(url, { fetchImpl, timeoutMs, format, method = 'GET', body, headers = {} }) {
  if (typeof fetchImpl !== 'function') throw providerError('官方賽程讀取器不存在');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      cache: 'no-store',
      headers: { Accept: format === 'json' ? 'application/json' : 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT, ...headers },
      ...(body == null ? {} : { body }),
      signal: controller.signal,
    });
    if (!response?.ok) throw providerError(`官方賽程讀取失敗（${response?.status || 'network'}）`);
    return format === 'json' ? await response.json() : await response.text();
  } catch (error) {
    if (error?.code === 'ASIAN_PROVIDER_UNAVAILABLE') throw error;
    const timedOut = error?.name === 'AbortError' || controller.signal.aborted;
    throw providerError(timedOut ? '官方賽程讀取逾時' : '官方賽程目前無法讀取');
  } finally {
    clearTimeout(timer);
  }
}

function monthCoordinates(date, offset = 0) {
  const value = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + offset);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1 };
}

async function fetchNpbDay(date, options) {
  const compact = date.replaceAll('-', '');
  const url = `https://npb.jp/bis/eng/${date.slice(0, 4)}/games/gm${compact}.html`;
  const [scheduleHtml, startersHtml] = await Promise.all([
    fetchResponse(url, { ...options, format: 'text' }),
    fetchResponse('https://npb.jp/announcement/starter/', { ...options, format: 'text' }).catch(() => ''),
  ]);
  const starters = parseNpbProbableStartersHtml(startersHtml, date);
  return parseNpbScheduleHtml(scheduleHtml, date).map(game => {
    const row = starters.find(item => item.awayCode === game.awayCode && item.homeCode === game.homeCode);
    if (!row) return game;
    return {
      ...game,
      awayProbable: row.away.name,
      homeProbable: row.home.name,
      awayProbableId: row.away.id,
      homeProbableId: row.home.id,
      probableSource: 'NPB_OFFICIAL_PROBABLE_STARTER',
    };
  });
}

async function fetchNpbMonth(year, month, options) {
  const url = `https://npb.jp/bis/eng/${year}/calendar/index_${String(month).padStart(2, '0')}.html`;
  return parseNpbMonthHtml(await fetchResponse(url, { ...options, format: 'text' }), year, month);
}

async function fetchKboMonth(year, month, options) {
  const url = 'https://www.koreabaseball.com/ws/Schedule.asmx/GetScheduleList';
  const body = new URLSearchParams({
    leId: '1',
    srIdList: '0,9,6',
    seasonId: String(year),
    gameMonth: String(month).padStart(2, '0'),
    teamId: '',
  });
  const payload = await fetchResponse(url, {
    ...options,
    format: 'json',
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://www.koreabaseball.com/Schedule/Schedule.aspx',
    },
  });
  return parseKboOfficialSchedulePayload(payload, year, month);
}

async function fetchCpblDate(date, options) {
  const url = `https://stats.cpbl.com.tw/api/proxy/v1/games/schedule/${date}`;
  return parseCpblSchedulePayload(await fetchResponse(url, { ...options, format: 'json' }), date);
}

async function fetchCpblMonth(year, month, options) {
  const url = `https://stats.cpbl.com.tw/api/proxy/v1/games/schedule?kindCode=A&year=${year}&month=${month}`;
  return parseCpblSchedulePayload(await fetchResponse(url, { ...options, format: 'json' }));
}

export async function fetchAsianTaipeiSlate(value, date, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
} = {}) {
  const league = leagueId(value);
  if (!validDate(date)) throw providerError('日期格式必須為 YYYY-MM-DD', 400, 'INVALID_BOARD_DATE');
  const options = { fetchImpl, timeoutMs };
  if (league === 'NPB') return fetchNpbDay(date, options);
  if (league === 'KBO') {
    const { year, month } = monthCoordinates(date);
    return (await fetchKboMonth(year, month, options)).filter(game => game.officialDate === date);
  }
  return fetchCpblDate(date, options);
}

export const fetchAsianSchedule = fetchAsianTaipeiSlate;

async function fetchHistory(league, date, options) {
  if (Array.isArray(options.historyGames)) return options.historyGames;
  const months = [0, -1, -2].map(offset => monthCoordinates(date, offset));
  const requests = months.map(({ year, month }) => {
    if (league === 'NPB') return fetchNpbMonth(year, month, options);
    if (league === 'KBO') return fetchKboMonth(year, month, options);
    return fetchCpblMonth(year, month, options);
  });
  const settled = await Promise.allSettled(requests);
  // A partial three-month sample changes both the league baseline and each
  // team's run proxy. Never silently drop a failed month and present a new
  // score as if it came from the same model input.
  const failedMonths = settled
    .map((result, index) => result.status === 'rejected' ? months[index] : null)
    .filter(Boolean)
    .map(({ year, month }) => `${year}-${String(month).padStart(2, '0')}`);
  if (failedMonths.length) {
    throw providerError(`亞洲聯盟歷史比分快照不完整（${failedMonths.join('、')}）`, 503, 'ASIAN_HISTORY_INCOMPLETE');
  }
  return uniqueGames(settled.flatMap(result => result.value));
}

function completedBefore(games, gameDate) {
  const cutoff = Date.parse(gameDate || '');
  return (Array.isArray(games) ? games : []).filter(game => (
    Number.isFinite(cutoff)
    && Date.parse(game?.gameDate || '') < cutoff
    && Number.isFinite(Number(game?.awayScore))
    && Number.isFinite(Number(game?.homeScore))
    && String(game?.statusCode || '').toUpperCase() === 'F'
  ));
}

function teamGames(games, teamId) {
  return games.filter(game => Number(game.awayTeamId) === Number(teamId) || Number(game.homeTeamId) === Number(teamId));
}

function teamRunRows(games, teamId) {
  return teamGames(games, teamId).map(game => {
    const away = Number(game.awayTeamId) === Number(teamId);
    return {
      date: game.gameDate,
      scored: Number(away ? game.awayScore : game.homeScore),
      allowed: Number(away ? game.homeScore : game.awayScore),
      innings: Math.max(9, Number(game?.innings) || Number(game?.scheduledInnings) || 9),
    };
  }).filter(row => Number.isFinite(row.scored) && Number.isFinite(row.allowed));
}

function variance(values) {
  const rows = values.filter(Number.isFinite);
  if (rows.length < 2) return 0;
  const mean = rows.reduce((sum, value) => sum + value, 0) / rows.length;
  return rows.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (rows.length - 1);
}

function finiteNumber(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedThrows(value) {
  const text = cleanText(value).toUpperCase();
  return text === 'L' || text === 'R' ? text : null;
}

function pitTimestampReady(value, gameDate) {
  const asOf = Date.parse(value || '');
  const firstPitch = Date.parse(gameDate || '');
  return Number.isFinite(asOf) && Number.isFinite(firstPitch) && asOf <= firstPitch;
}

function isWholeTeamProxySource(value) {
  return /TEAM[_ -]?(?:SCORE|RUN|RESULT|RATE|PITCHING)|RECENT[_ -]?TEAM[_ -]?SCHEDULE|ROTATION[_ -]?SCENARIO/i.test(cleanText(value));
}

function hittingBlock(rows, baseline) {
  const count = rows.length;
  const runsPerGame = count ? rows.reduce((sum, row) => sum + row.scored, 0) / count : baseline;
  return {
    available: count > 0,
    gamesPlayed: count,
    runsPerGame,
    metricScope: 'TEAM_SCORE_HISTORY_PROXY',
    componentStatsAvailable: false,
    ops: null,
    avg: null,
    obp: null,
    slg: null,
    iso: null,
    kRate: null,
    bbRate: null,
  };
}

function pitchingBlock(rows, baseline) {
  const count = rows.length;
  const runsAllowed = count ? rows.reduce((sum, row) => sum + row.allowed, 0) / count : baseline;
  return {
    available: count > 0,
    gamesPlayed: count,
    inningsObserved: count * 9,
    runsAllowedPerGame: runsAllowed,
    metricScope: 'TEAM_SCORE_HISTORY_PROXY',
    individualPitcherStatsAvailable: false,
    pureReliefStatsAvailable: false,
    era: null,
    fip: null,
    whip: null,
    kMinusBB: null,
    hrPer9: null,
  };
}

function restBlock(rows, gameDate) {
  const previous = [...rows].sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0];
  const days = previous ? Math.max(0, Math.round((Date.parse(gameDate) - Date.parse(previous.date)) / 86_400_000)) : 1;
  return { available: Boolean(previous), days, travelKm: 0, previousExtraInnings: Number(previous?.innings || 9) > 9, dayNightTransition: false };
}

function projectedBullpen(rows, gameDate) {
  const cutoff = Date.parse(gameDate || '');
  const lastFourDays = rows.filter(row => {
    const difference = (cutoff - Date.parse(row.date || '')) / 86_400_000;
    return difference > 0 && difference <= 4;
  });
  const estimatedReliefInnings = lastFourDays.reduce((sum, row) => sum + Math.max(2.4, Number(row.innings || 9) - 5.2), 0);
  const backToBack = lastFourDays.filter(row => (cutoff - Date.parse(row.date || '')) / 86_400_000 <= 2).length;
  const fatigueIndex = Math.max(0.05, Math.min(0.95, estimatedReliefInnings / 18 + backToBack * 0.07));
  return {
    available: false,
    usageAvailable: false,
    pureRelief: false,
    projectionBased: true,
    status: 'TEAM_SCHEDULE_PROXY_ONLY',
    source: 'OFFICIAL_RECENT_TEAM_SCHEDULE_NON_RELIEF_PROXY',
    recentGameCount: lastFourDays.length,
    estimatedReliefInnings,
    fatigueIndex,
    highLeverageAvailability: Math.max(0.35, Math.min(0.92, 0.92 - fatigueIndex * 0.55)),
    qualityFactor: null,
    qualityScope: 'UNAVAILABLE',
  };
}

function normalizeTeamStrength(base, supplied) {
  const season = supplied?.seasonHitting || {};
  const recent = supplied?.recentHitting || {};
  const seasonGames = finiteNumber(season.gamesPlayed ?? supplied?.currentSeasonGames);
  const seasonRuns = finiteNumber(season.runsPerGame);
  const source = cleanText(supplied?.source);
  const ready = supplied?.available === true
    && cleanText(supplied?.metricScope).toUpperCase() === 'TEAM_STRENGTH_BASELINE'
    && source.length > 0
    && seasonGames >= 8
    && seasonRuns != null
    && cleanText(supplied?.baselineMethod).toUpperCase() !== 'RECENT_ONLY';
  if (!ready) return { ready: false, team: base };
  const seasonHitting = {
    ...base.seasonHitting,
    ...season,
    available: true,
    gamesPlayed: seasonGames,
    runsPerGame: seasonRuns,
    metricScope: 'TEAM_STRENGTH_BASELINE',
    componentStatsAvailable: [season.ops, season.iso, season.kRate, season.bbRate].some(value => finiteNumber(value) != null),
    source,
  };
  const recentHitting = {
    ...base.recentHitting,
    ...recent,
    available: finiteNumber(recent.gamesPlayed) > 0,
    metricScope: 'TEAM_RECENT_FORM',
    source,
  };
  return {
    ready: true,
    team: {
      ...base,
      seasonHitting,
      hitting: seasonHitting,
      recentHitting,
      teamStrength: {
        available: true,
        metricScope: 'TEAM_STRENGTH_BASELINE',
        baselineMethod: cleanText(supplied.baselineMethod),
        priorSeasonRegressed: supplied.priorSeasonRegressed === true,
        source,
      },
    },
  };
}

function identityMatchesProbable(probable, supplied, teamId) {
  if (!supplied?.identityConfirmed) return false;
  if (Number(supplied?.teamId) !== Number(teamId)) return false;
  if (!cleanText(probable?.source || supplied?.identitySource)) return false;
  const probableId = cleanText(probable?.id);
  const suppliedId = cleanText(supplied?.id);
  const probableName = cleanText(probable?.name).toUpperCase();
  const suppliedName = cleanText(supplied?.name).toUpperCase();
  if (probableId) return Boolean(suppliedId) && probableId === suppliedId;
  if (probableName) return Boolean(suppliedName) && probableName === suppliedName;
  return Boolean(suppliedId || suppliedName);
}

function normalizeStarter(base, supplied, probable, teamId) {
  const season = supplied?.season || {};
  const recent = supplied?.recent || {};
  const officialThrows = normalizedThrows(probable?.throws ?? supplied?.officialThrows);
  const reportedThrows = normalizedThrows(supplied?.throws ?? supplied?.handedness);
  const throws = officialThrows || reportedThrows;
  const handednessConflict = Boolean(officialThrows && reportedThrows && officialThrows !== reportedThrows);
  const individualScope = cleanText(supplied?.performanceScope).toUpperCase() === 'INDIVIDUAL_STARTER';
  const performanceSource = cleanText(supplied?.performanceSource);
  const independent = supplied?.independentOfTeamResults === true
    && supplied?.projectedFromTeamPitching !== true
    && !isWholeTeamProxySource(performanceSource);
  const identityReady = identityMatchesProbable(probable, supplied, teamId);
  const performanceReady = supplied?.performanceAvailable === true
    && individualScope
    && independent
    && performanceSource.length > 0
    && finiteNumber(season.inningsPitched) > 0
    && finiteNumber(season.gamesStarted) > 0
    && finiteNumber(season.era) != null
    && [season.fip, season.whip].some(value => finiteNumber(value) != null)
    && finiteNumber(supplied?.expectedInnings) > 0;
  const ready = identityReady && performanceReady && Boolean(throws);
  if (!ready) return {
    ready: false,
    identityReady,
    performanceReady,
    handednessReady: Boolean(throws),
    starter: {
      ...base,
      id: supplied?.id || base.id,
      name: supplied?.name || base.name,
      identityConfirmed: identityReady || base.identityConfirmed,
      identityMismatch: Boolean(supplied?.identityConfirmed) && !identityReady,
      suppliedPerformanceRejected: Boolean(supplied?.performanceAvailable) && !performanceReady,
      throws,
      handedness: throws,
      handednessConflict,
      handednessResolution: handednessConflict ? 'OFFICIAL_SOURCE_WINS' : null,
    },
  };
  const starter = {
    ...base,
    ...supplied,
    available: true,
    confirmed: true,
    identityConfirmed: true,
    identityMismatch: false,
    performanceAvailable: true,
    performanceStatus: 'CONFIRMED_INDIVIDUAL_STARTER',
    performanceScope: 'INDIVIDUAL_STARTER',
    independentOfTeamResults: true,
    projectedFromTeamPitching: false,
    projectionMode: 'VERIFIED_INDIVIDUAL_STARTER_PERFORMANCE',
    throws,
    handedness: throws,
    throwsStatus: 'CONFIRMED',
    handednessConflict,
    handednessResolution: handednessConflict ? 'OFFICIAL_SOURCE_WINS' : null,
    expectedInnings: Number(supplied.expectedInnings),
    season: { ...season, available: true, metricScope: 'INDIVIDUAL_STARTER' },
    recent: { ...recent, available: finiteNumber(recent.inningsPitched) > 0, metricScope: 'INDIVIDUAL_STARTER' },
    era: finiteNumber(season.era),
    fip: finiteNumber(season.fip),
    whip: finiteNumber(season.whip),
    source: performanceSource,
  };
  return { ready: true, identityReady: true, performanceReady: true, handednessReady: true, starter };
}

function normalizeLineup(base, supplied) {
  const players = Array.isArray(supplied?.players) ? supplied.players.filter(Boolean) : [];
  const scenarioPlayers = (Array.isArray(supplied?.scenarios) ? supplied.scenarios : [])
    .flatMap(scenario => Array.isArray(scenario?.players) ? scenario.players : [])
    .filter(Boolean);
  const hasPlayers = players.length > 0 || scenarioPlayers.length > 0;
  const modeReady = supplied?.official === true || supplied?.projected === true;
  const ready = supplied?.available === true
    && supplied?.credibleScenario === true
    && modeReady
    && hasPlayers
    && cleanText(supplied?.source).length > 0
    && finiteNumber(supplied?.offensiveIndex) != null;
  return {
    ready,
    lineup: ready ? {
      ...base,
      ...supplied,
      available: true,
      players,
      status: supplied.official === true ? 'CONFIRMED' : 'PROJECTED_SCENARIO',
      emptyLineup: false,
    } : {
      ...base,
      official: false,
      projected: false,
      emptyLineup: true,
      rejectedReason: hasPlayers ? 'LINEUP_SCENARIO_NOT_CREDIBLE' : 'EMPTY_LINEUP',
    },
  };
}

function normalizeBullpen(base, supplied) {
  const source = cleanText(supplied?.source);
  const ready = supplied?.available === true
    && supplied?.pureRelief === true
    && supplied?.usageAvailable === true
    && cleanText(supplied?.qualityScope).toUpperCase() === 'PURE_RELIEF'
    && source.length > 0
    && !isWholeTeamProxySource(source)
    && finiteNumber(supplied?.qualityFactor) != null
    && finiteNumber(supplied?.fatigueIndex) != null
    && finiteNumber(supplied?.highLeverageAvailability) != null;
  return {
    ready,
    bullpen: ready ? {
      ...base,
      ...supplied,
      available: true,
      pureRelief: true,
      projectionBased: supplied?.projectionBased === true,
      status: supplied?.projectionBased === true ? 'PROJECTED_PURE_RELIEF' : 'CONFIRMED_PURE_RELIEF',
      teamRunsAllowedProxyUsed: false,
    } : {
      ...base,
      available: false,
      usageAvailable: false,
      pureRelief: false,
      teamRunsAllowedProxyUsed: false,
    },
  };
}

function normalizePark(game, supplied) {
  const runFactor = finiteNumber(supplied?.runFactor);
  const ready = supplied?.available === true
    && supplied?.recognized === true
    && supplied?.isNeutralPlaceholder !== true
    && runFactor != null
    && runFactor > 0
    && cleanText(supplied?.source).length > 0
    && cleanText(supplied?.factorMethod).length > 0;
  return {
    ready,
    park: ready ? {
      ...supplied,
      available: true,
      recognized: true,
      runFactor,
      name: cleanText(supplied.name || game?.venue || '場地待確認'),
      nameEnglish: cleanText(supplied.nameEnglish || game?.venueEnglish),
      isNeutralPlaceholder: false,
    } : {
      available: false,
      recognized: false,
      runFactor: 1,
      roof: 'unknown',
      roofConfirmed: false,
      name: game?.venue || '場地待確認',
      nameEnglish: game?.venueEnglish || '',
      source: 'NEUTRAL_PLACEHOLDER_NOT_MODEL_ELIGIBLE',
      factorMethod: 'UNAVAILABLE',
      isNeutralPlaceholder: true,
    },
  };
}

const NPB_CENTRAL = new Set(['YOM', 'HAN', 'YDB', 'HIR', 'YAK', 'CHU']);
const NPB_PACIFIC = new Set(['SOF', 'NIP', 'LOM', 'RAK', 'ORI', 'SEI']);

function npbRuleState(game) {
  const awayCode = cleanText(game?.awayCode).toUpperCase();
  const homeCode = cleanText(game?.homeCode).toUpperCase();
  const awayLeague = NPB_CENTRAL.has(awayCode) ? 'CENTRAL' : NPB_PACIFIC.has(awayCode) ? 'PACIFIC' : '';
  const homeLeague = NPB_CENTRAL.has(homeCode) ? 'CENTRAL' : NPB_PACIFIC.has(homeCode) ? 'PACIFIC' : '';
  const ready = Boolean(awayLeague && homeLeague);
  return {
    ready,
    status: ready ? 'RESOLVED' : 'UNRESOLVED',
    awayLeague: awayLeague || null,
    homeLeague: homeLeague || null,
    interleague: ready ? awayLeague !== homeLeague : null,
    designatedHitter: ready ? homeLeague === 'PACIFIC' : null,
    resolution: ready ? 'NPB_LEAGUE_AND_HOME_VENUE_RULE' : 'TEAM_LEAGUE_UNKNOWN',
  };
}

function kboRuleState(game, features, park) {
  const secondGame = Number(game?.gameNumber || 1) > 1;
  const doubleheaderReady = !secondGame || features?.rules?.doubleheader?.secondGameBullpenRecomputed === true;
  const dome = park.ready && (park.park.dome === true || ['DOME', 'CLOSED'].includes(cleanText(park.park.roof).toUpperCase())) && park.park.roofConfirmed === true;
  const weather = features?.weather || {};
  const weatherReady = dome || (
    (weather.available === true || weather.scenarioAvailable === true)
    && cleanText(weather.source).length > 0
  );
  return {
    ready: doubleheaderReady && weatherReady,
    doubleheader: {
      ready: doubleheaderReady,
      secondGame,
      gameNumber: Number(game?.gameNumber || 1),
      bullpenRecomputed: secondGame ? features?.rules?.doubleheader?.secondGameBullpenRecomputed === true : true,
    },
    weather: {
      ready: weatherReady,
      domeBypass: dome,
      status: dome ? 'RECOGNIZED_DOME' : weatherReady ? 'FORECAST_OR_SCENARIO' : 'MISSING',
    },
  };
}

function cpblRuleState(features) {
  const foreign = features?.rules?.foreignPlayerConstraint || {};
  const status = cleanText(foreign.status).toUpperCase();
  const sourced = cleanText(foreign.source).length > 0;
  const modeled = status === 'MODELED'
    && sourced
    && (foreign.applies !== true || (
      foreign.pitcherExitLineupTransitionModeled === true
      && foreign.first5FullDifferentiated === true
    ));
  const ready = (status === 'NOT_APPLICABLE' && sourced) || modeled;
  return {
    ready,
    foreignPlayerConstraint: {
      status: ready ? status : 'UNRESOLVED',
      applies: foreign.applies === true,
      pitcherExitLineupTransitionModeled: foreign.pitcherExitLineupTransitionModeled === true,
      first5FullDifferentiated: foreign.first5FullDifferentiated === true,
      source: cleanText(foreign.source),
    },
  };
}

function teamContext(history, teamId, baseline, gameDate, modelConfig, probable = {}, supplied = {}) {
  const seasonRows = teamRunRows(history, teamId);
  const recentRows = [...seasonRows].sort((left, right) => Date.parse(right.date) - Date.parse(left.date)).slice(0, 10);
  const seasonHitting = hittingBlock(seasonRows, baseline);
  const seasonPitching = pitchingBlock(seasonRows, baseline);
  const recentHitting = hittingBlock(recentRows, baseline);
  const recentPitching = pitchingBlock(recentRows, baseline);
  const rest = restBlock(seasonRows, gameDate);
  const scheduleWorkloadProxy = projectedBullpen(seasonRows, gameDate);
  const base = {
    seasonHitting,
    seasonPitching,
    hitting: seasonHitting,
    pitching: seasonPitching,
    recentHitting,
    recentPitching,
    vsLeft: { ...hittingBlock(seasonRows, baseline), available: false },
    vsRight: { ...hittingBlock(seasonRows, baseline), available: false },
    starter: {
      available: false,
      confirmed: false,
      identityConfirmed: Boolean(probable?.name),
      performanceAvailable: false,
      performanceStatus: 'MISSING_INDIVIDUAL_STARTER_PERFORMANCE',
      performanceScope: 'UNAVAILABLE',
      id: probable?.id || null,
      name: probable?.name || '',
      handedness: null,
      throws: null,
      throwsStatus: 'MISSING',
      expectedInnings: null,
      inningsPitched: null,
      gamesStarted: null,
      era: null,
      fip: null,
      whip: null,
      season: { available: false, metricScope: 'INDIVIDUAL_STARTER', inningsPitched: null, gamesStarted: null, era: null, fip: null, whip: null, kMinusBB: null, hrPer9: null },
      recent: { available: false, metricScope: 'INDIVIDUAL_STARTER', inningsPitched: null, gamesStarted: null, era: null, fip: null, whip: null, kMinusBB: null, hrPer9: null },
      pitchQuality: { available: false, runFactor: 1 },
      projectedFromTeamPitching: false,
      projectionMode: probable?.name ? 'IDENTITY_ONLY_PERFORMANCE_MISSING' : 'STARTER_IDENTITY_AND_PERFORMANCE_MISSING',
      source: probable?.source || 'UNAVAILABLE',
    },
    lineup: { available: false, official: false, projected: false, credibleScenario: false, handednessAdjusted: false, offensiveIndex: 1, catcher: null, players: [], sampleGames: seasonRows.length, status: 'MISSING', source: 'EMPTY_LINEUP_PLACEHOLDER_NOT_MODEL_ELIGIBLE', emptyLineup: true },
    bullpen: scheduleWorkloadProxy,
    scheduleWorkloadProxy,
    scoring: { games: seasonRows.length, varianceRuns: variance(seasonRows.map(row => row.scored)) },
    defense: { available: false },
    baserunning: { runIndex: 1 },
    rest,
    injuriesAvailable: false,
    injuries: [],
    injuryImpact: 0,
  };
  const strength = normalizeTeamStrength(base, supplied?.teamStrength);
  const starter = normalizeStarter(strength.team.starter, supplied?.starter, probable, teamId);
  const lineup = normalizeLineup(strength.team.lineup, supplied?.lineup);
  const bullpen = normalizeBullpen(strength.team.bullpen, supplied?.bullpen);
  return {
    ...strength.team,
    starter: starter.starter,
    lineup: lineup.lineup,
    bullpen: bullpen.bullpen,
    upstreamReadiness: {
      teamStrength: strength.ready,
      starterIdentity: starter.identityReady,
      starterPerformance: starter.performanceReady,
      starterHandedness: starter.handednessReady,
      lineup: lineup.ready,
      bullpen: bullpen.ready,
    },
  };
}

export async function buildAsianGameContext(value, game, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  historyGames,
  featureSnapshot,
  upstreamFeatures,
} = {}) {
  const leagueId = leagueIdForGame(value, game);
  const config = asianLeagueConfig(leagueId);
  const features = featureSnapshot || upstreamFeatures || {};
  const history = completedBefore(await fetchHistory(leagueId, game?.officialDate || game?.taipeiDate || game?.gameDate?.slice(0, 10), {
    fetchImpl, timeoutMs, historyGames,
  }), game?.gameDate);
  const leagueRuns = history.length
    ? history.reduce((sum, row) => sum + Number(row.awayScore) + Number(row.homeScore), 0) / (history.length * 2)
    : config.baselineRuns;
  const baseline = Math.max(config.modelConfig.baselineBounds.full.min, Math.min(config.modelConfig.baselineBounds.full.max, leagueRuns));
  const away = teamContext(history, game.awayTeamId, baseline, game.gameDate, config.modelConfig, {
    id: game.awayProbableId, name: game.awayProbable, source: game.probableSource, throws: game.awayProbableThrows,
  }, features?.away);
  const home = teamContext(history, game.homeTeamId, baseline, game.gameDate, config.modelConfig, {
    id: game.homeProbableId, name: game.homeProbable, source: game.probableSource, throws: game.homeProbableThrows,
  }, features?.home);
  const parkState = normalizePark(game, features?.park);
  const npbRules = leagueId === 'NPB' ? npbRuleState(game) : null;
  const kboRules = leagueId === 'KBO' ? kboRuleState(game, features, parkState) : null;
  const cpblRules = leagueId === 'CPBL' ? cpblRuleState(features) : null;
  const minimumTeamSample = Math.min(away.seasonHitting.gamesPlayed, home.seasonHitting.gamesPlayed);
  // Empirical-Bayes reliability: official recent team results remain useful,
  // but 8-60 games cannot carry the same weight as a full independently
  // validated season. This shrinks team deltas toward the league environment
  // without using the Tai888 price and without clipping EV after calculation.
  const asianPriorGames = 120;
  const sampleReliability = minimumTeamSample / (minimumTeamSample + asianPriorGames);
  const effectiveModelConfig = {
    ...config.modelConfig,
    shrink: {
      full: config.modelConfig.shrink.full * sampleReliability,
      first5: config.modelConfig.shrink.first5 * sampleReliability * 0.85,
    },
  };
  const scheduleReady = Boolean(game?.gamePk && game?.awayTeamId && game?.homeTeamId);
  const historyReady = history.length > 0;
  const snapshotReady = pitTimestampReady(features?.asOf, game?.gameDate);
  const both = key => away.upstreamReadiness[key] === true && home.upstreamReadiness[key] === true;
  const rows = [
    { name: 'officialScheduleIdentity', ready: scheduleReady, status: scheduleReady ? 'CONFIRMED' : 'MISSING', core: true },
    { name: 'leagueRunEnvironment', ready: historyReady, status: historyReady ? 'CONFIRMED' : 'MISSING', core: true },
    { name: 'pointInTimeFeatureSnapshot', ready: snapshotReady, status: snapshotReady ? 'CONFIRMED' : 'MISSING', core: true },
    { name: 'teamStrengthBaseline', ready: both('teamStrength'), status: both('teamStrength') ? 'CONFIRMED' : 'MISSING', core: true },
    { name: 'starterIdentityAndIndependentPerformance', ready: both('starterIdentity') && both('starterPerformance'), status: both('starterIdentity') && both('starterPerformance') ? 'CONFIRMED' : 'MISSING', core: true },
    ...(leagueId === 'KBO' ? [{ name: 'officialStarterHandedness', ready: both('starterHandedness'), status: both('starterHandedness') ? 'CONFIRMED' : 'MISSING', core: true }] : []),
    { name: 'credibleLineupScenario', ready: both('lineup'), status: both('lineup') ? (away.lineup.official && home.lineup.official ? 'CONFIRMED' : 'PROJECTED') : 'MISSING', core: true },
    { name: 'pureReliefBullpen', ready: both('bullpen'), status: both('bullpen') ? (away.bullpen.projectionBased || home.bullpen.projectionBased ? 'PROJECTED' : 'CONFIRMED') : 'MISSING', core: true },
    { name: 'recognizedVenueParkFactor', ready: parkState.ready, status: parkState.ready ? 'CONFIRMED' : 'MISSING', core: true },
    ...(leagueId === 'NPB' ? [{ name: 'npbDhAndInterleagueRuleState', ready: npbRules.ready, status: npbRules.ready ? 'CONFIRMED' : 'MISSING', core: true }] : []),
    ...(leagueId === 'KBO' ? [
      { name: 'kboWeatherOrDomeScenario', ready: kboRules.weather.ready, status: kboRules.weather.ready ? (kboRules.weather.domeBypass ? 'CONFIRMED' : 'PROJECTED') : 'MISSING', core: true },
      { name: 'kboDoubleheaderState', ready: kboRules.doubleheader.ready, status: kboRules.doubleheader.ready ? 'CONFIRMED' : 'MISSING', core: true },
    ] : []),
    ...(leagueId === 'CPBL' ? [{ name: 'cpblForeignPlayerConstraintState', ready: cpblRules.ready, status: cpblRules.ready ? 'CONFIRMED' : 'MISSING', core: true }] : []),
    { name: 'ninthInningWalkoffAndDrawRules', ready: true, status: 'CONFIRMED', core: true },
  ];
  const blocking = rows.filter(row => row.core && !row.ready).map(row => row.name);
  const blockerDetails = asianFeatureBlockerDetails(leagueId, blocking);
  const coreReady = blocking.length === 0;
  const dataGateV10 = {
    version: 'ASIAN-CORE-UPSTREAM-GATE-2026-08-v2.1.0',
    featureContractVersion: config.featureContract.version,
    rows: rows.map(row => ({ ...row })),
    missing: rows.filter(row => !row.ready).map(row => row.name),
    projected: rows.filter(row => row.ready && row.status === 'PROJECTED').map(row => row.name),
    blocking,
    blockerDetails,
    passedForShadowScore: coreReady,
    passedForFormalScore: false,
    numericScoreEligible: coreReady,
    failClosed: true,
    quality: coreReady ? 0.72 : 0.35,
    modelErrorMarginEV: coreReady ? 0.040 : 0.070,
  };
  const warnings = [
    'EXPERIMENTAL_SHADOW｜亞洲聯盟尚未完成跨球季正式校準，所有分數不可下注',
    '官方賽程與整隊完賽比分只能建立聯盟環境與近期球隊代理；不得冒充個別先發、純牛棚、打線或球場能力',
    ...(coreReady ? [] : [`CORE_DATA_BLOCKED｜不產生數字影子分數｜缺少：${blocking.join('、')}`]),
  ];
  const starterIdentityConfirmed = away.starter.identityConfirmed && home.starter.identityConfirmed;
  const starterPerformanceConfirmed = both('starterPerformance');
  const leagueRuleState = leagueId === 'NPB' ? { npb: npbRules } : leagueId === 'KBO' ? { kbo: kboRules } : { cpbl: cpblRules };
  return {
    game: { ...game, league: leagueId, leagueId, analysisMode: ASIAN_ANALYSIS_MODE, betEligible: false },
    leagueId,
    analysisMode: ASIAN_ANALYSIS_MODE,
    executable: false,
    betEligible: false,
    modelVersion: config.modelVersion,
    rulesVersion: config.rulesVersion,
    modelConfig: effectiveModelConfig,
    dataGateV10,
    analysisReadiness: {
      version: ASIAN_LEAGUE_READINESS_VERSION,
      leagueId,
      status: coreReady ? 'BLOCKED_ENGINE_UNRELEASED' : 'BLOCKED_UPSTREAM_AND_ENGINE',
      coreInputsReady: coreReady,
      distributionEngineReady: false,
      canCalculateModelEvW: false,
      canCalculateRobustEvR: false,
      mlbFallbackAllowed: false,
      tai888ProbabilityInputAllowed: false,
      blockers: [...blockerDetails, asianDistributionEngineBlocker(leagueId)],
    },
    dataQuality: dataGateV10.quality,
    modelErrorMarginEV: dataGateV10.modelErrorMarginEV,
    provider: {
      id: config.id,
      leagueId,
      analysisMode: ASIAN_ANALYSIS_MODE,
      executable: false,
      betEligible: false,
      mlbFallbackAllowed: false,
      featureContractVersion: config.featureContract.version,
    },
    featureContract: config.featureContract,
    leagueRules: config.rules,
    leagueRuleState,
    league: { id: leagueId, available: historyReady, runsPerTeamGame: baseline, source: `${config.label} 近期官方完賽比分環境（不是球員能力資料）` },
    away,
    home,
    weather: features?.weather?.available === true || features?.weather?.scenarioAvailable === true
      ? { ...features.weather }
      : { available: false, scenarioAvailable: false, roofClosedProbability: null, roofConfirmed: false, source: 'UNAVAILABLE' },
    park: parkState.park,
    umpire: {},
    warnings,
    featureProvenance: [
      { feature: '聯盟得分基準', status: history.length ? '已確認' : '預估', source: `${config.label} 官方完賽比分` },
      { feature: '球隊近期比分代理', status: historyReady ? '僅供環境／近期型態' : '缺失', source: `${config.label} 官方近期完賽比分；禁止轉成個別投手或牛棚ERA` },
      { feature: '球隊能力基準', status: both('teamStrength') ? '已確認' : '缺失', source: both('teamStrength') ? `${away.teamStrength.source}／${home.teamStrength.source}` : '需要當季／回歸先驗獨立資料' },
      { feature: '先發身分', status: starterIdentityConfirmed ? '已確認' : '缺失', source: starterIdentityConfirmed ? (game.probableSource || away.starter.source || home.starter.source) : '官方或經驗證先發來源' },
      { feature: '先發能力', status: starterPerformanceConfirmed ? '已確認' : '缺失', source: starterPerformanceConfirmed ? `${away.starter.source}／${home.starter.source}` : '不可使用整隊失分率代替' },
      { feature: '打線', status: both('lineup') ? (away.lineup.official && home.lineup.official ? '已確認' : '可信情境') : '缺失', source: both('lineup') ? `${away.lineup.source}／${home.lineup.source}` : '空打線不具模型資格' },
      { feature: '牛棚', status: both('bullpen') ? '純救援資料' : '缺失', source: both('bullpen') ? `${away.bullpen.source}／${home.bullpen.source}` : '整隊近期失分與推估救援局數不具牛棚資格' },
      { feature: '球場', status: parkState.ready ? '已確認' : '缺失', source: parkState.park.source },
      { feature: '天氣／主審', status: features?.weather?.available || features?.weather?.scenarioAvailable ? '已建模' : '未知', source: features?.weather?.source || '未提供' },
    ],
    coreModelable: coreReady,
    coreTeamData: historyReady && both('teamStrength'),
    coreStarterData: starterPerformanceConfirmed,
    starterModelingMode: starterPerformanceConfirmed
      ? 'VERIFIED_INDIVIDUAL_STARTER_PERFORMANCE'
      : starterIdentityConfirmed ? 'IDENTITY_ONLY_CORE_PERFORMANCE_BLOCKED' : 'STARTER_CORE_DATA_BLOCKED',
    sourceStatuses: {
      starterIdentity: starterIdentityConfirmed ? 'CONFIRMED' : 'MISSING',
      starters: starterPerformanceConfirmed ? 'CONFIRMED_INDIVIDUAL' : 'MISSING_INDIVIDUAL_PERFORMANCE',
      lineups: both('lineup') ? (away.lineup.official && home.lineup.official ? 'CONFIRMED' : 'PROJECTED_SCENARIO') : 'MISSING',
      bullpen: both('bullpen') ? 'PURE_RELIEF' : 'MISSING_PURE_RELIEF',
      park: parkState.ready ? 'RECOGNIZED' : 'MISSING_RECOGNIZED_FACTOR',
    },
    asianCalibration: {
      version: 'ASIAN-EMPIRICAL-BAYES-NO-DOUBLE-COUNT-v1.0.0',
      minimumTeamSample,
      priorGames: asianPriorGames,
      sampleReliability,
      effectiveShrink: effectiveModelConfig.shrink,
      tai888UsedAsModelInput: false,
      calibrationStatus: 'UNVALIDATED_SHADOW',
    },
    gameStateModel: {
      regulationInnings: config.rules.regulationInnings,
      bottomNinthMayBeSkipped: config.rules.bottomNinthMayBeSkipped,
      regulationWalkoff: config.rules.regulationWalkoff,
      extraInningsLimit: config.rules.extraInningsLimit,
      allowDraw: config.rules.allowDraw,
      automaticRunner: config.rules.automaticRunner === true,
    },
    asianProxyAudit: {
      version: 'ASIAN-TEAM-SCORE-PROXY-AUDIT-v1.0.0',
      teamScoreHistoryAllowedUses: ['leagueRunEnvironment', 'teamRecentFormDiagnostic'],
      forbiddenUses: ['individualStarterERA', 'individualStarterFIP', 'individualStarterWHIP', 'pureReliefBullpenQuality', 'lineupCompletion', 'parkCompletion'],
      teamRunsUsedAsStarterPerformance: false,
      teamRunsUsedAsPureBullpenQuality: false,
      emptyLineupQualified: false,
      neutralParkQualified: false,
      tai888UsedAsModelInput: false,
      mlbFallbackUsed: false,
    },
    featureSnapshotAsOf: snapshotReady ? features.asOf : null,
    historyGameCount: history.length,
    scheduleVersion: ASIAN_SCHEDULE_VERSION,
    contextVersion: ASIAN_CONTEXT_VERSION,
    fetchedAt: new Date().toISOString(),
  };
}

function leagueIdForGame(value, game) {
  const requested = leagueId(value);
  const embedded = String(game?.leagueId || game?.league || '').trim().toUpperCase();
  if (embedded && embedded !== requested) throw providerError('賽事聯盟識別不一致', 409, 'OFFICIAL_IDENTITY_MISMATCH');
  return requested;
}

export async function fetchAsianFinalResult(value, gamePk, date, options = {}) {
  const league = leagueId(value);
  if (!validDate(date)) throw providerError('亞洲聯盟賽果查詢必須提供 YYYY-MM-DD 日期', 400, 'RESULT_DATE_REQUIRED');
  const id = Number(gamePk);
  if (!Number.isSafeInteger(id) || id <= 0) throw providerError('缺少或無效的 gamePk', 400, 'INVALID_GAME_PK');
  const games = await fetchAsianTaipeiSlate(league, date, options);
  const game = games.find(row => Number(row.gamePk) === id);
  if (!game) throw providerError('官方賽程找不到指定場次', 404, 'OFFICIAL_GAME_NOT_FOUND');
  return normalizeAsianFinalResult(league, id, date, game);
}

function officialFinalScore(value) {
  const score = Number(value);
  return Number.isSafeInteger(score) && score >= 0 ? score : null;
}

export function normalizeAsianFinalResult(value, gamePk, date, game) {
  const league = leagueIdForGame(value, game);
  if (!validDate(date)) throw providerError('亞洲聯盟賽果查詢必須提供 YYYY-MM-DD 日期', 400, 'RESULT_DATE_REQUIRED');
  const id = Number(gamePk);
  if (!Number.isSafeInteger(id) || id <= 0) throw providerError('缺少或無效的 gamePk', 400, 'INVALID_GAME_PK');
  if (!game || Number(game.gamePk) !== id) throw providerError('官方賽果場次識別不一致', 409, 'OFFICIAL_IDENTITY_MISMATCH');

  const officialDate = cleanText(game.officialDate || game.taipeiDate);
  const gameNumber = Number(game.gameNumber || 1);
  const awayTeamId = Number(game.awayTeamId);
  const homeTeamId = Number(game.homeTeamId);
  const away = cleanText(game.away);
  const home = cleanText(game.home);
  const provider = cleanText(game.scheduleProvider || SOURCE_CONFIG[league].id);
  const providerGameId = cleanText(game.providerGameId);
  if (officialDate !== date || !Number.isSafeInteger(gameNumber) || gameNumber <= 0
    || !Number.isSafeInteger(awayTeamId) || awayTeamId <= 0
    || !Number.isSafeInteger(homeTeamId) || homeTeamId <= 0 || awayTeamId === homeTeamId
    || !away || !home || !provider || !providerGameId) {
    throw providerError('亞洲聯盟官方賽果缺少日期、雙重賽、球隊或來源身分', 502, 'OFFICIAL_FINAL_RESULT_INVALID');
  }

  const finalState = String(game.statusCode || '').toUpperCase() === 'F';
  const awayScore = officialFinalScore(game.awayScore);
  const homeScore = officialFinalScore(game.homeScore);
  if (finalState && (awayScore == null || homeScore == null)) {
    throw providerError('亞洲聯盟官方狀態為完賽但終場比分不完整', 502, 'OFFICIAL_FINAL_RESULT_INVALID');
  }

  const innings = Number(game.innings);
  const normalizedInnings = Number.isSafeInteger(innings) && innings > 0 ? innings : null;
  if (finalState) {
    const rules = SOURCE_CONFIG[league].rules;
    if (normalizedInnings == null || normalizedInnings < Number(rules.regulationInnings || 9)) {
      throw providerError(`${league} 完賽局數缺失或短於正式局數，禁止自動結算`, 502, 'OFFICIAL_FINAL_RESULT_INVALID');
    }
    const extraLimit = Number(rules.extraInningsLimit);
    if (Number.isSafeInteger(extraLimit) && normalizedInnings > extraLimit) {
      throw providerError(`${league} 完賽局數超出已發布規則版本，禁止自動結算`, 502, 'OFFICIAL_FINAL_RESULT_INVALID');
    }
    if (awayScore === homeScore) {
      if (rules.allowDraw !== true || (Number.isSafeInteger(extraLimit) && normalizedInnings !== extraLimit)) {
        throw providerError(`${league} 和局局數不符合已發布規則版本，禁止自動結算`, 502, 'OFFICIAL_FINAL_RESULT_INVALID');
      }
    }
  }

  return {
    league,
    gamePk: id,
    gameNumber,
    officialDate,
    awayTeamId,
    homeTeamId,
    away,
    home,
    final: finalState,
    awayRuns: finalState ? awayScore : null,
    homeRuns: finalState ? homeScore : null,
    awayFirst5: null,
    homeFirst5: null,
    innings: normalizedInnings,
    first5Complete: false,
    status: game.status,
    statusEnglish: game.statusEnglish,
    provider,
    providerRevision: game.observedAt || game.updatedAt || null,
    sourceRecord: `${provider}:${providerGameId}:${officialDate}`,
    providerGameId,
    game,
  };
}
