import assert from 'node:assert/strict';
import { settleBetTicket, settleBetTicketFromResult, settleBetTickets } from '../lib/bet-settlement-service.js';

const base = { id: 'original-ticket', league: 'MLB', gamePk: 123, status: 'OPEN',
  market: '全場大小', pick: '大3平', away: '客隊', home: '主隊', water: 0.95, stake: 10_000 };
const result = { final: true, awayRuns: 3, homeRuns: 2, awayFirst5: 3, homeFirst5: 2, first5Complete: true };
const invalid = [undefined, null, '', ' ', NaN, Infinity, -Infinity, 0, -1, '0', '-1', 'NaN', true, false, [], [0.95], {}];

for (const league of ['MLB', 'NPB', 'KBO', 'CPBL']) for (const half of [false, true]) {
  for (const field of ['water', 'stake']) for (const value of invalid) {
    const original = { ...base, league, market: `${half ? '上半' : '全場'}大小`, [field]: value };
    const before = structuredClone(original);
    const settled = settleBetTicketFromResult(original, result);
    assert.equal(settled.status, 'MANUAL_REVIEW', `${league}/${original.market}/${field}=${String(value)}`);
    assert.equal(settled.settlement, null, 'missing original amounts must not invent a 0.95 price or a zero-principal settlement');
    assert.equal(settled.settlementError, field === 'water' ? '缺少有效的原始下注水位' : '缺少有效的原始下注本金');
    assert.deepEqual(original, before, 'the original contract and evidence are not mutated');
  }
}
// Even an apparent push cannot certify an incomplete original contract.
const pushResult = { ...result, awayRuns: 2, homeRuns: 1, awayFirst5: 2, homeFirst5: 1 };
for (const field of ['water', 'stake']) {
  assert.equal(settleBetTicketFromResult({ ...base, [field]: null }, pushResult).status, 'MANUAL_REVIEW');
}

// Decimal-string legacy originals remain valid. Exact existing payout and
// rebate rules are unchanged for full/partial win/loss and push.
const examples = [['大3平', result, 9650], ['大3+50', pushResult, 4825], ['大3-50', pushResult, -4925],
  ['大3平', pushResult, 0], ['大4平', pushResult, -9850]];
for (const [water, stake] of [[0.95, 10_000], ['0.95', '10000'], [' 0.95 ', ' 10000 ']]) {
  for (const [pick, scores, expectedProfit] of examples) {
    const original = { ...base, water, stake, pick };
    const settled = settleBetTicketFromResult(original, scores);
    assert.equal(settled.status, 'SETTLED');
    assert.equal(settled.settlement.netProfit, expectedProfit, `${pick}/${String(water)}/${String(stake)}`);
    assert.equal(settled.water, water); assert.equal(settled.stake, stake, 'saved original values remain unchanged');
  }
}
const fractionalStake = settleBetTicketFromResult({ ...base, water: 0.75, stake: 0.5 }, result);
assert.equal(fractionalStake.status, 'SETTLED');
assert.equal(fractionalStake.settlement.netProfit, 0.3825, 'positive finite fractional legacy principals are not rounded or capped');

for (const status of ['SETTLED', 'VOID', 'CANCELLED']) {
  const terminal = { ...base, status, water: null, stake: null, updatedAt: '2026-01-01T00:00:00Z' };
  assert.equal(settleBetTicketFromResult(terminal, result), terminal, 'terminal records are not silently reopened by this input-boundary repair');
  assert.equal(await settleBetTicket(terminal), terminal);
}
const postponed = settleBetTicketFromResult(base, { ...result, statusEnglish: 'Postponed' });
assert.equal(postponed.status, 'MANUAL_REVIEW'); assert.equal(postponed.settlement, undefined, 'abnormal-result policy remains manual review');

// Preserve an inconsistent OPEN record's stale financial evidence separately;
// it must not remain active or grow duplicate corrections on a second review.
const stale = { ...base, water: null, settlement: { netProfit: 9650 }, resultSnapshot: { source: 'old-unverified-result' } };
const staleBefore = structuredClone(stale), reviewed = settleBetTicketFromResult(stale, result);
assert.equal(reviewed.settlement, null); assert.equal(reviewed.settlementCorrections.length, 1);
assert.deepEqual(reviewed.settlementCorrections[0].settlement, staleBefore.settlement);
assert.deepEqual(reviewed.settlementCorrections[0].resultSnapshot, staleBefore.resultSnapshot);
assert.equal(settleBetTicketFromResult(reviewed, result).settlementCorrections.length, 1);
assert.deepEqual(stale, staleBefore);

const batch = await settleBetTickets([{ ...base, water: null }, { ...base, id: 'valid-original' }], { fetchResult: async () => result });
assert.deepEqual(batch.map(row => row.status), ['MANUAL_REVIEW', 'SETTLED']);
assert.equal(batch[0].settlement, null); assert.equal(batch[1].settlement.netProfit, 9650);

console.log('PASS shipped ticket settlement: missing/nonfinite/nonpositive/coerced original water or principal cannot fabricate 0.95 or zero-value SETTLED; valid legacy strings, partial/full/push/abnormal rules and immutable terminal/stale evidence preserved; NOT Production');
