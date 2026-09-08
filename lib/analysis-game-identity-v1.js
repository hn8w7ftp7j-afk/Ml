// Analysis display identity follows the frozen input, not a later schedule or
// Reader task. This helper does not grant execution authority or change prices.
export function sameAnalysisGame(left, right) {
  if (!left?.gamePk || !right?.gamePk || String(left.gamePk) !== String(right.gamePk)) return false;
  for (const key of ['awayTeamId', 'homeTeamId', 'gameNumber']) {
    if (left[key] != null && right[key] != null && String(left[key]) !== String(right[key])) return false;
  }
  const leftLeague = left.leagueId || left.league;
  const rightLeague = right.leagueId || right.league;
  return !leftLeague || !rightLeague || leftLeague === rightLeague;
}

export function analysisGameIdentity(fallback, frozenGame) {
  if (!frozenGame?.gamePk) return fallback;
  if (fallback?.gamePk && !sameAnalysisGame(fallback, frozenGame)) {
    throw new Error('ANALYSIS_GAME_IDENTITY_MISMATCH');
  }
  // Missing or explicit null starter names cannot borrow a newer schedule's
  // identity. Legacy snapshots stay unknown until a new analysis supplies it.
  return { ...fallback, ...frozenGame,
    awayProbable: frozenGame.awayProbable ?? null,
    homeProbable: frozenGame.homeProbable ?? null,
  };
}

export function analysisDisplayGame(item) {
  const data = item?.customData?.analysis ? item.customData : item?.referenceData;
  const savedGame = data?.game;
  if (!savedGame?.gamePk || !sameAnalysisGame(item?.game, savedGame)) return item?.game;
  return analysisGameIdentity(item.game, savedGame);
}
