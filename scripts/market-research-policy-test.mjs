import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marketResearchPolicy, isResearchOnlyMarket } from '../lib/market-research-policy.js';
import { BET_ORDER_MIN_SCORE, buildBetOrderEntries } from '../lib/bet-order.js';
import { bindVerifiedReaderContractsForItem } from '../lib/client-analysis-state.js';
import { evaluateBetAction } from '../lib/bet-action-state-v118.js';

const game = Object.freeze({ leagueId: 'MLB', gamePk: 101, gameDate: '2099-09-12T10:00:00.000Z' });
const row = Object.freeze({
  market: '全場大小', pick: '大8+50', direction: 'OVER', slotId: 'FULL_TOTAL_OVER',
  segment: 'FULL', marketType: 'TOTAL', score: 8.4, rankingQualified: true,
  weightedEV: 0.1471, rawWeightedEV: 0.1471, robustEV: 0.0885, rawRobustEV: 0.0885,
});
const policy = marketResearchPolicy(row, game);
assert.ok(Object.isFrozen(policy));
assert.equal(policy.id, 'MLB_FULL_TOTAL_OVER_RESEARCH_ONLY');
assert.equal(policy.candidateEligible, false);
assert.equal(policy.preserveAnalysis, true);
assert.equal(policy.preserveLedger, true);
assert.equal(policy.market, '全場大小');
assert.equal(policy.direction, 'over');
assert.throws(() => { policy.candidateEligible = true; }, TypeError);

const positiveCases = [
  [{ market: '全場大小', pick: '大8平' }, game],
  [{ market: '全場大小', pick: ' over 8.5 ' }, { league: 'mlb' }],
  [{ market: '全场大小', direction: 'over', leagueId: ' MLB ' }],
  [{ market: 'FULL_TOTAL', direction: '大分', league: 'MLB' }],
  [{ market: 'FULL_GAME_TOTAL', selection: 'OVER', leagueCode: 'MLB' }],
  [{ market: 'TOTAL', period: 'FULL_GAME', direction: 'OVER', leagueId: 'MLB' }],
  [{ marketType: 'TOTAL', segment: 'FULL', direction: 'over', leagueId: 'MLB' }],
  [{ marketFamily: 'TOTAL', period: 'FULL_GAME', direction: 'over', leagueId: 'MLB' }],
  [{ slotId: 'FULL_TOTAL_OVER', leagueId: 'MLB' }],
  [{ directionSlotId: 'FULL_TOTAL_OVER', league: 'MLB' }],
  [{ row, item: { game }, market: row.market, pick: row.pick, score: row.score }],
  [{ row, item: { game: { gamePk: 101 }, customData: { analysis: { leagueId: 'MLB' } } } }],
  [{ market: row.market, pick: row.pick, game }],
  [{ row: { ...row, game } }],
];
for (const [value, context] of positiveCases) {
  const before = structuredClone(value);
  assert.equal(marketResearchPolicy(value, context), policy, JSON.stringify(value));
  assert.equal(isResearchOnlyMarket(value, context), true);
  assert.deepEqual(value, before, 'policy may not mutate input snapshots');
}

const negativeCases = [
  [null, game], [undefined, game], [[], game], [{}, game],
  [{ market: '全場大小', pick: '大8平' }], // no league default
  [{ ...row, leagueId: '' }],
  [{ ...row, leagueId: 'NOT_MLB' }],
  ...['NPB', 'KBO', 'CPBL', 'NBA', 'NHL'].map(leagueId => [row, { leagueId }]),
  [{ market: '上半大小', pick: '大4平' }, game],
  [{ slotId: 'FIRST5_TOTAL_OVER' }, game],
  [{ marketType: 'TOTAL', period: 'FIRST5', direction: 'over' }, game],
  [{ marketType: 'TOTAL', period: 'F5', direction: 'over' }, game],
  [{ market: '全場大小', pick: '小8平' }, game],
  [{ slotId: 'FULL_TOTAL_UNDER' }, game],
  [{ market: '全場讓分', pick: '大都會讓1平' }, game],
  [{ market: '全場大小與上半大小', pick: '大8平' }, game],
  [{ market: '全場大小', pick: '大都會讓1平' }, game],
  [{ market: '全場大小', pick: '大8錯字' }, game],
  [{ market: '全場大小' }, game],
  [{ marketType: 'TOTAL', direction: 'OVER' }, game], // total is not inherently full-game
  [{ period: 'FULL', direction: 'OVER' }, game], // full is not inherently a total
  [{ ...row, leagueId: 'MLB' }, { leagueId: 'NPB' }],
  [{ ...row, leagueId: 'MLB', league: 'CPBL' }],
  [{ ...row, leagueId: 'MLB', league: { id: 'MLB' } }],
  [{ row: { ...row, league: 'MLB' }, item: { game: { league: 'NPB' } } }],
  [{ row, item: { game, customData: { analysis: { leagueId: 'KBO' } } } }],
  [{ ...row, pick: '小8平' }, game],
  [{ ...row, direction: 'UNDER' }, game],
  [{ ...row, selection: 'UNDER' }, game],
  [{ ...row, market: '上半大小' }, game],
  [{ ...row, segment: 'FIRST5' }, game],
  [{ ...row, period: 'FIRST5' }, game],
  [{ ...row, marketType: 'RUNLINE' }, game],
  [{ ...row, marketFamily: 'RUNLINE' }, game],
  [{ ...row, directionSlotId: 'FIRST5_TOTAL_OVER' }, game],
  [{ ...row, slotId: 'FULL_TOTAL_OVER_GUESS' }, game],
  [{ row, market: '上半大小', item: { game } }],
  [{ row, pick: '小8平', item: { game } }],
];
for (const [value, context] of negativeCases) {
  assert.equal(marketResearchPolicy(value, context), null, JSON.stringify({ value, context }));
  assert.equal(isResearchOnlyMarket(value, context), false);
}

const entries = [
  { id: 'research', row, item: { game }, market: row.market, pick: row.pick, score: 8.4 },
  { id: 'under', row: { market: '全場大小', pick: '小8平' }, item: { game }, market: '全場大小', pick: '小8平', score: 7.1 },
  { id: 'first5', row: { slotId: 'FIRST5_TOTAL_OVER' }, item: { game }, market: '上半大小', pick: '大4平', score: 7.2 },
  { id: 'npb', item: { game: { ...game, leagueId: 'NPB' } }, market: '全場大小', pick: '大8平', score: 8.5 },
  { id: 'legacy-research', league: 'MLB', market: '全場大小', pick: '大8平', score: 8.6 },
  { id: 'low-score', item: { game }, market: '全場讓分', pick: '主隊讓1平', score: 6.9 },
  { id: 'qa-preserved', item: { game }, market: '上半大小', pick: '小4平', score: 7.0, rankingEligible: false, qaPassed: false },
];
const original = structuredClone(entries);
const ordered = buildBetOrderEntries(entries);
assert.equal(BET_ORDER_MIN_SCORE, 7.0, 'do not redefine the existing 7.0 display threshold');
assert.deepEqual(new Set(ordered.map(entry => entry.id)), new Set(['under', 'first5', 'npb', 'qa-preserved']));
assert.deepEqual(ordered.map(entry => entry.betOrderIndex), [1, 2, 3, 4]);
assert.equal(ordered.find(entry => entry.id === 'qa-preserved').qaPassed, false);
assert.deepEqual(entries, original, 'candidate omission must not modify raw scores or rankingQualified');
assert.deepEqual(buildBetOrderEntries(entries, { minimumScore: 8 }).map(entry => entry.id), ['npb']);
assert.deepEqual(buildBetOrderEntries(null), []);

// The policy cannot prevent honest recording, cancellation or re-recording of
// an actual user-placed bet. Use the existing ledger action path unchanged.
const actualRow = {
  market: '全場大小', pick: '大8+50', water: 0.95,
  sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO',
  readerGameMarketHash: 'game-market-hash', evCalibration: { actualReaderEligible: false },
};
const item = {
  status: 'done', analysisFailure: null, game,
  actualSource: { provider: 'TAI888_READER_AUTO' }, readerPayloadHash: 'reader-board-hash',
  readerProvenance: { provider: 'TAI888_READER_AUTO', payloadHash: 'reader-board-hash', readerGameMarketHash: 'game-market-hash' },
  customMarkets: [{ ...actualRow, executable: true }], customData: { pitPersistence: { confirmed: true } },
};
const [boundRow] = bindVerifiedReaderContractsForItem(item, [actualRow]);
const context = { item, row: boundRow, now: Date.parse('2099-09-12T00:00:00.000Z'), betsEnabled: true, cloudLedgerState: 'ready' };
assert.equal(isResearchOnlyMarket(boundRow, game), true);
assert.equal(evaluateBetAction(context).recordable, true);
assert.equal(evaluateBetAction({ ...context, latest: { status: 'OPEN' } }).kind, 'cancel');
assert.equal(evaluateBetAction({ ...context, latest: { status: 'OPEN' } }).disabled, false);
assert.equal(evaluateBetAction({ ...context, cancelled: { status: 'CANCELLED' } }).recordable, true);
assert.equal(evaluateBetAction({ ...context, latest: { status: 'WON' } }).text, '已下注 ✓');
assert.doesNotMatch(readFileSync(new URL('../lib/bet-action-state-v118.js', import.meta.url), 'utf8'), /market-research-policy/);

console.log(`Market research policy PASS: ${positiveCases.length} exact matches, ${negativeCases.length} isolation/conflict cases, immutable candidate filtering, unchanged recording/cancel/rebet`);
