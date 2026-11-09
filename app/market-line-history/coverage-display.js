const SOURCE_STATUSES = ['AVAILABLE', 'NOT_CAPTURED', 'INVALID', 'LOCKED', 'PERIOD_UNKNOWN'];
const INTERPRETATION_VERSION = 'SOCCER-HISTORY-PERIOD-INTERPRETATION-v1';

// Read-time interpretation is separate from the immutable capture state. A
// malformed interpretation must never make an unverified market look saved.
export function validateCoverageDisplay(games) {
  for (const row of games || []) {
    if (row.relatedIdentityCandidates != null) {
      const parts = String(row.gameKey).split('|');
      if (row.league !== 'NBA' || !Array.isArray(row.relatedIdentityCandidates) || row.relatedIdentityCandidates.length > 10
        || typeof row.relatedIdentityCandidatesTruncated !== 'boolean'
        || new Set(row.relatedIdentityCandidates.map(item => item?.gameKey)).size !== row.relatedIdentityCandidates.length
        || row.relatedIdentityCandidates.some(item => item?.status !== 'NOT_VERIFIED'
          || item.basis !== 'SAME_BOARD_DATE_AND_ORDERED_TEAM_CODES' || item.gameKey === row.gameKey
          || !/^(?:[01]\d|2[0-3]):[0-5]\d\|[A-Z0-9]+\|[A-Z0-9]+$/.test(item.gameKey || '')
          || item.gameKey.split('|')[1] !== parts[1] || item.gameKey.split('|')[2] !== parts[2])) {
        throw new Error('盤面識別的交叉查詢資料不完整，未合併為同一場賽事。');
      }
    }
    if (row.retainedMarkets != null) {
      if (!['MLB', 'NPB', 'KBO', 'CPBL', 'NBA'].includes(row.league)
        || row.retainedHistoryComplete !== false || row.retainedLookupBasis !== 'LATEST_STATE_AND_PER_MARKET_RECEIPT_REFERENCES'
        || !Array.isArray(row.retainedMarkets) || row.retainedMarkets.length !== 4
        || row.retainedMarkets.some((market, index) => {
          if (market?.market !== row.markets?.[index]?.market || !['AVAILABLE', 'NOT_VERIFIED'].includes(market.status)) return true;
          if (market.status === 'NOT_VERIFIED') return market.lastObservedAt !== null || market.evidence != null;
          const proof = market.evidence;
          return !Number.isFinite(Date.parse(market.lastObservedAt || '')) || proof?.observedAt !== market.lastObservedAt
            || proof.gameKey !== row.gameKey || proof.sourceTable !== 'tai888_market_line_history_v1'
            || !/^[a-f0-9]{16}$/.test(proof.stateHash || '') || !Array.isArray(proof.directions) || proof.directions.length !== 2
            || proof.directions.some(direction => typeof direction.pick !== 'string' || typeof direction.water !== 'number' || !Number.isFinite(direction.water));
        })) throw new Error('歷來保存市場的來源證據不完整，未當成已確認盤口。');
    }
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
