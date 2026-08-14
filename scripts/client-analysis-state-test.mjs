import assert from 'node:assert/strict';
import {
  actualLineFreshNow,
  formalBetEligibility,
  gameIsPrestartNow,
  liveReaderHashMatches,
  liveReaderRevisionMatches,
  mergeReaderStatusHighWater,
  mergeRecognizedGameInputs,
  readerHashKey,
  readerRevisionKey,
  shouldAcceptReaderStatus,
  shouldAcknowledgeReaderHash,
} from '../lib/client-analysis-state.js';

const NOW = Date.parse('2026-08-15T08:00:00.000Z');
const LINE_AT = Date.parse('2026-08-15T07:59:00.000Z');
const eligible = {
  sourceType: 'ACTUAL_TW_CREDIT', water: 0.95, waterEstimated: false,
  executable: true, lineFresh: true, lineAsOf: '2026-08-15T07:59:00.000Z', score: 7.2, betEligible: true,
  scoreAudit: { ok: true }, pairAudit: { passed: true }, thirdAudit: { passed: true },
};
assert.equal(formalBetEligibility(eligible, 7.2, NOW).passed, true);
for (const mutation of [
  { lineFresh: false }, { executable: false }, { betEligible: false },
  { scoreAudit: { ok: false } }, { pairAudit: null }, { thirdAudit: null },
]) assert.equal(formalBetEligibility({ ...eligible, ...mutation }, 7.2, NOW).passed, false);
assert.equal(actualLineFreshNow(eligible, LINE_AT + 5 * 60 * 1000), true);
assert.equal(actualLineFreshNow(eligible, LINE_AT + 5 * 60 * 1000 + 1), false);
assert.equal(formalBetEligibility(eligible, 7.2, LINE_AT + 5 * 60 * 1000 + 1).passed, false);

const futureGame = { gameDate: '2026-08-15T08:01:00.000Z', statusCode: 'S', statusEnglish: 'Scheduled' };
assert.equal(gameIsPrestartNow(futureGame, NOW), true);
assert.equal(gameIsPrestartNow(futureGame, Date.parse(futureGame.gameDate)), false);
assert.equal(gameIsPrestartNow({ ...futureGame, statusCode: 'I', statusEnglish: 'In Progress' }, NOW), false);
assert.equal(gameIsPrestartNow({ ...futureGame, gameDate: '' }, NOW), false);

assert.equal(readerHashKey('2026-08-15', 'abc'), '2026-08-15:abc');
assert.equal(shouldAcknowledgeReaderHash({ payloadHash: 'abc', expectedCount: 2, completedCount: 2 }), true);
assert.equal(shouldAcknowledgeReaderHash({ payloadHash: 'abc', expectedCount: 2, completedCount: 1 }), false);
assert.equal(shouldAcknowledgeReaderHash({ payloadHash: 'abc', expectedCount: 2, completedCount: 2, failedCount: 1 }), false);

const h1 = { fresh: true, boardDate: '2026-08-15', payloadHash: 'h1', receivedAt: '2026-08-15T08:00:00.000Z' };
const h2 = { fresh: true, boardDate: '2026-08-15', payloadHash: 'h2', receivedAt: '2026-08-15T08:00:01.000Z' };
assert.equal(shouldAcceptReaderStatus(h1, h2), true);
assert.equal(shouldAcceptReaderStatus(h2, h1), false);
assert.equal(shouldAcceptReaderStatus(h2, { fresh: false, message: 'stale' }), true);
assert.equal(shouldAcceptReaderStatus({ ...h2, fresh: false }, h1), false);
const missing = { fresh: false, boardDate: '2026-08-15', payloadHash: null, receivedAt: null, message: 'missing' };
const highWaterAfterMissing = mergeReaderStatusHighWater(h2, missing);
assert.equal(highWaterAfterMissing.payloadHash, 'h2');
assert.equal(highWaterAfterMissing.receivedAt, h2.receivedAt);
assert.equal(shouldAcceptReaderStatus(highWaterAfterMissing, h1), false);
assert.equal(liveReaderHashMatches('2026-08-15', h2, 'h2'), true);
assert.equal(liveReaderHashMatches('2026-08-15', h2, 'h1'), false);
assert.equal(liveReaderHashMatches('2026-08-16', h2, 'h2'), false);
assert.equal(liveReaderHashMatches('2026-08-15', { ...h2, fresh: false }, 'h2'), false);

const heartbeatAt = '2026-08-15T08:06:00.000Z';
const sameBoardBeforeHeartbeat = { ...h2, payloadHash: 'same-board', pageActivityAt: '2026-08-15T08:00:00.000Z' };
const sameBoardAfterHeartbeat = { ...sameBoardBeforeHeartbeat, receivedAt: heartbeatAt, pageActivityAt: heartbeatAt };
assert.notEqual(
  readerRevisionKey('2026-08-15', sameBoardBeforeHeartbeat.payloadHash, sameBoardBeforeHeartbeat.pageActivityAt),
  readerRevisionKey('2026-08-15', sameBoardAfterHeartbeat.payloadHash, sameBoardAfterHeartbeat.pageActivityAt),
);
assert.equal(liveReaderRevisionMatches('2026-08-15', sameBoardAfterHeartbeat, 'same-board', sameBoardBeforeHeartbeat.pageActivityAt), false);
assert.equal(liveReaderRevisionMatches('2026-08-15', sameBoardAfterHeartbeat, 'same-board', heartbeatAt), true);
assert.equal(actualLineFreshNow({ ...eligible, lineAsOf: sameBoardBeforeHeartbeat.pageActivityAt }, Date.parse(heartbeatAt)), false);
assert.equal(actualLineFreshNow({ ...eligible, lineAsOf: heartbeatAt }, Date.parse(heartbeatAt) + 1), true);
const heartbeatT3 = { ...sameBoardAfterHeartbeat, receivedAt: '2026-08-15T08:07:00.000Z', pageActivityAt: '2026-08-15T08:07:00.000Z' };
assert.equal(
  liveReaderRevisionMatches('2026-08-15', heartbeatT3, 'same-board', heartbeatAt),
  false,
  'a T2 reprice response must not acknowledge after live status has advanced to T3',
);

const game = { gamePk: 123, away: '客隊', home: '主隊' };
const merged = mergeRecognizedGameInputs([
  { game, markets: [{ market: '全場讓分', pick: '客隊讓1+50', water: 0.95, confidence: 1 }, { market: '全場讓分', pick: '主隊受讓1+50', water: null, confidence: 1 }] },
  { game, markets: [{ market: '全場讓分', pick: '主隊受讓1+50', water: 0.93, confidence: 0.9 }, { market: '全場大小', pick: '大8+50', water: 0.94 }, { market: '全場大小', pick: '小8+50', water: 0.94 }] },
]);
assert.equal(merged.games.length, 1);
assert.equal(merged.games[0].markets.length, 4);
assert.equal(merged.games[0].markets.find(row => row.pick === '主隊受讓1+50').water, 0.93);

const conflict = mergeRecognizedGameInputs([
  { game, markets: [{ market: '全場大小', pick: '大8+50', water: 0.94 }, { market: '全場大小', pick: '小8+50', water: 0.94 }] },
  { game, markets: [{ market: '全場大小', pick: '大8+50', water: 0.91 }, { market: '全場大小', pick: '小8+50', water: 0.94 }] },
]);
assert.equal(conflict.games.length, 0);
assert.equal(conflict.conflicts.length, 1);

console.log('client analysis state: strict QA, retryable Reader hashes and same-game merge PASS');
