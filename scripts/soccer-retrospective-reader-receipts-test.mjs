import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
const fixture = await soccerSqlFixture(), { db } = fixture;
const before = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_V2_URL: process.env.DATABASE_V2_URL };
process.env.DATABASE_URL = 'postgres://fixture.invalid/soccer-retro'; delete process.env.DATABASE_V2_URL;
try {
  const { saveSoccerReaderSnapshot: save } = await import('../lib/soccer/reader-store.js');
  const { soccerReaderHash } = await import('../lib/soccer/reader.js');
  const { canonicalSoccerPayload } = await import('../reader/soccer-parser.js');
  const { soccerJournalHash } = await import('../lib/soccer/journal.js');
  const { loadSoccerRetrospectiveReaderReceipts: load } = await import('../lib/soccer/retrospective-reader-receipts.js');
  const date = '2026-10-22';
  const capture = (league, day, observed, legacy = false) => {
    const payload = { league, boardDate: day, observedAt: observed, executable: false, deviceId: 'must-never-leak',
      ...(legacy ? {} : { periodsCovered: ['FT'] }),
      games: [{ league, boardDate: day, boardTime: '21:00', awayKey: 'away', homeKey: 'home',
        ...(legacy ? {} : { periodsCovered: ['FT'], periodStates: { FT: 'open' } }),
        markets: [{ kind: 'TOTAL', unit: 'GOALS', line: '2.5', overWater: 0.9, underWater: 0.95,
          ...(legacy ? {} : { period: 'FT', periodEvidence: { period: 'FT', status: 'EXPLICIT' } }) }] }] };
    payload.contentHash = soccerReaderHash(canonicalSoccerPayload(payload)); return payload;
  };
  const a = capture('EPL', date, '2026-10-21T08:00:00.123456Z');
  const first = await save(a, { receivedAt: '2026-10-21T08:00:01.123456Z' });
  const b = capture('EPL', date, '2026-10-21T08:01:00.654321Z');
  await save(b, { receivedAt: '2026-10-21T08:01:01.654321Z' });
  await save(capture('UCL', date, '2026-10-21T08:02:00.123456Z'));
  await save(capture('EPL', '2026-10-23', '2026-10-21T08:02:00.123456Z'));
  let count = 0;
  const original = globalThis.__SOCCER_TEST_SQL;
  globalThis.__SOCCER_TEST_SQL = async (queries, tx) => { count += queries.length; assert.equal(tx, false); return original(queries, tx); };
  const full = await load('epl', date, { maxRows: 2 });
  globalThis.__SOCCER_TEST_SQL = original;
  assert.equal(count, 1, 'exactly one SQL statement for one MVCC snapshot');
  assert.equal(full.status, 'COMPLETE'); assert.equal(full.rows.length, 2);
  assert.equal(full.rows[0].observationId, first.observationId);
  assert.equal(full.rows[0].sourceObservedAt, '2026-10-21T08:00:00.123456Z');
  assert.equal(full.rows[0].receivedAt, '2026-10-21T08:00:01.123456Z');
  assert.match(full.rows[0].persistedAt, /\.\d{6}Z$/);
  assert.equal(full.rows[0].periods[0].period, 'FT');
  assert.equal(JSON.stringify(full.rows).includes('must-never-leak'), false);
  assert.equal(Object.hasOwn(full.rows[0].payload, 'deviceId'), false);
  assert.match(full.rows[0].deviceHash, /^[0-9a-f]{64}$/);
  assert.deepEqual((await load('epl', date, { maxRows: 1 })).rows, []);
  assert.equal((await load('epl', date, { maxRows: 1 })).status, 'PARTIAL');
  assert.deepEqual((await load('epl', date, { maxRows: 1 })).reasonCodes, ['READER_RECEIPT_ROW_BUDGET']);
  assert.equal((await load('epl', date, { maxRows: 2, maxBytes: full.observedBytes })).status, 'COMPLETE');
  assert.equal((await load('epl', date, { maxRows: 2, maxBytes: full.observedBytes - 1 })).status, 'PARTIAL');
  assert.deepEqual((await load('epl', date, { maxRows: 2, maxBytes: full.observedBytes - 1 })).reasonCodes, ['READER_RECEIPT_BYTE_BUDGET']);
  assert.equal((await load('ucl', date)).rows.length, 1);
  assert.equal((await load('epl', '2026-10-23')).rows.length, 1);
  assert.equal((await load('epl', '2026-10-24')).rows.length, 0);
  await assert.rejects(() => load('EPL', date), /SCOPE_INVALID/);
  await assert.rejects(() => load('epl', date, { maxRows: 0 }), /SCOPE_INVALID/);
  await assert.rejects(() => load('epl', date, { maxBytes: 1 }), /SCOPE_INVALID/);
  // Legacy v2 row without any period index is preserved as UNKNOWN.
  const legacy = capture('EPL', '2026-10-25', '2026-10-21T08:00:00.123456Z', true);
  await db.query(`INSERT INTO sports_soccer_reader_observations_v2(observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
    VALUES ($1,'EPL',$2,$3,$4,$4,$5)`, [soccerJournalHash(legacy), legacy.boardDate, legacy.contentHash, legacy.observedAt, JSON.stringify(legacy)]);
  assert.deepEqual((await load('epl', legacy.boardDate)).rows[0].periods, [{ period: 'UNKNOWN', contentHash: legacy.contentHash }]);
  // An immutable malformed original must fail rather than be silently skipped.
  const bad = capture('EPL', '2026-10-26', '2026-10-21T08:00:00.123456Z', true);
  await db.query(`INSERT INTO sports_soccer_reader_observations_v2(observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
    VALUES ($1,'EPL',$2,$3,$4,$4,$5)`, ['corrupt', bad.boardDate, bad.contentHash, bad.observedAt, JSON.stringify(bad)]);
  await assert.rejects(() => load('epl', bad.boardDate), /RECEIPT_CORRUPTED/);
  const skew = capture('EPL', '2026-10-27', '2026-10-21T08:00:00.123456Z', true);
  await db.query(`INSERT INTO sports_soccer_reader_observations_v2(observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
    VALUES ($1,'EPL',$2,$3,$4,$5,$6)`, [soccerJournalHash(skew), skew.boardDate, skew.contentHash, '2026-10-21T08:00:00.123457Z', skew.observedAt, JSON.stringify(skew)]);
  await assert.rejects(() => load('epl', skew.boardDate), /RECEIPT_CORRUPTED/);
  const wrongLeague = capture('UCL', '2026-10-28', '2026-10-21T08:00:00.123456Z', true);
  await db.query(`INSERT INTO sports_soccer_reader_observations_v2(observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
    VALUES ($1,'EPL',$2,$3,$4,$4,$5)`, [soccerJournalHash(wrongLeague), wrongLeague.boardDate, wrongLeague.contentHash, wrongLeague.observedAt, JSON.stringify(wrongLeague)]);
  await assert.rejects(() => load('epl', wrongLeague.boardDate), /RECEIPT_CORRUPTED/);
  const periodBad = capture('EPL', '2026-10-29', '2026-10-21T08:00:00.123456Z');
  const periodId = soccerJournalHash(periodBad);
  await db.query(`INSERT INTO sports_soccer_reader_observations_v2(observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
    VALUES ($1,'EPL',$2,$3,$4,$4,$5)`, [periodId, periodBad.boardDate, periodBad.contentHash, periodBad.observedAt, JSON.stringify(periodBad)]);
  await db.query(`INSERT INTO sports_soccer_reader_period_observations_v2(observation_id,period,content_hash) VALUES ($1,'FT','invalid')`, [periodId]);
  await assert.rejects(() => load('epl', periodBad.boardDate), /PERIOD_CORRUPTED/);
  console.log('PASS retrospective Reader receipts: one SQL snapshot, bounds, isolation, microseconds, hashes, privacy, legacy and corruption');
} finally {
  for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await fixture.close();
}
