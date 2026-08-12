import assert from 'node:assert/strict';
import { applyMarketFreshness } from '../lib/market-freshness-v1.js';

const now = Date.parse('2026-08-12T00:00:00Z');
const fresh = applyMarketFreshness({
  sourceType: 'ACTUAL_TW_CREDIT',
  lineAsOf: '2026-08-11T23:58:00Z',
  executable: true,
}, now);
assert.equal(fresh.executable, true);
assert.equal(fresh.executionStatus, 'EXECUTABLE');

const expired = applyMarketFreshness({
  sourceType: 'ACTUAL_TW_CREDIT',
  lineAsOf: '2026-08-11T23:50:00Z',
  executable: true,
}, now);
assert.equal(expired.executable, false);
assert.equal(expired.executionStatus, 'EXPIRED');

const missing = applyMarketFreshness({ sourceType: 'ACTUAL_TW_CREDIT', executable: true }, now);
assert.equal(missing.executable, false);
assert.equal(missing.executionStatus, 'UNCONFIRMED_LINE_TIME');

const reference = applyMarketFreshness({ sourceType: 'INTERNATIONAL', executable: false }, now);
assert.equal(reference.lineFresh, true);
assert.equal(reference.executable, false);

console.log('market freshness v1: ok');
