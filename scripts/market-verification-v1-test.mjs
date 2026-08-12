import assert from 'node:assert/strict';
import { applyIndependentMarketVerification } from '../lib/market-verification-v1.js';

const actual = [{
  market: '全場大小', pick: '大8+50', water: 0.94,
  sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO',
  lineAsOf: '2026-08-12T00:00:00Z',
}];
const reference = [{
  market: '全場大小', pick: '大8+50', water: 0.95,
  sourceType: 'INTERNATIONAL', provider: 'THE_ODDS_API_CONSENSUS',
  lineAsOf: '2026-08-12T00:10:00Z',
}];

const verified = applyIndependentMarketVerification(actual, reference);
assert.equal(verified[0].marketVerification.verified, true);
assert.equal(new Set(verified[0].marketVerification.sources.map(row => row.independentGroup)).size, 2);

const different = applyIndependentMarketVerification(actual, [{ ...reference[0], pick: '大8.5' }]);
assert.equal(different[0].marketVerification.verified, false);

const stale = applyIndependentMarketVerification(actual, [{ ...reference[0], lineAsOf: '2026-08-12T02:00:00Z' }]);
assert.equal(stale[0].marketVerification.verified, false);

console.log('market verification v1: ok');
