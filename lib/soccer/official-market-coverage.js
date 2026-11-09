// Server-only, read-only source coverage. This is neither scoring nor evidence
// that today's schedule was available when a historical Reader row was seen.
import { createHmac, timingSafeEqual } from 'node:crypto';
import '../../reader/league-registry.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { fetchSoccerSchedule } from './data.js';
import { soccerJournalHash, soccerJournalQuery } from './journal.js';
import { loadSoccerReaderSnapshot } from './reader-store.js';
import { matchSoccerReaderGames } from './reader.js';
import { soccerCompleteScheduleAuthorityVerified } from './reader-identity-proof.js';
import { soccerMarketHasVerifiedPeriodResolution } from './reader-period-binding.js';
import { validateRetrospectiveReaderReceipt } from './retrospective-reader-receipts.js';
import { soccerTeamLabel } from './team-labels.js';

export const SOCCER_OFFICIAL_MARKET_COVERAGE_VERSION = 'SOCCER-OFFICIAL-MARKET-COVERAGE-v1';
export const SOCCER_REQUIRED_MARKET_CELLS = Object.freeze(['FT:HANDICAP', 'FT:TOTAL', 'HT:HANDICAP', 'HT:TOTAL']);
const MAX_ROWS = 10000, MAX_PAGE_BYTES = 8 * 1024 * 1024, PAGE_ROWS = 20;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(value) && Number.isFinite(Date.parse(value));
const integer = value => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const cells = factory => Object.fromEntries(SOCCER_REQUIRED_MARKET_CELLS.map(key => [key, factory()]));
const error = (code, status = 503) => Object.assign(Error(code), { code, status });
const sign = (value, secret) => createHmac('sha256', secret).update(`SOCCER-OFFICIAL-MARKET-COVERAGE-v1\n${value}`).digest('base64url');

export function normalizeSoccerOfficialMarketCoverageQuery(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['league', 'date', 'cursor'].includes(key)) ||
      typeof input.league !== 'string' || !soccerLeague(input.league) || !validSoccerDate(input.date) ||
      (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 1600))) throw error('SOCCER_MARKET_COVERAGE_QUERY_INVALID', 400);
  return { league: soccerLeague(input.league).id, date: input.date, cursor: input.cursor || null };
}
function decodeCursor(value, secret, league, date) {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw error('SOCCER_MARKET_COVERAGE_CURSOR_INVALID', 400);
  const [body, signature] = value.split('.'), expected = sign(body, secret);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw error('SOCCER_MARKET_COVERAGE_CURSOR_INVALID', 400);
  let parsed; try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw error('SOCCER_MARKET_COVERAGE_CURSOR_INVALID', 400); }
  if (parsed.v !== 1 || parsed.league !== league || parsed.date !== date || !timestamp(parsed.cutoffAt) || !hex(parsed.snapshotHash) || !hex(parsed.scheduleFingerprint) ||
      !Number.isSafeInteger(parsed.after) || parsed.after < 1 || parsed.after > MAX_ROWS || !Number.isSafeInteger(parsed.total) || parsed.total < parsed.after || parsed.total > MAX_ROWS)
    throw error('SOCCER_MARKET_COVERAGE_CURSOR_INVALID', 400);
  return parsed;
}
function encodeCursor(value, secret) { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${sign(body, secret)}`; }

function marketPeriod(market, now, historical) {
  const proof = market.periodEvidence;
  const parsed = globalThis.Tai888LeagueRegistry.soccerPeriodEvidence({ sectionTitle: proof?.sectionTitle, headers: proof?.tableHeaders, marketHeader: proof?.marketHeader, truncated: proof?.truncated });
  if (parsed.status === 'EXCLUDED') return null;
  // No later account configuration can relabel an old source row as FT.
  if (!historical && soccerMarketHasVerifiedPeriodResolution(market, now)) return 'FT';
  return parsed.status === 'EXPLICIT' && parsed.period === market.period ? parsed.period : 'UNKNOWN';
}
function receiptUsable(source, now, kickoff) {
  if (!hex(source?.observationId)) return false;
  const times = ['observedAt', 'firstFetchedAt', 'receivedAt', 'persistedAt'].map(key => Date.parse(source[key] || ''));
  return times.every(time => Number.isFinite(time) && time <= now && time < kickoff) && now - times[0] <= 180000 && times[0] <= times[2] && times[1] <= times[2] && times[2] <= times[3];
}
function summarizeMatched(raw, capture, game, now, historical = false) {
  const result = { cells: cells(() => ({ marketIds: new Set(), completeMarketIds: new Set(), quoteIds: new Set(), freshPregameIds: new Set() })), unknownPeriodQuoteCount: 0 };
  for (const market of raw.markets) {
    if (market?.unit !== 'GOALS' || !['HANDICAP', 'TOTAL'].includes(market.kind) || typeof market.line !== 'string' ||
        !/^(\d+(?:\.\d+)?)(?:平|[+-]\d{1,3})?$/.test(market.line) || market.kind === 'HANDICAP' && !['home', 'away'].includes(market.lineSide)) continue;
    const period = marketPeriod(market, now, historical); if (!period) continue;
    const sides = market.kind === 'HANDICAP' ? ['home', 'away'] : ['over', 'under'];
    const quoted = sides.filter(side => Number.isFinite(market[`${side}Water`]) && market[`${side}Water`] > 0 && market[`${side}Water`] <= 1000);
    if (period === 'UNKNOWN') { result.unknownPeriodQuoteCount += quoted.length; continue; }
    const cell = result.cells[`${period}:${market.kind}`]; if (!cell) continue;
    const contract = { period, kind: market.kind, line: market.line, lineSide: market.lineSide || null }, marketId = soccerJournalHash(contract);
    cell.marketIds.add(marketId);
    for (const side of quoted) cell.quoteIds.add(soccerJournalHash({ ...contract, side, water: market[`${side}Water`], rawRows: market.rawRows || [] }));
    // Never manufacture a two-sided market by joining two incomplete captures.
    if (quoted.length === 2) {
      cell.completeMarketIds.add(marketId);
      const source = market.serverObservation || (capture.isPeriodAggregate ? null : capture);
      if (!historical && game.status === 'scheduled' && Date.parse(game.startTime) > now && receiptUsable(source, now, Date.parse(game.startTime))) cell.freshPregameIds.add(marketId);
    }
  }
  return result;
}
function mergeSeen(target, source) {
  for (const key of SOCCER_REQUIRED_MARKET_CELLS) for (const field of ['marketIds', 'completeMarketIds', 'quoteIds']) for (const value of source.cells[key][field]) target.cells[key][field].add(value);
  target.unknownPeriodQuoteCount += source.unknownPeriodQuoteCount;
}
function exposeSeen(value) {
  return { cells: Object.fromEntries(SOCCER_REQUIRED_MARKET_CELLS.map(key => [key, Object.fromEntries(['marketIds', 'completeMarketIds', 'quoteIds'].map(field => [field, [...value.cells[key][field]].sort()]))])), unknownPeriodQuoteCount: value.unknownPeriodQuoteCount };
}
function rawKey(raw) { return soccerJournalHash([raw.boardDate, raw.boardTime, raw.homeKey, raw.awayKey]); }
function unmatchedRows(matched, target) {
  for (const raw of matched.filter(item => item.matchStatus !== 'MATCHED')) {
    const key = rawKey(raw), existing = target.get(key);
    if (existing) existing.observationCount++;
    else target.set(key, { key, label: `${raw.boardTime || '?'} ${raw.awayCode || raw.awayKey || '?'} @ ${raw.homeCode || raw.homeKey || '?'}`, status: raw.matchStatus === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'UNMATCHED', observationCount: 1 });
  }
}

/** Each invocation verifies one bounded ORIGINAL page. The signed cursor fixes
 * the first MVCC manifest; consumers must merge pages from readFrom=0 in order.
 * The last cursor page alone is deliberately not a full-scan certificate. */
export async function readSoccerOfficialMarketCoverage(input, { query = soccerJournalQuery, schedule = fetchSoccerSchedule, loadCurrent = loadSoccerReaderSnapshot,
  now = Date.now(), secret = process.env.SESSION_SECRET || process.env.APP_PASSWORD, limits = {} } = {}) {
  const { league, date, cursor } = normalizeSoccerOfficialMarketCoverageQuery(input);
  if (typeof secret !== 'string' || !secret) throw error('SOCCER_MARKET_COVERAGE_CURSOR_NOT_CONFIGURED');
  if (typeof query !== 'function' || typeof schedule !== 'function' || typeof loadCurrent !== 'function' || !Number.isFinite(now)) throw error('SOCCER_MARKET_COVERAGE_DEPENDENCY_INVALID');
  const pageRows = limits.pageRows ?? PAGE_ROWS, pageBytes = limits.pageBytes ?? MAX_PAGE_BYTES;
  if (!Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > 50 || !Number.isSafeInteger(pageBytes) || pageBytes < 4096 || pageBytes > MAX_PAGE_BYTES) throw error('SOCCER_MARKET_COVERAGE_LIMIT_INVALID');
  const continuation = cursor ? decodeCursor(cursor, secret, league, date) : null;
  const deadline = Date.now() + 25000;
  const bounded = async operation => {
    const remaining = deadline - Date.now(); if (remaining <= 0) throw error('SOCCER_MARKET_COVERAGE_READ_TIMEOUT');
    let timer;
    try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(error('SOCCER_MARKET_COVERAGE_READ_TIMEOUT')), remaining); })]); }
    finally { clearTimeout(timer); }
  };
  const read = (sql, values) => bounded(() => query(sql, values));
  const board = await bounded(() => schedule(league, date, { windowDays: 1 }));
  if (board?.ok !== true || board.league?.id !== league || board.date !== date || board.until !== date || board.coverage?.complete !== true || !Array.isArray(board.games) ||
      board.games.length > 100 || board.games.some(game => game.league !== league || game.date !== date || !soccerCompleteScheduleAuthorityVerified(board, game))) throw error('SOCCER_MARKET_COVERAGE_SCHEDULE_UNAVAILABLE');
  const scheduleFingerprint = soccerJournalHash(board.games.map(game => ({ id: game.id, league: game.league, date: game.date, startTime: game.startTime, status: game.status, home: game.home.sourceId, away: game.away.sourceId })).sort((a, b) => a.id.localeCompare(b.id)));
  if (continuation && continuation.scheduleFingerprint !== scheduleFingerprint) throw error('SOCCER_MARKET_COVERAGE_SCOPE_CHANGED', 409);
  const manifestRows = await read(`WITH cutoff AS MATERIALIZED (SELECT COALESCE($3::timestamptz,statement_timestamp()) AS at), limited AS MATERIALIZED (
    SELECT o.observation_id,o.content_hash,o.source_observed_at,o.received_at,o.persisted_at,octet_length(o.payload::text) AS payload_bytes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('period',p.period,'contentHash',p.content_hash) ORDER BY p.period)
        FROM sports_soccer_reader_period_observations_v2 p WHERE p.observation_id=o.observation_id),
        CASE WHEN NOT (o.payload ? 'periodsCovered') THEN jsonb_build_array(jsonb_build_object('period','UNKNOWN','contentHash',o.content_hash)) ELSE '[]'::jsonb END) AS periods
    FROM sports_soccer_reader_observations_v2 o,cutoff WHERE o.league=$1 AND o.board_date=$2::date AND o.persisted_at<=cutoff.at
    ORDER BY o.observation_id LIMIT 10001
  ) SELECT to_char(cutoff.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cutoffAt", (SELECT count(*)::text FROM limited) AS n,
    CASE WHEN (SELECT count(*) FROM limited)<=10000 THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('observationId',observation_id,'contentHash',content_hash,
      'sourceObservedAt',to_char(source_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'receivedAt',to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'persistedAt',to_char(persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'payloadBytes',payload_bytes,'periods',periods)
      ORDER BY observation_id) FROM limited),'[]'::jsonb) ELSE '[]'::jsonb END AS items FROM cutoff`, [league.toUpperCase(), date, continuation?.cutoffAt || null]);
  const manifest = manifestRows?.[0], count = integer(manifest?.n);
  if (!manifest || count === null || count > MAX_ROWS + 1 || !timestamp(manifest.cutoffAt) || !Array.isArray(manifest.items)) throw error('SOCCER_MARKET_COVERAGE_MANIFEST_UNAVAILABLE');
  const rowBudgetExceeded = count > MAX_ROWS;
  if (!rowBudgetExceeded && (manifest.items.length !== count || new Set(manifest.items.map(row => row.observationId)).size !== count || manifest.items.some(row =>
    !hex(row.observationId) || !hex(row.contentHash) || !timestamp(row.sourceObservedAt) || !timestamp(row.receivedAt) || !timestamp(row.persistedAt) ||
    Date.parse(row.persistedAt) > Date.parse(manifest.cutoffAt) || !Number.isSafeInteger(row.payloadBytes) || row.payloadBytes < 2 || !Array.isArray(row.periods)))) throw error('SOCCER_MARKET_COVERAGE_MANIFEST_UNAVAILABLE');
  const snapshotHash = soccerJournalHash({ league, date, cutoffAt: manifest.cutoffAt, items: manifest.items }), readFrom = continuation?.after || 0;
  if (continuation && (continuation.snapshotHash !== snapshotHash || continuation.total !== count || continuation.cutoffAt !== manifest.cutoffAt)) throw error('SOCCER_MARKET_COVERAGE_SCOPE_CHANGED', 409);
  const selected = []; let bytes = 2;
  for (const row of manifest.items.slice(readFrom, readFrom + pageRows)) {
    const cost = row.payloadBytes + Buffer.byteLength(JSON.stringify(row)) + 2048;
    if (bytes + cost > pageBytes) break;
    selected.push(row); bytes += cost;
  }
  const reasonCodes = rowBudgetExceeded ? ['READER_RECEIPT_METADATA_ROW_BUDGET'] : count > readFrom && !selected.length ? ['READER_ORIGINAL_DOCUMENT_BYTE_BUDGET'] : [];
  const games = board.games.map(game => ({ gameId: game.id, label: `${soccerTeamLabel(game.away)} @ ${soccerTeamLabel(game.home)}`, startTime: game.startTime, status: game.status,
    seen: { cells: cells(() => ({ marketIds: new Set(), completeMarketIds: new Set(), quoteIds: new Set() })), unknownPeriodQuoteCount: 0 }, current: null }));
  const byId = new Map(games.map(game => [game.gameId, game])), unmatched = new Map();
  if (selected.length) {
    const results = await read(`WITH encoded AS MATERIALIZED (
      SELECT jsonb_build_object('observationId',o.observation_id,'contentHash',o.content_hash,
        'sourceObservedAt',to_char(o.source_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'payloadObservedAt',to_char((o.payload->>'observedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'receivedAt',to_char(o.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'persistedAt',to_char(o.persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'payload',o.payload) AS item
      FROM sports_soccer_reader_observations_v2 o WHERE o.league=$1 AND o.board_date=$2::date AND o.observation_id=ANY($3::text[])
    ), bounds AS (SELECT count(*) AS n,COALESCE(sum(octet_length(item::text)),0)+GREATEST(count(*)-1,0)*2+2 AS bytes FROM encoded)
    SELECT n::text AS n,bytes::text AS bytes,CASE WHEN bytes<=$4::integer THEN COALESCE((SELECT jsonb_agg(item) FROM encoded),'[]'::jsonb) ELSE '[]'::jsonb END AS items FROM bounds`,
    [league.toUpperCase(), date, selected.map(row => row.observationId), pageBytes]);
    const result = results?.[0];
    if (!result || integer(result.n) !== selected.length || integer(result.bytes) === null || integer(result.bytes) > pageBytes || !Array.isArray(result.items) || result.items.length !== selected.length) throw error('SOCCER_MARKET_COVERAGE_ORIGINAL_PAGE_UNAVAILABLE');
    const expected = new Map(selected.map(row => [row.observationId, row]));
    for (const original of result.items) {
      const meta = expected.get(original.observationId);
      if (!meta || ['contentHash', 'sourceObservedAt', 'receivedAt', 'persistedAt'].some(key => meta[key] !== original[key])) throw error('SOCCER_MARKET_COVERAGE_ORIGINAL_MISMATCH');
      const verified = validateRetrospectiveReaderReceipt({ ...original, periods: meta.periods }, league, date); expected.delete(original.observationId);
      const capture = { ...verified.payload, observationId: verified.observationId, observedAt: verified.sourceObservedAt, firstFetchedAt: null, receivedAt: verified.receivedAt, persistedAt: verified.persistedAt };
      const matched = matchSoccerReaderGames(capture, board.games, now); unmatchedRows(matched, unmatched);
      for (const raw of matched.filter(item => item.matchStatus === 'MATCHED')) mergeSeen(byId.get(raw.officialGameId).seen, summarizeMatched(raw, capture, board.games.find(game => game.id === raw.officialGameId), now, true));
    }
    if (expected.size) throw error('SOCCER_MARKET_COVERAGE_ORIGINAL_PAGE_UNAVAILABLE');
  }
  let currentStatus = 'AVAILABLE', currentObservedAt = null, currentUnmatched = [];
  try {
    let hasCurrentReceipt = true;
    if (loadCurrent === loadSoccerReaderSnapshot) {
      // Bound the existing store's head hydration before it reads any originals.
      // Its old unreceipted v1 fallback is outside this v2 receipt audit.
      const rows = await read(`WITH current_refs AS MATERIALIZED (
        SELECT h.observation_id FROM sports_soccer_reader_period_heads_v2 h WHERE h.league=lower($1) AND h.board_date=$2::date
        UNION ALL SELECT legacy.observation_id FROM (
          SELECT o.observation_id FROM sports_soccer_reader_observations_v2 o WHERE o.league=$1 AND o.board_date=$2::date AND NOT (o.payload ? 'periodsCovered')
          ORDER BY o.source_observed_at DESC,o.received_at DESC,o.observation_id DESC LIMIT 1) legacy
        WHERE NOT EXISTS (SELECT 1 FROM sports_soccer_reader_period_heads_v2 h WHERE h.league=lower($1) AND h.board_date=$2::date AND h.period='UNKNOWN')
      ) SELECT count(*)::text AS n,count(o.observation_id)::text AS hydrated,COALESCE(sum(octet_length(o.payload::text)),0)::text AS bytes
        FROM current_refs r LEFT JOIN sports_soccer_reader_observations_v2 o ON o.observation_id=r.observation_id AND o.league=$1 AND o.board_date=$2::date`, [league.toUpperCase(), date]);
      const row = rows?.[0], n = integer(row?.n), hydrated = integer(row?.hydrated), sourceBytes = integer(row?.bytes);
      if (n === null || hydrated !== n || n > 3 || sourceBytes === null || sourceBytes > MAX_PAGE_BYTES) throw error('CURRENT_READER_BYTE_BUDGET');
      hasCurrentReceipt = n > 0;
    }
    const capture = hasCurrentReceipt ? await bounded(() => loadCurrent(league, date)) : null;
    if (capture === null) currentStatus = 'NO_ACTIVE_HEAD';
    else if (!capture || soccerLeague(capture.league)?.id !== league || capture.boardDate !== date || !Array.isArray(capture.games) || capture.games.some(raw => !Array.isArray(raw.markets))) throw error('CURRENT_READER_UNAVAILABLE');
    const matched = capture ? matchSoccerReaderGames(capture, board.games, now) : [], currentUnmatchedMap = new Map(); unmatchedRows(matched, currentUnmatchedMap); currentUnmatched = [...currentUnmatchedMap.values()];
    currentObservedAt = capture?.observedAt || null;
    for (const game of board.games) {
      const summary = { cells: cells(() => ({ marketIds: new Set(), completeMarketIds: new Set(), quoteIds: new Set(), freshPregameIds: new Set() })), unknownPeriodQuoteCount: 0 };
      for (const raw of matched.filter(item => item.matchStatus === 'MATCHED' && item.officialGameId === game.id)) {
        const part = summarizeMatched(raw, capture, game, now); mergeSeen(summary, part);
        for (const key of SOCCER_REQUIRED_MARKET_CELLS) for (const value of part.cells[key].freshPregameIds) summary.cells[key].freshPregameIds.add(value);
      }
      byId.get(game.id).current = { status: currentStatus, observedAt: currentObservedAt, cells: Object.fromEntries(SOCCER_REQUIRED_MARKET_CELLS.map(key => [key, {
        marketCount: summary.cells[key].marketIds.size, completePriceMarketCount: summary.cells[key].completeMarketIds.size, freshPregameMarketCount: summary.cells[key].freshPregameIds.size, quoteCount: summary.cells[key].quoteIds.size }])), unknownPeriodQuoteCount: summary.unknownPeriodQuoteCount };
    }
  } catch { currentStatus = 'NOT_VERIFIED'; reasonCodes.push('CURRENT_READER_UNAVAILABLE'); for (const game of games) game.current = { status: currentStatus, observedAt: null, cells: null }; }
  const readCount = selected.length, readThrough = readFrom + readCount, hasMore = !rowBudgetExceeded && readThrough < count && readCount > 0;
  const scopeComplete = readFrom === 0 && readThrough === count && !reasonCodes.some(code => code !== 'CURRENT_READER_UNAVAILABLE');
  const nextCursor = hasMore ? encodeCursor({ v: 1, league, date, cutoffAt: manifest.cutoffAt, snapshotHash, scheduleFingerprint, after: readThrough, total: count }, secret) : null;
  return { ok: true, report: { version: SOCCER_OFFICIAL_MARKET_COVERAGE_VERSION, league, date,
    status: scopeComplete && board.games.length ? 'COMPLETE_PROVIDER_SCOPE' : 'PARTIAL',
    schedule: { fingerprint: scheduleFingerprint, sourceScope: 'RETURNED_PROVIDER_PAGES_ONLY', officialGameCount: board.games.length, empty: !board.games.length,
      sourceVerified: Boolean(board.games.length), providerCompletenessVerified: false, sources: (board.sources || []).map(source => ({ provider: source.provider, url: source.url, fetchedAt: source.fetchedAt, contentHash: source.contentHash })) },
    history: { snapshotHash, cutoffAt: manifest.cutoffAt, totalReceipts: rowBudgetExceeded ? null : count, readFrom, readCount, readThrough, hasMore, nextCursor, scopeComplete,
      integrityStatus: reasonCodes.some(code => code !== 'CURRENT_READER_UNAVAILABLE') ? 'NOT_VERIFIED' : 'VERIFIED_PAGE', historicalAvailabilityVerified: false },
    games: games.map(game => ({ ...game, seen: exposeSeen(game.seen) })), unmatched: [...unmatched.values()], currentUnmatched,
    diagnostics: { currentStatus, currentAsOf: new Date(now).toISOString(), reasonCodes, requiredCells: [...SOCCER_REQUIRED_MARKET_CELLS],
      currentScope: 'DURABLE_V2_PERIOD_HEADS_ONLY', absenceMeaning: 'NOT_SEEN_IN_VERIFIED_RECEIPTS_NOT_PROOF_OF_UNOPENED_OR_MISSED_MARKET', countsDescribe: 'UNIQUE_CONTRACT_LINES_AND_PRICE_VARIANTS_NOT_GAMES', historicalIdentityScope: 'DISPLAY_MATCH_TO_CURRENT_PROVIDER_SCHEDULE_NOT_PREGAME_PROOF' },
    coverageComplete: false, formalEligible: false, executable: false } };
}
