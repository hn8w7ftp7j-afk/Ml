import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import {
  fetchAsianTaipeiSlate,
  parseNpbGameDetailHtml,
  parseNpbMonthHtml,
  parseNpbScheduleHtml,
} from '../lib/asian-baseball.js';

// Official calendar DOM excerpts captured 2026-09-23 from
// https://npb.jp/bis/eng/2026/calendar/index_09.html . Cross-check against
// gm20260904.html and the corresponding English BIS game details below.
// In particular C 1 - 3 G means Hiroshima HOME 1, Yomiuri AWAY 3.
const monthHtml = `<table><tr><td class="stschedule">
  <div class="teschedate"><a href="/bis/eng/2026/games/gm20260904.html">4</a></div>
  <div class="stvsteam">
    <div><a href="/bis/eng/2026/games/s2026090401413.html">S 1 - 1 D</a></div>
    <div><a href="/bis/eng/2026/games/s2026090401414.html">C 1 - 3 G</a></div>
  </div><div class="stvsteam">
    <div><a href="/bis/eng/2026/games/s2026090401770.html">E 2 - 5 F</a></div>
    <div><a href="/bis/eng/2026/games/s2026090401771.html">B 3 - 1 M</a></div>
    <div><a href="/bis/eng/2026/games/s2026090401772.html">H 8 - 2 L</a></div>
  </div></td><td class="stschedule">
  <div class="teschedate">6</div><div class="stvsteam">
    <div><a href="/bis/eng/2026/games/s2026090601418.html">S * - * D</a></div>
  </div></td><td class="stschedule">
  <div class="teschedate">23</div><div class="stvsteam">
    <div>S - T 14:00</div><div>DB - D 18:00</div>
  </div></td></tr></table>`;
const month = parseNpbMonthHtml(monthHtml, 2026, 9);
const monthById = new Map(month.map(game => [game.providerGameId, game]));
for (const [id, away, home, awayRuns, homeRuns] of [
  ['s2026090401413', 'CHU', 'YAK', 1, 1],
  ['s2026090401414', 'YOM', 'HIR', 3, 1],
  ['s2026090401770', 'NIP', 'RAK', 5, 2],
  ['s2026090401771', 'LOM', 'ORI', 1, 3],
  ['s2026090401772', 'SEI', 'SOF', 2, 8],
]) {
  const game = monthById.get(id);
  assert.deepEqual([game.awayCode, game.homeCode, game.awayScore, game.homeScore], [away, home, awayRuns, homeRuns], id);
  assert.equal(game.statusCode, 'F');
}
const postponed = monthById.get('s2026090601418');
assert.deepEqual([postponed.awayCode, postponed.homeCode, postponed.statusCode, postponed.awayScore, postponed.homeScore],
  ['CHU', 'YAK', 'D', null, null]);
const future = month.filter(game => game.officialDate === '2026-09-23');
assert.deepEqual(future.map(game => [game.awayCode, game.homeCode, game.gameDate, game.statusCode]), [
  ['HAN', 'YAK', '2026-09-23T05:00:00.000Z', 'S'],
  ['CHU', 'YDB', '2026-09-23T09:00:00.000Z', 'S'],
]);

// Exact side-container shape from the official daily card. The English
// inning table uses the opposite display order: visiting team first.
const dailyHtml = `<a href="/bis/eng/2026/games/s2026090401414.html" class="link_box"><div class="unit">
  <div class="team_left"><div class="team_info"><div class="team_name">Hiroshima</div></div>
    <div class="score_text score_left">1</div></div>
  <div class="round">Game 18<br>Mazda Stadium</div>
  <div class="team_right"><div class="score_text score_right">3</div>
    <div class="team_info"><div class="team_name">Yomiuri</div></div></div>
</div></a>`;
const [daily] = parseNpbScheduleHtml(dailyHtml, '2026-09-04');
const monthly = monthById.get('s2026090401414');
assert.deepEqual([daily.gamePk, daily.awayTeamId, daily.homeTeamId], [monthly.gamePk, monthly.awayTeamId, monthly.homeTeamId]);
assert.equal(daily.gameNumber, 1, 'Series meeting 18 cannot become the 18th game of a doubleheader');
assert.equal(daily.seriesGameNumber, 18);
assert.equal(daily.doubleHeader, 'N');
assert.equal(parseNpbScheduleHtml(dailyHtml + dailyHtml, '2026-09-04').length, 1, 'Responsive duplicates retain one source identity');

// Parsing identity from explicit left/right containers must survive DOM
// ordering changes; position is the provider side field, not traversal order.
const $daily = cheerio.load(dailyHtml);
$daily('.unit').prepend($daily('.team_right'));
const [reordered] = parseNpbScheduleHtml($daily.html(), '2026-09-04');
assert.deepEqual([reordered.awayCode, reordered.homeCode], ['YOM', 'HIR']);
const [unlinkedDaily] = parseNpbScheduleHtml('<div class="unit"><div class="team_name">Yakult</div><div class="round">14:00</div><div class="team_name">Hanshin</div></div>', '2026-09-23');
assert.equal(unlinkedDaily.gamePk, future[0].gamePk,
  'Before official game links exist, day and month must share the same matchup/date/time identity');

// Same teams returning after cancellation are separate official games.
const rescheduled = parseNpbMonthHtml(`<table><tr>
  <td class="stschedule"><div class="teschedate">6</div><div class="stvsteam">
    <div><a href="/bis/eng/2026/games/s2026090601418.html">S * - * D</a></div></div></td>
  <td class="stschedule"><div class="teschedate">25</div><div class="stvsteam">
    <div>S - D 18:00</div></div></td></tr></table>`, 2026, 9);
assert.equal(rescheduled.length, 2);
assert.notEqual(rescheduled[0].gamePk, rescheduled[1].gamePk);
assert.deepEqual(rescheduled.map(game => [game.awayCode, game.homeCode, game.gameNumber, game.doubleHeader]),
  [['CHU', 'YAK', 1, 'N'], ['CHU', 'YAK', 1, 'N']]);

// Synthetic doubleheader, using the documented provider DOM (no assertion
// that these future fixtures occurred). Source IDs, clocks and players differ.
const twinCard = (id, time, series) => `<a href="/bis/eng/2026/games/${id}.html"><div class="unit">
  <div class="team_left"><div class="team_name">Hiroshima</div></div>
  <div class="round">Game ${series}<br>Mazda Stadium<br>${time}</div>
  <div class="team_right"><div class="team_name">Yomiuri</div></div></div></a>`;
const twinsHtml = twinCard('s2026090402001', '13:00', 21) + twinCard('s2026090402002', '18:00', 22);
const twins = parseNpbScheduleHtml(twinsHtml, '2026-09-04');
assert.deepEqual(twins.map(game => [game.gameNumber, game.doubleHeader]), [[1, 'Y'], [2, 'Y']]);
assert.notEqual(twins[0].gamePk, twins[1].gamePk);
const twinsMonth = parseNpbMonthHtml(`<table><tr><td class="stschedule"><div class="teschedate">4</div><div class="stvsteam">
  <div><a href="/bis/eng/2026/games/s2026090402001.html">C 2 - 4 G</a></div>
  <div><a href="/bis/eng/2026/games/s2026090402002.html">C 3 - 1 G</a></div>
</div></td></tr></table>`, 2026, 9);
assert.deepEqual(twinsMonth.map(game => [game.providerGameId, game.gameNumber, game.doubleHeader, game.awayScore, game.homeScore]),
  [['s2026090402001', 1, 'Y', 4, 2], ['s2026090402002', 2, 'Y', 1, 3]]);

const announcement = (time, suffix) => `<div class="unit">
  <div class="team_left"><img src="/img/common/logo/2026/logo_c_l.gif"><a href="/bis/players/111${suffix}.html">Home ${suffix}</a></div>
  <div class="team_right"><img src="/img/common/logo/2026/logo_g_l.gif"><a href="/bis/players/222${suffix}.html">Away ${suffix}</a></div>
  <div class="info">Mazda Stadium ${time}</div></div>`;
let starterHtml = `<h4>9月4日</h4><div class="starting_wrap_cl">${announcement('13:00', '1')}${announcement('18:00', '2')}</div>`;
const slateOptions = { fetchImpl: async url => new Response(String(url).includes('gm20260904.html') ? twinsHtml
  : String(url).includes('/announcement/starter/') ? starterHtml : '', { status: 200 }) };
const announcedTwins = await fetchAsianTaipeiSlate('NPB', '2026-09-04', slateOptions);
assert.deepEqual(announcedTwins.map(game => [game.awayProbableId, game.homeProbableId]), [['2221', '1111'], ['2222', '1112']]);
starterHtml = `<h4>9月4日</h4><div class="starting_wrap_cl">${announcement('13:00', '1')}</div>`;
const partialTwins = await fetchAsianTaipeiSlate('NPB', '2026-09-04', slateOptions);
assert.deepEqual(partialTwins.map(game => [game.awayProbableId, game.homeProbableId]), [['2221', '1111'], [null, null]],
  'The only announced pitcher pair must not be assigned to both games');

assert.throws(() => parseNpbMonthHtml(monthHtml.replace('s2026090401414', 's2026090501414'), 2026, 9),
  error => error.code === 'OFFICIAL_IDENTITY_MISMATCH', 'A stale link cannot silently move a source game to another date');
assert.throws(() => parseNpbScheduleHtml(dailyHtml, '2026-09-05'), error => error.code === 'OFFICIAL_IDENTITY_MISMATCH');
assert.throws(() => parseNpbScheduleHtml(dailyHtml + dailyHtml.replaceAll('Yomiuri', 'Chunichi'), '2026-09-04'),
  error => error.code === 'OFFICIAL_IDENTITY_MISMATCH', 'One source ID cannot represent two different opponents');
assert.equal(parseNpbMonthHtml('<table><tr><td class="stschedule"><div class="teschedate">31</div><div class="stvsteam"><div>C - G 18:00</div></div></td></tr></table>', 2026, 2).length, 0,
  'Impossible February dates cannot roll into March');

// Optional full official-corpus check, without network or fixture dependency
// in normal CI: node scripts/npb-source-identity-integrity-test.mjs
//   --archive-dir=.../actual-npb/raw --month-html=.../npb-month-2026-09.html
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const archiveDir = argument('archive-dir');
const monthPath = argument('month-html');
if (archiveDir || monthPath) {
  assert.ok(archiveDir && monthPath, 'Supply both official-corpus paths');
  const fullMonth = parseNpbMonthHtml(readFileSync(monthPath, 'utf8'), 2026, 9);
  const byId = new Map(fullMonth.map(game => [game.providerGameId, game]));
  const officialTeamAliases = {
    Yomiuri: 'YOM', Hanshin: 'HAN', DeNA: 'YDB', Hiroshima: 'HIR', Yakult: 'YAK', Chunichi: 'CHU',
    SoftBank: 'SOF', 'Nippon-Ham': 'NIP', Lotte: 'LOM', Rakuten: 'RAK', ORIX: 'ORI', Seibu: 'SEI',
  };
  const counts = { monthGames: fullMonth.length, dailyIdentityMatches: 0, detailIdentityMatches: 0, detailScoreMatches: 0,
    resultParserAccepted: 0, resultParserRejected: [], postponed: 0, unlinkedScheduleGames: 0 };
  for (const filename of readdirSync(archiveDir).filter(name => /^schedule-2026-09-\d{2}\.html$/.test(name))) {
    const date = filename.slice('schedule-'.length, 'schedule-'.length + 10);
    for (const game of parseNpbScheduleHtml(readFileSync(join(archiveDir, filename), 'utf8'), date)) {
      if (!/^s\d+$/i.test(game.providerGameId)) { counts.unlinkedScheduleGames += 1; continue; }
      const calendarGame = byId.get(game.providerGameId);
      assert.ok(calendarGame, `${game.providerGameId} must be present in the official month`);
      assert.deepEqual([game.awayTeamId, game.homeTeamId, game.gamePk],
        [calendarGame.awayTeamId, calendarGame.homeTeamId, calendarGame.gamePk], game.providerGameId);
      counts.dailyIdentityMatches += 1;
      if (calendarGame.statusCode === 'D') { counts.postponed += 1; continue; }
      const detailPath = join(archiveDir, `${game.providerGameId}-en.html`);
      if (!existsSync(detailPath)) continue;
      const detailHtml = readFileSync(detailPath, 'utf8');
      const $ = cheerio.load(detailHtml);
      // Headline display order varies (often winner first), so only compare
      // its unordered team set. The inning and box tables are away then home.
      const headlineNames = $('.contentshdname').map((_, node) => $(node).text().trim().toUpperCase()).get();
      assert.deepEqual(headlineNames.sort(), [game.homeEnglish, game.awayEnglish].map(name => name.toUpperCase()).sort(), game.providerGameId);
      for (const selector of ['.gmscoreteam', '.gmtblteam']) {
        const codes = $(selector).map((_, node) => officialTeamAliases[$(node).text().trim()]).get();
        assert.deepEqual(codes, [game.awayCode, game.homeCode], `${game.providerGameId} ${selector}`);
      }
      counts.detailIdentityMatches += 1;
      // Independently inspect published R totals; this identity test does not
      // relax production validation of malformed/short inning sequences.
      const totals = $('#gmdivresult tr').filter((_, row) => $(row).find('.gmscoreteam').length > 0)
        .map((_, row) => Number($(row).find('.gmscore').eq(-3).text().trim())).get();
      assert.deepEqual(totals, [calendarGame.awayScore, calendarGame.homeScore], `${game.providerGameId} run ownership`);
      counts.detailScoreMatches += 1;
      try {
        const detail = parseNpbGameDetailHtml(detailHtml, game);
        if (detail.statusCode === 'F') counts.resultParserAccepted += 1;
      } catch (error) {
        assert.equal(error.code, 'OFFICIAL_FINAL_RESULT_INVALID');
        counts.resultParserRejected.push({ providerGameId: game.providerGameId, code: error.code });
      }
    }
  }
  assert.ok(counts.dailyIdentityMatches > 0 && counts.detailIdentityMatches > 0 && counts.detailScoreMatches > 0,
    'Full-corpus run must exercise the archived sources');
  console.log(JSON.stringify({ officialCorpus: counts }));
}
console.log('NPB source identity: official home/away and scores, shared IDs, reschedules, duplicate cards, doubleheader starters PASS');
