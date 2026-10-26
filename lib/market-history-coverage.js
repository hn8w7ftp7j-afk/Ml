import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from './database-url.js';
import { expandMarketLineHistoryRow } from './market-line-history-query.js';
import { createHash } from 'node:crypto';
import { canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { soccerJournalHash } from './soccer/journal.js';
import { MARKET_CAPTURE_RECEIPT_SCHEMA, MARKET_CAPTURE_GAMES_FORMAT } from './market-capture-receipts.js';

export const MARKET_HISTORY_COVERAGE_SCHEMA = 'market-history-coverage-v1';
export const MARKET_HISTORY_COVERAGE_LEAGUES = Object.freeze(['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL']);
export const MARKET_HISTORY_COVERAGE_HEADERS = Object.freeze({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
const STATE_LEAGUES = MARKET_HISTORY_COVERAGE_LEAGUES.slice(0, 5);
const SOCCER_LEAGUES = MARKET_HISTORY_COVERAGE_LEAGUES.slice(5);
const MARKET_NAMES = ['全場讓分', '全場大小', '上半讓分', '上半大小'];
const TABLES = { states: 'tai888_market_line_history_v1', soccer: 'sports_soccer_reader_observations_v2', receipts: 'tai888_market_capture_receipts_v1' };

function invalid(message) { return Object.assign(new Error(message), { status: 400, code: 'INVALID_QUERY' }); }
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function parseMarketHistoryCoverageQuery(params, { now = Date.now() } = {}) {
  for (const key of params.keys()) if (!['league', 'date', 'from', 'through', 'limit', 'until'].includes(key) || params.getAll(key).length !== 1) throw invalid('盤口保存核對參數重複或不支援');
  const league = params.get('league');
  if (league !== null && !MARKET_HISTORY_COVERAGE_LEAGUES.includes(league)) throw invalid('不支援的聯盟');
  let from = params.get('from'), through = params.get('through');
  const date = params.get('date');
  if (date !== null) {
    if (from !== null || through !== null || !validDate(date)) throw invalid('盤日與日期範圍不可混用');
    from = date; through = date;
  }
  if ((from !== null && !validDate(from)) || (through !== null && !validDate(through)) || (from && through && from > through)) throw invalid('盤日範圍錯誤');
  const limit = params.get('limit') ?? '100';
  if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 500) throw invalid('每頁場次需介於 1 與 500');
  const until = params.get('until') ?? new Date(now).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until) || !validDate(until.slice(0, 10)) || !Number.isFinite(Date.parse(until)) || Date.parse(until) > now) throw invalid('查詢截點無效');
  return { filters: { league, from, through }, limit: Number(limit), until };
}

function number(value) {
  if (!((typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)))) throw new Error('INVALID_COVERAGE_COUNT');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('INVALID_COVERAGE_COUNT');
  return parsed;
}
function stamp(value) { return value == null ? null : new Date(value).toISOString(); }
function identity(row) { return JSON.stringify([row.league, row.boardDate, row.gameKey]); }
function emptyLeague(league) {
  return { league, status: 'NOT_VERIFIED', savedCount: null,
    countUnit: STATE_LEAGUES.includes(league) ? 'CHANGED_STATES' : 'READER_OBSERVATIONS', gameDateKeys: null,
    firstBoardDate: null, lastBoardDate: null, lastStateChangedAt: null,
    lastReaderObservedAt: null, lastPersistedAt: null, captureReceiptCount: null };
}
function baseGame(row) {
  return { league: row.league, boardDate: row.board_date, gameKey: row.game_key,
    gameLabel: `賽事 ${row.game_key}`, archiveObservedAt: null, lastReaderObservedAt: null, lastPersistedAt: null,
    markets: MARKET_NAMES.map(market => ({ market, status: 'NOT_CAPTURED', lastObservedAt: null })),
    closingCoverage: 'NOT_VERIFIED', integrity: { status: 'NOT_VERIFIED', issues: [] } };
}
function validateEnvelope(rows, kind) {
  const envelope = rows?.[0];
  if (!envelope || !Array.isArray(envelope.leagues) || !Array.isArray(envelope.games)) throw new Error('INVALID_COVERAGE_RESPONSE');
  for (const row of envelope.leagues) {
    for (const field of kind === 'receipts' ? ['receipt_count'] : ['saved_count', 'game_date_keys']) number(row[field]);
    for (const field of ['last_state_changed_at', 'last_reader_observed_at', 'last_persisted_at']) if (row[field] != null) stamp(row[field]);
  }
  return envelope;
}

async function readStates(sql, query) {
  const { league, from, through } = query.filters;
  return validateEnvelope(await sql`
    WITH filtered AS MATERIALIZED (
      SELECT * FROM tai888_market_line_history_v1
      WHERE observed_at <= ${query.until}::timestamptz AND league IN ('MLB','NPB','KBO','CPBL','NBA')
        AND (${league}::text IS NULL OR league=${league})
        AND (${from}::date IS NULL OR board_date>=${from}::date)
        AND (${through}::date IS NULL OR board_date<=${through}::date)
    ), summaries AS (
      SELECT league, count(*) AS saved_count, count(DISTINCT (board_date,game_key)) AS game_date_keys,
        min(board_date)::text AS first_board_date,max(board_date)::text AS last_board_date,
        max(observed_at) AS last_state_changed_at FROM filtered GROUP BY league
    ), latest AS (
      SELECT DISTINCT ON (league,board_date,game_key) league,board_date::text AS board_date,game_key,
        game_pk::text AS game_pk,observed_at,state_hash,markets,source_hash,reader_version
      FROM filtered ORDER BY league,board_date,game_key,observed_at DESC
    ), page AS (SELECT * FROM latest ORDER BY observed_at DESC,league,board_date,game_key LIMIT ${query.limit + 1})
    SELECT (SELECT coalesce(jsonb_agg(to_jsonb(summaries) ORDER BY league),'[]'::jsonb) FROM summaries) AS leagues,
      (SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY observed_at DESC,league,board_date,game_key),'[]'::jsonb) FROM page) AS games
  `, 'states');
}

async function readSoccer(sql, query) {
  const { league, from, through } = query.filters;
  return validateEnvelope(await sql`
    WITH filtered AS MATERIALIZED (
      SELECT * FROM sports_soccer_reader_observations_v2
      WHERE source_observed_at<=${query.until}::timestamptz AND received_at<=${query.until}::timestamptz
        AND persisted_at<=${query.until}::timestamptz AND league IN ('EPL','UCL')
        AND (${league}::text IS NULL OR league=${league})
        AND (${from}::date IS NULL OR board_date>=${from}::date)
        AND (${through}::date IS NULL OR board_date<=${through}::date)
    ), expanded AS MATERIALIZED (
      SELECT o.*,g.game,
        concat_ws('|',g.game->>'boardTime',coalesce(g.game->>'awayKey',g.game->>'awayCode'),coalesce(g.game->>'homeKey',g.game->>'homeCode')) AS game_key
      FROM filtered o CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(o.payload->'games')='array' THEN o.payload->'games' ELSE '[]'::jsonb END) AS g(game)
    ), summaries AS (
      SELECT o.league,count(*) AS saved_count,min(o.board_date)::text AS first_board_date,max(o.board_date)::text AS last_board_date,
        max(o.source_observed_at) AS last_reader_observed_at,max(o.persisted_at) AS last_persisted_at,
        (SELECT count(DISTINCT (e.board_date,e.game_key)) FROM expanded e WHERE e.league=o.league) AS game_date_keys
      FROM filtered o GROUP BY o.league
    ), periods AS (
      SELECT e.*,p.period FROM expanded e CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(e.game->'periodsCovered')='array' AND jsonb_array_length(e.game->'periodsCovered')>0
          THEN e.game->'periodsCovered' ELSE '["UNKNOWN"]'::jsonb END) AS p(period)
    ), latest AS (
      SELECT DISTINCT ON (league,board_date,game_key,period) * FROM periods
      ORDER BY league,board_date,game_key,period,source_observed_at DESC,received_at DESC,observation_id DESC
    ), games AS (
      SELECT league,board_date::text AS board_date,game_key,max(source_observed_at) AS observed_at,
        max(persisted_at) AS persisted_at,
        jsonb_agg(jsonb_build_object('period',period,'game',game,'observedAt',source_observed_at,'persistedAt',persisted_at,'observationId',observation_id,'payload',payload) ORDER BY period) AS periods
      FROM latest GROUP BY league,board_date,game_key
    ), page AS (SELECT * FROM games ORDER BY observed_at DESC,league,board_date,game_key LIMIT ${query.limit + 1})
    SELECT (SELECT coalesce(jsonb_agg(to_jsonb(summaries) ORDER BY league),'[]'::jsonb) FROM summaries) AS leagues,
      (SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY observed_at DESC,league,board_date,game_key),'[]'::jsonb) FROM page) AS games
  `, 'soccer');
}

async function readReceipts(sql, query) {
  const { league, from, through } = query.filters;
  return validateEnvelope(await sql`
    WITH filtered AS MATERIALIZED (
      SELECT * FROM tai888_market_capture_receipts_v1
      WHERE persisted_at<=${query.until}::timestamptz AND (source_observed_at IS NULL OR source_observed_at<=${query.until}::timestamptz)
        AND league IN ('MLB','NPB','KBO','CPBL','NBA') AND (${league}::text IS NULL OR league=${league})
        AND (${from}::date IS NULL OR board_date>=${from}::date)
        AND (${through}::date IS NULL OR board_date<=${through}::date)
    ), summaries AS (
      SELECT league,count(*) AS receipt_count,max(source_observed_at) AS last_reader_observed_at,
        max(persisted_at) AS last_persisted_at FROM filtered GROUP BY league
    ), expanded AS (
      SELECT o.*,g.game,
        g.game->>'gameKey' AS game_key FROM filtered o CROSS JOIN LATERAL jsonb_array_elements(o.games) AS g(game)
    ), latest AS (
      SELECT DISTINCT ON (league,board_date,game_key) * FROM expanded
      ORDER BY league,board_date,game_key,source_observed_at DESC NULLS LAST,persisted_at DESC,receipt_id DESC
    ), page AS (
      SELECT l.league,l.board_date::text AS board_date,l.game_key,l.source_observed_at AS observed_at,l.persisted_at,l.game,
        l.receipt_id,l.games_format,l.source_hash,l.reader_version,l.page_activity_at,l.games,
        (SELECT to_jsonb(h) FROM tai888_market_line_history_v1 h
          WHERE h.league=l.league AND h.board_date=l.board_date AND h.game_key=l.game_key
            AND h.state_hash=l.game->>'stateHash' AND h.observed_at<=coalesce(l.page_activity_at,l.source_observed_at)
          ORDER BY h.observed_at DESC LIMIT 1) AS referenced_state
      FROM latest l
      ORDER BY l.source_observed_at DESC NULLS LAST,l.league,l.board_date,l.game_key LIMIT ${query.limit + 1}
    )
    SELECT (SELECT coalesce(jsonb_agg(to_jsonb(summaries) ORDER BY league),'[]'::jsonb) FROM summaries) AS leagues,
      (SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY observed_at DESC NULLS LAST,league,board_date,game_key),'[]'::jsonb) FROM page) AS games
  `, 'receipts');
}

function soccerGame(row) {
  const result = baseGame(row);
  result.archiveObservedAt = result.lastReaderObservedAt = stamp(row.observed_at);
  result.lastPersistedAt = stamp(row.persisted_at);
  result.integrity.status = 'PASS';
  let unknownPeriod = false, corrupted = false;
  for (const captured of row.periods || []) {
    const raw = captured.game;
    if (!raw || !['FT', 'HT', 'UNKNOWN'].includes(captured.period)) continue;
    let validSource = false;
    try {
      validSource = captured.payload?.league === row.league && captured.payload?.boardDate === row.board_date
        && stamp(captured.payload.observedAt) === stamp(captured.observedAt)
        && soccerJournalHash(captured.payload) === captured.observationId
        && createHash('sha256').update(canonicalSoccerPayload(captured.payload)).digest('hex') === captured.payload.contentHash;
    } catch { /* A malformed saved payload remains visible as invalid evidence. */ }
    if (!validSource) {
      corrupted = true; result.integrity.issues.push('SOURCE_PAYLOAD_HASH_MISMATCH');
      const indices = captured.period === 'FT' ? [0, 1] : captured.period === 'HT' ? [2, 3] : [0, 1, 2, 3];
      for (const index of indices) result.markets[index] = { market: MARKET_NAMES[index], status: 'INVALID', lastObservedAt: null };
      continue;
    }
    result.gameLabel = `${raw.awayCode || raw.awayKey || '?'} @ ${raw.homeCode || raw.homeKey || '?'} ${raw.boardTime || ''}`.trim();
    if (captured.period === 'UNKNOWN') {
      unknownPeriod = true;
      result.integrity.issues.push('PERIOD_UNKNOWN');
      continue;
    }
    const offset = captured.period === 'FT' ? 0 : 2;
    for (const [kind, index] of [['HANDICAP', offset], ['TOTAL', offset + 1]]) {
      const markets = Array.isArray(raw.markets) ? raw.markets.filter(m => m.period === captured.period && m.kind === kind && m.unit === 'GOALS') : [];
      const valid = markets.some(m => typeof m.line === 'string' && m.line.trim()
        && (kind === 'HANDICAP' ? ['away', 'home'].includes(m.lineSide) && finitePositive(m.awayWater) && finitePositive(m.homeWater)
          : finitePositive(m.overWater) && finitePositive(m.underWater)));
      const locked = raw.periodStates?.[captured.period] === 'locked';
      result.markets[index] = { market: MARKET_NAMES[index], status: valid ? 'AVAILABLE' : locked ? 'LOCKED' : markets.length ? 'INVALID' : 'NOT_CAPTURED',
        lastObservedAt: valid || locked ? stamp(captured.observedAt) : null };
    }
  }
  if (unknownPeriod) for (const market of result.markets) if (market.status === 'NOT_CAPTURED') market.status = 'PERIOD_UNKNOWN';
  result.integrity.status = corrupted ? 'FAIL' : unknownPeriod ? 'NOT_VERIFIED' : 'PASS';
  result.integrity.issues = [...new Set(result.integrity.issues)];
  return result;
}
function finitePositive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }

function receiptIntegrity(row) {
  const issues = [];
  const marketFlags = row.game?.markets;
  const shapeValid = row.games_format === MARKET_CAPTURE_GAMES_FORMAT && Array.isArray(marketFlags)
    && marketFlags.length === 4 && marketFlags.every(value => typeof value === 'boolean')
    && ['CAPTURED', 'NOT_CAPTURED', 'LOCKED', 'UNOPENED', 'IDENTITY_BLOCKED'].includes(row.game?.captureStatus);
  if (!shapeValid) issues.push('CAPTURE_RECEIPT_SHAPE_INVALID');
  let hashValid = false;
  try {
    const original = { schema: MARKET_CAPTURE_RECEIPT_SCHEMA, gamesFormat: row.games_format, league: row.league, boardDate: row.board_date,
      sourceObservedAt: stamp(row.observed_at), pageActivityAt: stamp(row.page_activity_at),
      sourceHash: row.source_hash?.trim() || null, readerVersion: row.reader_version || null, games: row.games };
    hashValid = /^[a-f0-9]{64}$/.test(row.receipt_id?.trim() || '') && soccerJournalHash(original) === row.receipt_id.trim();
  } catch { /* Corrupted immutable receipts never become saved-market evidence. */ }
  if (!hashValid) issues.push('CAPTURE_RECEIPT_HASH_MISMATCH');
  if (shapeValid) {
    const hasMarkets = marketFlags.some(value => value === true);
    if (hasMarkets) {
      const reference = row.referenced_state;
      const expanded = reference ? expandMarketLineHistoryRow(reference) : null;
      if (row.game.captureStatus !== 'CAPTURED' || !/^[a-f0-9]{16}$/.test(row.game.stateHash || '')
        || !expanded?.integrity.ok || expanded.stateHash !== row.game.stateHash
        || expanded.league !== row.league || expanded.boardDate !== row.board_date || expanded.gameKey !== row.game_key
        || Date.parse(expanded.observedAt) > Date.parse(row.page_activity_at || row.observed_at)
        || expanded.markets.some((market, index) => (market.status === 'AVAILABLE') !== marketFlags[index])) issues.push('CAPTURE_STATE_REFERENCE_INVALID');
    } else if (row.game.stateHash !== null || row.game.captureStatus === 'CAPTURED') issues.push('CAPTURE_STATE_REFERENCE_INVALID');
  }
  return { status: issues.length ? 'FAIL' : 'PASS', issues };
}

export async function queryMarketHistoryCoverage(query, options = {}) {
  const databaseUrl = durableDatabaseUrl(options.env ?? process.env);
  if (!options.sql && !databaseUrl) throw Object.assign(new Error('盤口保存資料庫尚未設定'), { code: 'HISTORY_DATABASE_NOT_CONFIGURED', status: 503 });
  const sql = options.sql || neon(databaseUrl);
  const requested = query.filters.league ? [query.filters.league] : MARKET_HISTORY_COVERAGE_LEAGUES;
  const leagues = new Map(requested.map(league => [league, emptyLeague(league)]));
  const needStates = requested.some(league => STATE_LEAGUES.includes(league));
  const needSoccer = requested.some(league => SOCCER_LEAGUES.includes(league));
  const jobs = [needStates && ['states', readStates], needSoccer && ['soccer', readSoccer], needStates && ['receipts', readReceipts]].filter(Boolean);
  const sources = [], games = new Map();
  let truncated = false, archiveSourcesSucceeded = 0;
  const results = await Promise.allSettled(jobs.map(([, read]) => read(sql, query)));
  for (let index = 0; index < jobs.length; index += 1) {
    const [kind] = jobs[index], result = results[index];
    if (result.status === 'rejected') {
      sources.push({ sourceTable: TABLES[kind], status: result.reason?.code === '42P01' ? 'NOT_READY' : 'FAIL',
        code: result.reason?.code === '42P01' ? 'HISTORY_TABLE_NOT_READY' : 'HISTORY_READ_FAILED' });
      continue;
    }
    sources.push({ sourceTable: TABLES[kind], status: 'PASS' });
    if (kind !== 'receipts') archiveSourcesSucceeded += 1;
    const envelope = result.value;
    truncated ||= envelope.games.length > query.limit;
    for (const row of envelope.leagues) {
      const target = leagues.get(row.league);
      if (!target) continue;
      if (kind === 'receipts') {
        target.captureReceiptCount = number(row.receipt_count);
        target.lastReaderObservedAt = stamp(row.last_reader_observed_at);
        target.lastPersistedAt = stamp(row.last_persisted_at);
      } else {
        Object.assign(target, { status: 'PASS', savedCount: number(row.saved_count), gameDateKeys: number(row.game_date_keys),
          firstBoardDate: row.first_board_date, lastBoardDate: row.last_board_date });
        if (kind === 'states') target.lastStateChangedAt = stamp(row.last_state_changed_at);
        else { target.lastReaderObservedAt = stamp(row.last_reader_observed_at); target.lastPersistedAt = stamp(row.last_persisted_at); }
      }
    }
    // A successfully read empty table is distinguishable from an unreadable table.
    for (const league of requested.filter(value => (kind === 'soccer' ? SOCCER_LEAGUES : STATE_LEAGUES).includes(value))) {
      const target = leagues.get(league);
      if (kind === 'receipts') target.captureReceiptCount ??= 0;
      else if (target.savedCount === null) Object.assign(target, { status: 'PASS', savedCount: 0, gameDateKeys: 0 });
    }
    for (const row of envelope.games.slice(0, query.limit)) {
      if (!leagues.has(row.league)) continue;
      const key = identity({ league: row.league, boardDate: row.board_date, gameKey: row.game_key });
      if (kind === 'states') {
        const expanded = expandMarketLineHistoryRow(row);
        games.set(key, { ...baseGame(row), gameLabel: expanded.gameLabel, archiveObservedAt: stamp(row.observed_at),
          markets: expanded.markets.map(market => ({ market: market.market, status: market.status,
            lastObservedAt: market.status === 'AVAILABLE' ? stamp(row.observed_at) : null })),
          integrity: { status: expanded.integrity.ok ? 'PASS' : 'FAIL', issues: expanded.integrity.issues } });
      } else if (kind === 'soccer') games.set(key, soccerGame(row));
      else {
        const game = games.get(key) || baseGame(row);
        game.lastReaderObservedAt = stamp(row.observed_at); game.lastPersistedAt = stamp(row.persisted_at);
        game.captureStatus = row.game?.captureStatus || null;
        game.receiptIntegrity = receiptIntegrity(row);
        if (game.receiptIntegrity.status === 'FAIL') game.integrity = { status: 'FAIL', issues: [...new Set([...game.integrity.issues, ...game.receiptIntegrity.issues])] };
        // Receipt availability is separate from retained last-change quote evidence.
        game.latestCaptureMarkets = MARKET_NAMES.map((market, marketIndex) => ({ market,
          status: game.receiptIntegrity.status === 'FAIL' || row.game?.captureStatus === 'IDENTITY_BLOCKED' ? 'INVALID'
            : row.game?.captureStatus === 'LOCKED' ? 'LOCKED'
              : row.game?.captureStatus === 'CAPTURED' && row.game?.markets?.[marketIndex] === true ? 'AVAILABLE' : 'NOT_CAPTURED',
          lastObservedAt: stamp(row.observed_at) }));
        games.set(key, game);
      }
    }
  }
  const sortedGames = [...games.values()].sort((left, right) => String(right.lastReaderObservedAt || right.archiveObservedAt || '').localeCompare(String(left.lastReaderObservedAt || left.archiveObservedAt || ''))
    || identity(left).localeCompare(identity(right)));
  truncated ||= sortedGames.length > query.limit || [...leagues.values()].reduce((sum, row) => sum + (row.gameDateKeys || 0), 0) > sortedGames.length;
  if (sources.some(source => source.sourceTable === TABLES.receipts && source.status !== 'PASS')) {
    for (const row of leagues.values()) if (STATE_LEAGUES.includes(row.league) && row.status === 'PASS') row.status = 'PARTIAL';
  }
  return { ok: archiveSourcesSucceeded > 0, status: archiveSourcesSucceeded === 0 ? 'FAIL' : sources.some(source => source.status !== 'PASS') ? 'PARTIAL' : 'PASS',
    schema: MARKET_HISTORY_COVERAGE_SCHEMA, until: query.until, filters: query.filters, sources,
    leagues: [...leagues.values()], games: sortedGames.slice(0, query.limit), gameRowsTruncated: truncated,
    productionWrites: false, coverageComplete: false, closingCoverage: 'NOT_VERIFIED',
    notes: ['變盤版本數與足球觀測回條數是不同單位，不可加總為比賽場數。',
      '最後變盤時間不等於最後讀盤時間；舊紀錄沒有讀盤回條時保持未驗證。',
      '只列已保存的場次識別，未與全部官方賽程比對；不代表全部賽事或最後尾盤完整。',
      '每場只列最新保存狀態的市場；未保存的半場、未知時段與鎖盤不補值。'] };
}
