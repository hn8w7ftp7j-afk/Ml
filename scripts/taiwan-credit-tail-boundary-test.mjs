import assert from 'node:assert/strict';
import { parseTaiwanContract, settleTaiwanContract, settlementProfit, mirrorSettlementAudit } from '../lib/taiwan-settlement-v9.js';
import { settleBetTicketFromResult } from '../lib/bet-settlement-service.js';

const away = '客隊', home = '主隊';
const score = { final: true, awayRuns: 1, homeRuns: 2, awayFirst5: 1, homeFirst5: 2, first5Complete: true };

// This is an original-contract validation boundary. Unsupported values cannot
// be rounded or clamped into another ticket, even away from the exact line.
for (const percent of [101, 150, 999]) for (const sign of ['+', '-']) {
  const picks = [`${home}讓1${sign}${percent}`, `${away}受讓1${sign}${percent}`, `大3${sign}${percent}`, `小3${sign}${percent}`];
  for (const pick of picks) {
    const parsed = parseTaiwanContract(pick);
    assert.equal(parsed.valid, false, pick);
    assert.equal(parsed.rawText, pick, 'the original unsupported contract stays readable');
    assert.equal(parsed.tailPercent, percent, 'invalid input must not be silently capped to 100');
    for (const [awayScore, homeScore] of [[1, 2], [0, 0], [0, 10]]) {
      assert.equal(settleTaiwanContract(pick, awayScore, homeScore, away, home), null, `${pick}: ${awayScore}-${homeScore}`);
      assert.equal(settleTaiwanContract(parsed, awayScore, homeScore, away, home), null, 'parsed invalid contracts also fail closed');
    }
    for (const league of ['MLB', 'NPB', 'KBO', 'CPBL']) for (const half of [false, true]) {
      const original = { id: 'unsupported-credit-tail', league, gamePk: 123, status: 'OPEN',
        market: `${half ? '上半' : '全場'}${/^[大小]/.test(pick) ? '大小' : '讓分'}`,
        pick, away, home, water: 0.95, stake: 10_000 };
      const before = structuredClone(original);
      const result = settleBetTicketFromResult(original, score);
      assert.equal(result.status, 'MANUAL_REVIEW', `${league}/${original.market}/${pick}`);
      assert.equal(result.settlement, undefined, 'unsupported tails cannot create any financial settlement');
      assert.equal(result.pick, pick);
      assert.deepEqual(original, before, 'original ticket is immutable');
    }
  }
  assert.equal(mirrorSettlementAudit(picks[0], picks[1], 1, 2, away, home).ok, false);
}

// Independent fixed examples retain the confirmed payoff and rebate policies.
// Columns are profit at 1% football rebate and 1.5% baseball/NBA rebate,
// with stake 10,000 and original water 0.75.
const expectedProfits = new Map([
  [0, [0, 0]], [0.2, [1520, 1530]], [-0.2, [-1980, -1970]],
  [0.5, [3800, 3825]], [-0.5, [-4950, -4925]],
  [1, [7600, 7650]], [-1, [-9900, -9850]],
]);
for (const percent of [0, 20, 50, 100]) for (const sign of ['+', '-']) {
  const expected = (sign === '+' ? 1 : -1) * percent / 100;
  const signedFraction = Object.is(expected, -0) ? 0 : expected;
  const giving = `${home}讓1${sign}${percent}`, receiving = `${away}受讓1${sign}${percent}`;
  for (const [pick, fraction] of [[giving, signedFraction], [receiving, -signedFraction],
    [`大3${sign}${percent}`, signedFraction], [`小3${sign}${percent}`, -signedFraction]]) {
    const parsed = parseTaiwanContract(pick), settlement = settleTaiwanContract(pick, 1, 2, away, home);
    assert.equal(parsed.valid, true, pick);
    assert.equal(parsed.tailPercent, percent);
    assert.equal(settlement.netFraction, Object.is(fraction, -0) ? 0 : fraction);
    assert.equal(settlement.coverage, 1);
    for (const [index, rebateRate] of [0.01, 0.015].entries()) {
      const payout = settlementProfit({ stake: 10_000, water: 0.75, settlement, rebateRate });
      assert.equal(payout.profit, expectedProfits.get(fraction)[index], `${pick}/${rebateRate}`);
    }
  }
  assert.equal(mirrorSettlementAudit(giving, receiving, 1, 2, away, home).ok, true);
}
for (const pick of [`${home}讓1平`, `${home}讓0.5`, '大3.5', '小3平', `${home}讓1/1.5+50`]) {
  assert.equal(parseTaiwanContract(pick).valid, true, 'supported flat, half-point and explicit split contracts stay valid');
}
const mixed = settleTaiwanContract(`${home}讓1/1.5+50`, 1, 2, away, home);
assert.equal(mixed.winFraction, 0.25); assert.equal(mixed.lossFraction, 0.5); assert.equal(mixed.pushFraction, 0.25);
assert.equal(settlementProfit({ stake: 10_000, water: 0.95, settlement: mixed, rebateRate: 0.015 }).profit, -2512.5);

console.log('PASS original Taiwan credit tails: unsupported ±101/150/999 rejected without clamping, all baseball ticket/period paths remain un-settled, valid 0/20/50/100 and split/mirror payoffs plus 1%/1.5% rebates unchanged; NOT Production');
