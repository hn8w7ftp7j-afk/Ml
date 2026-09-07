import { createHash } from 'node:crypto';
import { assertNba, validDate } from './identity.js';

export const NBA_OFFICIAL_VERSION = 'nba-official-crosswalk-v1';
const tricodes = { GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS' };
const code = team => tricodes[team.abbreviation] || team.abbreviation;
const nameKey = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cache = new Map();
const inflight = new Map();

export function parseNbaPage(html) {
  const match = html.match(/<script\b(?=[^>]*\bid="__NEXT_DATA__")[^>]*>([\s\S]*?)<\/script>/);
  assertNba(match, 'OFFICIAL_SCHEMA_INVALID', '官方頁面未提供可解析的資料');
  const props = JSON.parse(match[1])?.props?.pageProps;
  assertNba(props && !props.hasError, 'OFFICIAL_SCHEMA_INVALID', '官方頁面資料不完整');
  return props;
}

export function findOfficialGame(props, game, easternDate) {
  assertNba(validDate(easternDate) && props.selectedDate === easternDate, 'OFFICIAL_DATE_CONFLICT', '官方日期未遵守查詢');
  assertNba(Array.isArray(props.gameCardFeed?.modules), 'OFFICIAL_SCHEMA_INVALID', '官方賽程結構缺失');
  const candidates = props.gameCardFeed.modules.flatMap(module => module.cards || []).map(row => row.cardData).filter(row => row?.leagueId === '00' && row.awayTeam?.teamTricode === code(game.away) && row.homeTeam?.teamTricode === code(game.home));
  assertNba(candidates.length === 1, 'OFFICIAL_GAME_UNRESOLVED', '官方場次無法唯一對應，不猜測 ID');
  const row = candidates[0];
  assertNba(/^00[1245]\d{7}$/.test(row.gameId) && Date.parse(row.gameTimeUtc) === Date.parse(game.startTime), 'OFFICIAL_GAME_CONFLICT', '官方開賽時間或比賽 ID 不一致');
  const type = { 'Regular Season': 'regular', 'Preseason': 'preseason', 'Playoffs': 'postseason' }[row.seasonType];
  assertNba(type === game.seasonType, 'OFFICIAL_SEASON_CONFLICT', '官方賽事類型不一致');
  const url = new URL(row.shareUrl);
  assertNba(url.origin === 'https://www.nba.com' && new RegExp(`^/game/[a-z0-9-]+-${row.gameId}$`).test(url.pathname) && !url.search && !url.hash && !url.username && !url.password, 'OFFICIAL_SOURCE_INVALID', '官方比賽網址不符合已核對身分');
  return { ...row, url: `${url.href}/box-score` };
}

export function crosswalkOfficialGame(official, card, game, players) {
  assertNba(official?.gameId === card.gameId && Date.parse(official.gameTimeUTC) === Date.parse(game.startTime), 'OFFICIAL_GAME_CONFLICT', '官方 box score 場次或時間衝突');
  assertNba(game.league === 'NBA' && game.id === `nba:espn:game:${game.sourceId}`, 'OFFICIAL_GAME_CONFLICT', '非 NBA 場次不能交叉核對');
  const result = { version: NBA_OFFICIAL_VERSION, gameId: game.id, officialGameId: official.gameId, status: 'ready', teams: [], players: [], missingPlayers: [], temporalBasis: game.status === 'final' ? 'postgame_crosscheck' : 'observed_now', pregameLineupVerified: false };
  const allOfficialIds = new Set(); const allProviderIds = new Set(); const assignedOfficialIds = new Set();
  for (const side of ['away', 'home']) {
    const a = official[`${side}Team`]; const b = game[side];
    assertNba(Number.isSafeInteger(a?.teamId) && a.teamId > 0 && a.teamId === card[`${side}Team`]?.teamId && official[`${side}TeamId`] === a.teamId && a.teamTricode === code(b), 'OFFICIAL_TEAM_CONFLICT', '官方球隊 ID 或主客隊衝突');
    if (game.status === 'final') assertNba(official.gameStatus === 3 && a.score === b.score && JSON.stringify((a.periods || []).map(p => p.score)) === JSON.stringify(b.periodScores.map(p => p.score)), 'OFFICIAL_SCORE_CONFLICT', '官方全場或分節比分與來源不一致');
    result.teams.push({ providerId: b.id, officialId: `nba:official:team:${a.teamId}`, officialSourceId: String(a.teamId), tricode: a.teamTricode });
    assertNba(Array.isArray(a.players), 'OFFICIAL_SCHEMA_INVALID', '官方球員資料缺失');
    for (const player of a.players) {
      assertNba(Number.isSafeInteger(player.personId) && player.personId > 0 && !allOfficialIds.has(player.personId), 'OFFICIAL_PLAYER_CONFLICT', '官方球員 ID 缺失或重複');
      allOfficialIds.add(player.personId);
    }
    for (const player of players.filter(p => p.teamId === b.id)) {
      assertNba(!allProviderIds.has(player.id), 'OFFICIAL_PLAYER_CONFLICT', '來源球員 ID 重複'); allProviderIds.add(player.id);
      const matches = a.players.filter(p => nameKey(`${p.firstName} ${p.familyName}`) === nameKey(player.name));
      assertNba(matches.length <= 1, 'OFFICIAL_PLAYER_CONFLICT', '同場同隊球員姓名不唯一，禁止猜測');
      if (!matches.length) { result.missingPlayers.push({ playerId: player.id, name: player.name, reason: 'no_unique_same_game_same_team_name' }); continue; }
      const match = matches[0];
      assertNba(!assignedOfficialIds.has(match.personId), 'OFFICIAL_PLAYER_CONFLICT', '多個來源球員指向同一官方 ID'); assignedOfficialIds.add(match.personId);
      const points = player.statistics?.find(s => s.name === 'points')?.displayValue;
      const checkedPoints = !player.didNotPlay && typeof points === 'string' && /^\d+$/.test(points) && Number.isFinite(match.statistics?.points);
      if (checkedPoints) assertNba(Number(points) === match.statistics.points, 'OFFICIAL_PLAYER_CONFLICT', '同場同隊同名球員得分不一致');
      result.players.push({ providerId: player.id, officialId: `nba:official:player:${match.personId}`, officialSourceId: String(match.personId), teamId: b.id, name: player.name, basis: checkedPoints ? 'same_game_team_name_and_points' : 'same_game_team_unique_name', pointsChecked: checkedPoints });
    }
  }
  assertNba(result.teams[0].officialId !== result.teams[1].officialId, 'OFFICIAL_TEAM_CONFLICT', '兩隊官方 ID 相同');
  if (result.missingPlayers.length || !result.players.length) result.status = 'partial';
  return result;
}

async function getPage(url, { fetchImpl = fetch, now = Date.now } = {}) {
  const parsed = new URL(url);
  assertNba(parsed.origin === 'https://www.nba.com' && !parsed.username && !parsed.password && (parsed.pathname === '/games' || /^\/game\/[a-z0-9-]+-\d{10}\/box-score$/.test(parsed.pathname)), 'OFFICIAL_SOURCE_INVALID', '官方來源不在允許清單');
  const key = url; const time = now(); const previous = cache.get(key);
  if (fetchImpl === fetch && previous && time >= previous.time && time - previous.time < 600000) return structuredClone(previous.result);
  const run = async () => {
    const response = await fetchImpl(url, { headers: { Accept: 'text/html' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000) });
    assertNba(response.ok, 'OFFICIAL_UNAVAILABLE', `NBA 官網回應 HTTP ${response.status}`);
    const html = await response.text();
    assertNba(html.length < 12000000, 'OFFICIAL_SCHEMA_INVALID', '官方頁面超過大小限制');
    const value = parseNbaPage(html);
    const result = { value, source: { provider: 'NBA', url, fetchedAt: new Date(now()).toISOString(), publishedAt: null, hash: createHash('sha256').update(html).digest('hex'), status: 'ready', publicationBasis: 'not_supplied' } };
    if (fetchImpl === fetch) { cache.set(key, { time, result }); while (cache.size > 40) cache.delete(cache.keys().next().value); }
    return result;
  };
  if (fetchImpl !== fetch) return run();
  if (inflight.has(key)) return structuredClone(await inflight.get(key));
  const task = run(); inflight.set(key, task);
  try { return structuredClone(await task); } finally { inflight.delete(key); }
}

export async function loadOfficialNbaEvidence(game, players, options = {}) {
  const sources = [];
  try {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(game.startTime));
    const schedule = await getPage(`https://www.nba.com/games?date=${date}`, options); sources.push(schedule.source);
    const card = findOfficialGame(schedule.value, game, date);
    const box = await getPage(card.url, options); sources.push(box.source);
    return { ...crosswalkOfficialGame(box.value.game, card, game, players), sources, officialUrl: card.url };
  } catch (error) {
    return { version: NBA_OFFICIAL_VERSION, gameId: game.id, status: /CONFLICT|INVALID/.test(error.code || '') ? 'blocked' : 'unavailable', sources, error: error.message, code: error.code || 'OFFICIAL_UNAVAILABLE', teams: [], players: [], pregameLineupVerified: false };
  }
}
