import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { resolveLeagueTeamId } from './league-teams.js';

export const ASIAN_BASEBALL_VERSION = 'ASIAN-BASEBALL-OFFICIAL-PROVIDERS-2026-08-v1.0.0';
export const ASIAN_SCHEDULE_VERSION = 'ASIAN-OFFICIAL-SCHEDULE-2026-08-v1.0.0';
export const ASIAN_CONTEXT_VERSION = 'ASIAN-SHADOW-CONTEXT-2026-08-v1.0.0';
export const ASIAN_ANALYSIS_MODE = 'EXPERIMENTAL_SHADOW';

const ASIAN_LEAGUES = new Set(['NPB', 'KBO', 'CPBL']);
const USER_AGENT = 'Baseball-Positive-EV/9.6.0 (+official-schedule-only)';

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

const SOURCE_CONFIG = Object.freeze({
  NPB: Object.freeze({
    id: 'NPB_OFFICIAL_BIS',
    label: 'NPB 官方 BIS',
    zoneOffset: '+09:00',
    modelVersion: 'NPB-SHADOW-JOINT-SCORE-2026-08-v1.0.0',
    rulesVersion: 'NPB-TW-SHADOW-RULES-2026-08-v1.0.0',
    baselineRuns: 3.75,
    modelConfig: Object.freeze({
      baselineBounds: Object.freeze({ full: Object.freeze({ min: 3.1, max: 5.2 }), first5: Object.freeze({ min: 1.72, max: 2.89 }) }),
      scoreClamps: Object.freeze({ full: Object.freeze({ min: 1.7, max: 7.3 }), first5: Object.freeze({ min: 0.55, max: 4.55 }) }),
      homeCoefficient: Object.freeze({ full: 1.02, first5: 1.01 }),
      shrink: Object.freeze({ full: 0.72, first5: 0.70 }),
      extraInningsLimit: 12,
      allowDraw: true,
    }),
  }),
  KBO: Object.freeze({
    id: 'KBO_OFFICIAL_SCHEDULE',
    label: 'KBO 官方賽程',
    zoneOffset: '+09:00',
    modelVersion: 'KBO-SHADOW-JOINT-SCORE-2026-08-v1.0.0',
    rulesVersion: 'KBO-TW-SHADOW-RULES-2026-08-v1.0.0',
    baselineRuns: 4.65,
    modelConfig: Object.freeze({
      baselineBounds: Object.freeze({ full: Object.freeze({ min: 3.5, max: 5.8 }), first5: Object.freeze({ min: 1.94, max: 3.22 }) }),
      scoreClamps: Object.freeze({ full: Object.freeze({ min: 2.0, max: 8.1 }), first5: Object.freeze({ min: 0.65, max: 5.0 }) }),
      homeCoefficient: Object.freeze({ full: 1.025, first5: 1.012 }),
      shrink: Object.freeze({ full: 0.70, first5: 0.68 }),
      extraInningsLimit: 12,
      allowDraw: true,
    }),
  }),
  CPBL: Object.freeze({
    id: 'CPBL_OFFICIAL_STATS',
    label: 'CPBL 官方 Stats API',
    zoneOffset: '+08:00',
    modelVersion: 'CPBL-SHADOW-JOINT-SCORE-2026-08-v1.0.0',
    rulesVersion: 'CPBL-TW-SHADOW-RULES-2026-08-v1.0.0',
    baselineRuns: 4.45,
    modelConfig: Object.freeze({
      baselineBounds: Object.freeze({ full: Object.freeze({ min: 3.3, max: 5.8 }), first5: Object.freeze({ min: 1.83, max: 3.22 }) }),
      scoreClamps: Object.freeze({ full: Object.freeze({ min: 1.9, max: 8.0 }), first5: Object.freeze({ min: 0.60, max: 4.95 }) }),
      homeCoefficient: Object.freeze({ full: 1.025, first5: 1.012 }),
      shrink: Object.freeze({ full: 0.70, first5: 0.68 }),
      extraInningsLimit: 12,
      allowDraw: true,
    }),
  }),
});

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

function statusFields(status, scoresPresent) {
  const value = cleanText(status).toUpperCase();
  if (/POSTPON|CANCEL|SUSPEND|RAIN|NO GAME/.test(value)) {
    return { status: '延期／取消', statusEnglish: value || 'Postponed', statusCode: 'D' };
  }
  if (/IN PROGRESS|PLAYING|LIVE|START/.test(value) && !/SCHEDULE/.test(value)) {
    return { status: '比賽進行中', statusEnglish: value || 'In Progress', statusCode: 'I' };
  }
  if (scoresPresent || /FINISH|FINAL|COMPLETED|END/.test(value)) {
    return { status: '比賽結束', statusEnglish: value || 'Final', statusCode: 'F' };
  }
  return { status: '尚未開賽', statusEnglish: value || 'Scheduled', statusCode: 'S' };
}

function normalizedGame({
  league, sourceId, date, time, awayTeam, homeTeam, venue = '', status = '', awayScore = null,
  homeScore = null, innings = null, gameNumber = 1,
}) {
  const scoresPresent = Number.isFinite(awayScore) && Number.isFinite(homeScore);
  const state = statusFields(status, scoresPresent);
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
    awayScore: scoresPresent ? awayScore : null,
    homeScore: scoresPresent ? homeScore : null,
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
    const awayTeam = resolveTeam('NPB', teams[0]);
    const homeTeam = resolveTeam('NPB', teams[1]);
    if (!awayTeam || !homeTeam) return;
    const middleParts = unit.find('.round').html()?.split(/<br\s*\/?>/i).map(value => cleanText(cheerio.load(value).text())).filter(Boolean) || [];
    const time = middleParts.find(value => /^\d{1,2}:\d{2}$/.test(value)) || '18:00';
    const venue = middleParts.find(value => !/^\d{1,2}:\d{2}$/.test(value) && !/^Game\s+\d+/i.test(value)) || '';
    const gameNumber = Number(middleParts.join(' ').match(/Game\s+(\d+)/i)?.[1]) || 1;
    const awayScore = numericScore(unit.find('.score_left').first().text());
    const homeScore = numericScore(unit.find('.score_right').first().text());
    const href = unit.closest('a[href], .link_box').attr('href') || unit.find('a[href]').first().attr('href') || '';
    const sourceId = href.match(/\/(s\d+)\.html/i)?.[1] || `${date}|${awayTeam.code}|${homeTeam.code}|${time}|${gameNumber}`;
    const game = normalizedGame({ league: 'NPB', sourceId, date, time, awayTeam, homeTeam, venue, awayScore, homeScore, gameNumber });
    if (game) rows.push(game);
  });
  return uniqueGames(rows);
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
        if (awayScore == null || homeScore == null) status = 'POSTPONED';
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
    const scoreValues = play('em span').map((_, node) => cleanText(play(node).text())).get().filter(value => /^\d+$/.test(value));
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
  return parseNpbScheduleHtml(await fetchResponse(url, { ...options, format: 'text' }), date);
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
  return uniqueGames(settled.flatMap(result => result.status === 'fulfilled' ? result.value : []));
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
    return { date: game.gameDate, scored: Number(away ? game.awayScore : game.homeScore), allowed: Number(away ? game.homeScore : game.awayScore) };
  }).filter(row => Number.isFinite(row.scored) && Number.isFinite(row.allowed));
}

function hittingBlock(rows, baseline) {
  const count = rows.length;
  const runsPerGame = count ? rows.reduce((sum, row) => sum + row.scored, 0) / count : baseline;
  const factor = Math.max(0.78, Math.min(1.24, runsPerGame / Math.max(0.1, baseline)));
  return {
    available: count > 0,
    gamesPlayed: count,
    runsPerGame,
    ops: Math.max(0.62, Math.min(0.86, 0.72 * Math.sqrt(factor))),
    avg: Math.max(0.21, Math.min(0.31, 0.255 * Math.sqrt(factor))),
    obp: Math.max(0.28, Math.min(0.39, 0.325 * Math.sqrt(factor))),
    slg: Math.max(0.32, Math.min(0.50, 0.395 * factor)),
    iso: Math.max(0.10, Math.min(0.22, 0.15 * factor)),
    kRate: 0.225,
    bbRate: 0.085,
  };
}

function pitchingBlock(rows, baseline) {
  const count = rows.length;
  const runsAllowed = count ? rows.reduce((sum, row) => sum + row.allowed, 0) / count : baseline;
  return {
    available: count > 0,
    gamesPlayed: count,
    inningsPitched: count * 9,
    era: runsAllowed,
    fip: runsAllowed,
    whip: Math.max(1.0, Math.min(1.65, 1.3 * Math.sqrt(runsAllowed / Math.max(0.1, baseline)))),
    kMinusBB: 0.14,
    hrPer9: 1.05,
  };
}

function restBlock(rows, gameDate) {
  const previous = [...rows].sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0];
  const days = previous ? Math.max(0, Math.round((Date.parse(gameDate) - Date.parse(previous.date)) / 86_400_000)) : 1;
  return { available: Boolean(previous), days, travelKm: 0, previousExtraInnings: false, dayNightTransition: false };
}

function teamContext(history, teamId, baseline, gameDate) {
  const seasonRows = teamRunRows(history, teamId);
  const recentRows = [...seasonRows].sort((left, right) => Date.parse(right.date) - Date.parse(left.date)).slice(0, 10);
  const recentPitching = pitchingBlock(recentRows, baseline);
  return {
    seasonHitting: hittingBlock(seasonRows, baseline),
    seasonPitching: pitchingBlock(seasonRows, baseline),
    recentHitting: hittingBlock(recentRows, baseline),
    recentPitching,
    vsLeft: { ...hittingBlock(seasonRows, baseline), available: false },
    vsRight: { ...hittingBlock(seasonRows, baseline), available: false },
    starter: { available: false, confirmed: false },
    lineup: { official: false, projected: false, offensiveIndex: 1, catcher: null },
    bullpen: {
      usageAvailable: false,
      fatigueIndex: 0.2,
      highLeverageAvailability: 0.75,
      qualityFactor: Math.max(0.80, Math.min(1.25, recentPitching.era / Math.max(0.1, baseline))),
    },
    defense: { available: false },
    baserunning: { runIndex: 1 },
    rest: restBlock(seasonRows, gameDate),
    injuriesAvailable: false,
    injuries: [],
    injuryImpact: 0,
  };
}

export async function buildAsianGameContext(value, game, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  historyGames,
} = {}) {
  const leagueId = leagueIdForGame(value, game);
  const config = asianLeagueConfig(leagueId);
  const history = completedBefore(await fetchHistory(leagueId, game?.officialDate || game?.taipeiDate || game?.gameDate?.slice(0, 10), {
    fetchImpl, timeoutMs, historyGames,
  }), game?.gameDate);
  const leagueRuns = history.length
    ? history.reduce((sum, row) => sum + Number(row.awayScore) + Number(row.homeScore), 0) / (history.length * 2)
    : config.baselineRuns;
  const baseline = Math.max(config.modelConfig.baselineBounds.full.min, Math.min(config.modelConfig.baselineBounds.full.max, leagueRuns));
  const away = teamContext(history, game.awayTeamId, baseline, game.gameDate);
  const home = teamContext(history, game.homeTeamId, baseline, game.gameDate);
  const warnings = [
    'EXPERIMENTAL_SHADOW｜亞洲聯盟尚未完成跨球季正式校準，所有分數不可下注',
    '先發、打線、逐投手牛棚、守備與天氣未由官方結構化來源完整確認，已擴大聯合情境',
  ];
  return {
    game: { ...game, league: leagueId, leagueId, analysisMode: ASIAN_ANALYSIS_MODE, betEligible: false },
    leagueId,
    analysisMode: ASIAN_ANALYSIS_MODE,
    executable: false,
    betEligible: false,
    modelVersion: config.modelVersion,
    rulesVersion: config.rulesVersion,
    modelConfig: config.modelConfig,
    provider: { id: config.id, leagueId, analysisMode: ASIAN_ANALYSIS_MODE, executable: false, betEligible: false },
    league: { id: leagueId, available: history.length > 0, runsPerTeamGame: baseline, source: `${config.label} 近三個月完賽比分` },
    away,
    home,
    weather: { available: false, roofClosedProbability: 0.35, roofConfirmed: false },
    park: { runFactor: 1, roof: 'unknown', name: game.venue || '場地待確認', nameEnglish: game.venueEnglish || '' },
    umpire: {},
    warnings,
    featureProvenance: [
      { feature: '聯盟得分基準', status: history.length ? '已確認' : '預估', source: `${config.label} 官方完賽比分` },
      { feature: '球隊近期攻守', status: history.length ? '已確認' : '預估', source: `${config.label} 官方近三個月賽果` },
      { feature: '先發／打線／牛棚', status: '未知', source: 'shadow 中性分布與擴大不確定性' },
      { feature: '天氣／主審', status: '未知', source: 'shadow 中性分布與擴大不確定性' },
    ],
    coreModelable: Boolean(game?.gamePk && game?.awayTeamId && game?.homeTeamId),
    coreTeamData: history.length > 0,
    coreStarterData: false,
    starterModelingMode: 'NEUTRAL_STARTER_UNCERTAINTY',
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
  const final = game.statusCode === 'F' && Number.isFinite(Number(game.awayScore)) && Number.isFinite(Number(game.homeScore));
  return {
    final,
    awayRuns: final ? Number(game.awayScore) : null,
    homeRuns: final ? Number(game.homeScore) : null,
    awayFirst5: null,
    homeFirst5: null,
    innings: game.innings,
    status: game.status,
    statusEnglish: game.statusEnglish,
    game,
  };
}
