import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { VERSION, FEATURE_VERSION, conditionalReturnResearchHash as hash, estimateConditionalReturnError as estimate } from './estimator.mjs';

const sha = character => character.repeat(64), iso = day => `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
const scope = { league: 'epl', period: 'FT', variant: 'baseline', modelHash: sha('a'),
  settlementRuleFamilyHash: sha('b'), kind: 'TOTAL', side: 'over', lineSide: null };
const descriptor = { version: FEATURE_VERSION, metric: 'WEIGHTED_L1', dimensions: [{ name: 'rate', scale: 1, weight: 1 }] };
const features = { rate: 2 }, featureDescriptorHash = hash(descriptor);
const protocol = { version: VERSION, scope, registeredAt: iso(1), modelTrainedThrough: '2025-12-31T00:00:00Z',
  calibrationFrom: iso(2), calibrationBefore: iso(10), alpha: 0.1, featureDescriptor: descriptor,
  selectionPolicy: 'DECLARED_WITHOUT_OUTCOMES', weightNormalization: 'NORMALIZE_DECLARED_WEIGHTS',
  dependencyPolicy: 'DECLARED_BLOCKS_NOT_AUTOMATICALLY_VERIFIED' };
const target = { ...scope, gameId: 'soccer:epl:999', quoteIdentity: 'synthetic-target', features, featureDescriptorHash,
  analysisCutoff: iso(10), predictionCapturedAt: iso(10), kickoff: iso(11), sourceHashes: [sha('c')],
  predictedNetReturn: 0, payoffSupport: { lower: -1, upper: 1 }, tailError: 0 };
const assumptions = { commonDesignFixedBeforeOutcomes: true, conditionalBlockIndependence: true,
  outcomeIndependentInclusion: true, requestedScopeComplete: true, singlePrespecifiedTarget: true,
  transferLipschitzBound: 0, timeShiftBound: 0, contextOmissionBound: 0, numericalTailBound: 0 };
const row = (index, extra = {}) => ({ ...scope, gameId: `soccer:epl:${100 + index}`, observationId: `synthetic-${index}`,
  economicPriceHash: hash(`price-${index}`), blockId: `synthetic-block-${index}`, weight: 1,
  weightDeclaredAt: iso(2), features, featureDescriptorHash, sourceHashes: [sha('d')],
  analysisCutoff: iso(2), predictionCapturedAt: iso(2), kickoff: iso(3),
  outcomeFirstSourceFetchedAt: iso(4), resultAvailableAt: iso(4), checkedAt: iso(5),
  predictedNetReturn: 0, realizedNetReturn: 0.2, payoffSupport: { lower: -1, upper: 1 }, ...extra });
const run = (observations, extra = {}) => estimate({ protocol, target, observations, assumptions, now: Date.parse(iso(10)), ...extra });
const restrictions = value => {
  for (const key of ['accepted', 'formalEligible', 'executable', 'sourceAuthorityVerified', 'durableFreezeVerified',
    'assumptionsVerified', 'individualGameApplicabilityVerified', 'simultaneousTargetsCovered']) assert.equal(value[key], false, key);
  for (const key of ['formalMargin', 'modelError', 'W', 'R', 'S']) assert.equal(value[key], null, key);
};
const reason = (result, expected) => { restrictions(result); assert.ok(result.reasons.includes(expected), JSON.stringify(result)); assert.equal(result.conditionalTotalBound, null); };

const one = run([row(1)]); restrictions(one);
assert.equal(one.status, 'ASSUMPTION_CONDITIONAL_RESEARCH');
assert.ok(one.components.weightedSignedResidual.lower <= 0.2 && one.components.weightedSignedResidual.upper >= 0.2);
assert.ok(one.components.blockSamplingUpper >= Math.sqrt(2 * Math.log(20)));
assert.ok(one.conditionalTotalBound >= 0.2 + Math.sqrt(2 * Math.log(20)));
assert.ok(one.conditionalTotalBound - (0.2 + Math.sqrt(2 * Math.log(20))) < 1e-12);

// Repeated prices/IDs cannot create independent draws or silently double weight.
const duplicate = run([row(1), row(1), row(1, { observationId: 'same-economic-price-another-id' })]);
assert.equal(duplicate.duplicateEconomicPricesIgnored, 2); assert.equal(duplicate.realGames, 1);
assert.deepEqual(duplicate.components, one.components);
assert.equal(duplicate.conditionalTotalBound, one.conditionalTotalBound);
reason(run([row(1), row(1, { realizedNetReturn: -0.2 })]), 'CONFLICTING_DUPLICATE_ECONOMIC_PRICE');
reason(run([row(1), row(2, { observationId: 'synthetic-1' })]), 'OBSERVATION_ID_CONFLICT');

// Any number of prices in one perfectly dependent game keeps one full-width block.
const twoQuotes = run([row(1), row(2, { gameId: 'soccer:epl:101', blockId: 'synthetic-block-1' })]);
assert.equal(twoQuotes.realGames, 1); assert.equal(twoQuotes.declaredDependencyBlocks, 1);
assert.equal(twoQuotes.components.blockSamplingUpper, one.components.blockSamplingUpper);
reason(run([row(1), row(2, { gameId: 'soccer:epl:101' })]), 'REAL_GAME_SPLIT_BETWEEN_BLOCKS');
const independent = run([row(1), row(2)]), dependent = run([row(1), row(2, { blockId: 'synthetic-block-1' })]);
assert.equal(independent.realGames, 2); assert.equal(independent.effectiveIndependentBlocksVerified, null);
assert.ok(independent.components.blockSamplingUpper < dependent.components.blockSamplingUpper);
assert.equal(dependent.components.blockSamplingUpper, one.components.blockSamplingUpper);
const unequal = run([row(1, { weight: 1 }), row(2, { weight: 3 })]);
assert.ok(unequal.components.blockSamplingUpper >= Math.sqrt(Math.log(20) / 2 * (0.5 ** 2 + 1.5 ** 2)));

// Opposite conditional biases cancel globally, leaving the target unsupported.
const cancellation = run([row(1, { realizedNetReturn: 0.8, features: { rate: 1 } }),
  row(2, { realizedNetReturn: -0.8, features: { rate: 3 } })],
{ assumptions: { ...assumptions, transferLipschitzBound: null, contextOmissionBound: null } });
assert.ok(cancellation.components.absoluteResidualUpper < 1e-70);
reason(cancellation, 'TRANSFER_BOUND_UNKNOWN'); reason(cancellation, 'OMITTED_CONTEXT_BOUND_UNKNOWN');
assert.ok(cancellation.components.weightedDistanceUpper >= 1);
for (const [key, expected] of [['transferLipschitzBound', 'TRANSFER_BOUND_UNKNOWN'], ['timeShiftBound', 'TIME_SHIFT_BOUND_UNKNOWN'],
  ['contextOmissionBound', 'OMITTED_CONTEXT_BOUND_UNKNOWN'], ['numericalTailBound', 'NUMERICAL_OR_TAIL_BOUND_UNKNOWN']])
  reason(run([row(1)], { assumptions: { ...assumptions, [key]: null } }), expected);
for (const [key, expected] of [['commonDesignFixedBeforeOutcomes', 'COMMON_FIXED_DESIGN_NOT_ESTABLISHED'],
  ['conditionalBlockIndependence', 'CONDITIONAL_BLOCK_INDEPENDENCE_NOT_ESTABLISHED'],
  ['outcomeIndependentInclusion', 'OUTCOME_INDEPENDENT_INCLUSION_NOT_ESTABLISHED'],
  ['requestedScopeComplete', 'REQUESTED_SCOPE_NOT_COMPLETE'], ['singlePrespecifiedTarget', 'MULTIPLE_OR_POSTHOC_TARGETS_NOT_COVERED']])
  reason(run([row(1)], { assumptions: { ...assumptions, [key]: false } }), expected);

// Full finite support remains intact; an observed return cannot redefine it.
reason(run([row(1, { realizedNetReturn: 2 })]), 'EXACT_RETURN_OR_PAYOFF_SUPPORT_INVALID');
reason(run([row(1, { predictedNetReturn: 2 })]), 'EXACT_RETURN_OR_PAYOFF_SUPPORT_INVALID');
reason(run([row(1, { predictedNetReturn: null })]), 'EXACT_RETURN_OR_PAYOFF_SUPPORT_INVALID');
reason(run([row(1, { status: 'OBSERVED_BOUNDED', predictedReturnBounds: { lower: 0.1, upper: 0.3 } })]), 'INTERVAL_FORECAST_CANNOT_BECOME_POINT_RESIDUAL');
reason(run([row(1, { unresolvedTailMass: 0.01 })]), 'INTERVAL_FORECAST_CANNOT_BECOME_POINT_RESIDUAL');
for (const change of [{ predictedNetReturn: null }, { predictedNetReturn: 2 }, { tailError: null },
  { payoffSupport: null }, { unresolvedTailMass: 0.01 }])
  reason(run([row(1)], { target: { ...target, ...change } }), 'TARGET_POINT_FORECAST_OR_FULL_SUPPORT_UNAVAILABLE');
reason(run([row(1, { weight: -1 })]), 'OBSERVATION_SCOPE_IDENTITY_FEATURES_OR_WEIGHT_INVALID');
reason(run([row(1, { weight: 0 })]), 'POSITIVE_TOTAL_WEIGHT_REQUIRED');
const zeroWeight = run([row(1), row(2, { weight: 0 })]);
assert.equal(zeroWeight.positiveWeightGames, 1); assert.equal(zeroWeight.positiveWeightDependencyBlocks, 1);
assert.equal(zeroWeight.components.blockSamplingUpper, one.components.blockSamplingUpper);
assert.deepEqual(run([row(2), row(1)]).components, independent.components);
reason(run([row(1, { weight: NaN })]), 'OBSERVATION_SCOPE_IDENTITY_FEATURES_OR_WEIGHT_INVALID');
const hugeWeights = run([row(1, { weight: 1e308 }), row(2, { weight: 1e308 })]);
assert.equal(hugeWeights.status, 'ASSUMPTION_CONDITIONAL_RESEARCH');
assert.equal(hugeWeights.components.blockSamplingUpper, independent.components.blockSamplingUpper);
const tinyAlpha = run([row(1)], { protocol: { ...protocol, alpha: Number.MIN_VALUE } });
assert.equal(tinyAlpha.status, 'ASSUMPTION_CONDITIONAL_RESEARCH'); assert.ok(Number.isFinite(tinyAlpha.conditionalTotalBound));

// League, period, model, rule mechanism, orientation and feature versions isolate.
for (const change of [{ league: 'ucl', gameId: 'soccer:ucl:101' }, { period: 'HT' }, { modelHash: sha('e') },
  { settlementRuleFamilyHash: sha('e') }, { side: 'under' }, { lineSide: 'home' }, { kind: 'HANDICAP' },
  { featureDescriptorHash: sha('e') }, { features: { rate: 2, unknown: 1 } }, { sourceHashes: [] }])
  reason(run([row(1, change)]), 'OBSERVATION_SCOPE_IDENTITY_FEATURES_OR_WEIGHT_INVALID');
reason(run([row(1, { gameId: target.gameId })]), 'OBSERVATION_SCOPE_IDENTITY_FEATURES_OR_WEIGHT_INVALID');
reason(run([row(1)], { protocol: { ...protocol, featureDescriptor: { ...descriptor, dimensions: [{ name: 'rate', scale: 0, weight: 1 }] } } }), 'INVALID_PROTOCOL_OR_DESCRIPTOR');
reason(run([row(1)], { protocol: { ...protocol, weightNormalization: undefined } }), 'INVALID_PROTOCOL_OR_DESCRIPTOR');
reason(run([row(1, { weightDeclaredAt: iso(4) })]), 'OBSERVATION_OR_WEIGHT_TIME_ORDER_INVALID');
reason(run([row(1), row(2, { weightDeclaredAt: '2026-01-04T12:00:00Z', kickoff: iso(5), outcomeFirstSourceFetchedAt: iso(6), resultAvailableAt: iso(6), checkedAt: iso(7) })]), 'WEIGHTS_NOT_DECLARED_BEFORE_ALL_INCLUDED_OUTCOMES');
reason(run([row(1, { checkedAt: iso(10) })]), 'OBSERVATION_OR_WEIGHT_TIME_ORDER_INVALID');
reason(run([row(1)], { target: { ...target, analysisCutoff: iso(9) } }), 'PROTOCOL_TARGET_TIME_ORDER_INVALID');
reason(run([row(1)], { protocol: { ...protocol, registeredAt: iso(3) } }), 'PROTOCOL_TARGET_TIME_ORDER_INVALID');
reason(run([row(1)], { protocol: { ...protocol, modelTrainedThrough: iso(2) } }), 'PROTOCOL_TARGET_TIME_ORDER_INVALID');

const declaredAuthority = run([row(1, { accepted: true, formalEligible: true })],
  { assumptions: { ...assumptions, sourceAuthorityVerified: true, assumptionsVerified: true, accepted: true } });
restrictions(declaredAuthority); assert.equal(declaredAuthority.status, 'ASSUMPTION_CONDITIONAL_RESEARCH');
const empty = run([]); restrictions(empty); assert.equal(empty.status, 'NO_OBSERVATIONS');
const template = JSON.parse(await fs.readFile(new URL('./protocol.json', import.meta.url), 'utf8'));
reason(run([row(1)], { protocol: template }), 'INVALID_PROTOCOL_OR_DESCRIPTOR');
assert.equal(hash({ b: [1, 2], a: { y: 3, x: 4 } }), hash({ a: { x: 4, y: 3 }, b: [1, 2] }));
console.log(JSON.stringify({ ok: true, suite: VERSION, syntheticOnly: true, formalEligible: false,
  checked: ['block concentration', 'no quote pseudo-replication', 'dependent-game counterexample', 'conditional cancellation',
    'context omission', 'unknown components remain null', 'time/weight leakage', 'scope isolation', 'outward numeric bounds', 'authority never promoted'] }));
