export const MLB_ADVANCED_PROMOTION_POLICY_V2_VERSION = 'MLB-ADVANCED-PROMOTION-POLICY-2026-08-v2.1.0';

// Generated from the immutable 2021 training, 2022-2025 walk-forward OOS,
// and 2026 shadow artifact.  Payloads cannot self-declare that a feature is
// promoted: server-owned policy must opt a family in after all folds pass.
export const MLB_ADVANCED_PROMOTION_POLICY_V2 = Object.freeze({
  fielding: Object.freeze({ promoted: false, decision: 'DIAGNOSTIC_ONLY', reason: 'OOS_FOLD_CRITERIA_NOT_MET' }),
  injury: Object.freeze({ promoted: false, decision: 'DIAGNOSTIC_PROXY_ONLY', reason: 'NO_OFFICIAL_IMMUTABLE_HISTORICAL_IL_SNAPSHOT' }),
  pitchMatchup: Object.freeze({ promoted: false, decision: 'DIAGNOSTIC_ONLY', reason: 'OOS_FOLD_CRITERIA_NOT_MET' }),
  catcherFraming: Object.freeze({ promoted: false, decision: 'DIAGNOSTIC_ONLY', reason: 'JOINT_CATCHER_UMPIRE_OOS_FOLD_CRITERIA_NOT_MET' }),
  umpireZone: Object.freeze({ promoted: false, decision: 'DIAGNOSTIC_ONLY', reason: 'JOINT_CATCHER_UMPIRE_OOS_FOLD_CRITERIA_NOT_MET_AND_2026_ABS_REGIME' }),
  directionalWind: Object.freeze({ promoted: false, decision: 'DIAGNOSTIC_ONLY', reason: 'OOS_FOLD_CRITERIA_NOT_MET' }),
});

export function isMlbAdvancedFeaturePromotedV2(name, policy = MLB_ADVANCED_PROMOTION_POLICY_V2) {
  return policy?.[name]?.promoted === true;
}
