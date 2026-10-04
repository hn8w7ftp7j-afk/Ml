// Exercises the actual SQL store with two independent module instances and an
// atomic SQL transport double. This is not a live PostgreSQL/Production test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalReaderPayload } from '../reader/parser.js';
import { normalizeNbaReaderPayload } from '../lib/nba/reader.js';
import { loadNbaReaderSnapshot, storeNbaReaderSnapshot } from '../lib/nba/reader-store.js';

const now = Date.now(); const deviceId = 'nba-reader-sql-fixture'; const boardDate = new Date(now).toISOString().slice(0, 10);
function snapshot(offset = 0, line = '220+50', activityOffset = offset) {
  const payload = { version: 'TAI888-READER-DOM-v2.2.0', readerVersion: '2.1.28', league: 'NBA', deviceId,
    sourceHost: 'tai888.in', pageUrl: 'https://tai888.in/newapp/#/BB', boardDate,
    observedAt: new Date(now - 2000 + offset).toISOString(), pageActivityAt: new Date(now - 3000 + activityOffset).toISOString(),
    expectedGameCount: 1, detectedGameCount: 1, parseIssues: [],
    games: [{ awayCode: 'GSW', homeCode: 'LAL', boardDate, boardTime: '07:00', marketStatus: 'open',
      fullRunline: null, fullTotal: { line, overWater: 0.95, underWater: 0.95 }, firstHalfRunline: null, firstHalfTotal: null }] };
  payload.payloadHash = createHash('sha256').update(canonicalReaderPayload(payload)).digest('hex');
  return normalizeNbaReaderPayload(payload, { now, deviceId });
}
const records = new Map(); const statements = [];
let heldTime = null; let release;
let gate = null;
function jsonbOrder(value) {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => b.localeCompare(a)).map(([key, item]) => [key, jsonbOrder(item)]));
  return value;
}
const sql = async (parts, ...values) => {
  const query = parts.join('?'); statements.push(query);
  assert(query.includes('sports_nba_reader_boards_v1'));
  if (query.startsWith('CREATE TABLE')) return [];
  if (query.startsWith('INSERT')) {
    assert.match(query, /ON CONFLICT \(board_date\) DO UPDATE/);
    assert.match(query, /WHERE EXCLUDED\.observed_at > sports_nba_reader_boards_v1\.observed_at/);
    assert.match(query, /AND EXCLUDED\.page_activity_at >= sports_nba_reader_boards_v1\.page_activity_at/);
    assert.match(query, /EXCLUDED\.source_hash = sports_nba_reader_boards_v1\.source_hash\s+OR EXCLUDED\.page_activity_at > sports_nba_reader_boards_v1\.page_activity_at/);
    const [date, observed, activity, hash, checksum, serialized] = values;
    if (observed === heldTime) await gate;
    const previous = records.get(date);
    const allowed = !previous || (Date.parse(observed) > Date.parse(previous.observed)
      && Date.parse(activity) >= Date.parse(previous.activity) && (hash === previous.hash || Date.parse(activity) > Date.parse(previous.activity)));
    if (!allowed) return [];
    const row = { observed, activity, hash, checksum, payload: jsonbOrder(JSON.parse(serialized)) }; records.set(date, row);
    return [structuredClone(row)];
  }
  if (query.startsWith('SELECT')) {
    const rows = values.length ? [records.get(values[0])].filter(Boolean) : [...records.values()].sort((a, b) => Date.parse(b.observed) - Date.parse(a.observed)).slice(0, 1);
    return rows.map(row => structuredClone(row));
  }
  throw Error('unexpected statement');
};

const old = snapshot(); const newer = snapshot(1000, '221+50');
const a = await import(`../lib/nba/reader-store.js?race=A-${now}`);
const b = await import(`../lib/nba/reader-store.js?race=B-${now}`);
heldTime = old.observedAt; gate = new Promise(resolve => { release = resolve; });
const olderWrite = a.storeNbaReaderSnapshot(old, { sql });
const olderResult = olderWrite.then(value => ({ value }), error => ({ error }));
const receipt = await b.storeNbaReaderSnapshot(newer, { sql });
assert.equal(receipt.durable, true); assert.equal(receipt.persisted, true); assert.equal(receipt.storage, 'database');
release(); const stale = await olderResult;
assert.equal(stale.error?.code, 'NBA_READER_REPLAY');
assert.equal((await loadNbaReaderSnapshot(boardDate, { sql })).games[0].fullTotal.line, '221+50');
assert.equal((await loadNbaReaderSnapshot('', { sql })).observedAt, newer.observedAt);
assert.equal(records.get(boardDate).payload.observedAt, newer.observedAt);

await assert.rejects(storeNbaReaderSnapshot(newer, { sql }), error => error.code === 'NBA_READER_REPLAY');
await assert.rejects(storeNbaReaderSnapshot(snapshot(1500, '222+50', 1000), { sql }), error => error.code === 'NBA_READER_REPLAY');
await assert.rejects(storeNbaReaderSnapshot(snapshot(1500, '221+50', 900), { sql }), error => error.code === 'NBA_READER_REPLAY');
assert.equal((await loadNbaReaderSnapshot(boardDate, { sql })).games[0].fullTotal.line, '221+50');

const unchanged = snapshot(1500, '221+50', 1000); const unchangedReceipt = await storeNbaReaderSnapshot(unchanged, { sql });
assert.equal(unchangedReceipt.durable, true);
records.get(boardDate).payload.games[0].fullTotal.line = '999+50';
await assert.rejects(loadNbaReaderSnapshot(boardDate, { sql }), error => error.code === 'NBA_READER_SNAPSHOT_INVALID');
const failed = async () => { throw Error('synthetic DB unavailable'); };
await assert.rejects(storeNbaReaderSnapshot(newer, { sql: failed }), error => error.code === 'NBA_READER_SAVE_FAILED');
const migration = readFileSync(new URL('../database/0011_nba_reader_boards.sql', import.meta.url), 'utf8');
assert(migration.includes('board_date TEXT PRIMARY KEY')); assert(migration.includes("payload->>'league' = 'NBA'"));
assert(statements.every(query => !/\b(?:DELETE|TRUNCATE|DROP)\b/.test(query)));
console.log('NBA Reader SQL transport-double: competing writers, atomic guard, DB authority, JSONB checksum, readback and failure isolation PASS (not live DB)');
