import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { normalizeTai888ReaderPayload } from '../lib/tai888-reader-parser-v2.js';
import { loadReaderDatabase, storeReaderDatabase } from '../lib/reader-database-store.js';
import { parseReaderLegacyHistoryQuery, readReaderLegacyHistory, READER_LEGACY_HISTORY_MAX_BYTES,
  READER_LEGACY_HISTORY_FLAGS } from '../lib/reader-legacy-history.js';

const now = Date.parse('2026-11-09T08:00:00.000Z');
const parse = query => parseReaderLegacyHistoryQuery(new URLSearchParams(query));
const scope = parse('league=MLB&from=2026-11-01&through=2026-11-30');
const detailScope = parse('view=detail&league=MLB&date=2026-11-01');
for (const query of ['', 'league=NBA&from=2026-11-01&through=2026-11-30',
  'league=KBO&from=2026-11-01&through=2026-11-30', 'league=MLB&from=2026-02-30&through=2026-03-01',
  'league=MLB&from=2026-11-30&through=2026-11-01', 'league=MLB&from=2026-10-01&through=2026-11-01',
  'league=MLB&league=NPB&from=2026-11-01&through=2026-11-30', 'league=MLB&from=2026-11-01&through=2026-11-30&expired=1',
  'league=MLB&from=2026-11-01&through=2026-11-30&view=', 'view=detail&league=MLB&date=2026-11-01&from=2026-11-01',
  'view=detail&league=MLB&date=2026-11-01&date=2026-11-02', 'view=constructor&league=MLB&date=2026-11-01',
  '__proto__=true&league=MLB&from=2026-11-01&through=2026-11-30']) {
  // An explicitly empty view is the same default inventory, not a bypass.
  if (query.endsWith('&view=')) { assert.equal(parse(query).view, 'inventory'); continue; }
  assert.throws(() => parse(query), error => error.status === 400);
}
assert.equal(parse('league=CPBL&from=2026-10-01&through=2026-10-31').through, '2026-10-31');

const raw = { version: 'TAI888-READER-DOM-v2.0.3', readerVersion: '2.0.3 FINAL MULTIFRAME VERIFIED', league: 'MLB',
  sourceHost: 'www1.tai888.in', pageUrl: 'https://www1.tai888.in/newapp/#/BS', boardDate: '2026-11-01',
  observedAt: '2026-10-31T22:30:00.000Z', pageActivityAt: '2026-10-31T22:29:45.000Z',
  expectedGameCount: 2, detectedGameCount: 2, payloadHash: '0'.repeat(64), games: [
    { awayCode: 'PIT', homeCode: 'MIA', boardDate: '2026-11-01', boardTime: '06:40',
      fullRunline: { lineSide: 'away', line: '1+85', awayWater: .95, homeWater: .91, rawRows: ['1+85 0.950', '0.910'] },
      fullTotal: { line: '7-10', overWater: .49, underWater: 1.83 },
      first5Runline: { lineSide: 'home', line: '0-15', awayWater: .94, homeWater: .92 },
      first5Total: { line: '3.5', overWater: .93, underWater: .90 } },
    { awayCode: 'CLE', homeCode: 'DET', boardDate: '2026-11-01', boardTime: '06:40', marketStatus: 'locked',
      fullRunline: null, fullTotal: null, first5Runline: null, first5Total: null },
  ] };
const schedule = [
  { gamePk: 1, awayTeamId: 134, homeTeamId: 146, away: '匹茲堡海盜', home: '邁阿密馬林魚', gameDate: '2026-10-31T22:40:00Z' },
  { gamePk: 2, awayTeamId: 114, homeTeamId: 116, away: '克里夫蘭守護者', home: '底特律老虎', gameDate: '2026-10-31T22:40:00Z' },
];
const snapshot = normalizeTai888ReaderPayload(raw, schedule, { league: 'MLB', deviceId: 'private-legacy-device',
  receivedAt: '2026-10-31T22:30:30.000Z' });
const poison = 'private-arbitrary-field-must-not-be-returned';
snapshot.privateToken = poison; snapshot.games[0].privateField = poison;
snapshot.games[0].markets[0].privateField = poison;
const db = new PGlite(), statements = [];
const writeSql = async (parts, ...params) => (await db.query(parts.reduce((text, part, i) => text + (i ? `$${i}` : '') + part, ''), params)).rows;
const sql = { query: async (text, params) => { statements.push({ text, params }); return (await db.query(text, params)).rows; } };
const read = (query = scope, extra = {}) => readReaderLegacyHistory(query, { sql, now, ...extra });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
async function replace(payload, checksum = hash(payload)) {
  await db.query('UPDATE sports_baseball_reader_boards_v1 SET payload=$1,checksum=$2 WHERE league=$3 AND board_date=$4',
    [JSON.stringify(payload), checksum, 'MLB', '2026-11-01']);
}
const assertFlags = result => { for (const [key, value] of Object.entries(READER_LEGACY_HISTORY_FLAGS)) assert.equal(result[key], value, key); };
try {
  // Model a retained legacy table without newer CHECK constraints so the
  // forensic reader must independently reject identity drift after hashing.
  await db.exec(`CREATE TABLE sports_baseball_reader_boards_v1 (
    league text, board_date text, observed_at timestamptz, page_activity_at timestamptz,
    checksum text, payload jsonb, expires_at timestamptz, PRIMARY KEY(league,board_date))`);
  await storeReaderDatabase(snapshot, 43200, { sql: writeSql });
  await db.query(`UPDATE sports_baseball_reader_boards_v1 SET expires_at='2026-11-01T10:30:30.123456Z'`);
  const original = (await db.query('SELECT * FROM sports_baseball_reader_boards_v1')).rows;
  assert.equal(await loadReaderDatabase('MLB', '2026-11-01', { sql: writeSql }), null,
    'the live Reader loader must still exclude the expired snapshot');
  const inventory = await read();
  assertFlags(inventory); assert.equal(inventory.status, 'RETAINED_MUTABLE_SNAPSHOTS'); assert.equal(inventory.count, 1);
  assert.equal(inventory.records[0].expired, true); assert.equal(inventory.records[0].detailAvailable, true);
  assert.equal(inventory.records[0].expiresAt, '2026-11-01T10:30:30.123456Z');
  assert.equal(inventory.records[0].integrity.status, 'NOT_CHECKED');
  assert.equal(Object.hasOwn(inventory.records[0], 'payload'), false);
  assert.ok(statements.every(row => !/,payload\s+FROM/.test(row.text)), 'inventory never selects the complete payload');
  const detail = await read(detailScope); assertFlags(detail);
  assert.equal(detail.status, 'RETAINED_MUTABLE_SNAPSHOT'); assert.equal(detail.record.integrity.status, 'PASS');
  assert.equal(detail.record.observedAt, '2026-10-31T22:30:00.000000Z');
  assert.equal(detail.record.receivedAt, snapshot.receivedAt); assert.equal(detail.record.games.length, 2);
  assert.deepEqual(detail.record.games[0].markets.map(({ market, pick, water, lineAsOf, rawText }) => ({ market, pick, water, lineAsOf, rawText })),
    snapshot.games[0].markets.map(({ market, pick, water, lineAsOf, rawText }) => ({ market, pick, water, lineAsOf, rawText })));
  assert.equal(detail.record.games[1].markets.length, 0);
  assert.equal(detail.record.games[1].marketStatus, 'locked', 'legacy status is retained without claiming an explicit source lock');
  const json = JSON.stringify(detail);
  for (const value of [poison, snapshot.deviceId, 'deviceId', 'pageUrl', 'privateField', 'privateToken']) assert.equal(json.includes(value), false);
  assert.ok(statements.every(({ text }) => /^\s*SELECT\b/.test(text) && !/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/.test(text)));
  assert.deepEqual((await db.query('SELECT * FROM sports_baseball_reader_boards_v1')).rows, original, 'all forensic reads preserve the source row and expiry');

  const empty = await read(parse('league=CPBL&from=2026-11-01&through=2026-11-30'));
  const emptyDetail = await read(parse('view=detail&league=NPB&date=2026-11-01'));
  for (const value of [empty, emptyDetail]) { assertFlags(value); assert.equal(value.status, 'NO_RETAINED_ROWS'); assert.equal(value.count, 0); }
  assert.deepEqual(empty.records, []); assert.equal(emptyDetail.record, null);
  assert.equal((await read(parse('league=MLB&from=2026-11-02&through=2026-11-30'))).count, 0);
  writeFileSync(join(tmpdir(), 'reader-legacy-history-contract-fixtures.json'), JSON.stringify({ inventory, detail, empty, emptyDetail }));
  await db.query(`UPDATE sports_baseball_reader_boards_v1 SET expires_at='2026-11-09T08:00:00.000001Z'`);
  assert.equal((await read()).records[0].expired, false, 'submillisecond expiry evidence is compared without millisecond truncation');
  await db.query(`UPDATE sports_baseball_reader_boards_v1 SET expires_at='2026-11-01T10:30:30.123456Z'`);

  const tooLarge = { ...snapshot, padding: 'x'.repeat(READER_LEGACY_HISTORY_MAX_BYTES) };
  await replace(tooLarge); statements.length = 0;
  assert.equal((await read()).records[0].detailAvailable, false);
  const before = statements.length;
  await assert.rejects(() => read(detailScope), error => error.status === 413);
  assert.equal(statements.length, before + 1, 'oversize evidence is rejected before selecting payload');
  const unknown = { ...snapshot, version: 'TAI888-READER-PARSER-v999.0.0' };
  await replace(unknown); statements.length = 0;
  assert.equal((await read()).records[0].detailAvailable, false);
  await assert.rejects(() => read(detailScope), error => error.code === 'LEGACY_READER_SCHEMA_UNSUPPORTED');
  assert.ok(statements.every(({ text }) => !/,payload\s+FROM/.test(text)));

  const tampered = structuredClone(snapshot); tampered.games[0].markets[0].water = 1.01;
  await replace(tampered, hash(snapshot));
  await assert.rejects(() => read(detailScope), error => error.code === 'LEGACY_READER_CHECKSUM_INVALID');
  for (const change of [
    value => { value.league = 'NPB'; }, value => { value.boardDate = '2026-11-02'; },
    value => { value.games[0].source.league = 'NPB'; }, value => { value.games[0].game.gamePk = 99; },
    value => { value.games[0].game.gameDate = '2026-11-01T22:40:00Z'; },
    value => { value.games[0].readerMeta.boardDate = '2026-11-02'; },
    value => { value.games[0].markets[0].water = null; }, value => { value.games[0].markets[0].water = '0.950'; },
    value => { value.games[0].markets[0].waterEstimated = true; }, value => { value.games[0].markets[0].market = 'NBA半場'; },
    value => { value.games[0].markets[0].lineAsOf = '2026-11-02T00:00:00Z'; },
    value => { value.games[0].markets.pop(); }, value => { value.games.push(structuredClone(value.games[0])); },
    value => { value.receivedAt = '2026-02-30T00:00:00Z'; }, value => { value.pageActivityAt = '2026-10-31T22:30:01Z'; },
  ]) {
    const invalid = structuredClone(snapshot); change(invalid); await replace(invalid);
    await assert.rejects(() => read(detailScope), error => error.status === 409);
  }
  await replace(snapshot); let readNumber = 0;
  const racing = { query: async (text, params) => {
    if (++readNumber === 2) { const changed = structuredClone(snapshot); changed.games[0].markets[0].water = 1.1; await replace(changed); }
    return sql.query(text, params);
  } };
  await assert.rejects(() => read(detailScope, { sql: racing }), error => error.code === 'LEGACY_READER_SOURCE_CHANGED');
  await replace(snapshot);
  const absent = new PGlite();
  try { await assert.rejects(() => read(scope, { sql: { query: async (text, params) => (await absent.query(text, params)).rows } }),
    error => error.code === 'LEGACY_READER_TABLE_NOT_PRESENT' && error.status === 503); }
  finally { await absent.close(); }
  await assert.rejects(() => read(scope, { sql: { query: async () => { throw Error('private-connection-secret'); } } }));
  assert.equal(await loadReaderDatabase('MLB', '2026-11-01', { sql: writeSql }), null, 'diagnostic reads never renew the live expiry');
  const source = readFileSync(new URL('../lib/reader-legacy-history.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:initialize\w*|ensureSchema|storeReader\w*)\s*\(|INSERT INTO|UPDATE sports|DELETE FROM|CREATE TABLE/);
} finally { await db.close(); }
console.log('PASS retained Reader cache forensic reads: real PostgreSQL expired/live isolation, metadata-before-payload budget, unchanged original quote strings/times/expiry, canonical JSONB checksum, schema/identity/league/date/tamper/race guards, bounded readonly SELECT and redaction; NOT Production');
