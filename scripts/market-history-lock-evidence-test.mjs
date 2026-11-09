import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { soccerJournalHash } from '../lib/soccer/journal.js';
import { MARKET_CAPTURE_RECEIPT_SCHEMA, MARKET_CAPTURE_GAMES_FORMAT } from '../lib/market-capture-receipts.js';
import { parseMarketHistoryCoverageQuery, queryMarketHistoryCoverage } from '../lib/market-history-coverage.js';

const db = new PGlite();
const now = Date.parse('2026-11-09T10:00:00.000Z');
const at = '2026-11-08T05:09:28.382Z';
const boardDate = '2026-11-08';
const sql = async (strings, ...values) => {
  const statement = strings.reduce((out, part, index) => out + (index ? `$${index}` : '') + part, '');
  assert.doesNotMatch(statement, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i,
    'the coverage projection must never rewrite immutable receipts');
  return (await db.query(statement, values)).rows;
};
const receiptGame = (time, marker, captureStatus = marker === 'NO_PARSED_MARKETS' ? 'NOT_CAPTURED' : 'LOCKED') => ({
  gameKey: `${time}|WSH|OKC`, gamePk: null, marketStatus: 'locked', captureStatus,
  markets: [false, false, false, false], stateHash: null,
  missingMarkets: ['全場讓分', '全場大小', '上半讓分', '上半大小'],
  ...(marker === undefined ? {} : { availabilityEvidence: marker }),
});
async function save(game, league = 'NBA') {
  const games = [game];
  const original = { schema: MARKET_CAPTURE_RECEIPT_SCHEMA, gamesFormat: MARKET_CAPTURE_GAMES_FORMAT,
    league, boardDate, sourceObservedAt: at, pageActivityAt: at, sourceHash: null, readerVersion: '2.1.60', games };
  const id = soccerJournalHash(original);
  await db.query('INSERT INTO tai888_market_capture_receipts_v1 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, league, boardDate, at, at, at, at, null, original.readerVersion, original.gamesFormat, JSON.stringify(games)]);
  return id;
}
const read = (league, readSql = sql) => queryMarketHistoryCoverage(parseMarketHistoryCoverageQuery(
  new URLSearchParams({ league, date: boardDate }), { now, secret: 'synthetic-source-lock-history-cursor' }), { sql: readSql });
try {
  await db.exec(`CREATE TABLE tai888_market_line_history_v1 (
    league text,board_date date,game_key text,game_pk bigint,observed_at timestamptz,
    state_hash text,markets text,source_hash text,reader_version text);
    CREATE TABLE tai888_market_capture_receipts_v1 (
    receipt_id text,league text,board_date date,source_observed_at timestamptz,page_activity_at timestamptz,
    received_at timestamptz,persisted_at timestamptz,source_hash text,reader_version text,games_format text,games jsonb);`);
  const legacy = receiptGame('09:00');
  const explicit = receiptGame('09:05', 'EXPLICIT_SOURCE_LOCK');
  const missing = receiptGame('09:10', 'NO_PARSED_MARKETS');
  const ids = await Promise.all([legacy, explicit, missing].map(game => save(game)));
  const before = (await db.query('SELECT receipt_id,games FROM tai888_market_capture_receipts_v1 ORDER BY receipt_id')).rows;
  let result = await read('NBA');
  assert.equal(result.productionWrites, false); assert.equal(result.coverageComplete, false);
  for (const game of result.games) {
    assert.equal(game.receiptIntegrity.status, 'PASS');
    assert.equal(game.integrity.status, 'NOT_VERIFIED', 'receipt integrity is separate from saved quote integrity');
    assert.equal(game.closingCoverage, 'NOT_VERIFIED');
  }
  const find = time => result.games.find(game => game.gameKey.startsWith(`${time}|`));
  assert.equal(find('09:00').captureStatus, 'LOCKED', 'a legacy immutable classification remains unchanged');
  assert.ok(find('09:00').latestCaptureMarkets.every(market => market.status === 'LOCKED'
    && !Object.hasOwn(market, 'availabilityEvidence')), 'legacy rows do not gain fabricated proof');
  assert.ok(find('09:05').latestCaptureMarkets.every(market => market.status === 'LOCKED'
    && market.availabilityEvidence === 'EXPLICIT_SOURCE_LOCK'));
  assert.ok(find('09:10').latestCaptureMarkets.every(market => market.status === 'NOT_CAPTURED'
    && market.availabilityEvidence === 'NO_PARSED_MARKETS'));
  assert.deepEqual((await db.query('SELECT receipt_id,games FROM tai888_market_capture_receipts_v1 ORDER BY receipt_id')).rows,
    before, 'new view metadata cannot alter source JSON or its receipt hash');
  const detachedProof = await read('NBA', async (strings, ...values) => (await sql(strings, ...values)).map(envelope => ({
    ...envelope, games: envelope.games.map(row => row.receipt_id === ids[0] ? { ...row,
      game: { ...row.game, availabilityEvidence: 'EXPLICIT_SOURCE_LOCK' } } : row),
  })));
  const forged = detachedProof.games.find(game => game.gameKey === legacy.gameKey);
  assert.ok(forged.receiptIntegrity.issues.includes('CAPTURE_RECEIPT_GAME_MISMATCH'),
    'projected proof must match the exact game included in the immutable receipt hash');
  assert.ok(forged.latestCaptureMarkets.every(market => market.status === 'INVALID'
    && !Object.hasOwn(market, 'availabilityEvidence')));

  const malformed = [
    { ...receiptGame('10:00', 'NO_PARSED_MARKETS'), availabilityEvidence: 'UNKNOWN' },
    { ...receiptGame('10:05', 'EXPLICIT_SOURCE_LOCK'), marketStatus: 'open' },
    receiptGame('10:10', 'EXPLICIT_SOURCE_LOCK', 'NOT_CAPTURED'),
    receiptGame('10:15', 'NO_PARSED_MARKETS', 'LOCKED'),
    { ...receiptGame('10:20', 'NO_PARSED_MARKETS'), markets: [true, false, false, false] },
  ];
  for (const game of malformed) await save(game);
  await save(receiptGame('10:25', 'EXPLICIT_SOURCE_LOCK'), 'MLB');
  result = await read('NBA');
  for (const raw of malformed) {
    const game = result.games.find(row => row.gameKey === raw.gameKey);
    assert.equal(game.receiptIntegrity.status, 'FAIL');
    assert.ok(game.receiptIntegrity.issues.includes('CAPTURE_AVAILABILITY_EVIDENCE_INVALID'));
    assert.ok(game.latestCaptureMarkets.every(market => market.status === 'INVALID'
      && !Object.hasOwn(market, 'availabilityEvidence')), 'invalid proof cannot reach a confirmed-lock label');
  }
  const otherLeague = (await read('MLB')).games[0];
  assert.ok(otherLeague.receiptIntegrity.issues.includes('CAPTURE_AVAILABILITY_EVIDENCE_INVALID'),
    'the NBA marker does not create a new baseball wire contract');

  // Simulate corruption only in the test database; the production query is
  // still read-only. Both adding and deleting proof must invalidate the hash.
  await db.query("UPDATE tai888_market_capture_receipts_v1 SET games=games #- '{0,availabilityEvidence}' WHERE receipt_id=$1", [ids[1]]);
  result = await read('NBA');
  assert.ok(find('09:05').receiptIntegrity.issues.includes('CAPTURE_RECEIPT_HASH_MISMATCH'));
  assert.ok(find('09:05').latestCaptureMarkets.every(market => market.status === 'INVALID'));
  await db.query("UPDATE tai888_market_capture_receipts_v1 SET games=jsonb_set(games,'{0,availabilityEvidence}','\"EXPLICIT_SOURCE_LOCK\"'::jsonb) WHERE receipt_id=$1", [ids[0]]);
  result = await read('NBA');
  assert.ok(find('09:00').receiptIntegrity.issues.includes('CAPTURE_RECEIPT_HASH_MISMATCH'));
  assert.ok(find('09:00').latestCaptureMarkets.every(market => market.status === 'INVALID'));
  console.log('PASS read-only PostgreSQL NBA receipt proof projection: legacy LOCKED unchanged without proof, explicit/no-price metadata, source hashes preserved, marker tampering and invalid/cross-league/status/price evidence rejected; NOT Production');
} finally { await db.close(); }
