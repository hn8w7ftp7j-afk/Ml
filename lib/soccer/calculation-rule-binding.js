import { adaptSoccerReaderQuote, soccerScoringHash } from './soccer-scoring.js';
import { soccerProviderPolicy } from './provider-policy.js';
import { soccerCreditRuleConfirmation } from './credit-rule-confirmation.js';
import { SETTLEMENT_RULE_VERSION } from '../taiwan-settlement-v9.js';

export const SOCCER_CALCULATION_BINDING_VERSION = 'SOCCER-ORIGINAL-QUOTE-CALCULATION-BINDING-v1';

// A server-created arithmetic receipt. This is deliberately separate from a
// provider contract: confirming an algorithm does not verify account terms.
export function bindSoccerCalculationRule({ quote, game, now = Date.now() } = {}) {
  const adapted = adaptSoccerReaderQuote({ quote, game, now });
  if (!adapted.ok) return { status: 'UNBOUND', reason: adapted.code };
  const policy = soccerProviderPolicy({ asOf: now });
  const credit = soccerCreditRuleConfirmation(now);
  const confirmedAt = credit.confirmedAt;
  if (credit.status !== 'USER_CONFIRMED' || policy.rebateApplicabilityStatus !== 'USER_CONFIRMED'
    || policy.rebateRate !== .01 || policy.rebateBasis !== 'SETTLED_PRINCIPAL'
    || Date.parse(adapted.provenance.observedAt) < Date.parse(confirmedAt))
    return { status: 'UNBOUND', reason: 'CALCULATION_CONFIRMATION_UNAVAILABLE_AT_QUOTE_TIME' };
  const contract = { type: 'CREDIT_BOUNDARY', period: quote.period,
    labelMapping: { home: game.home?.name, away: game.away?.name },
    rebate: { rate: .01, basis: 'SETTLED_PRINCIPAL' },
    provenance: { status: 'ASSUMPTION', note: 'Bound user-confirmed arithmetic; provider account and period terms remain unverified.' } };
  const body = { version: SOCCER_CALCULATION_BINDING_VERSION, status: 'ARITHMETIC_BOUND',
    authority: 'USER_CONFIRMED_CALCULATION', ruleVersion: SETTLEMENT_RULE_VERSION,
    confirmationVersion: credit.version, policyVersion: policy.version, confirmedAt,
    appliedAt: new Date(now).toISOString(), league: game.league, gameId: game.id,
    sourceQuoteKey: adapted.sourceQuoteKey, marketKey: adapted.marketKey,
    quote: adapted.quote, provenance: adapted.provenance, contract,
    abnormalStatusPolicy: 'MANUAL_REVIEW', accountTermsVerified: false,
    periodTermsVerified: false, historicalContractVerified: false,
    formalScoringEnabled: false, eligible: false, executable: false };
  return { ...body, bindingHash: soccerScoringHash(body) };
}
