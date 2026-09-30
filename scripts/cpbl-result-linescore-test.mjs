import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { parseCpblResultLinescore } from '../lib/cpbl-result-linescore.js';

// Reduced official fixture retrieved from stats.cpbl.com.tw/schedule/2026-A-311.
const html = fs.readFileSync(new URL('./fixtures/cpbl-2026-A-311-linescore.html', import.meta.url), 'utf8');
const game = { providerGameId: '2026-A-311', officialDate: '2026-09-05', away: '樂天桃猿', home: '富邦悍將',
  awayTeamId: 703, homeTeamId: 704, awayScore: 4, homeScore: 0, innings: 9, statusCode: 'F' };
const result = parseCpblResultLinescore(html, game);
assert.equal(result.awayFirst5, 4);
assert.equal(result.homeFirst5, 0);
assert.equal(result.first5Complete, true);
assert.equal(game.first5Complete, undefined);
for (const change of [{ providerGameId: '2026-A-312' }, { officialDate: '2026-09-06' },
  { away: game.home, home: game.away }, { awayScore: 5 }, { innings: 10 }, { statusCode: 'I' }]) {
  assert.throws(() => parseCpblResultLinescore(html, { ...game, ...change }), { code: 'OFFICIAL_FIRST5_RESULT_INVALID' });
}
for (const bad of ['', ' ', '-', 'X', 'NaN', '-1', '0.5']) {
  const $ = cheerio.load(html);
  $('tbody tr').first().find('td').eq(1).text(bad);
  assert.throws(() => parseCpblResultLinescore($.html(), game), /逐局比分/);
}
const wrongSum = cheerio.load(html);
wrongSum('tbody tr').first().find('td').eq(3).text('0');
assert.throws(() => parseCpblResultLinescore(wrongSum.html(), game), /加總/);
const duplicate = cheerio.load(html);
duplicate('body').append(duplicate('table').clone());
assert.throws(() => parseCpblResultLinescore(duplicate.html(), game), /不唯一/);
const incompleteHeaders = cheerio.load(html);
incompleteHeaders('thead th').eq(6).text('7');
assert.throws(() => parseCpblResultLinescore(incompleteHeaders.html(), game), /局數/);
// An unplayed final bottom inning is allowed only when the home team won;
// no missing first-five cell can be normalized to zero.
const homeWins = cheerio.load(html);
homeWins('tbody tr').first().find('td').eq(3).text('0');
homeWins('tbody tr').first().find('td').eq(10).text('0');
homeWins('tbody tr').last().find('td').eq(1).text('1');
homeWins('tbody tr').last().find('td').eq(9).text('X');
homeWins('tbody tr').last().find('td').eq(10).text('1');
const walkoff = parseCpblResultLinescore(homeWins.html(), { ...game, awayScore: 0, homeScore: 1 });
assert.equal(walkoff.homeFirst5, 1);
console.log('CPBL official first-five evidence: real fixture, identity, date, completeness, closure and home-X cases PASS');
