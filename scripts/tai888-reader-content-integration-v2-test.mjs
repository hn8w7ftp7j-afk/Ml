import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseTai888Capture } from '../reader/parser.js';

const spans = [
  [0, 80], [80, 260], [260, 380], [380, 500],
  [500, 580], [580, 700], [700, 820], [820, 940],
];
const labels = ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '一輸二贏', '上半讓球', '上半大小'];
const games = [
  ['01:10', 'BAL', 'MIN', '', '1+95', '9+30', '', '0-20', '4+50'],
  ['02:15', 'PHI', 'STL', '1-60', '', '8+50', '0-15', '', '4+20'],
  ['03:40', 'COL', 'ARI', '', '1-60', '9-90', '', '1+15', '5平'],
  ['04:10', 'MIL', 'SD', '1+65', '', '8+20', '0-10', '', '4平'],
  ['06:40', 'CLE', 'DET', '', '1+60', '8平', '', '0-25', '4+50'],
  ['07:05', 'SEA', 'NYY', '', '1+55', '9+30', '', '0-75', '5平'],
  ['07:07', 'BOS', 'TOR', '', '1+40', '7-40', '0-25', '', '4+50'],
  ['10:10', 'KC', 'LAD', '', '1-85', '9-50', '', '1+35', '5-50'],
];

function attrs(left, right, top) {
  return `data-left="${left}" data-right="${right}" data-top="${top}"`;
}

let top = 0;
const header = `<tr ${attrs(0, 940, top)}>${labels.map((label, index) => `<th ${attrs(spans[index][0], spans[index][1], top)}>${label}</th>`).join('')}</tr>`;
top += 24;
const league = `<tr ${attrs(0, 940, top)}><td colspan="8" ${attrs(0, 940, top)}>聯盟： MLB 美國職棒(8)</td></tr>`;
top += 24;

function teamRow(game, home, rowTop) {
  const [time, away, homeCode, awayRun, homeRun, total, awayF5, homeF5, first5Total] = game;
  const team = home ? homeCode : away;
  const run = home ? homeRun : awayRun;
  const first5 = home ? homeF5 : awayF5;
  const values = [
    home ? time : '08-13',
    `${team}-${home ? '主隊名稱[主]' : '客隊名稱'} 投手[右]`,
    `${run} 0.950`.trim(),
    home ? '小 0.940' : `${total} 大 0.940`,
    home ? '0.760' : '0.990',
    home ? '1.5 1.660' : '1.5 0.530',
    `${first5} 0.940`.trim(),
    home ? '小 0.930' : `${first5Total} 大 0.930`,
  ];
  return `<tr ${attrs(0, 940, rowTop)}>${values.map((value, index) => `<td ${attrs(spans[index][0], spans[index][1], rowTop)}>${value}</td>`).join('')}</tr>`;
}

const rows = [];
for (const game of games) {
  rows.push(teamRow(game, false, top));
  top += 22;
  rows.push(teamRow(game, true, top));
  top += 28;
}
const repeatedHeader = `<tr ${attrs(0, 940, top)}>${labels.map((label, index) => `<th ${attrs(spans[index][0], spans[index][1], top)}>${label}</th>`).join('')}</tr>`;
top += 24;
const specialLeague = `<tr ${attrs(0, 940, top)}><td colspan="8" ${attrs(0, 940, top)}>聯盟： MLB 美國職棒-主隊總得分(9)</td></tr>`;
top += 24;
const specialAway = `<tr ${attrs(0, 940, top)}><td ${attrs(0, 80, top)}>08-13</td><td ${attrs(80, 260, top)}>MIN-雙城</td><td ${attrs(380, 500, top)}>4.5 大 1.115</td></tr>`;
top += 22;
const specialHome = `<tr ${attrs(0, 940, top)}><td ${attrs(0, 80, top)}>01:10</td><td ${attrs(80, 260, top)}>MIN-雙城[主]</td><td ${attrs(380, 500, top)}>小 0.720</td></tr>`;

const html = `<!doctype html><html><head><title>泰8</title></head><body><table><tbody>${header}${league}${rows.join('')}${repeatedHeader}${specialLeague}${specialAway}${specialHome}</tbody></table></body></html>`;
const dom = new JSDOM(html, {
  url: 'https://www1.tai888.in/newapp/#/BS',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
window.getComputedStyle = () => ({ display: 'table-row', visibility: 'visible', opacity: '1' });
window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  const left = Number(this.getAttribute('data-left') || this.parentElement?.getAttribute?.('data-left') || 0);
  const right = Number(this.getAttribute('data-right') || this.parentElement?.getAttribute?.('data-right') || 940);
  const topValue = Number(this.getAttribute('data-top') || this.parentElement?.getAttribute?.('data-top') || 0);
  return { left, right, top: topValue, bottom: topValue + 20, width: right - left, height: 20, x: left, y: topValue, toJSON() {} };
};
if (window.Range?.prototype) window.Range.prototype.getClientRects = () => [];

let listener = null;
window.chrome = {
  runtime: {
    onMessage: { addListener(callback) { listener = callback; } },
    sendMessage() { return Promise.resolve({ ok: true }); },
  },
};

window.eval(fs.readFileSync(new URL('../reader/row-normalizer.js', import.meta.url), 'utf8'));
window.eval(fs.readFileSync(new URL('../reader/tai888-content.js', import.meta.url), 'utf8'));
assert.equal(typeof listener, 'function');

let response = null;
listener({ type: 'TAI888_CAPTURE_MLB_TABLE' }, {}, value => { response = value; });
assert.equal(response?.ok, true, response?.error || 'content capture failed');
assert.equal(response.capture.version, 'TAI888-DOM-CAPTURE-v2.0.2');
assert.equal(response.capture.diagnostics.sawLeagueMarker, true);
assert.equal(response.capture.diagnostics.gameCount, 8);
assert.equal(response.capture.tables.length, 1);
assert.equal(response.capture.tables[0].rows.length, 8);

const parsed = parseTai888Capture(response.capture, new Date('2026-08-12T12:12:00Z'));
assert.equal(parsed.games.length, 8);
assert.equal(parsed.games[0].awayCode, 'BAL');
assert.equal(parsed.games[0].homeCode, 'MIN');
assert.equal(parsed.games[0].fullRunline.lineSide, 'home');
assert.equal(parsed.games[0].fullRunline.line, '1+95');
assert.equal(parsed.games[0].fullTotal.line, '9+30');
assert.equal(parsed.games[7].awayCode, 'KC');
assert.equal(parsed.games[7].homeCode, 'LAD');
assert.equal(parsed.games.some(game => game.awayCode === 'MIN' && game.homeCode === 'MIN'), false);
assert.equal(parsed.games.some(game => /主隊總得分/.test(game.rawRowText)), false);

console.log('Tai888 content-script integration: one-cell league rows captured, 8/8 split games parsed, special team total excluded');
