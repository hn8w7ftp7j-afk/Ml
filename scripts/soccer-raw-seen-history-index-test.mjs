import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { register } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

// Source records below are inserted only into an isolated PostgreSQL engine.
// The retained Production fixture is never rewritten or submitted to a service.
const parts = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/soccer/ucl-seen-pregame-20261105.json.gz', import.meta.url))));
const db = new PGlite(), statements = [];
globalThis.__RAW_HISTORY_INDEX_SQL = async (queries, transaction = false) => {
  const run = async connection => {
    const results = [];
    for (const { query, params } of queries) {
      statements.push(query);
      results.push((await connection.query(query, params)).rows);
    }
    return results;
  };
  return transaction ? db.transaction(run) : run(db);
};
const adapter = 'data:text/javascript,' + encodeURIComponent(`
  export function neon() {
    const execute = (query, params = []) => ({ query, params,
      then(a, b) { return globalThis.__RAW_HISTORY_INDEX_SQL([{ query, params }]).then(x => x[0]).then(a, b); } });
    const sql = (strings, ...params) => execute(strings.reduce((s, p, i) => s + (i ? '$' + i : '') + p, ''), params);
    sql.query = execute;
    sql.transaction = queries => globalThis.__RAW_HISTORY_INDEX_SQL(queries, true);
    return sql;
  }
`);
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) {
  if (s === 'next/server') return n('next/server.js', c);
  if (s === '@neondatabase/serverless' && /\\/lib\\/(?:soccer\\/raw-seen-history-index|reader-seen-capture)\\.js$/.test(c.parentURL || ''))
    return { url: ${JSON.stringify(adapter)}, shortCircuit: true };
  return n(s, c);
}`), import.meta.url);

const { initializeReaderSeenCaptureStore, buildReaderSeenCapture, canonicalReaderSeenCapture } = await import('../lib/reader-seen-capture.js');
const { deriveRawSeenSoccerHistory, reassembleRawSeenBatch, RAW_SEEN_DERIVATION_VERSION } = await import('../lib/soccer/raw-seen-history.js');
const { indexRawSeenHistoryCapture, queryRawHistoryIndex, scanRawHistoryIndex, parseRawHistoryIndexQuery } = await import('../lib/soccer/raw-seen-history-index.js');
const { createSessionToken } = await import('../lib/security.js');
const { GET, POST } = await import('../app/api/soccer/raw-seen-history-index/route.js');
const schema = 'soccer-raw-history-index-v1', scope = { league: 'UCL', from: '2026-11-05', through: '2026-11-05' };
const sourceBefore = JSON.stringify(parts), evidence = reassembleRawSeenBatch(parts).evidence;
const realResult = deriveRawSeenSoccerHistory(parts);
const snapshot = async () => (await db.query('SELECT * FROM sports_reader_seen_captures_v1 ORDER BY capture_id')).rows;
const assertFlags = (value, entry = false) => {
  if (!entry) assert.equal(value.schema, schema);
  for (const key of ['currentBoardUpdated', 'historicalAvailabilityVerified', 'executable', 'coverageComplete', 'formalEligible', 'calibrationEligible', 'identityVerified'])
    assert.equal(value[key], false, `${key} must never be promoted by indexing`);
  assert.equal(value.archiveOnly, true); assert.equal(value.closingCoverage, 'NOT_VERIFIED');
};
async function insertSource(part, overrides = {}) {
  const built = buildReaderSeenCapture({ schema: 'READER-SEEN-CAPTURE-v1', evidence: part.evidence, captureId: part.captureId, evidenceHash: part.evidenceHash },
    { deviceId: 'index-fixture', headerVersion: part.readerVersion });
  await db.query(`INSERT INTO sports_reader_seen_captures_v1
    (capture_id,schema_version,league,source_observed_at,page_activity_at,evidence_hash,evidence_json,source_scope_hash,reader_version,
     table_count,row_count,cell_count,locked_row_count,capture_batch_id,part_index,part_count,received_at,persisted_at)
    VALUES($1,'READER-SEEN-CAPTURE-v1',$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::timestamptz)`,
  [part.captureId,part.league,part.observedAt,part.pageActivityAt || null,built.evidenceHash,built.evidenceJson,built.sourceScopeHash,part.readerVersion,
    built.tableCount,built.rowCount,built.cellCount,built.lockedRowCount,part.captureBatchId ?? null,part.partIndex ?? null,part.partCount ?? null,
    overrides.receivedAt || part.receivedAt,overrides.persistedAt || part.persistedAt]);
}
function synthetic(change = () => {}) {
  const item = { ...structuredClone(evidence), tables: [{ ...structuredClone(evidence.tables[171]),
    rows: structuredClone(evidence.tables[171].rows.filter(row => row.cells[0]?.pair?.[0] === '11-05')) }] };
  change(item);
  const built = buildReaderSeenCapture({ schema: 'READER-SEEN-CAPTURE-v1', evidence: item }, { deviceId: 'index-fixture', headerVersion: item.readerVersion });
  return { ...built, league: item.league, readerVersion: item.readerVersion, observedAt: item.observedAt, pageActivityAt: item.pageActivityAt || null,
    captureBatchId: null, partIndex: null, partCount: null, receivedAt: parts[0].receivedAt, persistedAt: parts[0].persistedAt };
}
const envNames = ['DATABASE_URL','DATABASE_V2_URL','APP_PASSWORD','SESSION_SECRET'];
const old = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
let requestNumber = 0;
try {
  delete process.env.DATABASE_V2_URL;
  Object.assign(process.env, { DATABASE_URL: 'postgres://isolated.invalid/history-index', APP_PASSWORD: 'index-fixture', SESSION_SECRET: 'index-fixture-session-secret' });
  const session = await createSessionToken();
  const request = (method = 'GET', value = scope, { auth = true, origin = 'https://fixture.invalid', rawBody } = {}) => {
    const url = 'https://fixture.invalid/api/soccer/raw-seen-history-index' + (method === 'GET' ? '?' + new URLSearchParams(value) : '');
    return new Request(url, { method, headers: { ...(auth ? { cookie: `mlb_session=${session}` } : {}),
      origin, 'x-forwarded-for': `127.20.0.${++requestNumber}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: rawBody ?? JSON.stringify(value) } : {}) });
  };
  const get = async value => { const response = await GET(request('GET', value)); return { response, body: await response.json() }; };
  const post = async value => { const response = await POST(request('POST', value)); return { response, body: await response.json() }; };

  // Missing index schema is an explicit state. A read cannot create a table.
  let cut = statements.length;
  const missing = await get(scope);
  assert.equal(missing.response.status, 200, JSON.stringify(missing.body));
  assert.equal(missing.body.status, 'NOT_INITIALIZED'); assert.equal(missing.body.indexCoverage, 'NOT_VERIFIED');
  assert.equal(missing.body.entries.length, 0); assertFlags(missing.body);
  assert.ok(statements.slice(cut).every(query => !/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/.test(query)), 'GET must be read-only, including first read');
  assert.equal((await GET(request('GET', scope, { auth: false }))).status, 401);
  assert.equal((await POST(request('POST', { action: 'index', captureId: parts[0].captureId }, { auth: false }))).status, 401);
  assert.equal((await POST(request('POST', { action: 'index', captureId: parts[0].captureId }, { origin: 'https://other.invalid' }))).status, 403);
  assert.equal((await POST(request('POST', {}, { rawBody: '{invalid json' }))).status, 400);
  assert.equal((await POST(request('POST', {}, { rawBody: JSON.stringify({ action: 'index', captureId: 'x'.repeat(7000) }) }))).status, 413);
  for (const params of [ {}, { ...scope, league: 'NBA' }, { ...scope, from: '2026-02-30' }, { ...scope, through: '2026-11-04' },
    { ...scope, through: '2026-12-06' }, { ...scope, extra: 'ignored?' }, { ...scope, gameKey: 'bad\nkey' } ])
    assert.equal((await get(params)).response.status, 400, JSON.stringify(params));
  assert.throws(() => parseRawHistoryIndexQuery(new URLSearchParams('league=UCL&league=EPL&from=2026-11-05&through=2026-11-05')), error => error.status === 400);
  for (const input of [ { action: 'index', captureId: 'bad' }, { action: 'index', captureId: parts[0].captureId, games: [] },
    { action: 'erase', captureId: parts[0].captureId }, { action: 'scan', ...scope, through: '2026-11-12' },
    { action: 'scan', ...scope, gameKey: 'ignored?' } ])
    assert.equal((await post(input)).response.status, 400, JSON.stringify(input));

  await initializeReaderSeenCaptureStore();
  for (const [i, part] of parts.entries()) await insertSource(part, { persistedAt: i === 3 ? part.persistedAt.replace('Z', '123Z') : part.persistedAt });
  const original = await snapshot(), originalCanonical = canonicalReaderSeenCapture(JSON.parse(JSON.stringify(original)));
  cut = statements.length;
  const indexed = await post({ action: 'index', captureId: parts[0].captureId });
  assert.equal(indexed.response.status, 200, JSON.stringify(indexed.body)); assertFlags(indexed.body);
  assert.equal(indexed.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(indexed.body.indexedGames, 16); assert.equal(indexed.body.captureBatchId, realResult.captureBatchId);
  assert.equal(indexed.body.derivedHash, realResult.derivedHash); assert.equal(indexed.body.observedAt, realResult.observedAt);
  assert.equal(indexed.body.sourcePersistedAt, parts[3].persistedAt.replace('Z', '123Z'));
  assert.ok(Date.parse(indexed.body.indexedAt) > Date.parse(indexed.body.sourcePersistedAt), 'new index clock cannot impersonate original availability');
  const indexWrites = statements.slice(cut).filter(query => /\b(?:INSERT|UPDATE|DELETE)\b/.test(query) && !query.startsWith('CREATE'));
  assert.ok(indexWrites.length > 0 && indexWrites.every(query => /INSERT INTO soccer_raw_seen_history_(?:batches|games)_v1/.test(query)), 'only derived index rows may be written');
  const repeated = await post({ action: 'index', captureId: parts[2].captureId });
  assert.equal(repeated.response.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.indexedAt, indexed.body.indexedAt); assert.equal(repeated.body.derivedHash, indexed.body.derivedHash);
  assert.equal((await db.query('SELECT count(*)::int n FROM soccer_raw_seen_history_batches_v1')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int n FROM soccer_raw_seen_history_games_v1')).rows[0].n, 16);
  cut = statements.length;
  await assert.rejects(() => indexRawSeenHistoryCapture(parts[0].captureId, {
    sourceCutoff: parts[3].persistedAt.replace('Z', '122Z'),
  }), error => error.code === 'RAW_HISTORY_INDEX_SOURCE_AFTER_CUTOFF');
  assert.ok(statements.slice(cut).every(query => !/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/.test(query)), 'a part one microsecond after a scan cutoff cannot be indexed by that scan');

  cut = statements.length;
  const nov5 = await get(scope);
  assert.equal(nov5.response.status, 200, JSON.stringify(nov5.body)); assertFlags(nov5.body);
  assert.equal(nov5.body.status, 'INDEXED_HISTORY_ONLY'); assert.equal(nov5.body.indexCoverage, 'NOT_VERIFIED');
  assert.equal(nov5.body.entries.length, 9); assert.equal(nov5.body.hasMore, false); assert.equal(nov5.body.nextAfter, null);
  for (const game of nov5.body.entries) {
    assertFlags(game, true); assert.equal(game.marketCount, 9); assert.equal(game.league, 'UCL'); assert.equal(game.boardDate, '2026-11-05');
    assert.equal(game.capture.captureId, parts[0].captureId); assert.equal(game.capture.captureBatchId, realResult.captureBatchId);
    assert.equal(game.capture.observedAt, realResult.observedAt); assert.equal(Date.parse(game.observedAt), Date.parse(realResult.observedAt));
    assert.equal(game.sourcePersistedAt, indexed.body.sourcePersistedAt); assert.equal(game.indexedAt, indexed.body.indexedAt);
    assert.equal(game.derivationVersion, RAW_SEEN_DERIVATION_VERSION); assert.equal(game.derivedHash, realResult.derivedHash);
    assert.ok(game.gameKey.includes(game.awayKey) && game.gameKey.includes(game.homeKey));
  }
  const nov4 = await get({ ...scope, from: '2026-11-04', through: '2026-11-04' });
  assert.equal(nov4.body.entries.length, 7, 'source observed Nov4 UTC / Nov5 Taipei must not erase original Nov4 board rows');
  const otherLeague = await get({ ...scope, league: 'EPL' }); assert.equal(otherLeague.body.entries.length, 0);
  const single = await get({ ...scope, gameKey: nov5.body.entries[0].gameKey });
  assert.equal(single.body.entries.length, 1); assert.equal(single.body.entries[0].gameKey, nov5.body.entries[0].gameKey);
  const badCursor = await get({ ...scope, after: 'forged.cursor' }); assert.equal(badCursor.response.status, 400);
  assert.ok(statements.slice(cut).every(query => !/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/.test(query)));
  assert.equal(canonicalReaderSeenCapture(JSON.parse(JSON.stringify(await snapshot()))), originalCanonical, 'raw source evidence and clocks must be unchanged');
  for (const table of ['soccer_raw_seen_history_batches_v1', 'soccer_raw_seen_history_games_v1']) {
    await assert.rejects(() => db.query(`UPDATE ${table} SET metadata='{}'::jsonb`), /RAW_HISTORY_INDEX_IMMUTABLE/);
    await assert.rejects(() => db.query(`DELETE FROM ${table}`), /RAW_HISTORY_INDEX_IMMUTABLE/);
  }
  assert.equal((await post({ action: 'index', captureId: '0'.repeat(64) })).response.status, 404);

  // Unsupported archives remain explicit source evidence, never zero games.
  const unsupported = synthetic(item => { item.tables[0].headers = []; });
  await insertSource(unsupported, { persistedAt: '2026-11-04T17:46:00.000123Z' });
  const unsupportedPost = await post({ action: 'index', captureId: unsupported.captureId });
  assert.equal(unsupportedPost.response.status, 422); assert.equal(unsupportedPost.body.code, 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT');
  assert.equal((await db.query('SELECT count(*)::int n FROM soccer_raw_seen_history_batches_v1')).rows[0].n, 1);
  const scanFirst = await post({ action: 'scan', ...scope });
  assert.equal(scanFirst.response.status, 200, JSON.stringify(scanFirst.body)); assertFlags(scanFirst.body);
  assert.equal(scanFirst.body.status, 'SOURCE_UNINDEXED'); assert.equal(scanFirst.body.reason, 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT');
  assert.equal(scanFirst.body.indexedGames, 0); assert.equal(scanFirst.body.hasMore, true); assert.equal(scanFirst.body.completeWithinWindow, false);
  const scanNext = await post({ action: 'scan', ...scope, after: scanFirst.body.nextAfter });
  assert.equal(scanNext.response.status, 200, JSON.stringify(scanNext.body)); assertFlags(scanNext.body);
  assert.equal(scanNext.body.indexedGames, 16); assert.equal(scanNext.body.hasMore, false); assert.equal(scanNext.body.completeWithinWindow, false);
  assert.equal(scanNext.body.concurrentSourceCommitsVerified, false);
  for (const input of [ { action: 'scan', ...scope, after: scanFirst.body.nextAfter.slice(0, -2) + 'xx' },
    { action: 'scan', ...scope, league: 'EPL', after: scanFirst.body.nextAfter },
    { action: 'scan', ...scope, from: '2026-11-04', after: scanFirst.body.nextAfter } ])
    assert.equal((await post(input)).response.status, 400);
  const none = await post({ action: 'scan', ...scope, from: '2026-11-03', through: '2026-11-03' });
  assert.equal(none.body.status, 'WINDOW_EXHAUSTED'); assert.equal(none.body.completeWithinWindow, false); assert.equal(none.body.hasMore, false);

  // Small signed synthetic sources supply multiple immutable observations so
  // the actual list keyset can be checked across a >50-row result.
  const synths = [];
  for (let i = 0; i < 6; i++) {
    const part = synthetic(item => { item.observedAt = `2026-11-05T02:0${i}:00.000Z`; });
    await insertSource(part); synths.push(part);
    assert.equal((await indexRawSeenHistoryCapture(part.captureId)).indexedGames, 9);
  }
  const all = await queryRawHistoryIndex(scope); assert.equal(all.entries.length, 50); assert.equal(all.hasMore, true); assert.ok(all.nextAfter);
  const remaining = await queryRawHistoryIndex({ ...scope, after: all.nextAfter });
  assert.equal(remaining.entries.length, 13); assert.equal(remaining.hasMore, false); assert.equal(remaining.until, all.until);
  const keys = [...all.entries, ...remaining.entries].map(game => `${game.boardDate}|${game.gameKey}|${game.captureBatchId}`);
  assert.equal(new Set(keys).size, 63, 'same-team observations stay distinct and pagination cannot repeat or drop a batch');
  await assert.rejects(() => queryRawHistoryIndex({ ...scope, league: 'EPL', after: all.nextAfter }), error => error.code === 'RAW_HISTORY_INDEX_CURSOR_INVALID');
  await assert.rejects(() => queryRawHistoryIndex({ ...scope, after: scanFirst.body.nextAfter }), error => error.code === 'RAW_HISTORY_INDEX_CURSOR_INVALID');
  await assert.rejects(() => scanRawHistoryIndex({ ...scope, after: all.nextAfter }), error => error.code === 'RAW_HISTORY_INDEX_CURSOR_INVALID');
  await assert.rejects(() => queryRawHistoryIndex({ ...scope, after: all.nextAfter.slice(0, -2) + 'xx' }), error => error.code === 'RAW_HISTORY_INDEX_CURSOR_INVALID');

  // A deliberately late DB delivery must still be indexed by its board day.
  const epl = synthetic(item => {
    item.league = 'EPL'; item.observedAt = '2026-11-06T02:00:00.000Z';
    item.tables[0].sectionTitle = '聯盟: 英格蘭超級聯賽(18)';
    item.tables[0].rows = [structuredClone(evidence.tables[171].rows[758])];
    item.tables[0].rows[0].cells[0].pair[0] = '11-05';
    item.tables[0].rows[0].cells[1].pair[0] = '愛華頓[主]'; item.tables[0].rows[0].cells[1].pair[1] = '阿仙奴';
  });
  await insertSource(epl, { receivedAt: '2026-11-07T12:00:00.000Z', persistedAt: '2026-11-07T12:00:00.000123Z' });
  assert.equal((await indexRawSeenHistoryCapture(epl.captureId)).indexedGames, 1);
  const late = await queryRawHistoryIndex({ ...scope, league: 'EPL' });
  assert.equal(late.entries.length, 1); assert.equal(late.entries[0].boardDate, '2026-11-05');
  assert.equal(late.entries[0].capture.observedAt, '2026-11-06T02:00:00.000Z'); assert.equal(late.entries[0].sourcePersistedAt, '2026-11-07T12:00:00.000123Z');
  assert.equal((await queryRawHistoryIndex(scope)).entries.every(game => game.league === 'UCL'), true);

  // A valid archive can exceed the replay UI's per-game market budget. Reject
  // the derived index atomically so one oversized game cannot poison a page.
  const oversized = synthetic(item => {
    item.observedAt = '2026-11-06T02:10:00.000Z';
    item.tables[0].rows = Array.from({ length: 41 }, () => structuredClone(evidence.tables[171].rows[758]));
  });
  const oversizedReplay = deriveRawSeenSoccerHistory([oversized]);
  assert.equal(oversizedReplay.games.length, 1); assert.equal(oversizedReplay.games[0].markets.length, 205);
  await insertSource(oversized);
  const oversizedSource = (await snapshot()).find(row => row.capture_id === oversized.captureId);
  assert.equal(JSON.parse(oversizedSource.evidence_json).tables[0].rows.length, 41);
  const indexCountBefore = (await db.query('SELECT count(*)::int n FROM soccer_raw_seen_history_games_v1')).rows[0].n;
  cut = statements.length;
  const oversizedIndex = await post({ action: 'index', captureId: oversized.captureId });
  assert.equal(oversizedIndex.response.status, 413, JSON.stringify(oversizedIndex.body));
  assert.equal(oversizedIndex.body.code, 'RAW_HISTORY_INDEX_MARKET_BUDGET_EXCEEDED');
  assert.ok(statements.slice(cut).every(query => !/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/.test(query)), 'oversized derived game is refused before any index write');
  assert.equal((await db.query('SELECT count(*)::int n FROM soccer_raw_seen_history_games_v1')).rows[0].n, indexCountBefore);
  const oversizedGame = oversizedReplay.games[0], oversizedKey = [oversizedGame.boardTime, oversizedGame.awayKey, oversizedGame.homeKey].join('|');
  const unpoisoned = await get({ ...scope, from: oversizedGame.boardDate, through: oversizedGame.boardDate, gameKey: oversizedKey });
  assert.equal(unpoisoned.response.status, 200, JSON.stringify(unpoisoned.body));
  assert.ok(unpoisoned.body.entries.every(game => game.marketCount <= 200 && game.captureBatchId !== oversized.captureId));
  assert.deepEqual((await snapshot()).find(row => row.capture_id === oversized.captureId), oversizedSource, 'all 41 raw primary rows and original clocks remain intact');

  // The same opponents and start time on two board days have the same gameKey.
  // Both rows belong in this batch; date must participate in readback sorting.
  const twoDays = synthetic(item => {
    item.observedAt = '2026-11-06T03:00:00.000Z';
    item.tables[0].rows = [structuredClone(evidence.tables[171].rows[758]), structuredClone(evidence.tables[171].rows[758])];
    item.tables[0].rows[0].cells[0].pair[0] = '11-05'; item.tables[0].rows[0].cells[0].pair[1] = '04:00';
    item.tables[0].rows[1].cells[0].pair[0] = '11-06'; item.tables[0].rows[1].cells[0].pair[1] = '04:00';
  });
  const twoDaysReplay = deriveRawSeenSoccerHistory([twoDays]);
  assert.equal(twoDaysReplay.games.length, 2);
  assert.deepEqual(twoDaysReplay.games.map(game => game.boardDate), ['2026-11-05','2026-11-06']);
  assert.equal(new Set(twoDaysReplay.games.map(game => [game.boardTime, game.awayKey, game.homeKey].join('|'))).size, 1);
  await insertSource(twoDays);
  const twoDaysSource = (await snapshot()).find(row => row.capture_id === twoDays.captureId);
  const twoDaysIndex = await post({ action: 'index', captureId: twoDays.captureId });
  assert.equal(twoDaysIndex.response.status, 200, JSON.stringify(twoDaysIndex.body)); assert.equal(twoDaysIndex.body.indexedGames, 2);
  const twoDaysRepeat = await post({ action: 'index', captureId: twoDays.captureId });
  assert.equal(twoDaysRepeat.response.status, 200, JSON.stringify(twoDaysRepeat.body));
  assert.equal(twoDaysRepeat.body.indexedAt, twoDaysIndex.body.indexedAt); assert.equal(twoDaysRepeat.body.derivedHash, twoDaysIndex.body.derivedHash);
  const twoDaysKey = [twoDaysReplay.games[0].boardTime, twoDaysReplay.games[0].awayKey, twoDaysReplay.games[0].homeKey].join('|');
  for (const date of ['2026-11-05','2026-11-06']) {
    const result = await get({ ...scope, from: date, through: date, gameKey: twoDaysKey });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    const batchRows = result.body.entries.filter(game => game.captureBatchId === twoDaysIndex.body.captureBatchId);
    assert.equal(batchRows.length, 1); assert.equal(batchRows[0].boardDate, date); assert.equal(batchRows[0].gameKey, twoDaysKey);
    assert.equal(batchRows[0].marketCount, 5); assertFlags(batchRows[0], true);
  }
  assert.deepEqual((await snapshot()).find(row => row.capture_id === twoDays.captureId), twoDaysSource);
  // A deployment adds a new immutable derivation; it cannot hide archives
  // that have not yet been re-indexed, duplicate a batch or move later pages.
  const legacyPart=synthetic(item=>{
    item.observedAt='2026-11-06T04:00:00.000Z';
    item.tables[0].rows=[structuredClone(evidence.tables[171].rows[758])];
    item.tables[0].rows[0].cells[0].pair=['11-05','23:59'];
  });
  await insertSource(legacyPart);
  const newReplay=deriveRawSeenSoccerHistory([legacyPart]);
  const legacyVersion='SOCCER-RAW-CREDIT-TABLE-HISTORY-v1',legacyGames=newReplay.games.map(({unavailableMarkets,...game})=>game);
  const legacyHash=createHash('sha256').update(canonicalReaderSeenCapture({captureBatchId:newReplay.captureBatchId,derivationVersion:legacyVersion,games:legacyGames})).digest('hex');
  const legacyCapture={captureId:legacyPart.captureId,captureBatchId:null,league:legacyPart.league,observedAt:legacyPart.observedAt,evidenceHash:legacyPart.evidenceHash};
  const legacyMetadata={schema,derivationVersion:legacyVersion,derivedHash:legacyHash,capture:legacyCapture,parts:newReplay.parts};
  const legacyGame=legacyGames[0],legacyGameKey=[legacyGame.boardTime,legacyGame.awayKey,legacyGame.homeKey].join('|');
  const legacyGameMetadata={league:legacyGame.league,boardDate:legacyGame.boardDate,gameKey:legacyGameKey,boardTime:legacyGame.boardTime,
    awayRaw:legacyGame.awayRaw,homeRaw:legacyGame.homeRaw,awayKey:legacyGame.awayKey,homeKey:legacyGame.homeKey,
    marketCount:legacyGame.markets.length,periods:[...new Set(legacyGame.markets.map(m=>m.period))],identityStatus:legacyGame.identityStatus,executable:false};
  await db.query(`INSERT INTO soccer_raw_seen_history_batches_v1(batch_hash,derivation_version,derived_hash,capture_id,league,observed_at,source_received_at,source_persisted_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newReplay.captureBatchId,legacyVersion,legacyHash,legacyPart.captureId,legacyPart.league,newReplay.observedAt,newReplay.receivedAt,newReplay.persistedAt,JSON.stringify(legacyMetadata)]);
  await db.query(`INSERT INTO soccer_raw_seen_history_games_v1(batch_hash,derivation_version,league,board_date,game_key,metadata) VALUES($1,$2,$3,$4,$5,$6)`,
    [newReplay.captureBatchId,legacyVersion,legacyGame.league,legacyGame.boardDate,legacyGameKey,JSON.stringify(legacyGameMetadata)]);
  const legacyScope={...scope,gameKey:legacyGameKey};
  let legacyRead=await queryRawHistoryIndex(legacyScope);
  assert.equal(legacyRead.entries.length,1);assert.equal(legacyRead.entries[0].derivationVersion,legacyVersion,'un-reindexed saved v1 source remains visible after a v2 release');
  const beforeMigration=await queryRawHistoryIndex(scope);assert.equal(beforeMigration.hasMore,true);
  const legacyBody=JSON.parse(Buffer.from(beforeMigration.nextAfter.split('.')[0],'base64url').toString());
  assert.equal(legacyBody.derivationVersion,RAW_SEEN_DERIVATION_VERSION);
  delete legacyBody.derivationVersion;
  const obsoleteEncoded=Buffer.from(JSON.stringify(legacyBody)).toString('base64url');
  const obsoleteToken=obsoleteEncoded+'.'+createHmac('sha256',process.env.SESSION_SECRET).update('RAW-HISTORY-INDEX-v1\n'+obsoleteEncoded).digest('base64url');
  await assert.rejects(()=>queryRawHistoryIndex({...scope,after:obsoleteToken}),e=>e.code==='RAW_HISTORY_INDEX_CURSOR_INVALID','an older-engine cursor is not silently reused under a new derivation');
  await indexRawSeenHistoryCapture(legacyPart.captureId);
  const afterMigrationPage=await queryRawHistoryIndex({...scope,after:beforeMigration.nextAfter});
  const stableLegacy=afterMigrationPage.entries.find(e=>e.captureBatchId===newReplay.captureBatchId);
  assert.ok(stableLegacy);assert.equal(stableLegacy.derivationVersion,legacyVersion,'the original cutoff pins the older valid batch across a concurrent v2 append');
  legacyRead=await queryRawHistoryIndex(legacyScope);
  assert.equal(legacyRead.entries.length,1);assert.equal(legacyRead.entries[0].derivationVersion,RAW_SEEN_DERIVATION_VERSION,'a fresh query prefers the new version once it exists, with no duplicate batch');
  const partialSource=synthetic(item=>{
    item.observedAt='2026-11-06T05:00:00.000Z';
    item.tables[0].rows=[structuredClone(evidence.tables[171].rows[758])];item.tables[0].rows[0].cells[4].pair=['-'];
  });
  await insertSource(partialSource);await indexRawSeenHistoryCapture(partialSource.captureId);
  const partialIndex=(await queryRawHistoryIndex(scope)).entries.find(e=>e.captureBatchId===partialSource.captureId)
    ||(await queryRawHistoryIndex({...scope,gameKey:[deriveRawSeenSoccerHistory([partialSource]).games[0].boardTime,deriveRawSeenSoccerHistory([partialSource]).games[0].awayKey,deriveRawSeenSoccerHistory([partialSource]).games[0].homeKey].join('|')})).entries.find(e=>e.captureBatchId===partialSource.captureId);
  assert.ok(partialIndex);assert.equal(partialIndex.marketCount,4);assert.equal(partialIndex.unavailableMarketCount,1,'index reports unavailable siblings without dropping independently valid saved quotes');
  assert.equal(JSON.stringify(parts), sourceBefore, 'real retained fixture remains byte-equivalent in memory');
  assert.deepEqual((await snapshot()).filter(row => original.some(item => item.capture_id === row.capture_id)), original);
  const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
  assert.deepEqual(tables, ['soccer_raw_seen_history_batches_v1','soccer_raw_seen_history_games_v1','sports_reader_seen_captures_v1'], 'no normalized head, analysis, bet or settlement table is created');
} finally {
  await db.close(); delete globalThis.__RAW_HISTORY_INDEX_SQL;
  for (const key of envNames) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
}
console.log('PASS raw soccer history index: real 4-part hash source → 16 append-only games; direct board-day Nov5 UCL nine/all nine quotes; original clock/hash integrity, idempotent writes, SELECT-only reads, signed 50-row keysets, bounded unsupported-aware source scan, late delivery/day distinction, oversized-market poison rejection, same-identity two-day readback, cross-league/auth/origin isolation; Production NOT VERIFIED');
