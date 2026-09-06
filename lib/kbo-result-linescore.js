// KBO's JSON tables may be nested or JSON-encoded inside the boxscore payload.
// Select only a two-team inning table, never a hitter's inning-by-inning row.
const text = value => String(value?.Text ?? value ?? '').replace(/<[^>]*>/g, '').trim();
const cells = row => (Array.isArray(row?.row) ? row.row : []).map(text);

export function parseKboResultLinescore(payload, game) {
  if (game?.statusCode !== 'F') return game;
  const tables = [];
  function visit(value, depth = 0) {
    if (depth > 12 || value == null) return;
    if (typeof value === 'string') {
      if (/^[\[{]/.test(value.trim())) {
        try { visit(JSON.parse(value), depth + 1); } catch { /* not a JSON table */ }
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value.rows)) tables.push(value);
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  visit(payload);
  const matches = [];
  for (const table of tables) {
    if (table.rows.length !== 2) continue;
    const headers = (Array.isArray(table.headers) ? table.headers : []).flatMap(cells);
    if (headers.length < 9 || !headers.every((value, index) => value === String(index + 1))) continue;
    const rows = table.rows.map(cells);
    if (rows.some(row => row.length !== headers.length)) continue;
    const played = rows.map(row => {
      const end = row.findIndex(value => value === '-' || value === '');
      if (end >= 0 && row.slice(end).some(value => value !== '-' && value !== '')) return null;
      const values = end < 0 ? row : row.slice(0, end);
      if (values.some(value => !/^\d+(?:X)?$|^X$/i.test(value))) return null;
      return values.map(value => /^X$/i.test(value) ? 0 : Number(value.replace(/X$/i, '')));
    });
    if (played.some(row => !row || row.length < 5)) continue;
    const [away, home] = played;
    const innings = Math.max(away.length, home.length);
    if (innings < 9 || away.length !== innings || home.length < innings - 1) continue;
    if (away.reduce((a, b) => a + b, 0) !== game.awayScore
      || home.reduce((a, b) => a + b, 0) !== game.homeScore) continue;
    matches.push({ innings, awayFirst5: away.slice(0, 5).reduce((a, b) => a + b, 0),
      homeFirst5: home.slice(0, 5).reduce((a, b) => a + b, 0) });
  }
  const distinct = [...new Map(matches.map(row => [JSON.stringify(row), row])).values()];
  if (distinct.length !== 1) {
    console.warn('[KBO_RESULT_TABLE_UNVERIFIED]', {
      gameId: game.providerGameId,
      keys: Object.keys(payload || {}).slice(0, 20),
      tables: tables.map(table => ({ rows: table.rows.length,
        headers: (Array.isArray(table.headers) ? table.headers : []).flatMap(cells).slice(0, 16) })).slice(0, 12),
    });
    throw new Error('KBO 官方逐局比分缺失或與終場比分不一致，等待驗證');
  }
  return { ...game, ...distinct[0], first5Complete: true,
    resultDetailSourceRecord: `KBO_OFFICIAL_BOXSCORE:${game.providerGameId}:${game.officialDate}` };
}
