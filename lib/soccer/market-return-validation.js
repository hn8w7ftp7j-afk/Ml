import { soccerForwardHash, validateSoccerForwardCapture, evaluateSoccerForwardCapture } from './forward-validation.js';
import { adaptSoccerReaderQuote, scoreSoccerQuote } from './soccer-scoring.js';
import { soccerVerifiedSettlementContract, soccerSettlementContractComplete, soccerSettlementContractBound } from './settlement-contract.js';
import { settleSoccerManualRecord } from './manual-settlement.js';

export const SOCCER_MARKET_RETURN_VERSION = 'SOCCER-SAVED-QUOTE-RETURN-OBSERVATION-v1';
export const SOCCER_MARKET_RETURN_SELECTION = 'FIRST_VALID_DATABASE_PREDICTION_PER_ECONOMIC_PRICE_MODEL_PERIOD_VARIANT';
const slots = { HANDICAP_HOME: ['HANDICAP', 'home'], HANDICAP_AWAY: ['HANDICAP', 'away'], TOTAL_OVER: ['TOTAL', 'over'], TOTAL_UNDER: ['TOTAL', 'under'] };
const detached = value => JSON.parse(JSON.stringify(value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validBounds = value => finite(value?.lower) && finite(value?.upper) && value.lower <= value.upper;
const observedStatus = status => ['OBSERVED', 'OBSERVED_BOUNDED'].includes(status);
const observationPriority = status => status === 'OBSERVED' ? 2 : status === 'OBSERVED_BOUNDED' ? 1 : 0;
// Expand the subtraction by one binary64 step so rounding cannot narrow the
// supplied payoff interval. This only propagates that existing interval.
function outward(value, upper) {
  if (!finite(value)) return value;
  if (value === 0) return upper ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + ((value > 0) === upper ? 1n : -1n));
  return view.getFloat64(0);
}
const restrictions = { formalEligible: false, calibrationEligible: false, promotionEligible: false, executable: false };
const seal = value => {
  const { checkedAt, ...body } = value;
  return { ...value, evidenceHash: soccerForwardHash({ ...body,
    observations: value.observations.map(({ checkedAt, ...row }) => row) }) };
};
export function soccerMarketEconomicPriceIdentity(capture, quote) {
  const proof = quote?.provenance, resolution = proof?.periodResolution;
  const observation = capture.snapshot?.inputVersions?.readerSourceObservations?.find(row => row.observationId === proof?.readerObservationId && row.revision === proof?.readerRevision);
  let sourceScope = null;
  try { const url = new URL(proof.sourceUrl); sourceScope = `${url.origin}${url.pathname}`; } catch {}
  return { league: capture.league, gameId: capture.gameId, period: quote?.period, kind: quote?.kind, side: quote?.side,
    line: quote?.line, lineSide: quote?.lineSide ?? null, water: quote?.water, unit: quote?.unit,
    sourceHost: proof?.sourceHost ?? null, sourceScope,
    // A device/config scope is retained when the saved server receipt supplies
    // it. Missing account identity remains unknown, never an approval claim.
    accountDeviceHash: resolution?.observation?.deviceHash ?? observation?.deviceHash ?? null,
    periodBindingConfigHash: resolution?.configHash ?? null };
}
const observationKey = (capture, quote) => soccerForwardHash([SOCCER_MARKET_RETURN_VERSION,
  capture.variant, capture.modelHash, soccerMarketEconomicPriceIdentity(capture, quote)]);
const originalRows = capture => (Array.isArray(capture.snapshot?.directions) ? capture.snapshot.directions : []).filter(direction => direction?.period === (capture.period === 'REGULATION_FT' ? 'FT' : 'HT'))
  .flatMap(direction => Array.isArray(direction.quotes) ? direction.quotes.map(quote => ({ direction, quote })) : []);

// The first scoreline forecast is often saved before any Reader price arrives.
// Keep that existing goal-validation policy intact. Return observations instead
// select the first valid saved prediction for each economic price/model pair.
// Receipt times/revisions change on unchanged Reader heartbeats; these are not
// independent return samples. Preserve the selected original receipt verbatim.
export function canonicalSoccerMarketReturnCaptures(captures, protocol, now = Date.now()) {
  const first = new Map(), selected = new Map(), excluded = [], unpriced = [], valid = [];
  let duplicateQuoteObservations = 0, invalidQuoteObservations = 0;
  const sequence = capture => /^[1-9]\d*$/.test(String(capture.captureSequence || '')) ? BigInt(capture.captureSequence) : 0n;
  for (const capture of [...captures].sort((a, b) => sequence(a) < sequence(b) ? -1 : sequence(a) > sequence(b) ? 1 : String(a.revision).localeCompare(String(b.revision)))) {
    const checked = validateSoccerForwardCapture(capture, protocol, now);
    if (!checked.ok) { excluded.push({ capture, reason: checked.reason }); continue; }
    valid.push(capture);
    const rows = originalRows(capture);
    if (!rows.length) { unpriced.push(capture); continue; }
    for (const { direction, quote } of rows) {
      const slot = slots[direction.direction], period = capture.period === 'REGULATION_FT' ? 'FT' : 'HT';
      if (!slot || quote?.period !== period || quote.kind !== slot[0] || quote.side !== slot[1]
        || !adaptSoccerReaderQuote({ quote, game: capture.snapshot.evidence.game, now: Date.parse(capture.snapshot.analysisCutoff) }).ok) {
        invalidQuoteObservations++; continue;
      }
      const observationId = observationKey(capture, quote);
      if (first.has(observationId)) { duplicateQuoteObservations++; continue; }
      first.set(observationId, { observationId, captureId: capture.captureId, quoteKey: quote.key });
      selected.set(capture.captureId, capture);
    }
  }
  return { chosen: [...selected.values()], observations: [...first.values()], excluded, unpriced, valid,
    duplicateQuoteObservations, invalidQuoteObservations, selection: SOCCER_MARKET_RETURN_SELECTION };
}

/**
 * Join the original DB-saved prediction and original Reader price to a real
 * result. This collects observations, not a fitted error margin, W/R/S, or an
 * approval. A newly confirmed contract must independently bind the old quote.
 * resolveContract is a trusted-server dependency, never an HTTP body field.
 */
export function evaluateSoccerMarketReturnCapture({ capture, protocol, result, now = Date.now(), resolveContract = soccerVerifiedSettlementContract } = {}) {
  const base = { version: SOCCER_MARKET_RETURN_VERSION, captureId: capture?.captureId || null,
    revision: capture?.revision || null, modelHash: capture?.modelHash || null, league: capture?.league || null,
    gameId: capture?.gameId || null, period: capture?.period || null, variant: capture?.variant || null,
    captureSequence: String(capture?.captureSequence || ''), checkedAt: Number.isFinite(now) ? new Date(now).toISOString() : null,
    unit: 'NET_PROFIT_PER_1_STAKE', ...restrictions };
  const checked = validateSoccerForwardCapture(capture, protocol, now);
  if (!checked.ok) return seal({ ...base, status: 'BLOCKED', reason: checked.reason, observations: [] });
  const snapshot = capture.snapshot, game = snapshot.evidence.game, period = capture.period === 'REGULATION_FT' ? 'FT' : 'HT';
  base.unassignedGameQuoteCount = Array.isArray(snapshot.unassignedQuotes) ? snapshot.unassignedQuotes.length : 0;
  const originalAt = Date.parse(snapshot.analysisCutoff), directions = snapshot.directions;
  if (!Array.isArray(directions) || directions.some(direction => !direction || !Array.isArray(direction.quotes)))
    return seal({ ...base, status: 'BLOCKED', reason: 'MARKET_RETURN_ORIGINAL_QUOTES_UNAVAILABLE', observations: [] });
  const scoped = directions.filter(direction => direction.period === period).flatMap(direction => direction.quotes.map(quote => ({ direction, quote })));
  if (scoped.length > 1000) return seal({ ...base, status: 'BLOCKED', reason: 'MARKET_RETURN_QUOTE_BUDGET_EXCEEDED', observations: [] });
  // Reuse the original period/result/source admission. Source-document refresh
  // does not become a different prediction or a fresh Reader observation.
  const final = evaluateSoccerForwardCapture(capture, protocol, result, now), seen = new Set();
  const observations = scoped.map(({ direction, quote }, index) => {
    const observationId = quote?.key ? observationKey(capture, quote) : soccerForwardHash([SOCCER_MARKET_RETURN_VERSION, capture.captureId, index]);
    const common = { observationId, captureId: capture.captureId, captureSequence: String(capture.captureSequence),
      analysisRevision: capture.revision, league: capture.league, gameId: capture.gameId, date: capture.date,
      period, variant: capture.variant, modelHash: capture.modelHash, distributionHash: soccerForwardHash(checked.distribution),
      economicPriceIdentity: soccerMarketEconomicPriceIdentity(capture, quote),
      predictionCapturedAt: capture.capturedAt, analysisCutoff: snapshot.analysisCutoff,
      quoteKey: quote?.key || null, originalQuote: quote ? detached(Object.fromEntries(['key', 'marketKey', 'period', 'kind', 'side', 'line', 'lineSide', 'water', 'rawRows', 'provenance'].map(key => [key, quote[key] ?? null]))) : null,
      resultHash: final.status === 'EVALUATED' ? final.resultHash : null,
      actualScore: final.status === 'EVALUATED' ? final.actualScore : null,
      checkedAt: new Date(now).toISOString(), ...restrictions };
    const pending = (reason, extra = {}) => ({ ...common, status: 'PENDING', reason,
      predictedNetReturn: null, realizedNetReturn: null, predictionError: null, ...extra });
    const slot = slots[direction.direction];
    if (!slot || quote?.period !== period || quote.kind !== slot[0] || quote.side !== slot[1])
      return pending('MARKET_RETURN_DIRECTION_MISMATCH');
    if (seen.has(quote.key)) return pending('MARKET_RETURN_DUPLICATE_ORIGINAL_QUOTE');
    seen.add(quote.key);
    // Evaluate freshness at the original analysis, never at result-check time.
    const adapted = adaptSoccerReaderQuote({ quote, game, now: originalAt });
    if (!adapted.ok) return pending(adapted.code);
    if (final.status !== 'EVALUATED') return pending(final.reason || 'MARKET_RETURN_RESULT_UNVERIFIED');
    const record = { league: capture.league, gameId: capture.gameId, date: capture.date, startTime: game.startTime,
      teamIds: { home: game.home.id, away: game.away.id }, status: 'OPEN', stake: 1,
      period, kind: quote.kind, side: quote.side, line: quote.line, lineSide: quote.lineSide, water: quote.water,
      analysisRevision: capture.revision, quoteKey: quote.key, sourceQuote: quote };
    let contract;
    try { contract = resolveContract(record); } catch { return pending('MARKET_RETURN_CONTRACT_LOOKUP_FAILED'); }
    if (!soccerSettlementContractComplete(contract, record) || !soccerSettlementContractBound(contract, record)
      || !(Date.parse(contract.verifiedAt) <= now)) return pending('SOCCER_SOURCE_CONTRACT_UNVERIFIED');
    const contractHash = soccerForwardHash(contract);
    const payoff = scoreSoccerQuote({ quote, game, distribution: checked.distribution, contract, evidence: snapshot.evidence, now: originalAt }).conditionalPayoff;
    const terms = { contractHash, contractVersion: contract.version, contractEvidenceRef: contract.evidenceRef,
      contractVerifiedAt: contract.verifiedAt, contractVerifiedAfterPrediction: Date.parse(contract.verifiedAt) > originalAt };
    if (payoff?.ok && soccerForwardHash(payoff.contract) !== contractHash) return pending('MARKET_RETURN_CONTRACT_CALCULATION_MISMATCH', terms);
    const exact = payoff?.ok === true && finite(payoff.netEV);
    const bounded = payoff?.ok === true && !exact && validBounds(payoff.evBounds?.net)
      && finite(payoff.unresolvedTailMass) && payoff.unresolvedTailMass > 0;
    if (!exact && !bounded) return pending('MARKET_RETURN_PREDICTED_PAYOFF_UNRESOLVED', {
      ...terms, predictedReturnBounds: payoff?.evBounds?.net || null });
    const settled = settleSoccerManualRecord(record, result, contract, now);
    if (settled.status !== 'SETTLED' || !Number.isFinite(settled.profit)) return pending(settled.reason || 'MARKET_RETURN_SETTLEMENT_PENDING', terms);
    // A valid result and bound source contract can be observed even when the
    // finite forecast rectangle leaves unresolved tail mass. Preserve an error
    // interval separately; no midpoint, zero-tail assumption or exact R sample.
    const predictionError = exact ? settled.profit - payoff.netEV : null;
    return { ...common, ...terms, status: exact ? 'OBSERVED' : 'OBSERVED_BOUNDED', reason: null,
      predictedNetReturn: exact ? payoff.netEV : null, realizedNetReturn: settled.profit, predictionError,
      absoluteError: exact ? Math.abs(predictionError) : null, squaredError: exact ? predictionError ** 2 : null,
      ...(!exact ? { predictedReturnBounds: { ...payoff.evBounds.net },
        predictionErrorBounds: { lower: outward(settled.profit - payoff.evBounds.net.upper, false), upper: outward(settled.profit - payoff.evBounds.net.lower, true) },
        tailMass: payoff.tailMass, resolvedTailMass: payoff.resolvedTailMass, unresolvedTailMass: payoff.unresolvedTailMass,
        boundInterpretation: 'UNRESOLVED_SCORE_TAIL_INTERVAL_NOT_POINT_RETURN_OR_EMPIRICAL_R' } : {}),
      outcome: settled.outcome, winFraction: settled.winFraction, lossFraction: settled.lossFraction, pushFraction: settled.pushFraction,
      rebate: settled.rebate, rebateBasis: settled.rebateBasis,
      interpretation: 'SAVED_SCORE_FORECAST_AT_ORIGINAL_PRICE_WITH_BOUND_TERMS_NOT_FORMAL_W_OR_R',
      resultEvidenceScope: result.evidenceScope, rawSourceHashRecomputed: false, strictHistoricalPit: false };
  });
  const observed = observations.filter(row => row.status === 'OBSERVED').length;
  const bounded = observations.filter(row => row.status === 'OBSERVED_BOUNDED').length;
  return seal({ ...base, status: !observations.length ? 'NO_ORIGINAL_QUOTES' : observed === observations.length ? 'OBSERVED'
    : bounded === observations.length ? 'OBSERVED_BOUNDED' : observed + bounded === observations.length ? 'OBSERVED_MIXED'
      : observed + bounded ? 'PARTIAL' : 'PENDING',
    reason: !observations.length ? base.unassignedGameQuoteCount ? 'MARKET_RETURN_PERIOD_UNVERIFIED' : 'MARKET_RETURN_SCOPED_ORIGINAL_QUOTES_MISSING' : null,
    quoteObservations: observations.length, observedQuoteReturns: observed, boundedQuoteReturns: bounded,
    pendingQuoteReturns: observations.length - observed - bounded, observations });
}

/** Deduplicate repeated checks and quarantine changed outcomes/terms, without
 * inventing an R estimate or treating correlated directions as independent. */
export function summarizeSoccerMarketReturnObservations(checks = [], { quarantinedCaptureIds = [], incompleteCaptureIds = [] } = {}) {
  const byId = new Map(), conflicts = new Set();
  const quarantined = new Set(quarantinedCaptureIds), incomplete = new Set(incompleteCaptureIds);
  for (const check of checks) {
    if (check?.version !== SOCCER_MARKET_RETURN_VERSION) continue;
    for (const row of check.observations || []) {
      if (!row?.observationId || row.formalEligible !== false || row.calibrationEligible !== false) continue;
      const previous = byId.get(row.observationId);
      if (previous?.actualScore && row.actualScore && soccerForwardHash(previous.actualScore) !== soccerForwardHash(row.actualScore)) conflicts.add(row.observationId);
      if (observedStatus(previous?.status) && observedStatus(row.status)) {
        if (previous.contractHash !== row.contractHash || previous.realizedNetReturn !== row.realizedNetReturn) conflicts.add(row.observationId);
        if (previous.status === row.status) {
          const fields = row.status === 'OBSERVED' ? ['predictedNetReturn', 'predictionError']
            : ['predictedReturnBounds', 'predictionErrorBounds', 'tailMass', 'resolvedTailMass', 'unresolvedTailMass'];
          if (fields.some(key => soccerForwardHash(previous[key] ?? null) !== soccerForwardHash(row[key] ?? null))) conflicts.add(row.observationId);
        } else {
          const point = previous.status === 'OBSERVED' ? previous : row, interval = previous.status === 'OBSERVED_BOUNDED' ? previous : row;
          if (!validBounds(interval.predictedReturnBounds) || !finite(point.predictedNetReturn)
            || point.predictedNetReturn < interval.predictedReturnBounds.lower || point.predictedNetReturn > interval.predictedReturnBounds.upper)
            conflicts.add(row.observationId);
        }
      }
      if (!previous || observationPriority(row.status) >= observationPriority(previous.status)) byId.set(row.observationId, row);
    }
  }
  for (const row of byId.values()) if (quarantined.has(row.captureId)) conflicts.add(row.observationId);
  const observed = [...byId.values()].filter(row => row.status === 'OBSERVED' && !conflicts.has(row.observationId) && !incomplete.has(row.captureId));
  const bounded = [...byId.values()].filter(row => row.status === 'OBSERVED_BOUNDED' && !conflicts.has(row.observationId) && !incomplete.has(row.captureId));
  const reasons = {};
  for (const row of byId.values()) {
    if (conflicts.has(row.observationId)) continue;
    const reason = incomplete.has(row.captureId) ? 'MARKET_RETURN_RESULT_HISTORY_INCOMPLETE' : !observedStatus(row.status) ? row.reason : null;
    if (reason) reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return { version: SOCCER_MARKET_RETURN_VERSION, quoteObservations: byId.size, observedQuoteReturns: observed.length, boundedQuoteReturns: bounded.length,
    pendingQuoteReturns: [...byId.values()].filter(row => (!observedStatus(row.status) || incomplete.has(row.captureId)) && !conflicts.has(row.observationId)).length,
    conflictingQuoteReturns: conflicts.size, uniqueObservedGames: new Set(observed.map(row => row.gameId)).size,
    uniqueBoundedGames: new Set(bounded.map(row => row.gameId)).size,
    pendingReasons: reasons, empiricalErrorMargin: null, W: null, R: null, S: null,
    interpretation: 'RETURN_OBSERVATIONS_ONLY_NO_FITTED_ERROR_OR_MODEL_PROMOTION', ...restrictions };
}

export function buildSoccerMarketReturnReport(evidence, now = Date.now()) {
  const selection = canonicalSoccerMarketReturnCaptures(evidence.captures, evidence.protocol, now), selected = selection.chosen;
  const selectedRows = new Set(selection.observations.map(row => `${row.captureId}:${row.observationId}`));
  const captures = new Map(selection.valid.map(capture => [capture.captureId, capture]));
  const allEvaluations = (evidence.evaluations || []).filter(row => {
    const scoped = row.status === 'EVALUATED' ? row : row.marketReturnValidation;
    const capture = captures.get(scoped?.captureId);
    return capture && ['revision', 'modelHash', 'period', 'variant', 'league', 'gameId'].every(key => scoped[key] === capture[key])
      && scoped.captureSequence === String(capture.captureSequence);
  });
  const selectedIds = new Set(selected.map(capture => capture.captureId));
  const evaluations = allEvaluations.filter(row => selectedIds.has(row.captureId || row.marketReturnValidation?.captureId));
  const results = new Map(), conflicts = new Set();
  const resultConflicts = new Set(), resultScope = row => `${row.league}:${row.gameId}:${row.period}`;
  const incompleteScopes = new Set((evidence.incompleteResultCaptureIds || []).map(id => captures.get(id)).filter(Boolean).map(resultScope));
  const incompleteSelected = selected.filter(capture => incompleteScopes.has(resultScope(capture))).map(capture => capture.captureId);
  // A correction discovered in the earliest unpriced goal forecast must also
  // quarantine later priced observations for the same real game/period.
  for (const row of allEvaluations.filter(row => row.status === 'EVALUATED')) {
    const key = resultScope(row), signature = soccerForwardHash([row.actualScore, row.actualOutcome]);
    if (results.has(key) && results.get(key) !== signature) resultConflicts.add(key);
    results.set(key, signature);
  }
  for (const capture of selected) if (resultConflicts.has(resultScope(capture))) conflicts.add(capture.captureId);
  const checks = evaluations.map(row => row.marketReturnValidation).filter(row => row?.version === SOCCER_MARKET_RETURN_VERSION)
    .map(check => ({ ...check, observations: (check.observations || []).filter(row => selectedRows.has(`${row.captureId}:${row.observationId}`)) }));
  const withEvidence = new Set(checks.map(row => row.captureId)), periodReasons = {};
  for (const capture of selected) {
    const latest = checks.filter(row => row.captureId === capture.captureId).sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
    const reason = latest ? ['BLOCKED', 'NO_ORIGINAL_QUOTES'].includes(latest.status) ? latest.reason || latest.status : null : 'MARKET_RETURN_NOT_CHECKED';
    if (reason) periodReasons[reason] = (periodReasons[reason] || 0) + 1;
  }
  const summary = summarizeSoccerMarketReturnObservations(checks, {
    quarantinedCaptureIds: [...conflicts], incompleteCaptureIds: incompleteSelected,
  });
  const uncheckedQuoteReturns = selection.observations.length - summary.quoteObservations;
  const pendingReasons = { ...summary.pendingReasons };
  if (uncheckedQuoteReturns > 0) pendingReasons.MARKET_RETURN_NOT_CHECKED = (pendingReasons.MARKET_RETURN_NOT_CHECKED || 0) + uncheckedQuoteReturns;
  return { ...summary, checkedQuoteObservations: summary.quoteObservations,
    quoteObservations: selection.observations.length, uncheckedQuoteReturns,
    pendingQuoteReturns: summary.pendingQuoteReturns + uncheckedQuoteReturns, pendingReasons,
    selection: selection.selection, savedPredictionPeriods: selection.valid.length, pricedPredictionPeriods: selected.length,
    unpricedPredictionPeriods: selection.unpriced.length, selectedOriginalQuoteObservations: selection.observations.length,
    laterDuplicateQuoteObservationsNotSelected: selection.duplicateQuoteObservations, invalidOriginalQuoteObservations: selection.invalidQuoteObservations,
    periodsWithReturnEvidence: withEvidence.size,
    periodsWithoutReturnEvidence: selected.length - withEvidence.size,
    quarantinedPredictionPeriods: conflicts.size, predictionPeriodReasons: periodReasons,
    predictionPeriodsWithIncompleteGameResultHistory: incompleteSelected.length,
    evidenceTruncated: evidence.truncated === true, incompleteResultHistories: evidence.incompleteResultCaptureIds?.length || 0,
    readCoverage: evidence.readCoverage || null };
}
