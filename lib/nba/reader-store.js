import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { validDate } from './identity.js';
import { NBA_READER_VERSION, assertNbaReaderMonotonic, nbaReaderError } from './reader.js';

export const NBA_READER_TABLE = 'sports_nba_reader_boards_v1';
const memory = new Map();
const pending = new Map();
const schemaByClient = new WeakMap();
let client;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const checksum = snapshot => createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
const memoryOnly = options => !options.sql && process.env.VERCEL !== '1' && process.env.READER_STORE_MEMORY_ONLY === 'true';
function databaseClient(options) {
  if (options.sql) return options.sql;
  const url = durableDatabaseUrl();
  if (!url) throw nbaReaderError('NBA_READER_DATABASE_UNAVAILABLE', 'NBA 盤口資料庫尚未可用', 503);
  return client ||= neon(url);
}
async function ensureSchema(sql) {
  if (!schemaByClient.has(sql)) {
    const schema = sql`CREATE TABLE IF NOT EXISTS sports_nba_reader_boards_v1 (
      board_date TEXT PRIMARY KEY,
      observed_at TIMESTAMPTZ NOT NULL,
      page_activity_at TIMESTAMPTZ NOT NULL,
      source_hash TEXT NOT NULL,
      checksum TEXT NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (payload->>'league' = 'NBA'),
      CHECK (payload->>'boardDate' = board_date),
      CHECK (payload->>'executable' = 'false')
    )`.catch(error => { schemaByClient.delete(sql); throw error; });
    schemaByClient.set(sql, schema);
  }
  await schemaByClient.get(sql);
}
function validEntry(entry, date = '') {
  const snapshot = entry?.payload;
  return snapshot?.version === NBA_READER_VERSION && snapshot.league === 'NBA' && snapshot.executable === false
    && validDate(snapshot.boardDate) && (!date || snapshot.boardDate === date)
    && Array.isArray(snapshot.games) && snapshot.games.length === snapshot.gameCount
    && snapshot.games.every(game => game.league === 'NBA' && game.home?.league === 'NBA' && game.away?.league === 'NBA')
    && entry.checksum === checksum(snapshot);
}
function verifiedPayload(row, date = '') {
  if (!validEntry(row, date)) throw nbaReaderError('NBA_READER_SNAPSHOT_INVALID', 'NBA 盤口保存身分或雜湊不一致', 503);
  return structuredClone(row.payload);
}
export async function loadNbaReaderSnapshot(date = '', options = {}) {
  if (date && !validDate(date)) throw nbaReaderError('NBA_READER_DATE_INVALID', 'NBA 日期必須是有效的 YYYY-MM-DD');
  if (memoryOnly(options)) {
    const rows = [...memory.values()].filter(row => !date || row.payload.boardDate === date)
      .sort((left, right) => Date.parse(right.payload.observedAt) - Date.parse(left.payload.observedAt));
    return rows.length ? verifiedPayload(rows[0], date) : null;
  }
  try {
    const sql = databaseClient(options); await ensureSchema(sql);
    // Every Production read uses the conditional-upsert authority. A non-CAS
    // Runtime Cache pointer can never replace a newer database observation.
    const rows = date
      ? await sql`SELECT payload, checksum FROM sports_nba_reader_boards_v1 WHERE board_date=${date} LIMIT 1`
      : await sql`SELECT payload, checksum FROM sports_nba_reader_boards_v1 ORDER BY observed_at DESC, board_date DESC LIMIT 1`;
    return rows.length ? verifiedPayload(rows[0], date) : null;
  } catch (error) {
    if (error.code?.startsWith('NBA_READER_')) throw error;
    throw nbaReaderError('NBA_READER_DATABASE_UNAVAILABLE', 'NBA 盤口資料庫暫時無法讀取', 503);
  }
}
export async function storeNbaReaderSnapshot(snapshot, options = {}) {
  const entry = { payload: structuredClone(snapshot), checksum: checksum(snapshot) };
  if (!validEntry(entry)) throw nbaReaderError('NBA_READER_SNAPSHOT_INVALID', 'NBA Reader 快照無效');
  if (memoryOnly(options)) {
    const previousWrite = pending.get('writes') || Promise.resolve();
    const operation = previousWrite.catch(() => {}).then(() => {
      assertNbaReaderMonotonic(memory.get(snapshot.boardDate)?.payload, snapshot);
      memory.set(snapshot.boardDate, entry);
      while (memory.size > 32) memory.delete(memory.keys().next().value);
      return { runtimeCache: false, storage: 'process_memory', durable: false };
    });
    pending.set('writes', operation);
    try { return await operation; } finally { if (pending.get('writes') === operation) pending.delete('writes'); }
  }
  try {
    const sql = databaseClient(options); await ensureSchema(sql);
    // PostgreSQL serializes contenders on the date's unique row and reevaluates
    // this condition after waiting. An older writer cannot overwrite a newer
    // observation, even when it read the old row on another Vercel invocation.
    const saved = await sql`INSERT INTO sports_nba_reader_boards_v1
      (board_date, observed_at, page_activity_at, source_hash, checksum, payload)
      VALUES (${snapshot.boardDate}, ${snapshot.observedAt}, ${snapshot.pageActivityAt}, ${snapshot.clientPayloadHash}, ${entry.checksum}, ${JSON.stringify(snapshot)}::jsonb)
      ON CONFLICT (board_date) DO UPDATE SET
        observed_at=EXCLUDED.observed_at,
        page_activity_at=EXCLUDED.page_activity_at,
        source_hash=EXCLUDED.source_hash,
        checksum=EXCLUDED.checksum,
        payload=EXCLUDED.payload,
        updated_at=NOW()
      WHERE EXCLUDED.observed_at > sports_nba_reader_boards_v1.observed_at
        AND EXCLUDED.page_activity_at >= sports_nba_reader_boards_v1.page_activity_at
        AND (EXCLUDED.source_hash = sports_nba_reader_boards_v1.source_hash
          OR EXCLUDED.page_activity_at > sports_nba_reader_boards_v1.page_activity_at)
      RETURNING payload, checksum`;
    if (saved.length !== 1) throw nbaReaderError('NBA_READER_REPLAY', 'NBA Reader 時間倒退或重播，已拒絕覆蓋', 409);
    const accepted = verifiedPayload(saved[0], snapshot.boardDate);
    if (saved[0].checksum !== entry.checksum || accepted.observedAt !== snapshot.observedAt) throw nbaReaderError('NBA_READER_SAVE_FAILED', 'NBA 盤口保存回條不一致', 503);
    const readback = await sql`SELECT payload, checksum FROM sports_nba_reader_boards_v1 WHERE board_date=${snapshot.boardDate} LIMIT 1`;
    if (readback.length !== 1) throw nbaReaderError('NBA_READER_SAVE_FAILED', 'NBA 盤口資料庫未確認保存', 503);
    verifiedPayload(readback[0], snapshot.boardDate);
    if (readback[0].checksum !== entry.checksum) throw nbaReaderError('NBA_READER_SUPERSEDED', '已有較新的 NBA 盤口，請重新同步', 409);
    return { runtimeCache: false, storage: 'database', durable: true, persisted: true };
  } catch (error) {
    if (error.code?.startsWith('NBA_READER_')) throw error;
    throw nbaReaderError('NBA_READER_SAVE_FAILED', 'NBA 盤口資料庫未確認保存，請重新同步', 503);
  }
}
