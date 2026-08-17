import assert from 'node:assert/strict';
const {
  storeReaderSnapshot,
  loadReaderSnapshot,
  readerSnapshotStatus,
  readerSnapshotPublicView,
} = await import('../lib/reader-store-v2.js');

delete process.env.READER_STORE_MEMORY_ONLY;
let writes = 0;
const failingCache = {
  async set() {
    writes += 1;
    if (writes === 2) throw new Error('latest pointer failed');
  },
};
const failedSnapshot = {
  league: 'MLB',
  boardDate: '2026-08-11',
  observedAt: '2026-08-11T00:00:10.000Z',
  receivedAt: '2026-08-11T00:00:11.000Z',
  pageActivityAt: '2026-08-11T00:00:09.000Z',
  matchedGameCount: 1,
  games: [{ gamePk: 11 }],
};
const failed = await storeReaderSnapshot(failedSnapshot, 3600, {
  runtimeCache: failingCache,
  requireRuntimeCache: true,
});
assert.equal(failed.writes.runtimeCache.date, true);
assert.equal(failed.writes.runtimeCache.latest, false);
assert.equal(failed.memory, false);
assert.equal(failed.allRequiredWritesSucceeded, false);

process.env.READER_STORE_MEMORY_ONLY = 'true';
assert.equal(await loadReaderSnapshot('MLB', '2026-08-11'), null);
const snapshot = {
  league: 'MLB',
  boardDate: '2026-08-12',
  observedAt: '2026-08-12T00:00:10.000Z',
  receivedAt: '2026-08-12T00:00:11.000Z',
  pageActivityAt: '2026-08-12T00:00:09.000Z',
  matchedGameCount: 15,
  games: [{ gamePk: 1 }],
};
const stored = await storeReaderSnapshot(snapshot);
assert.equal(stored.allRequiredWritesSucceeded, true);
assert.equal((await loadReaderSnapshot('MLB', '2026-08-12')).matchedGameCount, 15);
assert.equal(await loadReaderSnapshot('MLB', '2026-08-13'), null, 'exact-date lookup must never fall back to latest');
assert.equal(readerSnapshotStatus(await loadReaderSnapshot('MLB'), Date.parse('2026-08-12T00:00:30Z'), 'MLB').fresh, true);
assert.equal(readerSnapshotStatus({ ...snapshot, pageActivityAt: '2020-01-01T00:00:00Z' }, Date.now(), 'MLB').stale, true);

const staleAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const market = (name, pick) => ({
  market: name,
  pick,
  water: 0.95,
  waterEstimated: false,
  waterMissing: false,
  executable: true,
  lineAsOf: staleAt,
});
const staleComplete = {
  league: 'MLB',
  boardDate: '2099-01-01',
  observedAt: staleAt,
  receivedAt: staleAt,
  pageActivityAt: staleAt,
  freshnessTtlSeconds: 180,
  readerVersion: '2.0.3',
  sourceHost: 'www1.tai888.in',
  payloadHash: '1'.repeat(64),
  rawBoardHash: '2'.repeat(64),
  rawGameCount: 1,
  matchedGameCount: 1,
  scheduleGameCount: 1,
  unmatched: [],
  games: [{
    league: 'MLB',
    gamePk: 20990101,
    game: { gamePk: 20990101, league: 'MLB' },
    source: { league: 'MLB' },
    markets: [
      market('全場讓分', '客隊讓1平'), market('全場讓分', '主隊受讓1平'),
      market('全場大小', '大8平'), market('全場大小', '小8平'),
      market('上半讓分', '客隊讓0.5'), market('上半讓分', '主隊受讓0.5'),
      market('上半大小', '大4平'), market('上半大小', '小4平'),
    ],
  }],
};
await storeReaderSnapshot(staleComplete);
const statusPayload = readerSnapshotPublicView(await loadReaderSnapshot('MLB', '2099-01-01'), { complete: true, league: 'MLB' });
assert.equal(statusPayload.stale, true);
assert.equal(statusPayload.executable, false);
assert.equal(statusPayload.payloadHash, null);
assert.equal(statusPayload.rawBoardHash, null);
assert.equal(statusPayload.matchedGameCount, 0);
assert.equal(statusPayload.sourceHost, null);
const freshPayload = readerSnapshotPublicView(staleComplete, {
  complete: true,
  now: Date.parse(staleAt) + 30_000,
  league: 'MLB',
});
assert.equal(freshPayload.executable, true);
assert.equal(freshPayload.payloadHash, staleComplete.payloadHash);
assert.equal(freshPayload.matchedGameCount, 1);
console.log('reader store v2: exact-date isolation and fail-closed write ordering ok');
