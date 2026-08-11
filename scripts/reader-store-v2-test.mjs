import assert from 'node:assert/strict';
process.env.READER_STORE_MEMORY_ONLY = 'true';
const { storeReaderSnapshot, loadReaderSnapshot, readerSnapshotStatus } = await import('../lib/reader-store-v2.js');
const snapshot = { boardDate: '2026-08-12', receivedAt: new Date().toISOString(), matchedGameCount: 15, games: [{ gamePk: 1 }] };
await storeReaderSnapshot(snapshot);
assert.equal((await loadReaderSnapshot('2026-08-12')).matchedGameCount, 15);
assert.equal(readerSnapshotStatus(await loadReaderSnapshot()).fresh, true);
assert.equal(readerSnapshotStatus({ ...snapshot, receivedAt: '2020-01-01T00:00:00Z' }).stale, true);
console.log('reader store v2: ok');
