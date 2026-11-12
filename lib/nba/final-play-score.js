// ESPN's structured terminal events carry cumulative scores. Keep this evidence
// separate from the summary header until the official settlement checks agree.
const endPeriod = '412';
const endGame = '402';
const zeroClock = /^(?:0{1,2}:)?0{1,2}(?:\.0{1,3})?$/;

export function nbaFinalPlayScore(game, plays) {
  if (game?.status !== 'final' || game.completed !== true || !Array.isArray(plays)
    || typeof game.sourceId !== 'string' || !/^[1-9]\d*$/.test(game.sourceId)
    || game.id !== `nba:espn:game:${game.sourceId}`) return null;

  const away = { score: 0, periodScores: [] };
  const home = { score: 0, periodScores: [] };
  const periodEndPlayIds = [];
  for (const [index, play] of plays.entries()) {
    const type = play?.type?.id;
    const label = play?.type?.text;
    if (type !== endPeriod && type !== endGame && label !== 'End Period' && label !== 'End Game') continue;
    const period = play.period?.number;
    if (typeof play.id !== 'string' || !/^\d+$/.test(play.id) || !play.id.startsWith(game.sourceId)
      || play.id.length === game.sourceId.length || periodEndPlayIds.includes(play.id)
      || play.scoringPlay !== false || !zeroClock.test(play.clock?.displayValue || '')
      || !Number.isSafeInteger(play.awayScore) || !Number.isSafeInteger(play.homeScore)) return null;

    if (type === endGame && label === 'End Game') {
      if (index !== plays.length - 1 || period < 4 || period !== periodEndPlayIds.length
        || play.awayScore !== away.score || play.homeScore !== home.score || away.score === home.score) return null;
      return { gameId: game.id, away, home, periodEndPlayIds, endGamePlayId: play.id };
    }

    if (type !== endPeriod || label !== 'End Period' || period !== periodEndPlayIds.length + 1
      || play.awayScore < away.score || play.homeScore < home.score
      || (period > 4 && away.score !== home.score)) return null;
    away.periodScores.push({ period, score: play.awayScore - away.score });
    home.periodScores.push({ period, score: play.homeScore - home.score });
    away.score = play.awayScore;
    home.score = play.homeScore;
    periodEndPlayIds.push(play.id);
  }
  return null;
}
