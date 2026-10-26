import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { buildMarketCaptureReceipt, recordMarketCaptureReceipt } from '../lib/market-capture-receipts.js';
import { buildMarketLineHistoryRows, recordMarketLineHistory } from '../lib/market-line-history-v1.js';
import { requireReaderHistorySaved } from '../lib/reader-history-receipt.js';

const db = new PGlite();
const sql = (parts, ...values) => {
  const query = parts.reduce((result, part, index) => result + (index ? `$${index}` : '') + part, '');
  return { query, values, then: (resolve, reject) => db.query(query, values).then(result => result.rows).then(resolve, reject) };
};
sql.transaction = queries => db.transaction(async transaction => {
  const rows = [];
  for (const query of queries) rows.push((await transaction.query(query.query, query.values)).rows);
  return rows;
});
const capture = minute => ({ league: 'MLB', boardDate: '2026-10-27',
  observedAt: `2026-10-26T22:${minute}:01.000Z`, pageActivityAt: '2026-10-26T22:00:00.000Z',
  receivedAt: `2026-10-26T22:${minute}:02.000Z`, readerVersion: '2.1.42', rawBoardHash: 'a'.repeat(64),
  games: [{ gamePk: 777, marketStatus: 'open', markets: [
    { market: '全場大小', pick: '大8+20', water: 0.94 }, { market: '全場大小', pick: '小8+20', water: 1.06 },
  ] }], unopenedGames: [
    { gamePk: 778, marketStatus: 'locked', unavailableReason: 'not-rendered-by-reader', markets: [] },
    { gamePk: 779, marketStatus: 'locked', unavailableReason: 'reader-identity-unresolved', markets: [] },
    { gamePk: 780, marketStatus: 'locked', markets: [] },
  ] });
const count = async table => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
try {
  const first = capture('01'), heartbeat = capture('02');
  const built = buildMarketCaptureReceipt(first);
  assert.equal(built.games.length, 4);
  assert.deepEqual(built.games[0].markets, [false, true, false, false]);
  assert.equal(built.gamesFormat, 'AVAILABILITY_STATE_REF_V1');
  assert.equal(built.games[0].stateHash, buildMarketLineHistoryRows(first)[0].state_hash, 'availability receipt references exact retained immutable quote digest');
  assert.deepEqual(built.games[0].missingMarkets, ['全場讓分', '上半讓分', '上半大小']);
  assert.deepEqual(built.games.slice(1).map(game => game.captureStatus), ['UNOPENED', 'IDENTITY_BLOCKED', 'LOCKED']);
  assert.ok(built.games.slice(1).every(game => game.markets.every(value => value === false) && game.stateHash === null));
  assert.notEqual(built.sourceObservedAt, built.pageActivityAt, 'capture time must remain separate from DOM activity time');
  assert.notEqual(built.receiptId, buildMarketCaptureReceipt(heartbeat).receiptId, 'same-price heartbeat has its own source receipt');
  const write = snapshot => requireReaderHistorySaved(snapshot, {
    record: value => recordMarketLineHistory(value, { sql }),
    recordCapture: value => recordMarketCaptureReceipt(value, { sql }),
  });
  const saved = await write(first);
  assert.equal(saved.captureReceipt.persisted, true);
  assert.equal(saved.captureReceipt.sourceObservedAt, first.observedAt);
  assert.equal(saved.captureReceipt.receivedAt, first.receivedAt);
  assert.equal(saved.captureReceipt.coverageComplete, false);
  assert.equal(saved.captureReceipt.closingLineVerified, false);
  const second = await write(heartbeat);
  assert.equal(second.unchanged, 1);
  assert.equal(await count('tai888_market_line_history_v1'), 1, 'same quote does not become another changed-price event');
  assert.equal(await count('tai888_market_capture_receipts_v1'), 2, 'unchanged quote still retains heartbeat evidence');
  assert.equal((await db.query('SELECT observed_at::text AS observed_at FROM tai888_market_line_history_v1')).rows[0].observed_at,
    '2026-10-26 22:00:00+00', 'original price event time is never moved to heartbeat time');
  const retry = await recordMarketCaptureReceipt({ ...first, receivedAt: '2026-10-26T23:00:00.000Z' }, { sql });
  assert.equal(retry.receiptId, saved.captureReceipt.receiptId);
  assert.equal(retry.receivedAt, first.receivedAt, 'retry does not move first server receipt');
  assert.equal(retry.persistedAt, saved.captureReceipt.persistedAt);
  assert.equal(await count('tai888_market_capture_receipts_v1'), 2, 'exact source capture is idempotent');

  const missingWater = structuredClone(first);
  missingWater.games[0].markets[0].water = null;
  assert.equal(buildMarketCaptureReceipt(missingWater).games[0].markets[1], false, 'missing water must not be fabricated as zero');
  const legacy = { ...first, observedAt: undefined, receivedAt: undefined };
  const legacyReceipt = await recordMarketCaptureReceipt(legacy, { sql });
  assert.equal(legacyReceipt.sourceObservedAt, null);
  assert.equal(legacyReceipt.receivedAt, null, 'unknown acquisition remains unknown despite current persistence');
  assert.ok(legacyReceipt.persistedAt);
  const nba = { league: 'NBA', boardDate: first.boardDate, observedAt: first.observedAt, pageActivityAt: first.pageActivityAt,
    receivedAt: first.receivedAt, games: [{ boardTime: '07:00', awayCode: 'LAL', homeCode: 'GS', marketStatus: 'open',
      fullTotal: { line: '224-50', overWater: 0.94, underWater: 1.06 } }] };
  await assert.rejects(() => recordMarketCaptureReceipt(nba, { sql }), /READBACK_FAILED/, 'available receipts cannot reference an absent quote');
  await recordMarketLineHistory(nba, { sql });
  const nbaFirst = await recordMarketCaptureReceipt(nba, { sql });
  await recordMarketLineHistory({ ...nba, boardDate: '2026-10-28' }, { sql });
  const nbaNext = await recordMarketCaptureReceipt({ ...nba, boardDate: '2026-10-28' }, { sql });
  assert.notEqual(nbaFirst.receiptId, nbaNext.receiptId, 'NBA repeat team/time is isolated by board date');
  assert.equal(buildMarketCaptureReceipt(nba).games[0].gameKey, '07:00|LAL|GS');
  await recordMarketLineHistory({ ...first, league: 'KBO' }, { sql });
  await recordMarketCaptureReceipt({ ...first, league: 'KBO' }, { sql });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM tai888_market_capture_receipts_v1 WHERE league='KBO'")).rows[0].n, 1);

  for (const recordCapture of [async () => { throw Error('synthetic database failure'); }, async () => ({ configured: true, persisted: false })]) {
    await assert.rejects(() => requireReaderHistorySaved(first, {
      record: async () => ({ configured: true, checked: 1, inserted: 0, unchanged: 1, failed: 0 }), recordCapture,
    }), error => error.status === 503 && error.code === 'MARKET_CAPTURE_RECEIPT_WRITE_FAILED'
      && error.historyTracking.captureReceipt.persisted === false);
  }
  let receiptCalled = false;
  await assert.rejects(() => requireReaderHistorySaved(first, {
    record: async () => ({ configured: true, checked: 1, inserted: 0, unchanged: 0, failed: 1 }),
    recordCapture: async () => { receiptCalled = true; },
  }), error => error.code === 'MARKET_LINE_HISTORY_WRITE_FAILED');
  assert.equal(receiptCalled, false, 'archive failure is not masked by a successful receipt');
  await db.query("UPDATE tai888_market_capture_receipts_v1 SET games='[]'::jsonb WHERE receipt_id=$1", [built.receiptId]);
  await assert.rejects(() => recordMarketCaptureReceipt(first, { sql }), /READBACK_FAILED/, 'receipt payload corruption must fail readback');
  assert.equal((await recordMarketCaptureReceipt(first, { env: {} })).persisted, false, 'unconfigured storage cannot claim saved');
  assert.throws(() => buildMarketCaptureReceipt({ ...first, league: 'EPL' }), /INVALID/);
  assert.throws(() => buildMarketCaptureReceipt({ ...first, boardDate: '2026-02-30' }), /INVALID/);
  assert.throws(() => buildMarketCaptureReceipt({ ...first, observedAt: '1', pageActivityAt: undefined }), /INVALID/);
  assert.throws(() => buildMarketCaptureReceipt({ ...first, pageActivityAt: '2026-10-26T22:02:00.000Z' }), /TIME_INVALID/);
  assert.throws(() => buildMarketCaptureReceipt({ ...first, games: [...first.games, ...first.games] }), /DUPLICATE_GAME/);
  console.log('Market capture receipts PostgreSQL test PASS: immutable/idempotent readback, unchanged-heartbeat evidence, missing/locked markets, time/league/date isolation, failure gating; NOT Production');
} finally { await db.close(); }
