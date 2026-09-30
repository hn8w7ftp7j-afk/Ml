// Configuration checks are not evidence that a complete Production flow works.
// This report is deliberately descriptive; it never changes execution gates.
export function operationalReadiness({ configuredReady, formalScoringEnabled, leagues = [] } = {}) {
  return {
    ready: false,
    status: 'NOT_VERIFIED',
    basis: 'LIVE_END_TO_END_EVIDENCE_REQUIRED',
    configurationReady: configuredReady === true,
    checks: {
      ledgerReadback: { status: 'NOT_VERIFIED', reason: 'LIVE_READBACK_AND_LATENCY_NOT_PROBED' },
      snapshotIntegrity: { status: 'NOT_VERIFIED', reason: 'VALIDATED_PER_SNAPSHOT_NOT_BY_CONFIGURATION' },
      settlementBacklog: { status: 'NOT_VERIFIED', reason: 'LIVE_BACKLOG_AND_CRON_RESULTS_NOT_PROBED' },
      referenceTransport: { status: 'NOT_VERIFIED', reason: 'PROVIDER_CONFIGURATION_IS_NOT_LIVE_TRANSPORT_HEALTH' },
      formalModelRelease: {
        status: formalScoringEnabled === true ? 'NOT_VERIFIED' : 'BLOCK',
        reason: formalScoringEnabled === true ? 'RELEASE_EVIDENCE_NOT_PROBED' : 'FORMAL_SCORING_DISABLED',
      },
    },
    settlementCapabilities: leagues.map(league => ({
      league: league.id,
      verificationStatus: 'NOT_VERIFIED',
      declaredFullGameReady: league.analysisReadiness?.fullGameAutoSettlementReady ?? null,
      declaredFirst5Ready: league.analysisReadiness?.first5ResultFeedAvailable ?? null,
      declaredBlockers: (league.analysisReadiness?.settlementBlockers || []).map(row => row.code),
    })),
  };
}
