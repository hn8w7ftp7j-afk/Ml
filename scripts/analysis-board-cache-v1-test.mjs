import assert from 'node:assert/strict';
import {
  analysisBoardCacheKey,
  createAnalysisBoardCacheEntry,
  restoreAnalysisBoardCache,
  upsertAnalysisBoardCache,
} from '../lib/analysis-board-cache-v1.js';

const NOW = Date.parse('2026-08-23T11:00:00.000Z');
const board = [{
  game: { gamePk: 123, gameDate: '2026-08-23T10:00:00.000Z', away: 'Away', home: 'Home' },
  actualSource: { provider: 'TAI888_READER_AUTO' },
  readerPayloadHash: 'reader-hash',
  customMarkets: [{ market: '全場大小', pick: '大8+50', water: 0.94 }],
  customData: {
    context: { deliberatelyLargeAndStale: true },
    pitPersistence: { status: 'CONFIRMED', confirmed: true, snapshotId: 'MLB:123:FULL:hash' },
    analysis: {
      results: [{ market: '全場大小', pick: '大8+50', formulaDiagnosticScore: 7.8, modelEV: 0.032 }],
      directionSlots: [{ slotId: 'FULL_TOTAL_OVER', status: 'CALCULATED', modelEV: 0.032, robustEV: -0.004 }],
    },
  },
}];

const entry = createAnalysisBoardCacheEntry({ league: 'MLB', date: '2026-08-23', board, savedAt: NOW });
assert.equal(entry.board.length, 1);
assert.equal(entry.board[0].customData.context, undefined, 'volatile model context must not be persisted');
assert.equal(entry.board[0].customData.analysis.results[0].formulaDiagnosticScore, 7.8);
assert.equal(entry.board[0].customData.analysis.directionSlots[0].modelEV, 0.032, 'W必須通過手機續跑快取完整恢復');
assert.equal(entry.board[0].customData.analysis.directionSlots[0].robustEV, -0.004, 'R≤0不得在快取中隱藏W/R');
assert.equal(entry.board[0].customData.pitPersistence.confirmed, true, 'confirmed PIT persistence truth must survive mobile recovery');

const restored = restoreAnalysisBoardCache(entry, { league: 'MLB', date: '2026-08-23', now: NOW + 60_000 });
assert.equal(restored.length, 1, 'completed analysis must survive a mobile page reload');
assert.equal(restored[0].statusLabel, '已恢復上一版分析｜背景驗證中');
assert.equal(restored[0].customData.analysis.results[0].formulaDiagnosticScore, 7.8, 'restoring must preserve the visible score');
assert.deepEqual(restoreAnalysisBoardCache(entry, { league: 'KBO', date: '2026-08-23', now: NOW }), [], 'league caches must remain isolated');
assert.deepEqual(restoreAnalysisBoardCache(entry, { league: 'MLB', date: '2026-08-23', now: NOW + 73 * 60 * 60 * 1000 }), [], 'expired recovery data must not be restored');
assert.deepEqual(restoreAnalysisBoardCache({ ...entry, version: 1 }, { league: 'MLB', date: '2026-08-23', now: NOW }), [], 'pre-shared-distribution model snapshots must not survive the cache contract bump');
const legacyAsianEntry = { ...entry, version: 1, league: 'KBO' };
assert.deepEqual(restoreAnalysisBoardCache(legacyAsianEntry, { league: 'KBO', date: '2026-08-23', now: NOW }), [], 'pre-V11 Asian fallback scores must never be restored');
assert.deepEqual(restoreAnalysisBoardCache({ ...entry, version: 2 }, { league: 'MLB', date: '2026-08-23', now: NOW }), [], 'pre-V11 MLB advanced-policy snapshots must never be restored');
assert.deepEqual(restoreAnalysisBoardCache({ ...entry, version: 3 }, { league: 'MLB', date: '2026-08-23', now: NOW }), [], 'pre-W-first snapshots must never be restored');

const store = upsertAnalysisBoardCache({}, entry);
assert.equal(store[analysisBoardCacheKey('MLB', '2026-08-23')].board.length, 1);

console.log('analysis board cache: mobile reload recovery and league isolation PASS');
