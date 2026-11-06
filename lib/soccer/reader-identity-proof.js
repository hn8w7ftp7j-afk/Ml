// A historical quote is eligible for source-bound validation only when the
// immutable original analysis contains its complete-board identity proof.
// Missing legacy proofs are never inferred from matching team labels.
export const SOCCER_READER_IDENTITY_PROOF_VERSION='SOCCER-COMPLETE-SCHEDULE-IDENTITY-v1';
export function soccerReaderIdentityVerified(_snapshot) {
  // No deployed source can currently prove whole-board completeness at the
  // original decision time. Serializable flags, hashes and timestamps alone
  // are not an independently verified source receipt. Keep the future protocol
  // version reserved, but fail closed until an actual authority is integrated.
  return false;
}

// No current provider has been independently accepted as a complete schedule
// authority. These fail-closed functions cannot be enabled by input flags.
export function soccerCompleteScheduleAuthorityVerified(_board,_game) { return false; }
export function createVerifiedSoccerScheduleIdentityEvidence(_board,_game,_source,_now) { return null; }
