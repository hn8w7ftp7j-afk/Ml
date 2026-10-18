import assert from 'node:assert/strict';
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
const manifest = JSON.parse(fs.readFileSync('reader/manifest.json', 'utf8'));
const now = Date.parse('2026-10-18T21:29:30.000Z');
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}

class RenderedElement {
  constructor(tagName, { left = 0, top = 0, width = 1100, height = 20, fragments = [] } = {}) {
    Object.assign(this, { tagName, left, top, width, height, fragments, children: [], parentElement: null, ownerDocument: null });
  }
  get innerText() { return [...this.fragments.map(fragment => fragment.text), ...this.children.map(child => child.innerText)].join('\n'); }
  get textContent() { return this.innerText; }
  getBoundingClientRect() { return { left: this.left, top: this.top, right: this.left + this.width, bottom: this.top + this.height, width: this.width, height: this.height }; }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector) {
    if (selector === '*') return this.descendants();
    if (selector.includes('[class') || selector.includes('[aria-')) return [];
    const names = selector.split(',').map(value => value.trim().toUpperCase());
    return this.descendants().filter(child => names.includes(child.tagName));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getAttribute() { return null; }
  matches() { return false; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.tagName === selector.toUpperCase()) return node; return null; }
  compareDocumentPosition() { return 0; }
  contains(element) { return element === this || this.descendants().includes(element); }
}

function desktopDocument(league, { homeFirst = true, separatedRows = false, malformed = false, foreignHeading = false,
  lockMarket = '', lockCount = 1, fullyLocked = false, omitColumnHeader = false } = {}) {
  const label = league === 'EPL' ? '聯盟：英格蘭超級聯賽(5)' : '聯盟：歐洲冠軍聯賽(5)';
  const root = new RenderedElement('HTML', { height: 900 }); root.isConnected = true;
  const body = root.append(new RenderedElement('BODY', { height: 900 }));
  const table = body.append(new RenderedElement('TABLE', { left: 455, top: 100, width: 650, height: 450 }));
  const cell = (row, left, width, texts, { top = row.top, lineHeight = 14, tag = 'TD' } = {}) => row.append(new RenderedElement(tag, {
    left, top, width, height: Math.max(20, texts.length * lineHeight),
    fragments: texts.map((text, index) => ({ text, left: left + 3, top: top + index * lineHeight })),
  }));
  if (!omitColumnHeader) {
    const header = table.append(new RenderedElement('TR', { left: 455, top: 100, width: 650 }));
    for (const [left, width, text] of [[455, 45, '時間'], [500, 110, '主客隊伍'], [610, 50, '獨贏'], [660, 120, '讓球'], [780, 110, '大小盤'], [890, 90, '單雙'], [980, 120, '上半讓球']]) cell(header, left, width, [text], { tag: 'TH' });
  }
  const heading = table.append(new RenderedElement('TR', { left: 455, top: 125, width: 650 }));
  cell(heading, 455, 650, [label]);
  const home = league === 'EPL' ? '熱刺' : '皇家馬德里';
  const away = league === 'EPL' ? '高雲地利' : '巴塞隆納';
  let definitions = [
    { line: '1-50', water: ['1.070', '0.810'], total: '3平', totals: ['0.920', '0.940'], half: ['0.5', '0.970', '0.910'], money: ['0.390', '4.600', '3.650'] },
    { line: '1平', water: ['0.790', '1.100'], total: '3+50', totals: ['0.700', '1.190'], half: ['0-50', '0.660', '1.390'], money: ['', '', ''] },
    { line: '1.5', water: ['1.320', '0.640'], total: '3-50', totals: ['1.190', '0.700'], half: ['1+50', '1.370', '0.610'], money: ['', '', ''] },
    { prop: '角球數', line: '3+50', water: ['0.840', '0.940'], total: '10.5', totals: ['0.940', '0.840'], money: ['0.180', '2.700', '10.900'] },
    { prop: '罰牌數', line: '0.5', water: ['0.890', '0.910'], total: '3平', totals: ['0.730', '1.050'], money: ['', '', ''] },
  ];
  if (fullyLocked) definitions = definitions.slice(0, 1);
  for (const [index, definition] of definitions.entries()) {
    const top = 155 + index * 65;
    if (foreignHeading && index === 1) {
      const foreign = table.append(new RenderedElement('TR', { left: 455, top: top - 10, width: 650 }));
      cell(foreign, 455, 650, ['西班牙甲級聯賽']);
    }
    const suffix = definition.prop ? `-${definition.prop}` : '';
    const teams = foreignHeading && index >= 1
      ? [`皇家馬德里${suffix}[主]`, `巴塞隆納${suffix}`]
      : [`${home}${suffix}[主]`, `${away}${suffix}`];
    const waters = [...definition.water];
    const money = [...definition.money];
    const lineRows = [definition.line, '', ''];
    const halfRows = [definition.half?.[0] || '0.5', '', ''], halfWater = [...(definition.half?.slice(1) || ['0.970', '0.910'])];
    if (!homeFirst) { teams.reverse(); waters.reverse(); money.splice(0, 2, money[1], money[0]); lineRows.splice(0, 2, '', definition.line); halfRows.splice(0, 2, '', definition.half?.[0] || '0.5'); halfWater.reverse(); }
    if (malformed && index === 0) waters[0] = 'UNKNOWN';
    const values = [
      [455, 45, ['10-20', '03:00', '']], [500, 110, [...teams, '★']],
      [610, 50, money], [660, 50, lineRows], [710, 70, [...waters, '']],
      [780, 60, [`${definition.total} 大`, '小', '']], [840, 50, [...definition.totals, '']],
      [890, 30, ['單', '雙', '']], [920, 60, ['0.930', '0.950', '']],
      [980, 50, halfRows], [1030, 70, [...halfWater, '']],
    ];
    function lockedColumn(key, count) {
      if (key === 'moneyline') values[2][2] = Array.from({ length: 3 }, (_, offset) => offset < count ? '-' : '');
      else if (key === 'runline') { values[3][2] = ['', '', '']; values[4][2] = ['-', count > 1 ? '-' : '', '']; }
      else if (key === 'total') { values[5][2] = ['', '', '']; values[6][2] = ['-', count > 1 ? '-' : '', '']; }
      else if (key === 'half') { values[9][2] = ['', '', '']; values[10][2] = ['-', count > 1 ? '-' : '', '']; }
    }
    if (index === 0 && lockMarket) lockedColumn(lockMarket, lockCount);
    if (fullyLocked) for (const key of ['runline', 'total', 'moneyline', 'half']) lockedColumn(key, key === 'moneyline' ? 3 : 2);
    if (separatedRows) {
      for (let offset = 0; offset < 3; offset += 1) {
        const row = table.append(new RenderedElement('TR', { left: 455, top: top + offset * 14, width: 650, height: 14 }));
        for (const [left, width, texts] of values) cell(row, left, width, [texts[offset]]);
      }
    } else {
      const row = table.append(new RenderedElement('TR', { left: 455, top, width: 650, height: 48 }));
      for (const [left, width, texts] of values) cell(row, left, width, texts);
    }
  }
  let rangeNode;
  const document = {
    documentElement: root, body, visibilityState: 'visible', readyState: 'complete', referrer: '', addEventListener() {},
    location: { protocol: 'https:', hostname: 'tai888.in', origin: 'https://tai888.in', pathname: '/newapp/', hash: '#/FT', ancestorOrigins: [] },
    querySelectorAll(selector) { return root.querySelectorAll(selector); },
    createTreeWalker(element) {
      const nodes = [element, ...element.descendants()].flatMap(parentElement => parentElement.fragments.filter(fragment => fragment.text).map(fragment => ({ nodeValue: fragment.text, parentElement, fragment })));
      let index = -1;
      return { currentNode: null, nextNode() { index += 1; this.currentNode = nodes[index]; return Boolean(this.currentNode); } };
    },
    createRange() { return { selectNodeContents(node) { rangeNode = node; }, getClientRects() { return [{ ...rangeNode.fragment, width: 40, height: 10 }]; } }; },
  };
  for (const element of [root, ...root.descendants()]) element.ownerDocument = document;
  return { document, label };
}

function captureDesktop(league, options = {}) {
  const { document, label } = desktopDocument(league, options);
  let handler;
  const context = vm.createContext({ document, location: document.location, Element: RenderedElement,
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 }, Node: { ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    performance: { timeOrigin: now, now: () => 0, getEntriesByType: () => [] },
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime: { id: 'desktop-fixture', sendMessage: async () => ({}), onMessage: { addListener(value) { handler = value; } } } },
    addEventListener() {}, setInterval() {}, setTimeout() {}, clearTimeout() {}, URL, Date: Clock, console });
  for (const file of manifest.content_scripts[0].js) vm.runInContext(options.sourceOverrides?.[file] || fs.readFileSync(`reader/${file}`, 'utf8'), context);
  let response;
  handler({ type: 'TAI888_CAPTURE_BASEBALL_TABLE' }, {}, value => { response = value; });
  assert.equal(response?.ok, true, JSON.stringify(response));
  const envelope = JSON.parse(JSON.stringify(response.capture));
  assert.equal(envelope.readerVersion, manifest.version);
  const capture = envelope.captures.find(value => value.league === league);
  assert.ok(capture, `${league}: desktop table must reach the actual content handler; ${JSON.stringify(envelope)}`);
  assert.equal(capture.pageLeagueLabel, label);
  return capture;
}

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
      assert.equal(checked.payload.games[0].markets.length, 10);
      uploaded.push(body.league);
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, rawGameCount: 1, marketCount: 10, executable: false }) };
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
