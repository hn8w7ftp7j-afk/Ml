import {neon} from '@neondatabase/serverless';
import {durableDatabaseUrl} from '../database-url.js';
import {assertNba, validDate} from './identity.js';
import {validateNbaLiveHistoryRow} from './live-history.js';

let client, clientUrl;
const schemaByClient = new WeakMap();
function sql() {const url = durableDatabaseUrl(); if (!url) throw Error('NBA 自動歷史資料庫尚未設定'); if (!client || clientUrl !== url) {client = neon(url); clientUrl = url;} return client;}
export const NBA_LIVE_HISTORY_SCHEMA = `CREATE TABLE IF NOT EXISTS sports_nba_live_history_v1 (
 game_id TEXT PRIMARY KEY, revision TEXT NOT NULL, outcome_hash TEXT NOT NULL,
 game_date DATE NOT NULL, season_year INTEGER NOT NULL, season_type TEXT NOT NULL,
 captured_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK (payload->>'league'='NBA'), CHECK (payload->>'kind'='NBA_VERIFIED_LIVE_HISTORY'),
 CHECK (season_type IN ('preseason','regular','postseason')))`;
async function init(db) {
  let schema = schemaByClient.get(db);
  if (!schema) {
    schema = (typeof db.query === 'function' ? db.query(NBA_LIVE_HISTORY_SCHEMA) : db([NBA_LIVE_HISTORY_SCHEMA])).catch(error => {schemaByClient.delete(db); throw error;});
    schemaByClient.set(db,schema);
  }
  await schema;
}

export async function saveNbaLiveHistory(row, {sql:injected, now = Date.now} = {}) {
  validateNbaLiveHistoryRow(row,typeof now === 'function' ? now() : now); const db = injected || sql(); await init(db);
  // Different acquisitions of the same verified outcome are idempotent. A
  // changed outcome is a conflict to investigate, never an UPDATE/backfill.
  const inserted = await db`INSERT INTO sports_nba_live_history_v1
    (game_id,revision,outcome_hash,game_date,season_year,season_type,captured_at,payload)
    SELECT ${row.gameId},${row.recordHash},${row.outcomeHash},${row.date}::date,${row.year},${row.seasonType},${row.capturedAt}::timestamptz,${JSON.stringify(row)}::jsonb
    WHERE ${row.capturedAt}::timestamptz <= NOW()
    ON CONFLICT (game_id) DO NOTHING RETURNING revision,payload`;
  const saved = inserted.length ? inserted : await db`SELECT revision,payload FROM sports_nba_live_history_v1 WHERE game_id=${row.gameId}`;
  assertNba(saved.length === 1, 'NBA_LIVE_HISTORY_PERSISTENCE_INVALID', '已完賽歷史沒有永久保存回條');
  const previous = validateNbaLiveHistoryRow({...saved[0].payload, revision:saved[0].revision},typeof now === 'function' ? now() : now);
  assertNba(previous.gameId === row.gameId && previous.outcomeHash === row.outcomeHash, 'NBA_LIVE_HISTORY_CONFLICT', '同場比賽的已保存比分或資料衝突，禁止覆寫');
  return {persisted:true, inserted:inserted.length === 1, gameId:previous.gameId, revision:previous.recordHash, capturedAt:previous.capturedAt};
}

export async function loadNbaLiveHistory({beforeDate, seasonYear, limit = 20000} = {}, {sql:injected, now = Date.now} = {}) {
  assertNba(validDate(beforeDate) && (seasonYear == null || Number.isInteger(seasonYear) && seasonYear >= 1947 && seasonYear <= 2200) && Number.isInteger(limit) && limit > 0 && limit <= 20000, 'NBA_LIVE_HISTORY_QUERY_INVALID', '歷史截止日期、賽季或筆數無效');
  const db = injected || sql(); await init(db);
  const rows = await db`SELECT revision,payload FROM sports_nba_live_history_v1
    WHERE game_date < ${beforeDate}::date AND (${seasonYear ?? null}::integer IS NULL OR season_year=${seasonYear ?? null}::integer)
    ORDER BY game_date,game_id LIMIT ${limit + 1}`;
  assertNba(rows.length <= limit, 'NBA_LIVE_HISTORY_TRUNCATED', 'NBA 保存歷史超過讀取上限，不能靜默截斷訓練資料');
  return rows.map(record => {
    const row = validateNbaLiveHistoryRow({...record.payload, revision:record.revision},typeof now === 'function' ? now() : now);
    assertNba(row.date < beforeDate && (seasonYear == null || row.year === seasonYear), 'NBA_LIVE_HISTORY_QUERY_INVALID', '歷史查詢混入目標當日、未來或其他球季');
    return row;
  });
}
