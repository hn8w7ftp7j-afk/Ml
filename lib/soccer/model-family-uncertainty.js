import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import { evaluateSoccerQuote } from './market-payoff.js';

// This is a confidence set WITHIN an explicitly assumed model family. It is
// deliberately not an estimate of model misspecification and cannot register
// an accepted uncertainty artifact or enable a football score by itself.
export const SOCCER_MODEL_FAMILY_UNCERTAINTY_VERSION = 'SOCCER-POISSON-DC-FAMILY-CONFIDENCE-v1';
const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });
const Down = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_FLOOR });
const Up = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_CEIL });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const soccerModelFamilyHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const restrictions = { accepted: false, formalEligible: false, calibrationEligible: false, promotionEligible: false,
  executable: false, empiricalErrorMargin: null, W: null, R: null, S: null };
const seal = value => ({ ...value, contentHash: soccerModelFamilyHash(value) });
function step(value, upper) {
  if (!finite(value)) throw Error('SOCCER_FAMILY_NUMERIC_OVERFLOW');
  if (value === 0) return upper ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + ((value > 0) === upper ? 1n : -1n));
  return view.getFloat64(0);
}
const boundNumber = (value, upper) => step(Number(value.toString()), upper);
const boundedProbability = (value, upper) => Math.max(0, Math.min(1, boundNumber(value, upper)));
const interval = value => finite(value?.lower) && finite(value?.upper) && value.lower >= 0 && value.lower <= value.upper;
// Decimal(number) reads the shortest JSON decimal, which need not equal the
// exact IEEE value used by existing JS models. Expand input endpoints BEFORE
// nonlinear operations so both meanings are enclosed, not merely the output.
const inputLower = value => new Down(step(value, false));
const inputUpper = value => new Up(step(value, true));
const nonnegativeInputLower = value => D.max(0, inputLower(value));
const enclosingRates = rates => ({ lower: Math.max(0, step(rates.lower, false)), upper: step(rates.upper, true) });
function klBounds(count, mean) {
  if (mean.isZero()) return count === 0 ? { lower: new D(0), upper: new D(0) }
    : { lower: new D(Infinity), upper: new D(Infinity) };
  if (count === 0) return { lower: new D(mean), upper: new D(mean) };
  // ln and exp are correctly rounded in decimal.js at this precision. Taking
  // the difference of directed logarithms avoids an unrounded ratio/log.
  const logLower = new Down(count).ln().minus(new Up(mean).ln());
  const logUpper = new Up(count).ln().minus(new Down(mean).ln());
  return { lower: new Down(count).times(logLower).plus(mean).minus(count),
    upper: new Up(count).times(logUpper).plus(mean).minus(count) };
}

/** Invert BOTH Poisson Chernoff tails. For S~Poisson(mu),
 * d(S,mu)=S log(S/mu)+mu-S; P(d(S,mu)>log(2/delta))<=delta.
 * `errorProbability` is delta for this ONE marginal, not the joint error.
 * Roots are enclosed by outside endpoints, never an interpolated point. */
export function poissonChernoffMeanInterval(count, errorProbability) {
  if (!Number.isSafeInteger(count) || count < 0 || !finite(errorProbability)
    || !(errorProbability > 0 && errorProbability < 1)) throw Error('SOCCER_FAMILY_POISSON_INPUT_INVALID');
  const conservativeError = nonnegativeInputLower(errorProbability);
  if (conservativeError.isZero()) throw Error('SOCCER_FAMILY_POISSON_ERROR_BUDGET_UNREPRESENTABLE');
  const thresholdLower = new Down(2).div(conservativeError).ln();
  const thresholdUpper = new Up(2).div(conservativeError).ln();
  let lower = new D(0);
  if (count > 0) {
    let outside = new D(0), inside = new D(count);
    for (let index = 0; index < 90; index++) {
      const middle = outside.plus(inside).div(2), divergence = klBounds(count, middle);
      if (divergence.lower.gt(thresholdUpper)) outside = middle;
      else if (divergence.upper.lt(thresholdLower)) inside = middle;
      else break;
    }
    lower = outside;
  }
  let inside = new D(count), outside = new D(count).plus(thresholdUpper).plus(1);
  for (let index = 0; !klBounds(count, outside).lower.gt(thresholdUpper); index++) {
    if (index > 2000) throw Error('SOCCER_FAMILY_POISSON_BRACKET_FAILED');
    outside = outside.times(2).plus(1);
  }
  for (let index = 0; index < 90; index++) {
    const middle = inside.plus(outside).div(2), divergence = klBounds(count, middle);
    if (divergence.lower.gt(thresholdUpper)) outside = middle;
    else if (divergence.upper.lt(thresholdLower)) inside = middle;
    else break;
  }
  return { lower: count === 0 ? 0 : Math.max(0, boundNumber(lower, false)),
    upper: boundNumber(outside, true), errorProbability,
    method: 'TWO_SIDED_POISSON_CHERNOFF_KL_OUTSIDE_ROOT_ENCLOSURE' };
}

/** Exactly ONE unweighted count per real game. Multiple models, quote sides,
 * prices, heartbeat receipts, HT+FT and leagues cannot inflate this sample. */
export function buildSoccerModelFamilyConfidenceSet({ observations = [], baseline, protocol, now = Date.now() } = {}) {
  const reasons = {}, add = code => { reasons[code] = (reasons[code] || 0) + 1; };
  const scopeValid = ['epl', 'ucl'].includes(baseline?.league) && ['FT', 'HT'].includes(baseline?.period)
    && sha(baseline?.modelHash) && Array.isArray(baseline.sourceHashes) && baseline.sourceHashes.length > 0
    && baseline.sourceHashes.every(sha) && finite(now) && Number.isFinite(instant(baseline.createdAt))
    && Number.isFinite(instant(baseline.trainedThrough)) && instant(baseline.trainedThrough) < instant(baseline.createdAt);
  const times = ['registeredAt', 'calibrationFrom', 'calibrationBefore'].map(key => instant(protocol?.[key]));
  const marginalAlpha = finite(protocol?.alpha) && protocol.alpha > 0 && protocol.alpha < 1
    ? step(protocol.alpha / 2, false) : null;
  const protocolValid = scopeValid && times.every(Number.isFinite) && times[0] <= times[1] && times[1] < times[2]
    && instant(baseline.createdAt) <= times[1] && times[2] <= now
    && marginalAlpha > Number.MIN_VALUE;
  if (!scopeValid) add('MODEL_FAMILY_BASELINE_INVALID');
  if (!protocolValid) add('MODEL_FAMILY_FROZEN_WINDOW_PROTOCOL_INVALID');
  const selected = new Map(), quarantined = new Set();
  if (protocolValid) for (const row of observations) {
    if (row?.league !== baseline.league || row?.period !== baseline.period || row?.baselineModelHash !== baseline.modelHash) {
      add('MODEL_FAMILY_OBSERVATION_OUTSIDE_SCOPE'); continue;
    }
    if (typeof row.gameId !== 'string' || !new RegExp(`^soccer:${baseline.league}:\\d{1,16}$`).test(row.gameId)
      || ![row.homeRate, row.awayRate].every(value => finite(value) && value > 0 && value <= 100)
      || !['home', 'away'].every(side => Number.isSafeInteger(row.actualScore?.[side]) && row.actualScore[side] >= 0 && row.actualScore[side] <= 100)
      || !Array.isArray(row.sourceHashes) || !row.sourceHashes.length || !row.sourceHashes.every(sha)
      || !Number.isFinite(instant(row.kickoff)) || instant(row.kickoff) < times[1] || instant(row.kickoff) >= times[2]
      || !Number.isFinite(instant(row.resultAvailableAt)) || instant(row.resultAvailableAt) <= instant(row.kickoff)
      || instant(row.resultAvailableAt) > now
      || row.predictedAt != null && (!Number.isFinite(instant(row.predictedAt))
        || instant(row.predictedAt) < instant(baseline.createdAt) || instant(row.predictedAt) >= instant(row.kickoff))) {
      add('MODEL_FAMILY_OBSERVATION_INVALID'); continue;
    }
    const identity = soccerModelFamilyHash({ kickoff: row.kickoff, homeRate: row.homeRate, awayRate: row.awayRate,
      actualScore: row.actualScore });
    if (selected.has(row.gameId) && selected.get(row.gameId).identity !== identity) quarantined.add(row.gameId);
    else if (!selected.has(row.gameId)) selected.set(row.gameId, { row, identity });
  }
  const rows = [...selected].filter(([key]) => !quarantined.has(key)).map(([, value]) => value.row)
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.gameId.localeCompare(b.gameId));
  if (quarantined.size) reasons.MODEL_FAMILY_CONFLICTING_REAL_GAME = quarantined.size;
  if (!rows.length) add('MODEL_FAMILY_INDEPENDENT_GAMES_MISSING');
  const marginals = {};
  if (rows.length) for (const side of ['home', 'away']) {
    const goals = rows.reduce((sum, row) => sum + row.actualScore[side], 0);
    // Exact input decimals summed with opposite rounding directions; the rate
    // multiplier interval divides by the opposite exposure endpoint.
    const exposureLower = rows.reduce((sum, row) => sum.plus(nonnegativeInputLower(row[`${side}Rate`])), new Down(0));
    const exposureUpper = rows.reduce((sum, row) => sum.plus(inputUpper(row[`${side}Rate`])), new Up(0));
    const mean = poissonChernoffMeanInterval(goals, marginalAlpha);
    marginals[side] = { goals, exposure: { lower: boundNumber(exposureLower, false), upper: boundNumber(exposureUpper, true) },
      countMean: mean, multiplier: { lower: mean.lower === 0 ? 0 : Math.max(0, boundNumber(new Down(nonnegativeInputLower(mean.lower)).div(exposureUpper), false)),
        upper: boundNumber(new Up(inputUpper(mean.upper)).div(exposureLower), true) } };
  }
  return seal({ version: SOCCER_MODEL_FAMILY_UNCERTAINTY_VERSION, type: 'MODEL_FAMILY_RATE_CONFIDENCE_SET', ...restrictions,
    status: rows.length ? 'MODEL_FAMILY_ONLY_CONFIDENCE_SET' : 'MISSING_VALID_CALIBRATION_GAMES',
    generatedAt: finite(now) ? new Date(now).toISOString() : null, baseline: baseline || null, protocol: protocol || null,
    protocolHash: soccerModelFamilyHash(protocol || null), independentRealGames: rows.length,
    observationHashes: rows.map(soccerModelFamilyHash), quarantinedGames: quarantined.size, excludedReasons: reasons, marginals,
    family: 'FROZEN_BASELINE_TIMES_STABLE_HOME_AWAY_MULTIPLIERS_WITH_LEGAL_DIXON_COLES_DEPENDENCE',
    simultaneousErrorProbability: rows.length ? protocol.alpha : null,
    coverageAssumptionsVerified: false, durableFreezeVerified: false, modelMisspecificationBound: null,
    individualGameApplicabilityVerified: false,
    assumptions: ['Baseline model and selection window fixed independently of the calibration outcomes.',
      'Distinct real games are conditionally independent; no independence of home and away within a game is needed.',
      'Poisson marginal rates equal one stable home/away multiplier times the frozen baseline rates in calibration AND the target game.',
      'All relevant real games are included without outcome-based selection or delayed-result exclusion.',
      'Dixon-Coles dependence may vary but every score probability is nonnegative.'],
    interpretation: 'FINITE_SAMPLE_MODEL_FAMILY_CONFIDENCE_ONLY_NOT_VERIFIED_TOTAL_MODEL_ERROR_OR_FORMAL_R' });
}

function pmfAt(k, rate, Constructor) {
  if (rate === 0) return new Constructor(k === 0 ? 1 : 0);
  let value = new Constructor(rate).negated().exp();
  for (let n = 1; n <= k; n++) value = value.times(rate).div(n);
  return value;
}
/** The Poisson PMF is unimodal as a function of lambda with mode lambda=k.
 * Therefore endpoint minima and the clamped mode maximum cover the ENTIRE
 * continuous rate interval. This is not a grid search. */
export function poissonCellProbabilityBounds(k, rates) {
  if (!Number.isSafeInteger(k) || k < 0 || k > 1000 || !interval(rates) || rates.upper > 1000)
    throw Error('SOCCER_FAMILY_CELL_INPUT_INVALID');
  return enclosedPoissonCellProbabilityBounds(k, enclosingRates(rates));
}
function enclosedPoissonCellProbabilityBounds(k, rates) {
  const lower = D.min(pmfAt(k, rates.lower, Down), pmfAt(k, rates.upper, Down));
  const maximumAt = Math.max(rates.lower, Math.min(rates.upper, k));
  const upper = pmfAt(k, maximumAt, Up);
  return { lower: boundedProbability(lower, false), upper: boundedProbability(upper, true) };
}
function jointBounds(home, away, maxGoals) {
  home = enclosingRates(home); away = enclosingRates(away);
  const h = Array.from({ length: maxGoals + 1 }, (_, k) => enclosedPoissonCellProbabilityBounds(k, home));
  const a = Array.from({ length: maxGoals + 1 }, (_, k) => enclosedPoissonCellProbabilityBounds(k, away));
  const cells = [];
  for (let x = 0; x <= maxGoals; x++) for (let y = 0; y <= maxGoals; y++) {
    cells.push({ home: x, away: y, lower: new Down(h[x].lower).times(a[y].lower), upper: new Up(h[x].upper).times(a[y].upper) });
  }
  const at = (x, y) => cells[x * (maxGoals + 1) + y];
  // DC is the single signed mass transfer (-c,+c,+c,-c) in the 2x2 low-score
  // block. Nonnegative probabilities imply -min(p01,p10)<=c<=min(p00,p11).
  // Bounding this transfer retains EVERY legal rho, including rho=0, without
  // inventing an empirical probability for a nuisance parameter.
  const cLower = D.min(at(0, 1).upper, at(1, 0).upper).negated();
  const cUpper = D.min(at(0, 0).upper, at(1, 1).upper);
  for (const [x, y, sign] of [[0, 0, -1], [0, 1, 1], [1, 0, 1], [1, 1, -1]]) {
    const cell = at(x, y);
    cell.lower = D.max(0, sign > 0 ? new Down(cell.lower).plus(cLower) : new Down(cell.lower).minus(cUpper));
    cell.upper = D.min(1, sign > 0 ? new Up(cell.upper).plus(cUpper) : new Up(cell.upper).minus(cLower));
  }
  // K>=1 includes the entire DC transfer, whose sum is zero. Thus the CDF
  // rectangle is exactly the independent Poisson rectangle for every rho.
  const cdfLower = rates => {
    let term = new Down(rates.upper).negated().exp(), sum = new Down(term);
    for (let k = 1; k <= maxGoals; k++) { term = term.times(rates.upper).div(k); sum = sum.plus(term); }
    return sum;
  };
  const tailUpper = D.min(1, D.max(0, new Up(1).minus(new Down(cdfLower(home)).times(cdfLower(away)))));
  return { cells, tailUpper };
}
function payoffInterval({ winFraction, lossFraction, netPerUnit }, quote, rebate) {
  const unitFraction = value => ({ lower: D.max(0, inputLower(value)), upper: D.min(1, inputUpper(value)) });
  const win = unitFraction(winFraction), loss = unitFraction(lossFraction), rate = unitFraction(rebate.rate);
  let basis;
  if (rebate.basis === 'TOTAL_PRINCIPAL') basis = { lower: new D(1), upper: new D(1) };
  else if (rebate.basis === 'SETTLED_PRINCIPAL') basis = { lower: new Down(win.lower).plus(loss.lower),
    upper: D.min(1, new Up(win.upper).plus(loss.upper)) };
  else if (rebate.basis === 'LOSS_PRINCIPAL') basis = loss;
  else basis = { lower: new D(0), upper: new D(0) };
  const lower = new Down(win.lower).times(nonnegativeInputLower(quote.water)).minus(loss.upper)
    .plus(new Down(rate.lower).times(basis.lower));
  const upper = new Up(win.upper).times(inputUpper(quote.water)).minus(loss.lower)
    .plus(new Up(rate.upper).times(basis.upper));
  // Enclose both the directed reconstruction of the original rule arithmetic
  // and the existing engine's binary64 output. Cancellation in multiple JS
  // operations can exceed one final netPerUnit ULP, especially near zero.
  return { lower: finite(netPerUnit) ? D.min(lower, inputLower(netPerUnit)) : lower,
    upper: finite(netPerUnit) ? D.max(upper, inputUpper(netPerUnit)) : upper };
}
function simplexPayoffBound(cells, upper) {
  const Constructor = upper ? Up : Down;
  const values = [...new Set(cells.map(cell => (upper ? cell.payoffUpper : cell.payoffLower).toString()))];
  // Dual bounds for probabilities in their enclosing intervals and sum(p)=1.
  // Every t is valid: t+sum((v_i-t)*p_i). Optimizing only these piecewise-linear
  // dual breakpoints tightens the bound without any parameter-grid extrema.
  const candidates = values.map(t => {
    let result = new Constructor(t);
    for (const cell of cells) {
      const coefficient = new Constructor(upper ? cell.payoffUpper : cell.payoffLower).minus(t);
      const probability = upper ? coefficient.gte(0) ? cell.upper : cell.lower : coefficient.gte(0) ? cell.lower : cell.upper;
      result = result.plus(coefficient.times(probability));
    }
    return result;
  });
  return upper ? D.min(...candidates) : D.max(...candidates);
}

/** Integrate a quote's unchanged credit/Asian payoff across a CONTINUOUS rate
 * rectangle and all legal DC rho values. Unknown tail uses worst payoff; no
 * midpoint, tail normalization, point estimate, S/W/R or approval is emitted. */
export function boundSoccerModelFamilyQuote({ quote, contract, game, rates, maxGoals = 16 } = {}) {
  if (!['epl', 'ucl'].includes(game?.league) || !['FT', 'HT'].includes(quote?.period) || !interval(rates?.home)
    || !interval(rates?.away) || rates.home.upper > 1000 || rates.away.upper > 1000
    || !Number.isSafeInteger(maxGoals) || maxGoals < 1 || maxGoals > 100) throw Error('SOCCER_FAMILY_QUOTE_SCOPE_INVALID');
  let arithmeticContract = contract;
  if (contract?.rebate?.appliesTo != null) {
    const mask = contract.rebate.appliesTo;
    if (contract.rebate.basis !== 'SETTLED_PRINCIPAL'
      || Object.keys(mask).sort().join(',') !== 'FULL_LOSS,FULL_WIN,PARTIAL_LOSS,PARTIAL_WIN,PUSH'
      || mask.PUSH !== false || ['FULL_WIN', 'PARTIAL_WIN', 'PARTIAL_LOSS', 'FULL_LOSS'].some(key => mask[key] !== true))
      throw Error('SOCCER_FAMILY_OUTCOME_SPECIFIC_REBATE_UNSUPPORTED');
    // This exact mask is equivalent to settled-principal arithmetic. Other
    // outcome masks are never silently discarded by the base payoff adapter.
    arithmeticContract = { ...contract, rebate: { rate: contract.rebate.rate, basis: contract.rebate.basis } };
  }
  const joint = jointBounds(rates.home, rates.away, maxGoals);
  // Probability here is a device to ask the EXISTING settlement engine for
  // every deterministic score payoff. It is never used as a model forecast.
  const distribution = { period: quote.period === 'FT' ? 'REGULATION_FT' : 'REGULATION_HT',
    retainedMass: 1, tailMass: 0, cells: joint.cells.map((cell, index) => ({ home: cell.home, away: cell.away, probability: index === 0 ? 1 : 0 })) };
  const payoff = evaluateSoccerQuote({ quote, contract: arithmeticContract, distribution });
  if (!payoff.ok) throw Error(`SOCCER_FAMILY_PAYOFF_INVALID:${payoff.code}`);
  const payoffRange = payoff.tailUncertainty.payoffRanges.net;
  const enclosed = joint.cells.map((cell, index) => {
    const bounds = payoffInterval(payoff.rows[index], quote, arithmeticContract.rebate);
    return { ...cell, payoffLower: bounds.lower, payoffUpper: bounds.upper };
  });
  const cornerBounds = [{ winFraction: 1, lossFraction: 0 }, { winFraction: 0, lossFraction: 1 },
    { winFraction: 0, lossFraction: 0 }].map(row => payoffInterval(row, quote, arithmeticContract.rebate));
  enclosed.push({ lower: new D(0), upper: joint.tailUpper,
    payoffLower: D.min(inputLower(payoffRange.min), ...cornerBounds.map(value => value.lower)),
    payoffUpper: D.max(inputUpper(payoffRange.max), ...cornerBounds.map(value => value.upper)) });
  const lower = simplexPayoffBound(enclosed, false), upper = simplexPayoffBound(enclosed, true);
  return seal({ version: SOCCER_MODEL_FAMILY_UNCERTAINTY_VERSION, type: 'INDIVIDUAL_MODEL_FAMILY_PAYOFF_ENCLOSURE', ...restrictions,
    league: game.league, gameId: game.id || null, period: quote.period, rates, quoteHash: soccerModelFamilyHash(quote), contractHash: soccerModelFamilyHash(contract),
    bounds: { lower: boundNumber(lower, false), upper: boundNumber(upper, true) },
    unit: 'NET_PROFIT_PER_1_STAKE', maxGoals, omittedMassUpper: boundedProbability(joint.tailUpper, true),
    continuousDomainCovered: true, nuisanceDependence: 'ALL_LEGAL_DIXON_COLES_RHO_VALUES',
    inputNumberSemantics: 'ENCLOSURE_OF_ARCHIVED_JSON_DECIMAL_AND_IEEE_BINARY64_VALUES',
    tailPolicy: 'UNRESOLVED_MASS_TIMES_WORST_CASE_EXISTING_SETTLEMENT_PAYOFF',
    probabilityNormalizationApplied: false, modelMisspecificationBound: null,
    interpretation: 'INDIVIDUAL_CONDITIONAL_EV_BOUND_WITHIN_ASSUMED_RATE_FAMILY_ONLY_NOT_FORMAL_R' });
}

/** Scope-checked adapter from the calibration family set to ONE future game.
 * A conditional error bound around a supplied W is exposed separately from
 * `empiricalErrorMargin`; only a future independent acceptance process could
 * justify using it as the formal scorer's modelError.value. */
export function evaluateSoccerModelFamilyUncertainty({ confidenceSet, baselineRates, quote, contract, game,
  weightedExpectedReturn = null, maxGoals = 16, now = Date.now() } = {}) {
  const { contentHash, ...body } = confidenceSet || {};
  if (confidenceSet?.version !== SOCCER_MODEL_FAMILY_UNCERTAINTY_VERSION
    || confidenceSet.type !== 'MODEL_FAMILY_RATE_CONFIDENCE_SET' || contentHash !== soccerModelFamilyHash(body)
    || confidenceSet.independentRealGames < 1 || confidenceSet.accepted !== false || confidenceSet.formalEligible !== false
    || confidenceSet.baseline?.league !== game?.league || confidenceSet.baseline?.period !== quote?.period
    || confidenceSet.baseline?.modelHash !== baselineRates?.modelHash
    || ![baselineRates?.homeRate, baselineRates?.awayRate].every(value => finite(value) && value > 0 && value <= 100)
    || !['epl', 'ucl'].includes(game?.league) || !/^\d{1,16}$/.test(game?.sourceId || '')
    || game.id !== `soccer:${game.league}:${game.sourceId}` || game.status !== 'scheduled'
    || !finite(now) || !Number.isFinite(instant(game.startTime)) || !(instant(game.startTime) > now)
    || !Number.isFinite(instant(confidenceSet.generatedAt)) || instant(confidenceSet.generatedAt) > now
    || weightedExpectedReturn !== null && !finite(weightedExpectedReturn)) throw Error('SOCCER_FAMILY_TARGET_SCOPE_INVALID');
  const rates = Object.fromEntries(['home', 'away'].map(side => {
    const multiplier = confidenceSet.marginals?.[side]?.multiplier;
    if (!interval(multiplier)) throw Error('SOCCER_FAMILY_TARGET_MULTIPLIER_INVALID');
    const base = baselineRates[`${side}Rate`];
    return [side, { lower: multiplier.lower === 0 ? 0 : Math.max(0, boundNumber(new Down(nonnegativeInputLower(base)).times(nonnegativeInputLower(multiplier.lower)), false)),
      upper: boundNumber(new Up(inputUpper(base)).times(inputUpper(multiplier.upper)), true) }];
  }));
  const enclosure = boundSoccerModelFamilyQuote({ quote, contract, game, rates, maxGoals });
  let familyOnlyErrorBound = null;
  if (weightedExpectedReturn !== null) familyOnlyErrorBound = Math.max(0,
    boundNumber(new Up(inputUpper(weightedExpectedReturn)).minus(inputLower(enclosure.bounds.lower)), true),
    boundNumber(new Up(inputUpper(enclosure.bounds.upper)).minus(inputLower(weightedExpectedReturn)), true));
  const { contentHash: enclosureHash, ...enclosureBody } = enclosure;
  return seal({ ...enclosureBody, type: 'INDIVIDUAL_MODEL_FAMILY_UNCERTAINTY', confidenceSetHash: contentHash,
    enclosureHash, baselineModelHash: baselineRates.modelHash, evaluatedAt: new Date(now).toISOString(),
    independentRealGames: confidenceSet.independentRealGames, simultaneousErrorProbability: confidenceSet.simultaneousErrorProbability,
    familyOnlyErrorBound, referenceWeightedExpectedReturn: weightedExpectedReturn,
    coverageAssumptionsVerified: false, durableFreezeVerified: false, individualGameApplicabilityVerified: false,
    formalModelError: null,
    acceptanceRequired: ['DURABLE_PRECALIBRATION_MODEL_AND_PROTOCOL_RECEIPTS', 'COMPLETE_OUTCOME_INDEPENDENT_GAME_COHORT',
      'INDEPENDENCE_AND_STABLE_RATE_FAMILY_APPLICABILITY', 'MODEL_MISSPECIFICATION_AND_PERSONNEL_EFFECT_VALIDATION',
      'CURRENT_QUOTE_AND_SETTLEMENT_CONTRACT_BINDING', 'INDEPENDENT_CALIBRATION_AND_UNTOUCHED_EVALUATION'] });
}
