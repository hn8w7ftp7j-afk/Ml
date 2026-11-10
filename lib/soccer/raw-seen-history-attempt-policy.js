// v3 changes only recoverable row layouts, not the table profile or replay
// budget. Reuse precisely these v2 outcomes while retaining immutable proof.
// All other previous-version failures, including NO_GOALS, must be retried.
export function compatibleRawHistoryAttemptSql(alias = 'a') {
  return `(${alias}.derivation_version=$3 OR ($3='SOCCER-RAW-CREDIT-TABLE-HISTORY-v3'
    AND ${alias}.derivation_version='SOCCER-RAW-CREDIT-TABLE-HISTORY-v2'
    AND ${alias}.reason IN ('RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT','RAW_SEEN_RECOVERY_BUDGET_EXCEEDED')))`;
}
