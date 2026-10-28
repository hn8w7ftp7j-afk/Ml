import { soccerDate, soccerLeague, validSoccerDate, shiftSoccerDate } from './contracts.js';
import { canonicalSoccerPayload } from '../../reader/soccer-parser.js';
import { soccerReaderHash } from './reader.js';
import { ensureSoccerJournal, soccerJournalHash, soccerJournalQuery } from './journal.js';

export const SOCCER_READER_INVENTORY_VERSION = 'SOCCER-READER-INVENTORY-v1';
export const SOCCER_READER_INVENTORY_LIMITS = Object.freeze({ dates: 31, historyObservations: 5000,
  historyBytes: 16 * 1024 * 1024, headBytes: 8 * 1024 * 1024 });
const periods = ['FT', 'HT', 'UNKNOWN'];
const error = message => Object.assign(Error(message), { status: 400 });
const stamp = value => value == null ? null : Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const count = value => {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw Error('SOCCER_READER_INVENTORY_COUNT_INVALID');
  return number;
};
export function normalizeSoccerReaderInventoryQuery(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isFinite(now)
    || Object.keys(input).some(key => !['league', 'from', 'through'].includes(key))) throw error('足球原盤庫存查詢條件無效。');
  const league = soccerLeague(input.league)?.id, today = soccerDate(now);
  if (!league || (input.from == null) !== (input.through == null)) throw error('請同時提供原盤庫存開始與結束日期。');
  const from = input.from ?? shiftSoccerDate(today, -30), through = input.through ?? shiftSoccerDate(today, 14);
  if (!validSoccerDate(from) || !validSoccerDate(through) || through < from
    || Date.parse(through) - Date.parse(from) > 366 * 86400000) throw error('原盤庫存查詢日期無效，最多查詢 367 天。');
  return { league, from, through };
}
const gameKey = game => {
  const home = game?.homeKey || game?.homeCode, away = game?.awayKey || game?.awayCode;
  return typeof game?.boardTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(game.boardTime)
    && typeof home === 'string' && home && typeof away === 'string' && away && home !== away
    ? JSON.stringify([game.boardDate, game.boardTime, away, home]) : null;
};
function currentCounts(rows, league, date) {
  if (!rows.length) return { status: 'NO_ACTIVE_HEAD', gameCount: 0, marketCount: 0, periods: [], periodCounts: [] };
  const unknown = reason => ({ status: 'UNAVAILABLE', reason, gameCount: null, marketCount: null,
    periods: periods.filter(period => rows.some(row => row.period === period)), periodCounts: [] });
  const games = new Set(), seen = new Set(), output = []; let markets = 0;
  try {
    for (const row of rows) {
      if (row.omitted) return unknown('HEAD_INSPECTION_BUDGET');
      const payload = row.payload, period = row.period;
      if (!periods.includes(period) || seen.has(period) || row.league !== league.toUpperCase() || row.board_date !== date
        || payload?.league !== row.league || payload.boardDate !== date || payload.executable !== false
        || !Array.isArray(payload.games) || payload.games.length > 40
        || payload.games.some(game => game?.boardDate !== date || game.league != null && game.league !== league.toUpperCase() || !Array.isArray(game.markets))
        || soccerJournalHash(payload) !== row.observation_id || soccerReaderHash(canonicalSoccerPayload(payload)) !== payload.contentHash
        || row.head_content_hash !== row.index_content_hash || stamp(row.head_source_observed_at) !== stamp(payload.observedAt)
        || stamp(row.head_received_at) !== stamp(row.received_at) || !stamp(row.persisted_at)
        || Object.hasOwn(payload, 'periodsCovered') && (!Array.isArray(payload.periodsCovered) || !payload.periodsCovered.includes(period))
        || !Object.hasOwn(payload, 'periodsCovered') && period !== 'UNKNOWN') return unknown('HEAD_CONTENT_UNVERIFIED');
      seen.add(period); const keys = new Set(); let marketCount = 0;
      for (const raw of payload.games) {
        const selected = raw.markets.filter(market => Object.hasOwn(payload, 'periodsCovered') ? market.period === period : period === 'UNKNOWN');
        if (!selected.length && !raw.periodsCovered?.includes(period)) continue;
        const key = gameKey(raw); if (!key) return unknown('HEAD_GAME_IDENTITY_UNVERIFIED');
        keys.add(key); games.add(key); marketCount += selected.length;
      }
      markets += marketCount;
      output.push({ period, gameCount: keys.size, marketCount, observedAt: stamp(payload.observedAt),
        receivedAt: stamp(row.received_at), persistedAt: stamp(row.persisted_at) });
    }
  } catch { return unknown('HEAD_CONTENT_UNVERIFIED'); }
  output.sort((a, b) => periods.indexOf(a.period) - periods.indexOf(b.period));
  return { status: 'AVAILABLE', gameCount: games.size, marketCount: markets, periods: output.map(row => row.period), periodCounts: output };
}

// Legacy storage has an observed source clock but no v2 database receipt. Keep
// this independent date index separate from all receipt/current-head totals.
async function legacyInventory(scope, dateLimit, query) {
  const empty = (status, known) => ({ status, snapshotCount: known ? 0 : null, boardDateCount: known ? 0 : null,
    lastObservedAt: null, days: [], truncated: false, readAt: null,
    historicalAvailabilityVerified: false, formalEligible: false, executable: false });
  try {
    const rows = await query(`WITH scoped AS MATERIALIZED (
      SELECT board_date,observed_at FROM sports_soccer_reader_snapshots_v1
      WHERE league=$1 AND board_date BETWEEN $2::date AND $3::date),
      days AS (SELECT board_date::text AS date,count(*) AS snapshot_count,max(observed_at) AS last_observed_at
        FROM scoped GROUP BY board_date ORDER BY board_date DESC LIMIT $4)
      SELECT clock_timestamp() AS read_at,(SELECT count(*) FROM scoped) AS snapshot_count,
        (SELECT count(DISTINCT board_date) FROM scoped) AS board_date_count,
        (SELECT max(observed_at) FROM scoped) AS last_observed_at,
        coalesce((SELECT jsonb_agg(to_jsonb(days) ORDER BY date DESC) FROM days),'[]'::jsonb) AS days`,
    [scope.league.toUpperCase(), scope.from, scope.through, dateLimit]);
    if (rows.length !== 1 || !stamp(rows[0].read_at) || !Array.isArray(rows[0].days)) return empty('UNAVAILABLE', false);
    const row = rows[0], snapshotCount = count(row.snapshot_count), boardDateCount = count(row.board_date_count);
    const days = row.days.map(day => {
      if (!validSoccerDate(day.date) || day.date < scope.from || day.date > scope.through) throw Error('LEGACY_INVENTORY_SCOPE_INVALID');
      return { date: day.date, snapshotCount: count(day.snapshot_count), lastObservedAt: stamp(day.last_observed_at),
        receiptStatus: 'LEGACY_ACQUISITION_UNKNOWN' };
    });
    if (days.length > dateLimit || new Set(days.map(day => day.date)).size !== days.length) return empty('UNAVAILABLE', false);
    return { status: snapshotCount ? 'AVAILABLE' : 'EMPTY', snapshotCount, boardDateCount,
      lastObservedAt: stamp(row.last_observed_at), days, truncated: boardDateCount > days.length, readAt: stamp(row.read_at),
      historicalAvailabilityVerified: false, formalEligible: false, executable: false };
  } catch (error) { return empty(error.code === '42P01' ? 'ABSENT' : 'UNAVAILABLE', error.code === '42P01'); }
}

// Metadata totals cover the whole requested window. Original game keys and
// current-head documents have separate bounded inspection budgets. A partial
// inspection returns unknown counts, never a misleading partial/zero total.
export async function readSoccerReaderInventory(input, { query = soccerJournalQuery, ensure = ensureSoccerJournal,
  now = Date.now(), limits: supplied = {} } = {}) {
  const scope = normalizeSoccerReaderInventoryQuery(input, now), limits = { ...SOCCER_READER_INVENTORY_LIMITS, ...supplied };
  if (Object.keys(supplied).some(key => !Object.hasOwn(SOCCER_READER_INVENTORY_LIMITS, key))
    || Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < 1 || value > SOCCER_READER_INVENTORY_LIMITS[key]))
    throw error('原盤庫存讀取上限無效。');
  await ensure();
  const rows = await query(`WITH read_clock AS MATERIALIZED (SELECT clock_timestamp() AS read_at),
    scoped AS MATERIALIZED (
      SELECT observation_id,league,board_date,source_observed_at,received_at,persisted_at
      FROM sports_soccer_reader_observations_v2 WHERE league=$1 AND board_date BETWEEN $2::date AND $3::date),
    day_stats AS MATERIALIZED (
      SELECT board_date,count(*) AS observation_count,max(source_observed_at) AS last_observed_at,
        max(received_at) AS last_received_at,max(persisted_at) AS last_persisted_at FROM scoped GROUP BY board_date),
    listed_dates AS MATERIALIZED (SELECT * FROM day_stats ORDER BY board_date DESC LIMIT $4),
    history_ids AS MATERIALIZED (
      SELECT * FROM scoped ORDER BY received_at DESC,observation_id DESC LIMIT $5),
    history_pick AS MATERIALIZED (
      SELECT h.*,o.payload FROM history_ids h JOIN sports_soccer_reader_observations_v2 o USING(observation_id)),
    history_sizes AS MATERIALIZED (
      SELECT *,sum(octet_length(payload::text)) OVER (ORDER BY received_at DESC,observation_id DESC) AS bytes_so_far FROM history_pick),
    history_rows AS MATERIALIZED (SELECT * FROM history_sizes WHERE bytes_so_far<=$6),
    history_games AS MATERIALIZED (
      SELECT o.observation_id,o.board_date,g.game,
        (jsonb_typeof(g.game->'boardTime')='string' AND (g.game->>'boardTime') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND coalesce(g.game->>'homeKey',g.game->>'homeCode','')<>'' AND coalesce(g.game->>'awayKey',g.game->>'awayCode','')<>''
        AND coalesce(g.game->>'homeKey',g.game->>'homeCode')<>coalesce(g.game->>'awayKey',g.game->>'awayCode')
        AND g.game->>'boardDate'=o.board_date::text AND o.payload->>'boardDate'=o.board_date::text AND o.payload->>'league'=o.league) AS valid,
        jsonb_build_array(o.board_date::text,g.game->>'boardTime',coalesce(g.game->>'awayKey',g.game->>'awayCode'),coalesce(g.game->>'homeKey',g.game->>'homeCode'))::text AS game_key
      FROM history_rows o CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.payload->'games')='array' THEN o.payload->'games' ELSE '[]'::jsonb END) g(game)),
    head_candidates AS MATERIALIZED (
      SELECT h.period,h.board_date::text AS requested_date,h.observation_id,h.content_hash AS head_content_hash,
        h.source_observed_at AS head_source_observed_at,h.received_at AS head_received_at,p.content_hash AS index_content_hash,
        o.league,o.board_date::text AS board_date,o.received_at,o.persisted_at,o.payload
      FROM sports_soccer_reader_period_heads_v2 h JOIN listed_dates d ON d.board_date=h.board_date
      LEFT JOIN sports_soccer_reader_period_observations_v2 p ON p.observation_id=h.observation_id AND p.period=h.period
      LEFT JOIN sports_soccer_reader_observations_v2 o ON o.observation_id=h.observation_id WHERE h.league=lower($1)),
    head_sizes AS MATERIALIZED (
      SELECT *,sum(coalesce(octet_length(payload::text),0)) OVER (ORDER BY requested_date DESC,period) AS bytes_so_far FROM head_candidates),
    head_output AS MATERIALIZED (
      SELECT requested_date,jsonb_build_object('period',period,'observation_id',observation_id,'head_content_hash',head_content_hash,
        'head_source_observed_at',head_source_observed_at,'head_received_at',head_received_at,'index_content_hash',index_content_hash,
        'league',league,'board_date',board_date,'received_at',received_at,'persisted_at',persisted_at,
        'omitted',bytes_so_far>$7,'payload',CASE WHEN bytes_so_far<=$7 THEN payload ELSE NULL END) AS item FROM head_sizes),
    day_output AS (
      SELECT d.board_date::text AS date,d.observation_count,d.last_observed_at,d.last_received_at,d.last_persisted_at,
        (SELECT count(*) FROM history_rows r WHERE r.board_date=d.board_date)=d.observation_count
          AND NOT EXISTS (SELECT 1 FROM history_games g WHERE g.board_date=d.board_date AND g.valid IS NOT TRUE)
          AND NOT EXISTS (SELECT 1 FROM history_rows r WHERE r.board_date=d.board_date AND (jsonb_typeof(r.payload->'games') IS DISTINCT FROM 'array'
            OR r.payload->>'league' IS DISTINCT FROM r.league OR r.payload->>'boardDate' IS DISTINCT FROM r.board_date::text)) AS game_keys_complete,
        (SELECT count(DISTINCT game_key) FROM history_games g WHERE g.board_date=d.board_date AND g.valid) AS game_keys,
        coalesce((SELECT jsonb_agg(item ORDER BY item->>'period') FROM head_output h WHERE h.requested_date=d.board_date::text),'[]'::jsonb) AS heads
      FROM listed_dates d)
    SELECT (SELECT read_at FROM read_clock) AS read_at,
      (SELECT count(*) FROM scoped) AS observation_count,(SELECT count(*) FROM day_stats) AS board_date_count,
      (SELECT min(board_date)::text FROM day_stats) AS first_board_date,(SELECT max(board_date)::text FROM day_stats) AS last_board_date,
      (SELECT max(source_observed_at) FROM scoped) AS last_observed_at,(SELECT max(received_at) FROM scoped) AS last_received_at,
      (SELECT max(persisted_at) FROM scoped) AS last_persisted_at,
      (SELECT count(*) FROM history_rows)=(SELECT count(*) FROM scoped)
        AND NOT EXISTS (SELECT 1 FROM history_games WHERE valid IS NOT TRUE)
        AND NOT EXISTS (SELECT 1 FROM history_rows WHERE jsonb_typeof(payload->'games') IS DISTINCT FROM 'array'
          OR payload->>'league' IS DISTINCT FROM league OR payload->>'boardDate' IS DISTINCT FROM board_date::text) AS game_keys_complete,
      (SELECT count(DISTINCT game_key) FROM history_games WHERE valid) AS game_keys,
      coalesce((SELECT jsonb_agg(to_jsonb(day_output) ORDER BY date DESC) FROM day_output),'[]'::jsonb) AS days`,
  [scope.league.toUpperCase(), scope.from, scope.through, limits.dates, limits.historyObservations, limits.historyBytes, limits.headBytes]);
  if (rows.length !== 1 || !stamp(rows[0].read_at) || !Array.isArray(rows[0].days)) throw Error('SOCCER_READER_INVENTORY_RESPONSE_INVALID');
  const row = rows[0], boardDateCount = count(row.board_date_count), observationCount = count(row.observation_count);
  const complete = row.game_keys_complete === true;
  const days = row.days.map(day => {
    if (!validSoccerDate(day.date) || day.date < scope.from || day.date > scope.through || !Array.isArray(day.heads)) throw Error('SOCCER_READER_INVENTORY_SCOPE_INVALID');
    return { date: day.date, observationCount: count(day.observation_count),
      distinctBoardGameKeys: day.game_keys_complete === true ? count(day.game_keys) : null, gameKeysComplete: day.game_keys_complete === true,
      lastObservedAt: stamp(day.last_observed_at), lastReceivedAt: stamp(day.last_received_at), lastPersistedAt: stamp(day.last_persisted_at),
      current: currentCounts(day.heads, scope.league, day.date) };
  });
  if (days.length > limits.dates || new Set(days.map(day => day.date)).size !== days.length) throw Error('SOCCER_READER_INVENTORY_DATES_INVALID');
  const legacy = await legacyInventory(scope, limits.dates, query);
  return { ok: true, version: SOCCER_READER_INVENTORY_VERSION, league: scope.league,
    scope: { from: scope.from, through: scope.through, readAt: stamp(row.read_at), dateLimit: limits.dates },
    summary: { observationCount, boardDateCount, distinctBoardGameKeys: complete ? count(row.game_keys) : null, gameKeysComplete: complete,
      firstBoardDate: row.first_board_date, lastBoardDate: row.last_board_date,
      lastObservedAt: stamp(row.last_observed_at), lastReceivedAt: stamp(row.last_received_at), lastPersistedAt: stamp(row.last_persisted_at) },
    gameKeyDefinition: 'BOARD_DATE_TIME_AWAY_HOME_SOURCE_KEYS_NOT_OFFICIAL_GAME_IDENTITIES',
    observationDefinition: 'IMMUTABLE_V2_READER_RECEIPTS_HEARTBEATS_INCLUDED',
    truncated: boardDateCount > days.length, days, legacy, formalEligible: false, executable: false };
}
