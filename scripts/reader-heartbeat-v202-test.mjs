import assert from 'node:assert/strict';
process.env.READER_STORE_MEMORY_ONLY = 'true';

const {
  storeReaderSnapshot,
  loadReaderSnapshot,
  refreshReaderSnapshot,
  readerSnapshotStatus,
} = await import('../lib/reader-store-v2.js');

const oldObservedAt = '2026-08-12T00:00:00.000Z';
const newObservedAt = '2026-08-12T00:01:00.000Z';
const receivedAt = '2026-08-12T00:01:01.000Z';
const snapshot = {
  boardDate: '2026-08-12',
  observedAt: oldObservedAt,
  receivedAt: oldObservedAt,
  readerVersion: '2.0.2',
  payloadHash: 'server-normalized-hash',
  clientPayloadHash: 'a'.repeat(64),
  deviceId: 'device-12345678',
  sourceHost: 'www1.tai888.in',
  rawGameCount: 1,
  matchedGameCount: 1,
  games: [{
    gamePk: 1001,
    source: { observedAt: oldObservedAt, receivedAt: oldObservedAt },
    markets: [
      { market: '全場大小', pick: '大8平', water: 0.94, lineAsOf: oldObservedAt },
      { market: '全場大小', pick: '小8平', water: 0.94, lineAsOf: oldObservedAt },
    ],
  }],
};

await storeReaderSnapshot(snapshot);
const before = await loadReaderSnapshot('2026-08-12');
assert.equal(before.games[0].markets[0].lineAsOf, oldObservedAt);

const refreshedResult = await refreshReaderSnapshot(before, {
  observedAt: newObservedAt,
  receivedAt,
  readerVersion: '2.0.2',
});
assert.equal(refreshedResult.storage.memory, true);
const refreshed = refreshedResult.snapshot;
assert.equal(refreshed.observedAt, newObservedAt);
assert.equal(refreshed.receivedAt, receivedAt);
assert.equal(refreshed.payloadHash, 'server-normalized-hash');
assert.equal(refreshed.clientPayloadHash, 'a'.repeat(64));
assert.equal(refreshed.games[0].source.observedAt, newObservedAt);
assert.equal(refreshed.games[0].source.receivedAt, receivedAt);
assert.equal(refreshed.games[0].markets[0].lineAsOf, newObservedAt);
assert.equal(refreshed.games[0].markets[1].lineAsOf, newObservedAt);
assert.equal(readerSnapshotStatus(refreshed, Date.parse('2026-08-12T00:01:30Z')).fresh, true);

const persisted = await loadReaderSnapshot('2026-08-12');
assert.equal(persisted.games[0].markets[0].lineAsOf, newObservedAt);

console.log('Reader 2.0.2 heartbeat: unchanged price hash retained; observation and every market lineAsOf refreshed');
