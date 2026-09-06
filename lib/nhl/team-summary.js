// Official NHL season totals. Never a point-in-time pregame feature source.
export function validNhlTeamSummaryScope(teamId, season, gameType) {
  return Number.isSafeInteger(teamId) && teamId > 0 && Number.isSafeInteger(season)
    && /^\d{8}$/.test(String(season)) && Math.floor(season / 10000) >= 1917
    && season % 10000 === Math.floor(season / 10000) + 1 && [1, 2, 3].includes(gameType);
}
export function nhlTeamSummaryUrl(teamId, season, gameType) {
  if (!validNhlTeamSummaryScope(teamId, season, gameType)) throw new Error('NHL_TEAM_SUMMARY_SCOPE_INVALID');
  const params = new URLSearchParams({ isAggregate: 'false', isGame: 'false', start: '0', limit: '2',
    cayenneExp: `seasonId=${season} and gameTypeId=${gameType} and teamId=${teamId}` });
  return `https://api.nhle.com/stats/rest/en/team/summary?${params}`;
}
export function normalizeNhlTeamSummary(raw, { teamId, season, gameType }, source) {
  const issues = [];
  const block = () => ({ ok: false, status: 'BLOCK', code: 'NHL_TEAM_SUMMARY_INVALID', issues, source, league: 'NHL' });
  if (!validNhlTeamSummaryScope(teamId, season, gameType)) { issues.push('NHL_TEAM_SUMMARY_SCOPE_INVALID'); return block(); }
  // This report omits gameTypeId in its rows: bind its phase to the exact
  // official query, not to a guessed field or a default regular-season label.
  try {
    const actual = new URL(source?.url); const expected = new URL(nhlTeamSummaryUrl(teamId, season, gameType));
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.hash || actual.username || actual.password
      || [...actual.searchParams].length !== [...expected.searchParams].length
      || [...expected.searchParams].some(([key, value]) => actual.searchParams.getAll(key).length !== 1 || actual.searchParams.get(key) !== value)) issues.push('NHL_TEAM_SUMMARY_SOURCE_CONFLICT');
  } catch { issues.push('NHL_TEAM_SUMMARY_SOURCE_CONFLICT'); }
  if (!Array.isArray(raw?.data) || !Number.isSafeInteger(raw.total) || raw.total !== raw.data.length || raw.total > 1 || raw.total < 0) issues.push('NHL_TEAM_SUMMARY_CARDINALITY_INVALID');
  if (issues.length) return block();
  const scope = { league: 'NHL', teamId, season, gameType, seasonPhase: ['PRESEASON_SHADOW', 'REGULAR', 'PLAYOFFS'][gameType - 1],
    source, observedAt: source?.fetchedAt || null, pregamePointInTimeVerified: false,
    metricScope: 'OFFICIAL_SEASON_TOTALS_OBSERVED_AT_FETCH', ratioUnit: 'FRACTION', fiveOnFive: null, xGF: null, xGA: null };
  if (!raw.data.length) return { ...scope, ok: true, status: 'EMPTY', statistics: null, issues: ['NHL_TEAM_SUMMARY_NO_OFFICIAL_ROWS'] };
  const row = raw.data[0];
  if (!row || row.teamId !== teamId || row.seasonId !== season || (row.gameTypeId != null && row.gameTypeId !== gameType)) issues.push('NHL_TEAM_SUMMARY_IDENTITY_CONFLICT');
  if (!row || !Number.isSafeInteger(row.gamesPlayed) || row.gamesPlayed < 0) issues.push('NHL_TEAM_SUMMARY_GAMES_INVALID');
  if (issues.length) return block();
  const statistics = {};
  const counts = ['gamesPlayed', 'wins', 'losses', 'otLosses', 'ties', 'points', 'goalsFor', 'goalsAgainst', 'winsInRegulation', 'regulationAndOtWins', 'winsInShootout', 'teamShutouts'];
  const rates = ['goalsForPerGame', 'goalsAgainstPerGame', 'shotsForPerGame', 'shotsAgainstPerGame'];
  const fractions = ['faceoffWinPct', 'pointPct', 'powerPlayPct', 'penaltyKillPct'];
  for (const key of [...counts, ...rates, ...fractions]) {
    const value = row[key];
    if (value == null) { statistics[key] = null; continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || (counts.includes(key) && !Number.isSafeInteger(value)) || (fractions.includes(key) && value > 1)) issues.push(`NHL_TEAM_SUMMARY_METRIC_INVALID:${key}`);
    statistics[key] = value;
  }
  if (season >= 20052006 && gameType === 2 && ['wins', 'losses', 'otLosses'].every(key => statistics[key] != null)
    && statistics.wins + statistics.losses + statistics.otLosses !== statistics.gamesPlayed) issues.push('NHL_TEAM_SUMMARY_RECORD_CONFLICT');
  if (issues.length) return block();
  const missing = [...rates, ...fractions].filter(key => statistics[key] == null);
  // Do not derive shot counts or goalie save percentage from rounded team rates:
  // empty-net goals and shootout accounting need independent evidence.
  return { ...scope, ok: true, status: missing.length ? 'WARNING' : 'OK', name: typeof row.teamFullName === 'string' ? row.teamFullName : null,
    statistics, issues: missing.map(key => `NHL_TEAM_SUMMARY_METRIC_MISSING:${key}`) };
}
