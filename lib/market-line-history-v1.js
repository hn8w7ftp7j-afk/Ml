import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';
import { isLeagueId } from './leagues.js';

export const MARKET_LINE_HISTORY_VERSION = 'TAI888-LINE-HISTORY-v1.0.0';
export const MARKET_LINE_HISTORY_TABLE = 'tai888_market_line_history_v1';

const BASEBALL_MARKETS = Object.freeze(['全場讓分', '全場大小', '上半讓分', '上半大小']);
const NBA_MARKET_KEYS = Object.freeze(['fullRunline', 'fullTotal', 'firstHalfRunline', 'firstHalfTotal']);
let sqlClient;
const schemaByClient = new WeakMap();

function clean(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sourceHash(snapshot) {
  const value = clean(snapshot?.rawBoardHash || snapshot?.clientPayloadHash || snapshot?.payloadHash, 64).toLowerCase();
  return /^[a-f0-9]{64}$/.test(value) ? value.slice(0, 32) : null;
}

function stateHash(markets) {
  return createHash('sha256').update(JSON.stringify(markets)).digest('hex').slice(0, 16);
}

function baseballMarkets(game) {
  const rows = Array.isArray(game?.markets) ? game.markets : [];
  const compact = BASEBALL_MARKETS.map(market => {
    const pair = rows
      .filter(row => row?.market === market)
      .map(row => [clean(row?.pick, 100), finite(row?.water)])
      .filter(row => row[0] && row[1] != null)
      .sort((left, right) => left[0].localeCompare(right[0], 'zh-Hant'));
    return pair.length === 2 ? [pair[0][0], pair[0][1], pair[1][0], pair[1][1]] : null;
  });
  return compact.some(Boolean) ? compact : null;
}

function nbaRunline(value) {
  if (!value || !['away', 'home'].includes(value.lineSide)) return null;
  const awayWater = finite(value.awayWater);
  const homeWater = finite(value.homeWater);
  const line = clean(value.line, 32);
  if (!line || awayWater == null || homeWater == null) return null;
  return [value.lineSide === 'away' ? 0 : 1, line, awayWater, homeWater];
}

function nbaTotal(value) {
  if (!value) return null;
  const overWater = finite(value.overWater);
  const underWater = finite(value.underWater);
  const line = clean(value.line, 32);
  if (!line || overWater == null || underWater == null) return null;
  return [line, overWater, underWater];
}

function nbaMarkets(game) {
  const compact = NBA_MARKET_KEYS.map((key, index) => (
    index % 2 === 0 ? nbaRunline(game?.[key]) : nbaTotal(game?.[key])
  ));
  return compact.some(Boolean) ? compact : null;
}

function normalizedObservedAt(snapshot) {
  const value = clean(snapshot?.pageActivityAt || snapshot?.observedAt, 40);
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';
}

function baseballRows(snapshot) {
  const league = clean(snapshot?.league, 8).toUpperCase();
  if (!isLeagueId(league) || league === 'NBA') return [];
  const boardDate = clean(snapshot?.boardDate, 10);
  const observedAt = normalizedObservedAt(snapshot);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(boardDate) || !observedAt) return [];
  const evidenceHash = sourceHash(snapshot);
  const readerVersion = clean(snapshot?.readerVersion, 20) || null;
  return (Array.isArray(snapshot?.games) ? snapshot.games : []).flatMap(game => {
    const gamePk = Number(game?.gamePk || game?.game?.gamePk);
    if (!Number.isSafeInteger(gamePk) || gamePk <= 0 || game?.marketStatus === 'locked') return [];
    const markets = baseballMarkets(game);
    if (!markets) return [];
    const serialized = JSON.stringify(markets);
    return [{
      league,
      board_date: boardDate,
      game_key: String(gamePk),
      game_pk: gamePk,
      observed_at: observedAt,
      state_hash: stateHash(markets),
      markets: serialized,
      source_hash: evidenceHash,
      reader_version: readerVersion,
    }];
  });
}

function nbaRows(snapshot) {
  if (snapshot?.league !== 'NBA') return [];
  const boardDate = clean(snapshot?.boardDate, 10);
  const observedAt = normalizedObservedAt(snapshot);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(boardDate) || !observedAt) return [];
  const evidenceHash = sourceHash(snapshot);
  const readerVersion = clean(snapshot?.readerVersion, 20) || null;
  return (Array.isArray(snapshot?.games) ? snapshot.games : []).flatMap(game => {
    if (game?.marketStatus === 'locked') return [];
    const boardTime = clean(game?.boardTime, 5);
    const awayCode = clean(game?.awayCode, 12).toUpperCase();
    const homeCode = clean(game?.homeCode, 12).toUpperCase();
    if (!/^\d{2}:\d{2}$/.test(boardTime) || !awayCode || !homeCode || awayCode === homeCode) return [];
    const markets = nbaMarkets(game);
    if (!markets) return [];
    const serialized = JSON.stringify(markets);
    return [{
      league: 'NBA',
      board_date: boardDate,
      game_key: `${boardTime}|${awayCode}|${homeCode}`,
      game_pk: null,
      observed_at: observedAt,
      state_hash: stateHash(markets),
      markets: serialized,
      source_hash: evidenceHash,
      reader_version: readerVersion,
    }];
  });
}

export function buildMarketLineHistoryRows(snapshot) {
  const rows = snapshot?.league === 'NBA' ? nbaRows(snapshot) : baseballRows(snapshot);
  return rows
    .filter(row => row.markets.length <= 1000 && row.game_key.length <= 80)
    .sort((left, right) => left.game_key.localeCompare(right.game_key));
}

export function marketLineHistoryDatabaseConfigured(env = process.env) {
  return durableDatabaseConfigured(env);
}

function databaseClient() {
  if (!sqlClient) sqlClient = neon(durableDatabaseUrl());
  return sqlClient;
}

async function ensureSchema(database) {
  if (!schemaByClient.has(database)) {
    const pending = database`
      CREATE TABLE IF NOT EXISTS tai888_market_line_history_v1 (
        league VARCHAR(5) NOT NULL,
        board_date DATE NOT NULL,
        game_key VARCHAR(80) NOT NULL,
        game_pk BIGINT,
        observed_at TIMESTAMPTZ NOT NULL,
        state_hash CHAR(16) NOT NULL,
        markets TEXT NOT NULL,
        source_hash CHAR(32),
        reader_version VARCHAR(20),
        PRIMARY KEY (league, game_key, observed_at)
      )
    `.catch(error => {
      schemaByClient.delete(database);
      throw error;
    });
    schemaByClient.set(database, pending);
  }
  await schemaByClient.get(database);
}

export async function recordMarketLineHistory(snapshot, options = {}) {
  const rows = buildMarketLineHistoryRows(snapshot);
  const configured = Boolean(options.sql) || marketLineHistoryDatabaseConfigured();
  if (!configured) return { configured: false, checked: rows.length, inserted: 0, unchanged: rows.length, failed: 0 };
  if (!rows.length) return { configured: true, checked: 0, inserted: 0, unchanged: 0, failed: 0 };

  const database = options.sql || databaseClient();
  await ensureSchema(database);
  const inserted = await database`
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS row(
        league text,
        board_date date,
        game_key text,
        game_pk bigint,
        observed_at timestamptz,
        state_hash text,
        markets text,
        source_hash text,
        reader_version text
      )
    ),
    eligible AS (
      SELECT incoming.*
      FROM incoming
      WHERE incoming.observed_at > COALESCE((
        SELECT history.observed_at
        FROM tai888_market_line_history_v1 AS history
        WHERE history.league = incoming.league
          AND history.board_date = incoming.board_date
          AND history.game_key = incoming.game_key
        ORDER BY history.observed_at DESC
        LIMIT 1
      ), '-infinity'::timestamptz)
      AND incoming.state_hash IS DISTINCT FROM (
        SELECT history.state_hash
        FROM tai888_market_line_history_v1 AS history
        WHERE history.league = incoming.league
          AND history.board_date = incoming.board_date
          AND history.game_key = incoming.game_key
        ORDER BY history.observed_at DESC
        LIMIT 1
      )
    )
    INSERT INTO tai888_market_line_history_v1 (
      league, board_date, game_key, game_pk, observed_at,
      state_hash, markets, source_hash, reader_version
    )
    SELECT
      league, board_date, game_key, game_pk, observed_at,
      state_hash, markets, source_hash, reader_version
    FROM eligible
    ON CONFLICT (league, game_key, observed_at) DO NOTHING
    RETURNING league, game_key, observed_at
  `;
  const insertedCount = Array.isArray(inserted) ? inserted.length : 0;
  return {
    configured: true,
    checked: rows.length,
    inserted: insertedCount,
    unchanged: Math.max(0, rows.length - insertedCount),
    failed: 0,
  };
}

export function marketLineHistoryStorageBytes(snapshot) {
  return buildMarketLineHistoryRows(snapshot).reduce((sum, row) => (
    sum + Buffer.byteLength(row.markets, 'utf8')
      + Buffer.byteLength(row.game_key, 'utf8')
      + 16 + 32 + 8 + 8 + 8
  ), 0);
}
