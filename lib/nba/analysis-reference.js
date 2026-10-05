import { validDate } from './identity.js';
// A descriptive cross-season baseline, separate from the calibrated model.
// No current score, market direction, probability or cash valuation is inferred.
export function nbaPreseasonReference(game, history) {
  if (game?.league !== 'NBA' || game.seasonType !== 'preseason' || !Number.isInteger(game.season?.year)
    || !/^nba:espn:team:\d+$/.test(game.home?.id || '') || !/^nba:espn:team:\d+$/.test(game.away?.id || '')
    || game.home.id === game.away.id || !validDate(game.taipeiDate) || !Array.isArray(history)) return null;
  const year = game.season.year - 1;
  const rows = history.filter(row => row.year === year && row.seasonType === 'regular' && row.date < game.taipeiDate);
  const ids = new Set();
  if (!rows.length) return null;
  for (const row of rows) {
    if (!row.gameId || ids.has(row.gameId) || !validDate(row.date)
      || ![row.homeId, row.awayId].every(id => /^nba:espn:team:\d+$/.test(id || ''))
      || ![row.homeScore, row.awayScore].every(value => Number.isInteger(value) && value >= 0)
      || row.homeId === row.awayId) return null;
    ids.add(row.gameId);
  }
  const stats = id => {
    const selected = rows.filter(row => row.homeId === id || row.awayId === id);
    if (selected.length < 20) return null;
    const sum = key => selected.reduce((total, row) => total + (row.homeId === id ? row[key === 'for' ? 'homeScore' : 'awayScore'] : row[key === 'for' ? 'awayScore' : 'homeScore']), 0) / selected.length;
    return { games: selected.length, pointsFor: sum('for'), pointsAgainst: sum('against') };
  };
  const home = stats(game.home.id), away = stats(game.away.id);
  if (!home || !away) return null;
  const homePoints = (home.pointsFor + away.pointsAgainst) / 2;
  const awayPoints = (away.pointsFor + home.pointsAgainst) / 2;
  return { modelVersion: 'nba-prior-regular-reference-v1', sourceSeasonYear: year,
    sourceSeasonType: 'regular', sourceGames: rows.length, through: rows.map(row => row.date).sort().at(-1),
    home, away, homePoints, awayPoints, total: homePoints + awayPoints,
    calibrated: false, probabilityEstimate: null, expectedNet: null, direction: null,
    method: 'mean_team_points_for_and_opponent_points_against',
    limitations: ['跨季例行賽基準，尚未驗證季前賽準確度', '未納入本季人員異動、傷停、季前賽輪換與上場時間'] };
}
