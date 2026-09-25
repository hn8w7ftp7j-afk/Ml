import { sameAnalysisGame } from './analysis-game-identity-v1.js';
import { analysisHasCalculatedDirections } from './analysis-display-state-v116.js';

// Status is display-only: never create prices, signed contracts or scores here.
export function readerWaitingDisplay(item, authority, now = Date.now()) {
  const activityTime = Date.parse(authority?.pageActivityAt || '');
  if (!authority?.fresh || !authority.payloadHash
    || !Number.isFinite(activityTime) || activityTime > now || now - activityTime > 180_000
    || authority.boardDate !== authority.expectedBoardDate
    || authority.league !== (item?.game?.leagueId || item?.game?.league)
    || !['unopened', 'waiting'].includes(item?.status)
    || analysisHasCalculatedDirections(item?.customData)
    || !(Date.parse(item?.game?.gameDate) > now)) return null;
  const row = authority.gameAvailability?.find(value => sameAnalysisGame(item.game, value.game)
    && value.game?.gameDate === item.game.gameDate);
  if (!row) return null;
  const sourceTime = Date.parse(authority.observedAt || '');
  const previousTime = Date.parse(item.latestReaderSource?.observedAt || item.actualSource?.observedAt || '');
  if (!Number.isFinite(sourceTime) || (Number.isFinite(previousTime) && sourceTime < previousTime)) return null;
  const count = Number(row.marketCoverage?.openMarkets);
  if (!Number.isInteger(count) || count < 0 || count > 4) return null;
  const open = count > 0;
  return {
    open,
    coverage: row.marketCoverage,
    observedAt: authority.observedAt,
    label: open ? 'Tai888 Reader 已收到盤口（尚未分析）'
      : row.unavailableReason === 'reader-identity-unresolved' ? 'Reader 場次待核對'
      : row.unavailableReason === 'not-rendered-by-reader' ? 'Tai888 Reader 未呈現盤口' : 'Tai888 目前鎖盤',
    message: open ? `Reader已收到 ${count}/4 市場｜請按「分析此場」`
      : row.unavailableReason === 'reader-identity-unresolved' ? '場次待核對｜暫停使用此場盤口'
      : row.unavailableReason === 'not-rendered-by-reader' ? 'Reader目前未呈現盤口｜持續自動監看' : 'Tai888目前鎖盤｜持續自動監看',
  };
}
