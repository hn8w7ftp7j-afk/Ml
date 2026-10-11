import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';

let client;
const schemas = new WeakMap();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = payload => createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
const failure = (message, status = 503) => Object.assign(new Error(message), { status });
export const readerDatabaseRequired = options => Boolean(options.sql) ||
  (!Object.hasOwn(options, 'runtimeCache') && (process.env.VERCEL === '1' ||
    process.env.READER_STORE_MEMORY_ONLY !== 'true' && durableDatabaseConfigured()));

function database(options) {
  if (options.sql) return options.sql;
  if (!durableDatabaseConfigured()) throw failure('Reader 共用盤口資料庫尚未設定');
  return client ||= neon(durableDatabaseUrl());
}
async function schema(sql) {
  if (!schemas.has(sql)) {
    const pending = sql`CREATE TABLE IF NOT EXISTS sports_baseball_reader_boards_v1 (
      league TEXT NOT NULL,
      board_date TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      page_activity_at TIMESTAMPTZ NOT NULL,
      checksum TEXT NOT NULL,
      payload JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (league, board_date),
      CHECK (league IN ('MLB', 'NPB', 'KBO', 'CPBL')),
      CHECK (payload->>'league' = league),
      CHECK (payload->>'boardDate' = board_date)
    )`.catch(error => { schemas.delete(sql); throw error; });
    schemas.set(sql, pending);
  }
  await schemas.get(sql);
}
function verify(row, league, date = '') {
  const payload = row?.payload;
  if (!payload || payload.league !== league || (date && payload.boardDate !== date)
    || row.checksum !== digest(payload)) throw failure('Reader 共用盤口保存內容或校驗不一致');
  return payload;
}
export async function loadReaderDatabase(league, date = '', options = {}) {
  const sql = database(options); await schema(sql);
  const rows = date
    ? await sql`SELECT payload, checksum FROM sports_baseball_reader_boards_v1
        WHERE league=${league} AND board_date=${date} AND expires_at > NOW() LIMIT 1`
    : await sql`SELECT payload, checksum FROM sports_baseball_reader_boards_v1
        WHERE league=${league} AND expires_at > NOW() ORDER BY observed_at DESC, board_date DESC LIMIT 1`;
  return rows.length ? verify(rows[0], league, date) : null;
}
export async function storeReaderDatabase(payload, ttl, options = {}) {
  const sql = database(options); await schema(sql);
  if (![payload.observedAt, payload.pageActivityAt].every(value => Number.isFinite(Date.parse(value))))
    throw failure('Reader 共用盤口時間無效', 400);
  const serialized = JSON.stringify(payload);
  const checksum = digest(payload);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const saved = await sql`INSERT INTO sports_baseball_reader_boards_v1
      (league, board_date, observed_at, page_activity_at, checksum, payload, expires_at)
      VALUES (${payload.league}, ${payload.boardDate}, ${payload.observedAt}, ${payload.pageActivityAt},
        ${checksum}, ${serialized}::jsonb, ${expiresAt})
      ON CONFLICT (league, board_date) DO UPDATE SET
        observed_at=EXCLUDED.observed_at, page_activity_at=EXCLUDED.page_activity_at,
        checksum=EXCLUDED.checksum, payload=EXCLUDED.payload, expires_at=EXCLUDED.expires_at
      WHERE (EXCLUDED.observed_at > sports_baseball_reader_boards_v1.observed_at
        AND EXCLUDED.page_activity_at >= sports_baseball_reader_boards_v1.page_activity_at)
        OR EXCLUDED.checksum = sports_baseball_reader_boards_v1.checksum
      RETURNING payload, checksum`;
  if (saved.length !== 1) throw failure('已有較新的 Reader 盤口，已拒絕舊盤覆蓋', 409);
  verify(saved[0], payload.league, payload.boardDate);
  if (saved[0].checksum !== checksum) throw failure('Reader 共用盤口儲存回條不一致');
  console.info('[READER_DATABASE_SAVED]', { league: payload.league, boardDate: payload.boardDate, observedAt: payload.observedAt });
  return { memory: false, runtimeCache: false, database: true, durable: true,
    allRequiredWritesSucceeded: true, bytes: Buffer.byteLength(serialized) };
}
