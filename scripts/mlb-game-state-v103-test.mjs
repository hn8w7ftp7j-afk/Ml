import assert from 'node:assert/strict';
import {
  applyBottomNinthStateV13,
  extraInningsKernelV13,
  gameStateAuditForScenarioV13,
  scoreDistributionForScenario,
} from '../lib/joint-score-v13.js';

assert.deepEqual(
  applyBottomNinthStateV13({ awayRuns: 2, homeRuns: 3, sampledHomeRuns: 7 }),
  { awayRuns: 2, homeRuns: 3, bottomPlayed: false, walkoff: false, tied: false },
  'home lead after top ninth must skip bottom ninth',
);
assert.deepEqual(
  applyBottomNinthStateV13({ awayRuns: 4, homeRuns: 3, sampledHomeRuns: 5 }),
  { awayRuns: 4, homeRuns: 5, bottomPlayed: true, walkoff: true, tied: false },
  'walkoff must stop at winning run without invented extra margin',
);
assert.deepEqual(
  applyBottomNinthStateV13({ awayRuns: 4, homeRuns: 3, sampledHomeRuns: 1 }),
  { awayRuns: 4, homeRuns: 4, bottomPlayed: true, walkoff: false, tied: true },
);

const skippedScenario = {
  means: { awayNinth: 0.4, homeNinth: 0.5, awayLate: 1.6, homeLate: 1.8 },
  pmf: {
    awayFirst5: [[0, 1]], homeFirst5: [[2, 1]],
    awayMiddle3: [[0, 1]], homeMiddle3: [[0, 1]],
    awayNinth: [[0, 1]], homeNinth: [[7, 1]],
  },
};
const skipped = scoreDistributionForScenario(skippedScenario, false);
assert.deepEqual(skipped.cells, [{ awayRuns: 0, homeRuns: 2, probability: 1 }]);
assert.equal(gameStateAuditForScenarioV13(skippedScenario).bottomNinthSkippedProbability, 1);

const walkoffScenario = {
  means: { awayNinth: 0.4, homeNinth: 0.5, awayLate: 1.6, homeLate: 1.8 },
  pmf: {
    awayFirst5: [[0, 1]], homeFirst5: [[0, 1]],
    awayMiddle3: [[0, 1]], homeMiddle3: [[0, 1]],
    awayNinth: [[1, 1]], homeNinth: [[5, 1]],
  },
};
const walkoff = scoreDistributionForScenario(walkoffScenario, false);
assert.deepEqual(walkoff.cells, [{ awayRuns: 1, homeRuns: 2, probability: 1 }]);
assert.equal(gameStateAuditForScenarioV13(walkoffScenario).regulationWalkoffProbability, 1);

const extrasScenario = {
  means: { awayNinth: 0.45, homeNinth: 0.48, awayLate: 1.8, homeLate: 1.9 },
  pmf: {
    awayFirst5: [[0, 1]], homeFirst5: [[0, 1]],
    awayMiddle3: [[0, 1]], homeMiddle3: [[0, 1]],
    awayNinth: [[0, 1]], homeNinth: [[0, 1]],
  },
};
const extras = scoreDistributionForScenario(extrasScenario, false);
assert.ok(Math.abs(extras.cells.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-12);
assert.equal(extras.cells.some(row => row.awayRuns === row.homeRuns), false);
assert.ok(Math.abs(gameStateAuditForScenarioV13(extrasScenario).extraInningsProbability - 1) < 1e-12);
const kernel = extraInningsKernelV13(extrasScenario);
assert.ok(Math.abs(kernel.cells.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-12);
assert.equal(kernel.cells.some(row => row.awayRuns === row.homeRuns), false);
assert.ok(kernel.cells.filter(row => row.homeRuns > row.awayRuns).every(row => row.homeRuns === row.awayRuns + 1), 'extra-inning home wins must terminate at walkoff run');

console.log(JSON.stringify({ ok: true, skipped: skipped.cells[0], walkoff: walkoff.cells[0], extraCells: extras.cells.length }, null, 2));
