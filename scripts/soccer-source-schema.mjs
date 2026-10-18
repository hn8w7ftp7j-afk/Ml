// Bounded provider schema inspection; emits public football data only.
for (const league of ['eng.1', 'uefa.champions']) {
  const response = await fetch(`https://site.api.espn.com/apis/v2/sports/soccer/${league}/standings`, { signal: AbortSignal.timeout(10_000) });
  const d = await response.json();
  console.log('SOCCER_TABLE_SCHEMA', JSON.stringify({ league, status: response.status,
    keys: Object.keys(d), id: d.id, uid: d.uid, name: d.name, displayName: d.displayName,
    abbreviation: d.abbreviation, season: d.season, leagues: d.leagues,
    children: d.children?.map(c => ({ keys: Object.keys(c), id: c.id, uid: c.uid, name: c.name,
      abbreviation: c.abbreviation, standingsKeys: c.standings && Object.keys(c.standings),
      entryCount: c.standings?.entries?.length, first: c.standings?.entries?.[0] })) }));
}
