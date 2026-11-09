import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';

export const VERSION = 'CONDITIONAL-RETURN-ERROR-ASSUMPTION-STUDY-v1';
export const FEATURE_VERSION = 'CONDITIONAL_RETURN_FEATURES-v1';
const Down = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_FLOOR });
const Up = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_CEIL });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const conditionalReturnResearchHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fields = ['league', 'period', 'variant', 'modelHash', 'settlementRuleFamilyHash', 'kind', 'side', 'lineSide'];
const restrictions = Object.freeze({ accepted: false, formalEligible: false, executable: false,
  formalMargin: null, modelError: null, W: null, R: null, S: null,
  sourceAuthorityVerified: false, durableFreezeVerified: false, assumptionsVerified: false,
  individualGameApplicabilityVerified: false, simultaneousTargetsCovered: false });

// Enclose the actual binary64 input, not its shortened decimal rendering.
function input(value) {
  if (!finite(value)) throw Error('NONFINITE_NUMBER');
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  const bits = view.getBigUint64(0), negative = (bits >> 63n) !== 0n;
  const exponent = Number((bits >> 52n) & 2047n), fraction = bits & ((1n << 52n) - 1n);
  let numerator = exponent === 0 ? fraction : fraction + (1n << 52n);
  let denominator = 1n; const power = exponent === 0 ? -1074 : exponent - 1023 - 52;
  if (power >= 0) numerator <<= BigInt(power); else denominator <<= BigInt(-power);
  if (negative) numerator = -numerator;
  return { lo: new Down(numerator.toString()).div(denominator.toString()), hi: new Up(numerator.toString()).div(denominator.toString()) };
}
const add = (a, b) => ({ lo: new Down(a.lo).plus(b.lo), hi: new Up(a.hi).plus(b.hi) });
const sub = (a, b) => ({ lo: new Down(a.lo).minus(b.hi), hi: new Up(a.hi).minus(b.lo) });
const mul = (a, b) => ({
  lo: Down.min(...[a.lo, a.hi].flatMap(x => [b.lo, b.hi].map(y => new Down(x).times(y)))),
  hi: Up.max(...[a.lo, a.hi].flatMap(x => [b.lo, b.hi].map(y => new Up(x).times(y)))),
});
const divPositive = (a, b) => {
  if (b.lo.lte(0)) throw Error('NONPOSITIVE_DENOMINATOR');
  return { lo: new Down(a.lo).div(b.hi), hi: new Up(a.hi).div(b.lo) };
};
const absUpper = a => Up.max(new Up(a.lo).abs(), new Up(a.hi).abs());
function adjacent(value, direction) {
  if (value === 0) return direction > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  let bits = view.getBigUint64(0); bits += (value > 0) === (direction > 0) ? 1n : -1n;
  view.setBigUint64(0, bits); return view.getFloat64(0);
}
function upperNumber(value) {
  if (value.isZero()) return 0;
  const number = value.toNumber(); if (!finite(number)) throw Error('NUMERICAL_RESULT_NOT_FINITE');
  const result = adjacent(number, 1); if (!finite(result)) throw Error('NUMERICAL_RESULT_NOT_FINITE'); return result;
}
function lowerNumber(value) {
  if (value.isZero()) return 0;
  const number = value.toNumber(); if (!finite(number)) throw Error('NUMERICAL_RESULT_NOT_FINITE');
  const result = adjacent(number, -1); if (!finite(result)) throw Error('NUMERICAL_RESULT_NOT_FINITE'); return result;
}
const publicInterval = value => ({ lower: lowerNumber(value.lo), upper: upperNumber(value.hi) });
const sum = values => values.reduce(add, input(0));
const validHashList = value => Array.isArray(value) && value.length > 0 && value.every(sha);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 300;
const validScope = value => ['epl', 'ucl'].includes(value?.league) && ['FT', 'HT'].includes(value?.period)
  && text(value.variant) && sha(value.modelHash) && sha(value.settlementRuleFamilyHash)
  && (value.kind === 'TOTAL' ? ['over', 'under'].includes(value.side) && value.lineSide === null
    : value.kind === 'HANDICAP' && ['home', 'away'].includes(value.side) && ['home', 'away'].includes(value.lineSide));
const matches = (value, scope) => fields.every(key => value?.[key] === scope[key]);
function validDescriptor(value) {
  return value?.version === FEATURE_VERSION && value.metric === 'WEIGHTED_L1'
    && Array.isArray(value.dimensions) && value.dimensions.length > 0 && value.dimensions.length <= 100
    && value.dimensions.every(row => text(row?.name) && finite(row.scale) && row.scale > 0 && finite(row.weight) && row.weight >= 0)
    && new Set(value.dimensions.map(row => row.name)).size === value.dimensions.length
    && value.dimensions.some(row => row.weight > 0);
}
function validFeatures(row, descriptor, descriptorHash) {
  return row?.featureDescriptorHash === descriptorHash && row.features && !Array.isArray(row.features)
    && Object.keys(row.features).sort().join('\0') === descriptor.dimensions.map(d => d.name).sort().join('\0')
    && descriptor.dimensions.every(d => finite(row.features[d.name]));
}
function distanceUpper(left, right, descriptor) {
  return descriptor.dimensions.reduce((total, dimension) => {
    const difference = absUpper(sub(input(left[dimension.name]), input(right[dimension.name])));
    return total.plus(new Up(difference).times(input(dimension.weight).hi).div(input(dimension.scale).lo));
  }, new Up(0));
}
function forecastFor(row, target = false) {
  const support = row.payoffSupport;
  if (!finite(support?.lower) || !finite(support?.upper) || support.lower > support.upper) return null;
  const typed = row.forecast;
  if (typed != null) {
    if (!['POINT', 'INTERVAL'].includes(typed.type) || !finite(typed.lower) || !finite(typed.upper)
      || typed.lower > typed.upper || typed.lower < support.lower || typed.upper > support.upper
      || !text(typed.method) || !sha(typed.certificateHash) || typed.modelHash !== row.modelHash
      || (typed.type === 'POINT' ? !finite(typed.point) || typed.lower !== typed.point || typed.upper !== typed.point
        : typed.point !== null)
      || row.predictedNetReturn != null && (!finite(row.predictedNetReturn) || typed.type === 'INTERVAL'
        || row.predictedNetReturn !== typed.point)) return null;
    return { ...typed };
  }
  if (!finite(row.predictedNetReturn) || row.predictedNetReturn < support.lower || row.predictedNetReturn > support.upper
    || (target && row.tailError !== 0) || row.status === 'OBSERVED_BOUNDED' || row.predictedReturnBounds != null
    || row.unresolvedTailMass > 0) return null;
  return { type: 'POINT', lower: row.predictedNetReturn, upper: row.predictedNetReturn, point: row.predictedNetReturn,
    method: 'LEGACY_DECLARED_POINT_RESEARCH_INPUT', modelHash: row.modelHash, certificateHash: null };
}

/** Research calculator only. JSON scope, hashes, times and assumption fields are
 * declarations, not authenticated source evidence, durable registration or
 * acceptance. Even a fully populated result cannot supply formal R/S. */
export function estimateConditionalReturnError({ protocol, target, observations = [], assumptions = {}, now = Date.now() } = {}) {
  const base = { version: VERSION, ...restrictions, status: 'INVALID_RESEARCH_INPUT',
    protocolHash: conditionalReturnResearchHash(protocol ?? null), targetHash: conditionalReturnResearchHash(target ?? null),
    interpretation: 'SINGLE_PRESPECIFIED_TARGET_FORECAST_INTERVAL_CONDITIONAL_ON_UNVERIFIED_ASSUMPTIONS_NOT_FORMAL_R',
    estimand: 'SUP_ABSOLUTE_TARGET_FORECAST_INTERVAL_MINUS_FULL_CONTEXT_CONDITIONAL_EXPECTED_NET_RETURN_PER_UNIT_STAKE',
    reasons: [], components: null, conditionalTotalBound: null, actualFrozenForecastConditionalBound: null };
  const fail = reason => ({ ...base, reasons: [reason] });
  if (!protocol || protocol.version !== VERSION || !validScope(protocol.scope)
    || protocol.weightNormalization !== 'NORMALIZE_DECLARED_WEIGHTS'
    || protocol.selectionPolicy !== 'DECLARED_WITHOUT_OUTCOMES'
    || protocol.dependencyPolicy !== 'DECLARED_BLOCKS_NOT_AUTOMATICALLY_VERIFIED'
    || !finite(protocol.alpha) || protocol.alpha <= 0 || protocol.alpha >= 1
    || !validDescriptor(protocol.featureDescriptor)) return fail('INVALID_PROTOCOL_OR_DESCRIPTOR');
  const registered = instant(protocol.registeredAt), from = instant(protocol.calibrationFrom), before = instant(protocol.calibrationBefore);
  const trained = instant(protocol.modelTrainedThrough), cutoff = instant(target?.analysisCutoff), captured = instant(target?.predictionCapturedAt), kickoff = instant(target?.kickoff);
  if (![registered, from, before, trained, cutoff, captured, kickoff, now].every(Number.isFinite)
    || !(trained < registered && registered <= from && from < before && before <= cutoff && cutoff <= captured && captured < kickoff && captured <= now))
    return fail('PROTOCOL_TARGET_TIME_ORDER_INVALID');
  const descriptorHash = conditionalReturnResearchHash(protocol.featureDescriptor);
  if (!matches(target, protocol.scope) || !new RegExp(`^soccer:${target.league}:\\d{1,16}$`).test(target.gameId)
    || !text(target.quoteIdentity) || !validFeatures(target, protocol.featureDescriptor, descriptorHash) || !validHashList(target.sourceHashes))
    return fail('TARGET_SCOPE_OR_FEATURES_INVALID');
  const targetForecast = forecastFor(target, true);
  if (!targetForecast)
    return fail('TARGET_POINT_FORECAST_OR_FULL_SUPPORT_UNAVAILABLE');
  if (!Array.isArray(observations)) return fail('OBSERVATIONS_MUST_BE_ARRAY');
  if (!observations.length) return { ...base, status: 'NO_OBSERVATIONS', reasons: ['NO_INDEPENDENT_SOURCE_OBSERVATIONS'] };
  const unique = new Map(), ids = new Map(), gameBlocks = new Map(); let duplicates = 0;
  for (const row of observations) {
    if (!matches(row, protocol.scope) || !new RegExp(`^soccer:${target.league}:\\d{1,16}$`).test(row?.gameId)
      || row.gameId === target.gameId || !text(row.observationId) || !sha(row.economicPriceHash)
      || !text(row.blockId) || !finite(row.weight) || row.weight < 0 || !validHashList(row.sourceHashes)
      || !validFeatures(row, protocol.featureDescriptor, descriptorHash)) return fail('OBSERVATION_SCOPE_IDENTITY_FEATURES_OR_WEIGHT_INVALID');
    const analysis = instant(row.analysisCutoff), prediction = instant(row.predictionCapturedAt), start = instant(row.kickoff);
    const available = instant(row.resultAvailableAt), checked = instant(row.checkedAt), declared = instant(row.weightDeclaredAt);
    const firstKnown = instant(row.outcomeFirstSourceFetchedAt ?? row.resultAvailableAt);
    if (![analysis, prediction, start, available, checked, declared, firstKnown].every(Number.isFinite)
      || !(from <= analysis && analysis <= prediction && prediction < start && from <= start && start < before
        && start < firstKnown && firstKnown <= available && available <= checked && checked < before
        && registered <= declared && declared < firstKnown)) return fail('OBSERVATION_OR_WEIGHT_TIME_ORDER_INVALID');
    if (!finite(row.realizedNetReturn)
      || !finite(row.payoffSupport?.lower) || !finite(row.payoffSupport?.upper) || row.payoffSupport.lower > row.payoffSupport.upper
      || row.realizedNetReturn < row.payoffSupport.lower || row.realizedNetReturn > row.payoffSupport.upper
      || row.forecast == null && !finite(row.predictedNetReturn))
      return fail('EXACT_RETURN_OR_PAYOFF_SUPPORT_INVALID');
    if (row.forecast == null && (row.status === 'OBSERVED_BOUNDED' || row.predictedReturnBounds != null || row.unresolvedTailMass > 0))
      return fail('INTERVAL_FORECAST_CANNOT_BECOME_POINT_RESIDUAL');
    if (!forecastFor(row)) return fail('FORECAST_INTERVAL_OR_POINT_OUTSIDE_SUPPORT_OR_MODEL_SCOPE');
    const economicKey = `${row.gameId}:${row.economicPriceHash}`, signature = conditionalReturnResearchHash(row);
    if (ids.has(row.observationId) && ids.get(row.observationId) !== economicKey) return fail('OBSERVATION_ID_CONFLICT');
    ids.set(row.observationId, economicKey);
    if (unique.has(economicKey)) {
      const old = unique.get(economicKey);
      const withoutId = value => { const { observationId: ignored, ...body } = value; return conditionalReturnResearchHash(body); };
      if (old.signature !== signature && withoutId(old.row) !== withoutId(row)) return fail('CONFLICTING_DUPLICATE_ECONOMIC_PRICE');
      duplicates++; continue;
    }
    if (gameBlocks.has(row.gameId) && gameBlocks.get(row.gameId) !== row.blockId) return fail('REAL_GAME_SPLIT_BETWEEN_BLOCKS');
    gameBlocks.set(row.gameId, row.blockId); unique.set(economicKey, { row, signature });
  }
  const rows = [...unique.values()].map(value => value.row)
    .sort((left, right) => left.gameId.localeCompare(right.gameId) || left.economicPriceHash.localeCompare(right.economicPriceHash));
  const earliestKnown = Math.min(...rows.map(row => instant(row.outcomeFirstSourceFetchedAt ?? row.resultAvailableAt)));
  if (rows.some(row => instant(row.weightDeclaredAt) >= earliestKnown)) return fail('WEIGHTS_NOT_DECLARED_BEFORE_ALL_INCLUDED_OUTCOMES');
  try {
    const totalWeight = sum(rows.map(row => input(row.weight)));
    if (totalWeight.lo.lte(0)) return fail('POSITIVE_TOTAL_WEIGHT_REQUIRED');
    const weighted = rows.map(row => ({ row, weight: divPositive(input(row.weight), totalWeight) }));
    const bias = sum(weighted.map(({ row, weight }) => {
      const forecast = forecastFor(row), enclosure = { lo: input(forecast.lower).lo, hi: input(forecast.upper).hi };
      return mul(weight, sub(input(row.realizedNetReturn), enclosure));
    }));
    const blocks = new Map(); let weightedDistance = new Up(0);
    for (const { row, weight } of weighted) {
      const width = sub(input(row.payoffSupport.upper), input(row.payoffSupport.lower));
      const contribution = mul(weight, width).hi;
      blocks.set(row.blockId, new Up(blocks.get(row.blockId) ?? 0).plus(contribution));
      weightedDistance = weightedDistance.plus(new Up(weight.hi).times(distanceUpper(row.features, target.features, protocol.featureDescriptor)));
    }
    const rangeSquares = [...blocks.values()].reduce((value, width) => value.plus(new Up(width).times(width)), new Up(0));
    const logFactor = new Up(2).div(input(protocol.alpha).lo).ln().div(2);
    const sampling = new Up(rangeSquares).times(logFactor).sqrt();
    const need = [], nonnegative = (key, reason) => {
      if (!finite(assumptions[key]) || assumptions[key] < 0) { need.push(reason); return null; }
      return input(assumptions[key]).hi;
    };
    const lipschitz = nonnegative('transferLipschitzBound', 'TRANSFER_BOUND_UNKNOWN');
    const drift = nonnegative('timeShiftBound', 'TIME_SHIFT_BOUND_UNKNOWN');
    const omitted = nonnegative('contextOmissionBound', 'OMITTED_CONTEXT_BOUND_UNKNOWN');
    const numerical = nonnegative('numericalTailBound', 'NUMERICAL_OR_TAIL_BOUND_UNKNOWN');
    for (const [key, reason] of [['commonDesignFixedBeforeOutcomes', 'COMMON_FIXED_DESIGN_NOT_ESTABLISHED'],
      ['conditionalBlockIndependence', 'CONDITIONAL_BLOCK_INDEPENDENCE_NOT_ESTABLISHED'],
      ['outcomeIndependentInclusion', 'OUTCOME_INDEPENDENT_INCLUSION_NOT_ESTABLISHED'],
      ['requestedScopeComplete', 'REQUESTED_SCOPE_NOT_COMPLETE'], ['singlePrespecifiedTarget', 'MULTIPLE_OR_POSTHOC_TARGETS_NOT_COVERED']])
      if (assumptions[key] !== true) need.push(reason);
    const transfer = lipschitz === null ? null : new Up(lipschitz).times(weightedDistance);
    const magnitude = absUpper(bias);
    const targetWidth = targetForecast.upper === targetForecast.lower ? new Up(0)
      : sub(input(targetForecast.upper), input(targetForecast.lower)).hi;
    const components = { weightedSignedResidual: publicInterval(bias), absoluteResidualUpper: upperNumber(magnitude),
      blockSamplingUpper: upperNumber(sampling), weightedDistanceUpper: upperNumber(weightedDistance),
      targetForecastIntervalWidthUpper: upperNumber(targetWidth),
      transferUpper: transfer === null ? null : upperNumber(transfer), timeShiftUpper: drift === null ? null : upperNumber(drift),
      contextOmissionUpper: omitted === null ? null : upperNumber(omitted), numericalTailUpper: numerical === null ? null : upperNumber(numerical) };
    const actualBound = need.length ? null : [magnitude, sampling, transfer, drift, omitted, numerical].reduce((value, term) => value.plus(term), new Up(0));
    // The transport assumption applies to the SAME actual frozen P function,
    // which is enclosed by each interval. Adding target width additionally
    // covers every alternative point in its interval, without choosing one.
    const uniformBound = actualBound === null ? null : new Up(actualBound).plus(targetWidth);
    return { ...base, status: need.length ? 'COMPONENTS_ONLY_MISSING_ASSUMPTIONS' : 'ASSUMPTION_CONDITIONAL_RESEARCH',
      reasons: need, components, conditionalTotalBound: uniformBound === null ? null : upperNumber(uniformBound),
      actualFrozenForecastConditionalBound: actualBound === null ? null : upperNumber(actualBound),
      targetForecast, arithmeticRevision: 'INTERVAL_NATIVE_ORIGINAL_MODEL_EXPECTATION_v2',
      intervalForecastObservations: rows.filter(row => forecastFor(row).type === 'INTERVAL').length,
      observations: rows.length, duplicateEconomicPricesIgnored: duplicates, realGames: gameBlocks.size,
      positiveWeightGames: new Set(rows.filter(row => row.weight > 0).map(row => row.gameId)).size,
      positiveWeightDependencyBlocks: new Set(rows.filter(row => row.weight > 0).map(row => row.blockId)).size,
      declaredDependencyBlocks: blocks.size, effectiveIndependentBlocksVerified: null,
      weightNormalization: protocol.weightNormalization,
      rawWeightTotal: { lowerDecimal: totalWeight.lo.toString(), upperDecimal: totalWeight.hi.toString() },
      normalizedWeights: weighted.map(({ row, weight }) => ({ observationId: row.observationId, weight: publicInterval(weight) })),
      featureDescriptorHash: descriptorHash, inputHash: conditionalReturnResearchHash({ protocol, target, observations, assumptions }),
      numericalMethod: '80_DIGIT_DIRECTED_INTERVALS_OVER_EXACT_BINARY64_INPUTS_OUTWARD_BINARY64_PROJECTION',
      limitations: ['Declared blocks do not prove conditional independence across teams, time or leagues.',
        'Each match frozen before kickoff does not establish one common design sigma-field independent of all included outcomes.',
        'contextOmissionBound is a total allowance covering target and weighted-neighbor conditioning gaps, not only the target gap.',
        'numericalTailBound is a total allowance covering target and weighted-neighbor source arithmetic/forecast tails, not only calculator rounding.',
        'Forecast intervals must enclose the SAME identified original frozen model expectation, not an unspecified set of models.',
        'transferLipschitzBound applies to the true residual bias of that original expectation, not to a selected interval endpoint or midpoint.',
        'An observed outcome is not the true conditional expected return; ordinary OOS outcome coverage cannot verify this estimand.',
        'Provided declarations and content hashes create no source, preregistration, OOS or acceptance authority.'] };
  } catch {
    return fail('NUMERICAL_RESULT_NOT_FINITE_OR_NOT_ENCLOSABLE');
  }
}
