import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from './database-url.js';

export const MARKET_LINE_HISTORY_QUERY_SCHEMA = 'market-line-history-query-v1';
export const MARKET_LINE_HISTORY_QUERY_LEAGUES = Object.freeze(['MLB', 'NPB', 'KBO', 'CPBL', 'NBA']);
export const MARKET_LINE_HISTORY_QUERY_HEADERS = Object.freeze({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
const MARKET_NAMES = Object.freeze(['全場讓分', '全場大小', '上半讓分', '上半大小']);
const PARAMS = new Set(['league', 'date', 'from', 'through', 'gameKey', 'limit', 'until', 'after']);
const MAX_CURSOR_LENGTH = 1400;

function queryError(code, message, status = 400) {
  const error = new Error(message); error.code = code; error.status = status; return error;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTimestamp(value, microseconds = false) {
  const pattern = microseconds
    ? /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/
    : /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
  return typeof value === 'string' && pattern.test(value) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

function validGameKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function cursorSecret(options) {
  const secret = options.secret ?? process.env.SESSION_SECRET;
  if (!secret) throw queryError('HISTORY_CURSOR_NOT_CONFIGURED', '歷史查詢游標驗證尚未設定', 503);
  return secret;
}

const filterHash = filters => createHash('sha256').update(JSON.stringify(filters)).digest('hex');
const sign = (payload, secret) => createHmac('sha256', secret).update(`MARKET-LINE-HISTORY-CURSOR-v1\n${payload}`).digest('base64url');

function decodeCursor(cursor, secret) {
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) {
    throw queryError('INVALID_QUERY', '歷史查詢游標格式錯誤');
  }
  const [payload, signature] = cursor.split('.');
  const expected = sign(payload, secret);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw queryError('INVALID_QUERY', '歷史查詢游標無效');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw queryError('INVALID_QUERY', '歷史查詢游標格式錯誤'); }
  if (decoded?.v !== 1 || !/^[a-f0-9]{64}$/.test(decoded.filtersHash || '') || !validTimestamp(decoded.until)
    || !validTimestamp(decoded.observedAt, true) || !MARKET_LINE_HISTORY_QUERY_LEAGUES.includes(decoded.league)
    || !validDate(decoded.boardDate) || !validGameKey(decoded.gameKey)
    || decoded.observedAt > decoded.until.replace(/(\.\d{3})Z$/, (_, milliseconds) => `${milliseconds}000Z`)) {
    throw queryError('INVALID_QUERY', '歷史查詢游標內容錯誤');
  }
  return decoded;
}

export function parseMarketLineHistoryQuery(params, options = {}) {
  for (const key of params.keys()) {
    if (!PARAMS.has(key) || params.getAll(key).length !== 1) throw queryError('INVALID_QUERY', '歷史查詢參數重複或不支援');
  }
  const league = params.get('league');
  if (league !== null && !MARKET_LINE_HISTORY_QUERY_LEAGUES.includes(league)) throw queryError('INVALID_QUERY', '不支援的聯盟');
  const date = params.get('date');
  let from = params.get('from'), through = params.get('through');
  if (date !== null) {
    if (from !== null || through !== null || !validDate(date)) throw queryError('INVALID_QUERY', '盤日與日期範圍不可混用');
    from = date; through = date;
  }
  if ((from !== null && !validDate(from)) || (through !== null && !validDate(through)) || (from && through && from > through)) {
    throw queryError('INVALID_QUERY', '盤日範圍錯誤');
  }
  const gameKey = params.get('gameKey');
  if (gameKey !== null && !validGameKey(gameKey)) throw queryError('INVALID_QUERY', '賽事識別碼錯誤');
  const limitText = params.get('limit') ?? '100';
  if (!/^[1-9]\d{0,2}$/.test(limitText) || Number(limitText) > 500) throw queryError('INVALID_QUERY', '每頁筆數需介於 1 與 500');
  const filters = { league, from, through, gameKey };
  const secret = cursorSecret(options);
  const afterText = params.get('after');
  const after = afterText === null ? null : decodeCursor(afterText, secret);
  if (after && after.filtersHash !== filterHash(filters)) throw queryError('INVALID_QUERY', '游標與查詢範圍不一致');
  const now = options.now ?? Date.now();
  const until = params.get('until') ?? after?.until ?? new Date(now).toISOString();
  if (!validTimestamp(until) || Date.parse(until) > now || (after && after.until !== until)) throw queryError('INVALID_QUERY', '截止時間無效或與游標不一致');
  return { filters, limit: Number(limitText), until, after, secret };
}

export function createMarketLineHistoryCursor(row, query) {
  const payload = Buffer.from(JSON.stringify({ v: 1, filtersHash: filterHash(query.filters), until: query.until,
    observedAt: row.observed_at, league: row.league, boardDate: row.board_date, gameKey: row.game_key })).toString('base64url');
  return `${payload}.${sign(payload, query.secret)}`;
}

const isWater = value => typeof value === 'number' && Number.isFinite(value);
const isLabel = value => typeof value === 'string' && value.length > 0 && value === value.trim();

// Do not re-parse credit lines into decimal handicaps: the saved string is the evidence.
export function expandMarketLineHistoryRow(row) {
  const issues = [];
  let compact;
  try { compact = typeof row.markets === 'string' ? JSON.parse(row.markets) : row.markets; }
  catch { issues.push('MARKETS_JSON_INVALID'); }
  const shapeValid = Array.isArray(compact) && compact.length === 4;
  if (!shapeValid && !issues.length) issues.push('MARKETS_SHAPE_INVALID');
  const nba = row.league === 'NBA';
  const nbaIdentity = nba ? String(row.game_key).split('|') : [];
  const nbaIdentityValid = !nba || (nbaIdentity.length === 3 && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(nbaIdentity[0])
    && isLabel(nbaIdentity[1]) && isLabel(nbaIdentity[2]) && nbaIdentity[1] !== nbaIdentity[2]);
  if (!nbaIdentityValid) issues.push('NBA_GAME_KEY_INVALID');
  const markets = MARKET_NAMES.map((market, index) => {
    const value = shapeValid ? compact[index] : undefined;
    if (shapeValid && value === null) return { market, status: 'NOT_CAPTURED', directions: [] };
    let valid = false, directions = [];
    if (Array.isArray(value)) {
      if (!nba) {
        valid = value.length === 4 && isLabel(value[0]) && isWater(value[1]) && isLabel(value[2]) && isWater(value[3]);
        if (valid) directions = [{ side: null, pick: value[0], line: null, water: value[1] }, { side: null, pick: value[2], line: null, water: value[3] }];
      } else if (index % 2 === 0) {
        valid = nbaIdentityValid && value.length === 4 && [0, 1].includes(value[0]) && isLabel(value[1]) && isWater(value[2]) && isWater(value[3]);
        if (valid) directions = ['away', 'home'].map((side, sideIndex) => ({ side,
          pick: `${nbaIdentity[sideIndex + 1]}${value[0] === sideIndex ? '讓' : '受讓'}${value[1]}`,
          line: value[1], water: value[sideIndex + 2] }));
      } else {
        valid = value.length === 3 && isLabel(value[0]) && isWater(value[1]) && isWater(value[2]);
        if (valid) directions = [{ side: 'over', pick: `大${value[0]}`, line: value[0], water: value[1] },
          { side: 'under', pick: `小${value[0]}`, line: value[0], water: value[2] }];
      }
    }
    if (!valid && shapeValid) issues.push(`MARKET_${index}_INVALID`);
    return { market, status: valid ? 'AVAILABLE' : 'INVALID', directions, ...(!valid && value !== undefined ? { raw: value } : {}) };
  });
  if (shapeValid && compact.every(value => value === null)) issues.push('NO_CAPTURED_MARKETS');
  const stateHash = typeof row.state_hash === 'string' ? row.state_hash.trim() : '';
  // Hash the exact stored bytes, not expanded display labels. Corruption remains visible.
  if (typeof row.markets !== 'string' || !/^[a-f0-9]{16}$/.test(stateHash)
    || createHash('sha256').update(row.markets).digest('hex').slice(0, 16) !== stateHash) issues.push('STATE_HASH_MISMATCH');
  return { league: row.league, boardDate: row.board_date, gameKey: row.game_key,
    gamePk: row.game_pk == null ? null : String(row.game_pk), observedAt: row.observed_at,
    stateHash, sourceHash: row.source_hash?.trim() || null, readerVersion: row.reader_version || null,
    gameLabel: nbaIdentityValid && nba ? `${nbaIdentity[1]} @ ${nbaIdentity[2]} ${nbaIdentity[0]}` : `賽事 ${row.game_key}`,
    markets, integrity: { ok: issues.length === 0, issues }, rawMarkets: row.markets };
}

function count(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw queryError('HISTORY_READ_FAILED', '歷史統計資料無法安全讀取', 503);
  return number;
}

function summary(row) {
  return { ...(row.league ? { league: row.league } : {}), savedStates: count(row.saved_states), gameDateKeys: count(row.game_date_keys),
    boardDates: count(row.board_dates), firstBoardDate: row.first_board_date, lastBoardDate: row.last_board_date,
    firstObservedAt: row.first_observed_at, lastObservedAt: row.last_observed_at };
}

export async function queryMarketLineHistory(query, options = {}) {
  const databaseUrl = durableDatabaseUrl(options.env ?? process.env);
  if (!options.sql && !databaseUrl) throw queryError('HISTORY_DATABASE_NOT_CONFIGURED', '歷史盤口資料庫尚未設定', 503);
  const sql = options.sql || neon(databaseUrl);
  const { league, from, through, gameKey } = query.filters;
  const cursor = query.after;
  let result;
  try {
    // One statement keeps the page and whole-filter counts on the same PostgreSQL snapshot.
    // GET deliberately never ensures schema or writes anything.
    result = await sql`
      WITH filtered AS MATERIALIZED (
        SELECT league, board_date, game_key, game_pk::text AS game_pk, observed_at,
          state_hash, markets, source_hash, reader_version
        FROM tai888_market_line_history_v1
        WHERE observed_at <= ${query.until}::timestamptz
          AND (${league}::text IS NULL OR league = ${league})
          AND (${from}::date IS NULL OR board_date >= ${from}::date)
          AND (${through}::date IS NULL OR board_date <= ${through}::date)
          AND (${gameKey}::text IS NULL OR game_key = ${gameKey})
          AND league IN ('MLB', 'NPB', 'KBO', 'CPBL', 'NBA')
      ), league_summary AS (
        SELECT league, COUNT(*) AS saved_states, COUNT(DISTINCT (board_date, game_key)) AS game_date_keys,
          COUNT(DISTINCT board_date) AS board_dates, MIN(board_date)::text AS first_board_date,
          MAX(board_date)::text AS last_board_date,
          to_char(MIN(observed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_observed_at,
          to_char(MAX(observed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_observed_at
        FROM filtered GROUP BY league
      ), total_summary AS (
        SELECT COUNT(*) AS saved_states, COUNT(DISTINCT (league, board_date, game_key)) AS game_date_keys,
          COUNT(DISTINCT board_date) AS board_dates, MIN(board_date)::text AS first_board_date,
          MAX(board_date)::text AS last_board_date,
          to_char(MIN(observed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_observed_at,
          to_char(MAX(observed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_observed_at
        FROM filtered
      ), page AS (
        SELECT league, board_date::text AS board_date, game_key, game_pk,
          to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
          state_hash, markets, source_hash, reader_version
        FROM filtered
        WHERE (${cursor?.observedAt ?? null}::timestamptz IS NULL OR (observed_at, league, board_date, game_key)
          > (${cursor?.observedAt ?? null}::timestamptz, ${cursor?.league ?? null}::text, ${cursor?.boardDate ?? null}::date, ${cursor?.gameKey ?? null}::text))
        ORDER BY observed_at, league, board_date, game_key LIMIT ${query.limit + 1}
      )
      SELECT (SELECT to_jsonb(total_summary) FROM total_summary) AS totals,
        (SELECT COALESCE(jsonb_agg(to_jsonb(league_summary) ORDER BY league), '[]'::jsonb) FROM league_summary) AS leagues,
        (SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY observed_at, league, board_date, game_key), '[]'::jsonb) FROM page) AS rows
    `;
  } catch (error) {
    if (error?.code === '42P01') throw queryError('HISTORY_TABLE_NOT_READY', '歷史盤口資料表尚未建立，不能視為零筆', 503);
    throw queryError('HISTORY_READ_FAILED', '歷史盤口查詢失敗，請稍後重試', 503);
  }
  const envelope = result?.[0];
  if (!envelope?.totals || !Array.isArray(envelope.leagues) || !Array.isArray(envelope.rows)) throw queryError('HISTORY_READ_FAILED', '歷史查詢回應不完整', 503);
  const rows = envelope.rows.slice(0, query.limit);
  const hasMore = envelope.rows.length > query.limit;
  return { ok: true, schema: MARKET_LINE_HISTORY_QUERY_SCHEMA, sourceTable: 'tai888_market_line_history_v1',
    until: query.until, filters: query.filters, totals: summary(envelope.totals), leagues: envelope.leagues.map(summary),
    rows: rows.map(expandMarketLineHistoryRow), nextAfter: hasMore ? createMarketLineHistoryCursor(rows.at(-1), query) : null, hasMore,
    productionWrites: false, coverageComplete: false, cutoffBasis: 'observed_at',
    coverageNote: '僅統計此表已保存的盤口狀態；不代表全部賽事、全部變盤或可回測場數。截止時間依觀測時間，遲到補寫可能改變後續查詢。' };
}
