import { soccerForwardHash, validateSoccerForwardCapture, evaluateSoccerForwardCapture } from './forward-validation.js';
import { canonicalSoccerMarketReturnCaptures } from './market-return-validation.js';
import { adaptSoccerReaderQuote } from './soccer-scoring.js';
import { evaluateSoccerQuote } from './market-payoff.js';
import { soccerProviderPolicy } from './provider-policy.js';
import { soccerCreditRuleConfirmation } from './credit-rule-confirmation.js';

export const SOCCER_RETROSPECTIVE_PAYOFF_VERSION = 'SOCCER-RETROSPECTIVE-CONFIRMED-RULE-PAYOFF-v1';
const restrictions = { accountSettlementVerified: false, historicalContractVerified: false, verifiedAtOriginalCutoff: false,
  formalEligible: false, calibrationEligible: false, promotionEligible: false, executable: false,
  empiricalErrorMargin: null, W: null, R: null, S: null };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const epoch = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const gameKey = value => `${value.league}:${value.gameId}`;
const resultKey = value => `${gameKey(value)}:${value.period}`;
const count = (reasons, code, n = 1) => { reasons[code] = (reasons[code] || 0) + n; };
const interval = value => finite(value?.lower) && finite(value?.upper) && value.lower <= value.upper;
function outward(value, upper) {
  if (!finite(value)) return value;
  if (value === 0) return upper ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + ((value > 0) === upper ? 1n : -1n));
  return view.getFloat64(0);
}
const addBounds = (a, b) => ({ lower: outward(a.lower + b.lower, false), upper: outward(a.upper + b.upper, true) });
// Recompute the payoff sum with outward rounding at every product/addition.
// The preserved omitted-score tail stays an interval; no midpoint or rescaling.
function payoffBounds(payoff) {
  if (!payoff?.ok || !Array.isArray(payoff.rows)) return null;
  let bounds = { lower: 0, upper: 0 };
  const add = (probability, net) => {
    if (!finite(probability) || probability < 0 || !finite(net)) return false;
    if (probability === 0) return true;
    const product = probability * net;
    bounds = addBounds(bounds, { lower: outward(product, false), upper: outward(product, true) }); return true;
  };
  for (const row of payoff.rows) if (!add(row.probability, row.netPerUnit)) return null;
  if (payoff.tailSettlement && !add(payoff.tailSettlement.probability, payoff.tailSettlement.netPerUnit)) return null;
  const mass = payoff.unresolvedTailMass, range = payoff.tailUncertainty?.payoffRanges?.net;
  if (!finite(mass) || mass < 0 || mass > 1 || !finite(range?.min) || !finite(range?.max) || range.min > range.max) return null;
  if (mass > 0) bounds = addBounds(bounds, { lower: outward(mass * range.min, false), upper: outward(mass * range.max, true) });
  return interval(bounds) ? bounds : null;
}

function ruleAt(now) {
  const policy = soccerProviderPolicy({ asOf: now }), credit = soccerCreditRuleConfirmation(now);
  const known = policy.rebateRate === .01 && policy.rebateBasis === 'SETTLED_PRINCIPAL'
    && policy.rebateApplicabilityStatus === 'USER_CONFIRMED' && credit.status === 'USER_CONFIRMED';
  const specification = { mechanic: 'CREDIT_BOUNDARY', rebateRate: .01, rebateBasis: 'SETTLED_PRINCIPAL',
    rebateApplicability: 'WIN_AND_LOSS_FRACTIONS_EXCLUDING_PUSH', policyVersion: policy.version,
    creditRuleVersion: credit.version, rebateConfirmedAt: policy.settlementConfirmation.confirmedAt,
    creditConfirmedAt: credit.confirmedAt, periodScope: 'NORMAL_REGULATION_HT_FT_WITHOUT_EXTRA_TIME_RESEARCH_ASSUMPTION' };
  return { known, application: { ...specification, appliedAt: finite(now) && Math.abs(now) <= 8.64e15 ? new Date(now).toISOString() : null,
    confirmedAt: [specification.rebateConfirmedAt, credit.confirmedAt].sort().at(-1), ruleHash: soccerForwardHash(specification), ...restrictions } };
}
function scopedEvaluation(row, capture) {
  return row?.status === 'EVALUATED' && ['revision', 'modelHash', 'period', 'variant', 'league', 'gameId'].every(key => row[key] === capture[key])
    && String(row.captureSequence) === String(capture.captureSequence)
    && ['home', 'away'].every(side => Number.isSafeInteger(row.actualScore?.[side]) && row.actualScore[side] >= 0);
}

/** Retrospective research arithmetic over actual immutable predictions/prices.
 * The current confirmed rule is applied NOW. Neither its account applicability
 * nor its availability at the old prediction cutoff is asserted. No registry,
 * legacy formal dataset, fitted error, current score or wager is produced. */
function* pipeline(evidence = {}, { now = Date.now() } = {}) {
  const reasons = {}, rule = ruleAt(now), groups = new Map(), playedGames = new Set(), quarantined = new Set(), resultScores = new Map();
  const selection = canonicalSoccerMarketReturnCaptures(evidence.captures || [], evidence.protocol, now);
  const valid = new Map(selection.valid.map(capture => [capture.captureId, capture])), usableResults = new Map(), checkReasons = new Map();
  for (const row of selection.excluded) count(reasons, row.reason);
  const conflict = (capture, score) => {
    const key = resultKey(capture), hash = soccerForwardHash({ home: score.home, away: score.away });
    if (resultScores.has(key) && resultScores.get(key) !== hash) quarantined.add(gameKey(capture));
    resultScores.set(key, hash);
  };
  // Read all valid captures' histories, including unpriced first forecasts and
  // later duplicate-price heartbeats. A correction anywhere quarantines the game.
  for (const row of evidence.evaluations || []) {
    const capture = valid.get(row?.captureId);
    if (capture && scopedEvaluation(row, capture)) conflict(capture, row.actualScore);
  }
  for (const check of evidence.checks || []) {
    const capture = valid.get(check?.captureId), checkedAt = epoch(check?.checkedAt);
    if (!capture || !finite(checkedAt) || checkedAt > now) continue;
    const result = check.resultEvidence;
    const sourceTimes = [result?.observedAt, ...(Array.isArray(result?.sources) ? result.sources.map(source => source?.fetchedAt) : [])].map(epoch);
    if (result && (sourceTimes.length !== 3 || sourceTimes.some(time => !finite(time) || time > checkedAt))) {
      checkReasons.set(capture.captureId, 'RETROSPECTIVE_RESULT_RECEIPT_TIME_INVALID'); continue;
    }
    // Compact proof was created by the scanner at its current cutoff, not the
    // older result receipt. Verify that receipt's availability separately above.
    const evaluated = evaluateSoccerForwardCapture(capture, evidence.protocol, result, now);
    if (evaluated.status !== 'EVALUATED') { checkReasons.set(capture.captureId, evaluated.reason || 'RETROSPECTIVE_RESULT_UNVERIFIED'); continue; }
    conflict(capture, evaluated.actualScore);
    const old = usableResults.get(resultKey(capture));
    if (!old || checkedAt < old.checkedAt) usableResults.set(resultKey(capture), { result, checkedAt, score: evaluated.actualScore });
  }
  const incomplete = new Set((evidence.incompleteResultCaptureIds || []).filter(id => valid.has(id)));
  const incompleteGames = new Set([...incomplete].map(id => gameKey(valid.get(id))));
  for (const key of incompleteGames) quarantined.add(key);
  let replayed = 0, exact = 0, bounded = 0, pending = 0, quarantinedQuotes = 0;
  const selectedByCapture = new Map();
  for (const observation of selection.observations) {
    if (!selectedByCapture.has(observation.captureId)) selectedByCapture.set(observation.captureId, []);
    selectedByCapture.get(observation.captureId).push(observation);
  }
  for (const [id, observations] of selectedByCapture) {
    const compact = valid.get(id), key = gameKey(compact), result = usableResults.get(resultKey(compact));
    if (quarantined.has(key)) {
      quarantinedQuotes += observations.length; count(reasons, incompleteGames.has(key)
        ? 'RETROSPECTIVE_RESULT_HISTORY_INCOMPLETE' : 'RETROSPECTIVE_CONFLICTING_RESULT_EVIDENCE', observations.length); continue;
    }
    if (!rule.known) { pending += observations.length; count(reasons, 'RETROSPECTIVE_CONFIRMED_RULE_UNAVAILABLE_AT_APPLICATION', observations.length); continue; }
    if (!result) { pending += observations.length; count(reasons, checkReasons.get(id) || 'RETROSPECTIVE_ORIGINAL_RESULT_EVIDENCE_MISSING', observations.length); continue; }
    const original = yield id;
    const same = original && ['captureId', 'captureSequence', 'league', 'gameId', 'date', 'period', 'variant', 'modelHash', 'revision', 'capturedAt']
      .every(field => String(original[field]) === String(compact[field]));
    const verified = same && validateSoccerForwardCapture(original, evidence.protocol, now);
    if (!verified?.ok) { pending += observations.length; count(reasons, 'RETROSPECTIVE_ORIGINAL_CAPTURE_UNAVAILABLE', observations.length); continue; }
    const final = evaluateSoccerForwardCapture(original, evidence.protocol, result.result, result.checkedAt);
    if (final.status !== 'EVALUATED' || soccerForwardHash(final.actualScore) !== soccerForwardHash(result.score)) {
      pending += observations.length; count(reasons, 'RETROSPECTIVE_RESULT_RECOMPUTE_FAILED', observations.length); continue;
    }
    const snapshot = original.snapshot, game = snapshot.evidence.game, period = original.period === 'REGULATION_FT' ? 'FT' : 'HT';
    const quotes = new Map((snapshot.directions || []).filter(direction => direction.period === period)
      .flatMap(direction => direction.quotes || []).map(quote => [quote.key, quote]));
    for (const observation of observations) {
      const quote = quotes.get(observation.quoteKey), adapted = adaptSoccerReaderQuote({ quote, game, now: Date.parse(snapshot.analysisCutoff) });
      if (!adapted.ok) { pending++; count(reasons, adapted.code); continue; }
      const contract = { type: 'CREDIT_BOUNDARY', period, labelMapping: { home: game.home.id, away: game.away.id },
        rebate: { rate: .01, basis: 'SETTLED_PRINCIPAL' }, provenance: { status: 'ASSUMPTION', note: 'Current confirmed arithmetic applied retrospectively; account contract and historical applicability are unverified.' } };
      const forecast = evaluateSoccerQuote({ quote: adapted.quote, distribution: verified.distribution, contract });
      const realized = evaluateSoccerQuote({ quote: adapted.quote, distribution: { period: original.period, retainedMass: 1, tailMass: 0,
        cells: [{ home: final.actualScore.home, away: final.actualScore.away, probability: 1 }] }, contract });
      const predictedBounds = payoffBounds(forecast), actualBounds = payoffBounds(realized);
      if (!predictedBounds || !actualBounds || !finite(realized.netEV)) { pending++; count(reasons, 'RETROSPECTIVE_PAYOFF_UNRESOLVED'); continue; }
      const error = { lower: outward(actualBounds.lower - predictedBounds.upper, false), upper: outward(actualBounds.upper - predictedBounds.lower, true) };
      const descriptor = { league: original.league, period, variant: original.variant, modelHash: original.modelHash,
        ruleHash: rule.application.ruleHash, kind: quote.kind, side: quote.side };
      const groupId = soccerForwardHash(descriptor);
      let group = groups.get(groupId);
      if (!group) { group = { ...descriptor, quotes: 0, games: new Set(), exactPredictedQuotes: 0, boundedPredictedQuotes: 0,
        predictedNetReturnSum: { lower: 0, upper: 0 }, hypotheticalRealizedNetReturnSum: 0,
        retrospectiveErrorSum: { lower: 0, upper: 0 }, ...restrictions }; groups.set(groupId, group); }
      const predictedSum = addBounds(group.predictedNetReturnSum, predictedBounds), errorSum = addBounds(group.retrospectiveErrorSum, error);
      const realizedSum = group.hypotheticalRealizedNetReturnSum + realized.netEV;
      if (!interval(predictedSum) || !interval(errorSum) || !finite(realizedSum)) { pending++; count(reasons, 'RETROSPECTIVE_NUMERICAL_RANGE_INVALID'); continue; }
      group.predictedNetReturnSum = predictedSum; group.retrospectiveErrorSum = errorSum; group.hypotheticalRealizedNetReturnSum = realizedSum;
      group.quotes++; group.games.add(key); playedGames.add(key); replayed++;
      if (forecast.unresolvedTailMass === 0 && finite(forecast.netEV)) { exact++; group.exactPredictedQuotes++; }
      else { bounded++; group.boundedPredictedQuotes++; }
    }
  }
  const complete = evidence.truncated !== true && (!evidence.readCoverage || ['COMPLETE_WITHIN_REQUESTED_SCOPE', 'COMPLETE_WITHIN_REQUESTED_GAME'].includes(evidence.readCoverage.status));
  if (!complete) count(reasons, 'RETROSPECTIVE_INCOMPLETE_REQUESTED_SCOPE');
  return { version: SOCCER_RETROSPECTIVE_PAYOFF_VERSION,
    status: replayed ? pending || quarantinedQuotes || !complete ? 'PARTIAL' : 'RESEARCH_REPLAY_AVAILABLE' : 'MISSING_OBSERVATIONS',
    ruleApplication: rule.application, selectedQuoteObservations: selection.observations.length, replayedQuoteObservations: replayed,
    exactPredictedQuoteReturns: exact, boundedPredictedQuoteReturns: bounded, pendingQuoteObservations: pending,
    quarantinedQuoteObservations: quarantinedQuotes, uniqueReplayedGames: playedGames.size,
    duplicateEconomicQuoteObservations: selection.duplicateQuoteObservations, invalidOriginalQuotes: selection.invalidQuoteObservations,
    unpricedPredictionPeriods: selection.unpriced.length, incompleteResultHistories: incomplete.size,
    completeWithinRequestedScope: complete, excludedReasons: reasons,
    groups: [...groups.values()].filter(group => group.quotes).map(group => ({ ...group, games: group.games.size })),
    resultEvidenceScope: 'ESPN_TWO_ENDPOINT_CROSSCHECK_NOT_INDEPENDENT_OFFICIAL_CONFIRMATION',
    interpretation: 'CURRENT_CONFIRMED_RULE_RETROSPECTIVE_ARITHMETIC_NOT_ACTUAL_ACCOUNT_PROFIT_OR_CONDITIONAL_EV_UNCERTAINTY', ...restrictions };
}

export function buildSoccerRetrospectivePayoffReport(evidence = {}, options = {}) {
  const originals = new Map((evidence.captures || []).map(capture => [capture.captureId, capture]));
  const iterator = pipeline(evidence, options); let step = iterator.next();
  while (!step.done) step = iterator.next(originals.get(step.value));
  return step.value;
}
export async function buildSoccerRetrospectivePayoffReportHydrated(evidence = {}, { hydrateCapture, ...options } = {}) {
  if (typeof hydrateCapture !== 'function') throw Error('RETROSPECTIVE_HYDRATOR_REQUIRED');
  const iterator = pipeline(evidence, options); let step = iterator.next();
  while (!step.done) { let capture = null; try { capture = await hydrateCapture(step.value); } catch {} step = iterator.next(capture); }
  return step.value;
}
