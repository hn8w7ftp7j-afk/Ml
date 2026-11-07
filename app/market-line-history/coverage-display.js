const SOURCE_STATUSES = ['AVAILABLE', 'NOT_CAPTURED', 'INVALID', 'LOCKED', 'PERIOD_UNKNOWN'];
const INTERPRETATION_VERSION = 'SOCCER-HISTORY-PERIOD-INTERPRETATION-v1';

// Read-time interpretation is separate from the immutable capture state. A
// malformed interpretation must never make an unverified market look saved.
export function validateCoverageDisplay(games) {
  for (const row of games || []) {
    if (row.displayMarkets == null) continue;
    if (!['EPL', 'UCL'].includes(row.league) || row.integrity?.status === 'FAIL' || !Array.isArray(row.markets) || row.markets.length !== 4
      || !Array.isArray(row.displayMarkets) || row.displayMarkets.length !== 4
      || row.displayMarkets.some((market, index) => {
        const original = row.markets[index];
        if (market?.market !== original?.market) return true;
        if (market.status !== 'RETROSPECTIVE_INTERPRETATION') return !SOURCE_STATUSES.includes(market.status)
          || market.status !== original.status || market.lastObservedAt !== original.lastObservedAt;
        const proof = market.historyPeriodInterpretation;
        return index > 1 || !['NOT_CAPTURED', 'PERIOD_UNKNOWN'].includes(original.status)
          || market.originalStatus !== original.status || market.originalPeriod !== 'UNKNOWN' || market.displayPeriod !== 'FT'
          || !Number.isFinite(Date.parse(market.lastObservedAt || ''))
          || proof?.version !== INTERPRETATION_VERSION || proof.status !== 'RETROSPECTIVE_INTERPRETATION'
          || proof.basis !== 'SAME_OBSERVATION_PRIMARY_AND_EXPLICIT_HT'
          || !Number.isFinite(Date.parse(proof.interpretedAt || ''))
          || Date.parse(proof.interpretedAt) < Date.parse(market.lastObservedAt)
          || !/^[a-f0-9]{64}$/.test(proof.observationId || '')
          || proof.historicalAvailabilityVerified !== false || proof.executable !== false;
      })) throw new Error('保存狀態的查閱時辨識資料不完整，未當成已確認盤口。');
  }
  return games;
}

export function coverageMarketsForDisplay(row) {
  return row.latestCaptureMarkets || row.displayMarkets || row.markets || [];
}
