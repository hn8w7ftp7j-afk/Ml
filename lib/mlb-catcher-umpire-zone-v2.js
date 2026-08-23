export const MLB_CATCHER_UMPIRE_ZONE_V2_VERSION = 'MLB-CATCHER-UMPIRE-ZONE-ABS-2026-08-v2.0.0';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function buildCatcherUmpireZoneV2({ catcherFraming = {}, umpire = {}, gameStart = '', observedAt = '' } = {}) {
  const season = Number(String(gameStart).slice(0, 4)) || null;
  const pitches = Math.max(0, finite(catcherFraming?.pitches, 0));
  const framingRuns = finite(catcherFraming?.regressedValue?.framingRuns, finite(catcherFraming?.framingRuns, 0));
  const framingRunsPerPitch = pitches > 0 ? framingRuns / pitches : 0;
  const umpireId = Number(umpire?.id || 0) || null;
  const umpireTakenPitches = Math.max(0, finite(umpire?.takenPitches, 0));
  const umpireResidual = finite(umpire?.catcherNeutralRunsPerGame, null);
  const absChallengeEra = season != null && season >= 2026;
  const status = umpireId && pitches > 0 && umpireResidual != null ? (umpire?.status === 'CONFIRMED' ? 'CONFIRMED' : 'PROJECTED') : 'MISSING';
  return {
    status,
    validationStatus: 'PENDING',
    observedAt,
    catcherId: catcherFraming?.catcherId || null,
    umpireId,
    pitches,
    takenPitches: umpireTakenPitches,
    catcherNeutralRunsPerGame: umpireResidual ?? 0,
    rawValue: { framingRunsPerPitch, umpireCatcherNeutralRunsPerGame: umpireResidual, absChallengeEra },
    regressedValue: {
      framingRunsPerPitch: framingRunsPerPitch * clamp(pitches / (pitches + 1200), 0, 0.90),
      umpireCatcherNeutralRunsPerGame: umpireResidual == null ? null : umpireResidual * clamp(umpireTakenPitches / (umpireTakenPitches + 1800), 0, 0.85),
    },
    appliedValue: { runsPerGame: 0, reason: absChallengeEra ? '2026_ABS_CHALLENGE_OOS_PENDING' : 'HISTORICAL_VALIDATION_PENDING' },
    overlapRule: 'UMPIRE_MUST_BE_CATCHER_NEUTRAL_RESIDUAL',
    source: 'SAVANT_FRAMING_ZONE_PLUS_HOME_PLATE_UMPIRE_RESIDUAL',
    version: MLB_CATCHER_UMPIRE_ZONE_V2_VERSION,
  };
}

