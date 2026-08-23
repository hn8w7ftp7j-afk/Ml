export const MLB_INJURY_RUN_VALUE_V2_VERSION = 'MLB-INJURY-REPLACEMENT-RUN-VALUE-2026-08-v2.0.0';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function playerValue(row, leagueOps) {
  const stat = row?.person?.stats?.[0]?.splits?.[0]?.stat || row?.stats?.[0]?.splits?.[0]?.stat || row?.stat || {};
  const plateAppearances = Math.max(0, finite(stat.plateAppearances ?? stat.atBats, 0));
  const ops = finite(stat.ops, null);
  if (ops == null || plateAppearances <= 0) return null;
  const reliability = clamp(plateAppearances / (plateAppearances + 180), 0, 0.86);
  const regressedOps = leagueOps + (ops - leagueOps) * reliability;
  // A transparent pre-validation bridge into runs/game. It remains neutral until OOS promotion.
  const battingRunsPerGame = clamp((regressedOps - leagueOps) * 1.20, -0.22, 0.28);
  const fieldingRunsPerGame = clamp(finite(row?.fieldingRunsPerGame, 0), -0.08, 0.08);
  const baserunningRunsPerGame = clamp(finite(row?.baserunningRunsPerGame, 0), -0.05, 0.05);
  return {
    id: Number(row?.person?.id || row?.id || 0) || null,
    name: String(row?.person?.fullName || row?.name || ''),
    plateAppearances,
    rawOps: ops,
    regressedOps,
    reliability,
    battingRunsPerGame,
    fieldingRunsPerGame,
    baserunningRunsPerGame,
    totalRunsPerGame: battingRunsPerGame + fieldingRunsPerGame + baserunningRunsPerGame,
  };
}

export function buildInjuryRunValueV2({ injuredRoster, lineup, teamOps = 0.72, leagueOps = 0.72, observedAt = '' } = {}) {
  const rows = Array.isArray(injuredRoster?.roster) ? injuredRoster.roster : [];
  const lineupIds = new Set((lineup?.players || []).map(row => Number(row.id)).filter(Boolean));
  const absent = rows
    .filter(row => !lineupIds.has(Number(row?.person?.id || 0)))
    .map(row => playerValue(row, leagueOps))
    .filter(Boolean)
    .sort((left, right) => right.totalRunsPerGame - left.totalRunsPerGame)
    .slice(0, 8);
  if (!injuredRoster?.available) {
    return { status: 'MISSING', validationStatus: 'PENDING', observedAt, source: 'MLB_INJURED_LIST', reason: 'INJURED_LIST_UNAVAILABLE' };
  }
  const replacementOps = clamp(finite(teamOps, leagueOps), 0.55, 0.90);
  const replacementRunsPerGame = clamp((replacementOps - leagueOps) * 1.20, -0.18, 0.18);
  const rawAbsentRuns = absent.reduce((sum, row) => sum + Math.max(0, row.totalRunsPerGame - replacementRunsPerGame), 0);
  const rawBattingRuns = absent.reduce((sum, row) => sum + Math.max(0, row.battingRunsPerGame - replacementRunsPerGame), 0);
  const rawFieldingRuns = absent.reduce((sum, row) => sum + row.fieldingRunsPerGame, 0);
  const rawBaserunningRuns = absent.reduce((sum, row) => sum + row.baserunningRunsPerGame, 0);
  const coverage = rows.length ? absent.length / rows.length : 1;
  const regressionWeight = clamp(0.45 + coverage * 0.35, 0.45, 0.80);
  const regressedAbsentRuns = rawAbsentRuns * regressionWeight;
  const battingRuns = rawBattingRuns * regressionWeight;
  const fieldingRuns = rawFieldingRuns * regressionWeight;
  const baserunningRuns = rawBaserunningRuns * regressionWeight;
  return {
    status: lineup?.official ? 'CONFIRMED' : 'PROJECTED',
    validationStatus: 'PENDING',
    observedAt,
    expectedAbsentShare: absent.length ? 1 : 0,
    replacementRunDeltaPerGame: regressedAbsentRuns,
    lineupCoverage: clamp((lineup?.players?.length || 0) / 9, 0, 1),
    rawValue: { absentRunsPerGame: rawAbsentRuns, battingRunsPerGame: rawBattingRuns, fieldingRunsPerGame: rawFieldingRuns, baserunningRunsPerGame: rawBaserunningRuns, replacementOps },
    regressedValue: { absentRunsPerGame: regressedAbsentRuns, battingRunsPerGame: battingRuns, fieldingRunsPerGame: fieldingRuns, baserunningRunsPerGame: baserunningRuns },
    appliedValue: { absentRunsPerGame: 0, reason: 'HISTORICAL_VALIDATION_PENDING' },
    overlapRule: 'BATTING_VALUE_OWNED_BY_LINEUP_WHEN_LINEUP_IS_AVAILABLE',
    absentPlayers: absent,
    source: 'MLB_INJURED_LIST_PLUS_SEASON_STATS',
    version: MLB_INJURY_RUN_VALUE_V2_VERSION,
  };
}
