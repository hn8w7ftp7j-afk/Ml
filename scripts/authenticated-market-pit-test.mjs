import assert from 'node:assert/strict';
import { register } from 'node:module';
import { AUTHENTICATED_MARKET_INPUT_VERSION } from '../lib/market-freshness-v1.js';
import { signMarketRow, verifyArchivedMarketEvidence, verifyMarketRow } from '../lib/market-integrity-v1.js';
import { buildAnalysisPitReplayBundle, buildAnalysisPitSnapshotRecord, buildAnalysisPitSnapshotRecordAsync } from '../lib/analysis-pit-snapshot-store-v1.js';
import { verifyCloudBetEvidenceV110 } from '../lib/bet-evidence-verification-v110.js';
import { readerGameMarketContentHash } from '../lib/reader-market-revision-v110.js';
import { buildSnapshotFingerprints } from '../lib/snapshot-v9.js';

register('./authenticated-market-route-test-loader.mjs', import.meta.url);
process.env.MARKET_INTEGRITY_SECRET = 'isolated-authenticated-market-test-secret';

const now = Date.now();
const date = '2099-08-25';
const game = { league: 'MLB', leagueId: 'MLB', gamePk: 123, gameDate: `${date}T10:00:00.000Z`,
  officialDate: date, gameNumber: 1, awayTeamId: 1, homeTeamId: 2, away: '客隊', home: '主隊' };
const market = { market: '全場大小', pick: '大8+50', water: 0.94, confidence: 1,
  sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', executable: true,
  readerVersion: '2.1.19', readerPayloadHash: 'a'.repeat(64), readerRawBoardHash: 'c'.repeat(64), readerBoardDate: date,
  lineAsOf: new Date(now - 300_001).toISOString() };
market.readerGameMarketHash = readerGameMarketContentHash([market]);
const signed = await signMarketRow('MLB', game, market);
const versions = { modelVersion: 'model-test', rulesVersion: 'rules-test', dataVersion: 'data-test',
  scoreFormulaVersion: 'score-test', settlementRuleVersion: 'settlement-test', uncertaintySetVersion: 'uncertainty-test' };
const frozenContext = { leagueId: 'MLB', game, fetchedAt: new Date(now - 600_000).toISOString(), featureProvenance: [], ...versions };
const distributionSnapshot = { distributionId: 'distribution-test', distributionHash: 'e'.repeat(64), gamePk: game.gamePk,
  scenarios: [{ id: 'central', weight: 1, cells: [{ awayRuns: 4, homeRuns: 4, probability: 1 }] }] };
const analysis = { leagueId: 'MLB', analysisType: 'FULL', analysisMode: 'SHADOW', inputHash: 'b'.repeat(64),
  coreFingerprint: 'd'.repeat(64), priceFingerprint: 'f'.repeat(64), calculationFingerprint: '1'.repeat(64), auxiliaryFingerprint: '2'.repeat(64),
  distributionId: distributionSnapshot.distributionId, distributionHash: distributionSnapshot.distributionHash,
  dataAsOf: frozenContext.fetchedAt, analysisAsOf: new Date(now).toISOString(), lineAsOf: market.lineAsOf,
  results: [{ ...signed, weightedEV: 0.04, robustEV: 0.01 }] };
const snapshot = { league: 'MLB', boardDate: date, payloadHash: market.readerPayloadHash, rawBoardHash: market.readerRawBoardHash,
  pageActivityAt: new Date(now - 10_000).toISOString(), matchedGameCount: 1, scheduleGameCount: 1,
  games: [{ league: 'MLB', gamePk: game.gamePk, game, markets: [market] }] };
const baseInput = { league: 'MLB', game, frozenContext, analysis, distributionSnapshot, versions, markets: [signed], previousMarkets: [] };
const legacyRecord = buildAnalysisPitSnapshotRecord(baseInput);
const legacyReplay = buildAnalysisPitReplayBundle(legacyRecord);
assert.equal('authenticatedSuppliedMarkets' in legacyReplay.marketAnalysis, false, 'legacy payload remains byte-compatible without invented evidence');
assert.equal('marketEvidenceVersion' in legacyReplay.versions, false);
const candidate = { league: 'MLB', date, gamePk: game.gamePk, market: market.market, pick: market.pick, water: market.water,
  readerPayloadHash: snapshot.payloadHash, rawBoardHash: snapshot.rawBoardHash, readerRevision: `${date}:${snapshot.payloadHash}`,
  pitSnapshotId: legacyRecord.snapshotId };
const dependencies = { now, wallClock: () => now, loadReader: async () => snapshot, resolveGame: async () => ({ game }),
  assertPrestart: () => {}, loadLatestPitIdentity: async () => ({ snapshotId: legacyRecord.snapshotId, inputHash: analysis.inputHash }),
  loadPitReplay: async () => legacyReplay };
assert.equal((await verifyCloudBetEvidenceV110(candidate, dependencies)).pitVerified, true);

for (const routeName of ['analyze', 'reprice']) {
  const route = await import(`../app/api/${routeName}/route.js`);
  const prepared = await route.prepareAuthenticatedMarketsForTest('MLB', game, [signed], 16);
  const supplied = prepared.markets[0];
  const authenticated = prepared.authenticatedMarkets[0];
  assert.equal(authenticated.executable, true);
  assert.equal(supplied.executable, false, `${routeName} continues to reject stale execution`);
  assert.equal(supplied.lineFresh, false);
  assert.equal(await verifyMarketRow('MLB', game, authenticated), true);
  assert.equal(await verifyMarketRow('MLB', game, supplied), false, 'reproduces original signature failure after server freshness transformation');
  assert.equal((await verifyArchivedMarketEvidence('MLB', game, supplied, authenticated)).verified, true);
  const stored = await buildAnalysisPitSnapshotRecordAsync({ ...baseInput,
    versions: { ...versions, marketEvidenceVersion: AUTHENTICATED_MARKET_INPUT_VERSION },
    markets: prepared.markets, authenticatedSuppliedMarkets: prepared.authenticatedMarkets });
  const replay = buildAnalysisPitReplayBundle(stored);
  assert.deepEqual(replay.marketAnalysis.authenticatedSuppliedMarkets, prepared.authenticatedMarkets);
  assert.equal(replay.marketAnalysis.suppliedMarkets[0].executable, false);
  assert.equal(replay.versions.marketEvidenceVersion, AUTHENTICATED_MARKET_INPUT_VERSION);
  const verified = await verifyCloudBetEvidenceV110(candidate, { ...dependencies, loadPitReplay: async () => replay });
  assert.equal(verified.pitVerified, true, `${routeName} authenticated input survives async PIT encoding and ledger verification`);
  const noEvidenceRecord = buildAnalysisPitSnapshotRecord({ ...baseInput, markets: prepared.markets });
  assert.equal((await verifyCloudBetEvidenceV110(candidate, { ...dependencies,
    loadPitReplay: async () => buildAnalysisPitReplayBundle(noEvidenceRecord) })).pitVerified, false, 'old invalid archive is not repaired or re-signed');
  for (const mutation of [{ pick: '大9+50' }, { water: 0.95 }, { readerPayloadHash: '9'.repeat(64) }]) {
    const tampered = { ...signed, ...mutation };
    await assert.rejects(() => route.prepareAuthenticatedMarketsForTest('MLB', game, [tampered], 16), /簽章/);
    assert.equal((await verifyArchivedMarketEvidence('MLB', game, { ...supplied, ...mutation }, authenticated)).verified, false);
  }
  const missingEvidenceReplay = structuredClone(replay);
  missingEvidenceReplay.marketAnalysis.authenticatedSuppliedMarkets = [];
  assert.equal((await verifyCloudBetEvidenceV110(candidate, { ...dependencies,
    loadPitReplay: async () => missingEvidenceReplay })).pitVerified, false);
  const nonExecutable = await signMarketRow('MLB', game, { ...market, executable: false });
  assert.equal((await verifyArchivedMarketEvidence('MLB', game, { ...nonExecutable, executable: true }, nonExecutable)).verified, false,
    'archived authentication never upgrades an originally non-executable row');
}

const fingerprints = buildSnapshotFingerprints({ league: 'MLB', context: frozenContext, markets: [signed], versions });
const revised = buildSnapshotFingerprints({ league: 'MLB', context: frozenContext, markets: [signed],
  versions: { ...versions, marketEvidenceVersion: AUTHENTICATED_MARKET_INPUT_VERSION } });
assert.equal(revised.coreFingerprint, fingerprints.coreFingerprint);
assert.equal(revised.priceFingerprint, fingerprints.priceFingerprint);
assert.equal(revised.calculationFingerprint, fingerprints.calculationFingerprint);
assert.notEqual(revised.inputHash, fingerprints.inputHash, 'new evidence schema gets a new immutable identity without changing the model');
console.log('PASS authenticated market input: real analyze/reprice preparation → immutable PIT → verification; stale gates and tamper rejection preserved');
