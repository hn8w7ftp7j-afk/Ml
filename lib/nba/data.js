import { NBA_MODULE_VERSION, NbaDataError, assertNba, assertNbaLeague, assertUid, normalizeTeam, normalizePlayer, normalizeSeason, seasonType as normalizeSeasonType, sourceId, taipeiDate, validDate, ESPN_NBA_TEAMS } from './identity.js';
import { createNbaCache, nbaCache } from './cache.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/';
const PLAYER_BASE = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/';
const testCaches = new WeakMap();
const identityStatus = 'provider_verified_official_unverified';
const emptyData = () => ({ games: [], teams: [], players: [], injuries: [], game: null, team: null, player: null, playerSeasons: [], statistics: [], seasonTypes: [], lineups: [], availability: {} });
const issue = (code, message) => ({ code, message });
function safeTime(value) {
  if (typeof value !== 'string') return null;
  const parts = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/);
  if (!parts || !validDate(parts[1]) || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4] || 0) > 59) return null;
  if (parts[6] !== 'Z') {
    const [hours, minutes] = parts[6].slice(1).split(':').map(Number);
    if (hours > 23 || minutes > 59) return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function normalizeStatistics(stats) {
  if (!Array.isArray(stats)) return [];
  return stats.filter(stat => typeof stat?.name === 'string').map(stat => ({ name: stat.name, label: stat.label || stat.displayName || stat.abbreviation || stat.name, value: typeof stat.value === 'number' && Number.isFinite(stat.value) ? stat.value : null, displayValue: typeof stat.displayValue === 'string' ? stat.displayValue : typeof stat.value === 'number' ? String(stat.value) : '—' }));
}
function scoreNumber(raw) {
  const value = raw && typeof raw === 'object' ? raw.value ?? raw.displayValue : raw;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  return typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}
function gameStatus(status) {
  const type = status?.type || {};
  if (type.completed === true) return 'final';
  if (/POSTPONED|CANCELED|SUSPENDED/.test(type.name || '')) return 'postponed';
  return ({ pre: 'scheduled', in: 'live' })[type.state] || 'unknown';
}
export function normalizeGame(event, fallbackSeason) {
  const id = sourceId(event?.id, 'game');
  assertUid(event.uid, 'game', id);
  assertNba(Array.isArray(event.competitions) && event.competitions.length === 1, 'SCHEMA_INVALID', 'NBA 賽事必須有唯一比賽資料');
  const competition = event.competitions[0];
  assertNba(competition.id === id, 'GAME_IDENTITY_MISMATCH', '賽事與比賽 ID 不一致');
  if (competition.uid) assertNba(competition.uid === `s:40~l:46~e:${id}~c:${id}`, 'GAME_IDENTITY_MISMATCH', '賽事聯盟身分衝突');
  const startTime = safeTime(competition.date || event.date);
  assertNba(startTime, 'DATE_INVALID', '缺少可核對的 UTC 開賽時間');
  if (event.date && competition.date) assertNba(safeTime(event.date) === startTime, 'GAME_IDENTITY_MISMATCH', '同一賽事的開賽時間互相衝突');
  const competitors = competition.competitors;
  assertNba(Array.isArray(competitors) && competitors.length === 2, 'SCHEMA_INVALID', 'NBA 賽事必須包含兩支球隊');
  const statusInfo = competition.status || event.status;
  const status = gameStatus(statusInfo);
  const sides = {};
  for (const competitor of competitors) {
    assertNba(['home', 'away'].includes(competitor.homeAway) && !sides[competitor.homeAway], 'GAME_IDENTITY_MISMATCH', 'NBA 主客隊身分重複或缺失');
    const team = normalizeTeam(competitor.team);
    assertNba(competitor.id === team.sourceId, 'TEAM_IDENTITY_MISMATCH', '比賽球隊 ID 與隊伍資料不一致');
    assertUid(competitor.uid, 'team', team.sourceId);
    const score = status === 'scheduled' || status === 'postponed' ? null : scoreNumber(competitor.score);
    if (status === 'final') assertNba(score != null, 'SCORE_INVALID', '完賽比分缺失或不是有效整數');
    const periodScores = (competitor.linescores || []).map((line, index) => ({ period: Number.isInteger(line.period) ? line.period : index + 1, score: scoreNumber(line.value ?? line.displayValue) }));
    assertNba(periodScores.every((line, index) => line.period === index + 1 && line.score != null), 'SCORE_INVALID', '分節比分或分節順序無效');
    assertNba(new Set(periodScores.map(line => line.period)).size === periodScores.length, 'SCORE_INVALID', '分節編號重複');
    if (status === 'final' && periodScores.length >= 4) assertNba(periodScores.reduce((sum, line) => sum + line.score, 0) === score, 'SCORE_INVALID', '分節比分與最終比分不一致');
    sides[competitor.homeAway] = { ...team, score, periodScores, statistics: normalizeStatistics(competitor.statistics) };
  }
  assertNba(sides.home?.id !== sides.away?.id, 'GAME_IDENTITY_MISMATCH', 'NBA 同場兩隊不得相同');
  const seasonRecord = event.season || fallbackSeason;
  if (event.seasonType != null && seasonRecord?.type != null) assertNba(normalizeSeasonType(event.seasonType) === normalizeSeasonType(seasonRecord.type), 'SEASON_INVALID', '同場比賽的賽季類型互相衝突');
  const season = normalizeSeason({ ...seasonRecord, type: event.seasonType ?? seasonRecord?.type });
  return { id: `nba:espn:game:${id}`, sourceId: id, league: 'NBA', provider: 'ESPN', name: event.name || `${sides.away.name} @ ${sides.home.name}`, startTime, taipeiDate: taipeiDate(startTime), season, seasonType: season.type, status, statusText: statusInfo?.type?.description || statusInfo?.type?.detail || status, completed: status === 'final', home: sides.home, away: sides.away, venue: competition.venue?.fullName || null, neutralSite: competition.neutralSite === true, timeConfirmed: competition.timeValid !== false && event.timeValid !== false, identityStatus };
}
function uniqueGames(games) {
  const byId = new Map();
  for (const game of games) {
    const previous = byId.get(game.id);
    if (previous) {
      const comparable = ({ sourceUrl, retrievedAt, ...rest }) => rest;
      assertNba(JSON.stringify(comparable(previous)) === JSON.stringify(comparable(game)), 'GAME_IDENTITY_MISMATCH', '相同賽事 ID 的內容衝突');
    }
    byId.set(game.id, game);
  }
  return [...byId.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
}
function validateScoreboard(raw) {
  assertNba(Array.isArray(raw?.leagues) && raw.leagues.length === 1 && Array.isArray(raw?.events), 'SCHEMA_INVALID', 'NBA 賽程回應結構不正確');
  assertNbaLeague(raw.leagues[0]);
  uniqueGames(raw.events.map(event => normalizeGame(event, raw.leagues[0].season)));
}
function validateTeams(raw) {
  const sports = raw?.sports;
  assertNba(Array.isArray(sports) && sports.length === 1 && sports[0].id === '40' && sports[0].leagues?.length === 1, 'LEAGUE_IDENTITY_MISMATCH', '球隊清單不是 NBA 籃球資料');
  const league = sports[0].leagues[0]; assertNbaLeague(league);
  assertNba(Array.isArray(league.teams), 'SCHEMA_INVALID', '球隊清單缺失');
  const teams = league.teams.map(entry => normalizeTeam(entry.team));
  assertNba(new Set(teams.map(team => team.id)).size === teams.length, 'TEAM_IDENTITY_MISMATCH', '球隊 ID 重複');
}
function summaryPlayers(raw, game) {
  const players = [];
  const knownTeams = new Set([game.home.id, game.away.id]);
  for (const block of raw.boxscore?.players || []) {
    const team = normalizeTeam(block.team);
    assertNba(knownTeams.has(team.id), 'TEAM_IDENTITY_MISMATCH', '球員數據混入其他球隊');
    for (const group of block.statistics || []) {
      assertNba(Array.isArray(group.athletes) && Array.isArray(group.keys), 'SCHEMA_INVALID', '球員統計欄位結構不正確');
      for (const row of group.athletes) {
        const player = normalizePlayer(row.athlete, team.id);
        assertNba(Array.isArray(row.stats), 'SCHEMA_INVALID', '球員統計資料不是陣列');
        if (!row.didNotPlay) assertNba(row.stats.length === group.keys.length, 'SCHEMA_INVALID', '球員統計欄位與數值無法對齊');
        const starterStatus = row.starter === true ? game.status === 'final' || game.status === 'live' ? 'actual' : 'reported' : 'unknown';
        players.push({ ...player, starter: row.starter === true, starterStatus, lineupTemporalBasis: game.status === 'final' ? 'postgame_boxscore' : game.status === 'live' ? 'in_game_boxscore' : 'provider_pregame_report', didNotPlay: row.didNotPlay === true, statistics: group.keys.map((name, index) => ({ name, label: group.labels?.[index] || name, value: null, displayValue: typeof row.stats[index] === 'string' ? row.stats[index] : '—' })) });
      }
    }
  }
  assertNba(new Set(players.map(player => player.id)).size === players.length, 'PLAYER_IDENTITY_MISMATCH', '同場球員 ID 重複或跨隊衝突');
  return players;
}
function validateSummary(raw, id) {
  assertNba(raw?.header?.id === id, 'GAME_IDENTITY_MISMATCH', '回傳賽事與指定賽事不同');
  assertNbaLeague(raw.header.league);
  const game = normalizeGame(raw.header);
  summaryPlayers(raw, game);
  for (const block of raw.boxscore?.teams || []) {
    const team = normalizeTeam(block.team);
    assertNba([game.home.id, game.away.id].includes(team.id), 'TEAM_IDENTITY_MISMATCH', '比賽統計混入其他球隊');
  }
}
function validateRoster(raw, id) {
  assertNba(raw?.status === 'success' && Array.isArray(raw.athletes), 'SCHEMA_INVALID', '球員名單來源結構錯誤');
  const team = normalizeTeam(raw.team);
  assertNba(team.sourceId === id, 'TEAM_IDENTITY_MISMATCH', '球員名單與指定球隊不同');
  const players = raw.athletes.map(player => normalizePlayer(player, team.id));
  assertNba(new Set(players.map(player => player.id)).size === players.length, 'PLAYER_IDENTITY_MISMATCH', '球員名單身分重複');
}
function validateTeamStatistics(raw, id, year) {
  assertNba(raw?.status === 'success' && Array.isArray(raw.results?.stats?.categories), 'SCHEMA_INVALID', '球隊統計來源結構錯誤');
  assertNba(normalizeTeam(raw.team).sourceId === id, 'TEAM_IDENTITY_MISMATCH', '球隊統計身分不一致');
  assertNba(raw.requestedSeason?.year === year, 'SEASON_INVALID', '回傳統計賽季不是要求的賽季');
  normalizeSeason(raw.requestedSeason);
}
function normalizeInjuries(raw) {
  assertNba(raw?.status === 'success' && Array.isArray(raw.injuries), 'SCHEMA_INVALID', '傷病來源結構錯誤');
  const records = raw.injuries.flatMap(group => {
    const teamId = sourceId(group.id, 'team');
    assertNba(ESPN_NBA_TEAMS[teamId] && Array.isArray(group.injuries), 'TEAM_IDENTITY_MISMATCH', '傷病清單球隊身分無效');
    return group.injuries.map(record => {
      const team = normalizeTeam(record.athlete?.team);
      assertNba(team.sourceId === teamId, 'TEAM_IDENTITY_MISMATCH', '傷病球員隊伍與分組衝突');
      const player = normalizePlayer(record.athlete, team.id);
      const sourceRecordId = typeof record.id === 'string' || Number.isSafeInteger(record.id) ? String(record.id) : null;
      return { id: `nba:espn:injury:${teamId}:${player.sourceId}:${sourceRecordId ?? 'unreported'}`, sourceRecordId, player, team, status: record.status || 'Unknown', bodyPart: record.details?.type || null, detail: record.details?.detail || null, description: typeof record.shortComment === 'string' ? record.shortComment : typeof record.longComment === 'string' ? record.longComment : null, side: record.details?.side || null, reportedAt: safeTime(record.date), expectedReturnDate: validDate(record.details?.returnDate) ? record.details.returnDate : null, temporalBasis: 'latest_report_only', officialReportVerified: false };
    });
  });
  const byId = new Map();
  for (const record of records) {
    const previous = byId.get(record.id);
    assertNba(!previous || JSON.stringify(previous) === JSON.stringify(record), 'INJURY_IDENTITY_CONFLICT', '同一球員的傷病來源身分出現互相衝突的報告');
    byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function validateHistory(raw, id, year, type) {
  assertNba(Array.isArray(raw?.events), 'SCHEMA_INVALID', '歷史賽程來源結構錯誤');
  assertNba(normalizeTeam(raw.team).sourceId === id, 'TEAM_IDENTITY_MISMATCH', '歷史賽程球隊不一致');
  assertNba(raw.requestedSeason?.year === year && raw.requestedSeason?.type === type, 'SEASON_INVALID', '歷史來源未遵守要求的賽季與賽事類型');
  const games = raw.events.map(event => normalizeGame(event, raw.requestedSeason));
  for (const game of games) {
    assertNba(game.season.year === year, 'SEASON_INVALID', '歷史賽事混入不同賽季');
    assertNba(game.seasonType === normalizeSeasonType(type), 'SEASON_INVALID', '歷史賽事混入不同賽事類型');
    assertNba([game.home.sourceId, game.away.sourceId].includes(id), 'GAME_IDENTITY_MISMATCH', '歷史賽事混入其他球隊');
  }
  uniqueGames(games);
}
function validatePlayerProfile(raw, id) {
  assertNbaLeague(raw?.league);
  assertNba(normalizePlayer(raw.athlete).sourceId === id, 'PLAYER_IDENTITY_MISMATCH', '球員資料與指定 ID 不一致');
  if (raw.athlete.team?.id) normalizeTeam(raw.athlete.team);
}
function normalizePlayerSeasons(raw, year, type) {
  assertNba(Array.isArray(raw?.filters) && raw.filters.find(filter => filter.name === 'league')?.value === 'nba', 'LEAGUE_IDENTITY_MISMATCH', '球員統計來源未確認為 NBA');
  assertNba(raw.filters.find(filter => filter.name === 'seasontype')?.value === String(type), 'SEASON_INVALID', '球員統計賽事類型與指定類型不同');
  assertNba(Array.isArray(raw.categories) && raw.teams && typeof raw.teams === 'object', 'SCHEMA_INVALID', '球員歷年統計結構錯誤');
  const teams = Object.fromEntries(Object.entries(raw.teams).map(([slug, value]) => [slug, normalizeTeam(value)]));
  const rows = [];
  for (const category of raw.categories) {
    assertNba(Array.isArray(category.names) && Array.isArray(category.statistics), 'SCHEMA_INVALID', '球員統計分類缺少欄位');
    for (const record of category.statistics) {
      assertNba(Number.isInteger(record.season?.year), 'SEASON_INVALID', '球員統計缺少逐列賽季');
      if (record.season.year !== year) continue;
      assertNba(Array.isArray(record.stats) && record.stats.length === category.names.length, 'SCHEMA_INVALID', '球員歷年統計欄位無法對齊');
      const recordTeam = record.teamId == null ? null : teams[record.teamSlug];
      if (record.teamId != null) assertNba(recordTeam?.sourceId === record.teamId, 'TEAM_IDENTITY_MISMATCH', '球員歷史統計隊伍 ID 無法核對');
      rows.push({ season: normalizeSeason({ year, type }), team: recordTeam, teamLabel: recordTeam?.name || '多隊合計', aggregateAcrossTeams: record.teamId == null, category: category.name, categoryLabel: category.displayName || category.name, statistics: category.names.map((name, index) => ({ name, label: category.labels?.[index] || name, value: null, displayValue: typeof record.stats[index] === 'string' ? record.stats[index] : '—' })) });
    }
  }
  return rows;
}

export async function loadNbaData({ view = 'schedule', date, id, season, seasonType = 'regular' } = {}, options = {}) {
  const now = options.now ?? Date.now;
  const clock = () => Number(typeof now === 'function' ? now() : now);
  const updatedAt = new Date(clock()).toISOString();
  let cache = options.cache || nbaCache;
  if (options.fetchImpl && !options.cache) {
    if (!testCaches.has(options.fetchImpl)) testCaches.set(options.fetchImpl, createNbaCache());
    cache = testCaches.get(options.fetchImpl);
  }
  const data = emptyData(); const sources = []; const issues = [];
  let successfulSources = 0;
  async function get(path, validate, ttlMs = 60000) {
    const url = path.startsWith('https://') ? path : `${BASE}${path}`;
    try {
      const validateSource = raw => {
        validate(raw);
        for (const timestamp of [raw?.meta?.lastUpdatedAt, raw?.timestamp]) {
          if (timestamp != null) assertNba(safeTime(timestamp), 'DATE_INVALID', '來源發布時間缺少明確時區或日期時間格式無效');
        }
      };
      const fetched = await cache.fetchJson(url, { fetchImpl: options.fetchImpl, now: clock, ttlMs, timeoutMs: options.timeoutMs ?? 20000, validate: validateSource });
      sources.push(fetched.source); successfulSources += 1;
      if (fetched.source.status === 'stale') issues.push(issue('STALE_CACHE', '資料來源暫時失效，顯示上次成功資料與原始擷取時間'));
      if (!fetched.source.publishedAt) issues.push(issue('SOURCE_PUBLICATION_UNKNOWN', '來源未提供發布時間；擷取時間不等於資料發布時間'));
      if (fetched.source.publishedAt && Date.parse(fetched.source.publishedAt) > clock() + 60000) issues.push(issue('SOURCE_TIMESTAMP_FUTURE', '資料來源時間晚於目前時間，尚待核對'));
      return fetched;
    } catch (error) {
      sources.push({ provider: 'ESPN', role: 'secondary', url, fetchedAt: new Date(clock()).toISOString(), retrievedAt: null, publishedAt: null, hash: null, status: 'unavailable', errorCode: error.code || 'UPSTREAM_UNAVAILABLE', officialIdentityVerified: false });
      throw error;
    }
  }
  try {
    assertNba(['schedule', 'teams', 'game', 'team', 'player', 'injuries', 'history'].includes(view), 'VIEW_INVALID', '不支援的 NBA 資料頁籤');
    if (view === 'schedule') {
      const selected = date || taipeiDate(updatedAt);
      assertNba(validDate(selected), 'DATE_INVALID', '日期必須為有效 YYYY-MM-DD');
      const previous = new Date(Date.parse(`${selected}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const next = new Date(Date.parse(`${selected}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      const path = `scoreboard?dates=${previous.replaceAll('-', '')}-${next.replaceAll('-', '')}&limit=1000`;
      const { value, source } = await get(path, validateScoreboard);
      data.games = uniqueGames(value.events.map(event => normalizeGame(event, value.leagues[0].season))).filter(game => game.taipeiDate === selected).map(game => ({ ...game, sourceUrl: source.url, retrievedAt: source.fetchedAt }));
      data.date = selected; data.timeZone = 'Asia/Taipei';
      data.seasonTypes = [...new Set(data.games.map(game => game.seasonType))];
      data.availability.schedule = data.games.length ? 'available' : 'no_games_for_selected_date';
    } else if (view === 'teams') {
      const { value } = await get('teams?limit=1000', validateTeams, 6 * 3600000);
      data.teams = value.sports[0].leagues[0].teams.map(entry => normalizeTeam(entry.team));
      data.availability.teams = data.teams.length ? 'available' : 'empty';
    } else if (view === 'game') {
      const gameId = sourceId(id, 'game');
      const { value, source } = await get(`summary?event=${gameId}`, raw => validateSummary(raw, gameId));
      data.game = { ...normalizeGame(value.header), sourceUrl: source.url, retrievedAt: source.fetchedAt, venue: value.gameInfo?.venue?.fullName || null };
      data.players = summaryPlayers(value, data.game);
      for (const block of value.boxscore?.teams || []) {
        const team = normalizeTeam(block.team);
        const side = data.game.home.id === team.id ? 'home' : 'away';
        data.game[side].statistics = normalizeStatistics(block.statistics);
      }
      data.lineups = [data.game.away, data.game.home].map(team => ({ teamId: team.id, players: data.players.filter(player => player.teamId === team.id && player.starter), status: data.players.some(player => player.teamId === team.id && player.starter) ? data.game.completed ? 'actual_postgame' : data.game.status === 'live' ? 'actual_in_game' : 'provider_reported' : 'unconfirmed', pregameConfirmedAt: null }));
      data.availability = { boxscore: data.players.length ? 'available' : 'not_yet_available', lineups: data.lineups.every(lineup => lineup.players.length === 5) ? 'available' : 'unconfirmed', historicalInjuries: 'unavailable_point_in_time_snapshot_required', playerOnOff: 'unavailable', usage: 'unavailable' };
      issues.push(issue('HISTORICAL_INJURY_SNAPSHOT_MISSING', '此場賽前傷病快照尚未取得，未將目前傷病回填歷史賽事'));
      if (data.game.completed) issues.push(issue('LINEUP_POSTGAME_ONLY', '先發來自賽後 box score，不能視為賽前已知資料'));
    } else if (view === 'team') {
      const teamId = sourceId(id, 'team');
      assertNba(ESPN_NBA_TEAMS[teamId], 'TEAM_IDENTITY_MISMATCH', 'NBA 球隊 ID 不在已核對清單');
      const year = season == null ? new Date(clock()).getUTCFullYear() : Number(season);
      assertNba(Number.isInteger(year) && year >= 1947 && year <= new Date(clock()).getUTCFullYear() + 1, 'SEASON_INVALID', 'NBA 賽季參數無效');
      const results = await Promise.allSettled([
        get(`teams/${teamId}/roster?season=${year}`, raw => validateRoster(raw, teamId), 15 * 60000),
        get(`teams/${teamId}/statistics?season=${year}`, raw => validateTeamStatistics(raw, teamId, year), 3600000)
      ]);
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === 'rejected') { issues.push(issue(result.reason.code || 'UPSTREAM_UNAVAILABLE', result.reason.message || 'NBA 部分資料未取得')); continue; }
        const raw = result.value.value;
        data.team = normalizeTeam(raw.team);
        if (index === 0) {
          data.players = raw.athletes.map(player => ({ ...normalizePlayer(player, data.team.id), statistics: [], starterStatus: 'unknown', rosterTemporalBasis: 'provider_roster_retrieved_now', historicalMembershipVerified: false }));
          data.availability.roster = 'available_current_snapshot';
          issues.push(issue('ROSTER_NOT_POINT_IN_TIME', '球員名單為目前擷取的來源快照，未證實是該歷史日期的名單'));
        } else {
          data.statistics = raw.results.stats.categories.flatMap(category => normalizeStatistics(category.stats).map(stat => ({ ...stat, category: category.displayName || category.name })));
          data.season = normalizeSeason(raw.requestedSeason);
          data.availability.teamStatistics = 'available';
        }
      }
      data.availability = { roster: 'unavailable', teamStatistics: 'unavailable', playerSeasonStatistics: 'available_in_player_view', playerGameStatistics: 'available_in_game_boxscore', playerOnOff: 'unavailable', usage: 'unavailable', ...data.availability };
    } else if (view === 'player') {
      const playerId = sourceId(id, 'player');
      const year = season == null ? new Date(clock()).getUTCFullYear() : Number(season);
      const type = { preseason: 1, regular: 2, postseason: 3 }[seasonType];
      assertNba(Number.isInteger(year) && year >= 1947 && year <= new Date(clock()).getUTCFullYear() + 1 && type, 'SEASON_INVALID', '球員統計賽季與賽事類型參數無效');
      const results = await Promise.allSettled([
        get(`${PLAYER_BASE}${playerId}`, raw => validatePlayerProfile(raw, playerId), 15 * 60000),
        get(`${PLAYER_BASE}${playerId}/stats?season=${year}&seasontype=${type}`, raw => normalizePlayerSeasons(raw, year, type), 3600000)
      ]);
      if (results[0].status === 'fulfilled') {
        const raw = results[0].value.value;
        data.team = raw.athlete.team?.id ? normalizeTeam(raw.athlete.team) : null;
        data.player = { ...normalizePlayer(raw.athlete, data.team?.id), teamTemporalBasis: 'current_profile_not_historical_membership' };
      } else issues.push(issue(results[0].reason.code || 'UPSTREAM_UNAVAILABLE', results[0].reason.message || '球員身分來源未取得'));
      if (results[1].status === 'fulfilled' && data.player) {
        const raw = results[1].value.value;
        data.playerSeasons = normalizePlayerSeasons(raw, year, type);
        data.availableSeasons = [...new Set(raw.categories.flatMap(category => category.statistics.map(record => record.season.year)))].sort((a, b) => b - a);
        data.statistics = data.playerSeasons.flatMap(row => row.statistics.map(stat => ({ ...stat, category: `${row.categoryLabel} · ${row.teamLabel}` })));
      } else if (results[1].status === 'rejected') issues.push(issue(results[1].reason.code || 'UPSTREAM_UNAVAILABLE', results[1].reason.message || '球員統計來源未取得'));
      data.season = normalizeSeason({ year, type });
      data.availability = { player: data.player ? 'available' : 'unavailable', playerSeasonStatistics: data.playerSeasons.length ? 'available_selected_season_and_type' : 'no_verified_rows_for_selection', historicalMembership: 'statistics_row_team_only', playerOnOff: 'unavailable', usage: 'unavailable' };
      issues.push(issue('PLAYER_STATS_SOURCE_BINDING', '球員 ID 已由個人資料核對；統計回應未重複提供球員 ID，依同一來源的球員網址關聯'));
    } else if (view === 'injuries') {
      const today = taipeiDate(updatedAt);
      assertNba(date == null || date === today, 'HISTORICAL_INJURY_UNAVAILABLE', '目前傷病來源不能作為歷史日期的傷病快照');
      const { value } = await get('injuries?limit=1000', normalizeInjuries, 5 * 60000);
      data.injuries = normalizeInjuries(value).map(record => ({ ...record, reportAgeMs: record.reportedAt ? clock() - Date.parse(record.reportedAt) : null, freshness: !record.reportedAt ? 'unknown' : Date.parse(record.reportedAt) > clock() + 60000 ? 'future_timestamp' : clock() - Date.parse(record.reportedAt) > 48 * 3600000 ? 'older_report' : 'recent_report' }));
      data.availability.injuries = 'secondary_latest_reports_official_unverified';
      data.date = today;
      issues.push(issue('OFFICIAL_INJURY_REPORT_UNVERIFIED', '目前顯示 ESPN 傷病報導，尚未逐筆與 NBA 官方傷病報告核對'));
      if (data.injuries.some(record => record.freshness !== 'recent_report')) issues.push(issue('INJURY_REPORT_AGE', '部分個別傷病報導較舊或時間未確認，請查看每筆報導時間'));
    } else if (view === 'history') {
      const teamId = sourceId(id, 'team');
      assertNba(ESPN_NBA_TEAMS[teamId], 'TEAM_IDENTITY_MISMATCH', 'NBA 歷史球隊 ID 無效');
      const year = Number(season);
      assertNba(Number.isInteger(year) && year >= 1947 && year <= new Date(clock()).getUTCFullYear() + 1, 'SEASON_INVALID', '歷史資料需要有效的 NBA 賽季結束年份');
      const type = { preseason: 1, regular: 2, postseason: 3 }[seasonType];
      assertNba(type, 'SEASON_INVALID', '歷史賽事類型無效');
      const parts = await Promise.allSettled([get(`teams/${teamId}/schedule?season=${year}&seasontype=${type}`, raw => validateHistory(raw, teamId, year, type), 3600000)]);
      for (const part of parts) {
        if (part.status === 'rejected') { issues.push(issue(part.reason.code || 'UPSTREAM_UNAVAILABLE', part.reason.message || '部分歷史賽程未取得')); continue; }
        const { value, source } = part.value;
        data.team = normalizeTeam(value.team);
        data.games.push(...value.events.map(event => ({ ...normalizeGame(event, value.requestedSeason), sourceUrl: source.url, retrievedAt: source.fetchedAt })).filter(game => game.completed && game.seasonType === seasonType));
      }
      data.games = uniqueGames(data.games);
      data.seasonTypes = [...new Set(data.games.map(game => game.seasonType))];
      data.season = { year, label: `${year - 1}–${String(year).slice(-2)}` };
      data.availability.history = data.games.length ? 'available_completed_games_only' : 'no_completed_games_returned';
      data.availability.pointInTimeFeatures = 'unavailable';
      issues.push(issue('HISTORY_POINT_IN_TIME_LIMITATION', '歷史比分可驗證；尚未具備當時可知的傷病、名單與完整進階特徵快照'));
    }
  } catch (error) {
    issues.push(issue(error.code || 'UPSTREAM_UNAVAILABLE', error instanceof NbaDataError ? error.message : 'NBA 資料暫時無法取得，請稍後重試'));
  }
  if (successfulSources) issues.push(issue('OFFICIAL_IDENTITY_UNVERIFIED', '來源已核對為 ESPN NBA；NBA 官方 ID 對照尚未驗證'));
  const returnedGames = data.game ? [data.game, ...data.games] : data.games;
  if (returnedGames.some(game => game.seasonType === 'unknown')) issues.push(issue('SEASON_TYPE_UNVERIFIED', '部分賽事尚未確認季前賽／例行賽／季後賽分類'));
  if (returnedGames.some(game => !game.timeConfirmed)) issues.push(issue('GAME_TIME_UNCONFIRMED', '部分開賽時間尚未由來源確認'));
  const uniqueIssues = [...new Map(issues.map(item => [item.code, item])).values()];
  const blocked = uniqueIssues.some(item => /IDENTITY|SCHEMA|SCORE_INVALID|SEASON_INVALID|DATE_INVALID|VIEW_INVALID/.test(item.code) && item.code !== 'OFFICIAL_IDENTITY_UNVERIFIED');
  const hasData = Boolean(data.game || data.team || data.player || data.games.length || data.teams.length || data.players.length || data.injuries.length);
  const failedSource = sources.some(source => source.status !== 'ready');
  const qaStatus = blocked ? 'BLOCK' : uniqueIssues.length ? 'WARNING' : 'PASS';
  const status = blocked || !successfulSources ? 'unavailable' : failedSource ? 'partial' : !hasData ? 'empty' : 'ready';
  return { league: 'NBA', moduleVersion: NBA_MODULE_VERSION, status, data: blocked ? emptyData() : data, sources, qa: { status: qaStatus, issues: uniqueIssues }, updatedAt };
}
