import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { buildReaderSeenCapture, canonicalReaderSeenCapture, initializeReaderSeenCaptureStore } from '../lib/reader-seen-capture.js';
import { deriveRawSeenSoccerHistory, reassembleRawSeenBatch, RAW_SEEN_DERIVATION_VERSION } from '../lib/soccer/raw-seen-history.js';
import { drainRawSeenHistoryIndex, getRawSeenHistoryProgress } from '../lib/soccer/raw-seen-history-maintenance.js';
import { queryRawHistoryIndex } from '../lib/soccer/raw-seen-history-index.js';
import { readRawSeenHistoryAudit } from '../lib/soccer/raw-seen-history-audit.js';

// Real PostgreSQL checks for immutable v2 -> v3 migration. All captures,
// prior receipts and deliberately malformed counterexamples are isolated here.
const db = new PGlite(), statements = [];
const query = (text, params = []) => ({ query: text, params,
  then(a, b) { return execute([{ query: text, params }]).then(rows => rows[0]).then(a, b); } });
const sql = (strings, ...params) => query(strings.reduce((s, part, i) => s + (i ? '$' + i : '') + part, ''), params);
sql.query = query;
async function execute(queries, transaction = false) {
  const run = async connection => {
    const rows = [];
    for (const item of queries) { statements.push(item.query); rows.push((await connection.query(item.query, item.params)).rows); }
    return rows;
  };
  return transaction ? db.transaction(run) : run(db);
}
sql.transaction = queries => execute(queries, true);
const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/soccer/ucl-seen-pregame-20261105.json.gz', import.meta.url))));
const original = reassembleRawSeenBatch(fixture).evidence, V2 = 'SOCCER-RAW-CREDIT-TABLE-HISTORY-v2', V1 = 'SOCCER-RAW-CREDIT-TABLE-HISTORY-v1';
const now = Math.max(Date.now(), Date.parse('2026-11-10T12:00:00Z')) + 86400000, before = new Date(now - 60000).toISOString();
let sequence = 0;
const hash = value => createHash('sha256').update(canonicalReaderSeenCapture(value)).digest('hex');
function part(evidence) {
  const built = buildReaderSeenCapture({ schema: 'READER-SEEN-CAPTURE-v1', evidence }, { deviceId: 'upgrade-fixture', headerVersion: evidence.readerVersion });
  return { ...built, league: evidence.league, readerVersion: evidence.readerVersion, observedAt: evidence.observedAt,
    captureBatchId: evidence.captureBatchId || null, partIndex: evidence.partIndex ?? null, partCount: evidence.partCount ?? null,
    receivedAt: before, persistedAt: before };
}
function source({ unsupported = false, note = false } = {}) {
  const evidence = { ...structuredClone(original), observedAt: new Date(Date.parse(original.observedAt) + ++sequence * 1000).toISOString(),
    tables: [{ ...structuredClone(original.tables[171]), rows: [structuredClone(original.tables[171].rows[758])] }] };
  if (unsupported) evidence.tables[0].headers = [];
  if (note) evidence.tables[0].rows[0].cells.push({ pair: ['測試備註'] });
  return part(evidence);
}
function fragmented(size) {
  const whole = source();
  return Array.from({ length: size }, (_, partIndex) => part({ ...structuredClone(whole.evidence), captureBatchId: whole.captureId,
    partIndex, partCount: size, tables: partIndex === 0 ? structuredClone(whole.evidence.tables) : [] }));
}
async function insertSource(value, persistedAt = before) {
  await db.query(`INSERT INTO sports_reader_seen_captures_v1(capture_id,schema_version,league,source_observed_at,page_activity_at,
    evidence_hash,evidence_json,source_scope_hash,reader_version,table_count,row_count,cell_count,locked_row_count,
    capture_batch_id,part_index,part_count,received_at,persisted_at)
    VALUES($1,'READER-SEEN-CAPTURE-v1',$2,$3::timestamptz,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16::timestamptz)`,
  [value.captureId, value.league, value.observedAt, value.evidenceHash, value.evidenceJson, value.sourceScopeHash, value.readerVersion,
    value.tableCount, value.rowCount, value.cellCount, value.lockedRowCount, value.captureBatchId, value.partIndex, value.partCount, before, persistedAt]);
}
async function attempt(value, reason, { version = V2, at = before, league = value.league, batch = value.captureBatchId || value.captureId } = {}) {
  await db.query(`INSERT INTO soccer_raw_seen_history_attempts_v1(capture_id,derivation_version,batch_hash,league,source_capture_ids,
    source_watermark_hash,status,reason,attempted_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,'SOURCE_UNINDEXED',$7,$8::timestamptz)`,
  [value.captureId, version, batch, league, JSON.stringify([value.captureId]), hash([value.captureId]), reason, at]);
}
async function oldIndex(values, version = V2, { manifest = values, league = values[0].league, at = before } = {}) {
  const derived = deriveRawSeenSoccerHistory(values, { derivationVersion: V2 }), first = values[0];
  const metadata = { schema: 'soccer-raw-history-index-v1', derivationVersion: version, derivedHash: derived.derivedHash,
    capture: { captureId: first.captureId, captureBatchId: first.captureBatchId, league, observedAt: first.observedAt, evidenceHash: first.evidenceHash },
    parts: derived.parts.filter(p => manifest.some(v => v.captureId === p.captureId)) };
  await db.query(`INSERT INTO soccer_raw_seen_history_batches_v1(batch_hash,derivation_version,derived_hash,capture_id,league,
    observed_at,source_received_at,source_persisted_at,metadata,indexed_at) VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$7::timestamptz,$8::jsonb,$9::timestamptz)`,
  [derived.captureBatchId, version, derived.derivedHash, first.captureId, league, first.observedAt, before, JSON.stringify(metadata), at]);
  for (const game of derived.games) {
    const m = { ...game, league, gameKey: [game.boardTime, game.awayKey, game.homeKey].join('|'), marketCount: game.markets.length };
    await db.query(`INSERT INTO soccer_raw_seen_history_games_v1(batch_hash,derivation_version,league,board_date,game_key,metadata)
      VALUES($1,$2,$3,$4::date,$5,$6::jsonb)`, [derived.captureBatchId, version, league, game.boardDate, m.gameKey, JSON.stringify(m)]);
  }
}
const rowsSnapshot = async table => canonicalReaderSeenCapture(JSON.parse(JSON.stringify((await db.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows)));
async function reset() { await db.query('TRUNCATE sports_reader_seen_captures_v1,soccer_raw_seen_history_batches_v1,soccer_raw_seen_history_games_v1,soccer_raw_seen_history_attempts_v1 CASCADE'); }
async function progress(at = now) {
  const start = statements.length, value = await getRawSeenHistoryProgress({ db: sql, now: at });
  assert.ok(statements.slice(start).every(s => /^\s*(?:WITH|SELECT)\b/.test(s)), 'migration progress is SELECT-only');
  return value;
}
async function audit(at = now) { return readRawSeenHistoryAudit({ limit: 4 }, { db: sql, now: at }); }

try {
  assert.equal(RAW_SEEN_DERIVATION_VERSION, 'SOCCER-RAW-CREDIT-TABLE-HISTORY-v3');
  await initializeReaderSeenCaptureStore({ sql });
  await drainRawSeenHistoryIndex({ db: sql, now });
  const unsupported = source({ unsupported: true }), budget = fragmented(9), recoverable = source({ note: true });
  for (const value of [unsupported, ...budget, recoverable]) await insertSource(value);
  await attempt(unsupported, 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT');
  for (const value of budget) await attempt(value, 'RAW_SEEN_RECOVERY_BUDGET_EXCEEDED');
  await attempt(recoverable, 'RAW_SEEN_RECOVERY_NO_GOALS');
  const attemptsBefore = await rowsSnapshot('soccer_raw_seen_history_attempts_v1');
  let pg = await progress();
  assert.equal(pg.counts.sourceBatches, 3); assert.equal(pg.counts.stableAttemptBatches, 2); assert.equal(pg.counts.retryPendingBatches, 1);
  const audited = await audit(); assert.equal(audited.ok, true); assert.equal(audited.samples.length, 2);
  assert.deepEqual(audited.samples.map(s => s.attemptReason).sort(), ['RAW_SEEN_RECOVERY_BUDGET_EXCEEDED', 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT']);
  const drained = await drainRawSeenHistoryIndex({ db: sql, now, maxBatches: 8 });
  assert.equal(drained.processedBatches, 1); assert.equal(drained.indexedBatches, 1); assert.equal(drained.results[0].captureId, recoverable.captureId);
  assert.equal(await rowsSnapshot('soccer_raw_seen_history_attempts_v1'), attemptsBefore, 'v2 attempts are retained without relabelling');
  pg = await progress(); assert.equal(pg.counts.indexedBatches, 1); assert.equal(pg.counts.stableAttemptBatches, 2); assert.equal(pg.counts.retryPendingBatches, 0);
  // No other version, reason, league, batch or future proof may suppress work.
  for (const options of [{ version: V1 }, { reason: 'RAW_SEEN_RECOVERY_NO_GOALS' }, { reason: 'RAW_SEEN_RECOVERY_INCOMPLETE' },
    { league: 'EPL' }, { batch: 'a'.repeat(64) }, { at: new Date(now + 1).toISOString() }]) {
    await reset(); const value = source({ unsupported: true }); await insertSource(value);
    const { reason = 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT', ...rest } = options;
    await attempt(value, reason, rest);
    pg = await progress(); assert.equal(pg.counts.retryPendingBatches, 1); assert.equal(pg.counts.stableAttemptBatches, 0);
    assert.equal((await audit()).samples.length, 0, 'audit does not widen migration policy or source scope');
    const run = await drainRawSeenHistoryIndex({ db: sql, now, maxBatches: 1 });
    assert.equal(run.processedBatches, 1); assert.equal(run.results[0].captureId, value.captureId, 'candidate agrees with read-only progress');
  }
  // Exact old successes remain readable, but require current revalidation.
  await reset(); const retained = source(); await insertSource(retained); await oldIndex([retained]);
  const oldSnapshot = await rowsSnapshot('soccer_raw_seen_history_batches_v1');
  pg = await progress(); assert.equal(pg.counts.indexedBatches, 0); assert.equal(pg.counts.previousReadableIndexedBatches, 1); assert.equal(pg.counts.retryPendingBatches, 1);
  const history = await queryRawHistoryIndex({ league: 'UCL', from: '2026-11-05', through: '2026-11-05' }, { db: sql, now });
  assert.equal(history.entries.length, 1); assert.equal(history.entries[0].derivationVersion, V2);
  assert.equal((await drainRawSeenHistoryIndex({ db: sql, now })).indexedBatches, 1);
  pg = await progress(); assert.equal(pg.counts.indexedBatches, 1); assert.equal(pg.counts.previousReadableIndexedBatches, 0);
  const priorRows = (await db.query('SELECT * FROM soccer_raw_seen_history_batches_v1 WHERE derivation_version=$1 ORDER BY 1,2', [V2])).rows;
  assert.equal(canonicalReaderSeenCapture(JSON.parse(JSON.stringify(priorRows))), oldSnapshot, 'upgrade appends without changing old success proof');
  // Coverage must come from a single prior-version manifest, not a union of
  // incomplete v1/v2 manifests or a hash claimed by another league.
  await reset(); const split = fragmented(2); for (const value of split) await insertSource(value);
  await oldIndex(split, V2, { manifest: [split[0]] }); await oldIndex(split, V1, { manifest: [split[1]] });
  pg = await progress(); assert.equal(pg.counts.previousReadableIndexedBatches, 0); assert.equal(pg.counts.retryPendingBatches, 1);
  for (const options of [{ league: 'EPL' }, { at: new Date(now + 1).toISOString() }]) {
    await reset(); const value = source(); await insertSource(value); await oldIndex([value], V2, options);
    assert.equal((await progress()).counts.previousReadableIndexedBatches, 0);
  }
  await reset(); const complete = fragmented(2); for (const value of complete) await insertSource(value);
  await oldIndex(complete, V1); assert.equal((await progress()).counts.previousReadableIndexedBatches, 1, 'v1 metadata remains readable without being called current');
  const late = part({ ...structuredClone(complete[0].evidence), partIndex: 2, partCount: 3, tables: [] });
  await insertSource(late, new Date(now + 1).toISOString());
  assert.equal((await progress()).counts.previousReadableIndexedBatches, 1, 'cutoff excludes a future source fragment');
  pg = await progress(now + 1); assert.equal(pg.counts.previousReadableIndexedBatches, 0); assert.equal(pg.counts.retryPendingBatches, 1, 'late source cannot hide behind an old manifest');
  console.log('PASS raw-history upgrade PostgreSQL: exact v3<-v2 two-reason reuse; NO_GOALS/other-version/scope/time retry; shared audit policy; immutable attempts and prior indexes; prior-readable/current distinction; single-version full manifests and late fragment cutoffs; NOT Production');
} finally { await db.close(); }
