import assert from 'node:assert/strict';
import {
  hydrateLineupBattingV13,
  mergePartialOfficialV13,
  parseOfficialLineupV13,
  projectLineupV13,
} from '../lib/mlb-context-v13.js';

const orders = Array.from({ length: 9 }, (_, index) => (index + 1) * 100);
const batter = (id, battingOrder, ops = 0.72) => ({
  person: { id, fullName: `Batter ${id}` },
  battingOrder,
  position: { abbreviation: 'OF' },
  seasonStats: { batting: { plateAppearances: 300, ops } },
});
const feed = (players, teamId = 1) => ({
  gameData: { teams: { away: { id: teamId }, home: { id: 2 } } },
  liveData: { boxscore: { teams: {
    away: { players: Object.fromEntries(players.map((row, index) => [`row${index}`, row])) },
    home: { players: {} },
  } } },
});
const starters = orders.map((order, index) => batter(100 + index, order));
const shape = lineup => lineup.players.map(row => ({ id: row.id, order: row.battingOrder }));
const assertLegal = (lineup, count) => {
  assert.equal(lineup.players.length, count);
  assert.equal(new Set(lineup.players.map(row => row.id)).size, count);
  assert.equal(new Set(lineup.players.map(row => row.battingOrder)).size, count);
  assert.ok(lineup.players.every(row => orders.includes(row.battingOrder)));
};

// The same pinch hitter appears in every recent game. Six appearances in slot
// 101 are still zero starts and cannot displace one of the nine starters.
const substituteFeeds = Array.from({ length: 6 }, () => feed([
  batter(1, 101, 1.1), batter(2, 102), batter(3, 901), batter(4, 0), ...starters,
]));
const unchangedInput = structuredClone(substituteFeeds);
const projected = projectLineupV13(substituteFeeds, 1, 0.72);
assertLegal(projected, 9);
assert.deepEqual(projected.players.map(row => row.id), starters.map(row => row.person.id));
assert.equal(projected.offensiveIndex, 1);
assert.equal(projected.official, false);
assert.equal(projected.identityStatus, 'PROJECTED');
assert.equal(projected.sampleGames, 6);
assert.deepEqual(substituteFeeds, unchangedInput, 'projection must not rewrite the source feeds');
assert.deepEqual(shape(parseOfficialLineupV13(substituteFeeds[0], 1, 0.72)), shape(projected));
assert.equal(projectLineupV13(substituteFeeds, 99, 0.72).players.length, 0, 'an unrelated team has no lineup');

// Counterexample for independent mean-rounding: reversing all nine slots
// makes many hitters round to the same middle slot.
const reversed = starters.map((row, index) => ({ ...row, battingOrder: (9 - index) * 100 }));
const colliding = projectLineupV13([feed(starters), feed(reversed)], 1, 0.72);
assertLegal(colliding, 9);
assert.deepEqual(colliding.players.map(row => row.battingOrder), orders);
assert.deepEqual(shape(colliding), shape(projectLineupV13([
  feed([...starters].reverse()), feed([...reversed].reverse()),
], 1, 0.72)), 'object iteration order cannot resolve projection ties');

// Independent exhaustive oracle for the slot objective, including an incomplete
// lineup. Unknown places must remain empty instead of collapsing to 1..N.
const threeNew = [batter(20, 100), batter(21, 200), batter(22, 300)];
const threeOld = [batter(20, 300), batter(21, 200), batter(22, 100)];
const means = threeNew.map((row, index) => (row.battingOrder + threeOld[index].battingOrder * 0.86) / 1.86);
let minimumCost = Infinity;
for (const a of orders) for (const b of orders) for (const c of orders) {
  if (new Set([a, b, c]).size !== 3) continue;
  minimumCost = Math.min(minimumCost, [a, b, c].reduce((sum, order, index) => sum + (order - means[index]) ** 2, 0));
}
const three = projectLineupV13([feed(threeNew), feed(threeOld)], 1, 0.72);
assertLegal(three, 3);
const measuredCost = threeNew.reduce((sum, row, index) => sum + (three.players.find(player => player.id === row.person.id).battingOrder - means[index]) ** 2, 0);
assert.ok(Math.abs(measuredCost - minimumCost) < 1e-8, 'joint assignment minimizes expected squared slot distance');
const oldOnly = projectLineupV13([feed([]), feed([batter(20, 900)])], 1, 0.72);
assert.equal(oldOnly.players[0].battingOrder, 900, 'recency below one cannot shrink a ninth-slot observation toward leadoff');
assertLegal(projectLineupV13([], 1, 0.72), 0);

// A player can start one day and pinch hit the next. Only the start contributes
// evidence about their opening batting slot.
const replacement = projectLineupV13([feed([batter(20, 101)]), feed([batter(20, 800)])], 1, 0.72);
assert.equal(replacement.players[0].battingOrder, 800);
const newStats = starters.map(row => ({ ...row, seasonStats: { batting: { plateAppearances: 320, ops: 0.8 } } }));
const newestMetric = projectLineupV13([feed(newStats), feed(starters)], 1, 0.72);
assert.ok(newestMetric.players.every(row => row.ops === 0.8), 'older starts cannot replace newer starting-feed metrics');

// Known official identities and slots are fixed, even if the player previously
// projected at another slot or did not occur in the projected nine.
const partialOfficial = parseOfficialLineupV13(feed([batter(100, 900), batter(999, 400)]), 1, 0.72);
const merged = mergePartialOfficialV13(projected, partialOfficial, 0.72);
assertLegal(merged, 9);
assert.equal(merged.players.find(row => row.id === 100).battingOrder, 900);
assert.equal(merged.players.find(row => row.id === 999).battingOrder, 400);
assert.equal(merged.official, false, 'projected fillers cannot turn a partial official announcement into a confirmed lineup');
assert.equal(merged.identityStatus, 'PROJECTED');
assert.equal(merged.source, 'MLB_PARTIAL_OFFICIAL_PLUS_RECENT_PROJECTION');
const fullOfficial = parseOfficialLineupV13(feed(starters), 1, 0.72);
assert.equal(mergePartialOfficialV13(projected, fullOfficial, 0.72), fullOfficial);
assert.equal(mergePartialOfficialV13(projected, parseOfficialLineupV13(feed([]), 1, 0.72), 0.72), projected);

// Malformed source rows cannot count two identities in the same opening slot,
// or one identity in two slots. Conflicts are left unknown, not chosen by order.
const conflictingRows = [...starters, batter(999, 100)];
const conflict = parseOfficialLineupV13(feed(conflictingRows), 1, 0.72);
assertLegal(conflict, 8);
assert.equal(conflict.official, false);
assert.ok(!conflict.players.some(row => row.id === 100 || row.id === 999));
assert.deepEqual(shape(conflict), shape(parseOfficialLineupV13(feed([...conflictingRows].reverse()), 1, 0.72)));
const repeatedIdentity = parseOfficialLineupV13(feed([batter(20, 100), batter(20, 200), batter(21, 300)]), 1, 0.72);
assert.deepEqual(shape(repeatedIdentity), [{ id: 21, order: 300 }]);
const duplicateTransport = parseOfficialLineupV13(feed([...starters, starters[0]]), 1, 0.72);
assertLegal(duplicateTransport, 9);
assert.equal(duplicateTransport.official, true, 'identical duplicated transport rows are harmless');

// Partial lineups must apply the established weight for the actual occupied
// batting slot and leave every missing slot neutral in the denominator.
const ninthOnly = parseOfficialLineupV13(feed([batter(20, 900, 0.9)]), 1, 0.8);
const weightSum = [1.05, 1.03, 1.08, 1.10, 1.07, 1, 0.96, 0.93, 0.90].reduce((sum, value) => sum + value, 0);
assert.ok(Math.abs(ninthOnly.offensiveIndex - Math.exp(Math.log(0.9 / 0.8) * 0.90 / weightSum)) < 1e-12);

// Hydration rebuilds normalized rows. It must preserve the official slots and
// projection status when the original lineup only had identities.
const noStats = row => { const copy = structuredClone(row); delete copy.seasonStats; return copy; };
const namesProjection = projectLineupV13([feed(starters.map(noStats))], 1, 0.72);
const namesOfficial = parseOfficialLineupV13(feed([noStats(batter(100, 900))]), 1, 0.72);
const namesMerged = mergePartialOfficialV13(namesProjection, namesOfficial, 0.72);
const hydrated = await hydrateLineupBattingV13(namesMerged, 1, 0.72, '2026-09-22', {
  fetchImpl: async () => Response.json({ stats: [{ splits: [{ stat: { plateAppearances: 300, ops: 0.72 } }] }] }),
});
assertLegal(hydrated, 9);
assert.deepEqual(shape(hydrated), shape(namesMerged));
assert.equal(hydrated.identityStatus, 'PROJECTED');
assert.equal(hydrated.official, false);
assert.equal(hydrated.metricCoverage, 1);

console.log(JSON.stringify({ ok: true, cases: [
  'pinch_hitters_excluded', 'unique_joint_slot_assignment', 'permutation_invariance',
  'minimum_cost_oracle', 'older_only_slot_normalization', 'team_identity_scope',
  'newest_start_metrics', 'official_slot_locks', 'conflicting_source_rows',
  'partial_slot_weights', 'hydration_keeps_projection_status',
] }));
