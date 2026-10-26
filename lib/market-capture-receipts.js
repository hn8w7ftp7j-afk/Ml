import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';
import { buildMarketLineHistoryRows } from './market-line-history-v1.js';

export const MARKET_CAPTURE_RECEIPT_SCHEMA = 'market-capture-receipt-v1';
export const MARKET_CAPTURE_RECEIPT_TABLE = 'tai888_market_capture_receipts_v1';
export const MARKET_CAPTURE_GAMES_FORMAT = 'AVAILABILITY_STATE_REF_V1';
export const MARKET_CAPTURE_MARKETS = Object.freeze(['全場讓分', '全場大小', '上半讓分', '上半大小']);
const LEAGUES = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA'];
const NBA_KEYS = ['fullRunline', 'fullTotal', 'firstHalfRunline', 'firstHalfTotal'];
const schemas = new WeakMap();
let client;
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const water = value => typeof value === 'number' && Number.isFinite(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)
    && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function gameKey(game, nba) {
  if (!nba) {
    const id = Number(game?.gamePk ?? game?.game?.gamePk);
    return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  }
  const time = text(game?.boardTime, 5), away = text(game?.awayCode, 12).toUpperCase(), home = text(game?.homeCode, 12).toUpperCase();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) && /^[A-Z0-9]+$/.test(away) && /^[A-Z0-9]+$/.test(home) && away !== home
    ? `${time}|${away}|${home}` : null;
}
function capturedMarkets(game, nba) {
  if (game?.marketStatus === 'locked') return MARKET_CAPTURE_MARKETS.map(() => null);
  return MARKET_CAPTURE_MARKETS.map((name, index) => {
    if (!nba) {
      const pair = (Array.isArray(game?.markets) ? game.markets : []).filter(row => row?.market === name);
      if (pair.length !== 2 || pair.some(row => !text(row.pick, 100) || !water(row.water)) || pair[0].pick === pair[1].pick) return null;
      pair.sort((left, right) => left.pick.localeCompare(right.pick, 'zh-Hant'));
      return [text(pair[0].pick, 100), pair[0].water, text(pair[1].pick, 100), pair[1].water];
    }
    const value = game?.[NBA_KEYS[index]], line = text(value?.line, 32);
    if (!line) return null;
    if (index % 2 === 0) return ['away', 'home'].includes(value.lineSide) && water(value.awayWater) && water(value.homeWater)
      ? [value.lineSide === 'away' ? 0 : 1, line, value.awayWater, value.homeWater] : null;
    return water(value.overWater) && water(value.underWater) ? [line, value.overWater, value.underWater] : null;
  });
}

// Receipt times describe only the supplied, validated capture. In particular,
// never substitute persistence time for an old source observation or receipt.
export function buildMarketCaptureReceipt(snapshot) {
  const league = text(snapshot?.league, 5).toUpperCase(), boardDate = text(snapshot?.boardDate, 10);
  const sourceObservedAt = timestamp(snapshot?.observedAt), pageActivityAt = timestamp(snapshot?.pageActivityAt);
  if (!LEAGUES.includes(league) || !validDate(boardDate)
    || (!sourceObservedAt && !pageActivityAt)) throw Error('MARKET_CAPTURE_RECEIPT_INVALID');
  // Match the existing Reader envelope's clock-skew tolerance. Freshness and
  // monotonic authority checks remain at ingestion; old catch-up is allowed.
  if (sourceObservedAt && pageActivityAt && Date.parse(pageActivityAt) > Date.parse(sourceObservedAt) + 5_000) throw Error('MARKET_CAPTURE_RECEIPT_TIME_INVALID');
  const rows = [...(Array.isArray(snapshot.games) ? snapshot.games : []), ...(Array.isArray(snapshot.unopenedGames) ? snapshot.unopenedGames : [])];
  if (rows.length > 100) throw Error('MARKET_CAPTURE_RECEIPT_TOO_LARGE');
  const archivedStates = new Map(buildMarketLineHistoryRows(snapshot).map(row => [row.game_key, row]));
  const games = rows.map(game => {
    const key = gameKey(game, league === 'NBA');
    if (!key) throw Error('MARKET_CAPTURE_RECEIPT_IDENTITY_INVALID');
    const compactMarkets = capturedMarkets(game, league === 'NBA');
    const markets = compactMarkets.map(Boolean), state = archivedStates.get(key);
    const stateHash = markets.some(Boolean) ? createHash('sha256').update(JSON.stringify(compactMarkets)).digest('hex').slice(0, 16) : null;
    if (stateHash && state?.state_hash !== stateHash) throw Error('MARKET_CAPTURE_RECEIPT_STATE_REFERENCE_INVALID');
    const reason = text(game?.unavailableReason, 80);
    const captureStatus = reason === 'reader-identity-unresolved' ? 'IDENTITY_BLOCKED'
      : reason === 'not-rendered-by-reader' ? 'UNOPENED'
        : game?.marketStatus === 'locked' ? 'LOCKED' : markets.some(Boolean) ? 'CAPTURED' : 'NOT_CAPTURED';
    return { gameKey: key, gamePk: league === 'NBA' ? null : key,
      marketStatus: game?.marketStatus === 'locked' ? 'locked' : 'open', captureStatus, markets, stateHash,
      missingMarkets: MARKET_CAPTURE_MARKETS.filter((_, index) => markets[index] === false) };
  }).sort((a, b) => a.gameKey.localeCompare(b.gameKey));
  if (new Set(games.map(game => game.gameKey)).size !== games.length) throw Error('MARKET_CAPTURE_RECEIPT_DUPLICATE_GAME');
  const rawHash = text(snapshot.rawBoardHash || snapshot.clientPayloadHash || snapshot.payloadHash, 64).toLowerCase();
  const identity = { schema: MARKET_CAPTURE_RECEIPT_SCHEMA, gamesFormat: MARKET_CAPTURE_GAMES_FORMAT, league, boardDate, sourceObservedAt, pageActivityAt,
    sourceHash: /^[a-f0-9]{64}$/.test(rawHash) ? rawHash : null, readerVersion: text(snapshot.readerVersion, 20) || null, games };
  return { ...identity, receiptId: digest(identity), receivedAt: timestamp(snapshot.receivedAt) };
}

async function ensureSchema(sql) {
  if (!schemas.has(sql)) {
    const pending = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS tai888_market_capture_receipts_v1 (
        receipt_id CHAR(64) PRIMARY KEY,
        league VARCHAR(5) NOT NULL CHECK (league IN ('MLB','NPB','KBO','CPBL','NBA')),
        board_date DATE NOT NULL,
        source_observed_at TIMESTAMPTZ,
        page_activity_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ,
        persisted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        source_hash CHAR(64), reader_version VARCHAR(20), games_format VARCHAR(32) NOT NULL, games JSONB NOT NULL,
        CHECK (jsonb_typeof(games)='array'),
        CHECK (source_observed_at IS NOT NULL OR page_activity_at IS NOT NULL)
      )`;
      await sql`CREATE INDEX IF NOT EXISTS tai888_market_capture_receipts_scope_v1
        ON tai888_market_capture_receipts_v1 (league,board_date,source_observed_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS tai888_market_capture_receipts_persisted_v1
        ON tai888_market_capture_receipts_v1 (persisted_at)`;
    })().catch(error => { schemas.delete(sql); throw error; });
    schemas.set(sql, pending);
  }
  await schemas.get(sql);
}

export async function recordMarketCaptureReceipt(snapshot, options = {}) {
  const receipt = buildMarketCaptureReceipt(snapshot);
  if (!options.sql && !durableDatabaseConfigured(options.env ?? process.env)) return { configured: false, persisted: false, receiptId: receipt.receiptId };
  const sql = options.sql || (client ||= neon(durableDatabaseUrl(options.env ?? process.env)));
  await ensureSchema(sql);
  // Retries of a capture preserve its first server receipt and persisted time.
  if (receipt.games.some(game => game.stateHash)) {
    // Store availability only when its exact retained quote digest exists in
    // this league/date/game at or before this source activity time. Same-price
    // heartbeats reference the earlier immutable state rather than duplicate it.
    await sql`INSERT INTO tai888_market_capture_receipts_v1
      (receipt_id,league,board_date,source_observed_at,page_activity_at,received_at,source_hash,reader_version,games_format,games)
      SELECT ${receipt.receiptId},${receipt.league},${receipt.boardDate}::date,${receipt.sourceObservedAt}::timestamptz,
        ${receipt.pageActivityAt}::timestamptz,${receipt.receivedAt}::timestamptz,${receipt.sourceHash},${receipt.readerVersion},${receipt.gamesFormat},${JSON.stringify(receipt.games)}::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(${JSON.stringify(receipt.games)}::jsonb) AS entry(game)
        WHERE entry.game->>'stateHash' IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM tai888_market_line_history_v1 AS h
          WHERE h.league=${receipt.league} AND h.board_date=${receipt.boardDate}::date
            AND h.game_key=entry.game->>'gameKey' AND h.state_hash=entry.game->>'stateHash'
            AND h.observed_at<=${receipt.pageActivityAt || receipt.sourceObservedAt}::timestamptz
        )
      ) ON CONFLICT (receipt_id) DO NOTHING`;
  } else {
    await sql`INSERT INTO tai888_market_capture_receipts_v1
      (receipt_id,league,board_date,source_observed_at,page_activity_at,received_at,source_hash,reader_version,games_format,games)
      VALUES (${receipt.receiptId},${receipt.league},${receipt.boardDate}::date,${receipt.sourceObservedAt}::timestamptz,
        ${receipt.pageActivityAt}::timestamptz,${receipt.receivedAt}::timestamptz,${receipt.sourceHash},${receipt.readerVersion},${receipt.gamesFormat},${JSON.stringify(receipt.games)}::jsonb)
      ON CONFLICT (receipt_id) DO NOTHING`;
  }
  const rows = await sql`SELECT receipt_id,league,board_date::text AS board_date,
    to_char(source_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_observed_at,
    to_char(page_activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS page_activity_at,
    to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
    to_char(persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS persisted_at,
    source_hash,reader_version,games_format,games FROM tai888_market_capture_receipts_v1 WHERE receipt_id=${receipt.receiptId}`;
  const saved = rows?.[0];
  const identity = saved && { schema: MARKET_CAPTURE_RECEIPT_SCHEMA, gamesFormat: saved.games_format, league: saved.league, boardDate: saved.board_date,
    sourceObservedAt: saved.source_observed_at, pageActivityAt: saved.page_activity_at,
    sourceHash: saved.source_hash?.trim() || null, readerVersion: saved.reader_version || null, games: saved.games };
  if (!saved || saved.receipt_id.trim() !== receipt.receiptId || digest(identity) !== receipt.receiptId || !timestamp(saved.persisted_at)) throw Error('MARKET_CAPTURE_RECEIPT_READBACK_FAILED');
  return { configured: true, persisted: true, receiptId: receipt.receiptId, gamesFormat: saved.games_format,
    sourceObservedAt: saved.source_observed_at, pageActivityAt: saved.page_activity_at,
    receivedAt: saved.received_at, persistedAt: saved.persisted_at, gameCount: saved.games.length,
    coverageComplete: false, closingLineVerified: false };
}
