import { createNbaCache } from './cache.js';
import { assertNba, ESPN_NBA_TEAMS, normalizePlayer, normalizeTeam, sourceId, validDate } from './identity.js';

const URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries?limit=1000';
const cache = createNbaCache({ capacity: 2, maxStaleMs: 0 });
const safeTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function validateEnvelope(raw) {
  assertNba(raw?.status === 'success' && Array.isArray(raw.injuries), 'SCHEMA_INVALID', 'NBA 傷停來源結構無效');
  for (const value of [raw.timestamp, raw.meta?.lastUpdatedAt]) if (value != null) assertNba(safeTime(value), 'DATE_INVALID', 'NBA 傷停來源時間缺少明確時區');
}

/**
 * The full raw response remains the hashed source. Only unrelated-team rows are
 * out of scope; a group OR athlete mentioning a target team is strictly checked.
 * This does not relax the existing all-league injuries validator in data.js.
 */
export function normalizeTargetNbaInjuries(raw, game) {
  validateEnvelope(raw);
  assertNba(game?.league === 'NBA' && /^nba:espn:game:[1-9]\d*$/.test(game.id || '') && game.id === `nba:espn:game:${game.sourceId}`, 'GAME_IDENTITY_MISMATCH', '本場 NBA 身分無效');
  const targets = ['away', 'home'].map(side => sourceId(game[side]?.id, 'team'));
  assertNba(new Set(targets).size === 2 && targets.every(team => ESPN_NBA_TEAMS[team]), 'TEAM_IDENTITY_MISMATCH', '本場 NBA 球隊身分無效');
  const groups = raw.injuries.filter(group => targets.includes(group?.id)
    || Array.isArray(group?.injuries) && group.injuries.some(row => targets.includes(row?.athlete?.team?.id)));
  const groupIds = new Set(); const rows = []; const rowIds = new Map();
  for (const group of groups) {
    const teamId = sourceId(group.id, 'team');
    assertNba(targets.includes(teamId) && !groupIds.has(teamId) && Array.isArray(group.injuries), 'TEAM_IDENTITY_MISMATCH', '本場傷停球隊分組無效或衝突');
    groupIds.add(teamId);
    for (const record of group.injuries) {
      const team = normalizeTeam(record.athlete?.team);
      assertNba(team.sourceId === teamId, 'TEAM_IDENTITY_MISMATCH', '本場傷停球員隊伍與分組衝突');
      const player = normalizePlayer(record.athlete, team.id);
      const recordId = typeof record.id === 'string' || Number.isSafeInteger(record.id) ? String(record.id) : null;
      const row = { id: `nba:espn:injury:${teamId}:${player.sourceId}:${recordId ?? 'unreported'}`, sourceRecordId: recordId,
        player, team, status: typeof record.status === 'string' && record.status.trim() ? record.status : 'Unknown',
        bodyPart: typeof record.details?.type === 'string' ? record.details.type : null,
        detail: typeof record.details?.detail === 'string' ? record.details.detail : null,
        description: typeof record.shortComment === 'string' ? record.shortComment : typeof record.longComment === 'string' ? record.longComment : null,
        side: typeof record.details?.side === 'string' ? record.details.side : null,
        reportedAt: safeTime(record.date), expectedReturnDate: validDate(record.details?.returnDate) ? record.details.returnDate : null,
        temporalBasis: 'latest_report_only', officialReportVerified: false };
      if (rowIds.has(row.id)) assertNba(JSON.stringify(rowIds.get(row.id)) === JSON.stringify(row), 'PLAYER_IDENTITY_MISMATCH', '同一本場傷停識別有互相衝突的版本');
      else { rowIds.set(row.id, row); rows.push(row); }
    }
  }
  return { injuries: rows, targetTeamIds: targets.map(team => `nba:espn:team:${team}`), reportedTeamIds: [...groupIds].map(team => `nba:espn:team:${team}`) };
}

export async function loadTargetNbaInjuries(game, options = {}) {
  const now = options.now ?? Date.now; const clock = () => Number(typeof now === 'function' ? now() : now);
  let source = null;
  try {
    const currentCache = options.cache || (options.fetchImpl ? createNbaCache({ capacity: 2, maxStaleMs: 0 }) : cache);
    const fetched = await currentCache.fetchJson(URL, { fetchImpl: options.fetchImpl, now: clock, ttlMs: 60000,
      timeoutMs: options.timeoutMs ?? 6000, validate: validateEnvelope });
    source = fetched.source;
    // Revalidate the target after every cache hit, not only when caching a body.
    const data = normalizeTargetNbaInjuries(fetched.value, game);
    return { league: 'NBA', status: data.injuries.length ? 'ready' : 'empty', data, sources: [source],
      qa: { status: 'WARNING', issues: [{ code: 'CURRENT_INJURY_PROVIDER_ONLY', message: '本場來源傷停，不代表官方最終出賽確認；無報導不代表健康' }] } };
  } catch (error) {
    return { league: 'NBA', status: 'unavailable', data: { injuries: [] }, sources: source ? [source] : [],
      qa: { status: /IDENTITY|SCHEMA|DATE_INVALID/.test(error.code || '') ? 'BLOCK' : 'WARNING',
        issues: [{ code: error.code || 'INJURY_SOURCE_UNAVAILABLE', message: '本場傷停來源不可核對，保留未知' }] } };
  }
}
