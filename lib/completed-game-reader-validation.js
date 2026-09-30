import { sameAnalysisGame } from './analysis-game-identity-v1.js';
import { advanceUnchangedReaderGame, gameIsPrestartNow, readerPitMatchesGameRevision } from './client-analysis-state.js';

// A completed game can be verified independently of the rest of its job.
// Progress alone never grants authority: use the current signed credit response.
export function validateCompletedGamesWithReader(board, credit, scope, now = Date.now()) {
  if (credit?.league !== scope.league || credit?.boardDate !== scope.date
    || credit?.provider !== 'TAI888_READER_AUTO' || credit?.blocked === true
    || credit?.readerFresh !== true || !credit?.payloadHash) return board;
  const liveByPk = new Map((credit.games || []).map(row => [Number(row.gamePk), row]));
  return board.map(item => {
    if (item?.status !== 'done' || item?.analysisFailure
      || item?.customData?.pitPersistence?.confirmed !== true
      || !gameIsPrestartNow(item.game, now)) return item;
    const live = liveByPk.get(Number(item.game.gamePk));
    if (!live?.game || !sameAnalysisGame(item.game, live.game)
      || live?.readerProvenance?.boardDate !== scope.date
      || live?.readerProvenance?.payloadHash !== credit.payloadHash
      || !readerPitMatchesGameRevision(item, live?.readerProvenance?.readerGameMarketHash)) return item;
    return advanceUnchangedReaderGame(item, live.markets, credit.payloadHash, credit.pageActivityAt, now, {
      actualSource: live.source, marketCoverage: live.marketCoverage, readerProvenance: live.readerProvenance,
    }) || item;
  });
}
