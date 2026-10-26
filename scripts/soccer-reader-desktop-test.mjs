import assert from 'node:assert/strict';
import { readerSaveReceiptFixture } from './reader-save-receipt-fixture.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload } from '../reader/parser.js';
import { readerPayloadsByDate, selectAuthoritativeBoard, selectAuthoritativeSoccerBoards, shouldSkipSuccessfulPayload } from '../reader/board-selector.js';
import { validateSoccerCapture, matchSoccerReaderGames } from '../lib/soccer/reader.js';
import { createReaderToken, verifyReaderToken } from '../lib/reader-auth-v2.js';

// Text and relative coordinates reconstructed from IMG_3533.jpeg. This is a
// desktop table regression fixture, not a recorded live DOM or a verified
// football settlement contract. The final two rows are separate prop markets.
import { manifest, now, Clock, captureDesktop } from './helpers/soccer-reader-dom-fixture.mjs';

function assertFootball(capture) {
  const parsed = parseTai888Capture(capture, new Date(now));
  assert.deepEqual(parsed.parseIssues, [], JSON.stringify(parsed));
  assert.equal(parsed.games.length, 1, 'three alternative quote rows belong to one event; prop rows are excluded');
  const game = parsed.games[0];
  assert.equal(game.boardDate, '2026-10-20'); assert.equal(game.boardTime, '03:00');
  assert.equal(game.homeKey, globalThis.Tai888SoccerTeams.key(capture.league === 'EPL' ? 'Tottenham' : 'Real Madrid'));
  assert.equal(game.awayKey, globalThis.Tai888SoccerTeams.key(capture.league === 'EPL' ? 'Coventry City' : 'Barcelona'));
  assert.equal(game.markets.length, 10, 'seven unlabelled-period goal quotes and three explicitly first-half handicaps');
  const unknown = game.markets.filter(market => market.period === 'UNKNOWN');
  assert.equal(unknown.length, 7, 'the plain screenshot headers do not assert a full-time period');
  assert.ok(unknown.every(market => market.periodEvidence.status === 'UNKNOWN'));
  const handicaps = unknown.filter(market => market.kind === 'HANDICAP');
  assert.deepEqual(handicaps.map(market => [market.line, market.lineSide, market.homeWater, market.awayWater]), [
    ['1-50', 'home', 1.070, .810], ['1平', 'home', .790, 1.100], ['1.5', 'home', 1.320, .640],
  ]);
  assert.deepEqual(unknown.filter(market => market.kind === 'TOTAL').map(market => [market.line, market.overWater, market.underWater]), [
    ['3平', .920, .940], ['3+50', .700, 1.190], ['3-50', 1.190, .700],
  ]);
  assert.deepEqual(game.markets.filter(market => market.period === 'HT').map(market => [market.kind, market.line, market.lineSide, market.homeWater, market.awayWater]), [
    ['HANDICAP', '0.5', 'home', .970, .910], ['HANDICAP', '0-50', 'home', .660, 1.390], ['HANDICAP', '1+50', 'home', 1.370, .610],
  ]);
  assert.ok(game.markets.filter(market => market.period === 'HT').every(market => market.periodEvidence.status === 'EXPLICIT' && /上半/.test(market.periodEvidence.marketHeader)));
  assert.deepEqual([...game.periodsCovered].sort(), ['HT', 'UNKNOWN']);
  const moneyline = game.markets.find(market => market.kind === 'MONEYLINE');
  assert.deepEqual([moneyline.homeWater, moneyline.drawWater, moneyline.awayWater], [.390, 3.650, 4.600]);
  assert.ok(game.markets.every(market => market.unit === 'GOALS'));
  assert.equal(parsed.executable, false);
  assert.equal(JSON.stringify(parsed.sourceCapture).includes('角球數'), false);
  assert.equal(JSON.stringify(parsed.sourceCapture).includes('罰牌數'), false);
  const wire = { ...parsed, readerVersion: manifest.version, pageActivityAt: new Date(now).toISOString() };
  const checked = validateSoccerCapture(wire, { now, headerVersion: manifest.version });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const official = {
    id: `soccer:${capture.league.toLowerCase()}:desktop-fixture`, league: capture.league.toLowerCase(),
    date: game.boardDate, startTime: '2026-10-19T19:00:00.000Z', status: 'scheduled',
    home: { name: capture.league === 'EPL' ? 'Tottenham Hotspur' : 'Real Madrid' },
    away: { name: capture.league === 'EPL' ? 'Coventry City' : 'Barcelona' },
  };
  assert.equal(matchSoccerReaderGames(checked.payload, [official], now)[0].officialGameId, official.id,
    'desktop Chinese team labels must match the official English team identities');
  assert.equal(matchSoccerReaderGames(checked.payload, [{ ...official, home: official.away, away: official.home }], now)[0].matchStatus, 'UNMATCHED');
  const selection = selectAuthoritativeBoard([{ tabId: 1, frameId: 0, active: true, capture, parsed }], { now, league: capture.league });
  assert.equal(selection.ok, true, JSON.stringify(selection.assessed));
  return wire;
}

const captures = ['EPL', 'UCL'].map(league => {
  const capture = captureDesktop(league); assertFootball(capture); return capture;
});
assertFootball(captureDesktop('EPL', { homeFirst: false }));
assertFootball(captureDesktop('EPL', { separatedRows: true }));
for (const layout of ['table', 'split-tables', 'nested-tables', 'div-grid']) for (const malformed of [false, true]) {
  const capture = captureDesktop('UCL', { layout, malformed, malformedAlternative: !malformed, headingCount: 36 });
  const parsed = parseTai888Capture(capture, new Date(now));
  assert.deepEqual(capture.diagnostics.tableIssues, []);
  assert.equal(capture.diagnostics.skippedAlternativeCount, 1);
  assert.equal(capture.diagnostics.expectedGameCount, 1, 'an excluded alternative cannot remove the already validated match');
  assert.equal(parsed.games.length, 1);
  assert.equal(parsed.games[0].markets.length, malformed ? 6 : 7);
  assert.ok(parsed.games[0].markets.every(market => !market.rawRows.some(value => value.includes('UNKNOWN'))));
  assert.ok(Object.values(parsed.games[0].periodStates).every(value => value === 'open'), 'unreadable odds never become lock outcomes');
  const healthy = parseTai888Capture(captureDesktop('UCL', { layout, headingCount: 36 }), new Date(now));
  for (const market of parsed.games[0].markets) assert.ok(healthy.games[0].markets.some(value => JSON.stringify(value) === JSON.stringify(market)), 'all retained contracts and prices remain exact');
  assert.equal(selectAuthoritativeSoccerBoards([{ capture, parsed, tabId: 1, frameId: 0 }], { now, league: 'UCL' }).ok, true);
  assert.equal(validateSoccerCapture({ ...parsed, readerVersion: manifest.version, pageActivityAt: new Date(now).toISOString() }, { now, headerVersion: manifest.version }).ok, true);
  assert.ok(JSON.stringify(capture.diagnostics.samples[0]).includes('UNKNOWN'), 'diagnostics prioritise the actual rejected alternative rather than the first healthy rows');
}
// IMG_3535: the (36) heading counts displayed rows, including card props.
{
  const capture = captureDesktop('UCL', { malformed: true, singleRow: true });
  const parsed = parseTai888Capture(capture, new Date(now));
  assert.equal(capture.diagnostics.skippedAlternativeCount, 0);
  assert.ok(capture.diagnostics.tableIssues.includes('SOCCER_TABLE_QUOTES_AMBIGUOUS'));
  assert.equal(selectAuthoritativeSoccerBoards([{ capture, parsed, tabId: 1, frameId: 0 }], { now, league: 'UCL' }).ok, false,
    'a sole unreadable match cannot disappear to make a board look complete');
}
for (const cardProp of ['副牌數', '副牌数']) {
  const capture = captureDesktop('UCL', { headingCount: 36, cardProp, malformedCard: true });
  assert.equal(capture.diagnostics.expectedGameCount, 1);
  assert.equal(capture.diagnostics.excludedProps, 2);
  assertFootball(capture);
  assert.equal(JSON.stringify(capture.tables).includes(cardProp), false);
}
{
  const file = 'soccer-table-normalizer.js';
  const previous = fs.readFileSync(`reader/${file}`, 'utf8').replace('角球|副牌|', '角球|');
  const capture = captureDesktop('UCL', { headingCount: 36, cardProp: '副牌數', malformedCard: true,
    sourceOverrides: { [file]: previous } });
  const parsed = parseTai888Capture(capture, new Date(now));
  assert.equal(capture.diagnostics.expectedGameCount, null);
  const result = selectAuthoritativeBoard([{ capture, parsed, tabId: 1, frameId: 0 }], { now, league: 'UCL' });
  assert.equal(result.ok, false, 'a malformed non-goal card row blocked valid goal odds before this fix');
  assert.ok(result.assessed[0].issues.includes('missing-expected-game-count'));
}
// A bad quote may reject the source or the affected match; it may never be
// repaired by borrowing odds from the adjacent odd/even or first-half columns.
const malformed = parseTai888Capture(captureDesktop('EPL', { malformed: true }), new Date(now));
assert.ok(malformed.parseIssues.length || !malformed.games.length || malformed.games[0].markets.length < 10);

function assertForeignScope(capture) {
  const parsed = parseTai888Capture(capture, new Date(now));
  assert.deepEqual(parsed.parseIssues, []);
  assert.equal(parsed.games.length, 1, 'a bare foreign-league heading must terminate the preceding EPL section');
  assert.equal(parsed.games[0].homeKey, globalThis.Tai888SoccerTeams.key('Tottenham'));
  assert.equal(parsed.games[0].markets.length, 4, 'only the first EPL quote block precedes the foreign heading');
  assert.equal(JSON.stringify(parsed.sourceCapture).includes('皇家馬德里'), false, 'foreign table rows cannot inherit the EPL identity');
}
assertForeignScope(captureDesktop('EPL', { foreignHeading: true }));

function assertTruncatedLock(capture) {
  assert.ok(capture.diagnostics.tableIssues.includes('SOCCER_TABLE_QUOTES_AMBIGUOUS'),
    'one displayed dash is incomplete outcome evidence, not a closed pair or three-way market');
  assert.equal(capture.diagnostics.expectedGameCount, null, 'an omitted invalid quote block cannot shrink the expected slate');
  const parsed = parseTai888Capture(capture, new Date(now));
  assert.ok(parsed.games.every(game => Object.values(game.periodStates).every(value => value !== 'locked')),
    'truncated outcomes must not synthesize a locked period or tombstone');
  const selection = selectAuthoritativeSoccerBoards([{ tabId: 1, frameId: 0, active: true, capture, parsed }], { now, league: 'EPL' });
  assert.equal(selection.ok, false, 'normalization errors must block authoritative uploads even when other alternatives parsed');
}
for (const lockMarket of ['runline', 'total', 'moneyline', 'half']) assertTruncatedLock(captureDesktop('EPL', { lockMarket, lockCount: 1 }));

for (const [lockMarket, lockCount, cellIndex] of [['runline', 2, 2], ['total', 2, 3], ['moneyline', 3, 4]]) {
  const capture = captureDesktop('EPL', { lockMarket, lockCount });
  assert.deepEqual(capture.diagnostics.tableIssues, []);
  const table = capture.tables.find(value => value.headers[cellIndex] === ({ runline: '讓球', total: '大小盤', moneyline: '獨贏' })[lockMarket]);
  assert.deepEqual(table.rows[0].cells[cellIndex].pair, Array(lockCount).fill('-'), 'complete closed markets retain exactly their displayed outcome count');
  const parsed = parseTai888Capture(capture, new Date(now));
  assert.deepEqual(parsed.parseIssues, []);
  assert.equal(parsed.games[0].markets.length, 9);
  assert.equal(selectAuthoritativeSoccerBoards([{ tabId: 1, frameId: 0, active: true, capture, parsed }], { now, league: 'EPL' }).ok, true);
}
{
  const capture = captureDesktop('EPL', { fullyLocked: true }), parsed = parseTai888Capture(capture, new Date(now));
  assert.deepEqual(capture.diagnostics.tableIssues, []);
  assert.equal(parsed.games.length, 1); assert.equal(parsed.games[0].marketStatus, 'locked');
  assert.deepEqual(parsed.games[0].markets, []);
  assert.deepEqual(parsed.games[0].periodStates, { UNKNOWN: 'locked', HT: 'locked' });
  assert.equal(validateSoccerCapture({ ...parsed, readerVersion: manifest.version, pageActivityAt: new Date(now).toISOString() }, { now, headerVersion: manifest.version }).ok, true);
  assert.equal(selectAuthoritativeSoccerBoards([{ tabId: 1, frameId: 0, active: true, capture, parsed }], { now, league: 'EPL' }).ok, true);
}
{
  const capture = captureDesktop('EPL', { omitColumnHeader: true }), parsed = parseTai888Capture(capture, new Date(now));
  assert.equal(capture.diagnostics.sawLeagueMarker, true);
  assert.deepEqual(capture.tables, []);
  assert.equal(capture.diagnostics.gameCount, 0);
  assert.equal(selectAuthoritativeSoccerBoards([{ tabId: 1, frameId: 0, active: true, capture, parsed }], { now, league: 'EPL' }).ok, false,
    'a recognized league with missing columns remains a detected-but-unreadable board');
}

// Sensitivity checks execute the actual collector with one safety guard removed
// only inside its VM. They prove the regressions fail without each fix; no
// Reader source or historical revision is rewritten for these comparisons.
{
  const file = 'soccer-table-normalizer.js', current = fs.readFileSync(`reader/${file}`, 'utf8');
  const boundary = 'identified || headingRow ||';
  assert.ok(current.includes(boundary));
  assert.throws(() => assertForeignScope(captureDesktop('EPL', {
    foreignHeading: true, sourceOverrides: { [file]: current.replace(boundary, 'identified ||') },
  })), { code: 'ERR_ASSERTION' }, 'the foreign-heading regression must fail when its boundary guard is removed');
  const cardinality = "      if (rows.length !== (key === 'moneyline' ? 3 : 2)) return null;\n";
  assert.ok(current.includes(cardinality));
  assert.throws(() => assertTruncatedLock(captureDesktop('EPL', {
    lockMarket: 'moneyline', lockCount: 1, sourceOverrides: { [file]: current.replace(cardinality, '') },
  })), { code: 'ERR_ASSERTION' }, 'the truncated-lock regression must fail when its outcome-cardinality guard is removed');
}

const event = { addListener() {} }, uploaded = [], deviceId = 'soccer-desktop-fixture';
let workerCaptures = captures;
const oldSecret = process.env.READER_PAIR_SECRET;
try {
  process.env.READER_PAIR_SECRET = 'desktop-local-fixture-secret';
  const readerToken = await createReaderToken({ deviceId });
  const state = { deviceId, readerToken };
  const chrome = {
    runtime: { onInstalled: event, onStartup: event, onMessage: event }, alarms: { onAlarm: event },
    tabs: { onUpdated: event, query: async () => [{ id: 7, active: true }], sendMessage: async () => ({ ok: true, capture: { readerVersion: manifest.version, captures: workerCaptures } }) },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
    storage: { local: { get: async () => structuredClone(state), set: async value => Object.assign(state, value), remove: async () => {} } },
  };
  const worker = vm.createContext({ chrome, Date: Clock, URL, setTimeout, clearTimeout, queueMicrotask, TextEncoder, AbortController, crypto: webcrypto,
    parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload, selectAuthoritativeBoard, selectAuthoritativeSoccerBoards, readerPayloadsByDate, shouldSkipSuccessfulPayload,
    fetch: async (url, options) => {
      assert.equal(url, 'https://mlb-positive-ev.vercel.app/api/soccer/reader');
      assert.equal(options.headers['X-Reader-Version'], manifest.version);
      assert.equal(options.headers['X-Device-Id'], deviceId);
      assert.equal((await verifyReaderToken(options.headers.Authorization.replace(/^Bearer /, '')))?.deviceId, deviceId);
      const body = JSON.parse(options.body), checked = validateSoccerCapture(body, { now, headerVersion: manifest.version });
      assert.equal(checked.ok, true, JSON.stringify(checked));
      const marketCount = body.games[0].markets.length;
      assert.equal(checked.payload.games[0].markets.length, marketCount);
      uploaded.push(body.league);
      return { ok: true, status: 200, text: async () => JSON.stringify(readerSaveReceiptFixture(body, { rawGameCount: 1, marketCount, executable: false })) };
    },
  });
  vm.runInContext(fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, ''), worker);
  const result = await vm.runInContext("performSync('manual')", worker);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(uploaded, ['EPL', 'UCL']);
  for (const league of uploaded) { assert.equal(state.readerStatuses[league].marketCount, 10); assert.equal(state.readerStatuses[league].executable, false); }
  uploaded.length = 0;
  await vm.runInContext("performSync('alarm')", worker);
  assert.deepEqual(uploaded, [], 'unchanged desktop football quotes retain existing heartbeat throttling');
  workerCaptures = [captureDesktop('UCL', { malformedAlternative: true, headingCount: 36 })];
  assert.equal((await vm.runInContext("performSync('manual')", worker)).ok, true);
  assert.deepEqual(uploaded, ['UCL']);
  assert.equal(state.readerStatuses.UCL.marketCount, 7);
  assert.equal(state.readerStatuses.UCL.skippedAlternativeCount, 1);
  assert.match(state.readerStatuses.UCL.message, /略過 1 組/);
  uploaded.length = 0;
  workerCaptures = [captureDesktop('EPL', { omitColumnHeader: true })];
  assert.equal((await vm.runInContext("performSync('manual')", worker)).ok, false);
  assert.equal(state.readerStatuses.EPL.state, 'error');
  assert.match(state.readerStatuses.EPL.message, /已偵測到聯盟標題.*無法組成賽事列/);
  assert.deepEqual(uploaded, [], 'missing desktop columns must show an explicit read failure without an upload');
  workerCaptures = [captureDesktop('EPL', { lockMarket: 'moneyline', lockCount: 1 })];
  assert.equal((await vm.runInContext("performSync('manual')", worker)).ok, false);
  assert.equal(state.readerStatuses.EPL.state, 'error');
  assert.match(state.readerStatuses.EPL.message, /檢查未通過/);
  assert.deepEqual(uploaded, [], 'a truncated outcome must not reach the upload boundary');
} finally {
  if (oldSecret === undefined) delete process.env.READER_PAIR_SECRET; else process.env.READER_PAIR_SECRET = oldSecret;
}
console.log('PASS desktop soccer screenshot reconstruction: actual content-script table collection, split date/time, home/away row order, 3-way home/away/draw reorder, seven unlabelled-period goal quotes, three separate HT handicaps, foreign-section/prop/odd-even exclusion, exact closed-outcome counts, incomplete-lock/missing-header upload blocks, guard-removal sensitivity, signed EPL/UCL uploads, server reparse and heartbeat. Live PC/DOM NOT VERIFIED.');
