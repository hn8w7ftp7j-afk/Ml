import assert from 'node:assert/strict';
import { inspectPitFeatureTimes, receiptInstant } from '../lib/pit-feature-time-evidence.js';

const before = '2026-09-28T19:40:00.000Z';
const cutoff = '2026-09-28T19:41:00.000Z';
const after = '2026-09-28T19:42:00.000Z';
const row = { featureName: 'awayInjuries', fetchedAt: before, asOf: '2026-09-29' };
const context = { leagueId: 'MLB', fetchedAt: cutoff, featureProvenance: [row] };
const check = (rows, extra = {}) => inspectPitFeatureTimes({ ...context, ...extra, featureProvenance: rows }, cutoff);
assert.equal(check([row]).ok, true);
assert.equal(check([{ ...row, validAt: after, asOf: after }]).ok, true, 'semantic dates are not receipt times');
for (const value of [null, '', 'bad', '2026-09-28', '2026-09-28T19:40:00', '2026-02-30T00:00:00Z', '2026-09-28T24:00:00Z', after]) {
  assert.equal(check([{ ...row, fetchedAt: value }]).ok, false, String(value));
}
assert.equal(check([{ featureName: 'awayInjuries', asOf: before }]).ok, false);
assert.equal(check([]).ok, false);
assert.equal(check([row, row]).ok, false);
assert.equal(check([{ fetchedAt: before }]).ok, false);
assert.equal(check([{ ...row, observedAt: after }]).ok, false);
assert.equal(check([{ ...row, dependencyReceipts: [{ fetchedAt: before }, { fetchedAt: after }] }]).ok, false);
assert.equal(check([{ ...row, sourceReceipts: [{}] }]).ok, false);
assert.equal(check([{ ...row, dependencyReceipts: {} }]).ok, false);
assert.equal(check([{ ...row, fetchedAt: '2026-09-29T03:40:00+08:00' }]).ok, true);
assert.equal(receiptInstant('2026-02-28T00:00:00Z'), '2026-02-28T00:00:00.000Z');
assert.equal(inspectPitFeatureTimes(context, 'bad').ok, false);

const weather = { featureName: 'weather', normalizationVersion: 'MLB-STANDALONE-POINT-IN-TIME-CONTEXT-2026-09-v11.0.2', status: 'MISSING', value: null };
assert.equal(check([weather], { weather: { available: false, meanRunFactor: 1 } }).ok, true);
assert.deepEqual(check([weather], { weather: { available: false, meanRunFactor: 1 } }).featureObservedAts, { 'neutralState:weather': cutoff });
assert.equal(check([weather], { weather: { available: false, meanRunFactor: 1.1 } }).ok, false);
assert.equal(check([weather], { weather: { available: false, meanRunFactor: 1 }, fetchedAt: after }).ok, false);
const wind = { featureName: 'parkWindOrientation', normalizationVersion: 'MLB-PIT-LINEUP-PLATOON-RELIEF-CONTEXT-2026-09-v11.0.9', value: {
  version: 'MLB-PARK-WIND-ORIENTATION-2026-08-v2.0.0', validationStatus: 'PENDING',
  appliedValue: { runDelta: 0, reason: 'PARK_SPECIFIC_CENTERED_OOS_COEFFICIENT_PENDING' },
} };
assert.equal(check([wind]).ok, true);
assert.equal(check([{ ...wind, value: { ...wind.value, appliedValue: { ...wind.value.appliedValue, runDelta: 0.1 } } }]).ok, false);
assert.equal(check([{ ...weather, normalizationVersion: 'unknown' }], { weather: { available: false, meanRunFactor: 1 } }).ok, false);

for (const leagueId of ['NPB', 'KBO', 'CPBL']) {
  const sourceEvidence = { events: [{ id: 'bound', fetchedAt: before }, { id: 'unrelated', fetchedAt: after }] };
  const bound = { feature: '打線', fetchedAt: before, sourceEventIds: ['bound'], timeEvidenceStatus: 'PENDING' };
  assert.equal(check([bound], { leagueId, sourceEvidence }).ok, true);
  assert.equal(check([{ ...bound, observedAt: after }], { leagueId, sourceEvidence }).ok, false);
  assert.equal(check([{ ...bound, sourceEventIds: 'bound' }], { leagueId, sourceEvidence }).ok, false);
  assert.equal(check([{ ...bound, sourceEventIds: ['missing'] }], { leagueId, sourceEvidence }).ok, false);
  assert.equal(check([{ ...bound, sourceEventIds: ['unrelated'] }], { leagueId, sourceEvidence }).ok, false);
  assert.equal(check([{ feature: '打線', observedAt: before, asOf: before }], { leagueId }).ok, false);
}
const original = JSON.stringify(context);
Object.freeze(context.featureProvenance[0]);
Object.freeze(context.featureProvenance);
Object.freeze(context);
assert.equal(inspectPitFeatureTimes(context, cutoff).ok, true);
assert.equal(JSON.stringify(context), original, 'frozen snapshots are never rewritten');
console.log('PIT feature receipt-time regression passed');
