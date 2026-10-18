import { createHash } from 'node:crypto';
import { validateTrainingRows } from './score-model.js';

export const HALF_TIME_MODEL_VERSION = 'SOCCER-HT-FT-CONDITIONAL-BINOMIAL-v1';
export const HALF_TIME_PROTOCOL_VERSION = 'SOCCER-HT-PAST-ONLY-WEIGHTED-MLE-v1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const outcomes = ['home', 'draw', 'away'];
const validEvidence = value => typeof value === 'string' ? value.trim().length > 0 : value !== null && typeof value === 'object' && Object.keys(value).length > 0;

function verifiedHalfTime(row) {
  const h = row?.halfTime;
  if (h?.verified !== true || !validEvidence(h.evidence) || !h.source?.url || !h.source?.contentHash || (h.period !== undefined && h.period !== 'REGULATION_HT')) throw Error('HALF_TIME_EVIDENCE_UNVERIFIED');
  if (![h.home, h.away].every(x => Number.isInteger(x) && x >= 0) || h.home > row.homeGoals || h.away > row.awayGoals) throw Error('HALF_TIME_SCORE_INVALID');
  return h;
}

export function fitHalfTimeModel(input, { league, cutoff, halfLifeDays = 365 } = {}) {
  if (!(Number.isFinite(halfLifeDays) && halfLifeDays > 0)) throw Error('HALF_TIME_FIT_OPTIONS_INVALID');
  // Do not silently discard foreign leagues, future labels, identity errors or revisions.
  const validated = validateTrainingRows(input, league, cutoff), rows = [], excluded = [];
  for (const row of validated) {
    try { verifiedHalfTime(row); rows.push(row); }
    catch (error) { excluded.push({ eventId: row.eventId, reason: error.message }); }
  }
  let homeGoals = 0, awayGoals = 0, homeHalf = 0, awayHalf = 0, weightSum = 0;
  for (const row of rows) {
    const weight = Math.exp(-Math.LN2 * (Date.parse(cutoff) - Date.parse(row.startTime)) / 86400000 / halfLifeDays);
    homeGoals += weight * row.homeGoals; awayGoals += weight * row.awayGoals;
    homeHalf += weight * row.halfTime.home; awayHalf += weight * row.halfTime.away; weightSum += weight;
  }
  if (!(homeGoals > 0 && awayGoals > 0)) throw Error('HALF_TIME_NO_EXPOSURE');
  return {
    version: HALF_TIME_MODEL_VERSION, protocolVersion: HALF_TIME_PROTOCOL_VERSION,
    league, period: 'REGULATION_HT', cutoff, halfLifeDays,
    trainedThrough: rows.at(-1).startTime, inputCount: input.length, uniqueInputCount: validated.length,
    trainingCount: rows.length, excludedCount: excluded.length, excluded,
    coverage: validated.length ? rows.length / validated.length : 0,
    trainingHash: hash(rows), inputHash: hash(validated),
    shares: { home: homeHalf / homeGoals, away: awayHalf / awayGoals },
    weightedExposure: { homeGoals, awayGoals, homeHalfGoals: homeHalf, awayHalfGoals: awayHalf, matchWeightSum: weightSum },
    estimator: 'TIME_WEIGHTED_CONDITIONAL_BINOMIAL_MLE_RATIO_OF_GOAL_SUMS',
    status: 'RESEARCH_ONLY', formalEnabled: false, executable: false,
    assumptions: ['CONSTANT_ROLE_SPECIFIC_HALF_TIME_SHARE', 'CONDITIONAL_INDEPENDENT_BINOMIAL_ALLOCATIONS_GIVEN_FULL_TIME', 'REGULATION_PERIODS_INCLUDE_THEIR_OWN_STOPPAGE_TIME'],
    missing: ['NO_SCORE_STATE_DEPENDENT_TIMING', 'NO_EVENT_PROCESS_OR_PLAYER_EFFECTS', 'RETROSPECTIVE_AVAILABILITY_UNVERIFIED'],
  };
}

function checkModel(model, { league, startTime } = {}) {
  if (model?.version !== HALF_TIME_MODEL_VERSION || model.period !== 'REGULATION_HT' || !['epl', 'ucl'].includes(model.league) || (league !== undefined && league !== model.league) || !Number.isFinite(Date.parse(model.cutoff)) || ![model.shares?.home, model.shares?.away].every(x => Number.isFinite(x) && x >= 0 && x <= 1)) throw Error('HALF_TIME_MODEL_NOT_APPLICABLE');
  if (startTime !== undefined && (!Number.isFinite(Date.parse(startTime)) || Date.parse(startTime) < Date.parse(model.cutoff))) throw Error('HALF_TIME_PREDICTION_BEFORE_CUTOFF');
}

function logFactorial(n) { let value = 0; for (let k = 2; k <= n; k++) value += Math.log(k); return value; }
function logPoisson(n, rate) { return rate === 0 ? (n === 0 ? 0 : -Infinity) : -rate + n * Math.log(rate) - logFactorial(n); }
function tau(h, a, hr, ar, rho) { return h === 0 && a === 0 ? 1 - hr * ar * rho : h === 0 && a === 1 ? 1 + hr * rho : h === 1 && a === 0 ? 1 + ar * rho : h === 1 && a === 1 ? 1 - rho : 1; }
function logDC(h, a, hr, ar, rho) { return logPoisson(h, hr) + logPoisson(a, ar) + Math.log(tau(h, a, hr, ar, rho)); }

function checkFullTime(ft, { requireDC = false } = {}) {
  if (ft?.period !== 'REGULATION_FT' || !Array.isArray(ft.cells) || !ft.cells.length) throw Error('HALF_TIME_FULL_TIME_DISTRIBUTION_INVALID');
  const isDC = ft.distributionFamily === 'POISSON_DIXON_COLES';
  if (requireDC && !isDC) throw Error('HALF_TIME_FULL_TIME_FAMILY_UNSUPPORTED');
  if (isDC && (![ft.homeRate, ft.awayRate].every(x => Number.isFinite(x) && x > 0 && x <= 30) || !Number.isFinite(ft.rho))) throw Error('HALF_TIME_FULL_TIME_DISTRIBUTION_INVALID');
  if (isDC && [[0, 0], [0, 1], [1, 0], [1, 1]].some(([h, a]) => !(tau(h, a, ft.homeRate, ft.awayRate, ft.rho) > 0))) throw Error('HALF_TIME_DEPENDENCE_INVALID');
  if (![ft.retainedMass, ft.tailMass].every(x => Number.isFinite(x) && x >= 0 && x <= 1 + 1e-10) || Math.abs(ft.retainedMass + ft.tailMass - 1) > 1e-10) throw Error('HALF_TIME_FULL_TIME_MASS_INVALID');
  let mass = 0; const seen = new Set();
  for (const c of ft.cells) {
    if (![c.home, c.away].every(x => Number.isInteger(x) && x >= 0 && x <= 300) || !Number.isFinite(c.probability) || c.probability < 0) throw Error('HALF_TIME_FULL_TIME_CELL_INVALID');
    const key = `${c.home}:${c.away}`;
    if (seen.has(key)) throw Error('HALF_TIME_FULL_TIME_CELL_DUPLICATE');
    seen.add(key); mass += c.probability;
    // The analytic HT scorer applies only to the disclosed DC FT distribution.
    if (isDC) {
      const expected = Math.exp(logDC(c.home, c.away, ft.homeRate, ft.awayRate, ft.rho));
      if (Math.abs(c.probability - expected) > Math.max(1e-14, expected * 1e-9)) throw Error('HALF_TIME_FULL_TIME_NOT_DC');
    }
  }
  if (Math.abs(mass - ft.retainedMass) > 1e-10) throw Error('HALF_TIME_FULL_TIME_MASS_INVALID');
}

function parameters(ft, model) {
  return {
    homeRate: ft.homeRate * model.shares.home,
    awayRate: ft.awayRate * model.shares.away,
    // Thinning attenuates DC dependence. Retaining the FT rho would be wrong.
    rho: ft.rho * Math.exp(-(1 - model.shares.home) * ft.homeRate - (1 - model.shares.away) * ft.awayRate),
  };
}

function poissonCells(rate, tolerance) {
  if (rate === 0) return [1];
  const values = [Math.exp(-rate)]; let mass = values[0];
  for (let n = 1; n < 2 || 1 - mass > tolerance / 2; n++) {
    if (n > 300) throw Error('HALF_TIME_TAIL_NOT_CONVERGED');
    values.push(values.at(-1) * rate / n); mass += values.at(-1);
  }
  return values;
}

export function predictHalfTimeDistribution(ft, model, options = {}) {
  checkModel(model, options); checkFullTime(ft);
  if (ft.league !== undefined && ft.league !== model.league) throw Error('HALF_TIME_LEAGUE_MISMATCH');
  if (ft.distributionFamily !== 'POISSON_DIXON_COLES') {
    const mixed = new Map();
    for (const c of soccerHalfTimeJointCells(ft, model, options)) {
      const key = `${c.home}:${c.away}`, existing = mixed.get(key);
      if (existing) existing.probability += c.probability;
      else mixed.set(key, { home: c.home, away: c.away, probability: c.probability });
    }
    const cells = [...mixed.values()].sort((a, b) => a.home - b.home || a.away - b.away), probabilities = { home: 0, draw: 0, away: 0 };
    let mass = 0, homeMean = 0, awayMean = 0;
    for (const c of cells) { mass += c.probability; homeMean += c.home * c.probability; awayMean += c.away * c.probability; probabilities[c.home > c.away ? 'home' : c.home === c.away ? 'draw' : 'away'] += c.probability; }
    return {
      cells, retainedMass: mass, tailMass: ft.tailMass, outcomes: probabilities,
      homeRate: ft.tailMass === 0 ? homeMean : null, awayRate: ft.tailMass === 0 ? awayMean : null,
      period: 'REGULATION_HT', league: model.league, modelVersion: model.version,
      shares: { ...model.shares }, exactScoreAvailable: false,
      tailSemantics: 'INHERITED_OMITTED_FT_MASS_CAN_CONTRIBUTE_TO_ANY_HT_SCORE_NOT_HT_OUTSIDE_GRID_PROBABILITY',
      jointContract: { version: HALF_TIME_MODEL_VERSION, method: 'ARBITRARY_FT_PMF_TIMES_CONDITIONAL_BINOMIAL_ALLOCATIONS', fullTimeMarginalPreserved: true, halfTimeNeverExceedsFullTime: true, secondHalfIdentity: 'SECOND_HALF = FULL_TIME - HALF_TIME', ftRetainedMass: ft.retainedMass, ftTailMass: ft.tailMass },
      status: 'RESEARCH_ONLY', formalEnabled: false, executable: false,
    };
  }
  const { homeRate, awayRate, rho } = parameters(ft, model);
  const tolerance = ft.tolerance > 0 && ft.tolerance < 1e-6 ? ft.tolerance : 1e-12;
  const hp = poissonCells(homeRate, tolerance), ap = poissonCells(awayRate, tolerance);
  const cells = [], probabilities = { home: 0, draw: 0, away: 0 }; let retainedMass = 0;
  for (let h = 0; h < hp.length; h++) for (let a = 0; a < ap.length; a++) {
    const probability = hp[h] * ap[a] * tau(h, a, homeRate, awayRate, rho);
    if (!Number.isFinite(probability) || probability < 0) throw Error('HALF_TIME_PROBABILITY_INVALID');
    cells.push({ home: h, away: a, probability }); retainedMass += probability;
    probabilities[h > a ? 'home' : h === a ? 'draw' : 'away'] += probability;
  }
  const tailMass = Math.max(0, 1 - retainedMass);
  if (retainedMass > 1 + 1e-10 || tailMass > tolerance * 1.1) throw Error('HALF_TIME_PROBABILITY_MASS_INVALID');
  return {
    homeRate, awayRate, rho, cells, retainedMass, tailMass, tolerance, outcomes: probabilities,
    distributionFamily: 'POISSON_DIXON_COLES_THINNED', exactScoreAvailable: true,
    period: 'REGULATION_HT', league: model.league, modelVersion: model.version,
    protocolVersion: model.protocolVersion, trainingHash: model.trainingHash, trainedThrough: model.trainedThrough,
    shares: { ...model.shares }, status: 'RESEARCH_ONLY', formalEnabled: false, executable: false,
    tailSemantics: 'HT_OWN_ADAPTIVE_GRID_OMITTED_MASS_NOT_FT_TAIL',
    jointContract: {
      version: HALF_TIME_MODEL_VERSION,
      method: 'FT_DC_PMF_TIMES_CONDITIONALLY_INDEPENDENT_BINOMIAL_HT_ALLOCATIONS',
      support: '0 <= HT_HOME <= FT_HOME; 0 <= HT_AWAY <= FT_AWAY',
      fullTimeMarginalPreserved: true, halfTimeNeverExceedsFullTime: true, secondHalfIdentity: 'SECOND_HALF = FULL_TIME - HALF_TIME',
      ftRetainedMass: ft.retainedMass, ftTailMass: ft.tailMass,
      generatorTailSemantics: 'JOINT_GENERATOR_OMITS_FT_TAIL; OMITTED_MASS_CAN_CONTRIBUTE_TO_ANY_HT_SCORE',
      homeShare: model.shares.home, awayShare: model.shares.away,
    },
  };
}

export function soccerHalfTimeLogProbability(homeGoals, awayGoals, ft, model) {
  if (![homeGoals, awayGoals].every(x => Number.isInteger(x) && x >= 0 && x <= 300)) throw Error('HALF_TIME_OBSERVED_SCORE_INVALID');
  checkModel(model); checkFullTime(ft, { requireDC: true });
  if (ft.league !== undefined && ft.league !== model.league) throw Error('HALF_TIME_LEAGUE_MISMATCH');
  const { homeRate, awayRate, rho } = parameters(ft, model);
  return logDC(homeGoals, awayGoals, homeRate, awayRate, rho);
}

function binomialProbabilities(n, q) {
  const values = Array(n + 1).fill(0);
  if (q === 0) { values[0] = 1; return values; }
  if (q === 1) { values[n] = 1; return values; }
  const logNF = logFactorial(n); let mass = 0;
  for (let k = 0; k <= n; k++) { values[k] = Math.exp(logNF - logFactorial(k) - logFactorial(n - k) + k * Math.log(q) + (n - k) * Math.log1p(-q)); mass += values[k]; }
  // This is the complete finite conditional support; normalization only removes floating error.
  return values.map(value => value / mass);
}

export function* soccerHalfTimeJointCells(ft, model, options = {}) {
  checkModel(model, options); checkFullTime(ft);
  if (ft.league !== undefined && ft.league !== model.league) throw Error('HALF_TIME_LEAGUE_MISMATCH');
  const homeCache = new Map(), awayCache = new Map();
  for (const c of ft.cells) {
    if (!homeCache.has(c.home)) homeCache.set(c.home, binomialProbabilities(c.home, model.shares.home));
    if (!awayCache.has(c.away)) awayCache.set(c.away, binomialProbabilities(c.away, model.shares.away));
    const hp = homeCache.get(c.home), ap = awayCache.get(c.away);
    for (let home = 0; home < hp.length; home++) for (let away = 0; away < ap.length; away++) {
      const probability = c.probability * hp[home] * ap[away];
      if (probability > 0) yield { ftHome: c.home, ftAway: c.away, home, away, probability };
    }
  }
}

export function evaluateHalfTimeModel(model, rows, { predictFullTime } = {}) {
  checkModel(model);
  if (!Array.isArray(rows) || typeof predictFullTime !== 'function') throw Error('HALF_TIME_EVALUATION_OPTIONS_INVALID');
  const games = [], bins = Array.from({ length: 10 }, (_, i) => ({ from: i / 10, to: (i + 1) / 10, count: 0, predicted: 0, observed: 0 }));
  let count = 0, scoreLogLoss = 0, logLoss = 0, brier = 0;
  for (const row of rows) {
    try {
      // Validate the entire row before touching any metric numerator.
      const h = verifiedHalfTime(row);
      if (row.league !== model.league || !/^\d+$/.test(row.eventId || '') || !/^\d+$/.test(row.homeId || '') || !/^\d+$/.test(row.awayId || '') || row.homeId === row.awayId || row.period !== 'REGULATION_FT' || !Number.isFinite(Date.parse(row.startTime)) || ![row.homeGoals, row.awayGoals].every(x => Number.isInteger(x) && x >= 0 && x <= 30) || !row.source?.url || !row.source?.contentHash) throw Error('HALF_TIME_EVALUATION_ROW_INVALID');
      const ft = predictFullTime(row), d = predictHalfTimeDistribution(ft, model, { league: row.league, startTime: row.startTime });
      const scoreLoss = -soccerHalfTimeLogProbability(h.home, h.away, ft, model), outcome = h.home > h.away ? 'home' : h.home === h.away ? 'draw' : 'away';
      const outcomeLoss = -Math.log(d.outcomes[outcome]);
      const rowBrier = outcomes.reduce((sum, key) => sum + (d.outcomes[key] - (key === outcome ? 1 : 0)) ** 2, 0);
      if (Number.isNaN(scoreLoss) || Number.isNaN(outcomeLoss) || !Number.isFinite(rowBrier)) throw Error('HALF_TIME_METRIC_INVALID');
      scoreLogLoss += scoreLoss; logLoss += outcomeLoss; brier += rowBrier; count++;
      for (const key of outcomes) { const p = d.outcomes[key], bin = bins[Math.min(9, Math.floor(p * 10))]; bin.count++; bin.predicted += p; bin.observed += key === outcome ? 1 : 0; }
      games.push({ eventId: row.eventId, status: 'EVALUATED', scoreLogLoss: scoreLoss, logLoss: outcomeLoss, brier: rowBrier });
    } catch (error) { games.push({ eventId: row?.eventId ?? null, status: 'SKIPPED', reason: error.message }); }
  }
  return {
    total: rows.length, count, sample: rows.length, used: count, excluded: rows.length - count, coverage: rows.length ? count / rows.length : 0,
    scoreLogLoss: count ? scoreLogLoss / count : null, logLoss: count ? logLoss / count : null, brier: count ? brier / count : null,
    bins: bins.map(b => ({ ...b, meanPredicted: b.count ? b.predicted / b.count : null, observedFrequency: b.count ? b.observed / b.count : null })),
    binInterpretation: 'POOLED_THREE_CLASS_HT_OUTCOME_RELIABILITY_DIAGNOSTIC', games,
    status: 'RESEARCH_ONLY', formalEnabled: false, profit: null, bettingEvidence: false,
  };
}
