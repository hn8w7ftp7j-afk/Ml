export const NHL_IDENTITY_VERSION = 'NHL-IDENTITY-v1.0.0';
const explicitTimestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && validNhlDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

export function nhlDate(value) {
  if (!(value instanceof Date) && !(typeof value === 'number' && Number.isFinite(value)) && !explicitTimestamp(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed) : null;
}

export function validNhlDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function positiveId(value) { return (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null; }

export function normalizeNhlTeam(team) {
  const id = positiveId(team?.id ?? team?.teamId);
  const abbrev = String(team?.abbrev || team?.triCode || '').toUpperCase();
  if (!id || !/^[A-Z]{2,3}$/.test(abbrev)) return null;
  const place = team?.placeName?.default || team?.placeName || '';
  const common = team?.commonName?.default || team?.commonName || '';
  return { leagueId: 'NHL', teamId: id, identityKey: `NHL:team:${id}`, abbrev, name: [place, common].filter(Boolean).join(' ') || abbrev };
}

export function normalizeNhlPlayer(player, { teamId = null, source = null } = {}) {
  const playerId = positiveId(player?.id ?? player?.playerId);
  if (!playerId) return null;
  const first = player?.firstName?.default || player?.firstName || '';
  const last = player?.lastName?.default || player?.lastName || '';
  return { leagueId: 'NHL', playerId, identityKey: `NHL:player:${playerId}`, teamId: positiveId(teamId ?? player?.currentTeamId), name: [first, last].filter(Boolean).join(' ') || player?.name?.default || null, position: player?.position || player?.positionCode || null, shootsCatches: player?.shootsCatches || null, sweaterNumber: player?.sweaterNumber ?? null, source };
}

export function validateNhlIdentity(game, expected = null) {
  const issues = [];
  const gameId = String(positiveId(game?.gameId ?? game?.id) ?? '');
  const season = positiveId(game?.season);
  const gameType = positiveId(game?.gameType);
  const awayTeamId = positiveId(game?.awayTeamId ?? game?.awayTeam?.id);
  const homeTeamId = positiveId(game?.homeTeamId ?? game?.homeTeam?.id);
  const startTimeUTC = game?.startTimeUTC;
  if ((game?.leagueId && game.leagueId !== 'NHL') || (game?.league && game.league !== 'NHL')) issues.push('NHL_LEAGUE_MISMATCH');
  if (!/^\d{10}$/.test(gameId) || ![1, 2, 3].includes(gameType) || Number(gameId.slice(4, 6)) !== gameType) issues.push('NHL_GAME_IDENTITY_INVALID');
  if (!/^\d{8}$/.test(String(season)) || Number(String(season).slice(4)) !== Number(String(season).slice(0, 4)) + 1 || gameId.slice(0, 4) !== String(season).slice(0, 4)) issues.push('NHL_SEASON_IDENTITY_INVALID');
  if (!awayTeamId || !homeTeamId || awayTeamId === homeTeamId) issues.push('NHL_TEAM_IDENTITY_INVALID');
  if (!explicitTimestamp(startTimeUTC)) issues.push('NHL_START_TIME_INVALID');
  if (expected) {
    for (const key of ['gameId', 'season', 'gameType', 'awayTeamId', 'homeTeamId', 'startTimeUTC']) {
      const actual = key === 'gameId' ? gameId : key === 'awayTeamId' ? awayTeamId : key === 'homeTeamId' ? homeTeamId : game?.[key];
      if (expected[key] != null && String(actual) !== String(expected[key])) issues.push(`NHL_IDENTITY_MISMATCH_${key}`);
    }
    if (expected.leagueId && expected.leagueId !== 'NHL') issues.push('NHL_LEAGUE_MISMATCH');
    if (expected.taipeiDate && nhlDate(startTimeUTC) !== expected.taipeiDate) issues.push('NHL_BOARD_DATE_MISMATCH');
  }
  return { ok: issues.length === 0, status: issues.length ? 'BLOCK' : 'PASS', issues, identityKey: issues.length ? null : `NHL:${gameId}:${awayTeamId}:${homeTeamId}:${startTimeUTC}` };
}

export function verifyNhlPlayerMembership(player, roster, expectedTeamId) {
  const playerId = positiveId(player?.playerId ?? player?.id);
  return Boolean(playerId && positiveId(expectedTeamId) && roster?.teamId === Number(expectedTeamId) && roster?.players?.some(row => row.playerId === playerId && row.teamId === Number(expectedTeamId)));
}

export function normalizeNhlGoalieEvidence(evidence, { game, roster, now = Date.now() } = {}) {
  if (!evidence) return { status: 'UNKNOWN', playerId: null, source: null, issues: ['NHL_GOALIE_UNCONFIRMED'] };
  const issues = [];
  const playerId = positiveId(evidence.playerId);
  const teamId = positiveId(evidence.teamId);
  const status = ['PROJECTED', 'CONFIRMED'].includes(evidence.status) ? evidence.status : 'UNKNOWN';
  const availableAt = evidence.availableAt || evidence.source?.publishedAt;
  const fetchedAt = evidence.source?.fetchedAt;
  if (String(evidence.gameId) !== String(game?.gameId) || ![game?.awayTeamId, game?.homeTeamId].includes(teamId)) issues.push('NHL_GOALIE_GAME_IDENTITY_MISMATCH');
  if (!playerId || !verifyNhlPlayerMembership({ playerId }, roster, teamId) || !roster?.players?.some(row => row.playerId === playerId && row.position === 'G')) issues.push('NHL_GOALIE_PLAYER_IDENTITY_MISMATCH');
  if (!/^https:\/\//.test(String(evidence.source?.url || '')) || typeof now !== 'number' || !Number.isFinite(now) || !explicitTimestamp(availableAt) || !explicitTimestamp(fetchedAt) || Date.parse(availableAt) > now || Date.parse(fetchedAt) > now || Date.parse(availableAt) > Date.parse(fetchedAt)) issues.push('NHL_GOALIE_SOURCE_UNVERIFIED');
  if (status === 'CONFIRMED' && evidence.source?.confirmationExplicit !== true) issues.push('NHL_GOALIE_CONFIRMATION_NOT_EXPLICIT');
  return { leagueId: 'NHL', gameId: game?.gameId, teamId, playerId, status: issues.length ? 'UNKNOWN' : status, availableAt: availableAt || null, source: evidence.source || null, issues };
}

export function detectNhlGoalieChange(previous, current) {
  if (!previous || !current || previous.gameId !== current.gameId || previous.teamId !== current.teamId) return { changed: false, invalidateAnalysis: false, issue: previous && current ? 'NHL_GOALIE_SNAPSHOT_IDENTITY_MISMATCH' : null };
  const chronological = Date.parse(current.availableAt || current.source?.fetchedAt) >= Date.parse(previous.availableAt || previous.source?.fetchedAt);
  if (!chronological) return { changed: false, invalidateAnalysis: false, issue: 'NHL_GOALIE_UPDATE_OUT_OF_ORDER' };
  const changed = previous.playerId !== current.playerId || previous.status !== current.status;
  return { changed, invalidateAnalysis: changed, issue: changed ? 'NHL_GOALIE_CHANGED' : null, previousPlayerId: previous.playerId, currentPlayerId: current.playerId };
}
