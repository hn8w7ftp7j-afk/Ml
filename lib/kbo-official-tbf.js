import * as cheerio from 'cheerio';

export const KBO_TBF_VERSION = 'KBO-OFFICIAL-SEASON-TBF-v1';
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// Only the identified player's single current-season summary is eligible.
// Recent-game, career, Futures and ambiguous traded-team rows are not totals.
export function parseKboOfficialTbf(html, { playerId, name, teamCode, season }) {
  if (!/^\d+$/.test(String(playerId)) || !/^\d{4}$/.test(String(season)) || !name || !/^[A-Z]{2}$/.test(teamCode || '')) return null;
  const $ = cheerio.load(String(html || ''));
  const form = $('form#mainForm').attr('action');
  if (!form) return null;
  const action = new URL(form, 'https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx');
  if (action.origin !== 'https://www.koreabaseball.com' || action.pathname !== '/Record/Player/PitcherDetail/Basic.aspx' || action.searchParams.get('playerId') !== String(playerId)) return null;
  if (text($('[id$="playerProfile_lblName"]').text()) !== text(name)) return null;
  const teamClass = String($('#h4Team').attr('class') || '').split(/\s+/);
  if (!teamClass.includes(`regular/${season}/emblem_${teamCode}`)) return null;
  const sections = $('.player_records').filter((_, section) => text($(section).children('h6').first().text()) === `${season} 성적`);
  if (sections.length !== 1) return null;
  const tables = sections.find('table').filter((_, table) => {
    const headers = $(table).find('thead th').map((_, th) => text($(th).text())).get();
    return ['팀명', 'ERA', 'G', 'TBF', 'NP', 'IP'].every(key => headers.includes(key));
  });
  if (tables.length !== 1) return null;
  const headers = tables.find('thead th').map((_, th) => text($(th).text())).get();
  if (headers.filter(key => key === 'TBF').length !== 1) return null;
  const rows = tables.find('tbody tr');
  if (rows.length !== 1) return null;
  const cells = rows.children('td').map((_, td) => text($(td).text())).get();
  if (cells.length !== headers.length) return null;
  const raw = cells[headers.indexOf('TBF')];
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) return null;
  const battersFaced = Number(raw.replaceAll(',', ''));
  if (!Number.isSafeInteger(battersFaced) || battersFaced < 0) return null;
  return { battersFaced, playerId: String(playerId), name: text(name), teamCode, season: Number(season),
    version: KBO_TBF_VERSION, sourceField: 'TBF', rawValue: raw,
    sourcePath: '.player_records[season heading] table[팀명,ERA,G,TBF,NP,IP] tbody tr[0] td[TBF]',
    dataCutoff: null, publishedAt: null };
}

export function kboTbfAcquisitionEligible(game, fetchedAt) {
  const fetched = Date.parse(fetchedAt || '');
  const start = Date.parse(game?.gameDate || '');
  const season = String(game?.officialDate || '').slice(0, 4);
  return Number.isFinite(fetched) && Number.isFinite(start) && fetched < start
    && /^\d{4}$/.test(season) && new Date(fetched + 9 * 3600000).getUTCFullYear() === Number(season);
}
