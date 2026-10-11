import assert from 'node:assert/strict';
import { storeReaderSnapshot, loadReaderSnapshot, refreshReaderSnapshot } from '../lib/reader-store-v2.js';
import { readerDatabaseRequired } from '../lib/reader-database-store.js';

const previousVercel = process.env.VERCEL;
const previousMemoryOnly = process.env.READER_STORE_MEMORY_ONLY;
try {
  process.env.VERCEL = '1';
  process.env.READER_STORE_MEMORY_ONLY = 'true';
  assert.equal(readerDatabaseRequired({}), true, 'production must never acknowledge a region-local write');
} finally {
  if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
  if (previousMemoryOnly === undefined) delete process.env.READER_STORE_MEMORY_ONLY; else process.env.READER_STORE_MEMORY_ONLY = previousMemoryOnly;
}

// Two isolated regional clients sharing only the database, never Runtime Cache.
const database = new Map();
function region() {
  return async (strings, ...values) => {
    const query = strings.join('?');
    if (query.includes('CREATE TABLE')) return [];
    if (query.includes('INSERT INTO')) {
      const [league, date, observed, activity, checksum, serialized, expires] = values;
      const key = `${league}:${date}`, previous = database.get(key);
      if (previous && checksum !== previous.checksum && !(Date.parse(observed) > Date.parse(previous.payload.observedAt)
        && Date.parse(activity) >= Date.parse(previous.payload.pageActivityAt))) return [];
      const row = { checksum, payload: JSON.parse(serialized), expires };
      database.set(key, row); return [structuredClone(row)];
    }
    assert.match(query, /SELECT payload, checksum/);
    const [league, date] = values;
    return [...database.values()].filter(row => row.payload.league === league && (!date || row.payload.boardDate === date)
      && Date.parse(row.expires) > Date.now()).sort((a, b) => Date.parse(b.payload.observedAt) - Date.parse(a.payload.observedAt))
      .slice(0, 1).map(row => structuredClone(row));
  };
}
const tokyo = { sql: region() }, hongkong = { sql: region() };
const time = new Date().toISOString();
const snapshot = { league: 'CPBL', boardDate: '2026-10-11', observedAt: time, receivedAt: time, pageActivityAt: time,
  matchedGameCount: 1, unopenedGames: [], games: [{ league: 'CPBL', gamePk: 42, game: undefined, source: undefined, markets: [{ line: '1+50' }] }] };
assert.equal((await storeReaderSnapshot(snapshot, 43200, tokyo)).durable, true);
assert.deepEqual(await loadReaderSnapshot('CPBL', snapshot.boardDate, hongkong), snapshot);
assert.equal(await loadReaderSnapshot('CPBL', '2026-10-12', hongkong), null);
assert.equal(await loadReaderSnapshot('MLB', snapshot.boardDate, hongkong), null);
assert.deepEqual(await loadReaderSnapshot('CPBL', '', hongkong), snapshot);
const newer = { ...snapshot, observedAt: new Date(Date.parse(time) + 1000).toISOString(),
  pageActivityAt: new Date(Date.parse(time) + 1000).toISOString(), games: [{ ...snapshot.games[0], markets: [{ line: '2-50' }] }] };
await storeReaderSnapshot(newer, 43200, hongkong);
await assert.rejects(storeReaderSnapshot(snapshot, 43200, tokyo), /拒絕舊盤/);
assert.deepEqual(await loadReaderSnapshot('CPBL', snapshot.boardDate, tokyo), newer);
// Equal timestamps with changed quotes must not win; replay identical writes is safe.
await assert.rejects(storeReaderSnapshot({ ...newer, games: [] }, 43200, tokyo), /拒絕舊盤/);
await storeReaderSnapshot(newer, 43200, tokyo);
const heartbeat = await refreshReaderSnapshot(newer, { observedAt: new Date(Date.parse(time) + 2000).toISOString(),
  receivedAt: new Date(Date.parse(time) + 2000).toISOString(), pageActivityAt: new Date(Date.parse(time) + 2000).toISOString(), storeOptions: tokyo });
assert.equal(heartbeat.storage.durable, true);
assert.equal((await loadReaderSnapshot('CPBL', snapshot.boardDate, hongkong)).observedAt, heartbeat.snapshot.observedAt);
const bad = { sql: async () => { throw new Error('database offline'); } };
await assert.rejects(storeReaderSnapshot(newer, 43200, bad), /database offline/);
await assert.rejects(loadReaderSnapshot('CPBL', snapshot.boardDate, bad), /database offline/);
database.get('CPBL:2026-10-11').payload.games = [];
await assert.rejects(loadReaderSnapshot('CPBL', snapshot.boardDate, hongkong), /校驗/);
database.get('CPBL:2026-10-11').expires = '2000-01-01T00:00:00Z';
assert.equal(await loadReaderSnapshot('CPBL', snapshot.boardDate, hongkong), null);
console.log('PASS Reader cross-region database, date/league isolation, heartbeat, CAS, integrity, expiry and failure');
