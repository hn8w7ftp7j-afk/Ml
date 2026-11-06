import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { canonicalReaderPayload } from '../reader/parser.js';
import { buildReaderCaptureArchive, READER_CAPTURE_ARCHIVE_SCHEMA as schema } from '../lib/reader-capture-archive.js';
import { parseReaderArchiveQuery, queryReaderCaptureArchives } from '../lib/reader-capture-archive-query.js';

const db = new PGlite(), statements = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const now = Date.parse('2026-11-06T10:00:00.000Z'), until = new Date(now).toISOString();
const parse = fields => parseReaderArchiveQuery(new URLSearchParams({ view: 'records', ...fields }), { now, secret: 'archive-query-fixture-secret' });
const sql = async (parts, ...values) => {
  const statement = parts.reduce((out, part, index) => out + (index ? `$${index}` : '') + part, '');
  assert.doesNotMatch(statement, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  statements.push({ statement, values });
  return (await db.query(statement, values)).rows;
};
const read = query => queryReaderCaptureArchives(query, { sql });
function payload(index, league = 'NBA') {
  const original = { version: 'TAI888-READER-DOM-v2.2.0', league, sourceHost: 'tai888.in', pageUrl: 'https://tai888.in/newapp/#/BB',
    boardDate: index < 80 ? '2026-11-05' : '2026-11-06', observedAt: `2026-11-05T01:${String(index % 60).padStart(2, '0')}:00.000Z`,
    pageActivityAt: `2026-11-05T01:${String(index % 60).padStart(2, '0')}:00.000Z`, readerVersion: '2.1.54',
    expectedGameCount: 1, detectedGameCount: 1, parseIssues: [], games: [{ awayCode: index % 2 ? 'LAL' : 'BOS', homeCode: 'GSW',
      boardDate: index < 80 ? '2026-11-05' : '2026-11-06', boardTime: '08:05', marketStatus: 'open',
      fullRunline: { lineSide: 'home', line: `${index + 1}+50`, awayWater: 0.95, homeWater: 0.94 },
      fullTotal: { line: '224-50', overWater: 0.93, underWater: 0.92 }, firstHalfRunline: null, firstHalfTotal: null }] };
  original.payloadHash = hash(canonicalReaderPayload(original));
  return buildReaderCaptureArchive({ schema, payload: original }, { deviceId: 'archive-query-fixture', headerVersion: '2.1.54', now }).payload;
}
try {
  await db.exec(`CREATE TABLE sports_reader_capture_archive_v1 (
    capture_id char(64) PRIMARY KEY,schema_version text,league text,board_date date,source_observed_at timestamptz,page_activity_at timestamptz,
    payload_hash char(64),payload_json text,checksum char(64),reader_version text,received_at timestamptz,persisted_at timestamptz);`);
  const fixtures = [];
  for (let index = 0; index < 103; index++) {
    const saved = payload(index), serialized = JSON.stringify(saved);
    const captureId = hash(JSON.stringify([schema, saved.league, saved.boardDate, saved.observedAt, saved.pageActivityAt, saved.payloadHash]));
    fixtures.push({ captureId, payload: saved });
    // Many rows share an exact microsecond timestamp: capture ID is the required tie-break.
    const persistedAt = index === 102 ? '2026-11-06T10:00:00.000001Z' : `2026-11-06T09:00:00.${index < 50 ? '000001' : '000002'}Z`;
    await db.query('INSERT INTO sports_reader_capture_archive_v1 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [captureId, schema, saved.league, saved.boardDate, saved.observedAt, saved.pageActivityAt, saved.payloadHash,
        serialized, hash(serialized), saved.readerVersion, '2026-11-06T08:00:00Z', persistedAt]);
  }
  let page = await read(parse({ until, limit: '25' })), collected = [...page.records], pages = 1;
  assert.equal(page.totalCount, 102); assert.equal(page.productionWrites, false); assert.equal(page.historicalAvailabilityVerified, false);
  assert.ok(page.records.every(row => row.integrity.status === 'NOT_VERIFIED' && !Object.hasOwn(row, 'payload')));
  const first = page;
  while (page.hasMore) {
    page = await read(parse({ after: page.nextAfter, limit: '25' })); collected.push(...page.records); pages++;
    assert.equal(page.totalCount, 102); assert.equal(page.until, until);
  }
  assert.equal(pages, 5); assert.equal(collected.length, 102); assert.equal(new Set(collected.map(row => row.captureId)).size, 102);
  assert.equal(page.nextAfter, null);
  const sorted = (await db.query('SELECT trim(capture_id) AS id FROM sports_reader_capture_archive_v1 WHERE persisted_at<=$1::timestamptz ORDER BY persisted_at,capture_id', [until])).rows.map(row => row.id);
  assert.deepEqual(collected.map(row => row.captureId), sorted);
  assert.ok(collected.every(row => row.persistedAt.endsWith('000001Z') || row.persistedAt.endsWith('000002Z')));
  const oneDay = await read(parse({ date: '2026-11-05', limit: '50' })); assert.equal(oneDay.totalCount, 80);
  const game = await read(parse({ league: 'NBA', gameKey: '08:05|LAL|GSW', limit: '50' })); assert.equal(game.totalCount, 51);
  assert.ok(game.records.every(row => row.games[0].away === 'LAL'));
  const empty = await read(parse({ league: 'EPL' })); assert.equal(empty.totalCount, 0); assert.equal(empty.records.length, 0);
  const detail = await read(parseReaderArchiveQuery(new URLSearchParams({ captureId: fixtures[0].captureId })));
  assert.equal(detail.record.integrity.status, 'PASS'); assert.equal(detail.record.payload.games[0].fullRunline.line, '1+50');
  assert.equal(detail.record.payload.games[0].fullTotal.line, '224-50');
  await assert.rejects(read({ captureId: 'f'.repeat(64) }), error => error.status === 404);
  const changedPayload = { ...fixtures[0].payload, accountToken: 'never-expose-unrelated-data' };
  const changedJson = JSON.stringify(changedPayload);
  await db.query('UPDATE sports_reader_capture_archive_v1 SET payload_json=$1,checksum=$2 WHERE capture_id=$3', [changedJson, hash(changedJson), fixtures[0].captureId]);
  const allowlisted = await read({ captureId: fixtures[0].captureId });
  assert.equal(allowlisted.record.integrity.status, 'PASS'); assert.equal(JSON.stringify(allowlisted).includes('never-expose-unrelated-data'), false);
  const invalidReparse = structuredClone(fixtures[0].payload);
  invalidReparse.games[0].fullRunline.rawRows = ['99+50 0.950', '0.940'];
  const invalidJson = JSON.stringify(invalidReparse);
  assert.equal(hash(canonicalReaderPayload(invalidReparse)), fixtures[0].payload.payloadHash);
  await db.query('UPDATE sports_reader_capture_archive_v1 SET payload_json=$1,checksum=$2 WHERE capture_id=$3', [invalidJson, hash(invalidJson), fixtures[0].captureId]);
  const badReparse = await read({ captureId: fixtures[0].captureId });
  assert.equal(badReparse.record.integrity.status, 'FAIL', 'a sport-only reparse failure cannot retain a previous true hash result');
  assert.equal(badReparse.record.payload, null);
  await db.query("UPDATE sports_reader_capture_archive_v1 SET checksum='0000000000000000000000000000000000000000000000000000000000000000' WHERE capture_id=$1", [fixtures[0].captureId]);
  const corrupt = await read({ captureId: fixtures[0].captureId }); assert.equal(corrupt.record.integrity.status, 'FAIL'); assert.equal(corrupt.record.payload, null);
  await db.query('UPDATE sports_reader_capture_archive_v1 SET payload_json=$1 WHERE capture_id=$2', [JSON.stringify({ ...fixtures[0].payload, games: {} }), fixtures[0].captureId]);
  const badShapePage = await read(parse({ limit: '50' }));
  assert.equal(badShapePage.totalCount, 102);
  let shapeRows = badShapePage.records;
  let shapePage = badShapePage;
  while (shapePage.hasMore) { shapePage = await read(parse({ limit: '50', after: shapePage.nextAfter })); shapeRows.push(...shapePage.records); }
  assert.deepEqual(shapeRows.find(row => row.captureId === fixtures[0].captureId).games, [], 'non-array game evidence cannot hide other archives from the list');
  for (const fields of [{ view: 'x' }, { league: 'NHL' }, { league: 'nba' }, { date: '2026-02-30' }, { from: '2026-11-06', through: '2026-11-05' },
    { date: '2026-11-06', from: '2026-11-06' }, { limit: '0' }, { limit: '51' }, { limit: '01' }, { until: '2026-11-07T00:00:00.000Z' },
    { gameKey: '' }, { unknown: 'x' }, { after: 'bad' }, { league: 'NBA', after: first.nextAfter }, { captureId: fixtures[0].captureId }]) assert.throws(() => parse(fields));
  const tampered = first.nextAfter.slice(0, -1) + (first.nextAfter.endsWith('a') ? 'b' : 'a');
  assert.throws(() => parse({ after: tampered }));
  assert.throws(() => parseReaderArchiveQuery(new URLSearchParams('view=records&view=records'), { now, secret: 'fixture' }));
  const injection = "08:05|';DROP TABLE x;--|GSW";
  assert.equal((await read(parse({ gameKey: injection }))).totalCount, 0);
  assert.ok(statements.at(-1).values.includes(injection)); assert.ok(!statements.at(-1).statement.includes(injection));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_reader_capture_archive_v1')).rows[0].n, 103);
  console.log('PASS archive query: actual PostgreSQL read-only bounded pages, all same-microsecond rows, signed filter/cutoff cursors, raw game filters, verified sport-only single payload, exact credit/water preservation and honest corruption/not-found; Production NOT VERIFIED');
} finally { await db.close(); }
