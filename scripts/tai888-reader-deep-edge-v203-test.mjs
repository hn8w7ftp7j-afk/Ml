import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseTai888Capture, canonicalReaderPayload } from '../reader/parser.js';
import { rawTai888ReaderPayloadHash } from '../lib/tai888-reader-parser-v2.js';

const normalizerSource = fs.readFileSync(new URL('../reader/row-normalizer.js', import.meta.url), 'utf8');
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(normalizerSource, context);
const normalizer = context.globalThis.Tai888RowNormalizer;
assert.ok(normalizer?.normalizeRowRecords);

const spans = {
  time: [0, 80], teams: [80, 260], runline: [260, 380], total: [380, 500],
  moneyline: [500, 580], oneLoseTwoWin: [580, 700], first5Runline: [700, 820], first5Total: [820, 940],
};
function cell(text, left, right, top, rows = null) {
  const value = String(text || '');
  return {
    text: value,
    lines: rows ? rows.map(row => row.text) : value ? [value] : [],
    rows: rows || (value ? [{ text: value, top, left }] : []),
    left, right, top, bottom: top + 20,
  };
}
function record(order, top, cells, text = '') {
  return { order, top, bottom: top + 20, text: text || cells.map(item => item.text).filter(Boolean).join(' '), cells: cells.filter(item => item.text) };
}
const headerLabels = ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '一輸二贏', '上半讓球', '上半大小'];
const header = record(0, 0, Object.values(spans).map((span, index) => cell(headerLabels[index], span[0], span[1], 0)));
const league = record(1, 25, [cell('聯盟：MLB 美國職棒(1)', 0, 940, 25)]);

// The away team text is intentionally repeated on two visual lines to emulate a wrapped text node.
const awayTeamRows = [
  { text: 'BAL-巴爾的摩金鶯 投手[右]', top: 50, left: 80 },
  { text: 'BAL-巴爾的摩金鶯 投手[右]', top: 62, left: 80 },
];
const away = record(2, 50, [
  cell('08-13', ...spans.time, 50),
  cell('BAL-巴爾的摩金鶯 投手[右]', ...spans.teams, 50, awayTeamRows),
  cell('0.950', ...spans.runline, 50),
  cell('9+30 大 0.940', ...spans.total, 50),
  cell('0.990', ...spans.moneyline, 50),
  cell('1.5 0.530', ...spans.oneLoseTwoWin, 50),
  cell('0.940', ...spans.first5Runline, 50),
  cell('4+50 大 0.930', ...spans.first5Total, 50),
]);
const home = record(3, 72, [
  cell('01:10', ...spans.time, 72),
  cell('MIN-明尼蘇達雙城［主］ 投手[右]', ...spans.teams, 72),
  cell('1+95 0.950', ...spans.runline, 72),
  cell('小 0.940', ...spans.total, 72),
  cell('0.760', ...spans.moneyline, 72),
  cell('1.5 1.660', ...spans.oneLoseTwoWin, 72),
  cell('0-20 0.940', ...spans.first5Runline, 72),
  cell('小 0.930', ...spans.first5Total, 72),
]);

const normalized = normalizer.normalizeRowRecords([header, league, away, home], { documentLooksStandardMlb: true });
assert.equal(normalized.diagnostics.expectedGameCount, 1);
assert.equal(normalized.diagnostics.gameCount, 1);
assert.equal(normalized.tables[0].rows.length, 1, 'wrapped duplicate team code must not fake a two-team row');

const capture = {
  sourceHost: 'www1.tai888.in',
  pageUrl: 'https://www1.tai888.in/newapp/#/BS',
  pageTitle: '泰8',
  observedAt: '2026-08-12T12:12:00Z',
  tables: normalized.tables,
};
const parsed = parseTai888Capture(capture, new Date('2026-08-12T12:12:00Z'));
assert.equal(parsed.version, 'TAI888-READER-DOM-v2.0.3');
assert.equal(parsed.games.length, 1);
assert.equal(parsed.games[0].awayCode, 'BAL');
assert.equal(parsed.games[0].homeCode, 'MIN');
assert.equal(parsed.games[0].fullRunline.lineSide, 'home');
assert.equal(parsed.games[0].fullRunline.line, '1+95');

// Both sides showing a runline is ambiguous and must not be guessed.
const ambiguousRunline = structuredClone(normalized.tables);
ambiguousRunline[0].rows[0].cells[2].pair = ['1+95 0.950', '1+95 0.950'];
const ambiguousRunlineParsed = parseTai888Capture({ ...capture, tables: ambiguousRunline }, new Date('2026-08-12T12:12:00Z'));
assert.equal(ambiguousRunlineParsed.games[0].fullRunline, null);
assert.ok(ambiguousRunlineParsed.games[0].fullTotal);

// A total without a complementary 大/小 pair must not be silently assigned by row order.
const ambiguousTotal = structuredClone(normalized.tables);
ambiguousTotal[0].rows[0].cells[3].pair = ['9+30 0.940', '0.940'];
const ambiguousTotalParsed = parseTai888Capture({ ...capture, tables: ambiguousTotal }, new Date('2026-08-12T12:12:00Z'));
assert.equal(ambiguousTotalParsed.games[0].fullTotal, null);
assert.ok(ambiguousTotalParsed.games[0].fullRunline);

const payloadA = { ...parsed, readerVersion: '2.0.3', pageActivityAt: '2026-08-12T12:11:59Z' };
const payloadB = { ...payloadA, games: [...payloadA.games].reverse() };
assert.equal(canonicalReaderPayload(payloadA), canonicalReaderPayload(payloadB), 'client price fingerprint must not depend on row order');
assert.equal(rawTai888ReaderPayloadHash(payloadA), rawTai888ReaderPayloadHash(payloadB), 'server raw-board hash must not depend on row order');

console.log('Tai888 Reader 2.0.3 deep edge cases: wrapped teams, full-width home marker, ambiguous contracts and deterministic hashes passed');
