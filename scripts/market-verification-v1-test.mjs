import assert from 'node:assert/strict';
import {
  applyIndependentMarketVerification,
  MAX_ACTUAL_REFERENCE_DISTANCE_MS,
  MARKET_VERIFICATION_V2_VERSION,
  MINIMUM_CONSENSUS_BOOKS,
} from '../lib/market-verification-v2.js';

const actual = [{
  market: '全場大小',
  pick: '大8.5',
  water: 0.94,
  sourceType: 'ACTUAL_TW_CREDIT',
  provider: 'TAI888_READER_AUTO',
  lineAsOf: '2026-08-12T00:00:00Z',
}, {
  market: '全場大小',
  pick: '小8.5',
  water: 0.94,
  sourceType: 'ACTUAL_TW_CREDIT',
  provider: 'TAI888_READER_AUTO',
  lineAsOf: '2026-08-12T00:00:00Z',
}];
const consensusBookKeys = ['book-a', 'book-b', 'book-c'];
const consensusEvidence = {
  referenceProbabilitySpread: 0.02,
  referenceProbabilityMad: 0.005,
  referenceEvidenceEligible: true,
  consensusBookCount: MINIMUM_CONSENSUS_BOOKS,
  consensusBookKeys,
  consensusOldestObservedAt: '2026-08-12T00:02:00Z',
  consensusNewestObservedAt: '2026-08-12T00:04:00Z',
  consensusTimeSpanMs: 2 * 60 * 1000,
  consensusFreshnessMaxMs: 4 * 60 * 1000,
  consensusSnapshotId: 'THE_ODDS_API:event-1:TOTAL:8.50:snapshot-1',
};
const independent = [{
  market: '全場大小', pick: '大8.5', water: 0.95,
  sourceType: 'INTERNATIONAL', provider: 'THE_ODDS_API_CONSENSUS',
  providerEventId: 'event-1', lineAsOf: '2026-08-12T00:04:00Z',
  referenceNoVigProbability: 0.51, referenceRobustProbability: 0.5025,
  referenceProbabilityMinimum: 0.50, referenceProbabilityMaximum: 0.52,
  ...consensusEvidence,
}, {
  market: '全場大小', pick: '小8.5', water: 0.95,
  sourceType: 'INTERNATIONAL', provider: 'THE_ODDS_API_CONSENSUS',
  providerEventId: 'event-1', lineAsOf: '2026-08-12T00:04:00Z',
  referenceNoVigProbability: 0.49, referenceRobustProbability: 0.4825,
  referenceProbabilityMinimum: 0.48, referenceProbabilityMaximum: 0.50,
  ...consensusEvidence,
}];
const verificationNow = Date.parse('2026-08-12T00:05:00Z');
const verify = (actualMarkets, referenceMarkets, now = verificationNow) => (
  applyIndependentMarketVerification(
    actualMarkets,
    referenceMarkets,
    MAX_ACTUAL_REFERENCE_DISTANCE_MS,
    now,
  )
);

const verified = verify(actual, independent);
assert.equal(verified[0].marketVerification.verified, true);
assert.equal(verified[0].marketVerification.policyStatus, 'THREE_BOOK_FRESH_SYNCHRONIZED_EXACT_CONTRACT_CONSENSUS');
assert.equal(verified[0].marketVerification.version, MARKET_VERIFICATION_V2_VERSION);
assert.equal(new Set(verified[0].marketVerification.sources.map(row => row.independentGroup)).size, 2);
assert.equal(verified[0].marketVerification.referencePriorEligible, true);
assert.equal(verified[0].marketVerification.referenceConsensusBookCount, MINIMUM_CONSENSUS_BOOKS);
assert.equal(verified[0].marketVerification.referenceNoVigProbability, 0.51);
assert.equal(verified[0].marketVerification.referenceRobustProbability, 0.5025);

const wrongLine = verify(actual, independent.map(row => ({ ...row, pick: row.pick.replace('8.5', '9.5') })));
assert.equal(wrongLine[0].marketVerification.verified, false);
assert.equal(wrongLine[0].marketVerification.referencePriorEligible, false);

const wrongDirection = verify(actual, [{ ...independent[0], pick: '小8.5' }, independent[1]]);
assert.equal(wrongDirection[0].marketVerification.verified, false);
assert.equal(wrongDirection[0].marketVerification.referencePriorEligible, false);

const stale = verify(actual, independent.map(row => ({ ...row, lineAsOf: '2026-08-12T02:00:00Z' })));
assert.equal(stale[0].marketVerification.verified, false);
assert.equal(stale[0].marketVerification.referencePriorEligible, false);

const sameProviderGroup = verify(actual, independent.map(row => ({
  ...row,
  provider: 'TAI888_SECOND_VIEW',
})));
assert.equal(sameProviderGroup[0].marketVerification.verified, false);
assert.equal(sameProviderGroup[0].marketVerification.referencePriorEligible, false);

const onlyTwoBooks = verify(actual, independent.map(row => ({
  ...row,
  consensusBookCount: MINIMUM_CONSENSUS_BOOKS - 1,
  consensusBookKeys: consensusBookKeys.slice(0, MINIMUM_CONSENSUS_BOOKS - 1),
  referenceEvidenceEligible: false,
})));
assert.equal(onlyTwoBooks[0].marketVerification.verified, false);
assert.equal(onlyTwoBooks[0].marketVerification.exactSecondSourceFound, true, 'exact independent price may remain visible as evidence while qualification fails closed');
assert.equal(onlyTwoBooks[0].marketVerification.referencePriorEligible, false, 'fewer than three books must never become an EV prior');
assert.equal(onlyTwoBooks[0].marketVerification.referenceNoVigProbability, null);
assert.match(onlyTwoBooks[0].marketVerification.priorIneligibleReason, /至少需要3家/);

const integerContract = verify(
  actual.map(row => ({ ...row, pick: row.pick.replace('8.5', '8平') })),
  independent.map(row => ({ ...row, pick: row.pick.replace('8.5', '8平') })),
);
assert.equal(integerContract[0].marketVerification.verified, false);
assert.equal(integerContract[0].marketVerification.referencePriorEligible, false, 'push/partial-settlement contracts require payoff-aware evidence');
assert.match(integerContract[0].marketVerification.priorIneligibleReason, /走水|部分輸贏/);

const exactlyFiveMinutes = verify(
  actual,
  independent.map(row => ({ ...row, lineAsOf: '2026-08-12T00:05:00Z' })),
);
assert.equal(exactlyFiveMinutes[0].marketVerification.verified, true, 'five-minute freshness boundary must remain inclusive');
assert.equal(exactlyFiveMinutes[0].marketVerification.referencePriorEligible, true);

const fiveMinutesOneSecond = verify(
  actual,
  independent.map(row => ({ ...row, lineAsOf: '2026-08-12T00:05:01Z' })),
);
assert.equal(fiveMinutesOneSecond[0].marketVerification.verified, false, 'five minutes and one second must be stale');
assert.equal(fiveMinutesOneSecond[0].marketVerification.referencePriorEligible, false);

const missingProviderEventId = verify(
  actual,
  independent.map(row => ({ ...row, providerEventId: '' })),
);
assert.equal(missingProviderEventId[0].marketVerification.referencePriorEligible, false, 'missing provider event identity must fail closed');
assert.match(missingProviderEventId[0].marketVerification.priorIneligibleReason, /場次|賽事|事件|event/i);

const mismatchedOppositeEvent = verify(actual, [
  { ...independent[0], providerEventId: 'event-over' },
  { ...independent[1], providerEventId: 'event-under' },
]);
assert.equal(mismatchedOppositeEvent[0].marketVerification.verified, false);
assert.equal(mismatchedOppositeEvent[0].marketVerification.exactSecondSourceFound, true, 'same-side exact source may remain visible as evidence');
assert.equal(mismatchedOppositeEvent[0].marketVerification.referencePriorEligible, false, 'opposite prices from another event must never create a no-vig pair');
assert.match(mismatchedOppositeEvent[0].marketVerification.priorIneligibleReason, /反方向|場次|賽事|事件/);

const consensusAgeBoundary = verify(actual, independent, Date.parse('2026-08-12T00:07:00Z'));
assert.equal(consensusAgeBoundary[0].marketVerification.referencePriorEligible, true, 'oldest consensus quote exactly five minutes old remains eligible');

const cachedConsensusStale = verify(actual, independent, Date.parse('2026-08-12T00:07:01Z'));
assert.equal(cachedConsensusStale[0].marketVerification.verified, false);
assert.equal(cachedConsensusStale[0].marketVerification.referencePriorEligible, false, 'cached reference evidence must be re-aged at verification time, not trusted from fetch-time freshness metadata');
assert.match(cachedConsensusStale[0].marketVerification.priorIneligibleReason, /5分鐘|過期|時間/);

const futureConsensus = independent.map(row => ({
  ...row,
  consensusOldestObservedAt: '2026-08-12T00:04:00Z',
  consensusNewestObservedAt: '2026-08-12T00:04:00Z',
  consensusTimeSpanMs: 0,
  consensusFreshnessMaxMs: 0,
}));
const futureSkewBoundary = verify(actual, futureConsensus, Date.parse('2026-08-12T00:02:30Z'));
assert.equal(futureSkewBoundary[0].marketVerification.referencePriorEligible, true, 'a provider timestamp exactly 90 seconds ahead remains within the clock-skew boundary');

const futureSkewBlocked = verify(actual, futureConsensus, Date.parse('2026-08-12T00:02:29Z'));
assert.equal(futureSkewBlocked[0].marketVerification.verified, false);
assert.equal(futureSkewBlocked[0].marketVerification.referencePriorEligible, false, 'reference timestamps more than 90 seconds in the future must fail closed');
assert.match(futureSkewBlocked[0].marketVerification.priorIneligibleReason, /未來|90秒|時間/);

console.log('Independent market verification V2.2: exact contract, unique-book threshold, synchronized no-vig prior and fail-closed gates PASS');
