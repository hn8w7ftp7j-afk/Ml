import assert from 'node:assert/strict';
import { applyMarketFreshness } from '../lib/market-freshness-v1.js';

const now = Date.parse('2026-08-12T00:00:00Z');

const fresh = applyMarketFreshness({
  sourceType: 'ACTUAL_TW_CREDIT',
  lineAsOf: '2026-08-11T23:58:00Z',
  executable: true,
}, now);
assert.equal(fresh.executable, true);
assert.equal(fresh.lineFresh, true);
assert.equal(fresh.executionStatus, 'EXECUTABLE');
assert.equal(fresh.lineAgeSeconds, 120);

const expired = applyMarketFreshness({
  sourceType: 'ACTUAL_TW_CREDIT',
  lineAsOf: '2026-08-11T23:54:59Z',
  executable: true,
}, now);
assert.equal(expired.executable, false);
assert.equal(expired.lineFresh, false);
assert.equal(expired.executionStatus, 'EXPIRED');

const missing = applyMarketFreshness({
  sourceType: 'ACTUAL_TW_CREDIT',
  executable: true,
}, now);
assert.equal(missing.executable, false);
assert.equal(missing.executionStatus, 'UNCONFIRMED_LINE_TIME');

const futureAllowed = applyMarketFreshness({
  sourceType: 'ACTUAL_TW_CREDIT',
  lineAsOf: '2026-08-12T00:01:00Z',
  executable: true,
}, now);
assert.equal(futureAllowed.executable, true);

const futureRejected = applyMarketFreshness({
  sourceType: 'ACTUAL_TW_CREDIT',
  lineAsOf: '2026-08-12T00:02:00Z',
  executable: true,
}, now);
assert.equal(futureRejected.executable, false);
assert.equal(futureRejected.executionStatus, 'FUTURE_TIMESTAMP_REJECTED');

const reference = applyMarketFreshness({
  sourceType: 'INTERNATIONAL',
  executable: false,
}, now);
assert.equal(reference.lineFresh, true);
assert.equal(reference.executable, false);
assert.equal(reference.executionStatus, 'NON_EXECUTABLE');

console.log('Actual credit-line freshness: fresh, expired, missing and future-skew gates PASS');
