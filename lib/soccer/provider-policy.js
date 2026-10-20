// JSON-only policy: safe to import from either server code or client components.
// Football rate and calculation basis were confirmed at separate times.
// Outcome fractions were confirmed later; keep historical as-of views separate.
export const SOCCER_PROVIDER_POLICY_VERSION = 'SOCCER-USER-REBATE-POLICY-v3';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const POLICY = deepFreeze({
  version: SOCCER_PROVIDER_POLICY_VERSION,
  sport: 'SOCCER',
  leagues: ['EPL', 'UCL'],
  rebateRate: 0.01,
  rebateRateStatus: 'USER_CONFIRMED',
  rebateBasis: 'SETTLED_PRINCIPAL',
  rebateBasisStatus: 'USER_CONFIRMED',
  rebateApplicability: 'WIN_AND_LOSS_FRACTIONS_EXCLUDING_PUSH',
  rebateApplicabilityStatus: 'USER_CONFIRMED',
  rebateFormula: 'stake * (winFraction + lossFraction) * 0.01',
  rebateAppliesTo: { FULL_WIN: true, PARTIAL_WIN: true, PUSH: false, PARTIAL_LOSS: true, FULL_LOSS: true },
  settlementConfirmation: {
    source: 'user_instruction',
    confirmedAt: '2026-10-20T09:11:48Z',
    confirmedFields: ['rebateBasis', 'rebateApplicability', 'rebateFormula'],
    examples: [{ winFraction: 1, lossFraction: 0, rate: 0.01 },
      { winFraction: 0.5, lossFraction: 0, rate: 0.005 },
      { winFraction: 0, lossFraction: 1, rate: 0.01 },
      { winFraction: 0.2, lossFraction: 0, rate: 0.002 },
      { winFraction: 0, lossFraction: 0.5, rate: 0.005 },
      { winFraction: 0, lossFraction: 0, rate: 0 }],
  },
  rateConfirmation: {
    source: 'user_instruction',
    confirmedAt: '2026-10-18T20:53:42Z',
    confirmedFields: ['rebateRate'],
  },
  basisConfirmation: {
    source: 'user_instruction',
    confirmedAt: '2026-10-18T22:15:31Z',
    confirmedFields: ['rebateBasis'],
  },
  period: 'UNKNOWN',
  boundarySettlement: 'UNKNOWN',
  abnormalSettlement: 'UNKNOWN',
  sourceContractGatePassed: false,
  formalContractVerified: false,
  calculationPolicy: 'RATE_AND_SETTLED_BASIS_CONFIRMED_CONTRACT_INCOMPLETE',
});

/** A detached, deeply frozen as-of snapshot; a later instruction is not PIT evidence. */
export function soccerProviderPolicy({ asOf = Date.now() } = {}) {
  const cutoff = typeof asOf === 'number' ? asOf
    : typeof asOf === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(asOf) ? Date.parse(asOf) : NaN;
  const result = JSON.parse(JSON.stringify(POLICY));
  const validCutoff = Number.isFinite(cutoff) && Math.abs(cutoff) <= 8.64e15;
  const rateKnown = validCutoff && cutoff >= Date.parse(POLICY.rateConfirmation.confirmedAt);
  const basisKnown = validCutoff && cutoff >= Date.parse(POLICY.basisConfirmation.confirmedAt);
  const settlementKnown = validCutoff && cutoff >= Date.parse(POLICY.settlementConfirmation.confirmedAt);
  result.asOf = validCutoff ? new Date(cutoff).toISOString() : null;
  if (!settlementKnown) {
    result.rebateBasis = 'TOTAL_PRINCIPAL';
    result.rebateApplicability = 'UNKNOWN';
    result.rebateApplicabilityStatus = 'UNKNOWN';
    result.rebateFormula = null;
    result.rebateAppliesTo = null;
    result.calculationPolicy = 'RATE_AND_BASIS_CONFIRMED_CONTRACT_INCOMPLETE';
  }
  if (!basisKnown) {
    result.rebateBasis = 'UNKNOWN';
    result.rebateBasisStatus = 'UNKNOWN';
    result.calculationPolicy = 'RATE_CONFIRMED_CONTRACT_INCOMPLETE';
  }
  if (!rateKnown) {
    result.rebateRate = null;
    result.rebateRateStatus = 'UNKNOWN';
    result.calculationPolicy = 'RATE_UNAVAILABLE_AT_CUTOFF_CONTRACT_INCOMPLETE';
  }
  return deepFreeze(result);
}

