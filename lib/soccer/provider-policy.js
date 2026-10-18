// JSON-only policy: safe to import from either server code or client components.
// The user confirmed the football RATE only. No settlement basis or complete
// source contract is inferred from that confirmation or from another sport.
export const SOCCER_PROVIDER_POLICY_VERSION = 'SOCCER-USER-RATE-POLICY-v1';

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
  rebateBasis: 'UNKNOWN',
  rateConfirmation: {
    source: 'user_instruction',
    confirmedAt: '2026-10-18T20:53:42Z',
    confirmedFields: ['rebateRate'],
  },
  period: 'UNKNOWN',
  boundarySettlement: 'UNKNOWN',
  abnormalSettlement: 'UNKNOWN',
  sourceContractGatePassed: false,
  formalContractVerified: false,
  calculationPolicy: 'RATE_CONFIRMED_CONTRACT_INCOMPLETE',
});

/** A detached, deeply frozen as-of snapshot; a later instruction is not PIT evidence. */
export function soccerProviderPolicy({ asOf = Date.now() } = {}) {
  const cutoff = typeof asOf === 'number' ? asOf
    : typeof asOf === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(asOf) ? Date.parse(asOf) : NaN;
  const result = JSON.parse(JSON.stringify(POLICY));
  const validCutoff = Number.isFinite(cutoff) && Math.abs(cutoff) <= 8.64e15;
  const known = validCutoff && cutoff >= Date.parse(POLICY.rateConfirmation.confirmedAt);
  result.asOf = validCutoff ? new Date(cutoff).toISOString() : null;
  if (!known) {
    result.rebateRate = null;
    result.rebateRateStatus = 'UNKNOWN';
    result.calculationPolicy = 'RATE_UNAVAILABLE_AT_CUTOFF_CONTRACT_INCOMPLETE';
  }
  return deepFreeze(result);
}
