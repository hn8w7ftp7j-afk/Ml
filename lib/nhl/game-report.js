// Official game-specific facts only. Series totals and other games in this
// endpoint are deliberately not imported: they can include future outcomes.
export function normalizeNhlGameReport(raw, game, source) {
  const errors = [];
  const integer = x => Number.isSafeInteger(x) && x >= 0;
  const matches = Array.isArray(raw?.seasonSeries) ? raw.seasonSeries.filter(row => String(row.id) === game.gameId) : [];
  if (matches.length !== 1 || matches[0].awayTeam?.id !== game.awayTeamId || matches[0].homeTeam?.id !== game.homeTeamId
    || matches[0].season !== game.season || matches[0].gameType !== game.gameType || matches[0].startTimeUTC !== game.startTimeUTC)
    errors.push('NHL_REPORT_GAME_IDENTITY_CONFLICT');
  if (source?.url !== `https://api-web.nhle.com/v1/gamecenter/${game.gameId}/right-rail`) errors.push('NHL_REPORT_SOURCE_IDENTITY_CONFLICT');
  const categories = new Map();
  if (!Array.isArray(raw?.teamGameStats)) errors.push('NHL_REPORT_STATISTICS_MISSING');
  for (const row of Array.isArray(raw?.teamGameStats) ? raw.teamGameStats : []) {
    if (!row || typeof row.category !== 'string') { errors.push('NHL_REPORT_STATISTICS_INVALID'); continue; }
    if (categories.has(row.category)) errors.push('NHL_REPORT_DUPLICATE_CATEGORY');
    categories.set(row.category, row);
  }
  const sides = {};
  const seenPlayers = new Set();
  for (const side of ['away', 'home']) {
    const value = categories.get('powerPlay')?.[`${side}Value`];
    const match = typeof value === 'string' ? /^(\d+)\/(\d+)$/.exec(value) : null;
    const goals = match ? Number(match[1]) : null; const opportunities = match ? Number(match[2]) : null;
    if (!integer(goals) || !integer(opportunities) || goals > opportunities) errors.push('NHL_REPORT_POWER_PLAY_INVALID');
    const scratches = raw?.gameInfo?.[`${side}Team`]?.scratches;
    if (scratches != null && !Array.isArray(scratches)) errors.push('NHL_REPORT_SCRATCHES_INVALID');
    const activeIds = new Set(['skaters', 'goalies'].flatMap(group => game.playerStatistics?.[side]?.[group]?.map(row => row.playerId) || []));
    const players = (Array.isArray(scratches) ? scratches : []).map(value => {
      const row = value || {};
      if (!integer(row.id) || row.id === 0 || seenPlayers.has(row.id) || activeIds.has(row.id)) errors.push('NHL_REPORT_PLAYER_IDENTITY_CONFLICT');
      seenPlayers.add(row.id);
      return { playerId: row.id, teamId: game[`${side}TeamId`], name: [row.firstName?.default, row.lastName?.default].filter(Boolean).join(' ') || null,
        status: 'OFFICIAL_GAME_SCRATCH', injuryReason: null, sourcePublishedAt: null, observedAt: source?.fetchedAt || null };
    });
    sides[side] = { teamId: game[`${side}TeamId`], powerPlayGoals: goals, powerPlayOpportunities: opportunities,
      powerPlayPercent: opportunities > 0 ? goals / opportunities : null,
      scratches: Array.isArray(scratches) ? players : null };
  }
  if (errors.length) return { ok: false, status: 'BLOCK', issues: [...new Set(errors)], source };
  for (const side of ['away', 'home']) {
    const opponent = sides[side === 'away' ? 'home' : 'away'];
    sides[side].timesShorthanded = opponent.powerPlayOpportunities;
    sides[side].powerPlayGoalsAgainst = opponent.powerPlayGoals;
    sides[side].penaltyKillPercent = opponent.powerPlayOpportunities > 0 ? 1 - opponent.powerPlayGoals / opponent.powerPlayOpportunities : null;
  }
  return { ok: true, status: 'OK', league: 'NHL', gameId: game.gameId, ...sides, source,
    pregamePointInTimeVerified: false, scope: 'OFFICIAL_GAME_REPORT_OBSERVED_AT_FETCH',
    issues: ['NHL_SCRATCH_IS_NOT_AN_INJURY_DIAGNOSIS_OR_PREGAME_CONFIRMATION'] };
}
