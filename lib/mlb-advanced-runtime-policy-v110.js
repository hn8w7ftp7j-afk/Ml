import { buildAdvancedPromotionPolicyV109 } from './mlb-advanced-promotion-gate-v109.js';
import {
  MLB_ADVANCED_PROMOTION_POLICY_V2,
  MLB_ADVANCED_PROMOTION_POLICY_V2_VERSION,
} from './mlb-advanced-promotion-policy-v2.js';

export const MLB_ADVANCED_RUNTIME_POLICY_V110_VERSION = 'MLB-SERVER-OWNED-ADVANCED-RUNTIME-POLICY-2026-08-v11.0.0';

// Trust is intentionally an in-process capability rather than a serializable
// property.  A request/context payload can copy every public field of an
// approved policy, but it cannot become a policy accepted by this resolver.
const trustedPolicies = new WeakMap();

function trust(policy, provenance) {
  trustedPolicies.set(policy, Object.freeze({
    runtimePolicyVersion: MLB_ADVANCED_RUNTIME_POLICY_V110_VERSION,
    source: 'SERVER_OWNED_MODULE',
    ...provenance,
  }));
  return policy;
}

export const MLB_ACTIVE_ADVANCED_RUNTIME_POLICY_V110 = trust(
  MLB_ADVANCED_PROMOTION_POLICY_V2,
  {
    policyVersion: MLB_ADVANCED_PROMOTION_POLICY_V2_VERSION,
    releaseStatus: MLB_ADVANCED_PROMOTION_POLICY_V2.__meta.releaseStatus,
    validationArtifactHash: null,
    releaseApproved: false,
    compiledDefault: true,
  },
);

// This is the only supported bridge from an immutable OOS artifact/release
// approval into the run model.  Keep calls to this factory in server-owned
// release code; never pass request JSON to it.
export function buildServerOwnedMlbAdvancedPolicyV110(validationArtifact = {}, approval = {}) {
  const policy = buildAdvancedPromotionPolicyV109(validationArtifact, approval);
  return trust(policy, {
    policyVersion: policy?.__meta?.version || null,
    releaseStatus: policy?.__meta?.releaseApproved ? 'APPROVED_LOCKED_RELEASE' : 'DIAGNOSTIC_NEUTRAL',
    validationArtifactHash: policy?.__meta?.validationArtifactHash || null,
    releaseApproved: policy?.__meta?.releaseApproved === true,
    releaseId: String(approval?.releaseId || ''),
    approvedAt: approval?.approvedAt || null,
    compiledDefault: false,
  });
}

export function resolveServerOwnedMlbAdvancedPolicyV110(candidate = null, { gameStart = '', contextAsOf = '' } = {}) {
  if (candidate && trustedPolicies.has(candidate)) {
    const provenance = trustedPolicies.get(candidate);
    if (provenance.releaseApproved === true) {
      const approvedAt = Date.parse(provenance.approvedAt || '');
      const start = Date.parse(gameStart || '');
      const asOf = Date.parse(contextAsOf || '');
      const cutoff = Number.isFinite(asOf) && Number.isFinite(start) ? Math.min(asOf, start) : start;
      if (!Number.isFinite(approvedAt) || !Number.isFinite(cutoff) || approvedAt >= cutoff) {
        return {
          policy: MLB_ACTIVE_ADVANCED_RUNTIME_POLICY_V110,
          provenance: trustedPolicies.get(MLB_ACTIVE_ADVANCED_RUNTIME_POLICY_V110),
          untrustedOverrideRejected: false,
          policyPointInTimeRejected: true,
          rejectedPolicyProvenance: provenance,
          rejectionReason: 'PROMOTION_POLICY_NOT_EFFECTIVE_BEFORE_CONTEXT',
        };
      }
    }
    return {
      policy: candidate,
      provenance,
      untrustedOverrideRejected: false,
      policyPointInTimeRejected: false,
    };
  }
  return {
    policy: MLB_ACTIVE_ADVANCED_RUNTIME_POLICY_V110,
    provenance: trustedPolicies.get(MLB_ACTIVE_ADVANCED_RUNTIME_POLICY_V110),
    untrustedOverrideRejected: Boolean(candidate),
    policyPointInTimeRejected: false,
  };
}
