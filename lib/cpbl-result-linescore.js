import * as cheerio from 'cheerio';

const invalid = message => Object.assign(new Error(message), { status: 502, code: 'OFFICIAL_FIRST5_RESULT_INVALID' });
const teamName = value => String(value || '').replace(/\s+/g, '').toUpperCase();

export function parseCpblResultLinescore(html, game) {
  const $ = cheerio.load(String(html || ''));
  $('style,script').remove();
  const url = `https://stats.cpbl.com.tw/schedule/${game.providerGameId}`;
  if (!/^\d{4}-A-\d+$/.test(game.providerGameId || '')
    || $('link[rel="canonical"]').attr('href') !== url) throw invalid('CPBL 逐局比分場次識別不一致');
  const heading = $('h1').text().trim();
  const names = heading.match(/^(.+?)\s+vs\s+(.+?)\s+賽事詳情$/);
  if (!names || !game.away || !game.home || teamName(names[1]) !== teamName(game.away)
    || teamName(names[2]) !== teamName(game.home)) throw invalid('CPBL 逐局比分主客隊不一致');
  const detailText = $('body').text().split(heading)[1] || '';
  const sourceDate = detailText.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+星期/);
  const date = sourceDate && `${sourceDate[1]}-${sourceDate[2].padStart(2, '0')}-${sourceDate[3].padStart(2, '0')}`;
  if (date !== game.officialDate || !detailText.includes('已結束') || game.statusCode !== 'F') throw invalid('CPBL 逐局比分日期或完賽狀態未通過核對');
  const tables = $('table').filter((_, table) => {
    const headers = $(table).find('thead th').map((_, th) => $(th).text().trim()).get();
    return headers.includes('R') && headers.slice(1, 6).join(',') === '1,2,3,4,5';
  });
  if (tables.length !== 1) throw invalid('CPBL 逐局比分表缺失或不唯一');
  const headers = tables.find('thead th').map((_, th) => $(th).text().trim()).get();
  const runsIndex = headers.indexOf('R');
  const innings = runsIndex - 1;
  if (innings !== Number(game.innings) || innings < 9
    || headers.slice(1, runsIndex).some((v, i) => v !== String(i + 1))) throw invalid('CPBL 逐局局數不一致');
  const rows = tables.find('tbody tr');
  if (rows.length !== 2) throw invalid('CPBL 逐局比分隊伍列不完整');
  const first5 = rows.map((side, row) => {
    const cells = $(row).find('td');
    const expectedTeam = side === 0 ? game.away : game.home;
    if (cells.length !== headers.length || teamName(cells.eq(0).text()) !== teamName(expectedTeam)) throw invalid('CPBL 逐局比分隊伍列不一致');
    const expectedRuns = side === 0 ? game.awayScore : game.homeScore;
    const rawRuns = cells.eq(runsIndex).text().trim();
    if (!/^\d+$/.test(rawRuns) || Number(rawRuns) !== expectedRuns) throw invalid('CPBL 逐局比分與官方終場不一致');
    const scores = cells.slice(1, runsIndex).map((i, cell) => {
      const text = $(cell).text().trim();
      if (side === 1 && i === innings - 1 && /^X$/i.test(text) && game.homeScore > game.awayScore) return 0;
      if (!/^\d+$/.test(text)) throw invalid('CPBL 逐局比分缺失，不能當成零');
      const value = Number(text);
      if (!Number.isSafeInteger(value)) throw invalid('CPBL 逐局比分格式不正確');
      return value;
    }).get();
    if (scores.reduce((sum, value) => sum + value, 0) !== expectedRuns) throw invalid('CPBL 逐局加總與終場不一致');
    return scores.slice(0, 5).reduce((sum, value) => sum + value, 0);
  }).get();
  return { ...game, first5Complete: true, awayFirst5: first5[0], homeFirst5: first5[1],
    first5Source: url, first5RetrievedAt: new Date().toISOString() };
}
