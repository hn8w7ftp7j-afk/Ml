import { VERSION, FEATURE_VERSION, conditionalReturnResearchHash as hash } from './estimator.mjs';

/** Deterministic invented numbers for calculator verification only. These
 * observations are not provider results, account returns, OOS or registration. */
export function conditionalReturnSyntheticFixture() {
  const iso = day => `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
  const scope = { league: 'epl', period: 'FT', variant: 'synthetic-baseline', modelHash: 'a'.repeat(64),
    settlementRuleFamilyHash: 'b'.repeat(64), kind: 'TOTAL', side: 'over', lineSide: null };
  const featureDescriptor = { version: FEATURE_VERSION, metric: 'WEIGHTED_L1',
    dimensions: [{ name: 'rate', scale: 1, weight: 1 }] };
  const features = { rate: 2 }, featureDescriptorHash = hash(featureDescriptor);
  const protocol = { version: VERSION, scope, registeredAt: iso(1), modelTrainedThrough: '2025-12-31T00:00:00Z',
    calibrationFrom: iso(2), calibrationBefore: iso(10), alpha: 0.1, featureDescriptor,
    selectionPolicy: 'DECLARED_WITHOUT_OUTCOMES', weightNormalization: 'NORMALIZE_DECLARED_WEIGHTS',
    dependencyPolicy: 'DECLARED_BLOCKS_NOT_AUTOMATICALLY_VERIFIED' };
  const target = { ...scope, gameId: 'soccer:epl:999', quoteIdentity: 'invented-target', features, featureDescriptorHash,
    analysisCutoff: iso(10), predictionCapturedAt: iso(10), kickoff: iso(11), sourceHashes: ['c'.repeat(64)],
    predictedNetReturn: 0, payoffSupport: { lower: -1, upper: 1 }, tailError: 0 };
  const observations = [1, 2].map(index => ({ ...scope, gameId: `soccer:epl:${100 + index}`,
    observationId: `invented-${index}`, economicPriceHash: hash(`invented-price-${index}`), blockId: `invented-block-${index}`,
    weight: 1, weightDeclaredAt: iso(2), features, featureDescriptorHash, sourceHashes: ['d'.repeat(64)],
    analysisCutoff: iso(2), predictionCapturedAt: iso(2), kickoff: iso(3),
    outcomeFirstSourceFetchedAt: iso(4), resultAvailableAt: iso(4), checkedAt: iso(5),
    predictedNetReturn: 0, realizedNetReturn: 0.2, payoffSupport: { lower: -1, upper: 1 } }));
  const assumptions = { commonDesignFixedBeforeOutcomes: true, conditionalBlockIndependence: true,
    outcomeIndependentInclusion: true, requestedScopeComplete: true, singlePrespecifiedTarget: true,
    transferLipschitzBound: 0, timeShiftBound: 0, contextOmissionBound: 0, numericalTailBound: 0 };
  return { syntheticOnly: true, protocol, target, observations, assumptions, now: Date.parse(iso(10)) };
}
