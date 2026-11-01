import { analyzeSoccerConditionalQuote } from './conditional-analysis.js';
import { deterministicScore } from '../deterministic-score.js';
import { soccerScoringHash } from './soccer-scoring.js';

const outward = (value, upper) => {
  if (!Number.isFinite(value)) return NaN;
  if (value === 0) return upper ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + ((value > 0) === upper ? 1n : -1n));
  return view.getFloat64(0);
};

// Parameter sensitivity only. The bootstrap weights are algorithmic weights,
// not probabilities of real-world scenarios or a total-model error estimate.
// Keep every formal field null and never pass this object to ranking.
export function soccerScenarioScore({ quote, distribution, game, research, now = Date.now() } = {}) {
  const base = { version: 'SOCCER-PARAMETER-STRESS-SCORE-v1', status: 'UNAVAILABLE',
    formalEligible: false, executable: false, W: null, R: null, S: null };
  const unavailable = reason => ({ ...base, reason });
  const baseline = analyzeSoccerConditionalQuote({ quote, distribution, game, now });
  if (baseline.status !== 'CONDITIONAL_RESEARCH') return unavailable(baseline.reason);
  const period = research?.periods?.[quote.period];
  if (research?.status !== 'RESEARCH_ONLY' || research.formalEnabled !== false
    || research.executable !== false || !(Date.parse(research.createdAt) <= now)
    || !/^[a-f0-9]{64}$/.test(research.artifactHash || '')
    || !/^[a-f0-9]{64}$/.test(research.protocolHash || '')
    || period?.status !== 'RESEARCH_SCENARIOS_AVAILABLE' || period.failed !== 0
    || period.weightsRenormalized !== false || !Array.isArray(period.scenarios)
    || !Number.isSafeInteger(period.attempted) || period.attempted < 1
    || period.attempted > 1000 || period.attempted !== period.scenarios.length || period.count !== period.attempted)
    return unavailable('COMPLETE_SCENARIO_SET_REQUIRED');
  const rows = [], ids = new Set();
  let mass = 0;
  for (const scenario of period.scenarios) {
    if (!scenario?.id || ids.has(scenario.id) || scenario.league !== game.league
      || scenario.gameId !== game.id || scenario.period !== quote.period
      || !Number.isFinite(scenario.weight) || scenario.weight <= 0)
      return unavailable('SCENARIO_SCOPE_OR_WEIGHT_INVALID');
    ids.add(scenario.id);
    const result = analyzeSoccerConditionalQuote({ quote, distribution: scenario.distribution, game, now });
    if (result.status !== 'CONDITIONAL_RESEARCH'
      || ![result.netReturnBounds?.lower, result.netReturnBounds?.upper].every(Number.isFinite)
      || result.netReturnBounds.lower > result.netReturnBounds.upper)
      return unavailable('SCENARIO_RETURN_NOT_IDENTIFIED');
    mass += scenario.weight;
    rows.push({ id: scenario.id, weight: scenario.weight, netReturn: result.exactNetReturn,
      lower: result.netReturnBounds.lower, upper: result.netReturnBounds.upper,
      distributionHash: result.distributionHash });
  }
  if (Math.abs(mass - 1) > 1e-10) return unavailable('SCENARIO_WEIGHT_MASS_INVALID');
  // Monotonic propagation of omitted-score payoff bounds. Do not turn a tail
  // interval into a point estimate, choose a midpoint or renormalize its mass.
  const bound = endpoint => {
    const mean = rows.reduce((sum, row) => outward(sum + outward(row.weight * row[endpoint], endpoint === 'upper'), endpoint === 'upper'), 0);
    let cumulative = 0, q10;
    for (const row of [...rows].sort((a, b) => a[endpoint] - b[endpoint])) {
      cumulative += row.weight;
      if (cumulative >= .10) { q10 = row[endpoint]; break; }
    }
    const stressReturn = Math.min(mean, q10);
    const formula = deterministicScore({ weightedEV: mean, robustEV: stressReturn,
      actualWater: true, qaPassed: true, executable: false });
    return { mean, q10, stressReturn, score: formula.score, formulaVersion: formula.formulaVersion };
  };
  const lower = bound('lower'), upper = bound('upper');
  if (![lower, upper].every(row => [row.mean, row.q10, row.stressReturn, row.score].every(Number.isFinite)))
    return unavailable('SCENARIO_NUMERIC_INVALID');
  return { ...base, status: 'PARAMETER_SENSITIVITY_ONLY', reason: null,
    gameId: game.id, league: game.league, period: quote.period, sourceQuoteKey: quote.key,
    calculatedAt: baseline.calculatedAt, baselineDistributionHash: baseline.distributionHash,
    artifactHash: research.artifactHash, protocolHash: research.protocolHash,
    scenarioCount: rows.length, weightSum: mass, scenariosHash: soccerScoringHash(rows), rows,
    meanNetReturn: lower.mean, q10: lower.q10, stressReturn: lower.stressReturn,
    returnBounds: { lower, upper }, scoreLower: lower.score, scoreUpper: upper.score,
    score: lower.score === upper.score ? lower.score : null,
    formulaVersion: lower.formulaVersion, modelErrorMargin: null,
    interpretation: 'PARAMETER_SENSITIVITY_NOT_VALIDATED_TOTAL_MODEL_ERROR_OR_FORMAL_SCORE' };
}
