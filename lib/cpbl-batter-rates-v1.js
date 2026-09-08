// Read the official server-rendered page as data, never execute its scripts.
export function decodeCpblPage(raw) {
  if (typeof raw !== 'string' || raw.length > 8 * 1024 * 1024) return {};
  const chunks = [];
  for (const match of raw.matchAll(/self\.__next_f\.push\((.*?)\)<\/script>/gs)) {
    try { const part = JSON.parse(match[1]); if (part[0] === 1 && typeof part[1] === 'string') chunks.push(part[1]); } catch { /* Ignore non-data scripts. */ }
  }
  const records = {};
  for (const line of chunks.join('').split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    try { records[line.slice(0, colon)] = JSON.parse(line.slice(colon + 1)); } catch { /* Flight references are not JSON. */ }
  }
  return { records };
}

export function cpblRatesEligible(game, at) {
  const time = Date.parse(at || '');
  return Number.isFinite(time) && time < Date.parse(game?.gameDate || '')
    && new Date(time + 8 * 3600_000).toISOString().slice(0, 10) === game?.officialDate;
}

export function parseCpblBatterRates(raw, year) {
  const matches = [];
  function walk(value, path) {
    if (!value || typeof value !== 'object') return;
    const key = value.queryKey;
    if (Array.isArray(key) && key[0] === 'season-pr-table' && key[1]?.year === Number(year)
      && key[1]?.searchType === 'batter' && key[1]?.gameKind === 'A'
      && value.state?.status === 'success' && Array.isArray(value.state.data)) {
      matches.push({ rows: value.state.data, path: [...path, 'state', 'data'], providerUpdatedAt: value.state.dataUpdatedAt });
    }
    for (const [name, item] of Object.entries(value)) walk(item, [...path, name]);
  }
  walk(decodeCpblPage(raw), []);
  if (matches.length !== 1) return null;
  const source = matches[0];
  const rows = source.rows.filter(row => /^\d{10}$/.test(row?.player?.acnt || '')
    && typeof row?.team?.code === 'string' && Number.isSafeInteger(row.pa) && row.pa > 0
    && typeof row.ba === 'number' && row.ba >= 0 && row.ba <= 1);
  return { ...source, rows };
}

export function matchCpblBatterRates(table, player, teamCode) {
  const id = String(player?.officialPlayerId || player?.id || '');
  const rows = (table?.rows || []).filter(row => row.player.acnt === id && row.team.code === teamCode);
  if (rows.length !== 1) return null;
  const row = rows[0];
  const rate = (value, maximum) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
  return { officialPlayerId: id, teamCode, plateAppearances: row.pa, battingAverage: row.ba,
    onBasePercentage: rate(row.obp, 1), sluggingPercentage: rate(row.slg, 4), woba: rate(row.woba, 3),
    atBats: null, hits: null, statisticalCutoff: null,
    source: 'CPBL_OFFICIAL_SEASON_PR_TABLE_SERVER_RENDERED',
    scope: 'CURRENT_SEASON_FIRST_TEAM_REGULAR',
    usedInMean: false, usedInUncertainty: false,
    reason: 'OBSERVED_RATES_ONLY;POOLED_HITS_AND_AT_BATS_NOT_SUPPLIED;NO_PA_AS_AB_SUBSTITUTION' };
}
