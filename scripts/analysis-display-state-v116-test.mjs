import assert from 'node:assert/strict';
import {
  analysisHasCalculatedToBlockedTransition,
  analysisHasCalculatedDirections,
  analysisDisplayRowsForCard,
  analysisIsUnopenedOnly,
  readerEvidenceIsOlder,
  readerMarketsHaveBlockingTransition,
  readerMarketsLoseCalculatedCoverage,
  readerResultIsStale,
  shouldPreserveCalculatedAnalysis,
} from '../lib/analysis-display-state-v116.js';

const calculatedRows = [
  ['FULL_RUNLINE_AWAY', '全場讓分'],
  ['FULL_RUNLINE_HOME', '全場讓分'],
  ['FULL_TOTAL_OVER', '全場大小'],
  ['FULL_TOTAL_UNDER', '全場大小'],
  ['FIRST5_RUNLINE_AWAY', '上半讓分'],
  ['FIRST5_RUNLINE_HOME', '上半讓分'],
  ['FIRST5_TOTAL_OVER', '上半大小'],
  ['FIRST5_TOTAL_UNDER', '上半大小'],
].map(([slotId, market], index) => ({
  slotId,
  market,
  status: 'CALCULATED',
  modelEV: index % 2 ? -0.02 : 0.04,
}));
const calculated = {
  analysis: {
    calculatedDirectionCount: 8,
    directionSlots: calculatedRows,
  },
};
const allUnopened = {
  analysis: {
    calculatedDirectionCount: 0,
    results: [],
    directionSlots: calculated.analysis.directionSlots.map(row => ({ ...row, status: 'UNOPENED', modelEV: null })),
  },
};
const partial = {
  analysis: {
    calculatedDirectionCount: 2,
    directionSlots: calculatedRows.map(row => row.market === '全場讓分'
      ? row
      : { ...row, status: 'UNOPENED', modelEV: null }),
  },
};
const blockedMixed = {
  analysis: {
    calculatedDirectionCount: 2,
    directionSlots: calculatedRows.map(row => row.market === '全場讓分'
      ? row
      : row.market === '全場大小'
        ? { ...row, status: 'BLOCKED', modelEV: null }
        : { ...row, status: 'UNOPENED', modelEV: null }),
  },
};
const blockedComplete = {
  analysis: {
    calculatedDirectionCount: 6,
    directionSlots: calculatedRows.map(row => row.market === '全場大小'
      ? { ...row, status: 'BLOCKED', modelEV: null }
      : row),
  },
};
const runlineMarkets = [{ market: '全場讓分' }, { market: '全場讓分' }];
const blockingTotalRow = {
  market: '全場大小',
  integrityOrigin: 'SERVER_SIGNED_READER_COVERAGE',
  authorizationStatus: 'SERVER_ATTESTED_READER_COVERAGE_BLOCK',
};
const fullMarkets = calculatedRows.map(row => ({ market: row.market }));

assert.equal(analysisHasCalculatedDirections(calculated), true);
const legacyPitAnalysis = {
  analysis: {
    calculatedDirectionCount: 2,
    results: calculatedRows.slice(0, 2).map(({ sourceType, ...row }) => row),
  },
  pitPersistence: { confirmed: true },
};
assert.equal(analysisDisplayRowsForCard(legacyPitAnalysis, { pitConfirmed: true }).length, 2,
  'confirmed legacy PIT results must remain visible when the newer sourceType field is absent');
assert.equal(analysisDisplayRowsForCard(legacyPitAnalysis, { pitConfirmed: false }).length, 0,
  'legacy rows without PIT confirmation must remain hidden');
assert.equal(analysisDisplayRowsForCard(calculated, { pitConfirmed: true }).length, 8,
  'the current eight-direction contract must render all direction slots unchanged');
assert.equal(analysisIsUnopenedOnly(allUnopened), true);
assert.equal(readerMarketsLoseCalculatedCoverage(calculated, []), true, '8→0 Reader coverage must be a regression');
assert.equal(readerMarketsLoseCalculatedCoverage(calculated, runlineMarkets), true, '8→2 calculated coverage must be a regression');
assert.equal(readerMarketsLoseCalculatedCoverage(partial, fullMarkets), false, '2→8 coverage expansion must be accepted');
assert.equal(shouldPreserveCalculatedAnalysis(calculated, allUnopened, []), true, 'all-UNOPENED must never erase calculated W/R');
assert.equal(shouldPreserveCalculatedAnalysis(calculated, partial, runlineMarkets), true, '8→2 partial Reader contraction must preserve the prior distribution');
assert.equal(shouldPreserveCalculatedAnalysis(partial, calculated, fullMarkets), false, 'coverage expansion must replace the prior partial result');
assert.equal(analysisHasCalculatedToBlockedTransition(calculated, blockedMixed), true);
assert.equal(readerMarketsHaveBlockingTransition(calculated, [...runlineMarkets, blockingTotalRow]), true);
assert.equal(shouldPreserveCalculatedAnalysis(calculated, blockedMixed, [...runlineMarkets, blockingTotalRow]), true, 'mixed BLOCKED + UNOPENED contraction must keep one immutable prior distribution while the live coverage overlay exposes the block');
assert.equal(shouldPreserveCalculatedAnalysis(calculated, blockedComplete, fullMarkets), false, 'a complete 6 CALCULATED + 2 BLOCKED snapshot must replace the old result and expose the true block');
assert.equal(readerResultIsStale({ taskPayloadHash: 'old', livePayloadHash: 'new', liveBoardDate: '2026-08-29', targetDate: '2026-08-29' }), true);
assert.equal(readerResultIsStale({ taskPayloadHash: 'old', livePayloadHash: '', liveBoardDate: '', targetDate: '2026-08-29' }), true, 'a cold reconnect must not apply a Reader job before the live hash is known');
assert.equal(readerResultIsStale({ taskPayloadHash: 'old', livePayloadHash: 'new', liveBoardDate: '2026-08-30', targetDate: '2026-08-29' }), true);
assert.equal(readerEvidenceIsOlder({ pageActivityAt: '2026-08-28T15:00:00Z' }, { pageActivityAt: '2026-08-28T15:01:00Z' }), true);
assert.equal(readerEvidenceIsOlder({ pageActivityAt: '2026-08-28T15:02:00Z' }, { pageActivityAt: '2026-08-28T15:01:00Z' }), false);
assert.equal(readerEvidenceIsOlder(
  { pageActivityAt: '2026-08-28T15:02:00Z' },
  { pageActivityAt: '2026-08-28T15:01:00Z' },
  { pageActivityAt: '2026-08-28T15:03:00Z' },
), true, 'waiting→reopen history must compare against the newest evidence across both stored sources');

console.log('analysis display state v11.6.1 monotonic Reader merge PASS');
