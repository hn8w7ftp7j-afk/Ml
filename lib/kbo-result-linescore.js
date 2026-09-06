// Contract observed in KBO GameCenter's getScoreTableGrid: table2 contains
// innings, table3 contains totals, and the initial-logo URLs identify the sides.
const text = value => String(value?.Text ?? value ?? '').replace(/<[^>]*>/g, '').trim();
const cells = row => (Array.isArray(row?.row) ? row.row : []).map(text);
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;

export function parseKboResultLinescore(payload, game) {
  if (game?.statusCode !== 'F') return game;
  const identity = String(game.providerGameId || '').match(/^(\d{8})([A-Z]{2})([A-Z]{2})\d$/);
  const logoCode = value => String(value || '').match(/initial_([A-Z]{2})_/i)?.[1]?.toUpperCase();
  if (String(payload?.code) !== '100' || !/^\d{1,2}:\d{2}$/.test(text(payload.END_TM))
    || !identity || identity[1] !== game.officialDate.replaceAll('-', '')
    || logoCode(payload.A_INITIAL_LK) !== identity[2] || logoCode(payload.H_INITIAL_LK) !== identity[3]) {
    throw new Error('KBO 官方計分板尚未完賽或主客隊識別不一致');
  }
  const table = decode(payload.table2);
  const totals = decode(payload.table3);
  if (!Array.isArray(totals?.rows) || totals.rows.length !== 2
    || cells(totals.rows[0])[0] !== String(game.awayScore)
    || cells(totals.rows[1])[0] !== String(game.homeScore)) {
    throw new Error('KBO 官方計分板與賽程終場比分不一致');
  }
  const tables = Array.isArray(table?.rows) ? [table] : [];
  const matches = [];
  for (const table of tables) {
    if (table.rows.length !== 2) continue;
    const headers = (Array.isArray(table.headers) ? table.headers : []).flatMap(cells);
    if (headers.length < 9 || !headers.every((value, index) => value === String(index + 1))) continue;
    const rows = table.rows.map(cells);
    if (rows.some(row => row.length !== headers.length)) continue;
    const played = rows.map((row, side) => {
      const end = row.findIndex(value => value === '-' || value === '');
      if (end >= 0 && row.slice(end).some(value => value !== '-' && value !== '')) return null;
      const values = end < 0 ? row : row.slice(0, end);
      if (values.some(value => !/^\d+(?:X)?$|^X$/i.test(value))) return null;
      if (values.some((value, index) => /X/i.test(value)
        && (side !== 1 || index !== values.length - 1 || index < 8 || game.homeScore <= game.awayScore))) return null;
      return values.map(value => /^X$/i.test(value) ? 0 : Number(value.replace(/X$/i, '')));
    });
    if (played.some(row => !row || row.length < 5)) continue;
    const [away, home] = played;
    const innings = Math.max(away.length, home.length);
    if (innings < 9 || away.length !== innings || home.length < innings - 1) continue;
    if (home.length < innings && game.homeScore <= game.awayScore) continue;
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
    resultDetailRevision: text(payload.END_TM),
    resultDetailSourceRecord: `KBO_OFFICIAL_SCOREBOARD:${game.providerGameId}:${game.officialDate}` };
}
