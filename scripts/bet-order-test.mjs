import assert from 'node:assert/strict';
import { BET_ORDER_MIN_SCORE, buildBetOrderEntries, groupBetOrderEntries } from '../lib/bet-order.js';

const entry = ({ gamePk, gameDate, market, pick, score }) => ({
  item: { game: { leagueId: 'NPB', gamePk, gameDate } },
  gamePk,
  matchup: `客隊${gamePk} 對 主隊${gamePk}`,
  market,
  pick,
  score,
  rankingEligible: true,
});

const ordered = buildBetOrderEntries([
  entry({ gamePk: 2, gameDate: '2099-08-25T10:00:00.000Z', market: '全場讓分', pick: '晚場讓分', score: 8.5 }),
  entry({ gamePk: 1, gameDate: '2099-08-25T08:00:00.000Z', market: '上半大小', pick: '早場上半大小', score: 7.2 }),
  entry({ gamePk: 1, gameDate: '2099-08-25T08:00:00.000Z', market: '全場大小', pick: '早場全場大小低分', score: 7.1 }),
  entry({ gamePk: 1, gameDate: '2099-08-25T08:00:00.000Z', market: '全場讓分', pick: '早場讓分', score: 7.0 }),
  entry({ gamePk: 1, gameDate: '2099-08-25T08:00:00.000Z', market: '全場大小', pick: '早場全場大小高分', score: 8.0 }),
  entry({ gamePk: 1, gameDate: '2099-08-25T08:00:00.000Z', market: '上半讓分', pick: '早場上半讓分', score: 7.4 }),
  entry({ gamePk: 3, gameDate: null, market: '全場讓分', pick: '時間未定', score: 8.9 }),
  entry({ gamePk: 4, gameDate: '2099-08-25T07:00:00.000Z', market: '全場讓分', pick: '未達門檻', score: 6.9 }),
]);

assert.equal(BET_ORDER_MIN_SCORE, 7.0);
assert.deepEqual(ordered.map(row => row.pick), [
  '早場讓分',
  '早場全場大小高分',
  '早場全場大小低分',
  '早場上半讓分',
  '早場上半大小',
  '晚場讓分',
  '時間未定',
]);
assert.deepEqual(ordered.map(row => row.betOrderIndex), [1, 2, 3, 4, 5, 6, 7]);
assert.equal(ordered.at(-1).betOrderStartAt, null, '時間未定賽事必須排在最後');

const groups = groupBetOrderEntries(ordered);
assert.deepEqual(groups.map(group => group.gamePk), [1, 2, 3]);
assert.deepEqual(groups.map(group => group.entries.length), [5, 1, 1]);
assert.equal(groups[0].matchup, '客隊1 對 主隊1');

const blockedCandidate = buildBetOrderEntries([{
  ...entry({ gamePk: 5, gameDate: '2099-08-25T06:00:00.000Z', market: '全場讓分', pick: 'QA阻擋', score: 8.4 }),
  rankingEligible: false,
  qaPassed: false,
}]);
assert.equal(blockedCandidate.length, 1, '有7.0以上公式分數的方向即使 QA BLOCK 仍須出現在非推薦候選順序');
assert.equal(blockedCandidate[0].rankingEligible, false, '候選順序不得改寫原始排名資格');

const missingScoreCandidate = buildBetOrderEntries([{
  ...entry({ gamePk: 6, gameDate: '2099-08-25T05:00:00.000Z', market: '全場讓分', pick: '無公式分數', score: null }),
  rankingEligible: false,
}]);
assert.deepEqual(missingScoreCandidate, [], '缺少公式分數的方向不得進入候選順序');

console.log('Bet order: 7.0+ formula score, QA status preservation, start time, game grouping and market order PASS');
