import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { durableDatabaseUrl } from '../database-url.js';
import { normalizeNbaManualBetRecord } from './manual-bet-record.js';
import { nbaManualContractHash } from './manual-bet-settlement.js';
import { nbaManualPerformanceBet } from './performance-ledger.js';
import { validDate } from './identity.js';

let client, schema;
function database() {
  const url = durableDatabaseUrl();
  if (!url) throw Object.assign(new Error('永久帳本目前無法使用；紀錄尚未保存。'), { status: 503 });
  return client ||= neon(url);
}
async function prepare(db) {
  schema ||= (async () => { await db`CREATE TABLE IF NOT EXISTS nba_manual_bet_records_v1 (
    position_key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE,
    board_date TEXT NOT NULL, payload JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
    await db`CREATE TABLE IF NOT EXISTS nba_manual_bet_settlements_v1 (
      record_id TEXT PRIMARY KEY REFERENCES nba_manual_bet_records_v1(id),
      contract_hash TEXT NOT NULL, payload JSONB NOT NULL,
      settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await db`CREATE INDEX IF NOT EXISTS nba_manual_bet_records_read_v1
      ON nba_manual_bet_records_v1 (recorded_at DESC, id DESC)`;
  })().catch(error => { schema = null; throw error; });
  await schema;
}
function hydrate(row) {
  if (!row.settlement) return row.payload;
  if (row.settlement.contractHash !== nbaManualContractHash(row.payload)) throw new Error('NBA settlement contract hash mismatch');
  return { ...row.payload, settlementStatus: 'SETTLED', settlement: row.settlement };
}
export async function listNbaManualBetRecords(date, { db = null, prepareSchema = true } = {}) {
  db ||= database(); if (prepareSchema) await prepare(db);
  const rows = await db`SELECT r.payload, s.payload AS settlement FROM nba_manual_bet_records_v1 r
    LEFT JOIN nba_manual_bet_settlements_v1 s ON s.record_id = r.id
    WHERE r.board_date = ${date} ORDER BY r.recorded_at DESC LIMIT 500`;
  return rows.map(hydrate);
}

function performanceReadError(message, code = 'NBA_PERFORMANCE_READ_OPTIONS_INVALID') {
  return Object.assign(new Error(message), { status: 400, code });
}
export function normalizeNbaPerformanceReadOptions(value = {}) {
  const date = value.date == null || value.date === '' ? null : String(value.date);
  if (date != null && !validDate(date)) throw performanceReadError('NBA 帳本日期不正確。');
  const limit = value.limit == null || value.limit === '' ? 500 : Number(value.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw performanceReadError('NBA 帳本每頁筆數不正確。');
  let cursor = null;
  if (value.cursor != null && value.cursor !== '') {
    try {
      const token = String(value.cursor);
      if (token.length > 600 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid cursor');
      cursor = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      if (!cursor || cursor.v !== 1 || cursor.kind !== 'NBA_PERFORMANCE'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id || '')
        || typeof cursor.recordedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.recordedAt)
        || !validDate(cursor.recordedAt.slice(0, 10)) || !Number.isFinite(Date.parse(cursor.recordedAt))
        || cursor.date !== date) throw new Error('invalid cursor');
    } catch { throw performanceReadError('NBA 帳本分頁識別不正確，請重新載入第一頁。', 'NBA_PERFORMANCE_READ_CURSOR_INVALID'); }
  }
  return { date, limit, cursor };
}

// Every page returns the full-filter count and one lookahead row. The keyset
// retains PostgreSQL microseconds and a unique ID, including identical times;
// the browser must finish all pages before publishing all-history statistics.
export async function listNbaPerformanceLedgerPage(value = {}, { db = null, prepareSchema = true } = {}) {
  const { date, limit, cursor } = normalizeNbaPerformanceReadOptions(value);
  db ||= database(); if (prepareSchema) await prepare(db);
  const rows = await db`WITH total AS (
      SELECT COUNT(*)::text AS total_records FROM nba_manual_bet_records_v1
      WHERE (${date}::text IS NULL OR board_date = ${date})
    ), selected AS (
      SELECT r.id, r.recorded_at, r.payload, s.payload AS settlement,
        TO_CHAR(r.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_recorded_at
      FROM nba_manual_bet_records_v1 r
      LEFT JOIN nba_manual_bet_settlements_v1 s ON s.record_id = r.id
      WHERE (${date}::text IS NULL OR r.board_date = ${date})
        AND (${cursor?.recordedAt || null}::timestamptz IS NULL
          OR (r.recorded_at, r.id) < (${cursor?.recordedAt || null}::timestamptz, ${cursor?.id || null}::text))
      ORDER BY r.recorded_at DESC, r.id DESC LIMIT ${limit + 1}
    ) SELECT total.total_records, selected.id, selected.payload, selected.settlement, selected.cursor_recorded_at
      FROM total LEFT JOIN selected ON TRUE ORDER BY selected.recorded_at DESC NULLS LAST, selected.id DESC`;
  if (!Array.isArray(rows) || !rows.length || rows[0]?.total_records == null) {
    throw Object.assign(new Error('NBA 帳本未回傳可核對的總筆數。'), { code: 'NBA_PERFORMANCE_READ_INCOMPLETE', status: 503 });
  }
  const totalRecords = Number(rows[0].total_records);
  if (!Number.isSafeInteger(totalRecords) || totalRecords < 0) {
    throw Object.assign(new Error('NBA 帳本總筆數不正確。'), { code: 'NBA_PERFORMANCE_READ_INCOMPLETE', status: 503 });
  }
  const rawRows = rows.filter(row => row.id != null), hasMore = rawRows.length > limit;
  const pageRows = rawRows.slice(0, limit);
  const bets = pageRows.map(row => row.payload?.id === row.id ? nbaManualPerformanceBet({
    ...row.payload,
    ...(row.settlement ? { settlementStatus: 'SETTLED', settlement: row.settlement } : {}),
  }) : null).filter(Boolean);
  const last = pageRows.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
    v: 1, kind: 'NBA_PERFORMANCE', recordedAt: last.cursor_recorded_at, id: last.id, date,
  })).toString('base64url') : null;
  if (nextCursor) normalizeNbaPerformanceReadOptions({ date, limit, cursor: nextCursor });
  return { bets, pagination: {
    limit, date, league: 'NBA', totalRecords, returnedRecords: bets.length,
    invalidRecordsOnPage: pageRows.length - bets.length, hasMore, nextCursor,
  } };
}
export async function listUnsettledNbaManualRecords({ date = null, throughDate, limit = 100 }, { db = null, prepareSchema = true } = {}) {
  db ||= database(); if (prepareSchema) await prepare(db);
  const rows = await db`SELECT r.payload FROM nba_manual_bet_records_v1 r
    LEFT JOIN nba_manual_bet_settlements_v1 s ON s.record_id = r.id
    WHERE s.record_id IS NULL AND COALESCE(r.payload->>'status', 'OPEN') = 'OPEN'
      AND r.board_date <= ${throughDate} AND (${date}::text IS NULL OR r.board_date = ${date})
    ORDER BY r.recorded_at DESC LIMIT ${Math.min(500, Math.max(1, Math.floor(limit)))}`;
  return rows.map(row => row.payload);
}
export async function archiveNbaManualSettlement(record, settlement, { db = null, prepareSchema = true } = {}) {
  if (settlement.status !== 'SETTLED' || settlement.contractHash !== nbaManualContractHash(record)) throw new Error('NBA settlement contract mismatch');
  db ||= database(); if (prepareSchema) await prepare(db);
  // Append one result per immutable contract. An atomic OPEN condition prevents
  // a cancelled record from being settled by an overlapping cron/UI request.
  const rows = await db`INSERT INTO nba_manual_bet_settlements_v1 (record_id, contract_hash, payload)
    SELECT r.id, ${settlement.contractHash}, ${JSON.stringify(settlement)}::jsonb
    FROM nba_manual_bet_records_v1 r WHERE r.id = ${record.id}
      AND COALESCE(r.payload->>'status', 'OPEN') = 'OPEN'
    ON CONFLICT (record_id) DO NOTHING RETURNING payload`;
  const saved = rows.length ? rows : await db`SELECT payload FROM nba_manual_bet_settlements_v1 WHERE record_id = ${record.id}`;
  if (!saved[0]) return { settlement: null, created: false };
  if (saved[0].payload.contractHash !== settlement.contractHash) throw new Error('NBA stored settlement contract mismatch');
  return { settlement: saved[0].payload, created: rows.length > 0, persistence: 'durable_database' };
}
export async function archiveNbaManualBetRecord(input, { db = null, prepareSchema = true, now = Date.now(), id = randomUUID() } = {}) {
  const record = normalizeNbaManualBetRecord(input);
  const key = [record.date, record.gameId, record.marketKey, record.side].join('|');
  const payload = { ...record, id, status: 'OPEN', recordedAt: new Date(now).toISOString() };
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

export async function changeNbaManualBetRecordStatus(id, action, { db = null, prepareSchema = true, now = Date.now() } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '') || !['cancel', 'restore'].includes(action)) {
    throw Object.assign(new Error('紀錄識別或操作不正確。'), { status: 400 });
  }
  db ||= database(); if (prepareSchema) await prepare(db);
  const target = action === 'cancel' ? 'CANCELLED' : 'OPEN';
  const previous = action === 'cancel' ? 'OPEN' : 'CANCELLED';
  const at = new Date(now).toISOString();
  const patch = JSON.stringify({ status: target, [action === 'cancel' ? 'cancelledAt' : 'restoredAt']: at });
  const event = JSON.stringify([{ action, at }]);
  const changed = await db`UPDATE nba_manual_bet_records_v1
    SET payload = payload || ${patch}::jsonb || jsonb_build_object('recordHistory', COALESCE(payload->'recordHistory', '[]'::jsonb) || ${event}::jsonb)
    WHERE id = ${id} AND COALESCE(payload->>'status', 'OPEN') = ${previous} RETURNING payload`;
  const rows = changed.length ? changed : await db`SELECT payload FROM nba_manual_bet_records_v1 WHERE id = ${id}`;
  if (!rows[0]?.payload || (rows[0].payload.status || 'OPEN') !== target) throw Object.assign(new Error('紀錄不存在或狀態已改變，請重新讀取。'), { status: 400 });
  const joined = await db`SELECT r.payload, s.payload AS settlement FROM nba_manual_bet_records_v1 r
    LEFT JOIN nba_manual_bet_settlements_v1 s ON s.record_id = r.id WHERE r.id = ${id}`;
  return { record: hydrate(joined[0] || rows[0]), changed: changed.length > 0, persistence: 'durable_database' };
}
