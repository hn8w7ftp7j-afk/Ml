import assert from 'node:assert/strict';
process.env.READER_STORE_MEMORY_ONLY = 'true';

const {
  storeReaderSnapshot,
  loadReaderSnapshot,
  refreshReaderSnapshot,
  readerSnapshotStatus,
} = await import('../lib/reader-store-v2.js');

const oldObservedAt = '2026-08-12T00:00:00.000Z';
const oldPageActivityAt = '2026-08-11T23:59:50.000Z';
const newObservedAt = '2026-08-12T00:01:00.000Z';
const newPageActivityAt = '2026-08-12T00:00:30.000Z';
const receivedAt = '2026-08-12T00:01:01.000Z';
const snapshot = {
  boardDate: '2026-08-12',
  observedAt: oldObservedAt,
  receivedAt: oldObservedAt,
  pageActivityAt: oldPageActivityAt,
  readerVersion: '2.0.3',
  payloadHash: 'server-normalized-hash',
  rawBoardHash: 'a'.repeat(64),
  deviceId: 'device-12345678',
  sourceHost: 'www1.tai888.in',
  rawGameCount: 1,
  matchedGameCount: 1,
  games: [{
    gamePk: 1001,
    source: { observedAt: oldObservedAt, receivedAt: oldObservedAt, pageActivityAt: oldPageActivityAt },
    markets: [
      { market: '全場大小', pick: '大8平', water: 0.94, lineAsOf: oldPageActivityAt },
      { market: '全場大小', pick: '小8平', water: 0.94, lineAsOf: oldPageActivityAt },
    ],
  }],
};

await storeReaderSnapshot(snapshot);
const before = await loadReaderSnapshot('2026-08-12');
assert.equal(before.games[0].markets[0].lineAsOf, oldPageActivityAt);

const refreshedResult = await refreshReaderSnapshot(before, {
  observedAt: newObservedAt,
  receivedAt,
  pageActivityAt: newPageActivityAt,
  readerVersion: '2.0.3',
});
assert.equal(refreshedResult.storage.memory, true);
const refreshed = refreshedResult.snapshot;
assert.equal(refreshed.observedAt, newObservedAt);
assert.equal(refreshed.receivedAt, receivedAt);
assert.equal(refreshed.pageActivityAt, newPageActivityAt);
assert.equal(refreshed.payloadHash, 'server-normalized-hash');
assert.equal(refreshed.rawBoardHash, 'a'.repeat(64));
assert.equal(refreshed.games[0].source.observedAt, newObservedAt);
assert.equal(refreshed.games[0].source.receivedAt, receivedAt);
assert.equal(refreshed.games[0].source.pageActivityAt, newPageActivityAt);
assert.equal(refreshed.games[0].markets[0].lineAsOf, newPageActivityAt);
assert.equal(refreshed.games[0].markets[1].lineAsOf, newPageActivityAt);
assert.equal(readerSnapshotStatus(refreshed, Date.parse('2026-08-12T00:01:30Z')).fresh, true);

const persisted = await loadReaderSnapshot('2026-08-12');
assert.equal(persisted.games[0].markets[0].lineAsOf, newPageActivityAt);

await assert.rejects(() => refreshReaderSnapshot(refreshed, {
  observedAt: newObservedAt,
  receivedAt: '2026-08-12T00:01:02.000Z',
  pageActivityAt: newPageActivityAt,
}), error => error?.status === 409 && /重播/.test(error.message));

await assert.rejects(() => refreshReaderSnapshot(refreshed, {
  observedAt: '2026-08-12T00:01:10.000Z',
  receivedAt: '2026-08-12T00:01:11.000Z',
  pageActivityAt: '2026-08-12T00:00:20.000Z',
}), error => error?.status === 409);

await assert.rejects(() => refreshReaderSnapshot(refreshed, {
  observedAt: '2026-08-12T00:10:00.000Z',
  receivedAt: '2026-08-12T00:10:01.000Z',
  pageActivityAt: '2026-08-12T00:00:31.000Z',
}), error => error?.status === 409 && /過期/.test(error.message));

assert.equal(readerSnapshotStatus({
  ...refreshed,
  observedAt: '2026-08-12T00:10:00.000Z',
  receivedAt: '2026-08-12T00:10:01.000Z',
  pageActivityAt: '2026-08-12T00:00:30.000Z',
}, Date.parse('2026-08-12T00:10:01.000Z')).fresh, false);

console.log('Reader 2.0.3 heartbeat: page activity controls lineAsOf/freshness; replay, rollback and stale activity rejected');
