import { createHash } from 'node:crypto';
import { soccerLeague } from './contracts.js';
import { fetchSoccerJson, normalizeSoccerSchedule, extractSoccerHalfTime, fetchSoccerSchedule } from './data.js';
const fail = reason => ({ ok: false, reason, status: 'PENDING', verified: false });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer = n => Number.isSafeInteger(n) && n >= 0;
function validSource(source, league, kind, eventId, now) {
  try {
    const url = new URL(source.url), at = Date.parse(source.fetchedAt);
    return source.provider === 'ESPN' && /^[a-f0-9]{64}$/.test(source.contentHash || '')
      && url.protocol === 'https:' && url.hostname === 'site.api.espn.com' && !url.port && !url.username && !url.password && !url.hash
      && url.pathname === `/apis/site/v2/sports/soccer/${league.espnSlug}/${kind}`
      && (kind !== 'summary' || url.searchParams.get('event') === eventId)
      && at <= now && now - at < 15 * 60000;
  } catch { return false; }
}

// This is an ESPN two-endpoint crosscheck, not an independent governing-body
// result or approval of the bookmaker's settlement terms.
export function normalizeSoccerSettlementResult(record, summary, scoreboard, now = Date.now()) {
  const league = soccerLeague(record?.league), id = record?.gameId?.split(':').at(-1);
  if (!league || !/^\d{1,16}$/.test(id || '') || record.gameId !== `soccer:${league.id}:${id}`) return fail('RESULT_GAME_IDENTITY_INVALID');
  if (!summary?.ok || !validSource(summary.source, league, 'summary', id, now)) return fail('RESULT_SUMMARY_SOURCE_UNVERIFIED');
  const payload = summary.data, header = payload?.header, competition = header?.competitions?.[0];
  if (String(header?.id) !== id || !competition) return fail('RESULT_SUMMARY_IDENTITY_MISMATCH');
  const normalized = normalizeSoccerSchedule({ leagues: [header.league], events: [{ ...header, date: competition.date, status: competition.status, format: payload.format, keyEvents: payload.keyEvents }] }, league.id, summary.source);
  const game = normalized.games?.[0];
  if (!normalized.ok || !game || game.id !== record.gameId || game.date !== record.date || game.startTime !== record.startTime) return fail('RESULT_GAME_SCOPE_MISMATCH');
  const expectedIds = record.teamIds || record.identityEvidence?.teamIds;
  if (!expectedIds || !['home', 'away'].every(side => expectedIds[side] === game[side].id)) return fail('RESULT_ORIGINAL_TEAM_IDENTITIES_UNVERIFIED');
  if (game.status !== 'final' || competition.status?.type?.name !== 'STATUS_FULL_TIME'
    || competition.status?.type?.completed !== true || competition.status?.type?.state !== 'post'
    || Date.parse(game.startTime) >= now) return fail('RESULT_NORMAL_FINAL_UNCONFIRMED');
  if (payload.keyEvents!==undefined&&!Array.isArray(payload.keyEvents)
    || competition.competitors.some(team=>team.linescores!==undefined&&!Array.isArray(team.linescores))) return fail('RESULT_PERIOD_SCHEMA_UNVERIFIED');
  if (payload.format?.regulation && (payload.format.regulation.periods!==2||payload.format.regulation.clock!==2700)) return fail('RESULT_REGULATION_FORMAT_UNVERIFIED');
  // STATUS_FULL_TIME is the provider's regulation result. Extra-time/shootout
  // final states and explicit extra periods cannot enter this normal-only path.
  if ((payload.keyEvents || []).some(e => Number(e.period?.number) > 2)
    || competition.competitors.some(team => (team.linescores || []).length>2||(team.linescores || []).some(p => Number(p.period) > 2))) return fail('RESULT_EXTRA_PERIODS_REQUIRE_REVIEW');
  const cross = scoreboard?.games?.filter(g => g.id === game.id) || [];
  if (!scoreboard?.ok || scoreboard.freshness?.stale === true || cross.length !== 1) return fail('RESULT_SCOREBOARD_CROSSCHECK_UNAVAILABLE');
  const other = cross[0], source = other.source;
  if (!validSource(source, league, 'scoreboard', id, now) || other.league !== league.id || other.status !== 'final' || other.date !== game.date || other.startTime !== game.startTime
    || !['home', 'away'].every(side => other[side]?.id === game[side].id && other[side]?.score === game[side].score)) return fail('RESULT_ENDPOINTS_DISAGREE');
  if (!['home', 'away'].every(side => integer(game[side].score))) return fail('RESULT_SCORE_MISSING');
  const extracted = extractSoccerHalfTime({ competition, status: competition.status, format: payload.format, keyEvents: payload.keyEvents, source: summary.source });
  const result = { ok: true, verified: true, status: 'NORMAL_FINAL_CROSSCHECKED', league: league.id, gameId: game.id,
    date: game.date, startTime: game.startTime, teamIds: { home: game.home.id, away: game.away.id },
    fullTime: { home: game.home.score, away: game.away.score, period: 'REGULATION_FT' },
    halfTime: extracted.halfTime ? { ...extracted.halfTime, period: 'REGULATION_HT' } : null,
    halfTimeMissingReason: extracted.reason, sources: [summary.source, source], observedAt: new Date(now).toISOString(),
    evidenceScope: 'ESPN_TWO_ENDPOINT_CROSSCHECK_NOT_INDEPENDENT_OFFICIAL_CONFIRMATION' };
  return { ...result, resultHash: hash({ gameId: game.id, league: league.id, date: game.date, startTime: game.startTime,
    teamIds: result.teamIds, fullTime: result.fullTime, halfTime: result.halfTime ? { home: result.halfTime.home, away: result.halfTime.away, period: result.halfTime.period } : null,
    sourceHashes: result.sources.map(s => s.contentHash) }) };
}
export async function fetchSoccerSettlementResult(record, options = {}) {
  const league = soccerLeague(record?.league), id = record?.gameId?.split(':').at(-1);
  if (!league || !/^\d{1,16}$/.test(id || '')) return fail('RESULT_GAME_IDENTITY_INVALID');
  const [summary, scoreboard] = await Promise.all([
    fetchSoccerJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${id}`, { ...options, ttlMs: 60000 }),
    fetchSoccerSchedule(league.id, record.date, { ...options, windowDays: 1 }),
  ]);
  return normalizeSoccerSettlementResult(record, summary, scoreboard, options.now?.() ?? Date.now());
}
