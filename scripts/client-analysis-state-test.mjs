import assert from 'node:assert/strict';
import {
  advanceUnchangedReaderGame,
  actualLineFreshNow,
  coreSnapshotReusable,
  formalBetEligibility,
  gameIsPrestartNow,
  liveReaderHashMatches,
  liveReaderRevisionMatches,
  mergeReaderStatusHighWater,
  mergeRecognizedGameInputs,
  readerCoverageCounts,
  readerHashKey,
  readerRevisionKey,
  shouldAcceptReaderStatus,
  shouldAcknowledgeReaderHash,
  touchReaderHeartbeat,
  sameReaderGameMarkets,
} from '../lib/client-analysis-state.js';
import { attestIncomingMarketRows, signMarketRow, verifyMarketRow } from '../lib/market-integrity-v1.js';

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
assert.deepEqual(
  readerCoverageCounts({ rawGameCount: 11, matchedGameCount: 8, unopenedGameCount: 3, scheduleGameCount: 11 }),
  { total: 11, captured: 11, open: 8, waiting: 3, locked: 3, notRendered: 0 },
);
assert.deepEqual(
  readerCoverageCounts({ matchedGameCount: 8, scheduleGameCount: 11 }),
  { total: 11, captured: 8, open: 8, waiting: 3, locked: 0, notRendered: 3 },
);

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
assert.equal(
  readerRevisionKey('2026-08-15', sameBoardBeforeHeartbeat.payloadHash, sameBoardBeforeHeartbeat.pageActivityAt),
  readerRevisionKey('2026-08-15', sameBoardAfterHeartbeat.payloadHash, sameBoardAfterHeartbeat.pageActivityAt),
  'Reader heartbeat must not become a new market-content revision',
);
assert.equal(liveReaderRevisionMatches('2026-08-15', sameBoardAfterHeartbeat, 'same-board', sameBoardBeforeHeartbeat.pageActivityAt), true);
assert.equal(liveReaderRevisionMatches('2026-08-15', sameBoardAfterHeartbeat, 'same-board', heartbeatAt), true);
assert.equal(actualLineFreshNow({ ...eligible, lineAsOf: sameBoardBeforeHeartbeat.pageActivityAt }, Date.parse(heartbeatAt)), false);
assert.equal(actualLineFreshNow({ ...eligible, lineAsOf: heartbeatAt }, Date.parse(heartbeatAt) + 1), true);
const heartbeatT3 = { ...sameBoardAfterHeartbeat, receivedAt: '2026-08-15T08:07:00.000Z', pageActivityAt: '2026-08-15T08:07:00.000Z' };
assert.equal(
  liveReaderRevisionMatches('2026-08-15', heartbeatT3, 'same-board', heartbeatAt),
  true,
  'same-content Reader heartbeats must match without forcing another reprice',
);

const heartbeatItem = {
  readerPayloadHash: 'same-board',
  actualSource: { provider: 'TAI888_READER_AUTO', pageActivityAt: sameBoardBeforeHeartbeat.pageActivityAt },
  customMarkets: [{ market: '全場讓分', lineAsOf: sameBoardBeforeHeartbeat.pageActivityAt, marketSignature: 'immutable-signature' }],
  customData: { context: {
    fetchedAt: '2026-08-15T08:00:00.000Z',
    game: { gameDate: '2026-08-15T12:00:00.000Z' },
    away: { lineup: { official: true }, bullpen: { status: 'CONFIRMED' } },
    home: { lineup: { official: true }, bullpen: { status: 'CONFIRMED' } },
    weather: { roofConfirmed: true },
  }, analysis: { results: [
    { sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', lineAsOf: sameBoardBeforeHeartbeat.pageActivityAt, formulaDiagnosticScore: 7.4 },
    { sourceType: 'REFERENCE', provider: 'OTHER', lineAsOf: sameBoardBeforeHeartbeat.pageActivityAt },
  ] } },
};
const heartbeatTouched = touchReaderHeartbeat(heartbeatItem, 'same-board', heartbeatAt);
assert.equal(heartbeatTouched.customMarkets[0].lineAsOf, sameBoardBeforeHeartbeat.pageActivityAt, 'heartbeat不得竄改已簽章盤口截點');
assert.equal(heartbeatTouched.customMarkets[0].marketSignature, 'immutable-signature', 'heartbeat不得讓下一次reprice收到失效簽章');
assert.equal(heartbeatTouched.customData.analysis.results[0].lineAsOf, sameBoardBeforeHeartbeat.pageActivityAt, 'heartbeat不得竄改PIT分析盤口截點');
assert.equal(heartbeatTouched.customData.analysis.results[0].readerLiveAsOf, heartbeatAt, 'Reader存活時間必須與不可變盤口截點分欄');
assert.equal(actualLineFreshNow({ ...heartbeatTouched.customData.analysis.results[0], lineFresh: true }, Date.parse(heartbeatAt) + 1), true, '存活時間可刷新執行資格但不得竄改PIT截點');
assert.equal(heartbeatTouched.customData.analysis.results[0].formulaDiagnosticScore, 7.4, 'heartbeat refresh must preserve the completed score');
assert.equal(heartbeatTouched.customData.analysis.results[1].lineAsOf, sameBoardBeforeHeartbeat.pageActivityAt, 'heartbeat must not rewrite independent reference evidence');
assert.equal(touchReaderHeartbeat(heartbeatItem, 'different-board', heartbeatAt), heartbeatItem, 'a different market hash must not refresh old rows');

process.env.MARKET_INTEGRITY_SECRET = 'client-heartbeat-signature-regression-secret';
const signedGame = {
  league: 'MLB', leagueId: 'MLB', gamePk: 12345, gameDate: '2026-08-15T12:00:00.000Z',
  officialDate: '2026-08-15', gameNumber: 1, awayTeamId: 1, homeTeamId: 2,
};
const signedBefore = await signMarketRow('MLB', signedGame, {
  market: '全場大小', pick: '大8平', water: 0.94, sourceType: 'ACTUAL_TW_CREDIT',
  provider: 'TAI888_READER_AUTO', executable: true, lineAsOf: sameBoardBeforeHeartbeat.pageActivityAt,
});
const signedHeartbeatItem = touchReaderHeartbeat({
  ...heartbeatItem,
  customMarkets: [signedBefore],
}, 'same-board', heartbeatAt);
assert.equal(await verifyMarketRow('MLB', signedGame, signedHeartbeatItem.customMarkets[0]), true, '同內容心跳後舊盤簽章仍須有效');
const signedAfter = await signMarketRow('MLB', signedGame, {
  ...signedBefore, water: 0.95, lineAsOf: heartbeatAt,
  marketSignature: undefined, marketSignatureVersion: undefined,
});
const attestedAfterMove = await attestIncomingMarketRows('MLB', signedGame, [signedHeartbeatItem.customMarkets[0], signedAfter]);
assert.equal(attestedAfterMove.length, 2, '同內容心跳後再變盤，reprice的新舊盤簽章都必須可驗證');

const oldGameMarkets = [
  { market: '全場讓分', pick: '客隊讓1+50', water: 0.95, lineAsOf: sameBoardBeforeHeartbeat.pageActivityAt },
  { market: '全場讓分', pick: '主隊受讓1+50', water: 0.93, lineAsOf: sameBoardBeforeHeartbeat.pageActivityAt },
];
const sameGameMarkets = [
  { market: '全場讓分', pick: '主隊受讓1+50', water: '0.930', lineAsOf: heartbeatAt },
  { market: '全場讓分', pick: '客隊讓1+50', water: '0.950', lineAsOf: heartbeatAt },
];
assert.equal(sameReaderGameMarkets(oldGameMarkets, sameGameMarkets), true, 'timestamps and row order must not change a single-game market revision');
assert.equal(sameReaderGameMarkets(oldGameMarkets, [{ ...sameGameMarkets[0], water: 0.92 }, sameGameMarkets[1]]), false, 'a changed price must require reprice');
const advanced = advanceUnchangedReaderGame({
  ...heartbeatItem,
  readerPayloadHash: 'old-whole-board',
  customMarkets: oldGameMarkets,
}, sameGameMarkets, 'new-whole-board', heartbeatAt, NOW);
assert.equal(advanced.readerPayloadHash, 'new-whole-board', 'an unchanged game must advance across an unrelated whole-board revision');
assert.equal(advanced.customData.analysis.results[0].lineAsOf, sameBoardBeforeHeartbeat.pageActivityAt, '跨全盤revision但同場未變時仍保留原PIT盤口截點');
assert.equal(advanced.customData.analysis.results[0].readerLiveAsOf, heartbeatAt);
assert.equal(advanceUnchangedReaderGame({ ...heartbeatItem, customMarkets: oldGameMarkets }, [
  { ...sameGameMarkets[0], water: 0.92 }, sameGameMarkets[1],
], 'new-whole-board', heartbeatAt, NOW), null, 'changed game markets must not reuse old analysis');
assert.equal(coreSnapshotReusable({ ...heartbeatItem, restoredFromCache: true }, NOW), false, 'browser-restored analysis must rebuild its missing frozen core');
assert.equal(coreSnapshotReusable({ ...heartbeatItem, customData: { ...heartbeatItem.customData, context: { ...heartbeatItem.customData.context, fetchedAt: '2026-08-15T06:00:00.000Z' } } }, NOW), false, 'expired core must not be marked current just because Reader prices are unchanged');
assert.equal(advanceUnchangedReaderGame({
  ...heartbeatItem,
  customMarkets: oldGameMarkets,
  customData: { ...heartbeatItem.customData, context: { ...heartbeatItem.customData.context, fetchedAt: '2026-08-15T06:00:00.000Z' } },
}, sameGameMarkets, 'new-whole-board', heartbeatAt, NOW), null, 'unchanged Reader prices must not short-circuit an expired core rebuild');

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
