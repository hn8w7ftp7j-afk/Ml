import { validateNhlIdentity, validNhlDate } from './identity.js';
import { allowedNhlPersonnelUrl } from './personnel-feed.js';

const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && validNhlDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const positions = new Set(['C', 'L', 'R', 'LW', 'RW', 'F', 'D', 'G']);
const identityEvidence = value => [
  ...(Array.isArray(value?.identitySources) ? value.identitySources : []),
  ...(Array.isArray(value?.players) ? value.players.flatMap(row => Array.isArray(row?.identitySources) ? row.identitySources : []) : []),
];
function completionTime(value) {
  const times = [value?.source?.observedAt, ...identityEvidence(value).map(proof => proof?.fetchedAt)];
  return times.every(time) ? new Date(Math.max(...times.map(Date.parse))).toISOString() : null;
}

// Only server-created, matched official personnel records enter this store.
// No public endpoint accepts a user-supplied confirmation or a replacement ID.
export function validateNhlPersonnelObservation(payload, key, { now = Date.now() } = {}) {
  const errors = [];
  const game = payload?.gameIdentity;
  const value = payload?.personnel;
  if (payload?.league !== 'NHL' || payload?.gameId !== key || game?.league !== 'NHL'
    || !validateNhlIdentity(game).ok || game?.gameId !== key) errors.push('NHL_PERSONNEL_SNAPSHOT_GAME_INVALID');
  // A source may explicitly quarantine unresolved names while retaining its
  // valid lines. Persist that evidence and its visible QA; never promote it to
  // a clean record merely because the source could be acquired.
  if (value?.league !== 'NHL' || value?.leagueId !== 'NHL' || value?.gameId !== key || value?.ok !== true || value?.matched !== true
    || !['PASS', 'WARNING', 'BLOCK'].includes(value?.qa?.status) || !digest(value?.revision)) errors.push('NHL_PERSONNEL_SNAPSHOT_NOT_VERIFIED');
  const source = value?.source;
  if (source?.provider !== 'NHL_EDITORIAL' || !allowedNhlPersonnelUrl(source?.url) || !digest(source?.contentHash)
    || !time(source?.observedAt) || !time(source?.availableAt) || !time(source?.sourcePublishedAt)
    || !Number.isFinite(now) || (source?.sourceUpdatedAt != null && !time(source.sourceUpdatedAt))
    || source?.availableAt !== (source?.sourceUpdatedAt || source?.sourcePublishedAt)
    || !time(payload?.observedAt) || payload?.observedAt !== completionTime(value)
    || Date.parse(source?.availableAt) > Date.parse(source?.observedAt)
    || Date.parse(source?.sourcePublishedAt) > Date.parse(source?.availableAt)
    || Date.parse(payload?.observedAt) > now) errors.push('NHL_PERSONNEL_SNAPSHOT_SOURCE_INVALID');
  const players = Array.isArray(value?.players) ? value.players : [];
  if (!players.length || new Set(players.map(row => row?.playerId)).size !== players.length
    || players.some(row => !Number.isSafeInteger(row?.playerId) || row.playerId <= 0
      || ![game?.awayTeamId, game?.homeTeamId].includes(row?.teamId)
      || typeof row.name !== 'string' || !row.name.trim() || !positions.has(row.position))) errors.push('NHL_PERSONNEL_SNAPSHOT_PLAYERS_INVALID');
  const sourceAgrees = row => row?.sourceUrl === source?.url
    && row?.sourcePublishedAt === source?.sourcePublishedAt
    && (row?.sourceUpdatedAt ?? null) === (source?.sourceUpdatedAt ?? null)
    && row?.observedAt === source?.observedAt
    && row?.availableAt === source?.availableAt && same(row?.source, source);
  if (players.some(row => !sourceAgrees(row))) errors.push('NHL_PERSONNEL_SNAPSHOT_PLAYER_SOURCE_INVALID');
  const allowedProofUrls = ['away', 'home'].flatMap(side => [
    `https://api-web.nhle.com/v1/roster/${game?.[`${side}Abbrev`]}/${game?.season}`,
    `https://api-web.nhle.com/v1/club-stats/${game?.[`${side}Abbrev`]}/${game?.season}/${game?.gameType}`,
  ]);
  if (value?.identitySources != null && (!Array.isArray(value.identitySources) || value.identitySources.some(proof => proof?.provider !== 'NHL'
    || !allowedProofUrls.includes(proof.url) || !digest(proof.contentHash) || !time(proof.fetchedAt) || Date.parse(proof.fetchedAt) > now))) errors.push('NHL_PERSONNEL_SNAPSHOT_MEMBERSHIP_INVALID');
  for (const row of players) {
    const side = row?.teamId === game?.awayTeamId ? 'away' : 'home';
    const abbrev = game?.[`${side}Abbrev`];
    const urls = [`https://api-web.nhle.com/v1/roster/${abbrev}/${game?.season}`,
      `https://api-web.nhle.com/v1/club-stats/${abbrev}/${game?.season}/${game?.gameType}`];
    if (!/^[A-Z]{2,3}$/.test(abbrev || '') || !Array.isArray(row?.identitySources) || !row.identitySources.length
      || !['OFFICIAL_SEASON_ROSTER_AND_ARTICLE_TEAM_BLOCK', 'OFFICIAL_SEASON_PARTICIPATION_AND_ARTICLE_TEAM_BLOCK'].includes(row?.membershipBasis)
      || row.identitySources.some(proof => proof?.provider !== 'NHL' || !urls.includes(proof.url)
        || !digest(proof.contentHash) || !time(proof.fetchedAt) || Date.parse(proof.fetchedAt) > now)) errors.push('NHL_PERSONNEL_SNAPSHOT_MEMBERSHIP_INVALID');
    if (value?.pointInTimeEligible === true && Array.isArray(row?.identitySources)
      && row.identitySources.some(proof => !time(proof?.fetchedAt) || Date.parse(proof.fetchedAt) > Date.parse(game?.startTimeUTC))) errors.push('NHL_PERSONNEL_SNAPSHOT_PIT_INVALID');
  }
  const catalog = new Map(players.map(row => [row?.playerId, row]));
  const exposed = new Set();
  for (const side of ['away', 'home']) {
    const teamId = game?.[`${side}TeamId`];
    const team = value?.teams?.[side];
    const goalie = value?.goalies?.[side];
    if (team?.teamId !== teamId || !['PROJECTED', 'CONFIRMED', 'BLOCK', 'PARTIAL'].includes(team?.lineupStatus)
      || !Array.isArray(team?.lineCombinations) || !Array.isArray(team?.defensivePairings)
      || !Array.isArray(team?.listedGoalies)
      || (team?.injuries != null && !Array.isArray(team.injuries))
      || (team?.scratched != null && !Array.isArray(team.scratched))) errors.push('NHL_PERSONNEL_SNAPSHOT_TEAM_INVALID');
    const nested = [];
    for (const [field, allowed, size] of [['lineCombinations', ['C', 'L', 'R', 'LW', 'RW', 'F'], 3], ['defensivePairings', ['D'], 2]]) {
      for (const group of Array.isArray(team?.[field]) ? team[field] : []) {
        if (!Array.isArray(group) || group.length !== size || group.some(row => !allowed.includes(row?.position))) {
          errors.push('NHL_PERSONNEL_SNAPSHOT_LINE_INVALID'); continue;
        }
        nested.push(...group);
      }
    }
    for (const field of ['listedGoalies', 'injuries', 'scratched']) {
      if (Array.isArray(team?.[field])) nested.push(...team[field]);
    }
    if (Array.isArray(team?.listedGoalies) && team.listedGoalies.some(row => row?.position !== 'G')) errors.push('NHL_PERSONNEL_SNAPSHOT_GOALIE_INVALID');
    for (const row of nested) {
      if (row?.teamId !== teamId || !same(row, catalog.get(row?.playerId)) || exposed.has(row?.playerId)) errors.push('NHL_PERSONNEL_SNAPSHOT_NESTED_PLAYER_INVALID');
      exposed.add(row?.playerId);
    }
    if (team?.lineupStatus === 'BLOCK' && nested.length) errors.push('NHL_PERSONNEL_SNAPSHOT_QUARANTINE_INVALID');
    if (!same(goalie, team?.goalie)) errors.push('NHL_PERSONNEL_SNAPSHOT_GOALIE_INVALID');
    if (goalie?.status === 'UNKNOWN') {
      if (goalie.playerId != null || goalie.confirmationExplicit === true) errors.push('NHL_PERSONNEL_SNAPSHOT_GOALIE_INVALID');
      continue;
    }
    if (!['PROJECTED', 'CONFIRMED'].includes(goalie?.status) || goalie?.teamId !== teamId
      || goalie?.gameId !== key || !players.some(row => row?.playerId === goalie?.playerId && row?.teamId === teamId && row?.position === 'G')
      || !Array.isArray(team?.listedGoalies) || !team.listedGoalies.some(row => row?.playerId === goalie?.playerId)
      || !sourceAgrees(goalie)
      || (goalie?.status === 'CONFIRMED' && goalie?.confirmationExplicit !== true)) errors.push('NHL_PERSONNEL_SNAPSHOT_GOALIE_INVALID');
  }
  if (exposed.size !== players.length || players.some(row => !exposed.has(row?.playerId))) errors.push('NHL_PERSONNEL_SNAPSHOT_CATALOG_MISMATCH');
  if (value?.pointInTimeEligible === true && (!time(game?.startTimeUTC)
    || Date.parse(source?.availableAt) > Date.parse(game.startTimeUTC)
    || Date.parse(payload?.observedAt) > Date.parse(game.startTimeUTC))) errors.push('NHL_PERSONNEL_SNAPSHOT_PIT_INVALID');
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function makeNhlPersonnelObservation(game, personnel, options = {}) {
  const gameIdentity = Object.fromEntries(['league', 'leagueId', 'gameId', 'season', 'gameType', 'awayTeamId', 'homeTeamId', 'awayAbbrev', 'homeAbbrev', 'startTimeUTC', 'officialDate', 'taipeiDate'].map(key => [key, game[key]]));
  gameIdentity.awayAbbrev = game.awayAbbrev || game.away?.abbrev;
  gameIdentity.homeAbbrev = game.homeAbbrev || game.home?.abbrev;
  // Article retrieval can finish before roster/participation identity checks.
  // Record completion is the latest acquisition, not the HTTP request start or
  // an older article timestamp. Preserve each original source timestamp.
  const payload = { league: 'NHL', gameId: game.gameId, observedAt: completionTime(personnel), gameIdentity, personnel };
  const validation = validateNhlPersonnelObservation(payload, game.gameId, options);
  if (!validation.ok) throw Object.assign(new Error('NHL 人員來源快照未通過身分或時間核對'), { code: 'NHL_PERSONNEL_SNAPSHOT_INVALID', status: 422, issues: validation.errors });
  return payload;
}

export function nhlPersonnelFreshness(personnel, now = Date.now()) {
  const available = personnel?.source?.availableAt;
  const maxAgeMs = personnel?.freshness?.maxAgeMs;
  if (!time(available) || !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || Date.parse(available) > now)
    return { fresh: false, ageSeconds: null, maxAgeMs: maxAgeMs ?? null, basis: 'ARTICLE_LAST_PUBLISHED_REVISION_NOT_FETCH_TIME' };
  return { fresh: now - Date.parse(available) <= maxAgeMs, ageSeconds: Math.floor((now - Date.parse(available)) / 1000), maxAgeMs,
    basis: 'ARTICLE_LAST_PUBLISHED_REVISION_NOT_FETCH_TIME' };
}
