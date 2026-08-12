import assert from 'node:assert/strict';
import { applyIndependentMarketVerification } from '../lib/market-verification-v1.js';

const actual = [{
  market: '全場大小',
  pick: '大8+50',
  water: 0.94,
  sourceType: 'ACTUAL_TW_CREDIT',
  provider: 'TAI888_READER_AUTO',
  lineAsOf: '2026-08-12T00:00:00Z',
}];
const independent = [{
  market: '全場大小',
  pick: '大8+50',
  water: 0.95,
  sourceType: 'INTERNATIONAL',
  provider: 'THE_ODDS_API_CONSENSUS',
  lineAsOf: '2026-08-12T00:10:00Z',
}];

const verified = applyIndependentMarketVerification(actual, independent);
assert.equal(verified[0].marketVerification.verified, true);
assert.equal(verified[0].marketVerification.policyStatus, 'TWO_INDEPENDENT_EXACT_CONTRACTS');
assert.equal(new Set(verified[0].marketVerification.sources.map(row => row.independentGroup)).size, 2);

const wrongLine = applyIndependentMarketVerification(actual, [{ ...independent[0], pick: '大8.5' }]);
assert.equal(wrongLine[0].marketVerification.verified, false);

const wrongDirection = applyIndependentMarketVerification(actual, [{ ...independent[0], pick: '小8+50' }]);
assert.equal(wrongDirection[0].marketVerification.verified, false);

const stale = applyIndependentMarketVerification(actual, [{ ...independent[0], lineAsOf: '2026-08-12T02:00:00Z' }]);
assert.equal(stale[0].marketVerification.verified, false);

const sameProviderGroup = applyIndependentMarketVerification(actual, [{
  ...independent[0],
  provider: 'TAI888_SECOND_VIEW',
}]);
assert.equal(sameProviderGroup[0].marketVerification.verified, false);

console.log('Independent market verification: exact line/direction/time/provider gates PASS');
