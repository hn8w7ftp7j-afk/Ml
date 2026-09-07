import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { assertNba } from './identity.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let client; let schema;
function sql() { const url = durableDatabaseUrl(); if (!url) throw new Error('NBA 永久快照資料庫尚未設定'); return client ||= neon(url); }
async function init() {
  schema ||= sql()`CREATE TABLE IF NOT EXISTS sports_nba_pregame_v1 (
    game_id TEXT NOT NULL, revision TEXT NOT NULL, captured_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (game_id, revision), CHECK (payload->>'league' = 'NBA'))`.catch(error => { schema = null; throw error; });
  await schema;
}
export function validateNbaPregame(payload, now = Date.now()) {
  assertNba(payload?.league === 'NBA' && /^nba:espn:game:[1-9]\d+$/.test(payload.gameId || '') && payload.gameId === payload.game?.id && payload.game?.league === 'NBA' && payload.game.status === 'scheduled' && payload.game.timeConfirmed === true, 'PREGAME_INVALID', '快照必須是已核對且尚未開賽的 NBA 場次');
  const captured = Date.parse(payload.capturedAt); const start = Date.parse(payload.game.startTime);
  assertNba(payload.gameId === `nba:espn:game:${payload.game.sourceId}`, 'PREGAME_INVALID', '來源場次 ID 不一致');
  assertNba(Number.isFinite(captured) && Number.isFinite(start) && captured <= now && captured < start, 'PREGAME_INVALID', '不能把賽後取得資料回填成賽前快照');
  assertNba(Array.isArray(payload.sources) && payload.sources.length >= 1 && payload.sources.every(source => {
    const time = Date.parse(source.fetchedAt); let url; try { url = new URL(source.url); } catch { return false; }
    return url.origin === 'https://site.api.espn.com' && url.pathname.startsWith('/apis/site/v2/sports/basketball/nba/') && /^[a-f0-9]{64}$/.test(source.hash || '') && source.status === 'ready' && Number.isFinite(time) && time <= captured && captured - time <= 300000;
  }), 'PREGAME_INVALID', '快照來源缺失、過期或身分不符');
  assertNba(payload.sources.some(s => new URL(s.url).pathname.endsWith('/summary') && new URL(s.url).searchParams.get('event') === payload.game.sourceId), 'PREGAME_INVALID', '缺少此場次原始摘要來源');
  assertNba(payload.officialLineupConfirmed === false && payload.modelInputEnabled === false, 'PREGAME_INVALID', '來源報導不能冒充官方確認或自動成為模型輸入');
  const teams = [payload.game.home.id, payload.game.away.id];
  assertNba(teams.every(id => /^nba:espn:team:[1-9]\d*$/.test(id)), 'PREGAME_INVALID', 'NBA 球隊 ID 無效');
  assertNba(teams[0] !== teams[1] && Array.isArray(payload.lineups) && payload.lineups.length === 2 && new Set(payload.lineups.map(l => l.teamId)).size === 2 && payload.lineups.every(l => teams.includes(l.teamId) && Array.isArray(l.players) && l.players.every(p => p.teamId === l.teamId && /^nba:espn:player:[1-9]\d+$/.test(p.id))), 'PREGAME_INVALID', '賽前陣容身分無效');
  const players = payload.lineups.flatMap(l => l.players); assertNba(new Set(players.map(p => p.id)).size === players.length, 'PREGAME_INVALID', '賽前球員重複');
  assertNba(Array.isArray(payload.injuries) && payload.injuries.every(r => teams.includes(r.team.id) && r.player.teamId === r.team.id && (!r.reportedAt || Date.parse(r.reportedAt) <= captured)), 'PREGAME_INVALID', '傷病球員／球隊或報告時間不符');
  assertNba(!payload.injuries.length || payload.sources.some(s => new URL(s.url).pathname.endsWith('/injuries')), 'PREGAME_INVALID', '缺少傷病原始來源');
  return true;
}
export function buildNbaPregame(gameResult, injuryResult, now = Date.now()) {
  assertNba(gameResult?.qa?.status !== 'BLOCK' && gameResult?.status === 'ready', 'PREGAME_INVALID', '場次 QA 未通過');
  const game = gameResult.data.game; const teams = [game.home.id, game.away.id];
  const injuryReady = injuryResult?.status === 'ready' && injuryResult.qa?.status !== 'BLOCK';
  const payload = { league: 'NBA', gameId: game.id, game, capturedAt: new Date(now).toISOString(), sources: [...gameResult.sources, ...(injuryReady ? injuryResult.sources : [])], lineups: gameResult.data.lineups, injuries: injuryReady ? injuryResult.data.injuries.filter(r => teams.includes(r.team.id)) : [], injuryStatus: injuryReady ? 'provider_latest_observation_not_game_official_report' : 'source_missing', lineupStatus: gameResult.data.lineups.every(l => l.players.length === 5) ? 'provider_reported_not_official' : 'unconfirmed', officialLineupConfirmed: false, modelInputEnabled: false };
  validateNbaPregame(payload, now); return payload;
}
export async function saveNbaPregame(payload) {
  validateNbaPregame(payload); await init();
  // Identical evidence is idempotent; new observations append, never overwrite.
  const revision = hash({ ...payload, capturedAt: undefined });
  const rows = await sql()`INSERT INTO sports_nba_pregame_v1 (game_id, revision, captured_at, payload)
    VALUES (${payload.gameId}, ${revision}, ${payload.capturedAt}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT DO NOTHING RETURNING revision`;
  return { persisted: true, inserted: rows.length === 1, revision };
}
export async function loadNbaPregame(gameId) {
  assertNba(/^nba:espn:game:[1-9]\d+$/.test(gameId), 'PREGAME_INVALID', 'NBA 場次 ID 無效'); await init();
  const rows = await sql()`SELECT revision, payload FROM sports_nba_pregame_v1 WHERE game_id=${gameId} ORDER BY captured_at DESC LIMIT 20`;
  return rows.map(row => { validateNbaPregame(row.payload); assertNba(row.payload.gameId === gameId && hash({ ...row.payload, capturedAt: undefined }) === row.revision, 'PREGAME_INVALID', '快照雜湊或場次不符'); return { ...row.payload, revision: row.revision }; });
}
