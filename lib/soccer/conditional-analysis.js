import { adaptSoccerReaderQuote, soccerScoringHash } from './soccer-scoring.js';
import { evaluateSoccerQuote } from './market-payoff.js';

export const SOCCER_CONDITIONAL_ANALYSIS_VERSION = 'SOCCER-CREDIT-ASSUMPTION-RETURN-v1';

// An explicitly labelled research assumption is not a registered source
// contract. Never feed this summary into formal scoring, ranking or settlement.
export function analyzeSoccerConditionalQuote({ quote, distribution, game, now = Date.now() } = {}) {
  const base = { version: SOCCER_CONDITIONAL_ANALYSIS_VERSION, gameId: game?.id || null,
    league: game?.league || null, period: quote?.period || null, sourceQuoteKey: quote?.key || null,
    calculatedAt: Number.isFinite(now) && Math.abs(now)<=8.64e15 ? new Date(now).toISOString() : null,
    formalScoringEnabled: false, eligible: false, executable: false, W: null, R: null, S: null };
  const blocked = reason => ({ ...base, status: 'UNAVAILABLE', reason });
  const adapted = adaptSoccerReaderQuote({ quote, game, now });
  if (!adapted.ok) return blocked(adapted.code);
  if (distribution?.league !== game.league || distribution?.gameId !== game.id
    || distribution?.period !== ({ FT: 'REGULATION_FT', HT: 'REGULATION_HT' })[quote.period]
    || !distribution?.modelVersion || !/^[a-f0-9]{64}$/.test(distribution?.trainingHash || '')
    || !Number.isFinite(Date.parse(distribution.trainedThrough)) || Date.parse(distribution.trainedThrough)>=now)
    return blocked('CONDITIONAL_MODEL_SCOPE_INVALID');
  const contract = { type: 'CREDIT_BOUNDARY', period: quote.period,
    labelMapping: { home: game.home?.name, away: game.away?.name },
    rebate: { rate: .01, basis: 'SETTLED_PRINCIPAL' },
    provenance: { status: 'ASSUMPTION', note: 'Credit-boundary payout hypothesis; account applicability unverified. User-confirmed 1% settled-principal rebate.' } };
  const payoff = evaluateSoccerQuote({ quote: adapted.quote, distribution, contract });
  if (!payoff.ok) return blocked(payoff.code);
  return { ...base, status: 'CONDITIONAL_RESEARCH', reason: null,
    assumption: { mechanic: contract.type, accountTermsVerified: false,
      rebateRate: .01, rebateBasis: 'SETTLED_PRINCIPAL',
      period: quote.period, extraTimeIncluded: false },
    modelVersion: distribution.modelVersion, trainingHash: distribution.trainingHash,
    distributionHash: soccerScoringHash(distribution), quoteObservedAt: quote.provenance.observedAt,
    probabilities: payoff.probabilities, probabilityBounds: payoff.probabilityBounds,
    netReturnBounds: payoff.evBounds.net, exactNetReturn: payoff.netEV,
    unresolvedTailMass: payoff.unresolvedTailMass,
    interpretation: 'CONDITIONAL_PAYOUT_HYPOTHESIS_NOT_EMPIRICAL_R_OR_S' };
}
