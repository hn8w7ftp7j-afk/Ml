export const ANALYSIS_TRANSPORT_VERSION = 'BASEBALL-ANALYSIS-TRANSPORT-v1.0.0';

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
  return String(league || '').toUpperCase() === 'MLB' ? 2 : 1;
}
