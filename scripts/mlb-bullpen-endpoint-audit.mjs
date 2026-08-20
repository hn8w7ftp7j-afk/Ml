const base = 'https://statsapi.mlb.com/api/v1/teams/138/stats';
for (const query of [
  { label: 'team', params: { stats: 'byDateRange', group: 'pitching', season: '2026', sportIds: '1', startDate: '2026-03-01', endDate: '2026-08-20' } },
  { label: 'sit-rp', params: { stats: 'byDateRange', group: 'pitching', season: '2026', sportIds: '1', startDate: '2026-03-01', endDate: '2026-08-20', sitCodes: 'rp' } },
  { label: 'position-rp', params: { stats: 'byDateRange', group: 'pitching', season: '2026', sportIds: '1', startDate: '2026-03-01', endDate: '2026-08-20', position: 'RP' } },
]) {
  const url = new URL(base);
  for (const [key,value] of Object.entries(query.params)) url.searchParams.set(key,value);
  const response = await fetch(url, { headers: { 'User-Agent': 'Baseball-Positive-EV-Audit' } });
  const data = await response.json();
  const stat = data?.stats?.[0]?.splits?.[0]?.stat || null;
  console.log(JSON.stringify({ label: query.label, status: response.status, url: String(url), stat: stat && { gamesPitched: stat.gamesPitched, gamesStarted: stat.gamesStarted, inningsPitched: stat.inningsPitched, earnedRuns: stat.earnedRuns, hits: stat.hits, baseOnBalls: stat.baseOnBalls, strikeOuts: stat.strikeOuts, homeRuns: stat.homeRuns, era: stat.era, whip: stat.whip } }, null, 2));
}
