import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hydrateLineupBattingV13, mergePartialOfficialV13, parseOfficialLineupV13, projectLineupV13 } from '../lib/mlb-context-v13.js';

const orders = Array.from({ length: 9 }, (_, index) => (index + 1) * 100);
const batter = (id, battingOrder) => ({ person: { id, fullName: `Batter ${id}` }, battingOrder, position: { abbreviation: 'OF' } });
const feed = (players, teamId = 1) => ({
  gameData: { teams: { away: { id: teamId }, home: { id: 9999 } } },
  liveData: { boxscore: { teams: { away: { players: Object.fromEntries(players.map((row, index) => [`row${index}`, row])) }, home: { players: {} } } } },
});

// Starting identities and slots use starts only. Batting ability must retain
// the latest appearance's intact season block even when that appearance is PH.
const withStats = (row, plateAppearances, ops) => ({ ...row, seasonStats: { batting: { plateAppearances, ops } } });
const otherStarters = orders.slice(1).map((order, index) => withStats(batter(20 + index, order), 300, 0.72));
const pinchHitter = { ...withStats(batter(10, 101), 350, 0.90), position: { abbreviation: 'PH' }, metricSource: 'NEWEST_PRIOR_GAME', metricProvenance: { gamePk: 1000 } };
const oldStarter = { ...withStats(batter(10, 100), 300, 0.72), position: { abbreviation: 'RF' } };
const alternateStarter = withStats(batter(11, 100), 300, 0.68);
const metricHistory = [feed([pinchHitter, alternateStarter, ...otherStarters]), feed([oldStarter, ...otherStarters]), feed([oldStarter, ...otherStarters])];
const metricProjection = projectLineupV13(metricHistory, 1, 0.72);
const selected = metricProjection.players.find(row => row.id === 10);
assert.equal(selected.ops, 0.90, 'a newer PH appearance must not regress the selected starter to older season metrics');
assert.equal(selected.plateAppearances, 350);
assert.equal(selected.position, 'RF', 'a PH appearance does not rewrite the projected starting position');
assert.equal(selected.historicalAverageBattingOrder, 100, 'the 101 appearance contributes no starting-slot evidence');
assert.equal(selected.metricSource, 'NEWEST_PRIOR_GAME');
assert.deepEqual(selected.metricProvenance, { gamePk: 1000 });
assert.ok(!metricProjection.players.some(row => row.id === 11), 'PH metrics must not change start-frequency selection');
let metricFetches = 0;
const alreadyComplete = await hydrateLineupBattingV13(metricProjection, 1, 0.72, '2026-09-15', { fetchImpl: async () => { metricFetches += 1; throw new Error('complete metrics should not be re-fetched'); } });
assert.equal(metricFetches, 0);
assert.equal(alreadyComplete.players.find(row => row.id === 10).ops, 0.90);
const incompleteLatest = structuredClone(metricHistory);
incompleteLatest[0].liveData.boxscore.teams.away.players.row0.seasonStats.batting = { plateAppearances: 351 };
const incompleteProjection = projectLineupV13(incompleteLatest, 1, 0.72);
const incompleteMetric = incompleteProjection.players.find(row => row.id === 10);
assert.equal(incompleteMetric.plateAppearances, 351);
assert.equal(incompleteMetric.ops, null, 'do not combine a newer PA count with an older OPS');
assert.equal(incompleteMetric.metricAvailable, false);

const newest = orders.map((order, index) => batter(index + 1, order));
const oldest = newest.map((row, index) => ({ ...row, battingOrder: (9 - index) * 100 }));
const projected = projectLineupV13([feed(newest), feed(oldest)], 1, 0.72);
for (const row of projected.players) {
  const mean = (newest[row.id - 1].battingOrder + oldest[row.id - 1].battingOrder * 0.86) / 1.86;
  assert.ok(Math.abs(row.historicalAverageBattingOrder - mean) < 1e-10, 'the original weighted mean must survive joint assignment in MLB 100-based units');
}
assert.deepEqual(projected.players.map(row => row.battingOrder), orders);
const sparse = projectLineupV13([feed([]), feed([]), feed([]), feed([]), feed([]), feed([batter(10, 900)])], 1, 0.72);
assert.ok(Math.abs(sparse.players[0].historicalAverageBattingOrder - 900) < 1e-10);
assert.equal(sparse.players[0].battingOrder, 900);

const official = parseOfficialLineupV13(feed([batter(1, 900)]), 1, 0.72);
assert.ok(!Object.hasOwn(official.players[0], 'historicalAverageBattingOrder'), 'an official slot must not invent history');
const merged = mergePartialOfficialV13(projected, official, 0.72);
assert.equal(merged.players.find(row => row.id === 1).battingOrder, 900);
assert.ok(!Object.hasOwn(merged.players.find(row => row.id === 1), 'historicalAverageBattingOrder'));
for (const row of merged.players.filter(row => row.id !== 1)) {
  assert.equal(row.historicalAverageBattingOrder, projected.players.find(player => player.id === row.id).historicalAverageBattingOrder);
}
const hydrated = await hydrateLineupBattingV13(merged, 1, 0.72, '2026-09-15', {
  fetchImpl: async () => Response.json({ stats: [{ splits: [{ stat: { plateAppearances: 300, ops: 0.72 } }] }] }),
});
assert.deepEqual(hydrated.players.map(({ id, battingOrder, historicalAverageBattingOrder }) => ({ id, battingOrder, historicalAverageBattingOrder })),
  merged.players.map(({ id, battingOrder, historicalAverageBattingOrder }) => ({ id, battingOrder, historicalAverageBattingOrder })));
assert.equal(hydrated.official, false);

// Real audit case: the frozen 822680 projection had two sixth-slot hitters.
// Only five of the six cited prior feeds are archived locally. Retain the gap
// at its original recency index; this is explicitly not an exact PIT replay.
const fixture = JSON.parse(await readFile(new URL('./fixtures/mlb-822680-projected-lineup.json', import.meta.url), 'utf8'));
assert.deepEqual(fixture.frozenProjectedLineup.players.map(row => row.battingOrder), [100, 200, 300, 400, 500, 600, 600, 700, 800]);
assert.deepEqual(fixture.missingHistoryGamePks, [824869]);
const history = Array.from({ length: 6 }, () => feed([], fixture.teamId));
for (const source of fixture.historyFeeds) {
  assert.notEqual(source.gamePk, 822680, 'never use the target game actual lineup to create its prediction');
  assert.ok(source.officialDate < fixture.analysisAsOf.slice(0, 10));
  assert.ok(source.sourceReceiptAtAnalysis.fetchedAt < fixture.analysisAsOf);
  history[source.historyIndex] = feed(source.players, fixture.teamId);
}
const actualCase = projectLineupV13(history, fixture.teamId, fixture.teamOps);
assert.equal(actualCase.players.length, 9);
assert.equal(new Set(actualCase.players.map(row => row.id)).size, 9);
assert.deepEqual(actualCase.players.map(row => row.battingOrder), orders);
assert.ok(actualCase.players.every(row => Number.isFinite(row.historicalAverageBattingOrder)));
assert.equal(actualCase.official, false);
const missing = projectLineupV13([], 120, fixture.frozenMissingOpponentLineup.offensiveIndexBaselineOps);
assert.equal(missing.identityStatus, 'MISSING');
assert.equal(missing.players.length, 0);
assert.equal(missing.offensiveIndex, 1);

console.log(JSON.stringify({ ok: true, cases: ['latest_pinch_hit_metrics_do_not_regress', 'single_batting_block_no_mixing', 'weighted_mean_retained', 'sparse_start_mean', 'official_slots_have_no_invented_mean', 'partial_and_hydration_keep_history', '822680_prior_history_partial_coverage', 'missing_opponent_not_fabricated'] }));
