import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { canonicalReaderPayload, parseTai888Capture } from '../reader/parser.js';
import { assessBoardCandidate, withinTai888TabScanLimit } from '../reader/board-selector.js';

const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../reader/league-registry.js', import.meta.url), 'utf8'), context);
vm.runInContext(fs.readFileSync(new URL('../reader/row-normalizer.js', import.meta.url), 'utf8'), context);
const normalizer = context.globalThis.Tai888RowNormalizer;
const labels = ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '一輸二贏', '上半讓球', '上半大小'];
const spans = labels.map((_, index) => [index * 110, (index + 1) * 110]);
const cell = (text, span, top) => ({ text, lines: text ? [text] : [], rows: text ? [{ text, top, left: span[0] }] : [], left: span[0], right: span[1], top, bottom: top + 20 });
const record = (order, top, values) => ({ order, top, bottom: top + 20, text: values.filter(Boolean).join(' '), cells: values.map((value, index) => cell(value, spans[index] || [0, 880], top)).filter(value => value.text) });
const header = (order, top, markets = [2, 3, 6, 7]) => record(order, top, labels.map((value, index) => index < 2 || markets.includes(index) ? value : ''));
const marker = (order, top, league, label) => ({ order, top, bottom: top + 20, text: `聯盟：${league} ${label}（1）`, cells: [cell(`聯盟：${league} ${label}（1）`, [0, 880], top)] });
const gameRows = (order, top, markets = [2, 3, 6, 7]) => [
  record(order, top, ['08-20', 'DET-老虎 投手[右]', markets.includes(2) ? '0.950' : '', markets.includes(3) ? '8平 大 0.940' : '', '', '', markets.includes(6) ? '0.940' : '', markets.includes(7) ? '4平 大 0.930' : '']),
  record(order + 1, top + 22, ['00:35', 'PIT-海盜［主］ 投手[右]', markets.includes(2) ? '1平 0.950' : '', markets.includes(3) ? '小 0.940' : '', '', '', markets.includes(6) ? '0.5 0.940' : '', markets.includes(7) ? '小 0.930' : '']),
];

const records = [{ order: -10, top: -10, text: 'CPBL NPB MLB KBO 左側導覽', cells: [cell('CPBL NPB MLB KBO 左側導覽', [0, 100], -10)] }];
const leagueLabels = { MLB: '美國職棒', NPB: '日本職棒', KBO: '韓國職棒', CPBL: '中華職棒' };
let order = 0;
for (const league of ['MLB', 'NPB', 'KBO', 'CPBL']) {
  records.push(header(order++, order * 30), marker(order++, order * 30, league, leagueLabels[league]), ...gameRows(order, order * 30));
  order += 2;
}
for (const league of Object.keys(leagueLabels)) {
  const result = normalizer.normalizeRowRecords(records, { expectedLeague: league });
  assert.equal(result.diagnostics.gameCount, 1, `TEST A ${league}`);
  assert.equal(result.diagnostics.sectionCount, 1);
}

for (const fixture of [
  { league: 'NPB', away: '讀賣巨人 馬場[右]', home: '阪神虎[主] 下村[右]', codes: ['YOM', 'HAN'] },
  { league: 'KBO', away: '起亞老虎 姜載[右]', home: '韓華鷹[主] 柳賢振[左]', codes: ['KIA', 'HAN'] },
  { league: 'CPBL', away: '中信兄弟 投手[右]', home: '統一獅[主] 投手[右]', codes: ['CTB', 'UNI'] },
]) {
  const asianRecords = [
    header(0, 0), marker(1, 30, fixture.league, leagueLabels[fixture.league]),
    record(2, 60, ['08-20', fixture.away, '0.950', '8平 大 0.940', '', '', '0.940', '4平 大 0.930']),
    record(3, 82, ['18:00', fixture.home, '1平 0.950', '小 0.940', '', '', '0.5 0.940', '小 0.930']),
  ];
  const normalized = normalizer.normalizeRowRecords(asianRecords, { expectedLeague: fixture.league });
  assert.equal(normalized.diagnostics.gameCount, 1, `${fixture.league} name-only board must normalize`);
  const parsed = parseTai888Capture({ ...capture(), league: fixture.league, tables: normalized.tables }, new Date('2026-08-19T16:00:00.000Z'));
  assert.equal(parsed.games.length, 1);
  assert.deepEqual([parsed.games[0].awayCode, parsed.games[0].homeCode], fixture.codes);
}

function capture(markets = [2, 3, 6, 7]) {
  const values = [
    { pair: ['08-20', '00:35'] }, { pair: ['DET-老虎 投手[右]', 'PIT-海盜［主］ 投手[右]'] },
    { pair: markets.includes(2) ? ['0.950', '1平 0.950'] : ['', ''] }, { pair: markets.includes(3) ? ['8平 大 0.940', '小 0.940'] : ['', ''] },
    { pair: ['', ''] }, { pair: ['', ''] }, { pair: markets.includes(6) ? ['0.940', '0.5 0.940'] : ['', ''] }, { pair: markets.includes(7) ? ['4平 大 0.930', '小 0.930'] : ['', ''] },
  ];
  return { version: 'TAI888-DOM-CAPTURE-v2.2.0', league: 'MLB', sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/#/BS', observedAt: '2026-08-19T16:00:00.000Z', tables: [{ headers: labels, rows: [{ cells: values, text: 'DET PIT' }] }], diagnostics: { gameCount: 1, expectedGameCount: 1, lastMutationAt: '2026-08-19T15:59:59.000Z' } };
}

for (const [markets, expected] of [[[2, 3], 2], [[2, 3, 6], 3], [[2, 3, 6, 7], 4]]) {
  const raw = capture(markets);
  const parsed = parseTai888Capture(raw, new Date('2026-08-19T16:00:00.000Z'));
  assert.equal([parsed.games[0].fullRunline, parsed.games[0].fullTotal, parsed.games[0].first5Runline, parsed.games[0].first5Total].filter(Boolean).length, expected);
  assert.equal(assessBoardCandidate({ tabId: 1, frameId: 0, active: true, capture: raw, parsed }, Date.parse('2026-08-19T16:00:00.000Z')).ok, true);
}

const malformed = capture([2, 3]);
malformed.tables[0].rows[0].cells[6] = { pair: ['0.5 0.940', ''] };
const blocked = parseTai888Capture(malformed, new Date('2026-08-19T16:00:00.000Z')).games[0];
assert.equal(blocked.marketStates.FIRST_HALF_HANDICAP, 'BLOCKED');
assert.ok(blocked.fullRunline && blocked.fullTotal);
assert.equal(blocked.first5Runline, null);

let prior = '';
for (const markets of [[], [2, 3], [2, 3, 6], [2, 3, 6, 7], [2, 3], []]) {
  const parsed = parseTai888Capture(capture(markets), new Date('2026-08-19T16:00:00.000Z'));
  const hash = canonicalReaderPayload(parsed);
  assert.notEqual(hash, prior);
  prior = hash;
  const game = parsed.games[0];
  assert.equal([game.fullRunline, game.fullTotal, game.first5Runline, game.first5Total].filter(Boolean).length, markets.length);
}

const contentSource = fs.readFileSync(new URL('../reader/tai888-content.js', import.meta.url), 'utf8');
const backgroundSource = fs.readFileSync(new URL('../reader/background.js', import.meta.url), 'utf8');
assert.match(contentSource, /activityByLeague/);
assert.match(contentSource, /fingerprintByLeague/);
assert.match(contentSource, /fingerprint !== fingerprintByLeague\[league\]/);
assert.doesNotMatch(contentSource, /document\.body\.innerText|document\.body\?\.innerText/);
assert.match(backgroundSource, /pendingRerun = true/);
assert.match(backgroundSource, /if \(pendingRerun\)/);
assert.match(backgroundSource, /answer\?\.capture\?\.captures/);
assert.equal(withinTai888TabScanLimit(5), true);
assert.doesNotMatch(backgroundSource, /最多檢查/);
console.log('Reader 2.1.9 Asian name-safe plus league-scoped partial-safe TEST A-J PASS');
