const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

/**
 * Deterministic late-inning leverage multiplier.
 * This does not invent a closer ERA. It only maps known bullpen availability/fatigue
 * and the simulated score state into a bounded run-environment adjustment.
 */
export function lateInningLeverageMultiplier({
  inning,
  battingTeamRuns,
  fieldingTeamRuns,
  highLeverageAvailability = 0.75,
  fatigueIndex = 0.2,
}) {
  const marginForFieldingTeam = fieldingTeamRuns - battingTeamRuns;
  const leverageAvailable = clamp(highLeverageAvailability, 0, 1);
  const fatigue = clamp(fatigueIndex, 0, 1);

  // Close games from the 7th onward are more likely to receive the best available arms.
  const closeGame = Math.abs(marginForFieldingTeam) <= 2;
  const late = inning >= 7;
  const veryLate = inning >= 8;
  const blowout = Math.abs(marginForFieldingTeam) >= 5;

  let multiplier = 1;
  if (late && closeGame) {
    const leverageSuppression = (veryLate ? 0.105 : 0.07) * leverageAvailable;
    multiplier -= leverageSuppression;
  }
  if (blowout) {
    // Low-leverage relievers are more likely; fatigue amplifies the effect.
    multiplier += 0.055 + fatigue * 0.055;
  } else {
    multiplier += fatigue * 0.025;
  }

  return clamp(multiplier, 0.84, 1.16);
}

/**
 * MLB automatic-runner extra-inning run PMF.
 * The shape is intentionally discrete instead of scaling a Poisson lambda.
 * Values are conservative priors until the historical calibration table is connected.
 * meanAdjustment tilts mass locally without changing the topology into a Poisson tail.
 */
export function mlbAutomaticRunnerPmf(meanAdjustment = 1) {
  const tilt = clamp(meanAdjustment, 0.78, 1.28);
  const base = [
    0.315, // 0 runs
    0.315, // 1 run: runner-on-2B state creates a pronounced one-run mode
    0.185, // 2
    0.095, // 3
    0.048, // 4
    0.024, // 5
    0.011, // 6
    0.007, // 7+
  ];

  const weighted = base.map((probability, runs) => {
    if (runs === 0) return probability / Math.sqrt(tilt);
    return probability * Math.pow(tilt, Math.min(runs, 4) / 2.5);
  });
  const total = weighted.reduce((sum, value) => sum + value, 0);
  return weighted.map(value => value / total);
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
 * Applies baseball termination rules to a home half-inning.
 * walk-off HR margins remain possible; ordinary scoring is truncated at the winning run.
 */
export function applyWalkoff({ awayRuns, homeRuns, sampledRuns, extraMarginProbability = 0.18, random }) {
  if (homeRuns > awayRuns) return { homeRuns, ended: true };
  const needed = awayRuns - homeRuns + 1;
  if (sampledRuns < needed) return { homeRuns: homeRuns + sampledRuns, ended: false };

  const surplus = Math.max(0, sampledRuns - needed);
  const keepSurplus = surplus > 0 && random() < extraMarginProbability;
  return {
    homeRuns: homeRuns + needed + (keepSurplus ? surplus : 0),
    ended: true,
  };
}

export const GAME_STATE_VERSION = 'MLB-GAME-STATE-2026-08-v10.0.0';
