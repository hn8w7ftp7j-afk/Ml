import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from './database-url.js';

export const READER_LEGACY_HISTORY_SCHEMA = 'reader-legacy-history-v1';
export const READER_LEGACY_HISTORY_MAX_BYTES = 650000;
export const READER_LEGACY_HISTORY_FLAGS = Object.freeze({
  sourceKind: 'NORMALIZED_READER_CACHE', sourceTable: 'sports_baseball_reader_boards_v1',
  archiveOnly: true, currentBoardUpdated: false, executable: false,
  historicalAvailabilityVerified: false, coverageComplete: false, firstObservedAtVerified: false,
  formalEligible: false, calibrationEligible: false, closingCoverage: 'NOT_VERIFIED',
  mutableSnapshot: true, completeHistory: false,
  timeBasis: 'LAST_RETAINED_READER_SNAPSHOT_NOT_FIRST_PRICE_OBSERVATION',
});
const LEAGUES = new Set(['MLB', 'NPB', 'CPBL']);
// These versions are present in the repository's actual parser history. An
// unknown format is retained in metadata, never guessed into historical quotes.
const SCHEMAS = new Set(['2.0.0', '2.0.2', '2.0.3', '2.1.0', '2.2.0', '2.2.1'].map(v => `TAI888-READER-PARSER-v${v}`));
const MARKETS = new Set(['全場讓分', '全場大小', '上半讓分', '上半大小']);
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, status = 503) => Object.assign(new Error(code), { code, status });
const assert = (ok, code = 'LEGACY_READER_CONTENT_INVALID', status = 409) => { if (!ok) throw failure(code, status); };
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const exactInstant = value => value.replace(/(?:\.(\d{1,6}))?Z$/, (_, fraction = '') => `.${fraction.padEnd(6, '0')}Z`);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const optionalText = (value, max) => value == null || text(value, max);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const checksum = payload => createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
let client;

export function parseReaderLegacyHistoryQuery(params) {
  assert(params instanceof URLSearchParams, 'LEGACY_READER_QUERY_INVALID', 400);
  const view = params.get('view') || 'inventory';
  const allowed = view === 'inventory' ? ['view', 'league', 'from', 'through'] : view === 'detail' ? ['view', 'league', 'date'] : [];
  assert(allowed.length && [...params.keys()].every(key => allowed.includes(key) && params.getAll(key).length === 1), 'LEGACY_READER_QUERY_INVALID', 400);
  const league = params.get('league');
  assert(LEAGUES.has(league), 'LEGACY_READER_QUERY_INVALID', 400);
  if (view === 'detail') {
    const boardDate = params.get('date');
    assert(date(boardDate), 'LEGACY_READER_QUERY_INVALID', 400);
    return { view, league, date: boardDate };
  }
  const from = params.get('from'), through = params.get('through');
  assert(date(from) && date(through) && from <= through && (Date.parse(through) - Date.parse(from)) / 86400000 <= 30,
    'LEGACY_READER_QUERY_INVALID', 400);
  return { view, league, from, through };
}

const metadataColumns = `league,board_date,
  to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
  to_char(page_activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_activity_at,
  to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
  left(checksum,65) AS checksum,octet_length(payload::text) AS payload_bytes,
  left(payload->>'league',16) AS payload_league,left(payload->>'boardDate',11) AS payload_date,
  left(payload->>'version',100) AS stored_schema`;
function metadata(row, scope, readAt) {
  assert(object(row) && row.league === scope.league && date(row.board_date)
    && (scope.view === 'detail' ? row.board_date === scope.date : row.board_date >= scope.from && row.board_date <= scope.through)
    && row.payload_league === scope.league && row.payload_date === row.board_date
    && instant(row.observed_at) && instant(row.page_activity_at) && instant(row.expires_at)
    && HASH.test(row.checksum) && Number.isSafeInteger(row.payload_bytes) && row.payload_bytes > 0
    && text(row.stored_schema, 100));
  return { league: row.league, boardDate: row.board_date, observedAt: row.observed_at,
    pageActivityAt: row.page_activity_at, expiresAt: row.expires_at, expired: exactInstant(row.expires_at) <= exactInstant(readAt),
    payloadBytes: row.payload_bytes, checksum: row.checksum, storedSchema: row.stored_schema,
    detailAvailable: row.payload_bytes <= READER_LEGACY_HISTORY_MAX_BYTES && SCHEMAS.has(row.stored_schema),
    integrity: { status: 'NOT_CHECKED' } };
}
function quoteProjection(payload, meta) {
  assert(object(payload) && SCHEMAS.has(payload.version), 'LEGACY_READER_SCHEMA_UNSUPPORTED');
  assert(payload.league === meta.league && payload.boardDate === meta.boardDate
    && instant(payload.observedAt) && instant(payload.pageActivityAt) && instant(payload.receivedAt)
    && exactInstant(payload.observedAt) === exactInstant(meta.observedAt)
    && exactInstant(payload.pageActivityAt) === exactInstant(meta.pageActivityAt)
    && Date.parse(payload.pageActivityAt) <= Date.parse(payload.observedAt) + 5000
    && HASH.test(payload.payloadHash) && HASH.test(payload.rawBoardHash)
    && text(payload.readerVersion, 120) && /^\d+\.\d+\.\d+(?: [\w .-]+)?$/.test(payload.readerVersion)
    && typeof payload.sourceHost === 'string' && /^(?:[a-z0-9-]+\.)*tai888\.in$/.test(payload.sourceHost)
    && Array.isArray(payload.games) && Array.isArray(payload.unopenedGames)
    && payload.games.length + payload.unopenedGames.length > 0 && payload.games.length + payload.unopenedGames.length <= 40);
  for (const [key, expected] of [['matchedGameCount', payload.games.length], ['unopenedGameCount', payload.unopenedGames.length],
    ['scheduleGameCount', payload.games.length + payload.unopenedGames.length]]) {
    assert(payload[key] === expected);
  }
  assert(Number.isInteger(payload.rawGameCount) && payload.rawGameCount > 0
    && payload.rawGameCount <= payload.games.length + payload.unopenedGames.length);
  const seen = new Set();
  const games = [...payload.games, ...payload.unopenedGames].map((game, index) => {
    const unopened = index >= payload.games.length;
    assert(object(game) && Number.isSafeInteger(game.gamePk) && game.gamePk > 0 && !seen.has(game.gamePk)
      && object(game.game) && object(game.source) && (!Object.hasOwn(game.game, 'gamePk') || game.game.gamePk === game.gamePk)
      && [game.league, game.game.league, game.game.leagueId, game.source.league].every(value => value == null || value === meta.league)
      && [game.league, game.game.league, game.game.leagueId, game.source.league].some(value => value === meta.league)
      && game.marketStatus === (unopened ? 'locked' : 'open') && Array.isArray(game.markets)
      && (unopened ? game.markets.length === 0 : game.markets.length > 0 && game.markets.length <= 8)
      && text(game.game.away, 100) && game.game.away.length > 0 && text(game.game.home, 100) && game.game.home.length > 0
      && instant(game.source.observedAt) && instant(game.source.receivedAt) && instant(game.source.pageActivityAt)
      && game.source.provider === 'TAI888_READER_AUTO' && game.source.sourceType === 'ACTUAL_TW_CREDIT'
      && exactInstant(game.source.observedAt) === exactInstant(payload.observedAt)
      && exactInstant(game.source.receivedAt) === exactInstant(payload.receivedAt)
      && exactInstant(game.source.pageActivityAt) === exactInstant(payload.pageActivityAt));
    seen.add(game.gamePk);
    const marketCounts = new Map(), picks = new Set();
    const markets = game.markets.map(market => {
      assert(object(market) && MARKETS.has(market.market) && text(market.pick, 180) && market.pick.length > 0
        && typeof market.water === 'number' && Number.isFinite(market.water) && market.water >= .01 && market.water <= 3
        && market.waterEstimated === false && market.waterMissing === false
        && market.sourceType === 'ACTUAL_TW_CREDIT' && market.provider === 'TAI888_READER_AUTO'
        && instant(market.lineAsOf) && exactInstant(market.lineAsOf) === exactInstant(payload.pageActivityAt)
        && optionalText(market.rawText, 300) && !picks.has(`${market.market}\n${market.pick}`));
      picks.add(`${market.market}\n${market.pick}`); marketCounts.set(market.market, (marketCounts.get(market.market) || 0) + 1);
      return { market: market.market, pick: market.pick, water: market.water, lineAsOf: market.lineAsOf,
        ...(typeof market.rawText === 'string' ? { rawText: market.rawText } : {}) };
    });
    assert([...marketCounts.values()].every(count => count === 2));
    const boardTime = game.readerMeta?.boardTime;
    assert(boardTime == null || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(boardTime));
    assert(game.readerMeta?.boardDate == null || game.readerMeta.boardDate === meta.boardDate);
    if (game.game.gameDate != null) assert(instant(game.game.gameDate)
      && new Date(Date.parse(game.game.gameDate) + 8 * 3600000).toISOString().slice(0, 10) === meta.boardDate);
    return { gamePk: game.gamePk, away: game.game.away, home: game.game.home, boardTime: boardTime || null,
      marketStatus: game.marketStatus, source: { observedAt: game.source.observedAt, receivedAt: game.source.receivedAt,
        pageActivityAt: game.source.pageActivityAt }, markets };
  });
  return { ...meta, receivedAt: payload.receivedAt, readerVersion: payload.readerVersion,
    payloadHash: payload.payloadHash, rawBoardHash: payload.rawBoardHash,
    integrity: { status: 'PASS', scope: 'CACHE_CHECKSUM_IDENTITY_SCHEMA_NOT_SOURCE_TIME_AUTHORITY' }, games };
}

/** Forensic reads deliberately bypass live expiry, not live eligibility. No
 * initializer, schema migration, heartbeat, journal or cache write is called. */
export async function readReaderLegacyHistory(query, options = {}) {
  const scope = parseReaderLegacyHistoryQuery(new URLSearchParams(query));
  const readAt = new Date(options.now ?? Date.now()).toISOString();
  const base = { ok: true, schema: READER_LEGACY_HISTORY_SCHEMA, ...READER_LEGACY_HISTORY_FLAGS,
    view: scope.view, filters: scope, readAt, concurrentSourceCommitsVerified: false };
  let db = options.sql;
  if (!db) { const url = durableDatabaseUrl(); assert(url, 'LEGACY_READER_STORAGE_UNAVAILABLE', 503); db = client ||= neon(url); }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  const select = (sql, params) => db.query(sql, params, { fetchOptions: { signal: controller.signal } });
  try {
    const rows = scope.view === 'inventory'
      ? await select(`SELECT ${metadataColumns} FROM sports_baseball_reader_boards_v1
          WHERE league=$1 AND board_date >= $2 AND board_date <= $3 ORDER BY board_date LIMIT 32`, [scope.league, scope.from, scope.through])
      : await select(`SELECT ${metadataColumns} FROM sports_baseball_reader_boards_v1
          WHERE league=$1 AND board_date=$2 LIMIT 1`, [scope.league, scope.date]);
    assert(Array.isArray(rows) && rows.length <= (scope.view === 'inventory' ? 31 : 1));
    if (!rows.length) return { ...base, status: 'NO_RETAINED_ROWS', count: 0,
      code: 'LEGACY_READER_SNAPSHOT_NOT_FOUND', ...(scope.view === 'inventory' ? { records: [] } : { record: null }) };
    const records = rows.map(row => metadata(row, scope, readAt));
    assert(new Set(records.map(row => row.boardDate)).size === records.length);
    if (scope.view === 'inventory') return { ...base, status: 'RETAINED_MUTABLE_SNAPSHOTS', count: records.length, records };
    const first = records[0];
    assert(first.payloadBytes <= READER_LEGACY_HISTORY_MAX_BYTES, 'LEGACY_READER_PAYLOAD_LIMIT_EXCEEDED', 413);
    assert(SCHEMAS.has(first.storedSchema), 'LEGACY_READER_SCHEMA_UNSUPPORTED');
    // A concurrent overwrite cannot substitute a different row after the size
    // guard. The same payload must still match its original canonical checksum.
    const full = await select(`SELECT ${metadataColumns},payload FROM sports_baseball_reader_boards_v1
      WHERE league=$1 AND board_date=$2 AND checksum=$3 AND octet_length(payload::text)<=$4 LIMIT 1`,
    [scope.league, scope.date, first.checksum, READER_LEGACY_HISTORY_MAX_BYTES]);
    assert(Array.isArray(full) && full.length === 1, 'LEGACY_READER_SOURCE_CHANGED');
    const meta = metadata(full[0], scope, readAt), payload = full[0].payload;
    assert(meta.checksum === first.checksum && object(payload) && checksum(payload) === first.checksum, 'LEGACY_READER_CHECKSUM_INVALID');
    return { ...base, status: 'RETAINED_MUTABLE_SNAPSHOT', count: 1, record: quoteProjection(payload, meta) };
  } catch (error) {
    if (error?.code === '42P01') throw failure('LEGACY_READER_TABLE_NOT_PRESENT');
    throw error;
  } finally { clearTimeout(timer); }
}
