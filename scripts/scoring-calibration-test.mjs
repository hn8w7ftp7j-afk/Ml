import assert from 'node:assert/strict';
import { analyzeMarkets } from '../lib/analysis.js';
import {
  FORMAL_SCORING_ENABLED,
  SCORE_RELEASE_STATUS,
  finalizeDeterministicAnalysis,
} from '../lib/deterministic-finalizer.js';
import { breakEvenProbability, evFromProbability } from '../lib/markets.js';

const team = () => ({
  seasonHitting: { gamesPlayed: 120, runsPerGame: 4.35, ops: 0.72, iso: 0.15, kRate: 0.225, bbRate: 0.085 },
  recentHitting: { gamesPlayed: 12, runsPerGame: 4.35, ops: 0.72, iso: 0.15, kRate: 0.225, bbRate: 0.085 },
  vsLeft: { available: true, ops: 0.72 },
  vsRight: { available: true, ops: 0.72 },
  lineup: { projected: true, offensiveIndex: 1, players: [] },
  injuryImpact: 0,
  baserunning: { runIndex: 1 },
  defense: { available: true, fieldingPercentage: 0.985, errorsPerGame: 0.55 },
  recentPitching: { inningsPitched: 50, era: 4.2, whip: 1.3 },
  bullpen: { usageAvailable: true, fatigueIndex: 0.2, highLeverageAvailability: 0.75, qualityFactor: 1 },
  rest: { available: true, days: 1, travelKm: 0 },
  starter: {
    available: true,
    confirmed: true,
    throws: 'R',
    expectedInnings: 5.2,
    season: { gamesStarted: 20, inningsPitched: 110, era: 4.2, fip: 4.2, whip: 1.3, kMinusBB: 0.14, hrPer9: 1.15 },
    recent: { gamesStarted: 5, inningsPitched: 27, era: 4.2, fip: 4.2, whip: 1.3, kMinusBB: 0.14, hrPer9: 1.15 },
    pitchQuality: { available: true, runFactor: 1 },
  },
});

const context = {
  coreModelable: true,
  coreFingerprint: 'scoring-calibration-shadow-regression-v2',
  game: { gamePk: 990001, away: '客隊', home: '主隊' },
  league: { runsPerTeamGame: 4.35 },
  away: team(),
  home: team(),
  park: { runFactor: 1, roof: 'open' },
  weather: { available: true, temperature: 21, windSpeed: 0, precipitationProbability: 0, roofConfirmed: true },
  umpire: { name: 'Regression Umpire' },
  featureProvenance: [],
};

const settings = {
  rebateRate: 0.015,
  candidateThreshold: 7.2,
  strongestThreshold: 8.5,
  simulationsPerScenario: 500,
};

const direction = (market, pick, water) => ({
  market,
  pick,
  water,
  waterEstimated: false,
  sourceType: 'ACTUAL_TW_CREDIT',
  executable: true,
});

const markets = [
  direction('全場讓分', '客隊讓1平', 0.95),
  direction('全場讓分', '主隊受讓1平', 0.95),
  direction('全場大小', '大8.5', 0.94),
  direction('全場大小', '小8.5', 0.94),
  direction('上半讓分', '客隊讓0.5', 0.94),
  direction('上半讓分', '主隊受讓0.5', 0.94),
  direction('上半大小', '大4.5', 0.93),
  direction('上半大小', '小4.5', 0.93),
];

assert.ok(Math.abs(evFromProbability(0.5, 0.94, 0.015) - (-0.015)) < 1e-12);
assert.ok(Math.abs(breakEvenProbability(0.94, 0.015) - (0.985 / 1.94)) < 1e-12);
assert.ok(Math.abs(evFromProbability(0.55, 0.94, 0.015) - 0.082) < 1e-12);

const previousMarkets = markets.map(row => ({ ...row, water: Math.max(0.5, row.water - 0.04) }));
const preliminary = analyzeMarkets({ context, markets, previousMarkets, settings });
const finalized = finalizeDeterministicAnalysis({ analysis: preliminary, game: context.game, settings });

assert.equal(FORMAL_SCORING_ENABLED, false);
assert.equal(SCORE_RELEASE_STATUS, 'LEGACY_INVALID');
assert.equal(finalized.formalScoringEnabled, false);
assert.equal(finalized.scoreReleaseStatus, 'LEGACY_INVALID');
assert.deepEqual(finalized.portfolio, []);
assert.equal(finalized.results.length, 8);

for (const row of finalized.results) {
  assert.equal(row.score, null, `${row.market} ${row.pick}不得發布正式分數`);
  assert.equal(row.scoreStatus, 'LEGACY_INVALID');
  assert.equal(row.betEligible, false);
  assert.equal(row.scoreType, 'SHADOW_DIAGNOSTIC');
  assert.equal(row.scoreBreakdown?.formalScoringEnabled, false);
  assert.equal(row.scoreBreakdown?.finalScore, null);
  assert.equal(Number.isFinite(Number(row.weightedEV)), true);
  assert.equal(Number.isFinite(Number(row.robustEV)), true);
  assert.equal(row.evDoubleCheck?.passed, true);
  assert.equal(row.movement?.available, true);
  assert.equal(Number.isFinite(Number(row.movement?.deltaEV)), true);

  // The old same-board calibration may remain visible only as legacy model
  // diagnostics while P0/P1 data and probability layers are rebuilt. It must
  // never create a formal score, recommendation, portfolio or bet eligibility.
  assert.equal(typeof row.marketCalibrationApplied, 'boolean');
  if (row.scoreAudit?.ok === true) assert.equal(Number.isFinite(Number(row.shadowDiagnosticScore)), true);
}

for (const market of ['全場讓分', '全場大小', '上半讓分', '上半大小']) {
  const pair = finalized.results.filter(row => row.market === market);
  assert.equal(pair.length, 2);
  assert.ok(Math.abs(pair[0].modelProbability + pair[1].modelProbability - 1) <= 0.012, market);
  assert.equal(pair.some(row => row.betEligible), false);
}

const extremeMarkets = [
  direction('全場大小', '大6.5', 0.94),
  direction('全場大小', '小6.5', 0.94),
  direction('上半大小', '大3.5', 0.93),
  direction('上半大小', '小3.5', 0.93),
];
const extreme = finalizeDeterministicAnalysis({
  analysis: analyzeMarkets({
    context: { ...context, coreFingerprint: 'scoring-calibration-extreme-shadow-v2' },
    markets: extremeMarkets,
    settings,
  }),
  game: context.game,
  settings,
});
for (const row of extreme.results) {
  assert.equal(row.score, null);
  assert.equal(row.betEligible, false);
  assert.match(row.tag, /SHADOW|QA未通過/);
}

console.log(JSON.stringify({
  ok: true,
  breakEvenAt094: breakEvenProbability(0.94, 0.015),
  formalScoringEnabled: finalized.formalScoringEnabled,
  diagnosticDirections: finalized.results.filter(row => Number.isFinite(Number(row.shadowDiagnosticScore))).length,
}, null, 2));
