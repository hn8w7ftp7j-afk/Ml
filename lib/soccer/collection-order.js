// Keep each game in the prospective collection queue. Untouched games go
// first; retries rotate by their last attempt before kickoff breaks ties.
// Sorting retries by kickoff first would let an early unavailable source
// consume every later batch, even after its retry lease has expired.
export function orderSoccerCollectionGames(games, lastAttempt = new Map()) {
  const attemptedAt = game => {
    const value = lastAttempt.get(game.id);
    return Number.isFinite(value) ? value : null;
  };
  return [...games].sort((left, right) => {
    const a = attemptedAt(left), b = attemptedAt(right);
    if (a === null && b !== null) return -1;
    if (a !== null && b === null) return 1;
    return (a === null ? 0 : a - b)
      || Date.parse(left.startTime) - Date.parse(right.startTime)
      || left.id.localeCompare(right.id);
  });
}
