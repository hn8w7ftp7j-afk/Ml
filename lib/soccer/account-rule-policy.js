// User instruction received after the two account-rule questions in this
// conversation. This is account-owner confirmation, not external source proof.
export const SOCCER_ACCOUNT_RULE_CONFIRMATION = Object.freeze({
  version: 'SOCCER-USER-CONFIRMED-ACCOUNT-RULES-v1',
  confirmedAt: '2026-11-01T23:53:50Z',
  authority: 'ACCOUNT_OWNER_INSTRUCTION',
  evidenceRef: 'account-owner-confirmation:2026-11-02:football-period-and-credit-rules',
  scope: 'EPL_UCL_FT_HT_NORMAL_REGULATION',
  abnormalStatusPolicy: 'MANUAL_REVIEW',
});

export function soccerAccountRulesKnown(asOf) {
  const time = typeof asOf === 'number' ? asOf : typeof asOf === 'string'
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(asOf) ? Date.parse(asOf) : NaN;
  return Number.isFinite(time) && time >= Date.parse(SOCCER_ACCOUNT_RULE_CONFIRMATION.confirmedAt);
}
