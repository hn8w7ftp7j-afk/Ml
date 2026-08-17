import assert from 'node:assert/strict';
import { parseTai888Capture, sanitizeTai888PageUrl } from '../reader/parser.js';
import { validateStandardReaderGame } from '../reader/board-selector.js';

const headers = ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '一輸二贏', '上半讓球', '上半大小'];
const row = (...cells) => ({ cells: cells.map(lines => ({ lines })), text: cells.flat().join(' ') });
const querySecret = 'DOM_QUERY_SECRET';
const hashSecret = 'DOM_HASH_SECRET';
const titleSecret = 'DOM_TITLE_SECRET';
const frameSecret = 'DOM_FRAME_SECRET';
const capture = {
  league: 'MLB',
  sourceHost: 'www1.tai888.in',
  pageUrl: `https://www1.tai888.in/newapp/?token=${querySecret}#/BS?session=${hashSecret}`,
  pageTitle: titleSecret,
  frameUrl: `https://www1.tai888.in/frame?token=${frameSecret}#private`,
  observedAt: '2026-08-12T05:30:00+08:00',
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
assert.equal(parsed.pageUrl, 'https://www1.tai888.in/newapp/#/BS');
assert.equal(Object.hasOwn(parsed, 'pageTitle'), false);
assert.equal(Object.hasOwn(parsed, 'frameUrl'), false);
const serialized = JSON.stringify(parsed);
for (const secret of [querySecret, hashSecret, titleSecret, frameSecret]) {
  assert.equal(serialized.includes(secret), false, `${secret} must not survive parser output`);
}
assert.equal(
  sanitizeTai888PageUrl('https://www1.tai888.in/newapp/board?token=secret#arbitrary-hash'),
  'https://www1.tai888.in/newapp/board',
);
assert.equal(
  sanitizeTai888PageUrl('https://www1.tai888.in/newapp/#/BS/private?token=secret'),
  'https://www1.tai888.in/newapp/#/BS',
);
assert.equal(sanitizeTai888PageUrl('https://www1.tai888.in/newapp/#/BS-secret'), 'https://www1.tai888.in/newapp/');
assert.equal(sanitizeTai888PageUrl('http://www1.tai888.in/newapp/#/BS'), '');
assert.equal(sanitizeTai888PageUrl('https://tai888.in.evil.example/newapp/#/BS'), '');

const alphanumericCapture = {
  ...capture,
  league: 'CPBL',
  tables: [{ headers, rows: [
    row(['08-12', '10:00'], ['ACN011-中信兄弟', 'ADD011-統一獅[主]'], ['1平 0.950', '0.950'], ['8平 大 0.940', '小 0.940'], [], [], ['0.5 0.940', '0.940'], ['4平 大 0.930', '小 0.930']),
    row(['02-30', '10:05'], ['AAA011-味全龍', 'AKP011-台鋼雄鷹[主]'], ['1-20 0.950', '0.950'], ['8平 大 0.940', '小 0.940'], [], [], ['0.5 0.940', '0.940'], ['4平 大 0.930', '小 0.930']),
    row(['10:10'], ['AJL011-樂天桃猿', 'AEO011-富邦悍將[主]'], ['1-20 0.950', '0.950'], ['8平 大 0.940', '小 0.940'], [], [], ['0.5 0.940', '0.940'], ['4平 大 0.930', '小 0.930']),
  ] }],
};
const alphanumeric = parseTai888Capture(alphanumericCapture, new Date('2026-08-12T00:00:00Z'));
assert.equal(alphanumeric.league, 'CPBL');
assert.equal(alphanumeric.games.length, 1, 'invalid/missing dates must not fall back to a runline token such as 1-20');
assert.equal(alphanumeric.games[0].awayCode, 'ACN011');
assert.equal(alphanumeric.games[0].homeCode, 'ADD011');
assert.equal(validateStandardReaderGame(alphanumeric.games[0]).directionCount, 8);

for (const fixture of [
  { league: 'NPB', awayCode: 'G', homeCode: 'T', awayLabel: '巨人', homeLabel: '阪神' },
  { league: 'KBO', awayCode: 'LG', homeCode: 'KT', awayLabel: 'LG雙子', homeLabel: 'KT巫師' },
]) {
  const leagueCapture = {
    ...capture,
    league: fixture.league,
    tables: [{ headers, rows: [
      row(['08-12', '10:00'], [`${fixture.awayCode}-${fixture.awayLabel}`, `${fixture.homeCode}-${fixture.homeLabel}[主]`], ['1平 0.950', '0.950'], ['8平 大 0.940', '小 0.940'], [], [], ['0.5 0.940', '0.940'], ['4平 大 0.930', '小 0.930']),
    ] }],
  };
  const leagueParsed = parseTai888Capture(leagueCapture, new Date('2026-08-12T00:00:00Z'));
  assert.equal(leagueParsed.league, fixture.league);
  assert.equal(leagueParsed.games.length, 1);
  assert.equal(leagueParsed.games[0].awayCode, fixture.awayCode);
  assert.equal(leagueParsed.games[0].homeCode, fixture.homeCode);
  assert.equal(validateStandardReaderGame(leagueParsed.games[0]).directionCount, 8);
}
console.log('tai888 reader DOM parser v2: ok');
