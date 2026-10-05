import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { durableDatabaseUrl } from '../database-url.js';
import { normalizeNbaManualBetRecord } from './manual-bet-record.js';

let client, schema;
function database() {
  const url = durableDatabaseUrl();
  if (!url) throw Object.assign(new Error('永久帳本目前無法使用；紀錄尚未保存。'), { status: 503 });
  return client ||= neon(url);
}
async function prepare(db) {
  schema ||= db`CREATE TABLE IF NOT EXISTS nba_manual_bet_records_v1 (
    position_key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE,
    board_date TEXT NOT NULL, payload JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`.catch(error => { schema = null; throw error; });
  await schema;
}
export async function listNbaManualBetRecords(date) {
  const db = database(); await prepare(db);
  const rows = await db`SELECT payload FROM nba_manual_bet_records_v1 WHERE board_date = ${date} ORDER BY recorded_at DESC LIMIT 500`;
  return rows.map(row => row.payload);
}
export async function archiveNbaManualBetRecord(input, { db = null, prepareSchema = true, now = Date.now(), id = randomUUID() } = {}) {
  const record = normalizeNbaManualBetRecord(input);
  const key = [record.date, record.gameId, record.marketKey, record.side].join('|');
  const payload = { ...record, id, recordedAt: new Date(now).toISOString() };
  db ||= database(); if (prepareSchema) await prepare(db);
  // Reanalysis, changed prices and double clicks cannot overwrite an archived
  // contract or make the already-recorded indicator disappear.
  const inserted = await db`INSERT INTO nba_manual_bet_records_v1 (position_key,id,board_date,payload)
    VALUES (${key},${id},${record.date},${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (position_key) DO NOTHING RETURNING payload`;
  const rows = inserted.length ? inserted : await db`SELECT payload FROM nba_manual_bet_records_v1 WHERE position_key = ${key}`;
  if (!rows[0]?.payload?.id) throw Object.assign(new Error('未取得永久保存確認；請重新讀取紀錄確認。'), { status: 503 });
  return { record: rows[0].payload, created: inserted.length > 0, persistence: 'durable_database' };
}
