export const MLB_RUN_MODEL_V103_VERSION = 'MLB-CORRELATED-RISK-RUN-PROFILE-2026-08-v10.5.1';

const finite = (value, fallback = 0) => {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const safeLog = value => Math.log(Math.max(1e-9, Number(value) || 1e-9));

function sampleReliability(sampleSize, target, maximum = 0.92) {
  const sample = Math.max(0, finite(sampleSize, 0));
  return clamp(sample / (sample + Math.max(1, target)), 0, maximum);
}

function statusMultiplier(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'CONFIRMED') return 1;
  if (value === 'PROJECTED') return 0.72;
  return 0.35;
}

function logShrinkFactor(ratio, reliability, maximumLogMove) {
  const value = clamp(finite(ratio, 1), 0.45, 2.20);
  return Math.exp(clamp(safeLog(value) * clamp(reliability, 0, 1), -maximumLogMove, maximumLogMove));
}

function geometricBlend(left, right, leftWeight) {
  const weight = clamp(finite(leftWeight, 0.5), 0, 1);
  return Math.exp(safeLog(left) * weight + safeLog(right) * (1 - weight));
}

function statusUncertainty(status, confirmed, projected, missing) {
  const value = String(status || '').toUpperCase();
  if (value === 'CONFIRMED') return confirmed;
  if (value === 'PROJECTED') return projected;
  return missing;
}

// Offense, lineup, injuries and opposing pitching are not independent error
// sources. Keep the largest component and add only a residual share of the
// others, avoiding the old root-sum-square double count.
function correlatedUncertainty(parts, residualWeight = 0.35) {
  const values = parts.map(value => Math.max(0, finite(value, 0))).sort((a, b) => b - a);
  if (!values.length) return 0;
  const [primary, ...residual] = values;
  return Math.sqrt(primary ** 2 + residualWeight ** 2 * residual.reduce((sum, value) => sum + value ** 2, 0));
}

// Game-to-game outcome variance already lives in the negative-binomial score
// distribution. Only the residual uncertainty of its estimated mean belongs
// in the scenario layer; carrying the entire feature uncertainty here counts
// the same baseball volatility twice.
const MEAN_PARAMETER_UNCERTAINTY_SHARE = 0.34;

function standardFip(block = {}, league = {}) {
  const leagueEra = clamp(finite(league?.era, 4.25), 2.5, 6.5);
  const leagueK9 = clamp(finite(league?.kPer9, 8.6), 4, 14);
  const leagueBB9 = clamp(finite(league?.bbPer9, 3.2), 1, 7);
  const leagueHR9 = clamp(finite(league?.hrPer9, 1.15), 0.2, 3);
  const k9 = clamp(finite(block?.kPer9, leagueK9), 3, 16);
  const bb9 = clamp(finite(block?.bbPer9, leagueBB9), 0.5, 8);
  const hr9 = clamp(finite(block?.hrPer9, leagueHR9), 0.1, 4);
  const leagueComponent = (13 * leagueHR9 + 3 * leagueBB9 - 2 * leagueK9) / 9;
  const constant = leagueEra - leagueComponent;
  return clamp((13 * hr9 + 3 * bb9 - 2 * k9) / 9 + constant, 2.0, 7.5);
}

function offenseProfile(team = {}, league = {}) {
  const leagueRuns = clamp(finite(league?.runsPerTeamGame, 4.4), 3.2, 5.8);
  const leagueOps = clamp(finite(league?.ops, 0.72), 0.55, 0.90);
  const season = team?.hitting || team?.seasonHitting || {};
  const recent = team?.recentHitting || {};
  const seasonGames = finite(season?.games ?? season?.gamesPlayed, 0);
  const recentGames = finite(recent?.games ?? recent?.gamesPlayed, 0);
  const seasonReliability = sampleReliability(seasonGames, 55) * statusMultiplier(season?.status);
  const recentReliability = sampleReliability(recentGames, 18, 0.75) * statusMultiplier(recent?.status) * 0.40;
  const seasonRuns = clamp(finite(season?.runsPerGame, leagueRuns), 2.0, 7.5);
  const recentRuns = clamp(finite(recent?.runsPerGame, seasonRuns), 1.5, 8.0);
  const seasonOps = clamp(finite(season?.ops, leagueOps), 0.50, 1.00);

  // Runs/game is the primary signal. Recent form is expressed only as a
  // shrunk delta to the season rate, and OPS is a small residual signal so
  // correlated offensive inputs cannot be counted at full strength twice.
  const seasonRunFactor = logShrinkFactor(seasonRuns / leagueRuns, seasonReliability, 0.105);
  const recentDeltaFactor = logShrinkFactor(recentRuns / Math.max(0.5, seasonRuns), recentReliability, 0.045);
  const opsResidualFactor = logShrinkFactor(seasonOps / leagueOps, seasonReliability * 0.24, 0.035);
  const factor = clamp(seasonRunFactor * recentDeltaFactor * opsResidualFactor, 0.86, 1.16);
  const uncertainty = clamp(
    0.026
      + (1 - seasonReliability) * 0.055
      + (1 - Math.min(1, recentReliability / 0.30)) * 0.018,
    0.035,
    0.105,
  );
  return {
    factor,
    uncertainty,
    seasonReliability,
    recentReliability,
    inputs: { leagueRuns, leagueOps, seasonRuns, recentRuns, seasonOps },
  };
}

function pitchingProfile(block = {}, league = {}, { starter = false } = {}) {
  const leagueEra = clamp(finite(league?.era, 4.25), 2.5, 6.5);
  const leagueWhip = clamp(finite(league?.whip, 1.30), 0.9, 1.8);
  const innings = Math.max(0, finite(block?.inningsPitched, 0));
  let reliability = sampleReliability(innings, starter ? 55 : 180);
  reliability *= statusMultiplier(block?.status);
  if (block?.fipStatus === 'PROJECTED') reliability *= 0.86;
  if (block?.projectedFromTeamPitching === true) reliability *= 0.28;

  const fip = standardFip(block, league);
  const era = clamp(finite(block?.era, fip), 1.5, 8.5);
  const whip = clamp(finite(block?.whip, leagueWhip), 0.7, 2.2);

  // FIP is the main run-prevention signal. ERA and WHIP enter only as
  // residual corrections, preventing the same pitching quality from being
  // multiplied three times.
  const fipFactor = logShrinkFactor(fip / leagueEra, reliability, starter ? 0.135 : 0.085);
  const eraResidualFactor = logShrinkFactor(era / Math.max(1.5, fip), reliability * 0.24, 0.032);
  const whipResidualFactor = logShrinkFactor(whip / leagueWhip, reliability * 0.14, 0.022);
  const factor = clamp(fipFactor * eraResidualFactor * whipResidualFactor, starter ? 0.84 : 0.90, starter ? 1.18 : 1.10);
  const uncertainty = clamp(
    (starter ? 0.035 : 0.055)
      + (1 - reliability) * (starter ? 0.105 : 0.075)
      + (block?.projectedFromTeamPitching === true ? 0.040 : 0),
    starter ? 0.045 : 0.060,
    starter ? 0.165 : 0.140,
  );
  return {
    factor,
    uncertainty,
    reliability,
    fip,
    fipSource: 'STANDARD_RATE_FIP_WITH_LEAGUE_ERA_CONSTANT_NO_HBP',
    inputs: { era, whip, innings },
  };
}

function bullpenProfile(team = {}, league = {}) {
  const season = pitchingProfile(team?.pitching || team?.seasonPitching || {}, league, { starter: false });
  const recent = pitchingProfile(team?.recentPitching || {}, league, { starter: false });
  // Team pitching is not a clean relief-only split. Keep the central effect
  // close to neutral and carry the missing relief-only information as risk.
  const factor = clamp(
    Math.exp(safeLog(season.factor) * 0.22 + safeLog(recent.factor) * 0.10),
    0.95,
    1.05,
  );
  const uncertainty = clamp(
    0.070 + (1 - season.reliability) * 0.035 + (1 - recent.reliability) * 0.020,
    0.075,
    0.135,
  );
  return {
    factor,
    uncertainty,
    status: 'PROJECTED',
    proxy: 'SHRUNK_TEAM_PITCHING_UNTIL_RELIEF_ONLY_PIT_EXISTS',
    season,
    recent,
  };
}

function expectedStarterInnings(block = {}) {
  if (block?.projectedFromTeamPitching === true) return 5.0;
  const innings = Math.max(0, finite(block?.inningsPitched, 0));
  const starts = Math.max(0, finite(block?.gamesStarted, 0));
  const observed = starts >= 2 ? innings / starts : finite(block?.expectedInnings, 5.2);
  return clamp(observed, 1.0, 7.2);
}

function environmentProfile(context = {}) {
  const park = clamp(finite(context?.park?.runFactor, 1), 0.88, 1.15);
  const weather = clamp(finite(context?.weather?.meanRunFactor, context?.weather?.meanRunFactorV10 ?? 1), 0.93, 1.08);
  return {
    park,
    weather,
    factor: clamp(park * weather, 0.84, 1.20),
    uncertainty: clamp(correlatedUncertainty([
      statusUncertainty(context?.park?.factorStatus, 0.018, 0.035, 0.060),
      statusUncertainty(context?.weather?.status, 0.018, 0.042, 0.070),
    ], 0.30) * MEAN_PARAMETER_UNCERTAINTY_SHARE, 0.008, 0.030),
  };
}

function scheduleDispersion(team = {}, segmentFraction = 1, segmentMean = 1) {
  const scoring = team?.scoring || {};
  const games = Math.max(0, finite(scoring?.games, 0));
  const reliability = sampleReliability(games, 45, 0.85);
  const empiricalVariance = Math.max(0, finite(scoring?.varianceRuns, 0)) * segmentFraction;
  const priorVariance = Math.max(segmentMean + 0.05, segmentMean * 1.30);
  const variance = reliability > 0 && empiricalVariance > 0
    ? reliability * empiricalVariance + (1 - reliability) * priorVariance
    : priorVariance;
  const implied = segmentMean * segmentMean / Math.max(0.05, variance - segmentMean);
  return clamp(implied, segmentFraction < 0.7 ? 2.4 : 3.2, 18);
}

function injuryUncertainty(team = {}) {
  if (team?.injuriesAvailable === false) return 0.040;
  return Math.min(0.040, (Array.isArray(team?.injuries) ? team.injuries.length : 0) * 0.0035);
}

function lineupUncertainty(context = {}) {
  const status = String(context?.sourceStatuses?.lineups || 'MISSING').toUpperCase();
  return status === 'CONFIRMED' ? 0.015 : status === 'PROJECTED' ? 0.035 : 0.055;
}

export function estimateRunProfileV103(context = {}) {
  const league = context?.league || {};
  const away = context?.away || {};
  const home = context?.home || {};
  const baseline = clamp(finite(league?.runsPerTeamGame, 4.4), 3.4, 5.5);
  const environment = environmentProfile(context);
  const homeAdvantage = 1.018;

  const awayOffense = offenseProfile(away, league);
  const homeOffense = offenseProfile(home, league);
  const awayStarter = pitchingProfile(away?.starter || {}, league, { starter: true });
  const homeStarter = pitchingProfile(home?.starter || {}, league, { starter: true });
  const awayBullpen = bullpenProfile(away, league);
  const homeBullpen = bullpenProfile(home, league);

  const awayStarterInnings = expectedStarterInnings(away?.starter || {});
  const homeStarterInnings = expectedStarterInnings(home?.starter || {});
  const awayStarterShareF5 = clamp(awayStarterInnings / 5, 0.20, 1);
  const homeStarterShareF5 = clamp(homeStarterInnings / 5, 0.20, 1);
  const awayStarterShareLate = clamp((awayStarterInnings - 5) / 4, 0, 0.55);
  const homeStarterShareLate = clamp((homeStarterInnings - 5) / 4, 0, 0.55);

  const awayOpponentPitchF5 = geometricBlend(homeStarter.factor, homeBullpen.factor, homeStarterShareF5);
  const homeOpponentPitchF5 = geometricBlend(awayStarter.factor, awayBullpen.factor, awayStarterShareF5);
  const awayOpponentPitchLate = geometricBlend(homeStarter.factor, homeBullpen.factor, homeStarterShareLate);
  const homeOpponentPitchLate = geometricBlend(awayStarter.factor, awayBullpen.factor, awayStarterShareLate);

  const awayFirst5 = clamp(baseline * (5 / 9) * awayOffense.factor * awayOpponentPitchF5 * environment.factor, 1.0, 4.15);
  const homeFirst5 = clamp(baseline * (5 / 9) * homeOffense.factor * homeOpponentPitchF5 * environment.factor * homeAdvantage, 1.0, 4.25);
  const awayLate = clamp(baseline * (4 / 9) * awayOffense.factor * awayOpponentPitchLate * environment.factor, 0.75, 3.45);
  const homeLate = clamp(baseline * (4 / 9) * homeOffense.factor * homeOpponentPitchLate * environment.factor * homeAdvantage, 0.75, 3.55);

  const lineupSigma = lineupUncertainty(context);
  const awayDataSigma = correlatedUncertainty([
    awayOffense.uncertainty,
    homeStarter.uncertainty,
    homeBullpen.uncertainty * 0.35,
    lineupSigma,
    injuryUncertainty(away),
  ], 0.32);
  const homeDataSigma = correlatedUncertainty([
    homeOffense.uncertainty,
    awayStarter.uncertainty,
    awayBullpen.uncertainty * 0.35,
    lineupSigma,
    injuryUncertainty(home),
  ], 0.32);

  return {
    version: MLB_RUN_MODEL_V103_VERSION,
    baseline,
    first5: { away: awayFirst5, home: homeFirst5 },
    late: { away: awayLate, home: homeLate },
    full: { away: awayFirst5 + awayLate, home: homeFirst5 + homeLate },
    dispersion: {
      awayFirst5: scheduleDispersion(away, 5 / 9, awayFirst5),
      homeFirst5: scheduleDispersion(home, 5 / 9, homeFirst5),
      awayLate: scheduleDispersion(away, 4 / 9, awayLate),
      homeLate: scheduleDispersion(home, 4 / 9, homeLate),
    },
    uncertainty: {
      away: clamp(awayDataSigma * MEAN_PARAMETER_UNCERTAINTY_SHARE, 0.018, 0.045),
      home: clamp(homeDataSigma * MEAN_PARAMETER_UNCERTAINTY_SHARE, 0.018, 0.045),
      environment: environment.uncertainty,
    },
    components: {
      awayOffense: awayOffense.factor,
      homeOffense: homeOffense.factor,
      awayStarter: awayStarter.factor,
      homeStarter: homeStarter.factor,
      awayBullpen: awayBullpen.factor,
      homeBullpen: homeBullpen.factor,
      awayStarterFip: awayStarter.fip,
      homeStarterFip: homeStarter.fip,
      awayStarterExpectedInnings: awayStarterInnings,
      homeStarterExpectedInnings: homeStarterInnings,
      awayStarterShareF5,
      homeStarterShareF5,
      awayStarterShareLate,
      homeStarterShareLate,
      awayOpponentPitchF5,
      homeOpponentPitchF5,
      awayOpponentPitchLate,
      homeOpponentPitchLate,
      park: environment.park,
      weather: environment.weather,
      environment: environment.factor,
      homeAdvantage,
      bullpenProxy: 'SHRUNK_TEAM_PITCHING_NOT_RELIEF_ONLY',
      injuryMeanEffect: 1,
    },
    statuses: context?.sourceStatuses || {},
    diagnostics: {
      awayOffense,
      homeOffense,
      awayStarter,
      homeStarter,
      awayBullpen,
      homeBullpen,
      lineups: context?.sourceStatuses?.lineups || 'MISSING',
    },
  };
}
