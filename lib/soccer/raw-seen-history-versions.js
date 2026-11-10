// Pure constants shared by the server replay and historical browser UI.
export const RAW_SEEN_DERIVATION_VERSION = 'SOCCER-RAW-CREDIT-TABLE-HISTORY-v3';
export const RAW_SEEN_READABLE_DERIVATION_VERSIONS = Object.freeze([RAW_SEEN_DERIVATION_VERSION,
  'SOCCER-RAW-CREDIT-TABLE-HISTORY-v2', 'SOCCER-RAW-CREDIT-TABLE-HISTORY-v1']);
// v1 remains readable as immutable index metadata; its exact parser is not
// retained here, so it cannot be relabelled as a reproducible v2/v3 replay.
export const RAW_SEEN_REPLAYABLE_DERIVATION_VERSIONS = Object.freeze(RAW_SEEN_READABLE_DERIVATION_VERSIONS.slice(0, 2));
