import { buildSoccerReturnErrorDataset, soccerReturnErrorSettlementRuleFamilyHash } from '../../../lib/soccer/return-error-model.js';
import { canonicalSoccerMarketReturnCaptures } from '../../../lib/soccer/market-return-validation.js';
import { soccerForwardHash, validateSoccerForwardCapture } from '../../../lib/soccer/forward-validation.js';
import { scoreSoccerQuote } from '../../../lib/soccer/soccer-scoring.js';
import { soccerVerifiedSettlementContract, soccerSettlementContractComplete, soccerSettlementContractBound } from '../../../lib/soccer/settlement-contract.js';

// A research adapter over the existing original-capture/result replay. This is
// deliberately not a runtime authority, HTTP endpoint, frozen-model receipt or
// raw-source-document verifier. A hash identifies content; it does not approve it.
export const CONDITIONAL_RETURN_BRIDGE_VERSION = 'CONDITIONAL-RETURN-ORIGINAL-EVIDENCE-BRIDGE-v1';
export const CONDITIONAL_RETURN_FEATURE_DESCRIPTOR = Object.freeze({
  version: 'CONDITIONAL_RETURN_FEATURES-v1', metric: 'WEIGHTED_L1',
  dimensions: Object.freeze(['homeRate', 'awayRate', 'rho', 'lineMagnitude', 'lineBoundary', 'water']
    .map(name => Object.freeze({ name, scale: 1, weight: 1 }))),
});
const restrictions = Object.freeze({ accepted: false, formalEligible: false, executable: false,
  formalMargin: null, empiricalErrorMargin: null, W: null, R: null, S: null });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const epoch = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const recordFor = (capture, quote) => {
  const game = capture.snapshot.evidence.game;
  return { league: capture.league, gameId: capture.gameId, date: capture.date, startTime: game.startTime,
    teamIds: { home: game.home.id, away: game.away.id }, status: 'OPEN', stake: 1,
    period: quote.period, kind: quote.kind, side: quote.side, line: quote.line, lineSide: quote.lineSide,
    water: quote.water, analysisRevision: capture.revision, quoteKey: quote.key, sourceQuote: quote };
};
const quoteFor = (capture, key) => (capture.snapshot?.directions || [])
  .filter(direction => direction.period === (capture.period === 'REGULATION_FT' ? 'FT' : 'HT'))
  .flatMap(direction => direction.quotes || []).filter(quote => quote.key === key);
function featuresFor(distribution, quote, contract) {
  let lineMagnitude, lineBoundary = 0;
  if (contract.type === 'CREDIT_BOUNDARY') {
    const match = /^(\d+(?:\.\d+)?)(平|[+-]\d{1,3})?$/.exec(quote.line);
    if (!match) return null;
    lineMagnitude = Number(match[1]);
    if (match[2] && match[2] !== '平') lineBoundary = Number(match[2]) / 100;
  } else if (contract.type === 'ASIAN_SPLIT') {
    if (!/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(quote.line)) return null;
    const legs = quote.line.split('/').map(Number);
    lineMagnitude = legs.reduce((sum, value) => sum + value, 0) / legs.length;
  } else return null;
  const features = { homeRate: distribution.homeRate, awayRate: distribution.awayRate,
    rho: distribution.rho, lineMagnitude, lineBoundary, water: quote.water };
  return Object.values(features).every(finite) ? features : null;
}
function replayOriginal(capture, quoteKey, protocol, now, resolveContract) {
  const checked = validateSoccerForwardCapture(capture, protocol, now);
  if (!checked.ok) return { error: checked.reason };
  const quotes = quoteFor(capture, quoteKey);
  if (quotes.length !== 1) return { error: 'BRIDGE_ORIGINAL_QUOTE_NOT_UNIQUE' };
  const quote = quotes[0], record = recordFor(capture, quote), cutoff = epoch(capture.snapshot.analysisCutoff);
  let contract;
  try { contract = resolveContract(record); } catch { return { error: 'BRIDGE_CONTRACT_LOOKUP_FAILED' }; }
  if (!soccerSettlementContractComplete(contract, record) || !soccerSettlementContractBound(contract, record)
    || !(epoch(contract.verifiedAt) <= cutoff)) return { error: 'BRIDGE_TERMS_NOT_BOUND_AT_CUTOFF' };
  const payoff = scoreSoccerQuote({ quote, game: capture.snapshot.evidence.game, distribution: checked.distribution,
    contract, now: cutoff }).conditionalPayoff;
  if (payoff?.ok !== true || soccerForwardHash(payoff.contract) !== soccerForwardHash(contract))
    return { error: 'BRIDGE_ORIGINAL_PAYOFF_RECOMPUTE_FAILED' };
  // The shipped payoff engine's corner support covers the entire nonnegative
  // score space. It is NOT the minimum/maximum of the truncated score grid.
  // Credit fractions and outcome-specific rebate terms are recomputed there.
  const range = payoff.tailUncertainty?.payoffRanges?.net;
  if (!finite(range?.min) || !finite(range?.max) || range.min > range.max)
    return { error: 'BRIDGE_FULL_PAYOFF_SUPPORT_UNAVAILABLE' };
  const features = featuresFor(checked.distribution, quote, contract);
  if (!features) return { error: 'BRIDGE_PREMATCH_FEATURES_UNAVAILABLE' };
  const certificate = payoff.certifiedDifferencePayoff, enclosure = certificate?.evBounds?.net;
  const certified = quote.kind === 'HANDICAP' && certificate?.status === 'CERTIFIED_NUMERICAL_MODEL_LAW_INTERVAL'
    && certificate.sourceVerification === 'RECOMPUTED_GENERATOR_PMF_AND_COMPLETE_RECTANGLE'
    && certificate.infiniteSeriesRemainderIncluded === true && certificate.arithmeticRoundingIncluded === true
    && finite(enclosure?.lower) && finite(enclosure?.upper) && enclosure.lower <= enclosure.upper;
  const forecast = certified ? { type: 'INTERVAL', lower: enclosure.lower, upper: enclosure.upper, point: null, modelHash: capture.modelHash,
    method: 'RECOMPUTED_OUTWARD_BINARY64_INFINITE_DIFFERENCE_PAYOFF_INTERVAL', certificateHash: soccerForwardHash(certificate) }
    : finite(payoff.netEV) && payoff.unresolvedTailMass === 0 ? {
      type: 'POINT', lower: payoff.netEV, upper: payoff.netEV, point: payoff.netEV, modelHash: capture.modelHash,
      method: 'ORIGINAL_RECOMPUTED_BINARY64_CONDITIONAL_RETURN',
      certificateHash: soccerForwardHash({ quoteKey, distributionHash: soccerForwardHash(checked.distribution),
        contractHash: soccerForwardHash(contract), netEV: payoff.netEV, unresolvedTailMass: payoff.unresolvedTailMass }),
    } : null;
  return { quote, contract, payoff, features,
    featureDescriptorHash: soccerForwardHash(CONDITIONAL_RETURN_FEATURE_DESCRIPTOR),
    payoffSupport: { lower: range.min, upper: range.max },
    // Resolved probability tail does not certify binary64 integration error.
    // No precision/error bound is inferred from a small residual or tolerance.
    tailError: payoff.unresolvedTailMass === 0 && finite(payoff.netEV) ? 0 : null,
    numericalTailError: null,
    // A certified interval remains the published research representation even
    // when the older finite-grid accumulator happens to report a scalar (for
    // example when a tiny omitted mass rounds to zero). Preserve that legacy
    // calculation only as original-source evidence, never a second point DTO.
    predictedNetReturn: forecast?.type === 'POINT' ? forecast.point : null,
    legacyOriginalPredictedNetReturn: finite(payoff.netEV) ? payoff.netEV : null,
    predictionBounds: payoff.evBounds?.net || null,
    forecast, forecastCertificate: certified ? {
      version: certificate.version, method: certificate.method,
      sourceVerification: certificate.sourceVerification, generator: certificate.generator,
      infiniteSeriesRemainderIncluded: true, arithmeticRoundingIncluded: true,
      interpretation: certificate.interpretation,
    } : null,
    settlementRuleFamilyHash: soccerReturnErrorSettlementRuleFamilyHash(contract),
    sourceHashes: [capture.revision, soccerForwardHash(checked.distribution), soccerForwardHash(contract),
      capture.snapshot.evidence.source.contentHash, capture.snapshot.evidence.scheduleSource.contentHash],
    featureSource: { captureId: capture.captureId, analysisRevision: capture.revision, quoteKey,
      distributionHash: soccerForwardHash(checked.distribution), contractHash: soccerForwardHash(contract),
      sourceFetchedAt: capture.snapshot.evidence.source.fetchedAt, scheduleFetchedAt: capture.snapshot.evidence.scheduleSource.fetchedAt },
  };
}
const scopeFor = (capture, replay) => ({ league: capture.league,
  period: capture.period === 'REGULATION_FT' ? 'FT' : 'HT', variant: capture.variant,
  modelHash: capture.modelHash, settlementRuleFamilyHash: replay.settlementRuleFamilyHash,
  kind: replay.quote.kind, side: replay.quote.side, lineSide: replay.quote.lineSide ?? null });
const sameScope = (left, right) => Object.keys(left).every(key => left[key] === right[key]);
function firstOutcomeFetch(row, evidence) {
  const stamps = (evidence.checks || []).filter(check => check.captureId === row.captureId
    && check.resultEvidence?.resultHash && row.sourceHashes.includes(check.resultEvidence.resultHash)
    && Number.isFinite(epoch(check.checkedAt)) && epoch(check.checkedAt) <= epoch(row.checkedAt))
    .flatMap(check => check.resultEvidence.sources || []).map(source => epoch(source.fetchedAt)).filter(Number.isFinite);
  return stamps.length ? new Date(Math.min(...stamps)).toISOString() : null;
}

/** Call with original server-owned evidence and a trusted contract dependency.
 * No externally supplied derived dataset, OBSERVED flag, feature vector, net
 * return, payoff support, provenance boolean, weight or block assignment is read.
 * Default admission remains the existing Production identity/contract policy.
 */
export function buildConditionalReturnResearchBridge({ evidence = {}, target, now = Date.now() } = {},
  { resolveContract = soccerVerifiedSettlementContract } = {}) {
  const excluded = {}, count = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
  const base = { version: CONDITIONAL_RETURN_BRIDGE_VERSION, ...restrictions,
    interpretation: 'RESEARCH_REPLAY_NOT_RAW_SOURCE_VERIFICATION_OR_FROZEN_PROSPECTIVE_AUTHORITY',
    rawSourceHashRecomputed: false, strictHistoricalPit: false,
    featureDescriptor: CONDITIONAL_RETURN_FEATURE_DESCRIPTOR,
    featureScope: 'SAVED_GOAL_MODEL_AND_ORIGINAL_PRICE_ONLY_NOT_COMPLETE_PREMATCH_COVARIATES',
    transferSmoothnessVerified: false, temporalShiftVerified: false, dependencyIndependenceVerified: false };
  if (!finite(now) || typeof resolveContract !== 'function') throw Error('BRIDGE_DEPENDENCY_INVALID');
  const capture = target?.capture, quoteKey = target?.quoteKey;
  const selected = canonicalSoccerMarketReturnCaptures(capture ? [capture] : [], evidence.protocol, now,
    { preferKnownContract: true, resolveContract });
  const targetObservation = selected.observations.find(value => value.captureId === capture?.captureId && value.quoteKey === quoteKey);
  if (!targetObservation) return { ...base, status: 'NOT_COMPUTABLE', target: null, rows: [],
    excludedReasons: { BRIDGE_TARGET_ORIGINAL_CAPTURE_OR_IDENTITY_UNAVAILABLE: 1 } };
  const targetReplay = replayOriginal(capture, quoteKey, evidence.protocol, now, resolveContract);
  if (targetReplay.error) return { ...base, status: 'NOT_COMPUTABLE', target: null, rows: [], excludedReasons: { [targetReplay.error]: 1 } };
  const scope = scopeFor(capture, targetReplay), targetValue = { ...scope,
    gameId: capture.gameId, quoteIdentity: targetObservation.observationId,
    predictionCapturedAt: capture.capturedAt, analysisCutoff: capture.snapshot.analysisCutoff,
    kickoff: capture.snapshot.evidence.game.startTime, features: targetReplay.features,
    featureDescriptorHash: targetReplay.featureDescriptorHash, featureSource: targetReplay.featureSource,
    payoffSupport: targetReplay.payoffSupport, tailError: targetReplay.tailError,
    numericalTailError: targetReplay.numericalTailError,
    predictedNetReturn: targetReplay.predictedNetReturn, predictionBounds: targetReplay.predictionBounds,
    legacyOriginalPredictedNetReturn: targetReplay.legacyOriginalPredictedNetReturn,
    forecast: targetReplay.forecast, forecastCertificate: targetReplay.forecastCertificate,
    sourceHashes: targetReplay.sourceHashes };
  const dataset = buildSoccerReturnErrorDataset(evidence, { now, resolveContract }), originals = new Map();
  for (const value of evidence.captures || []) {
    if (originals.has(value.captureId) && soccerForwardHash(originals.get(value.captureId)) !== soccerForwardHash(value))
      originals.set(value.captureId, null);
    else if (!originals.has(value.captureId)) originals.set(value.captureId, value);
  }
  const rows = [];
  for (const row of [...dataset.observations, ...dataset.boundedObservations]) {
    if (row.gameId === capture.gameId && row.league === capture.league) { count('BRIDGE_TARGET_GAME_EXCLUDED'); continue; }
    if (!(epoch(row.checkedAt) < epoch(capture.snapshot.analysisCutoff))) { count('BRIDGE_RESULT_NOT_KNOWN_BEFORE_TARGET'); continue; }
    const original = originals.get(row.captureId);
    if (!original) { count('BRIDGE_ORIGINAL_CAPTURE_NOT_UNIQUE'); continue; }
    const replay = replayOriginal(original, row.quoteKey, evidence.protocol, now, resolveContract);
    if (replay.error) { count(replay.error); continue; }
    if (!sameScope(scope, scopeFor(original, replay))) { count('BRIDGE_SCOPE_MISMATCH'); continue; }
    if (!replay.forecast) { count('BRIDGE_CERTIFIED_FORECAST_INTERVAL_OR_POINT_UNAVAILABLE'); continue; }
    const originalPredictionMatches = row.status === 'OBSERVED_BOUNDED'
      ? replay.legacyOriginalPredictedNetReturn === null
        && soccerForwardHash(replay.predictionBounds) === soccerForwardHash(row.predictedReturnBounds)
      : finite(replay.legacyOriginalPredictedNetReturn) && replay.legacyOriginalPredictedNetReturn === row.predictedNetReturn && replay.tailError === 0;
    if (!originalPredictionMatches) { count('BRIDGE_ORIGINAL_FORECAST_RECOMPUTE_MISMATCH'); continue; }
    if (!(row.realizedNetReturn >= replay.payoffSupport.lower && row.realizedNetReturn <= replay.payoffSupport.upper)) {
      count('BRIDGE_REALIZED_RETURN_OUTSIDE_FULL_SUPPORT'); continue;
    }
    const outcomeFirstSourceFetchedAt = firstOutcomeFetch(row, evidence);
    if (!outcomeFirstSourceFetchedAt) { count('BRIDGE_FIRST_RESULT_SOURCE_TIME_UNAVAILABLE'); continue; }
    rows.push({ ...row, ...scope, analysisRevision: original.revision,
      predictedNetReturn: replay.predictedNetReturn, legacyOriginalPredictedNetReturn: replay.legacyOriginalPredictedNetReturn,
      predictionError: replay.forecast.type === 'POINT' ? row.predictionError : null,
      legacyOriginalPredictionError: row.predictionError,
      features: replay.features, featureDescriptorHash: replay.featureDescriptorHash,
      featureSource: replay.featureSource, payoffSupport: replay.payoffSupport, tailError: replay.tailError,
      numericalTailError: replay.numericalTailError,
      forecast: replay.forecast, forecastCertificate: replay.forecastCertificate,
      outcomeFirstSourceFetchedAt, weight: null, weightDeclaredAt: null, blockId: null,
      weightsAndDependencies: 'REQUIRE_SEPARATE_OUTCOME_BLIND_RESEARCH_PROTOCOL_NOT_INFERRED_FROM_SOURCES',
      ...restrictions });
  }
  return { ...base, status: rows.length ? 'REPLAYED_RESEARCH_ROWS' : 'NO_SUPPORTED_RESEARCH_ROWS',
    target: targetValue, rows, distinctGames: new Set(rows.map(row => `${row.league}:${row.gameId}`)).size,
    requestedScopeComplete: dataset.coverage.completeWithinRequestedScope,
    excludedReasons: excluded, originalDatasetDiagnostics: { observedGames: dataset.observedGames,
      observedQuoteReturns: dataset.observedQuoteReturns, boundedQuoteReturns: dataset.boundedQuoteReturns,
      quarantinedGames: dataset.quarantinedGames, excludedReasons: dataset.excludedReasons },
    noAutomaticWeightsOrBlocks: true };
}
