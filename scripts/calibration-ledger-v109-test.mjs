import assert from 'node:assert/strict';
import './pit-feature-time-evidence-test.mjs';
import { sha256 } from '../lib/snapshot-v9.js';
import { buildCalibrationStatusFromBetsV109, buildPitPredictionFromBetV109, contractTypeV109, featureObservedAtsFromContextV109, marketFamilyV109, settledBetToPitObservationV109 } from '../lib/calibration-ledger-v109.js';

assert.equal(marketFamilyV109('全場大小'), 'FULL_TOTAL');
assert.equal(marketFamilyV109('上半讓分'), 'FIRST5_SIDE');
assert.equal(contractTypeV109('大8平'), 'TOTAL_OVER');
assert.equal(contractTypeV109('洋基讓1平'), 'SIDE_GIVING');

const mlbInjuryReceipt = '2026-09-28T19:40:00.000Z';
const mlbInjurySemanticDate = '2026-09-29T00:00:00.000Z';
const mlbFeatureTimes = featureObservedAtsFromContextV109({
  leagueId: 'MLB',
  fetchedAt: '2026-09-28T19:41:00.000Z',
  featureProvenance: [
    { featureName: 'awayInjuries', fetchedAt: mlbInjuryReceipt, asOf: mlbInjurySemanticDate },
    { featureName: 'homeInjuries', fetchedAt: mlbInjuryReceipt, asOf: mlbInjurySemanticDate },
  ],
});
assert.equal(mlbFeatureTimes.awayInjuries, mlbInjuryReceipt, 'MLB injury PIT time must use the immutable fetch receipt, not the semantic roster date');
assert.equal(mlbFeatureTimes.homeInjuries, mlbInjuryReceipt, 'both injury sides must preserve receipt-time provenance');


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
const injuryBet = { ...bet, gameDate: '2026-09-29T02:00:00.000Z',
  analysisAsOf: '2026-09-28T19:42:00.000Z', placedAt: '2026-09-28T19:43:00.000Z',
  lineAsOf: '2026-09-28T19:41:30.000Z', featureObservedAts: mlbFeatureTimes };
assert.equal(buildPitPredictionFromBetV109(injuryBet).ok, true, 'a future roster date with pre-analysis receipts must be recordable');
const futureTimes = featureObservedAtsFromContextV109({ leagueId: 'MLB', featureProvenance: [
  { featureName: 'awayInjuries', fetchedAt: '2026-09-28T19:44:00.000Z', asOf: '2026-09-27' },
] });
assert.ok(buildPitPredictionFromBetV109({ ...injuryBet, featureObservedAts: futureTimes }).errors.includes('FEATURE_FROM_FUTURE:awayInjuries'), 'a genuinely late receipt must still be rejected');
for (const leagueId of ['NPB', 'KBO', 'CPBL']) {
  assert.deepEqual(featureObservedAtsFromContextV109({ leagueId, fetchedAt: mlbInjuryReceipt,
    featureProvenance: [{ featureName: 'lineup', asOf: mlbInjuryReceipt, observedAt: mlbInjuryReceipt }] }), { lineup: null, invalidFeatureEvidence: null }, 'Asian source times must not fall back to semantic dates');
}

assert.equal(buildPitPredictionFromBetV109({ ...injuryBet, dataAsOf: '2026-09-28T19:39:00.000Z' }).ok, false, 'repricing must not move the model input cutoff');

const prediction = buildPitPredictionFromBetV109(bet);
assert.equal(prediction.ok, true);
assert.equal(prediction.prediction.marketFamily, 'FULL_TOTAL');
assert.equal(prediction.prediction.contractType, 'TOTAL_OVER');
assert.equal(settledBetToPitObservationV109({ ...bet, pitPrediction: prediction.prediction, pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED', calibrationEligibility: 'PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE', status: 'OPEN' }), null);
const observed = settledBetToPitObservationV109({ ...bet, pitPrediction: prediction.prediction, pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED', calibrationEligibility: 'PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE', status: 'SETTLED', settlement: { roi: 0.965, settledAt: '2026-08-25T05:00:00.000Z' } });
assert.equal(observed.realizedNetReturn, 0.965);
assert.equal(buildPitPredictionFromBetV109({ ...bet, pitEvidenceVerified: false }).ok, false, 'client-shaped rows cannot synthesize PIT hashes');
assert.equal(settledBetToPitObservationV109({ ...bet, pitPrediction: prediction.prediction, pitPredictionStatus: 'EXCLUDED_UNVERIFIABLE', calibrationEligibility: 'EXCLUDED_UNVERIFIABLE', status: 'SETTLED', settlement: { roi: 0.965, settledAt: '2026-08-25T05:00:00.000Z' } }), null, 'unverified rows must never enter calibration');

const settled = { ...bet, pitPrediction: prediction.prediction, pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED', calibrationEligibility: 'PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE', status: 'SETTLED', settlement: { roi: 0.965, settledAt: '2026-08-25T05:00:00.000Z' } };
for (const missing of [null, undefined, '', '   ', false, true, {}, [], [0], NaN, Infinity]) {
  assert.equal(buildPitPredictionFromBetV109({ ...bet, weightedEV: missing }).ok, false, 'missing W must not be written as zero');
  assert.equal(buildPitPredictionFromBetV109({ ...bet, robustEV: missing }).ok, false, 'missing R must not be written as zero');
  assert.equal(buildPitPredictionFromBetV109({ ...bet, rawModelWeightedEV: missing }).ok, false, 'explicit missing raw W cannot fall back to an alias');
  assert.equal(buildPitPredictionFromBetV109({ ...bet, rawModelRobustEV: missing }).ok, false, 'explicit missing raw R cannot fall back to an alias');
  assert.equal(settledBetToPitObservationV109({ ...settled, settlement: { ...settled.settlement, roi: missing } }), null, 'missing ROI must not enter the ledger as a push');
  assert.equal(settledBetToPitObservationV109({ ...settled, pitPrediction: { ...settled.pitPrediction, rawWeightedEv: missing } }), null, 'immutable marker does not bypass validation');
}
for (const zero of [0, '0']) {
  const zeroPrediction = buildPitPredictionFromBetV109({ ...bet, rawModelWeightedEV: zero, rawModelRobustEV: zero });
  assert.equal(zeroPrediction.ok, true);
  const zeroObservation = settledBetToPitObservationV109({ ...settled, pitPrediction: zeroPrediction.prediction, settlement: { ...settled.settlement, roi: zero } });
  assert.equal(zeroObservation.realizedNetReturn, 0);
  assert.equal(zeroObservation.settledAt, settled.settlement.settledAt, 'preserve actual result availability provenance');
}
assert.equal(settledBetToPitObservationV109({ ...settled, settlement: { ...settled.settlement, settledAt: 'invalid' } }), null);
assert.equal(settledBetToPitObservationV109({ ...settled, settlement: { ...settled.settlement, settledAt: bet.analysisAsOf } }), null, 'reject settlement before the game');
const validStatus = buildCalibrationStatusFromBetsV109([settled]);
assert.equal(validStatus.settledPredictionRows, 1);
assert.equal(buildCalibrationStatusFromBetsV109([{ ...settled, pitEvidenceVerified: false }]).settledPredictionRows, 0, 'cache must invalidate when PIT evidence eligibility changes');
assert.equal(buildCalibrationStatusFromBetsV109([{ ...settled, pitPrediction: { ...settled.pitPrediction, rawWeightedEv: null } }]).settledPredictionRows, 0, 'cache must invalidate corrected prediction inputs');
assert.equal(buildCalibrationStatusFromBetsV109([settled]).automaticActivation, false);
// Simulate the pre-fix process cache surviving a hot module reload.
globalThis.__BASEBALL_CALIBRATION_STATUS_V109__.signature = sha256({ options: {}, bets: [settled].map(item => [item.id, item.status, item.settlement.settledAt, item.settlement.roi, item.pitPredictionStatus, item.pitEvidenceVerified, item.calibrationEligibility, item.pitPrediction]) });
globalThis.__BASEBALL_CALIBRATION_STATUS_V109__.value = { version: 'BASEBALL-IMMUTABLE-FORWARD-CALIBRATION-LEDGER-v10.9.0', releaseEligible: true, status: 'STALE_BEFORE_RESULT_CUTOFF_FIX' };
assert.notEqual(buildCalibrationStatusFromBetsV109([settled]).status, 'STALE_BEFORE_RESULT_CUTOFF_FIX', 'implementation version must invalidate old cached calibration approval');

console.log('Immutable forward calibration ledger v10.9 PASS');
