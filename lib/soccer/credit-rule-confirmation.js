// User-confirmed arithmetic, kept separate from model and source-contract approval.
// This is the conservative receipt time, not an inferred historical effective date.
const confirmedAt = '2026-10-30T15:01:39Z';
const examples = [
  { line: '1+20', stake: 1000, water: 0.9, winningMargin: 1, grossProfit: 180, rebate: 2, netProfit: 182 },
  { line: '1-20', stake: 1000, water: 0.9, winningMargin: 1, grossProfit: -200, rebate: 2, netProfit: -198 },
  { line: '1平', stake: 1000, water: 0.9, winningMargin: 1, grossProfit: 0, rebate: 0, netProfit: 0 },
];

export function soccerCreditRuleConfirmation(asOf = Date.now()) {
  const cutoff = typeof asOf === 'number' ? asOf
    : typeof asOf === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(asOf) ? Date.parse(asOf) : NaN;
  const known = Number.isFinite(cutoff) && Math.abs(cutoff) <= 8.64e15 && cutoff >= Date.parse(confirmedAt);
  return Object.freeze({
    version: 'SOCCER-USER-CREDIT-EXAMPLES-v1',
    status: known ? 'USER_CONFIRMED' : 'NOT_YET_CONFIRMED',
    source: 'user_instruction', confirmedAt,
    timeBasis: 'CONFIRMATION_RECEIPT',
    scope: 'HANDICAP_GIVING_SIDE_EXACT_BOUNDARY_EXAMPLES',
    leagues: Object.freeze(['epl', 'ucl']),
    examples: Object.freeze(known ? examples.map(example => Object.freeze({ ...example })) : []),
    formalContractVerified: false,
    formalScoringEnabled: false,
  });
}
