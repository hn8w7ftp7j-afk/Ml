export const ANALYSIS_TRANSPORT_VERSION = 'BASEBALL-ANALYSIS-TRANSPORT-v1.1.0-MOBILE-RESUME';

export function compactAnalysisContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return context;
  const side = value => ({
    starter: value?.starter ? {
      id: value.starter.id || value.starter.officialPlayerId || null,
      teamId: value.starter.teamId || null,
      name: value.starter.name || null,
      assignmentStatus: value.starter.assignmentStatus || null,
      identitySource: value.starter.identitySource || value.starter.source || null,
    } : null,
    lineup: { official: value?.lineup?.official === true, projected: value?.lineup?.projected === true, status: value?.lineup?.status || null },
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
  // Drop raw bodies only after durable storage acknowledged them. Inline fallback
  // is still the only copy available to a later signed price-only request.
  if (compact.frozenContext?.sourceEvidence?.contentStorage === 'IMMUTABLE_SOURCE_STORE_V1') {
    const evidence = compact.frozenContext.sourceEvidence;
    compact.frozenContext = { ...compact.frozenContext, sourceEvidence: { ...evidence,
      contents: {}, contentHashes: [...new Set([...(evidence.contentHashes || []), ...Object.keys(evidence.contents || {})])],
      contentStorage: 'IMMUTABLE_SOURCE_STORE_V1',
    } };
  }
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
  return String(league || '').trim().toUpperCase() === 'MLB' ? 2 : 1;
}
