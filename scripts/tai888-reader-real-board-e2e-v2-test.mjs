import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseTai888Capture } from '../reader/parser.js';
import { normalizeTai888ReaderPayload } from '../lib/tai888-reader-parser-v2.js';

const source = fs.readFileSync(new URL('../reader/row-normalizer.js', import.meta.url), 'utf8');
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context);
const normalizer = context.globalThis.Tai888RowNormalizer;

const spans = {
  time: [0, 80], teams: [80, 260], runline: [260, 380], total: [380, 500],
  moneyline: [500, 580], oneLoseTwoWin: [580, 700], first5Runline: [700, 820], first5Total: [820, 940],
};
function cell(text, left, right, top) {
  const value = String(text || '');
  return { text: value, lines: value ? [value] : [], rows: value ? [{ text: value, top, left }] : [], left, right, top, bottom: top + 20 };
}
function record(order, top, cells, text = '') {
  return { order, top, bottom: top + 20, text: text || cells.map(item => item.text).filter(Boolean).join(' '), cells: cells.filter(item => item.text) };
}
const headerLabels = ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '一輸二贏', '上半讓球', '上半大小'];
const header = record(0, 0, Object.values(spans).map((span, index) => cell(headerLabels[index], span[0], span[1], 0)));
const league = record(1, 25, [cell('聯盟：MLB 美國職棒(8)', 0, 940, 25)]);

const fixtures = [
  { pk: 1001, time: '01:10', away: 'BAL', awayId: 110, awayName: '巴爾的摩金鶯', home: 'MIN', homeId: 142, homeName: '明尼蘇達雙城', runSide: 'home', run: '1+95', total: '9+30', f5Side: 'home', f5: '0-20', f5Total: '4+50' },
  { pk: 1002, time: '02:15', away: 'PHI', awayId: 143, awayName: '費城費城人', home: 'STL', homeId: 138, homeName: '聖路易紅雀', runSide: 'away', run: '1-60', total: '8+50', f5Side: 'away', f5: '0-15', f5Total: '4+20' },
  { pk: 1003, time: '03:40', away: 'COL', awayId: 115, awayName: '科羅拉多洛磯', home: 'ARI', homeId: 109, homeName: '亞利桑那響尾蛇', runSide: 'home', run: '1-60', total: '9-90', f5Side: 'home', f5: '1+15', f5Total: '5平' },
  { pk: 1004, time: '04:10', away: 'MIL', awayId: 158, awayName: '密爾瓦基釀酒人', home: 'SD', homeId: 135, homeName: '聖地牙哥教士', runSide: 'away', run: '1+65', total: '8+20', f5Side: 'away', f5: '0-10', f5Total: '4平' },
  { pk: 1005, time: '06:40', away: 'CLE', awayId: 114, awayName: '克里夫蘭守護者', home: 'DET', homeId: 116, homeName: '底特律老虎', runSide: 'home', run: '1+60', total: '8平', f5Side: 'home', f5: '0-25', f5Total: '4+50' },
  { pk: 1006, time: '07:05', away: 'SEA', awayId: 136, awayName: '西雅圖水手', home: 'NYY', homeId: 147, homeName: '紐約洋基', runSide: 'home', run: '1+55', total: '9+30', f5Side: 'home', f5: '0-75', f5Total: '5平' },
  { pk: 1007, time: '07:07', away: 'BOS', awayId: 111, awayName: '波士頓紅襪', home: 'TOR', homeId: 141, homeName: '多倫多藍鳥', runSide: 'home', run: '1+40', total: '7-40', f5Side: 'away', f5: '0-25', f5Total: '4+50' },
  { pk: 1008, time: '10:10', away: 'KC', awayId: 118, awayName: '堪薩斯市皇家', home: 'LAD', homeId: 119, homeName: '洛杉磯道奇', runSide: 'home', run: '1-85', total: '9-50', f5Side: 'home', f5: '1+35', f5Total: '5-50' },
];

function splitRow(order, top, game, home) {
  const side = home ? 'home' : 'away';
  const runLine = game.runSide === side ? game.run : '';
  const f5Line = game.f5Side === side ? game.f5 : '';
  return record(order, top, [
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
  ]);
}

const records = [header, league];
let order = 2;
let top = 50;
for (const game of fixtures) {
  records.push(splitRow(order++, top, game, false));
  records.push(splitRow(order++, top + 22, game, true));
  top += 50;
}
records.push(record(order++, top, [cell('聯盟：MLB 美國職棒-主隊總得分(9)', 0, 940, top)]));
records.push(record(order++, top + 25, [cell('08-13', ...spans.time, top + 25), cell('MIN-明尼蘇達雙城[主]', ...spans.teams, top + 25), cell('4.5 大 1.115', ...spans.total, top + 25)]));

const normalized = normalizer.normalizeRowRecords(records, { documentLooksStandardMlb: true });
assert.equal(normalized.tables[0].rows.length, 8);
const capture = {
  sourceHost: 'www1.tai888.in',
  pageUrl: 'https://www1.tai888.in/newapp/#/BS',
  pageTitle: '泰8',
  observedAt: '2026-08-12T12:12:00Z',
  tables: [...normalized.tables, ...normalized.tables],
};
const parsed = parseTai888Capture(capture, new Date('2026-08-12T12:12:00Z'));
assert.equal(parsed.games.length, 8, 'duplicate frame captures must deduplicate to 8 games');
parsed.readerVersion = '2.0.2';
parsed.payloadHash = '0'.repeat(64);

const schedule = fixtures.map(game => ({
  gamePk: game.pk,
  awayTeamId: game.awayId,
  homeTeamId: game.homeId,
  away: game.awayName,
  home: game.homeName,
  gameDate: `2026-08-12T${String((Number(game.time.slice(0, 2)) + 16) % 24).padStart(2, '0')}:${game.time.slice(3)}:00Z`,
}));
const result = normalizeTai888ReaderPayload(parsed, schedule, {
  deviceId: 'audit-device-123456',
  receivedAt: '2026-08-12T12:12:30Z',
});
assert.equal(result.rawGameCount, 8);
assert.equal(result.matchedGameCount, 8);
assert.equal(result.unmatched.length, 0);
assert.equal(result.games.every(game => game.markets.length === 8), true);
assert.equal(result.games.reduce((sum, game) => sum + game.markets.length, 0), 64);
assert.equal(result.games[0].markets[0].pick, '明尼蘇達雙城讓1+95');
assert.equal(result.games[0].markets[1].pick, '巴爾的摩金鶯受讓1+95');
assert.equal(result.games[6].markets[0].pick, '多倫多藍鳥讓1+40');
assert.equal(result.games[6].markets[4].pick, '波士頓紅襪讓0-25');
assert.equal(result.games[7].markets[6].pick, '大5-50');
assert.equal(result.games[7].markets[7].pick, '小5-50');

console.log('Tai888 real-board E2E: 8 split-row games -> dedupe -> MLB schedule match -> 64 formal directions');
