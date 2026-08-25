import assert from 'node:assert/strict';
import { buildPitPredictionFromBetV109, contractTypeV109, marketFamilyV109, settledBetToPitObservationV109 } from '../lib/calibration-ledger-v109.js';

assert.equal(marketFamilyV109('全場大小'), 'FULL_TOTAL');
assert.equal(marketFamilyV109('上半讓分'), 'FIRST5_SIDE');
assert.equal(contractTypeV109('大8平'), 'TOTAL_OVER');
assert.equal(contractTypeV109('洋基讓1平'), 'SIDE_GIVING');

const bet = {
  id: 'bet-v109-1', league: 'MLB', gamePk: 778899,
  gameDate: '2026-08-24T23:00:00.000Z', market: '全場大小', pick: '大8平',
  water: 0.95, weightedEV: 0.03, robustEV: 0.01,
  lineAsOf: '2026-08-24T18:00:00.000Z', analysisAsOf: '2026-08-24T18:01:00.000Z', placedAt: '2026-08-24T18:02:00.000Z',
  readerPayloadHash: 'a'.repeat(64), snapshotId: 'b'.repeat(64),
  inputHash: 'b'.repeat(64), pitEvidenceVerified: true,
  featureObservedAts: { lineup: '2026-08-24T17:59:00.000Z' },
  modelVersion: 'model-v109', settlementRuleVersion: 'settlement-v109',
};
const prediction = buildPitPredictionFromBetV109(bet);
assert.equal(prediction.ok, true);
assert.equal(prediction.prediction.marketFamily, 'FULL_TOTAL');
assert.equal(prediction.prediction.contractType, 'TOTAL_OVER');
assert.equal(settledBetToPitObservationV109({ ...bet, pitPrediction: prediction.prediction, pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED', calibrationEligibility: 'PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE', status: 'OPEN' }), null);
const observed = settledBetToPitObservationV109({ ...bet, pitPrediction: prediction.prediction, pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED', calibrationEligibility: 'PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE', status: 'SETTLED', settlement: { roi: 0.965, settledAt: '2026-08-25T05:00:00.000Z' } });
assert.equal(observed.realizedNetReturn, 0.965);
assert.equal(buildPitPredictionFromBetV109({ ...bet, pitEvidenceVerified: false }).ok, false, 'client-shaped rows cannot synthesize PIT hashes');
assert.equal(settledBetToPitObservationV109({ ...bet, pitPrediction: prediction.prediction, pitPredictionStatus: 'EXCLUDED_UNVERIFIABLE', calibrationEligibility: 'EXCLUDED_UNVERIFIABLE', status: 'SETTLED', settlement: { roi: 0.965, settledAt: '2026-08-25T05:00:00.000Z' } }), null, 'unverified rows must never enter calibration');

console.log('Immutable forward calibration ledger v10.9 PASS');
