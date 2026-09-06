// ESPN identifiers remain provider identifiers; no inferred NBA official ID mapping.
export { NBA_MODULE_VERSION } from './config.js';
export const ESPN_NBA_TEAMS = Object.freeze({ '1': 'ATL', '2': 'BOS', '17': 'BKN', '30': 'CHA', '4': 'CHI', '5': 'CLE', '6': 'DAL', '7': 'DEN', '8': 'DET', '9': 'GS', '10': 'HOU', '11': 'IND', '12': 'LAC', '13': 'LAL', '29': 'MEM', '14': 'MIA', '15': 'MIL', '16': 'MIN', '3': 'NO', '18': 'NY', '25': 'OKC', '19': 'ORL', '20': 'PHI', '21': 'PHX', '22': 'POR', '23': 'SAC', '24': 'SA', '28': 'TOR', '26': 'UTAH', '27': 'WSH' });

export class NbaDataError extends Error {
  constructor(code, message) { super(message); this.name = 'NbaDataError'; this.code = code; }
}
export function assertNba(condition, code, message) {
  if (!condition) throw new NbaDataError(code, message);
}
export function sourceId(value, kind) {
  assertNba(typeof value === 'string', 'IDENTITY_INVALID', '來源身分必須保留字串格式');
  const prefix = `nba:espn:${kind}:`;
  const id = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  assertNba(/^[1-9]\d{0,14}$/.test(id), 'IDENTITY_INVALID', 'NBA 身分格式錯誤');
  return id;
}
export function assertUid(uid, kind, id) {
  if (uid == null) return;
  const marker = { game: 'e', team: 't', player: 'a' }[kind];
  assertNba(uid === `s:40~l:46~${marker}:${id}`, 'LEAGUE_IDENTITY_MISMATCH', '來源身分不屬於此 NBA 資料');
}
export function assertNbaLeague(league) {
  assertNba(league && league.id === '46' && league.abbreviation === 'NBA', 'LEAGUE_IDENTITY_MISMATCH', '來源未確認為 NBA 聯盟');
  if (league.uid != null) assertNba(league.uid === 's:40~l:46', 'LEAGUE_IDENTITY_MISMATCH', '聯盟身分衝突');
}
export function normalizeTeam(raw) {
  assertNba(raw && typeof raw === 'object', 'SCHEMA_INVALID', '缺少球隊資料');
  const id = sourceId(raw.id, 'team');
  assertUid(raw.uid, 'team', id);
  assertNba(ESPN_NBA_TEAMS[id] === raw.abbreviation, 'TEAM_IDENTITY_MISMATCH', '球隊 ID 與 NBA 球隊縮寫不一致');
  assertNba(typeof raw.displayName === 'string' && raw.displayName.length > 0, 'TEAM_IDENTITY_MISMATCH', '缺少球隊名稱');
  return { id: `nba:espn:team:${id}`, sourceId: id, league: 'NBA', provider: 'ESPN', name: raw.displayName, abbreviation: raw.abbreviation, identityStatus: 'provider_verified_official_unverified' };
}
export function normalizePlayer(raw, teamId) {
  assertNba(raw && typeof raw === 'object', 'SCHEMA_INVALID', '缺少球員資料');
  let rawId = raw.id;
  if (rawId == null) {
    const candidates = (raw.links || []).filter(link => link.rel?.includes('playercard')).map(link => {
      try { const url = new URL(link.href); return url.protocol === 'https:' && url.hostname === 'www.espn.com' ? url.pathname.match(/^\/nba\/player\/_\/id\/(\d+)\//)?.[1] : null; } catch { return null; }
    }).filter(Boolean);
    assertNba(new Set(candidates).size === 1, 'PLAYER_IDENTITY_MISMATCH', '球員來源 ID 無法唯一確認');
    rawId = candidates[0];
  }
  const id = sourceId(rawId, 'player');
  assertUid(raw.uid, 'player', id);
  assertNba(typeof raw.displayName === 'string' && raw.displayName.length > 0, 'PLAYER_IDENTITY_MISMATCH', '缺少球員姓名');
  if (teamId) sourceId(teamId, 'team');
  return { id: `nba:espn:player:${id}`, sourceId: id, league: 'NBA', provider: 'ESPN', name: raw.displayName, teamId: teamId || null, position: raw.position?.abbreviation || null, jersey: typeof raw.jersey === 'string' ? raw.jersey : null, identityStatus: 'provider_verified_official_unverified' };
}
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function taipeiDate(value) {
  const date = new Date(value);
  assertNba(Number.isFinite(date.getTime()), 'DATE_INVALID', '賽事時間格式錯誤');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function seasonType(value) {
  const type = typeof value === 'object' ? value?.type ?? value?.id : value;
  return ({ 1: 'preseason', 2: 'regular', 3: 'postseason' })[type] || 'unknown';
}
export function normalizeSeason(raw) {
  const year = raw?.year;
  assertNba(Number.isInteger(year) && year >= 1947 && year <= 2200, 'SEASON_INVALID', 'NBA 賽季欄位缺失或不正確');
  return { year, label: `${year - 1}–${String(year).slice(-2)}`, type: seasonType(raw.type) };
}
