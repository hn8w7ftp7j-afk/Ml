// Current-game observations only. These fields never change model coefficients.
import { ESPN_NBA_TEAMS, validDate } from './identity.js';
export const NBA_PERSONNEL_EVIDENCE_VERSION = 'nba-current-personnel-observation-v1';
const MAX_SOURCE_AGE_MS = 5 * 60000;
const MAX_REPORT_AGE_MS = 48 * 3600000;
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/';
const id = (value, kind) => typeof value === 'string' && new RegExp(`^nba:espn:${kind}:[1-9]\\d{0,14}$`).test(value);
const timestamp = value => typeof value === 'string' && validDate(value.slice(0, 10))
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const text = value => typeof value === 'string' ? value.slice(0, 2000) : null;
const limitations = [
  '傷停是來源當下報導，不是 NBA 官方本場最終出賽確認；未列名不等於健康。',
  '五名來源報導先發不等於官方確認；臨場先發仍可能改變。',
  '本場輪替、分鐘限制與確認上場分鐘尚未取得，不以歷史平均補值。',
  '觀測及保存不修改模型係數，亦不構成完成前瞻驗證。',
];

export function validNbaPersonnelTarget(game, now) {
  return game?.league === 'NBA' && id(game.id, 'game') && game.id === `nba:espn:game:${game.sourceId}`
    && game.status === 'scheduled' && game.completed !== true && game.timeConfirmed === true
    && Number.isFinite(now) && timestamp(game.startTime) > now
    && ['home', 'away'].every(side => id(game[side]?.id, 'team') && ESPN_NBA_TEAMS[game[side].id.split(':').at(-1)]) && game.home.id !== game.away.id;
}

function sourceCheck(result, endpoint, game, capturedAt) {
  if (result?.league !== 'NBA' || !['ready', 'empty'].includes(result.status) || !['PASS', 'WARNING'].includes(result.qa?.status)) return { ok: false, code: 'SOURCE_QA_UNAVAILABLE' };
  const sources = result.sources;
  if (!Array.isArray(sources) || !sources.length) return { ok: false, code: 'SOURCE_MISSING' };
  for (const source of sources) {
    let url; try { url = new URL(source.url); } catch { return { ok: false, code: 'SOURCE_URL_INVALID' }; }
    const fetched = timestamp(source.fetchedAt);
    if (url.origin !== new URL(BASE).origin || url.pathname !== `${new URL(BASE).pathname}${endpoint}` || url.username || url.password || url.hash
      || endpoint === 'summary' && url.searchParams.get('event') !== game.sourceId) return { ok: false, code: 'SOURCE_IDENTITY_INVALID' };
    if (source.status !== 'ready' || !/^[a-f0-9]{64}$/.test(source.hash || '') || !Number.isFinite(fetched)
      || fetched > capturedAt || capturedAt - fetched > MAX_SOURCE_AGE_MS) return { ok: false, code: 'SOURCE_STALE_OR_UNVERIFIED' };
    if (source.publishedAt != null && (!Number.isFinite(timestamp(source.publishedAt)) || timestamp(source.publishedAt) > capturedAt)) return { ok: false, code: 'SOURCE_PUBLICATION_FUTURE_OR_INVALID' };
  }
  return { ok: true, code: null };
}

function sourceRows(results) {
  return results.flatMap(result => Array.isArray(result?.sources) ? result.sources : []).map(source => ({
    provider: 'ESPN', url: text(source.url), hash: text(source.hash), status: text(source.status),
    fetchedAt: text(source.fetchedAt), publishedAt: text(source.publishedAt),
    publicationBasis: text(source.publicationBasis) || 'not_supplied', errorCode: text(source.errorCode),
  }));
}

function unknownLineups(game) {
  return ['away', 'home'].map(side => ({ teamId: game?.[side]?.id || null, status: 'unknown', players: [], officialConfirmed: false,
    confirmedAt: null, confirmedMinutes: null, rotationStatus: 'unknown' }));
}

function validPlayer(player, teamId) {
  return id(player?.id, 'player') && player.id === `nba:espn:player:${player.sourceId}` && player.teamId === teamId
    && typeof player.name === 'string' && player.name.trim().length > 0;
}

/** Validates already-normalized server results; never accepts a client lineup. */
export function buildNbaPersonnelEvidence(game, gameResult, injuryResult, capturedAt = Date.now()) {
  const evidence = { version: NBA_PERSONNEL_EVIDENCE_VERSION, league: 'NBA', gameId: game?.id || null,
    startTime: game?.startTime || null, capturedAt: Number.isFinite(capturedAt) ? new Date(capturedAt).toISOString() : null,
    status: 'unavailable', injuries: [], lineups: unknownLineups(game), sources: sourceRows([gameResult, injuryResult]),
    coverage: { game: 'unknown', injuries: 'unknown', officialInjuries: 'unknown', lineups: 'unknown', officialLineups: 'unknown', rotation: 'unknown', minutes: 'unknown' },
    officialLineupConfirmed: false, modelInputEnabled: false, strictPointInTime: false,
    temporalBasis: 'server_observed_before_tipoff_not_official_confirmation', issues: [], limitations: [...limitations] };
  if (!validNbaPersonnelTarget(game, capturedAt)) { evidence.status = 'blocked'; evidence.issues.push('TARGET_NOT_VERIFIED_PREGAME'); return evidence; }
  const summarySource = sourceCheck(gameResult, 'summary', game, capturedAt);
  if (!summarySource.ok) { evidence.issues.push(summarySource.code); return evidence; }
  const observed = gameResult.data?.game;
  if (!validNbaPersonnelTarget(observed, capturedAt) || observed.id !== game.id || observed.sourceId !== game.sourceId
    || timestamp(observed.startTime) !== timestamp(game.startTime)
    || ['home', 'away'].some(side => observed[side]?.id !== game[side]?.id)
    || game.seasonType && observed.seasonType !== game.seasonType
    || game.season?.year && observed.season?.year !== game.season.year) {
    evidence.status = 'blocked'; evidence.issues.push('CURRENT_GAME_IDENTITY_OR_START_CONFLICT'); return evidence;
  }
  evidence.coverage.game = 'verified_current_game_summary';
  const teams = [game.away.id, game.home.id]; const seen = new Set();
  const rawLineups = gameResult.data?.lineups;
  if (!Array.isArray(rawLineups) || rawLineups.length !== 2 || new Set(rawLineups.map(row => row?.teamId)).size !== 2
    || rawLineups.some(row => !teams.includes(row?.teamId) || !Array.isArray(row.players))) {
    evidence.issues.push('LINEUP_STRUCTURE_UNKNOWN');
  } else {
    evidence.lineups = teams.map(teamId => {
      const row = rawLineups.find(value => value.teamId === teamId); const players = []; let invalid = false;
      for (const player of row.players) {
        if (!validPlayer(player, teamId) || seen.has(player.id) || player.didNotPlay === true
          || player.starter !== true || player.starterStatus !== 'reported' || player.lineupTemporalBasis !== 'provider_pregame_report') { invalid = true; continue; }
        seen.add(player.id);
        players.push({ playerId: player.id, sourceId: player.sourceId, teamId, name: player.name,
          starterStatus: 'provider_reported', officialConfirmed: false, confirmedMinutes: null });
      }
      if (invalid || players.length > 5) { evidence.issues.push('LINEUP_PLAYER_IDENTITY_OR_STAGE_UNKNOWN'); return { ...unknownLineups(game).find(value => value.teamId === teamId), reason: 'identity_or_stage_unverified' }; }
      if (players.length !== 5) evidence.issues.push('LINEUP_INCOMPLETE');
      return { teamId, status: players.length === 5 ? 'provider_reported' : 'unknown', players,
        officialConfirmed: false, confirmedAt: null, confirmedMinutes: null, rotationStatus: 'unknown' };
    });
  }
  evidence.coverage.lineups = evidence.lineups.every(row => row.status === 'provider_reported') ? 'provider_reported_not_official' : 'unknown_or_incomplete';
  const injurySource = sourceCheck(injuryResult, 'injuries', game, capturedAt);
  if (!injurySource.ok || !Array.isArray(injuryResult?.data?.injuries)) {
    evidence.issues.push(injurySource.code || 'INJURY_STRUCTURE_UNKNOWN'); evidence.status = 'partial'; return evidence;
  }
  const duplicatePlayers = new Set(); const injuryPlayers = new Set();
  const rows = injuryResult.data.injuries.filter(row => teams.includes(row?.team?.id));
  for (const row of rows) { if (injuryPlayers.has(row.player?.id)) duplicatePlayers.add(row.player?.id); injuryPlayers.add(row.player?.id); }
  const statuses = new Set(['available', 'out', 'doubtful', 'questionable', 'probable', 'day-to-day', 'suspended', 'not with team']);
  evidence.injuries = rows.map(row => {
    const teamId = row.team.id; const knownPlayer = validPlayer(row.player, teamId) && !duplicatePlayers.has(row.player.id);
    const reported = timestamp(row.reportedAt); const reportedStatus = text(row.status) || 'Unknown';
    let reason = null;
    if (!knownPlayer) reason = 'player_identity_unknown';
    else if (!Number.isFinite(reported)) reason = 'report_time_unknown';
    else if (reported > capturedAt) reason = 'report_time_future';
    else if (capturedAt - reported > MAX_REPORT_AGE_MS) reason = 'report_older_than_48_hours';
    else if (/not\s+(?:yet\s+)?submitted/i.test(reportedStatus) || !statuses.has(reportedStatus.toLowerCase())) reason = 'participation_status_unknown';
    if (reason) evidence.issues.push(`INJURY_${reason.toUpperCase()}`);
    return { gameId: game.id, startTime: game.startTime, teamId, playerId: knownPlayer ? row.player.id : null,
      sourceId: knownPlayer ? row.player.sourceId : null, name: text(row.player?.name),
      status: reason ? 'unknown' : 'provider_reported', reportedStatus,
      reportedAt: text(row.reportedAt), reason: text(row.description) || [row.bodyPart, row.detail, row.side].filter(value => typeof value === 'string').join(' · ') || null,
      unknownReason: reason, officialReportVerified: false, modelInputEnabled: false,
      identityBasis: knownPlayer ? 'provider_injury_team_player_ids_not_official_game_roster' : 'unresolved_not_guessed' };
  });
  evidence.coverage.injuries = rows.length ? evidence.injuries.every(row => row.status === 'provider_reported')
    ? 'provider_latest_reports_not_official' : 'provider_reports_with_unknown_rows' : 'no_matching_report_not_confirmed_health';
  evidence.status = evidence.coverage.lineups === 'provider_reported_not_official' && rows.length
    && evidence.injuries.every(row => row.status === 'provider_reported') ? 'ready' : 'partial';
  evidence.issues = [...new Set(evidence.issues)];
  return evidence;
}

/** Only validated normalized rows enter the existing append-only snapshot store. */
export function nbaPersonnelSnapshotInputs(evidence, gameResult, injuryResult) {
  if (!['ready', 'partial'].includes(evidence?.status) || evidence.coverage?.game !== 'verified_current_game_summary') return null;
  const lineups = evidence.lineups.map(row => ({ teamId: row.teamId, status: row.status === 'provider_reported' ? 'provider_reported' : 'unconfirmed', pregameConfirmedAt: null,
    players: row.players.map(player => ({ id: player.playerId, sourceId: player.sourceId, teamId: row.teamId, name: player.name,
      starter: true, starterStatus: 'reported', lineupTemporalBasis: 'provider_pregame_report', didNotPlay: false, statistics: [] })) }));
  const safeGame = { ...gameResult, data: { ...gameResult.data, lineups } };
  const eligible = new Set(evidence.injuries.filter(row => row.status === 'provider_reported').map(row => row.playerId));
  const safeInjuries = eligible.size ? { ...injuryResult, data: { ...injuryResult.data, injuries: injuryResult.data.injuries.filter(row => eligible.has(row.player?.id)) } } : null;
  return { gameResult: safeGame, injuryResult: safeInjuries };
}
