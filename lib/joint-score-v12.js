import { sha256 } from './snapshot-v9.js';
import {
  JOINT_SCORE_V11_VERSION,
  SCENARIO_QUADRATURE_VERSION,
  buildJointScoreSnapshotV11,
  negativeBinomialPmf,
  scoreDistributionForScenario as regulationDistribution,
} from './joint-score-v11.js';

export const JOINT_SCORE_V12_VERSION = 'BASEBALL-EXACT-JOINT-SCORE-WITH-EXTRAS-2026-08-v10.3.0';
export { SCENARIO_QUADRATURE_VERSION, negativeBinomialPmf };

function poissonPmf(mean, maximum = 8) {
  const mu = Math.max(0.01, Number(mean) || 0.01);
  const rows = [];
  let probability = Math.exp(-mu);
  let total = 0;
  for (let runs = 0; runs <= maximum; runs += 1) {
    if (runs > 0) probability *= mu / runs;
    rows.push([runs, probability]);
    total += probability;
  }
  rows[rows.length - 1][1] += Math.max(0, 1 - total);
  return rows;
}

function extraInningsKernel(scenario, maximumInnings = 10) {
  const awayMean = Math.max(0.30, Number(scenario?.means?.awayLate || 1.9) / 4 * 1.30);
  const homeMean = Math.max(0.30, Number(scenario?.means?.homeLate || 1.9) / 4 * 1.30);
  const awayPmf = poissonPmf(awayMean, 7);
  const homePmf = poissonPmf(homeMean, 7);
  let live = new Map([['0:0', 1]]);
  const terminal = new Map();
  const add = (map, away, home, probability) => {
    const key = `${away}:${home}`;
    map.set(key, (map.get(key) || 0) + probability);
  };
  for (let inning = 0; inning < maximumInnings; inning += 1) {
    const nextLive = new Map();
    for (const [key, stateProbability] of live) {
      const [awayAccumulated, homeAccumulated] = key.split(':').map(Number);
      for (const [awayRuns, awayProbability] of awayPmf) {
        for (const [homeRuns, homeProbability] of homePmf) {
          const probability = stateProbability * awayProbability * homeProbability;
          if (probability <= 1e-16) continue;
          const awayTotal = awayAccumulated + awayRuns;
          const homeTotal = homeAccumulated + homeRuns;
          if (awayRuns !== homeRuns) add(terminal, awayTotal, homeTotal, probability);
          else add(nextLive, awayTotal, homeTotal, probability);
        }
      }
    }
    live = nextLive;
    if ([...live.values()].reduce((sum, value) => sum + value, 0) < 1e-10) break;
  }
  for (const [key, probability] of live) {
    const [away, home] = key.split(':').map(Number);
    add(terminal, away + 1, home, probability / 2);
    add(terminal, away, home + 1, probability / 2);
  }
  const rows = [...terminal.entries()].map(([key, probability]) => {
    const [away, home] = key.split(':').map(Number);
    return { awayRuns: away, homeRuns: home, probability };
  });
  const total = rows.reduce((sum, row) => sum + row.probability, 0) || 1;
  return rows.map(row => ({ ...row, probability: row.probability / total }));
}

export function buildJointScoreSnapshotV12(args) {
  const base = buildJointScoreSnapshotV11(args);
  const identityPayload = {
    regulationDistributionHash: base.distributionHash,
    version: JOINT_SCORE_V12_VERSION,
    regulationModelVersion: JOINT_SCORE_V11_VERSION,
    extraInningsModel: 'TIE-CONDITIONAL-POISSON-AUTOMATIC-RUNNER-v1.0.0',
    quadratureVersion: base.quadratureVersion,
    modelVersion: base.modelVersion,
    rulesVersion: base.rulesVersion,
  };
  const distributionHash = sha256(identityPayload);
  return {
    ...base,
    version: JOINT_SCORE_V12_VERSION,
    regulationModelVersion: JOINT_SCORE_V11_VERSION,
    regulationDistributionHash: base.distributionHash,
    extraInningsModel: identityPayload.extraInningsModel,
    distributionHash,
    distributionId: `${base.gamePk || 'game'}:${distributionHash.slice(0, 20)}`,
    legacyDistributionUsed: false,
  };
}

export function scoreDistributionForScenario(scenario, first5 = false) {
  const regulation = regulationDistribution(scenario, first5);
  if (first5) return regulation;
  const kernel = extraInningsKernel(scenario);
  const output = new Map();
  const add = (away, home, probability) => {
    const key = `${away}:${home}`;
    output.set(key, (output.get(key) || 0) + probability);
  };
  for (const cell of regulation.cells) {
    if (cell.awayRuns !== cell.homeRuns) {
      add(cell.awayRuns, cell.homeRuns, cell.probability);
      continue;
    }
    for (const extra of kernel) {
      add(cell.awayRuns + extra.awayRuns, cell.homeRuns + extra.homeRuns, cell.probability * extra.probability);
    }
  }
  const cells = [...output.entries()].map(([key, probability]) => {
    const [awayRuns, homeRuns] = key.split(':').map(Number);
    return { awayRuns, homeRuns, probability };
  });
  const coverage = cells.reduce((sum, cell) => sum + cell.probability, 0) || 1;
  for (const cell of cells) cell.probability /= coverage;
  return { cells, coverage: 1 };
}
