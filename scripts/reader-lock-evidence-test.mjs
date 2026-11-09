import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parseTai888Capture, canonicalReaderPayload, readerMarketProperties } from '../reader/parser.js';
import { assessBoardCandidate } from '../reader/board-selector.js';
import { marketArchivePayload } from '../reader/market-outbox.js';
import { normalizeNbaReaderPayload } from '../lib/nba/reader.js';
import { buildReaderCaptureArchive, READER_CAPTURE_ARCHIVE_SCHEMA } from '../lib/reader-capture-archive.js';
import { buildMarketCaptureReceipt } from '../lib/market-capture-receipts.js';
import { buildMarketLineHistoryRows } from '../lib/market-line-history-v1.js';

// Execute the shipped lock classifier with observed DOM/style values. Empty
// price cells, ordinary layout names and unknown private glyphs are not locks.
const content = fs.readFileSync(new URL('../reader/tai888-content.js', import.meta.url), 'utf8');
const start = content.indexOf('  function hasExplicitMarketLock(element) {');
const end = content.indexOf('\n  }\n', start) + 5;
assert.ok(start > 0 && end > start);
const lock = new Function('clean', 'getComputedStyle', `return (${content.slice(start, end)})`)(
  value => String(value || '').trim(), (element, pseudo) => element.styles?.[pseudo || 'normal'] || {});
const node = (attributes = {}, styles = {}, children = []) => ({
  innerText: '', textContent: '', styles, getAttribute: key => attributes[key] || '', querySelectorAll: () => children,
});
for (const value of ['clock', 'block', 'market-clock', 'inline-block', 'unlocked', 'fa-lock-open', 'unlock']) {
  assert.equal(lock(node({ class: value, id: value, title: value, 'aria-label': value })), false, value);
}
for (const image of ['clock.png', 'block.svg', 'unlock.gif', 'lock-open.svg']) {
  assert.equal(lock(node({ src: `/assets/${image}` })), false, image);
}
assert.equal(lock(node({}, {}, [node({ 'aria-disabled': 'true', class: 'favourite-button' })])), false,
  'a disabled child control is not a disabled odds row');
for (const attributes of [{ class: 'fa-lock' }, { id: 'market_locked' }, { title: '鎖盤' },
  { 'aria-label': 'locked odds' }, { src: '/assets/padlock.png' }, { 'aria-disabled': 'true' }]) {
  assert.equal(lock(node(attributes)), true, JSON.stringify(attributes));
}
assert.equal(lock({ ...node(), innerText: '目前封盤' }), true);
assert.equal(lock(node({}, { '::before': { content: '"🔒"' } })), true);
assert.equal(lock(node({}, { normal: { backgroundImage: 'url("/assets/market-lock.svg")' } })), true);
for (const glyph of ['"\uf023"', '"\\f023"']) {
  assert.equal(lock(node({}, { '::before': { content: glyph, fontFamily: '"Font Awesome 6 Free"' } })), true,
    'a known closed-lock font profile supports actual and escaped glyphs');
  assert.equal(lock(node({}, { '::before': { content: glyph, fontFamily: 'UnknownFont' } })), false,
    'a private glyph without a known font profile is not proof');
}
assert.equal(lock(node({}, { '::before': { content: '"\uf3c1"', fontFamily: 'FontAwesome' } })), false);

const now = new Date('2026-11-02T23:00:00.000Z');
const cell = pair => ({ pair, lines: pair });
const row = ({ time = '08:00', away = 'BOS', home = 'LAL', empty = false, explicit = false, malformed = false } = {}) => ({
  marketLocked: explicit, cells: [cell(['11-03', time]), cell([`${away}-客隊`, `${home}-主隊[主]`]),
    cell(empty ? malformed ? ['0.930', '0.950'] : ['', ''] : ['5+50 0.970', '0.930']),
    cell(empty ? ['', ''] : ['大220+50 0.980', '小0.920']),
    cell(empty ? ['', ''] : ['2.5 0.950', '0.930']),
    cell(empty ? ['', ''] : ['大110平 0.960', '小0.940'])],
});
const capture = rows => ({ league: 'NBA', version: 'TAI888-DOM-CAPTURE-v2.2.0',
  sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/#/BS', observedAt: now.toISOString(),
  tables: [{ headers: ['時間', '主客隊伍', '全場讓分', '全場大小', '上半場讓分', '上半場大小'], rows }],
  diagnostics: { gameCount: new Set(rows.map(r => r.cells[0].pair[1] + r.cells[1].pair.join('|'))).size,
    expectedGameCount: new Set(rows.map(r => r.cells[0].pair[1] + r.cells[1].pair.join('|'))).size,
    lastMutationAt: now.toISOString() } });
const parse = rows => { const input = capture(rows); return { input, parsed: parseTai888Capture(input, now) }; };
const assessed = ({ input, parsed }) => assessBoardCandidate({ tabId: 1, frameId: 0, capture: input, parsed }, +now);
const complete = row();
for (const malformed of [false, true]) {
  const result = parse([complete, row({ time: '09:00', away: 'NY', home: 'CLE', empty: true, malformed })]);
  const missing = result.parsed.games[1];
  assert.equal(missing.marketStatus, 'locked', 'legacy internal partition remains non-executable');
  assert.equal(missing.availabilityEvidence, 'NO_PARSED_MARKETS');
  assert.equal(assessed(result).ok, true, 'an unavailable identity cannot discard its valid sibling quotes');
  assert.equal(result.parsed.games[0].fullTotal.line, '220+50');
  assert.equal(readerMarketProperties('NBA').some(key => missing[key]), false);
  assert.equal(missing.marketStates.fullRunline, malformed ? 'BLOCKED' : 'UNAVAILABLE');
}
const explicit = parse([row({ empty: true, explicit: true })]);
assert.equal(explicit.parsed.games[0].availabilityEvidence, 'EXPLICIT_SOURCE_LOCK');
assert.equal(assessed(explicit).ok, true);
const emptyClone = parse([row({ empty: true }), complete]);
assert.equal(emptyClone.parsed.games.length, 1);
assert.equal(emptyClone.parsed.games[0].availabilityEvidence, undefined);
assert.equal(assessed(emptyClone).ok, true);
for (const rows of [[row({ empty: true, malformed: true }), complete], [complete, row({ empty: true, malformed: true })],
  [row({ empty: true }), row({ empty: true, malformed: true })],
  [row({ empty: true, malformed: true }), row({ empty: true })]]) {
  const malformedClone = parse(rows);
  assert.ok(malformedClone.parsed.parseIssues.some(issue => issue.startsWith('conflicting-duplicate:')));
  assert.equal(assessed(malformedClone).ok, false,
    'richness or identical all-null fingerprints cannot erase BLOCKED duplicate evidence in either order');
}

const partialRow = row(); partialRow.cells[4] = cell(['', '']); partialRow.cells[5] = cell(['', '']);
const partial = parse([partialRow]);
assert.equal(partial.parsed.games[0].marketStatus, 'open');
assert.equal(partial.parsed.games[0].availabilityEvidence, undefined);
assert.equal(assessed(partial).ok, true, 'existing independently valid partial-market intake is preserved');
const oldPayload = structuredClone(explicit.parsed); delete oldPayload.games[0].availabilityEvidence;
assert.equal(Object.hasOwn(JSON.parse(canonicalReaderPayload(oldPayload)).games[0], 'availabilityEvidence'), false);
const digest = value => createHash('sha256').update(canonicalReaderPayload(value)).digest('hex');
assert.notEqual(digest(oldPayload), digest(explicit.parsed));
const changedMarker = structuredClone(explicit.parsed); changedMarker.games[0].availabilityEvidence = 'NO_PARSED_MARKETS';
assert.notEqual(digest(changedMarker), digest(explicit.parsed), 'marker is part of the source payload hash');
for (const league of ['MLB', 'NPB', 'KBO', 'CPBL']) {
  const legacy = { ...oldPayload, league, version: 'TAI888-READER-DOM-v2.1.0' };
  const extended = structuredClone(legacy); extended.games[0].availabilityEvidence = 'NO_PARSED_MARKETS';
  assert.equal(canonicalReaderPayload(extended), canonicalReaderPayload(legacy), 'other league wire hashes do not acquire NBA metadata');
}

// The shipped parser's distinction survives every selected-evidence boundary:
// live intake, local archive whitelist, archive intake, quote journal, receipts.
const combined = parse([complete, row({ time: '09:00', away: 'NY', home: 'CLE', empty: true, malformed: true }),
  row({ time: '10:00', away: 'MEM', home: 'TOR', empty: true, explicit: true })]);
assert.equal(assessed(combined).ok, true);
const deviceId = 'lock-evidence-test-device';
const wire = { ...combined.parsed, readerVersion: '2.1.60', deviceId, expectedGameCount: 3, detectedGameCount: 3,
  pageActivityAt: now.toISOString() };
wire.payloadHash = digest(wire);
const normalized = normalizeNbaReaderPayload(wire, { now: +now, deviceId, headerVersion: wire.readerVersion });
assert.deepEqual(normalized.games.map(game => [game.marketCount, game.availabilityEvidence ?? null]),
  [[4, null], [0, 'NO_PARSED_MARKETS'], [0, 'EXPLICIT_SOURCE_LOCK']]);
assert.deepEqual(buildMarketCaptureReceipt(normalized).games.map(game => game.captureStatus),
  ['CAPTURED', 'NOT_CAPTURED', 'LOCKED']);
assert.equal(buildMarketLineHistoryRows(normalized).length, 1, 'only the unchanged priced sibling creates a quote state');
const localArchive = marketArchivePayload(wire);
assert.equal(canonicalReaderPayload(localArchive), canonicalReaderPayload(wire));
const archived = buildReaderCaptureArchive({ schema: READER_CAPTURE_ARCHIVE_SCHEMA, payload: localArchive },
  { now: +now, deviceId, headerVersion: wire.readerVersion });
assert.equal(canonicalReaderPayload(archived.payload), canonicalReaderPayload(wire));
assert.deepEqual(archived.payload.games.map(game => game.availabilityEvidence ?? null),
  [null, 'NO_PARSED_MARKETS', 'EXPLICIT_SOURCE_LOCK']);

const background = fs.readFileSync(new URL('../reader/background.js', import.meta.url), 'utf8');
const localStart = background.indexOf('function localBoardDiagnostic(payload, capture) {');
const localEnd = background.indexOf('\nfunction sanitizeCapture', localStart);
const localDiagnostic = new Function('readerMarketProperties', `${background.slice(localStart, localEnd)};return localBoardDiagnostic;`)(readerMarketProperties);
const legacy = structuredClone(explicit.parsed.games[0]); delete legacy.availabilityEvidence;
const noPrice = parse([row({ empty: true })]).parsed.games[0];
const local = localDiagnostic({ league: 'NBA', games: [emptyClone.parsed.games[0], explicit.parsed.games[0], noPrice, legacy] }, {});
assert.deepEqual([local.openCount, local.lockedCount, local.unconfirmedCount, local.marketCount], [1, 1, 2, 4]);

const popup = fs.readFileSync(new URL('../reader/popup.js', import.meta.url), 'utf8');
const popupStart = popup.indexOf('function render(statuses) {');
const popupEnd = popup.indexOf('\nasync function refresh()', popupStart);
const element = () => ({ children: [], textContent: '', append(...children) { this.children.push(...children); },
  replaceChildren(...children) { this.children = children; } });
const grid = element();
const renderPopup = new Function('LEAGUES', 'leagueGrid', 'STALE_MS', 'document', 'state', 'dot', 'age',
  `${popup.slice(popupStart, popupEnd)};return render;`)([['NBA', 'NBA']], grid, 180000,
  { createElement: element }, element(), element(), () => '剛剛');
renderPopup({ NBA: { ok: true, state: 'synced', lastSyncAt: Date.now(), localDiagnostic: local,
  openGameCount: 1, lockedGameCount: 1, unconfirmedGameCount: 2, marketCount: 4 } });
assert.match(grid.children[0].children[1].textContent, /本機有價1 來源鎖盤1 未確認2/);
assert.match(grid.children[0].children[1].textContent, /後端有價1 來源鎖盤1 未確認2/);
renderPopup({ NBA: { ok: true, state: 'synced', lastSyncAt: Date.now(),
  localDiagnostic: { openCount: 1, lockedCount: 2, marketCount: 4 } } });
assert.match(grid.children[0].children[1].textContent, /本機有價1 來源鎖盤— 未確認2/,
  'an old local lock counter without proof is explicitly unconfirmed');
assert.match(grid.children[0].children[1].textContent, /後端有價— 來源鎖盤— 未確認—/,
  'old saved statuses with no evidence counters must not imply zero missing games');

console.log('PASS source lock evidence: clock/block/unlocked negative profiles, explicit row/icon/known-font locks, unchanged zero-market nonexec partition with hashed NBA evidence, valid siblings/partial/duplicate conflict isolation, legacy/other-league wire compatibility and honest local/server popup lock counts; NOT Production');
