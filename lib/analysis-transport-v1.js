export const ANALYSIS_TRANSPORT_VERSION = 'BASEBALL-ANALYSIS-TRANSPORT-v1.1.0-MOBILE-RESUME';

export function compactAnalysisContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return context;
  const side = value => ({
    lineup: { official: value?.lineup?.official === true },
    bullpen: { status: value?.bullpen?.status || null },
  });
  return {
    leagueId: context.leagueId || context?.game?.leagueId || null,
    analysisMode: context.analysisMode || null,
    fetchedAt: context.fetchedAt || null,
    game: {
      leagueId: context?.game?.leagueId || context.leagueId || null,
      gamePk: context?.game?.gamePk || null,
      gameDate: context?.game?.gameDate || null,
    },
    away: side(context.away),
    home: side(context.home),
    umpire: { status: context?.umpire?.status || null },
    weather: {
      roof: context?.weather?.roof || null,
      roofConfirmed: context?.weather?.roofConfirmed === true,
    },
    park: { roof: context?.park?.roof || null },
    featureProvenance: Array.isArray(context.featureProvenance) ? context.featureProvenance : [],
    sourceStatuses: context.sourceStatuses || {},
    warnings: Array.isArray(context.warnings) ? context.warnings : [],
  };
}

export function compactRepriceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const { distributionSnapshot: omittedDistribution, ...compact } = snapshot;
  return compact;
}

export function resolveRepriceDistribution(snapshot, buildDistribution) {
  const existing = snapshot?.distributionSnapshot;
  const distributionSnapshot = existing || buildDistribution({ context: snapshot?.frozenContext });
  const matches = Boolean(
    distributionSnapshot?.distributionId
    && distributionSnapshot.distributionId === snapshot?.distributionId
    && distributionSnapshot?.distributionHash
    && distributionSnapshot.distributionHash === snapshot?.distributionHash
  );
  return { distributionSnapshot, rebuilt: !existing, matches };
}

export function initialAnalysisConcurrency(league) {
  void league;
  return 1;
}
