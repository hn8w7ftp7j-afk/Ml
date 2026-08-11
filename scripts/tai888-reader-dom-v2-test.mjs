import assert from 'node:assert/strict';
import { parseTai888Capture } from '../reader/parser.js';

const headers = ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '一輸二贏', '上半讓球', '上半大小'];
const row = (...cells) => ({ cells: cells.map(lines => ({ lines })), text: cells.flat().join(' ') });
const capture = {
  sourceHost: 'www1.tai888.in', pageUrl: 'https://www1.tai888.in/board', pageTitle: '泰8', observedAt: '2026-08-12T05:30:00+08:00',
  tables: [{ headers, rows: [
    row(['08-12', '06:40'], ['PIT-海盜', 'MIA-馬林魚[主]'], ['1+85 0.950', '0.950'], ['7-10 大 0.940', '小 0.940'], [], [], ['0-15 0.940', '0.940'], ['3.5 大 0.930', '小 0.930']),
    row(['08-12', '06:40'], ['CLE-守護者', 'DET-老虎[主]'], ['0.950', '1+20 0.950'], ['8+30', '大 0.940', '小 0.940'], [], [], ['0.940', '0-90 0.940'], ['4-60 大 0.930', '小 0.930']),
    row(['08-12', '07:05'], ['SEA-水手', 'NYY-洋基[主]'], ['0.950', '1+35 0.950'], ['8平 大 0.940', '小 0.940'], [], [], ['0.940', '0-50 0.940'], ['4-30 大 0.930', '小 0.930']),
  ] }],
};
const parsed = parseTai888Capture(capture, new Date('2026-08-12T00:00:00Z'));
assert.equal(parsed.games.length, 3);
assert.equal(parsed.games[0].fullRunline.line, '1+85');
assert.equal(parsed.games[1].fullRunline.lineSide, 'home');
assert.equal(parsed.games[1].fullTotal.line, '8+30');
assert.equal(parsed.games[1].first5Runline.line, '0-90');
assert.equal(parsed.games[2].fullTotal.line, '8平');
assert.equal(parsed.games[0].first5Total.line, '3.5');
console.log('tai888 reader DOM parser v2: ok');
