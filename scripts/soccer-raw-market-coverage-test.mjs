import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { buildReaderSeenCapture, canonicalReaderSeenCapture, initializeReaderSeenCaptureStore, readReaderSeenCaptureBatch } from '../lib/reader-seen-capture.js';
import { initializeRawHistoryIndexStore, indexRawSeenHistoryCapture } from '../lib/soccer/raw-seen-history-index.js';
import { reassembleRawSeenBatch, deriveRawSeenSoccerHistory } from '../lib/soccer/raw-seen-history.js';
import { fetchSoccerSchedule } from '../lib/soccer/data.js';
import { readRawMarketCoverage, parseRawMarketCoverageQuery } from '../lib/soccer/raw-market-coverage.js';

const original = reassembleRawSeenBatch(JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/soccer/ucl-seen-pregame-20261105.json.gz', import.meta.url))))).evidence;
const db = new PGlite(), statements = [], fixtures = [], date = '2026-11-07', now = Date.now() + 60000;
let afterQuery = null, corruptReply = false, failPayload = false, candidateFault = '';
const query = (query, params = []) => ({ query, params, then(a, b) { return execute([{ query, params }]).then(rows => rows[0]).then(a, b); } });
const sql = (parts, ...params) => query(parts.reduce((s, p, i) => s + (i ? '$' + i : '') + p, ''), params);
sql.query = query;
async function execute(queries, transaction = false, options = {}) {
  const run = async connection => {
    const out = [];
    for (const item of queries) {
      statements.push({ ...item, options });
      if (failPayload && /SELECT a\.\*,/.test(item.query)) throw Object.assign(Error('source transport lost'), { code: '08006' });
      const rows = (await connection.query(item.query, item.params)).rows;
      if (/WITH scoped_hashes AS MATERIALIZED/.test(item.query) && rows[0]?.items) for (const row of rows[0].items) {
        if (candidateFault === 'HASH') { row.derived_hash = 'a'.repeat(64); row.batch_metadata.derivedHash = row.derived_hash; }
        if (candidateFault === 'TIME') row.metadata.boardTime = '29:00';
        if (candidateFault === 'VERSION') { row.derivation_version = 'SOCCER-RAW-CREDIT-TABLE-HISTORY-v1'; row.batch_metadata.derivationVersion = row.derivation_version; }
      }
      if (corruptReply && /SELECT a\.\*,/.test(item.query) && rows.length) {
        const evidence = JSON.parse(rows[0].evidence_json); evidence.tables[0].rows[0].cells[3].pair[1] = '0.123';
        rows[0].evidence_json = canonicalReaderSeenCapture(evidence);
      }
      out.push(rows);
    }
    return out;
  };
  const out = await (transaction ? db.transaction(run) : run(db));
  for (const item of queries) await afterQuery?.(item.query, item.params);
  return out;
}
sql.transaction = (queries, options) => execute(queries, true, options);
const pairs = [['愛華頓[主]', '阿仙奴', 'Everton', 'Arsenal'], ['白禮頓[主]', '水晶宮', 'Brighton & Hove Albion', 'Crystal Palace']];
function source({ sequence = 0, games = 2, missing = [], time = '23:00', league = 'EPL', fragmented = false, alternatives = false } = {}) {
  const evidence = { ...structuredClone(original), league, observedAt: new Date(Date.parse('2026-11-07T10:00:00Z') + sequence * 1000).toISOString(), pageLeagueLabel: league,
    tables: [{ ...structuredClone(original.tables[171]), sectionTitle: league === 'EPL' ? '聯盟: 英格蘭超級聯賽(2)' : '聯盟: 歐洲冠軍聯賽(2)', rows: pairs.slice(0, games).map(pair => {
      const row = structuredClone(original.tables[171].rows[758]); row.cells[0].pair = ['11-07', time]; row.cells[1].pair = [pair[0], pair[1], 'grade'];
      for (const column of missing) row.cells[column].pair = ['-']; return row;
    }) }] };
  if (alternatives) evidence.tables[0].rows = evidence.tables[0].rows.flatMap(row => {
    const alt = structuredClone(row); alt.cells = [alt.cells[0], alt.cells[1], alt.cells[3], alt.cells[4], alt.cells[6], alt.cells[7]];
    alt.cells[2].pair[/^\d{1,4}\.\d{3}$/.test(alt.cells[2].pair[0]) ? 1 : 0] = '1+50'; return [row, alt];
  });
  if (fragmented) {
    const whole = buildReaderSeenCapture({ schema: 'READER-SEEN-CAPTURE-v1', evidence }, { deviceId: 'isolated-witness', headerVersion: evidence.readerVersion });
    evidence.captureBatchId = whole.captureId; evidence.partIndex = 0; evidence.partCount = 1;
  }
  return { evidence };
}
async function insert(part, { receivedAt = '2026-11-07T10:01:00.000Z' } = {}) {
  const b = buildReaderSeenCapture({ schema: 'READER-SEEN-CAPTURE-v1', evidence: part.evidence }, { deviceId: 'isolated-witness', headerVersion: part.evidence.readerVersion });
  const at = '2026-11-07T10:01:00.000Z';
  await db.query(`INSERT INTO sports_reader_seen_captures_v1(capture_id,schema_version,league,source_observed_at,page_activity_at,evidence_hash,evidence_json,
    source_scope_hash,reader_version,table_count,row_count,cell_count,locked_row_count,capture_batch_id,part_index,part_count,received_at,persisted_at)
    VALUES($1,'READER-SEEN-CAPTURE-v1',$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::timestamptz)`,
  [b.captureId, part.evidence.league, part.evidence.observedAt, part.evidence.pageActivityAt || null, b.evidenceHash, b.evidenceJson, b.sourceScopeHash,
    part.evidence.readerVersion, b.tableCount, b.rowCount, b.cellCount, b.lockedRowCount, part.evidence.captureBatchId || null, part.evidence.partIndex ?? null, part.evidence.partCount ?? null, receivedAt, at]);
  return { ...b, ...part };
}
async function indexed(options) { const s = await insert(source(options)); await indexRawSeenHistoryCapture(s.captureId, { db: sql, now }); return s; }
let events = pairs.map((pair, n) => ({ id: String(9001 + n), date: '2026-11-07T15:00:00Z', status: { type: { state: 'pre', name: 'STATUS_SCHEDULED' } },
  competitions: [{ id: String(9001 + n), competitors: [{ homeAway: 'home', team: { id: String(10 + n * 2), displayName: pair[2] } }, { homeAway: 'away', team: { id: String(11 + n * 2), displayName: pair[3] } }] }] }));
const schedule = (league, day, options) => fetchSoccerSchedule(league, day, { ...options, ttlMs: 0, fetchImpl: async url => ({ ok: true, status: 200, url,
  json: async () => ({ leagues: [{ id: league === 'epl' ? '700' : '775', slug: league === 'epl' ? 'eng.1' : 'uefa.champions' }], events }) }) });
const snapshot = async () => canonicalReaderSeenCapture(JSON.parse(JSON.stringify((await db.query('SELECT * FROM sports_reader_seen_captures_v1 ORDER BY capture_id')).rows)));
async function read(options = {}, { allowAppend = false } = {}) {
  const before = await snapshot(), start = statements.length, body = await readRawMarketCoverage({ league: 'EPL', date }, { db: sql, now, schedule, ...options });
  if (!allowAppend) assert.equal(await snapshot(), before, 'no source price or clock mutation');
  assert.ok(statements.slice(start).every(s => /^\s*(SELECT|WITH)\b/.test(s.query)), 'even first GET is SELECT-only, no DDL');
  for (const key of ['currentBoardUpdated', 'historicalAvailabilityVerified', 'formalEligible', 'calibrationEligible', 'executable', 'coverageComplete', 'identityVerified', 'simultaneousCoverageVerified', 'completeHistory']) assert.equal(body[key], false);
  assert.equal(body.archiveOnly, true); assert.equal(body.closingCoverage, 'NOT_VERIFIED');
  assert.ok(body.budget.sourceBytesRead <= body.budget.sourceBytesReserved); assert.ok(body.budget.sourceBytesReserved <= body.budget.maxSourceBytes);
  assert.ok(body.budget.metadataBytesRead <= body.budget.maxMetadataBytes); assert.ok(body.budget.batchReads <= body.budget.maxBatchReads);
  return body;
}
async function reset() { afterQuery = null; corruptReply = false; failPayload = false; candidateFault = ''; await db.query('TRUNCATE sports_reader_seen_captures_v1,soccer_raw_seen_history_batches_v1,soccer_raw_seen_history_games_v1 CASCADE'); }
const keep = (name, body) => { fixtures.push({ name, scope: { league: 'EPL', date }, httpStatus: body.ok ? 200 : 503, body }); writeFileSync(join(tmpdir(), 'raw-market-coverage-contract-fixtures.json'), JSON.stringify({ cases: fixtures })); };
try {
  await initializeReaderSeenCaptureStore({ sql }); await initializeRawHistoryIndexStore({ db: sql });
  assert.deepEqual(parseRawMarketCoverageQuery(new URLSearchParams({ league: 'epl', date })), { league: 'EPL', date });
  for (const q of ['league=NBA&date=2026-11-07', 'league=EPL&date=2026-02-30', 'league=EPL&league=UCL&date=2026-11-07', 'league=EPL&date=2026-11-07&maxBatchReads=9000']) assert.throws(() => parseRawMarketCoverageQuery(new URLSearchParams(q)), e => e.status === 400);
  let value = await read(); assert.equal(value.status, 'PARTIAL', JSON.stringify(value)); assert.ok(value.games.every(g => g.witnessStatus === 'NOT_CHECKED')); keep('no-index-witness', value);
  const positive = await indexed({});
  value = await read(); assert.equal(value.status, 'WITNESSES_FOUND'); assert.equal(value.games.length, 2); assert.equal(value.budget.batchReads, 1, 'one batch witnesses multiple official fixtures');
  assert.equal(value.sources.length, 1); assert.equal(value.sources[0].captureId, positive.captureId);
  for (const game of value.games) for (const [cell, data] of Object.entries(game.cells)) {
    assert.equal(data.status, 'WITNESSED'); assert.ok(data.witnesses.length > 0); const quote = data.witnesses[0];
    assert.equal(`${quote.period}:${quote.kind}`, cell); assert.equal(quote.originalPeriod, cell.startsWith('FT:') ? 'UNKNOWN' : 'HT'); assert.equal(typeof quote.isAlternative, 'boolean');
    assert.equal(quote.gameId, game.gameId); assert.ok(game.rawGameKeys.includes(quote.rawGameKey));
  }
  assert.doesNotMatch(JSON.stringify(value), /rawRows|originalCell|deviceId|pageUrl|sourceScopeHash|tai888\.in/); keep('all-four-source-witnesses', value);
  const legacyVersion = 'SOCCER-RAW-CREDIT-TABLE-HISTORY-v1';
  await db.query(`INSERT INTO soccer_raw_seen_history_batches_v1 SELECT batch_hash,$1::text,$2::text::char(64),capture_id,league,observed_at,source_received_at,source_persisted_at,
    metadata||jsonb_build_object('derivationVersion',$1::text,'derivedHash',$2::text),indexed_at FROM soccer_raw_seen_history_batches_v1`, [legacyVersion, 'a'.repeat(64)]);
  await db.query(`INSERT INTO soccer_raw_seen_history_games_v1 SELECT batch_hash,$1,league,board_date,game_key,metadata FROM soccer_raw_seen_history_games_v1`, [legacyVersion]);
  value = await read(); assert.equal(value.status, 'WITNESSES_FOUND'); assert.equal(value.budget.batchReads, 1);
  assert.equal(value.sources[0].derivedHash, fixtures.find(f => f.name === 'all-four-source-witnesses').body.sources[0].derivedHash); keep('current-v2-preferred-over-legacy-index', value);
  candidateFault = 'HASH'; value = await read(); candidateFault = ''; assert.equal(value.status, 'UNKNOWN'); assert.ok(value.reasonCodes.includes('RAW_MARKET_COVERAGE_DERIVED_MISMATCH')); keep('wrong-derived-hash', value);
  candidateFault = 'TIME'; value = await read(); candidateFault = ''; assert.equal(value.ok, false); assert.deepEqual(value.sources, []); keep('invalid-29-hour-metadata', value);
  candidateFault = 'VERSION'; value = await read(); candidateFault = ''; assert.equal(value.status, 'UNKNOWN'); assert.ok(value.reasonCodes.includes('RAW_MARKET_COVERAGE_DERIVATION_UNVERIFIED')); keep('old-derivation-is-not-current-proof', value);
  const fake = structuredClone(await schedule('epl', date, { windowDays: 1 }));
  value = await read({ schedule: async () => fake }); assert.equal(value.ok, false); assert.equal(value.status, 'UNKNOWN'); assert.equal(value.inventory, null); keep('unbranded-schedule', value);
  const candidateQuery = statements.find(s => /WITH scoped_hashes AS MATERIALIZED/.test(s.query)).query;
  assert.match(candidateQuery, /derivation_version=\$5/); assert.match(candidateQuery, /candidate_page AS MATERIALIZED/); assert.match(candidateQuery, /CASE WHEN bytes<=\$7/);
  value = await read({ maxSourceBytes: 1 }); assert.equal(value.sources[0].status, 'UNKNOWN'); assert.equal(value.budget.sourceBytesReserved, 0); assert.ok(value.games.every(g => g.witnessStatus === 'NOT_CHECKED')); keep('source-byte-budget', value);
  const beforeMetadata = statements.length; value = await read({ maxMetadataBytes: 1 }); assert.equal(value.ok, false); assert.equal(value.budget.metadataBytesRead, 0);
  assert.ok(!statements.slice(beforeMetadata).some(s => /SELECT a\.\*,/.test(s.query))); keep('metadata-byte-budget', value);
  corruptReply = true; value = await read(); corruptReply = false;
  assert.equal(value.status, 'UNKNOWN'); assert.equal(value.sources[0].status, 'UNKNOWN'); assert.equal(value.sources[0].derivedHash, null); assert.deepEqual(value.sources[0].fragments, []); keep('corrupt-source-hash', value);
  failPayload = true; value = await read(); failPayload = false;
  assert.equal(value.status, 'UNKNOWN'); assert.ok(value.budget.sourceBytesReserved > 0); assert.equal(value.budget.sourceBytesRead, 0, 'failed dispatch cannot recycle its reserved byte budget'); keep('failed-original-dispatch', value);
  let tick = 0; value = await read({ clock: () => tick++ * 26000 }); assert.equal(value.status, 'UNKNOWN'); keep('soft-time-budget', value);

  await reset(); await indexed({ missing: [7] }); value = await read(); assert.equal(value.status, 'PARTIAL');
  assert.ok(value.games.every(g => g.cells['HT:TOTAL'].status === 'NOT_WITNESSED')); keep('partial-real-source', value);
  await reset(); await indexed({ missing: [6, 7] }); await indexed({ sequence: 1, missing: [3, 4] }); value = await read();
  assert.equal(value.status, 'WITNESSES_FOUND'); assert.equal(value.sources.length, 2); assert.equal(value.simultaneousCoverageVerified, false);
  assert.notEqual(value.games[0].cells['FT:TOTAL'].witnesses[0].sourceObservedAt, value.games[0].cells['HT:TOTAL'].witnesses[0].sourceObservedAt); keep('cross-time-is-not-simultaneous', value);
  value = await read({ maxBatchReads: 1 }); assert.equal(value.status, 'PARTIAL'); assert.ok(value.reasonCodes.includes('RAW_MARKET_COVERAGE_BATCH_BUDGET')); keep('batch-budget', value);
  await reset(); await indexed({ alternatives: true }); value = await read(); assert.equal(value.status, 'WITNESSES_FOUND');
  for (const game of value.games) for (const cell of Object.values(game.cells)) assert.deepEqual(cell.witnesses.map(q => q.isAlternative), [false, true]);
  assert.ok(value.games[0].cells['FT:HANDICAP'].witnesses.some(q => q.line === '1+50' && q.isAlternative)); keep('primary-and-alternative-lines', value);
  // Simulate a pre-release DB that contains only exact immutable v2 indexes.
  // The v3 rollout must verify those prices with v2, not reject or relabel them.
  await reset(); const oldSource=await indexed({});
  const oldReplay=deriveRawSeenSoccerHistory(await readReaderSeenCaptureBatch(oldSource.captureId,{sql}),
    {now,derivationVersion:'SOCCER-RAW-CREDIT-TABLE-HISTORY-v2'});
  const retainedBatch=(await db.query('SELECT * FROM soccer_raw_seen_history_batches_v1')).rows[0];
  const retainedGames=(await db.query('SELECT * FROM soccer_raw_seen_history_games_v1')).rows;
  await db.query('TRUNCATE soccer_raw_seen_history_batches_v1,soccer_raw_seen_history_games_v1 CASCADE');
  await db.query(`INSERT INTO soccer_raw_seen_history_batches_v1(batch_hash,derivation_version,derived_hash,capture_id,league,observed_at,source_received_at,source_persisted_at,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[retainedBatch.batch_hash,oldReplay.derivationVersion,oldReplay.derivedHash,
    retainedBatch.capture_id,retainedBatch.league,retainedBatch.observed_at,retainedBatch.source_received_at,retainedBatch.source_persisted_at,
    JSON.stringify({...retainedBatch.metadata,derivationVersion:oldReplay.derivationVersion,derivedHash:oldReplay.derivedHash})]);
  for(const g of retainedGames)await db.query(`INSERT INTO soccer_raw_seen_history_games_v1(batch_hash,derivation_version,league,board_date,game_key,metadata)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[g.batch_hash,oldReplay.derivationVersion,g.league,g.board_date,g.game_key,JSON.stringify(g.metadata)]);
  value=await read();assert.equal(value.status,'WITNESSES_FOUND');assert.equal(value.sources[0].derivedHash,oldReplay.derivedHash);
  assert.equal(value.budget.batchReads,1);keep('retained-v2-source-remains-verifiable-after-v3-rollout',value);
  await reset(); const microFuture = new Date(now).toISOString().replace(/\.(\d{3})Z$/, (_, ms) => `.${ms}001Z`);
  const micro = await insert(source(), { receivedAt: microFuture }); await indexRawSeenHistoryCapture(micro.captureId, { db: sql, now });
  value = await read(); assert.equal(value.status, 'UNKNOWN'); assert.ok(value.reasonCodes.includes('RAW_MARKET_COVERAGE_SOURCE_TIME_INVALID')); keep('one-microsecond-future-source-clock', value);

  await reset(); const racing = await indexed({ fragmented: true }); let appended = false;
  afterQuery = async (query, params) => {
    if (!appended && /SELECT a\.capture_id,a\.league,a\.evidence_hash/.test(query) && !/batch_metadata AS MATERIALIZED/.test(query) && params.includes(racing.captureId)) {
      appended = true; await insert({ evidence: { ...structuredClone(racing.evidence), partIndex: 1, partCount: 2, tables: [] } });
    }
  };
  value = await read({}, { allowAppend: true }); afterQuery = null;
  assert.equal(appended, true); assert.equal(value.status, 'UNKNOWN'); assert.ok(value.games.every(g => g.witnessStatus === 'NOT_CHECKED')); assert.equal(value.budget.sourceBytesRead, 0); keep('late-fragment-race', value);

  await reset(); await indexed({});
  await db.query('CREATE TEMP TABLE witness_b_copy AS SELECT * FROM soccer_raw_seen_history_batches_v1');
  await db.query('CREATE TEMP TABLE witness_g_copy AS SELECT * FROM soccer_raw_seen_history_games_v1');
  await db.query('TRUNCATE soccer_raw_seen_history_batches_v1 CASCADE');
  await db.query(`INSERT INTO soccer_raw_seen_history_batches_v1 SELECT batch_hash,derivation_version,derived_hash,capture_id,league,observed_at,source_received_at,source_persisted_at,
    metadata||jsonb_build_object('padding',repeat('x',2097152)),indexed_at FROM witness_b_copy`);
  await db.query('INSERT INTO soccer_raw_seen_history_games_v1 SELECT * FROM witness_g_copy');
  const hugeStart = statements.length; value = await read(); assert.equal(value.ok, false); assert.ok(value.reasonCodes.includes('RAW_MARKET_COVERAGE_METADATA_BUDGET'));
  assert.equal(value.budget.metadataBytesRead, 0); assert.ok(!statements.slice(hugeStart).some(s => /SELECT a\.\*,/.test(s.query))); keep('real-oversized-index-metadata', value);

  await reset(); await indexed({});
  await db.query(`INSERT INTO soccer_raw_seen_history_games_v1
    SELECT g.batch_hash,g.derivation_version,g.league,g.board_date,'duplicate-candidate-'||x.n,
      g.metadata||jsonb_build_object('gameKey','duplicate-candidate-'||x.n)
    FROM (SELECT * FROM soccer_raw_seen_history_games_v1 ORDER BY game_key LIMIT 1) g CROSS JOIN generate_series(1,201) x(n)`);
  value = await read(); assert.equal(value.inventory.candidateRows, 200); assert.equal(value.inventory.candidatesTruncated, true);
  assert.equal(value.inventory.candidateScanComplete, false); assert.ok(value.reasonCodes.includes('RAW_MARKET_COVERAGE_CANDIDATE_LIMIT'));
  assert.equal(value.games.length, 2); assert.equal(value.budget.batchReads, 1); assert.equal(value.coverageComplete, false); keep('candidate-sentinel-is-not-absence-proof', value);

  await reset(); const oldEvents = events; events = []; value = await read(); events = oldEvents;
  assert.equal(value.status, 'PARTIAL'); assert.deepEqual(value.games, []); assert.ok(value.reasonCodes.includes('RAW_MARKET_COVERAGE_NO_OFFICIAL_GAMES_RETURNED')); keep('empty-provider-is-not-complete', value);
  await indexed({ time: '23:01' }); value = await read(); assert.equal(value.inventory.unmatchedCandidates, 2); assert.ok(value.games.every(g => g.witnessStatus === 'NOT_CHECKED')); keep('identity-time-mismatch', value);
  await reset(); await indexed({ league: 'UCL' }); value = await read(); assert.equal(value.sources.length, 0, 'UCL source never populates EPL witnesses');
  const ucl = await readRawMarketCoverage({ league: 'UCL', date }, { db: sql, now, schedule }); assert.equal(ucl.status, 'WITNESSES_FOUND');
  assert.ok(ucl.games.every(g => g.gameId.startsWith('soccer:ucl:'))); fixtures.push({ name: 'ucl-isolated-positive', scope: { league: 'UCL', date }, httpStatus: 200, body: ucl });
  writeFileSync(join(tmpdir(), 'raw-market-coverage-contract-fixtures.json'), JSON.stringify({ cases: fixtures }));
  console.log('PASS raw-market witness PostgreSQL: actual branded schedule, greedy multi-game batch, full source hashes, raw FT inference, distinct-time cells, partial slots, exact byte reservation, metadata CASE, late race, identity and no writes/formal promotion');
} finally { afterQuery = null; await db.close(); }
