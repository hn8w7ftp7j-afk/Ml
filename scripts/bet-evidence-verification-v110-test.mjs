import assert from 'node:assert/strict';
import { verifyCloudBetEvidenceV110 } from '../lib/bet-evidence-verification-v110.js';
import { buildAnalysisPitReplayBundle, buildAnalysisPitSnapshotRecord } from '../lib/analysis-pit-snapshot-store-v1.js';
import { signMarketRow } from '../lib/market-integrity-v1.js';
import { readerGameMarketContentHash } from '../lib/reader-market-revision-v110.js';
import { isDatabaseError } from '../lib/database-error.js';

process.env.MARKET_INTEGRITY_SECRET = 'bet-evidence-v110-test-secret';

const now = Date.parse('2026-08-25T08:00:00.000Z');
const inputHash = 'b'.repeat(64);
const game = {
  league: 'MLB', leagueId: 'MLB', gamePk: 123, gameDate: '2026-08-25T10:00:00.000Z',
  officialDate: '2026-08-25', gameNumber: 1, awayTeamId: 1, homeTeamId: 2, away: '客隊', home: '主隊',
};
const market = {
  market: '全場大小', pick: '大8+50', water: 0.94,
  sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', executable: true,
  readerPayloadHash: 'a'.repeat(64), readerRawBoardHash: 'c'.repeat(64), readerBoardDate: '2026-08-25',
  lineAsOf: '2026-08-25T07:59:30.000Z',
};
market.readerGameMarketHash = readerGameMarketContentHash([market]);
const signedMarket = await signMarketRow('MLB', game, market);
const snapshot = {
  league: 'MLB', boardDate: '2026-08-25', payloadHash: 'a'.repeat(64), rawBoardHash: 'c'.repeat(64),
  pageActivityAt: '2026-08-25T07:59:30.000Z', matchedGameCount: 1, scheduleGameCount: 1,
  games: [{ league: 'MLB', gamePk: 123, game, markets: [market] }],
};
const versions = {
  modelVersion: 'model-v11', rulesVersion: 'rules-v11', dataVersion: 'data-v11',
  scoreFormulaVersion: 'score-v11', settlementRuleVersion: 'settlement-v11', uncertaintySetVersion: 'uncertainty-v11',
};
const frozenContext = {
  leagueId: 'MLB', game, fetchedAt: '2026-08-25T07:58:00.000Z',
  modelVersion: versions.modelVersion, rulesVersion: versions.rulesVersion, dataVersion: versions.dataVersion,
  featureProvenance: [],
};
const distributionSnapshot = {
  distributionId: 'distribution-123', distributionHash: 'e'.repeat(64), gamePk: game.gamePk,
  scenarios: [{ id: 'central', weight: 1, cells: [{ awayRuns: 4, homeRuns: 4, probability: 1 }] }],
};
const analysis = {
  leagueId: 'MLB', analysisType: 'FULL', analysisMode: 'SHADOW', inputHash,
  coreFingerprint: 'd'.repeat(64), priceFingerprint: 'f'.repeat(64), calculationFingerprint: '1'.repeat(64), auxiliaryFingerprint: '2'.repeat(64),
  distributionId: distributionSnapshot.distributionId, distributionHash: distributionSnapshot.distributionHash,
  dataAsOf: frozenContext.fetchedAt, analysisAsOf: '2026-08-25T07:59:45.000Z', lineAsOf: market.lineAsOf,
  results: [{ ...signedMarket, weightedEV: 0.04, robustEV: 0.01 }],
};
const pitRecord = buildAnalysisPitSnapshotRecord({
  league: 'MLB', game, frozenContext, analysis, distributionSnapshot, versions, markets: [signedMarket], previousMarkets: [],
});
const replay = buildAnalysisPitReplayBundle(pitRecord);
const snapshotId = pitRecord.snapshotId;
const candidate = {
  league: 'MLB', date: '2026-08-25', gamePk: 123, market: market.market, pick: market.pick, water: market.water,
  readerPayloadHash: snapshot.payloadHash, rawBoardHash: snapshot.rawBoardHash,
  readerRevision: `2026-08-25:${snapshot.payloadHash}`, pitSnapshotId: snapshotId,
};
const dependencies = {
  now,
  loadReader: async () => snapshot,
  resolveGame: async () => ({ game }),
  assertPrestart: (_league, value, checkedAt) => {
    if (Date.parse(value.gameDate) <= checkedAt) {
      const error = new Error('GAME_ALREADY_STARTED');
      error.code = 'GAME_ALREADY_STARTED';
      throw error;
    }
  },
  wallClock: () => now,
  loadPitReplay: async ({ expected }) => {
    assert.equal(expected.inputHash, inputHash);
    return replay;
  },
  loadLatestPitIdentity: async () => ({ snapshotId, inputHash }),
};

const verified = await verifyCloudBetEvidenceV110(candidate, dependencies);
assert.equal(verified.readerVerified, true);
assert.equal(verified.pitVerified, true);
assert.equal(verified.pit.weightedEV, 0.04);
assert.equal(verified.pit.inputHash, inputHash);

await assert.rejects(
  () => verifyCloudBetEvidenceV110({ ...candidate, readerPayloadHash: 'f'.repeat(64) }, dependencies),
  error => error?.code === 'READER_HASH_MISMATCH',
);
await assert.rejects(
  () => verifyCloudBetEvidenceV110({ ...candidate, water: 0.95 }, dependencies),
  error => error?.code === 'READER_CONTRACT_MISMATCH',
);
const noPit = await verifyCloudBetEvidenceV110({ ...candidate, pitSnapshotId: '' }, dependencies);
assert.equal(noPit.readerVerified, true);
assert.equal(noPit.pitVerified, false);
assert.equal(noPit.calibrationEligibility, 'EXCLUDED_UNVERIFIABLE');

await assert.rejects(
  () => verifyCloudBetEvidenceV110(candidate, {
    ...dependencies,
    loadPitReplay: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }) }); },
  }),
  error => isDatabaseError(error) && error?.operation === 'BET_PIT_REPLAY_READ_FAILED',
  'PIT database transport failures must escape as database failures instead of PIT evidence 409',
);

const olderMarket = await signMarketRow('MLB', game, {
  ...market,
  lineAsOf: '2026-08-25T07:58:30.000Z',
});
const olderPitRecord = buildAnalysisPitSnapshotRecord({
  league: 'MLB', game, frozenContext,
  analysis: {
    ...analysis,
    lineAsOf: olderMarket.lineAsOf,
    analysisAsOf: '2026-08-25T07:58:45.000Z',
    results: [{ ...olderMarket, weightedEV: 0.04, robustEV: 0.01 }],
  },
  distributionSnapshot, versions, markets: [olderMarket], previousMarkets: [],
});
const heartbeatPit = await verifyCloudBetEvidenceV110(candidate, {
  ...dependencies,
  loadPitReplay: async () => buildAnalysisPitReplayBundle(olderPitRecord),
});
assert.equal(heartbeatPit.readerVerified, true);
assert.equal(heartbeatPit.pitVerified, true, '同內容Reader heartbeat不得讓不可變PIT失效');

const changedContentMarket = await signMarketRow('MLB', game, {
  ...olderMarket,
  readerGameMarketHash: '8'.repeat(64),
});
const changedContentRecord = buildAnalysisPitSnapshotRecord({
  league: 'MLB', game, frozenContext,
  analysis: {
    ...analysis,
    lineAsOf: changedContentMarket.lineAsOf,
    analysisAsOf: '2026-08-25T07:58:45.000Z',
    results: [{ ...changedContentMarket, weightedEV: 0.04, robustEV: 0.01 }],
  },
  distributionSnapshot, versions, markets: [changedContentMarket], previousMarkets: [],
});
const changedContentPit = await verifyCloudBetEvidenceV110(candidate, {
  ...dependencies,
  loadPitReplay: async () => buildAnalysisPitReplayBundle(changedContentRecord),
});
assert.equal(changedContentPit.pitVerified, false, '同方向同水位但不同場次內容修訂不得附著');
assert.match(changedContentPit.pitError, /不是同一場盤口內容版本/);

const supersededPit = await verifyCloudBetEvidenceV110(candidate, {
  ...dependencies,
  loadLatestPitIdentity: async () => ({ snapshotId: `MLB:123:${'9'.repeat(64)}`, inputHash: '9'.repeat(64) }),
});
assert.equal(supersededPit.readerVerified, true);
assert.equal(supersededPit.pitVerified, false, '同一Reader截點的舊核心分析不得被挑選附著');
assert.match(supersededPit.pitError, /較新的核心分析取代/);

await assert.rejects(
  () => verifyCloudBetEvidenceV110(candidate, {
    ...dependencies,
    wallClock: () => Date.parse(game.gameDate),
  }),
  error => error?.code === 'GAME_ALREADY_STARTED',
);
await assert.rejects(
  () => verifyCloudBetEvidenceV110(candidate, {
    ...dependencies,
    wallClock: () => Date.parse(market.lineAsOf) + 5 * 60_000 + 1,
  }),
  error => error?.code === 'READER_LINE_STALE_AFTER_PIT',
);

console.log('Server-side Reader contract/hash/prestart and immutable PIT bet evidence verification PASS');
