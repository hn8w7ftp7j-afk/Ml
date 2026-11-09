// Read-only historical witnesses. A returned price is not a current quote,
// a pregame identity proof, a complete history or a closing-line certificate.
import '../../reader/league-registry.js';
import '../../reader/soccer-teams.js';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { readReaderSeenCaptureBatchMetadata, readReaderSeenCaptureBatch } from '../reader-seen-capture.js';
import { fetchSoccerSchedule } from './data.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { soccerJournalHash } from './journal.js';
import { soccerCompleteScheduleAuthorityVerified } from './reader-identity-proof.js';
import { matchSoccerReaderGames } from './reader.js';
import { soccerTeamLabel } from './team-labels.js';
import { deriveRawSeenSoccerHistory, RAW_SEEN_DERIVATION_VERSION, RAW_SEEN_READABLE_DERIVATION_VERSIONS } from './raw-seen-history.js';

export const RAW_MARKET_COVERAGE_SCHEMA = 'soccer-raw-market-coverage-v1';
export const RAW_MARKET_COVERAGE_FLAGS = Object.freeze({ archiveOnly: true, currentBoardUpdated: false,
  historicalAvailabilityVerified: false, executable: false, formalEligible: false, calibrationEligible: false,
  coverageComplete: false, closingCoverage: 'NOT_VERIFIED', completeHistory: false, identityVerified: false,
  simultaneousCoverageVerified: false });
const CELLS = ['FT:HANDICAP', 'FT:TOTAL', 'HT:HANDICAP', 'HT:TOTAL'];
const HASH = /^[a-f0-9]{64}$/, MAX_BYTES = 10485760, MAX_METADATA_BYTES = 2097152, TIME_MS = 25000, MAX_BATCHES = 8, MAX_CANDIDATES = 200;
const fail = (code, status = 503) => Object.assign(Error(code), { code, status });
const check = (ok, code, status) => { if (!ok) throw fail(code, status); };
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(value) && Number.isFinite(Date.parse(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const precise = value => value.replace(/\.(\d{3,6})Z$/, (_, fraction) => `.${fraction.padEnd(6, '0')}Z`);
const code = error => /^(?:RAW_MARKET_COVERAGE_|RAW_SEEN_RECOVERY_|READER_SEEN_CAPTURE_)[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'RAW_MARKET_COVERAGE_UNAVAILABLE';
let client;

export function parseRawMarketCoverageQuery(params) {
  if ([...params.keys()].some(key => !['league', 'date'].includes(key) || params.getAll(key).length !== 1)) throw fail('RAW_MARKET_COVERAGE_QUERY_INVALID', 400);
  const league = soccerLeague(params.get('league'))?.id, date = params.get('date');
  if (!['epl', 'ucl'].includes(league) || !validSoccerDate(date)) throw fail('RAW_MARKET_COVERAGE_QUERY_INVALID', 400);
  return { league: league.toUpperCase(), date };
}
function database(options) {
  if (options.db) return options.db;
  const url = durableDatabaseUrl(); check(url, 'RAW_MARKET_COVERAGE_STORAGE_UNAVAILABLE'); return client ||= neon(url);
}
// Each statement is bounded on the database and transport. Cancellation cannot
// prove server-side termination, so the response explicitly calls this SOFT.
function deadlineDatabase(source, deadline, clock) {
  async function run(queries, options = {}) {
    const left = deadline - clock(); check(left > 0, 'RAW_MARKET_COVERAGE_TIME_BUDGET');
    const timeout = String(Math.max(1, Math.min(5000, Math.floor(left / (queries.length + 2)))));
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), left);
    try {
      const values = await source.transaction([source`SELECT set_config('statement_timeout',${timeout},true)`,
        source`SELECT set_config('lock_timeout',${timeout},true)`, ...queries.map(q => source.query(q.query, q.params))],
      { ...options, fetchOptions: { ...options.fetchOptions, signal: controller.signal } });
      check(clock() < deadline, 'RAW_MARKET_COVERAGE_TIME_BUDGET'); return values.slice(2);
    } finally { clearTimeout(timer); }
  }
  const query = (query, params = []) => ({ query, params, then(a, b) { return run([{ query, params }]).then(rows => rows[0]).then(a, b); } });
  const db = (parts, ...params) => query(parts.reduce((s, part, i) => s + (i ? '$' + i : '') + part, ''), params);
  db.query = query; db.transaction = (queries, options) => run(queries, options); return db;
}
function validCandidate(row, league, date) {
  const m = row.metadata, b = row.batch_metadata;
  return row.league === league && row.board_date_text === date && typeof row.game_key === 'string' && row.game_key.length <= 200
    && m?.league === league && m.boardDate === date && m.gameKey === row.game_key && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(m.boardTime || '')
    && ['homeKey', 'awayKey', 'homeRaw', 'awayRaw'].every(key => typeof m[key] === 'string' && m[key].length > 0 && m[key].length <= 240)
    && integer(m.marketCount) && m.marketCount <= 200 && HASH.test(row.batch_hash?.trim() || '') && HASH.test(row.derived_hash?.trim() || '')
    && b?.derivedHash === row.derived_hash.trim() && b.derivationVersion === row.derivation_version
    && RAW_SEEN_READABLE_DERIVATION_VERSIONS.includes(row.derivation_version) && b.capture?.league === league && HASH.test(b.capture.captureId || '')
    && instant(row.observed_at_exact);
}
function gameId(raw, league, board, now) {
  const identity = Object.fromEntries(['league', 'boardDate', 'boardTime', 'homeKey', 'awayKey', 'homeRaw', 'awayRaw']
    .filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]));
  return matchSoccerReaderGames({ league, games: [{ ...identity, markets: [] }] }, board.games, now)[0]?.officialGameId || null;
}
function quoteWitness(market, replay, gameId, rawGameKey) {
  const [period, kind] = [market.period, market.kind], proof = market.periodEvidence, source = market.source;
  if (!CELLS.includes(`${period}:${kind}`) || market.unit !== 'GOALS' || !/^(\d+(?:\.\d+)?)(?:平|[+-]\d{1,3})?$/.test(market.line || '')
    || typeof market.isAlternative !== 'boolean' || proof?.basis !== 'SAME_ROW_PRIMARY_AND_EXPLICIT_HT_COLUMNS' || proof.originalPeriod !== (period === 'FT' ? 'UNKNOWN' : 'HT')
    || !['tableIndex', 'rowIndex', 'columnIndex'].every(key => integer(source?.[key]))) return null;
  const expectedColumn = (market.isAlternative ? { 'FT:HANDICAP': 2, 'FT:TOTAL': 3, 'HT:HANDICAP': 4, 'HT:TOTAL': 5 }
    : { 'FT:HANDICAP': 3, 'FT:TOTAL': 4, 'HT:HANDICAP': 6, 'HT:TOTAL': 7 })[`${period}:${kind}`];
  if (source.columnIndex !== expectedColumn) return null;
  const sides = kind === 'HANDICAP' ? ['homeWater', 'awayWater'] : ['overWater', 'underWater'];
  if (kind === 'HANDICAP' && !['home', 'away'].includes(market.lineSide) || sides.some(key => !Number.isFinite(market[key]) || market[key] <= 0 || market[key] > 1000)) return null;
  return { gameId, rawGameKey, batchHash: replay.captureBatchId, derivedHash: replay.derivedHash, sourceObservedAt: replay.observedAt,
    sourceReceivedAt: replay.receivedAt, sourcePersistedAt: replay.persistedAt, period, originalPeriod: proof.originalPeriod,
    periodBasis: proof.basis, kind, line: market.line, lineSide: kind === 'HANDICAP' ? market.lineSide : null, isAlternative: market.isAlternative,
    ...Object.fromEntries(['homeWater', 'awayWater', 'overWater', 'underWater'].map(key => [key, sides.includes(key) ? market[key] : null])),
    source: Object.fromEntries(['tableIndex', 'rowIndex', 'columnIndex'].map(key => [key, source[key]])) };
}

export async function readRawMarketCoverage(input, options = {}) {
  const filters = parseRawMarketCoverageQuery(new URLSearchParams(Object.entries(input || {})));
  const now = options.now ?? Date.now(), clock = options.clock || Date.now, timeBudgetMs = Math.min(TIME_MS, options.timeBudgetMs ?? TIME_MS),
    maxSourceBytes = Math.min(MAX_BYTES, options.maxSourceBytes ?? MAX_BYTES), maxBatchReads = Math.min(MAX_BATCHES, options.maxBatchReads ?? MAX_BATCHES),
    maxMetadataBytes = Math.min(MAX_METADATA_BYTES, options.maxMetadataBytes ?? MAX_METADATA_BYTES);
  check(integer(timeBudgetMs) && timeBudgetMs > 0 && integer(maxSourceBytes) && maxSourceBytes > 0 && integer(maxBatchReads) && maxBatchReads > 0
    && integer(maxMetadataBytes) && maxMetadataBytes > 0, 'RAW_MARKET_COVERAGE_OPTIONS_INVALID');
  const until = new Date(now).toISOString(), deadline = clock() + timeBudgetMs;
  const result = { ok: true, schema: RAW_MARKET_COVERAGE_SCHEMA, ...RAW_MARKET_COVERAGE_FLAGS, ...filters, until,
    status: 'PARTIAL', schedule: null, inventory: null, games: [], sources: [], reasonCodes: [],
    budget: { maxBatchReads, batchReads: 0, sourceBytesReserved: 0, sourceBytesRead: 0, maxSourceBytes, timeBudgetMs,
      maxMetadataBytes, metadataBytesRead: 0, metadataByteBasis: 'SERIALIZED_CANDIDATE_ROWS_JSONB_TEXT',
      budgetKind: 'SOFT_DEADLINE', hardDeadlineEnforced: false } };
  try {
    const db = deadlineDatabase(database(options), deadline, clock), schedule = options.schedule || fetchSoccerSchedule;
    let timer;
    const board = await Promise.race([schedule(filters.league.toLowerCase(), filters.date, { windowDays: 1 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(fail('RAW_MARKET_COVERAGE_SCHEDULE_TIMEOUT')), Math.max(1, deadline - clock())); })]).finally(() => clearTimeout(timer));
    check(board?.ok === true && board.league?.id === filters.league.toLowerCase() && board.date === filters.date && board.until === filters.date
      && board.coverage?.complete === true && Array.isArray(board.games) && board.games.length <= 100
      && board.games.every(game => game.league === board.league.id && game.date === filters.date && soccerCompleteScheduleAuthorityVerified(board, game)), 'RAW_MARKET_COVERAGE_SCHEDULE_UNAVAILABLE');
    result.schedule = { fingerprint: soccerJournalHash(board.games.map(g => ({ id: g.id, startTime: g.startTime, home: g.home.sourceId, away: g.away.sourceId })).sort((a, b) => a.id.localeCompare(b.id))),
      officialGameCount: board.games.length, sourceScope: 'RETURNED_PROVIDER_PAGES_ONLY', providerCompletenessVerified: false };
    result.games = board.games.map(game => ({ gameId: game.id, label: `${soccerTeamLabel(game.away)} @ ${soccerTeamLabel(game.home)}`,
      startTime: game.startTime, status: game.status, identityBasis: 'DISPLAY_MATCH_TO_CURRENT_PROVIDER_SCHEDULE', witnessStatus: 'NOT_CHECKED', rawGameKeys: [],
      cells: Object.fromEntries(CELLS.map(key => [key, { status: 'NOT_CHECKED', witnesses: [] }])) }));
    const byId = new Map(result.games.map(game => [game.gameId, game])), checked = new Set();
    // Only index metadata is ranked. No original evidence or normalized Reader
    // journal is scanned; latest and most-populated representatives are merely
    // candidate hints and never establish a price or market-cell certificate.
    const envelope = (await db.query(`WITH scoped_hashes AS MATERIALIZED (
      SELECT DISTINCT batch_hash FROM soccer_raw_seen_history_games_v1 WHERE league=$1 AND board_date=$2::date
    ), selected_batches AS MATERIALIZED (
      SELECT DISTINCT ON (b.batch_hash) b.batch_hash,b.derivation_version,b.derived_hash,b.observed_at,b.metadata
      FROM soccer_raw_seen_history_batches_v1 b JOIN scoped_hashes h USING(batch_hash)
      WHERE b.league=$1 AND b.indexed_at<=$3::timestamptz AND b.derivation_version=ANY($4::text[])
      ORDER BY b.batch_hash,(b.derivation_version=$5) DESC,b.derivation_version DESC
    ), ranked AS (SELECT g.league,g.game_key,g.metadata,g.board_date::text AS board_date_text,b.batch_hash,b.derivation_version,b.derived_hash,b.metadata AS batch_metadata,
      to_char(b.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at_exact,
      row_number() OVER(PARTITION BY g.game_key ORDER BY b.observed_at DESC,b.batch_hash) AS latest,
      row_number() OVER(PARTITION BY g.game_key ORDER BY b.observed_at,b.batch_hash) AS oldest,
      row_number() OVER(PARTITION BY g.game_key ORDER BY CASE WHEN (g.metadata->>'marketCount') ~ '^[0-9]{1,3}$' THEN (g.metadata->>'marketCount')::int ELSE 0 END DESC,b.observed_at DESC,b.batch_hash) AS populated
      FROM soccer_raw_seen_history_games_v1 g JOIN selected_batches b USING(batch_hash,derivation_version) WHERE g.league=$1 AND g.board_date=$2::date),
      candidate_page AS MATERIALIZED (SELECT * FROM ranked WHERE latest=1 OR populated=1 OR oldest=1 ORDER BY game_key,observed_at_exact DESC,batch_hash LIMIT $6),
      bounds AS (SELECT count(*)::int AS n,coalesce(sum(octet_length(to_jsonb(c)::text)),0)+greatest(count(*)-1,0)*2+2 AS bytes FROM candidate_page c)
      SELECT n,bytes::text AS bytes,CASE WHEN bytes<=$7::bigint THEN coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY game_key,observed_at_exact DESC,batch_hash) FROM candidate_page c),'[]'::jsonb) ELSE NULL END AS items FROM bounds`,
    [filters.league, filters.date, until, RAW_SEEN_READABLE_DERIVATION_VERSIONS, RAW_SEEN_DERIVATION_VERSION, MAX_CANDIDATES + 1, maxMetadataBytes]))[0];
    check(envelope && integer(envelope.n) && /^\d+$/.test(String(envelope.bytes)) && Number.isSafeInteger(Number(envelope.bytes)), 'RAW_MARKET_COVERAGE_METADATA_INVALID');
    check(Number(envelope.bytes) <= maxMetadataBytes && Array.isArray(envelope.items), 'RAW_MARKET_COVERAGE_METADATA_BUDGET');
    const rows = envelope.items; result.budget.metadataBytesRead = Number(envelope.bytes);
    check(rows.length === envelope.n, 'RAW_MARKET_COVERAGE_METADATA_INVALID');
    check(Array.isArray(rows) && rows.length <= MAX_CANDIDATES + 1, 'RAW_MARKET_COVERAGE_METADATA_INVALID');
    result.inventory = { status: 'READ', candidateRows: Math.min(rows.length, MAX_CANDIDATES), candidatesTruncated: rows.length > MAX_CANDIDATES,
      candidateScanComplete: rows.length <= MAX_CANDIDATES,
      matchedGameCount: 0, unmatchedCandidates: 0 };
    if (result.inventory.candidatesTruncated) result.reasonCodes.push('RAW_MARKET_COVERAGE_CANDIDATE_LIMIT');
    const candidates = new Map(), matchedIds = new Set();
    for (const row of rows.slice(0, MAX_CANDIDATES)) {
      check(validCandidate(row, filters.league, filters.date), 'RAW_MARKET_COVERAGE_METADATA_INVALID');
      const id = gameId(row.metadata, filters.league, board, now);
      if (!id) { result.inventory.unmatchedCandidates++; continue; }
      matchedIds.add(id); const batchHash = row.batch_hash.trim();
      const item = candidates.get(batchHash) || { batchHash, captureId: row.batch_metadata.capture.captureId, derivedHash: row.derived_hash.trim(),
        derivationVersion: row.derivation_version, ids: new Set(), quality: 0, observedAt: row.observed_at_exact };
      check(item.captureId === row.batch_metadata.capture.captureId && item.derivedHash === row.derived_hash.trim(), 'RAW_MARKET_COVERAGE_METADATA_INVALID');
      item.ids.add(id); item.quality += row.metadata.marketCount; candidates.set(batchHash, item);
    }
    result.inventory.matchedGameCount = matchedIds.size;
    while (candidates.size && result.budget.batchReads < maxBatchReads && result.games.some(game => game.witnessStatus !== 'FOUR_CELLS_WITNESSED')) {
      if (clock() >= deadline) { result.reasonCodes.push('RAW_MARKET_COVERAGE_TIME_BUDGET'); break; }
      const score = candidate => [...candidate.ids].filter(id => byId.get(id).witnessStatus !== 'FOUR_CELLS_WITNESSED').length;
      const item = [...candidates.values()].sort((a, b) => score(b) - score(a) || b.quality - a.quality || b.observedAt.localeCompare(a.observedAt) || a.batchHash.localeCompare(b.batchHash))[0];
      candidates.delete(item.batchHash); if (!score(item)) break;
      result.budget.batchReads++;
      const source = { captureId: item.captureId, batchHash: item.batchHash, status: 'UNKNOWN', reason: null, derivedHash: null,
        observedAt: null, receivedAt: null, persistedAt: null, fragments: [] }; result.sources.push(source);
      try {
        check(item.derivationVersion === RAW_SEEN_DERIVATION_VERSION, 'RAW_MARKET_COVERAGE_DERIVATION_UNVERIFIED');
        const metadata = await readReaderSeenCaptureBatchMetadata(item.captureId, { sql: db, sourceCutoff: until, league: filters.league });
        const bytes = metadata.rows.reduce((n, row) => n + row.evidence_bytes, 0);
        check(bytes <= 4800000 && bytes <= maxSourceBytes - result.budget.sourceBytesReserved, 'RAW_MARKET_COVERAGE_BYTE_BUDGET');
        result.budget.sourceBytesReserved += bytes;
        const parts = await readReaderSeenCaptureBatch(item.captureId, { sql: db, batchMetadata: metadata });
        result.budget.sourceBytesRead += bytes;
        const replay = deriveRawSeenSoccerHistory(parts, { now });
        check(clock() < deadline, 'RAW_MARKET_COVERAGE_TIME_BUDGET');
        check(replay.captureBatchId === item.batchHash && replay.derivedHash === item.derivedHash && replay.league === filters.league,
          'RAW_MARKET_COVERAGE_DERIVED_MISMATCH');
        check([replay.observedAt, replay.receivedAt, replay.persistedAt].every(at => instant(at) && precise(at) <= precise(until)), 'RAW_MARKET_COVERAGE_SOURCE_TIME_INVALID');
        const projections = [];
        for (const raw of replay.games) {
          const id = gameId(raw, filters.league, board, now), game = byId.get(id); if (!game) continue;
          const rawGameKey = soccerJournalHash([raw.boardDate, raw.boardTime, raw.awayKey, raw.homeKey]);
          projections.push({ id, game, rawGameKey, witnesses: raw.markets.map(market => quoteWitness(market, replay, id, rawGameKey)).filter(Boolean) });
        }
        Object.assign(source, { status: 'VERIFIED', derivedHash: replay.derivedHash, observedAt: replay.observedAt,
          receivedAt: replay.receivedAt, persistedAt: replay.persistedAt, fragments: replay.parts });
        for (const { id, game, rawGameKey, witnesses } of projections) {
          checked.add(id);
          if (!game.rawGameKeys.includes(rawGameKey)) game.rawGameKeys.push(rawGameKey);
          for (const witness of witnesses) {
            const cell = game.cells[`${witness.period}:${witness.kind}`];
            if (cell.witnesses.length < 2) cell.witnesses.push(witness);
          }
          game.witnessStatus = CELLS.every(key => game.cells[key].witnesses.length) ? 'FOUR_CELLS_WITNESSED' : 'PARTIAL';
        }
      } catch (error) { source.reason = code(error); result.reasonCodes.push(source.reason); }
    }
    for (const game of result.games) for (const key of CELLS) game.cells[key].status = game.cells[key].witnesses.length ? 'WITNESSED' : checked.has(game.gameId) ? 'NOT_WITNESSED' : 'NOT_CHECKED';
    if (!board.games.length) result.reasonCodes.push('RAW_MARKET_COVERAGE_NO_OFFICIAL_GAMES_RETURNED');
    if (candidates.size && result.budget.batchReads >= maxBatchReads && result.games.some(game => game.witnessStatus !== 'FOUR_CELLS_WITNESSED')) result.reasonCodes.push('RAW_MARKET_COVERAGE_BATCH_BUDGET');
    result.status = result.games.length && result.games.every(game => game.witnessStatus === 'FOUR_CELLS_WITNESSED') ? 'WITNESSES_FOUND'
      : result.sources.length && !result.sources.some(source => source.status === 'VERIFIED') ? 'UNKNOWN' : 'PARTIAL';
    result.reasonCodes = [...new Set(result.reasonCodes)]; return result;
  } catch (error) {
    return { ...result, ok: false, status: 'UNKNOWN', schedule: null, inventory: null, games: [], sources: [], reasonCodes: [code(error)] };
  }
}
