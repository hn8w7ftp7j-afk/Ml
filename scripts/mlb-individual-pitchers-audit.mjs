const url = new URL('https://statsapi.mlb.com/api/v1/stats');
for (const [key,value] of Object.entries({ stats: 'byDateRange', group: 'pitching', teamId: '138', playerPool: 'ALL', season: '2026', sportIds: '1', startDate: '2026-03-01', endDate: '2026-08-20', limit: '100' })) url.searchParams.set(key,value);
const response = await fetch(url, { headers: { 'User-Agent': 'Baseball-Positive-EV-Audit' } });
const data = await response.json();
const splits = data?.stats?.[0]?.splits || [];
console.log(JSON.stringify({ status: response.status, url: String(url), splitCount: splits.length, rows: splits.slice(0,40).map(row => ({ playerId: row?.player?.id, player: row?.player?.fullName, position: row?.position?.abbreviation, teamId: row?.team?.id, gamesPitched: row?.stat?.gamesPitched, gamesStarted: row?.stat?.gamesStarted, inningsPitched: row?.stat?.inningsPitched, earnedRuns: row?.stat?.earnedRuns, era: row?.stat?.era })) }, null, 2));
