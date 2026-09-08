import * as cheerio from 'cheerio';

export const KBO_TBF_VERSION = 'KBO-OFFICIAL-SEASON-TBF-v2';
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();

export function kboInningsOuts(value) {
  const match = /^(?:(\d+)(?: ([12])\/3)?|([12])\/3)$/.exec(text(value));
  if (!match) return null;
  const outs = Number(match[1] || 0) * 3 + Number(match[2] || match[3] || 0);
  return Number.isSafeInteger(outs) ? outs : null;
}
const integer = value => /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text(value))
  && Number.isSafeInteger(Number(text(value).replaceAll(',', ''))) ? Number(text(value).replaceAll(',', '')) : null;

function matchedProfile($, { playerId, name, teamCode, season }, page) {
  try {
    const form = $('form#mainForm').attr('action');
    if (!form) return false;
    const action = new URL(form, `https://www.koreabaseball.com/Record/Player/PitcherDetail/${page}.aspx`);
    return action.origin === 'https://www.koreabaseball.com'
      && action.pathname === `/Record/Player/PitcherDetail/${page}.aspx`
      && action.searchParams.get('playerId') === String(playerId)
      && text($('[id$="playerProfile_lblName"]').text()) === text(name)
      && String($('#h4Team').attr('class') || '').split(/\s+/).includes(`regular/${season}/emblem_${teamCode}`);
  } catch { return false; }
}

// Only the identified player's single current-season summary is eligible.
// Recent-game, career, Futures and ambiguous traded-team rows are not totals.
export function parseKboOfficialTbf(html, { playerId, name, teamCode, season }) {
  if (!/^\d+$/.test(String(playerId)) || !/^\d{4}$/.test(String(season)) || !name || !/^[A-Z]{2}$/.test(teamCode || '')) return null;
  const $ = cheerio.load(String(html || ''));
  if (!matchedProfile($, { playerId, name, teamCode, season }, 'Basic')) return null;
  const sections = $('.player_records').filter((_, section) => text($(section).children('h6').first().text()) === `${season} 성적`);
  if (sections.length !== 1) return null;
  const tables = sections.find('table').filter((_, table) => {
    const headers = $(table).find('thead th').map((_, th) => text($(th).text())).get();
    return ['팀명', 'ERA', 'G', 'TBF', 'NP', 'IP'].every(key => headers.includes(key));
  });
  if (tables.length !== 1) return null;
  const headers = tables.find('thead th').map((_, th) => text($(th).text())).get();
  if (!['TBF', 'IP', 'G'].every(key => headers.filter(header => header === key).length === 1)) return null;
  const rows = tables.find('tbody tr');
  if (rows.length !== 1) return null;
  const cells = rows.children('td').map((_, td) => text($(td).text())).get();
  if (cells.length !== headers.length) return null;
  const raw = cells[headers.indexOf('TBF')];
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) return null;
  const battersFaced = Number(raw.replaceAll(',', ''));
  if (!Number.isSafeInteger(battersFaced) || battersFaced < 0) return null;
  const inningsOuts = kboInningsOuts(cells[headers.indexOf('IP')]);
  return { battersFaced, appearances: integer(cells[headers.indexOf('G')]), inningsOuts,
    inningsPitched: inningsOuts === null ? null : inningsOuts / 3,
    inningsRawValue: cells[headers.indexOf('IP')], appearancesRawValue: cells[headers.indexOf('G')],
    playerId: String(playerId), name: text(name), teamCode, season: Number(season),
    version: KBO_TBF_VERSION, sourceField: 'TBF', rawValue: raw,
    sourcePath: '.player_records[season heading] table[팀명,ERA,G,TBF,NP,IP] tbody tr[0] td[TBF]',
    dataCutoff: null, publishedAt: null };
}

export function parseKboOfficialStarts(html, expected, totals, targetDate) {
  const $ = cheerio.load(String(html || ''));
  if (!matchedProfile($, expected, 'Daily')) return null;
  if ($('select[id$="ddlYear"] option:selected').attr('value') !== String(expected.season)
    || $('select[id$="ddlSeries"] option:selected').attr('value') !== '0') return null;
  if (!Number.isSafeInteger(totals?.appearances) || !Number.isSafeInteger(totals?.inningsOuts)
    || !Number.isSafeInteger(totals?.battersFaced) || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate || '')) return null;
  const records = [], seen = new Set();
  let invalid = false;
  $('.player_records table').each((_, table) => {
    const headers = $(table).find('thead th').map((_, th) => text($(th).text())).get();
    if (!/^\d{1,2}월$/.test(headers[0] || '')) return;
    if (!['상대', '구분', 'TBF', 'IP'].every(k => headers.filter(h => h === k).length === 1)) { invalid = true; return; }
    $(table).find('tbody tr').each((_, row) => {
      const cells = $(row).children('td').map((_, td) => text($(td).text())).get();
      const md = /^(\d{2})\.(\d{2})$/.exec(cells[0] || '');
      if (!md || cells.length !== headers.length) { invalid = true; return; }
      const date = `${expected.season}-${md[1]}-${md[2]}`;
      const at = Date.parse(`${date}T00:00:00Z`);
      const role = cells[headers.indexOf('구분')];
      const outs = kboInningsOuts(cells[headers.indexOf('IP')]);
      const tbf = integer(cells[headers.indexOf('TBF')]);
      // No same-day inference without game IDs (including doubleheaders).
      if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== date
        || Number(md[1]) !== Number(headers[0].replace('월', '')) || date >= targetDate
        || !['선발', '구원'].includes(role) || outs === null || tbf === null || seen.has(date)) { invalid = true; return; }
      seen.add(date);
      records.push({ date, role, inningsOuts: outs, battersFaced: tbf });
    });
  });
  if (invalid || records.length !== totals.appearances
    || records.reduce((s, r) => s + r.inningsOuts, 0) !== totals.inningsOuts
    || records.reduce((s, r) => s + r.battersFaced, 0) !== totals.battersFaced) return null;
  return { gamesStarted: records.filter(r => r.role === '선발').length,
    reliefAppearances: records.filter(r => r.role === '구원').length, appearances: records.length,
    records, version: 'KBO-STARTS-DAILY-TOTAL-RECONCILIATION-v1',
    sourceField: '구분=선발', sourcePath: '.player_records monthly table tbody tr[구분=선발]',
    dataCutoff: null, publishedAt: null };
}

export function kboTbfAcquisitionEligible(game, fetchedAt) {
  const fetched = Date.parse(fetchedAt || '');
  const start = Date.parse(game?.gameDate || '');
  const season = String(game?.officialDate || '').slice(0, 4);
  return Number.isFinite(fetched) && Number.isFinite(start) && fetched < start
    && /^\d{4}$/.test(season) && new Date(fetched + 9 * 3600000).getUTCFullYear() === Number(season);
}
