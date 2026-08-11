import assert from 'node:assert/strict';
import { buildSnapshotFingerprints } from '../lib/snapshot-v9.js';
import {
  analysisCacheKey,
  analysisCachePayloadMatches,
  analysisContractSignature,
} from '../lib/analysis-cache-v9.js';

const versions = {
  modelVersion: 'model-v1',
  dataVersion: 'data-v1',
  uncertaintySetVersion: 'uncertainty-v1',
  settlementRuleVersion: 'settlement-v1',
  scoreFormulaVersion: 'score-v1',
};

const baseContext = {
  game: {
    gamePk: 1001,
    officialDate: '2026-08-11',
    gameNumber: 1,
    away: '客隊A',
    home: '主隊A',
    awayTeamId: 1,
    homeTeamId: 2,
  },
  league: { runsPerTeamGame: 4.35 },
  away: { seasonHitting: { available: true, ops: 0.72 }, seasonPitching: { available: true, era: 4.1 } },
  home: { seasonHitting: { available: true, ops: 0.73 }, seasonPitching: { available: true, era: 4.0 } },
  weather: { available: true, temperature: 25 },
  park: { runFactor: 1 },
  umpire: { name: '' },
  featureProvenance: [],
  fetchedAt: '2026-08-11T01:00:00Z',
};
const markets = [
  { market: '全場大小', pick: '大8.5', water: 0.82, sourceType: 'INTERNATIONAL', lineAsOf: '2026-08-11T01:00:00Z', executable: false },
  { market: '全場大小', pick: '小8.5', water: 0.86, sourceType: 'INTERNATIONAL', lineAsOf: '2026-08-11T01:00:00Z', executable: false },
];

const first = buildSnapshotFingerprints({ context: baseContext, markets, versions });
const repeated = buildSnapshotFingerprints({ context: { ...baseContext, fetchedAt: '2026-08-11T01:01:00Z' }, markets: [...markets].reverse(), versions });
assert.equal(first.coreFingerprint, repeated.coreFingerprint, 'volatile fetch time must not change the core fingerprint');
assert.equal(first.priceFingerprint, repeated.priceFingerprint, 'market row order must not change the price fingerprint');
assert.equal(first.inputHash, repeated.inputHash, 'same economic input must reproduce the same inputHash');

const otherGame = buildSnapshotFingerprints({
  context: {
    ...baseContext,
    game: { ...baseContext.game, gamePk: 1002, away: '客隊B', home: '主隊B', awayTeamId: 3, homeTeamId: 4 },
  },
  markets,
  versions,
});
assert.notEqual(first.coreFingerprint, otherGame.coreFingerprint, 'different game must have a different core fingerprint');
assert.notEqual(first.inputHash, otherGame.inputHash, 'different game must have a different inputHash');

const otherWater = buildSnapshotFingerprints({
  context: baseContext,
  markets: markets.map((row, index) => index === 0 ? { ...row, water: 0.95 } : row),
  versions,
});
assert.equal(first.coreFingerprint, otherWater.coreFingerprint, 'price-only change must retain core fingerprint');
assert.notEqual(first.priceFingerprint, otherWater.priceFingerprint, 'water change must change price fingerprint');
assert.notEqual(first.inputHash, otherWater.inputHash, 'water change must change inputHash');

const signature = analysisContractSignature(baseContext.game, markets);
const otherSignature = analysisContractSignature(otherGame.corePayload.game, markets);
assert.notEqual(signature, otherSignature, 'contract signature must include game identity');
const cacheKey = analysisCacheKey(baseContext.game.gamePk, first.inputHash);
const otherCacheKey = analysisCacheKey(otherGame.corePayload.game.gamePk, otherGame.inputHash);
assert.notEqual(cacheKey, otherCacheKey, 'cache key must be game isolated');

const payload = {
  game: baseContext.game,
  context: { game: baseContext.game },
  analysis: { inputHash: first.inputHash },
  repriceSnapshot: { inputHash: first.inputHash },
};
assert.equal(analysisCachePayloadMatches({ signature, payload }, {
  game: baseContext.game,
  fingerprints: first,
  signature,
}), true);
assert.equal(analysisCachePayloadMatches({ signature, payload }, {
  game: otherGame.corePayload.game,
  fingerprints: otherGame,
  signature: otherSignature,
}), false, 'cached payload from another game must be rejected');

console.log(JSON.stringify({
  ok: true,
  repeatedInputHash: first.inputHash,
  otherGameInputHash: otherGame.inputHash,
  priceOnlyInputHash: otherWater.inputHash,
  cacheKey,
  otherCacheKey,
}, null, 2));
