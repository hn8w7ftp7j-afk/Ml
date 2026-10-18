// JSON-only policy: safe to import from either server code or client components.
// Football rate and calculation basis were confirmed at separate times.
// Eligible settlement states and the complete source contract remain unverified.
export const SOCCER_PROVIDER_POLICY_VERSION = 'SOCCER-USER-REBATE-POLICY-v2';

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
  rebateBasis: 'TOTAL_PRINCIPAL',
  rebateBasisStatus: 'USER_CONFIRMED',
  rebateApplicability: 'UNKNOWN',
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
  calculationPolicy: 'RATE_AND_BASIS_CONFIRMED_CONTRACT_INCOMPLETE',
});

/** A detached, deeply frozen as-of snapshot; a later instruction is not PIT evidence. */
export function soccerProviderPolicy({ asOf = Date.now() } = {}) {
  const cutoff = typeof asOf === 'number' ? asOf
    : typeof asOf === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(asOf) ? Date.parse(asOf) : NaN;
  const result = JSON.parse(JSON.stringify(POLICY));
  const validCutoff = Number.isFinite(cutoff) && Math.abs(cutoff) <= 8.64e15;
  const rateKnown = validCutoff && cutoff >= Date.parse(POLICY.rateConfirmation.confirmedAt);
  const basisKnown = validCutoff && cutoff >= Date.parse(POLICY.basisConfirmation.confirmedAt);
  result.asOf = validCutoff ? new Date(cutoff).toISOString() : null;
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

