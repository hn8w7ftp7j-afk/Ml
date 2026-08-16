const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

function finite(value) {
  return Number.isFinite(Number(value));
}

/**
 * Build a score-state-aware late-inning multiplier only from calibrated inputs.
 * No guessed bullpen coefficients are allowed. Callers must provide the calibrated
 * leverage table and the team's observed availability/fatigue inputs.
 */
export function lateInningLeverageMultiplier({
  inning,
  battingTeamRuns,
  fieldingTeamRuns,
  highLeverageAvailability,
  fatigueIndex,
  calibration,
}) {
  if (!calibration || !Array.isArray(calibration.rows)) {
    return { ok: false, reason: 'LATE_INNING_CALIBRATION_MISSING' };
  }
  if (![inning, battingTeamRuns, fieldingTeamRuns, highLeverageAvailability, fatigueIndex].every(finite)) {
    return { ok: false, reason: 'LATE_INNING_INPUT_MISSING' };
  }

  const margin = Number(fieldingTeamRuns) - Number(battingTeamRuns);
  const row = calibration.rows.find(candidate =>
    Number(inning) >= Number(candidate.inningFrom) &&
    Number(inning) <= Number(candidate.inningTo) &&
    margin >= Number(candidate.marginFrom) &&
    margin <= Number(candidate.marginTo)
  );
  if (!row || !finite(row.baseMultiplier) || !finite(row.availabilitySlope) || !finite(row.fatigueSlope)) {
    return { ok: false, reason: 'LATE_INNING_CALIBRATION_GAP' };
  }

  const multiplier = Number(row.baseMultiplier)
    + Number(row.availabilitySlope) * clamp(highLeverageAvailability, 0, 1)
    + Number(row.fatigueSlope) * clamp(fatigueIndex, 0, 1);

  return {
    ok: true,
    multiplier: clamp(multiplier, Number(calibration.minimum ?? 0.70), Number(calibration.maximum ?? 1.40)),
    calibrationVersion: calibration.version || null,
  };
}

/**
 * Validate an empirical automatic-runner run distribution. The engine deliberately
 * has no built-in probabilities: MLB historical calibration must be supplied first.
 */
export function validateAutomaticRunnerPmf(calibration) {
  const pmf = calibration?.pmf;
  if (!Array.isArray(pmf) || pmf.length < 2 || !pmf.every(value => finite(value) && Number(value) >= 0)) {
    return { ok: false, reason: 'EXTRA_INNING_PMF_MISSING' };
  }
  const total = pmf.reduce((sum, value) => sum + Number(value), 0);
  if (Math.abs(total - 1) > 1e-8) return { ok: false, reason: 'EXTRA_INNING_PMF_NOT_NORMALIZED' };
  return { ok: true, pmf: pmf.map(Number), calibrationVersion: calibration.version || null };
}

export function sampleDiscretePmf(pmf, random) {
  const draw = random();
  let cumulative = 0;
  for (let index = 0; index < pmf.length; index += 1) {
    cumulative += pmf[index];
    if (draw <= cumulative) return index;
  }
  return pmf.length - 1;
}

/**
 * Baseball termination rule only. Extra walk-off margins must come from an event/state
 * model or empirical calibration; this function never invents an HR probability.
 */
export function applyWalkoff({ awayRuns, homeRuns, sampledRuns, calibratedExtraMargin = 0 }) {
  if (homeRuns > awayRuns) return { homeRuns, ended: true };
  const needed = awayRuns - homeRuns + 1;
  if (sampledRuns < needed) return { homeRuns: homeRuns + sampledRuns, ended: false };
  return {
    homeRuns: homeRuns + needed + Math.max(0, Number(calibratedExtraMargin) || 0),
    ended: true,
  };
}

export const GAME_STATE_VERSION = 'MLB-GAME-STATE-2026-08-v10.0.1';
