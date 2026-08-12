import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { parseTai888Capture } from '../reader/parser.js';

const columns = [
  ['時間', 0, 80], ['主客隊伍', 80, 260], ['讓球', 260, 380], ['大小盤', 380, 500],
  ['獨贏', 500, 580], ['一輸二贏', 580, 700], ['上半讓球', 700, 820], ['上半大小', 820, 940],
];

function cells(values, top) {
  return values.map(([text, left, right]) => `<td data-left="${left}" data-right="${right}" data-top="${top}">${text}</td>`).join('');
}

function gameRows({ top, date, time, away, home, runSide, run, total, first5Side, first5, first5Total }) {
  const awayRun = runSide === 'away' ? run : '';
  const homeRun = runSide === 'home' ? run : '';
  const awayFirst5 = first5Side === 'away' ? first5 : '';
  const homeFirst5 = first5Side === 'home' ? first5 : '';
  const away = [
    [date, 0, 80], [`${away}-客隊名稱 投手[右]`, 80, 260],
    [awayRun, 260, 315], ['0.950', 315, 380],
    [`${total} 大`, 380, 450], ['0.940', 450, 500],
    ['0.990', 500, 580], ['1.5 0.530', 580, 700],
    [awayFirst5, 700, 755], ['0.940', 755, 820],
    [`${first5Total} 大`, 820, 890], ['0.930', 890, 940],
  ];
  const home = [
    [time, 0, 80], [`${home}-主隊名稱[主] 投手[右]`, 80, 260],
    [homeRun, 260, 315], ['0.950', 315, 380],
    ['小', 380, 450], ['0.940', 450, 500],
    ['0.760', 500, 580], ['1.5 1.660', 580, 700],
    [homeFirst5, 700, 755], ['0.940', 755, 820],
    ['小', 820, 890], ['0.930', 890, 940],
  ];
  return `<tr data-top="${top}">${cells(away, top)}</tr><tr data-top="${top + 22}">${cells(home, top + 22)}</tr>`;
}

const header = columns.map(([text, left, right]) => `<th data-left="${left}" data-right="${right}" data-top="0">${text}</th>`).join('');
const html = `<!doctype html><html><body>
<table>
<tr data-top="0">${header}</tr>
<tr data-top="25"><td colspan="12" data-left="0" data-right="940" data-top="25">聯盟：MLB 美國職棒(2)</td></tr>
${gameRows({ top: 50, date: '08-13', time: '01:10', away: 'BAL', home: 'MIN', runSide: 'home', run: '1+95', total: '9+30', first5Side: 'home', first5: '0-20', first5Total: '4+50' })}
${gameRows({ top: 100, date: '08-13', time: '07:07', away: 'BOS', home: 'TOR', runSide: 'home', run: '1+40', total: '7-40', first5Side: 'away', first5: '0-25', first5Total: '4+50' })}
<tr data-top="150"><td colspan="12" data-left="0" data-right="940" data-top="150">聯盟：MLB 美國職棒-主隊總得分(9)</td></tr>
<tr data-top="175">${cells([['08-13',0,80],['MIN-明尼蘇達雙城[主]',80,260],['4.5 大 1.115',380,500]],175)}</tr>
</table>
</body></html>`;

const dom = new JSDOM(html, {
  url: 'https://www1.tai888.in/newapp/#/BS',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
  configurable: true,
  get() { return this.textContent; },
});
window.getComputedStyle = element => ({
  display: element.tagName === 'TR' ? 'table-row' : element.tagName === 'TD' || element.tagName === 'TH' ? 'table-cell' : 'block',
  visibility: 'visible',
  opacity: '1',
});
window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  const left = Number(this.dataset?.left ?? 0);
  const right = Number(this.dataset?.right ?? (this.tagName === 'TR' ? 940 : left + 100));
  const top = Number(this.dataset?.top ?? 0);
  const bottom = top + 20;
  return { left, right, top, bottom, width: right - left, height: 20, x: left, y: top, toJSON() { return this; } };
};
if (window.Range?.prototype) window.Range.prototype.getClientRects = () => [];
let listener = null;
window.chrome = {
  runtime: {
    onMessage: { addListener(callback) { listener = callback; } },
    sendMessage() { return Promise.resolve({ ok: true }); },
  },
};

const context = dom.getInternalVMContext();
vm.runInContext(fs.readFileSync(new URL('../reader/row-normalizer.js', import.meta.url), 'utf8'), context);
vm.runInContext(fs.readFileSync(new URL('../reader/tai888-content.js', import.meta.url), 'utf8'), context);
assert.equal(typeof listener, 'function');

const response = await new Promise(resolve => {
  listener({ type: 'TAI888_CAPTURE_MLB_TABLE' }, {}, resolve);
});
assert.equal(response.ok, true, response.error);
assert.equal(response.capture.version, 'TAI888-DOM-CAPTURE-v2.0.2');
assert.equal(response.capture.tables.length, 1);
assert.equal(response.capture.tables[0].rows.length, 2);
assert.equal(response.capture.diagnostics.sawLeagueMarker, true);
assert.equal(response.capture.diagnostics.gameCount, 2);

const parsed = parseTai888Capture(response.capture, new Date('2026-08-12T12:00:00Z'));
assert.equal(parsed.games.length, 2);
assert.equal(parsed.games[0].awayCode, 'BAL');
assert.equal(parsed.games[0].homeCode, 'MIN');
assert.equal(parsed.games[0].fullRunline.lineSide, 'home');
assert.equal(parsed.games[0].fullRunline.line, '1+95');
assert.equal(parsed.games[0].fullTotal.line, '9+30');
assert.equal(parsed.games[0].first5Runline.line, '0-20');
assert.equal(parsed.games[1].awayCode, 'BOS');
assert.equal(parsed.games[1].homeCode, 'TOR');
assert.equal(parsed.games.some(game => /主隊總得分/.test(game.rawRowText)), false);

console.log('Tai888 content-script DOM integration: split rows captured, one-cell league boundaries honored, special market excluded');
