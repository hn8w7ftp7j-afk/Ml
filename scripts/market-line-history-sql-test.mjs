// Optional actual PostgreSQL-engine test. Supply the official PGlite package's
// dist/index.js path; no Production credentials, network or database is used.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { buildMarketLineHistoryRows, recordMarketLineHistory } from '../lib/market-line-history-v1.js';
import { parseMarketLineHistoryQuery, queryMarketLineHistory } from '../lib/market-line-history-query.js';

if (!process.argv[2]) throw new Error('Supply an installed @electric-sql/pglite dist/index.js path');
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const sql = (strings, ...values) => {
  const query = strings.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
  return { query, values,
    then(resolve, reject) { return db.query(query, values).then(result => result.rows).then(resolve, reject); },
    catch(reject) { return this.then(undefined, reject); },
  };
};
sql.transaction = queries => db.transaction(async transaction => {
  const results = [];
  for (const query of queries) results.push((await transaction.query(query.query, query.values)).rows);
  return results;
});

const capture = (time, water = 0.94) => ({ league: 'MLB', boardDate: '2026-10-06', pageActivityAt: `2026-10-06T12:${time}.000Z`,
  readerVersion: '2.1.31', rawBoardHash: 'a'.repeat(64),
  games: [{ gamePk: 777, markets: [{ market: '全場讓分', pick: 'NYY讓1+60', water },
    { market: '全場讓分', pick: 'BOS受讓1+60', water: 1.06 }] }] });
try {
  // Exercise the lossless migration from the existing Production v1 key.
  await db.exec(`CREATE TABLE tai888_market_line_history_v1 (
    league VARCHAR(5) NOT NULL, board_date DATE NOT NULL, game_key VARCHAR(80) NOT NULL, game_pk BIGINT,
    observed_at TIMESTAMPTZ NOT NULL, state_hash CHAR(16) NOT NULL, markets TEXT NOT NULL,
    source_hash CHAR(32), reader_version VARCHAR(20), PRIMARY KEY (league, game_key, observed_at));`);
  const original = buildMarketLineHistoryRows(capture('00:00'))[0];
  await db.query('INSERT INTO tai888_market_line_history_v1 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', Object.values(original));
  const write = snapshot => recordMarketLineHistory(snapshot, { sql });
  assert.deepEqual(await write(capture('01:00')), { configured: true, checked: 1, inserted: 0, unchanged: 1, failed: 0 });
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM tai888_market_line_history_v1')).rows[0].count, 1);
  const definition = (await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='tai888_market_line_history_v1'::regclass AND contype='p'")).rows[0].definition;
  assert.equal(definition, 'PRIMARY KEY (league, board_date, game_key, observed_at)');
  assert.equal((await write(capture('02:00', 0.98))).inserted, 1);
  assert.equal((await write(capture('02:00', 0.98))).unchanged, 1);
  const conflict = await write(capture('02:00', 1.02));
  assert.equal(conflict.failed, 1); assert.equal(conflict.unchanged, 0);
  assert.equal((await write(capture('01:30', 0.96))).inserted, 1, 'late distinct captured state is not discarded because a newer state exists');
  const concurrent = await Promise.all([write(capture('03:00', 1.01)), write(capture('03:01', 1.01))]);
  assert.equal(concurrent.reduce((sum, row) => sum + row.inserted, 0), 1, 'serialized same-state writers retain change-only storage');
  const nba = date => ({ league: 'NBA', boardDate: date, pageActivityAt: '2026-10-06T12:05:00.000Z', games: [{
    boardTime: '19:30', awayCode: 'LAL', homeCode: 'GSW', fullTotal: { line: '224-50', overWater: 0.964, underWater: 0.936 } }] });
  assert.equal((await write(nba('2026-10-06'))).inserted, 1);
  assert.equal((await write(nba('2026-10-07'))).inserted, 1, 'same NBA key and observedAt on different board dates remain independent');

  const queryOptions = { secret: 'synthetic-cursor-secret', now: Date.parse('2026-10-08T00:00:00.000Z') };
  const first = await queryMarketLineHistory(parseMarketLineHistoryQuery(new URLSearchParams({ limit: '2' }), queryOptions), { sql });
  assert.equal(first.totals.savedStates, 6); assert.equal(first.totals.gameDateKeys, 3); assert.equal(first.rows.length, 2);
  const seen = [...first.rows]; let page = first;
  while (page.hasMore) {
    page = await queryMarketLineHistory(parseMarketLineHistoryQuery(new URLSearchParams({ limit: '2', after: page.nextAfter }), queryOptions), { sql });
    seen.push(...page.rows);
  }
  assert.equal(seen.length, 6); assert.ok(seen.every(row => row.integrity.ok));
  const nbaRead = await queryMarketLineHistory(parseMarketLineHistoryQuery(new URLSearchParams({ league: 'NBA' }), queryOptions), { sql });
  assert.equal(nbaRead.rows.length, 2); assert.equal(nbaRead.rows[0].markets[1].directions[0].pick, '大224-50');
  assert.equal(nbaRead.rows[0].markets[1].directions[0].water, 0.964);
  const empty = await queryMarketLineHistory(parseMarketLineHistoryQuery(new URLSearchParams({ league: 'CPBL' }), queryOptions), { sql });
  assert.equal(empty.totals.savedStates, 0); assert.equal(empty.coverageComplete, false);
  console.log('PostgreSQL-engine history test PASS: lossless date-key migration, actual SQL insert/dedup/conflict/late state, serialized writes, totals and cursor pagination; NOT Production');
} finally { await db.close(); }
