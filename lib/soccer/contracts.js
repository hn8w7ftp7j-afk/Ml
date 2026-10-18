export const SOCCER_DATA_VERSION = 'soccer-data-v1';
export const SOCCER_TIME_ZONE = 'Asia/Taipei';
export const SOCCER_LEAGUES = Object.freeze({
  epl: Object.freeze({ id: 'epl', name: '英格蘭超級聯賽', shortName: '英超 EPL', espnSlug: 'eng.1', espnId: '700', englishName: 'English Premier League', officialUrl: 'https://www.premierleague.com/' }),
  ucl: Object.freeze({ id: 'ucl', name: '歐洲冠軍聯賽', shortName: '歐冠 UCL', espnSlug: 'uefa.champions', espnId: '775', englishName: 'UEFA Champions League', officialUrl: 'https://www.uefa.com/uefachampionsleague/' }),
});
export const SOCCER_CAPABILITIES = Object.freeze({
  schedule: true, results: true, standings: true, model: false, ranking: false, betting: false,
  reason: '足球歷史賽前資料、獨立模型與校準尚未驗證，暫不提供評分、EV、排名或下注。',
  missing: ['SOCCER_PREMATCH_HISTORY_VALIDATION', 'SOCCER_MODEL_CALIBRATION', 'VERIFIED_SOCCER_MARKET_CONTRACT'],
});
export function soccerLeague(value) { return typeof value === 'string' ? SOCCER_LEAGUES[value.toLowerCase()] || null : null; }
export function validSoccerDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function soccerDate(value = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: SOCCER_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function shiftSoccerDate(date, days) {
  if (!validSoccerDate(date) || !Number.isInteger(days)) return null;
  const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
}
export function soccerCacheKey(league, action, scope) {
  const competition = soccerLeague(league);
  if (!competition) throw new Error('SOCCER_INVALID_LEAGUE');
  return `soccer:v1:${competition.id}:${action}:${scope}`;
}
export function publicSoccerLeagues() {
  return Object.values(SOCCER_LEAGUES).map(league => ({ id: league.id.toUpperCase(), name: league.name, shortName: league.shortName, path: `/soccer?league=${league.id.toUpperCase()}`, capabilities: SOCCER_CAPABILITIES, source: { provider: 'ESPN', officialUrl: league.officialUrl } }));
}
