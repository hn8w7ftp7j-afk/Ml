import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseTai888Capture } from '../reader/parser.js';

const source = fs.readFileSync(new URL('../reader/row-normalizer.js', import.meta.url), 'utf8');
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context);
const normalizer = context.globalThis.Tai888RowNormalizer;
assert.ok(normalizer?.normalizeRowRecords, 'row normalizer missing');
assert.equal(normalizer.version, 'TAI888-SPLIT-ROW-NORMALIZER-v2.0.2');

const spans = {
  time: [0, 80], teams: [80, 260], runline: [260, 380], total: [380, 500],
  moneyline: [500, 580], oneLoseTwoWin: [580, 700], first5Runline: [700, 820], first5Total: [820, 940],
};

function cell(text, left, right, top) {
  const value = String(text || '');
  return {
    text: value,
    lines: value ? [value] : [],
    rows: value ? [{ text: value, top, left }] : [],
    left, right, top, bottom: top + 20,
  };
}

function record(order, top, cells, text = '') {
  return {
    order,
    top,
    bottom: top + 20,
    text: text || cells.map(item => item.text).filter(Boolean).join(' '),
    cells: cells.filter(item => item.text),
  };
}

const headerLabels = ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '一輸二贏', '上半讓球', '上半大小'];
const header = record(0, 0, Object.values(spans).map((span, index) => cell(headerLabels[index], span[0], span[1], 0)));
// This marker intentionally has exactly one cell, matching the live Tai888 colspan row.
const league = record(1, 25, [cell('聯盟：MLB 美國職棒(8)', 0, 940, 25)]);

const fixtures = [
  { time: '01:10', away: 'BAL', home: 'MIN', runSide: 'home', run: '1+95', total: '9+30', f5Side: 'home', f5: '0-20', f5Total: '4+50' },
  { time: '02:15', away: 'PHI', home: 'STL', runSide: 'away', run: '1-60', total: '8+50', f5Side: 'away', f5: '0-15', f5Total: '4+20' },
  { time: '03:40', away: 'COL', home: 'ARI', runSide: 'home', run: '1-60', total: '9-90', f5Side: 'home', f5: '1+15', f5Total: '5平' },
  { time: '04:10', away: 'MIL', home: 'SD', runSide: 'away', run: '1+65', total: '8+20', f5Side: 'away', f5: '0-10', f5Total: '4平' },
  { time: '06:40', away: 'CLE', home: 'DET', runSide: 'home', run: '1+60', total: '8平', f5Side: 'home', f5: '0-25', f5Total: '4+50' },
  { time: '07:05', away: 'SEA', home: 'NYY', runSide: 'home', run: '1+55', total: '9+30', f5Side: 'home', f5: '0-75', f5Total: '5平' },
  { time: '07:07', away: 'BOS', home: 'TOR', runSide: 'home', run: '1+40', total: '7-40', f5Side: 'away', f5: '0-25', f5Total: '4+50' },
  { time: '10:10', away: 'KC', home: 'LAD', runSide: 'home', run: '1-85', total: '9-50', f5Side: 'home', f5: '1+35', f5Total: '5-50' },
];

function splitRow(order, top, game, home) {
  const side = home ? 'home' : 'away';
  const runLine = game.runSide === side ? game.run : '';
  const f5Line = game.f5Side === side ? game.f5 : '';
  const cells = [
    cell(home ? game.time : '08-13', ...spans.time, top),
    cell(`${home ? game.home : game.away}-${home ? '主隊名稱[主]' : '客隊名稱'} 投手[右]`, ...spans.teams, top),
    cell(runLine, spans.runline[0], spans.runline[0] + 55, top),
    cell('0.950', spans.runline[0] + 55, spans.runline[1], top),
    cell(home ? '小' : `${game.total} 大`, spans.total[0], spans.total[0] + 70, top),
    cell('0.940', spans.total[0] + 70, spans.total[1], top),
    cell(home ? '0.760' : '0.990', ...spans.moneyline, top),
    cell(home ? '1.5 1.660' : '1.5 0.530', ...spans.oneLoseTwoWin, top),
    cell(f5Line, spans.first5Runline[0], spans.first5Runline[0] + 55, top),
    cell('0.940', spans.first5Runline[0] + 55, spans.first5Runline[1], top),
    cell(home ? '小' : `${game.f5Total} 大`, spans.first5Total[0], spans.first5Total[0] + 70, top),
    cell('0.930', spans.first5Total[0] + 70, spans.first5Total[1], top),
  ];
  return record(order, top, cells);
}

const records = [header, league];
let order = 2;
let top = 50;
for (const game of fixtures) {
  records.push(splitRow(order++, top, game, false));
  records.push(splitRow(order++, top + 22, game, true));
  top += 50;
}
// Special market starts with another one-cell league marker and must terminate standard parsing.
records.push(record(order++, top, [cell('聯盟：MLB 美國職棒-主隊總得分(9)', 0, 940, top)]));
records.push(record(order++, top + 25, [
  cell('08-13', ...spans.time, top + 25),
  cell('MIN-明尼蘇達雙城[主]', ...spans.teams, top + 25),
  cell('4.5 大 1.115', ...spans.total, top + 25),
]));

const normalized = normalizer.normalizeRowRecords(records, { documentLooksStandardMlb: true });
assert.equal(normalized.tables.length, 1);
assert.equal(normalized.tables[0].rows.length, 8);
assert.equal(normalized.diagnostics.pairedRows, 8);
assert.equal(normalized.diagnostics.gameCount, 8);
assert.equal(normalized.diagnostics.sawLeagueMarker, true);

const capture = {
  sourceHost: 'www1.tai888.in',
  pageUrl: 'https://www1.tai888.in/newapp/#/BS',
  pageTitle: '泰8',
  observedAt: '2026-08-12T12:12:00Z',
  tables: normalized.tables,
};
const parsed = parseTai888Capture(capture, new Date('2026-08-12T12:12:00Z'));
assert.equal(parsed.version, 'TAI888-READER-DOM-v2.0.2');
assert.equal(parsed.boardDate, '2026-08-13');
assert.equal(parsed.games.length, 8);
assert.equal(parsed.games[0].awayCode, 'BAL');
assert.equal(parsed.games[0].homeCode, 'MIN');
assert.equal(parsed.games[0].fullRunline.lineSide, 'home');
assert.equal(parsed.games[0].fullRunline.line, '1+95');
assert.equal(parsed.games[0].fullRunline.awayWater, 0.95);
assert.equal(parsed.games[0].fullRunline.homeWater, 0.95);
assert.equal(parsed.games[0].fullTotal.line, '9+30');
assert.equal(parsed.games[0].first5Runline.lineSide, 'home');
assert.equal(parsed.games[1].fullRunline.lineSide, 'away');
assert.equal(parsed.games[6].awayCode, 'BOS');
assert.equal(parsed.games[6].homeCode, 'TOR');
assert.equal(parsed.games[7].first5Total.line, '5-50');
assert.equal(parsed.games.some(game => /總得分/.test(game.rawRowText)), false);

console.log('Tai888 Reader 2.0.2 split-row fixture: 8/8 standard MLB games parsed; team-total section excluded');
