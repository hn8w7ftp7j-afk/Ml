import assert from 'node:assert/strict';
import { normalizeMlbFinalResult } from '../lib/mlb.js';
import { validateLeagueFinalResult } from '../lib/league-provider.js';
import { settleBetTicketFromResult } from '../lib/bet-settlement-service.js';

// Minimal, unchanged fields observed by official GET on 2026-11-07:
// https://statsapi.mlb.com/api/v1.1/game/823490/feed/live
// The official /api/v1/gameStatus catalog also classifies CR as abstract Final.
// This is public result evidence, without any Production ticket or wager data.
const cancelledFeed = {
  gamePk: 823490,
  metaData: { timeStamp: '20261107_222820' },
  gameData: {
    game: { pk: 823490, type: 'R', doubleHeader: 'N', gameNumber: 1 },
    datetime: { officialDate: '2026-09-27', originalDate: '2026-09-27', dateTime: '2026-09-27T17:05:00Z' },
    status: { abstractGameState: 'Final', codedGameState: 'C', detailedState: 'Cancelled: Rain',
      statusCode: 'CR', startTimeTBD: false, reason: 'Rain', abstractGameCode: 'F' },
    teams: {
      away: { id: 110, name: 'Baltimore Orioles' },
      home: { id: 147, name: 'New York Yankees' },
    },
  },
  liveData: { linescore: { scheduledInnings: 9, teams: { away: {}, home: {} }, innings: [] } },
};
const ticket = { id: 'synthetic-abnormal-review', league: 'MLB', gamePk: 823490, status: 'OPEN',
  officialDate: '2026-09-27', away: 'Baltimore Orioles', home: 'New York Yankees',
  market: '全場大小', pick: '大3平', water: 0.95, stake: 100 };
const before = structuredClone(cancelledFeed);
const cancelled = normalizeMlbFinalResult(cancelledFeed, 823490);
assert.equal(cancelled.final, false, 'abstract Final cancellation is not a played final');
assert.equal(cancelled.statusEnglish, 'Cancelled: Rain');
assert.deepEqual(cancelled.officialStatus, cancelledFeed.gameData.status);
assert.notEqual(cancelled.officialStatus, cancelledFeed.gameData.status, 'preserve a detached official status snapshot');
assert.equal(cancelled.providerRevision, '20261107_222820');
assert.equal(cancelled.awayRuns, null);
assert.equal(cancelled.homeRuns, null);
assert.equal(cancelled.first5Complete, false);
assert.equal(cancelled.awayFirst5, null);
assert.equal(cancelled.homeFirst5, null);
assert.deepEqual(cancelledFeed, before, 'official feed is not mutated');

const validated = validateLeagueFinalResult('MLB', 823490, cancelled, { date: '2026-09-27' });
const reviewed = settleBetTicketFromResult(ticket, validated);
assert.equal(reviewed.status, 'MANUAL_REVIEW');
assert.equal(reviewed.settlement, undefined, 'an official cancellation cannot create a payout or void');
assert.equal(reviewed.lastResultError, null, 'a known cancellation is not a missing-score provider failure');
assert.match(reviewed.settlementError, /不是正常完賽.*人工確認/);
assert.deepEqual(reviewed.resultSnapshot.officialStatus, cancelledFeed.gameData.status);
assert.equal(ticket.status, 'OPEN', 'pure review does not mutate the original ticket');

// Other explicit official abnormal states keep their detail and manual-review
// policy, even if the source has an abstract Final and partial score evidence.
for (const [detail, code, statusCode] of [
  ['Postponed: Rain', 'D', 'DR'],
  ['Suspended: Rain', 'U', 'UR'],
  ['Forfeit', 'Q', 'Q'],
]) {
  const feed = structuredClone(cancelledFeed);
  Object.assign(feed.gameData.status, { detailedState: detail, codedGameState: code, statusCode });
  feed.liveData.linescore.teams = { away: { runs: 2 }, home: { runs: 1 } };
  feed.liveData.linescore.innings = [{ num: 1, away: { runs: 2 }, home: { runs: 1 } }];
  const result = normalizeMlbFinalResult(feed, feed.gamePk);
  assert.equal(result.final, false, detail);
  assert.equal(result.statusEnglish, detail);
  assert.deepEqual(result.officialStatus, feed.gameData.status);
  assert.equal(result.awayRuns, null, 'partial scores are not certified as a full result');
  assert.equal(result.homeRuns, null);
  const next = settleBetTicketFromResult(ticket, validateLeagueFinalResult('MLB', feed.gamePk, result));
  assert.equal(next.status, 'MANUAL_REVIEW', detail);
  assert.equal(next.settlement, undefined, detail);
}

// Synthetic ordinary played-final counterexamples verify the existing strict
// final-score, innings, first-five, identity and date boundaries still apply.
const normalFeed = structuredClone(cancelledFeed);
normalFeed.gameData.status = { abstractGameState: 'Final', codedGameState: 'F', detailedState: 'Final', statusCode: 'F' };
normalFeed.liveData.linescore.teams = { away: { runs: 3 }, home: { runs: 1 } };
normalFeed.liveData.linescore.innings = Array.from({ length: 9 }, (_, index) => ({
  num: index + 1, away: { runs: index === 0 ? 3 : 0 }, home: { runs: index === 5 ? 1 : 0 },
}));
const normal = normalizeMlbFinalResult(normalFeed, normalFeed.gamePk);
assert.equal(normal.final, true);
assert.deepEqual([normal.awayRuns, normal.homeRuns, normal.awayFirst5, normal.homeFirst5], [3, 1, 3, 0]);
assert.equal(normal.first5Complete, true);
assert.equal(settleBetTicketFromResult(ticket, validateLeagueFinalResult('MLB', normalFeed.gamePk, normal)).status, 'SETTLED');
for (const change of [
  feed => { delete feed.liveData.linescore.teams.away.runs; },
  feed => { feed.liveData.linescore.innings = feed.liveData.linescore.innings.slice(0, 7); },
  feed => { feed.liveData.linescore.teams.home.runs = 3; },
]) {
  const feed = structuredClone(normalFeed); change(feed);
  assert.throws(() => normalizeMlbFinalResult(feed, feed.gamePk), { code: 'OFFICIAL_FINAL_RESULT_INVALID' });
}
const missingFirst5 = structuredClone(normalFeed);
delete missingFirst5.liveData.linescore.innings[1].home.runs;
const fullOnly = normalizeMlbFinalResult(missingFirst5, missingFirst5.gamePk);
assert.equal(fullOnly.final, true);
assert.equal(fullOnly.first5Complete, false);
assert.equal(fullOnly.homeFirst5, null);
assert.throws(() => normalizeMlbFinalResult(cancelledFeed, 823491), { code: 'OFFICIAL_IDENTITY_MISMATCH' });
assert.throws(() => validateLeagueFinalResult('MLB', 823490, cancelled, { date: '2026-09-26' }),
  { code: 'OFFICIAL_IDENTITY_MISMATCH' }, 'abnormal-state classification cannot bypass saved-date identity');

const delayedFeed = structuredClone(normalFeed);
delayedFeed.gameData.status = { abstractGameState: 'Live', detailedState: 'Delayed: Rain', statusCode: 'IR' };
const delayed = normalizeMlbFinalResult(delayedFeed, delayedFeed.gamePk);
assert.equal(delayed.final, false);
assert.equal(settleBetTicketFromResult(ticket, delayed).status, 'OPEN', 'a live weather delay is not a cancellation');

console.log('PASS MLB official CR cancellation and abnormal-state classification: preserved raw status, manual review without payout/void, ordinary final and strict identity/score/innings counterexamples; no Production writes');
