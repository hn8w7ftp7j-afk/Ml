import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { parseTai888Capture, nhlReaderEvidencePayload, parseNhlReaderMarketRows, parseReaderMarketRows } from '../reader/parser.js';
import { validateNhlCapture } from '../lib/nhl/reader.js';
import { readerPayloadsByDate, selectAuthoritativeBoard } from '../reader/board-selector.js';

// Screenshot-derived rendered coordinates/text, NOT a captured live DOM or a
// verified settlement contract. Exercise the actual adapter/parser/intake.
const context = vm.createContext({});
for (const file of ['league-registry.js', 'nhl-teams.js', 'nhl-card-normalizer.js']) vm.runInContext(fs.readFileSync(`reader/${file}`, 'utf8'), context);
const normalize = input => JSON.parse(JSON.stringify(context.Tai888NhlCardNormalizer.normalize(input)));
const label = 'NHL國家冰球聯盟--包括加時與點球';
const fragment = (text, left, top) => ({ text, left, top });
const headers = top => [fragment('獨贏', 545, top), fragment('讓分', 773, top), fragment('大小', 1005, top)];
const fragments = [fragment(label, 40, 40), ...headers(125), fragment('10/19 6:00 (GMT+8)', 40, 215), fragment('(更多玩法)', 890, 215),
  fragment('明尼蘇達荒野[主]', 40, 340), fragment('哥倫布藍衣', 40, 515),
  fragment('-', 570, 380), fragment('-', 570, 640), fragment('1平', 765, 300), fragment('1.125', 750, 390), fragment('0.775', 750, 640),
  fragment('大6平', 965, 300), fragment('0.93', 975, 390), fragment('小', 1005, 560), fragment('0.93', 975, 640),
  ...headers(830), fragment('10/19 8:00 (GMT+8)', 40, 925), fragment('(更多玩法)', 890, 925),
  fragment('卡爾加里火焰[主]', 40, 1040), fragment('卡羅萊納颶風', 40, 1220),
  fragment('-', 570, 1100), fragment('-', 570, 1340), fragment('0.75', 750, 1100), fragment('1.5', 765, 1270), fragment('1.15', 750, 1340),
  fragment('大6平', 965, 1005), fragment('1.005', 975, 1100), fragment('小', 1005, 1270), fragment('0.855', 975, 1340)];
const section = { label, fragments };
const normalized = normalize([section]);
assert.equal(normalized.diagnostics.gameCount, 2, JSON.stringify(normalized.diagnostics));
assert.equal(normalized.diagnostics.expectedGameCount, 2);
assert.equal(normalized.tables[0].rows[0].marketEvidence[0].pair[0], '-');
const now = new Date('2026-10-18T04:50:00Z');
const capture = { league: 'NHL', pageLeagueLabel: label, sourceHost: 'tai888.in', pageUrl: 'https://tai888.in/newapp/', observedAt: now.toISOString(), tables: normalized.tables, diagnostics: normalized.diagnostics };
const parsed = parseTai888Capture(capture, now);
parsed.readerVersion = '2.1.33'; parsed.expectedGameCount = 2; parsed.pageActivityAt = now.toISOString();
assert.equal(parsed.games.length, 2);
assert.deepEqual(parsed.games.map(game => [game.awayCode, game.homeCode, game.boardTime]), [['CBJ', 'MIN', '06:00'], ['CAR', 'CGY', '08:00']]);
assert.equal(parsed.games[0].fullRunline.lineSide, 'home');
assert.equal(parsed.games[0].fullRunline.line, '1平');
assert.equal(parsed.games[0].fullRunline.homeWater, 1.125);
assert.equal(parsed.games[0].fullRunline.awayWater, 0.775);
assert.equal(parsed.games[0].fullTotal.overWater, 0.93);
assert.equal(parsed.games[1].fullRunline.lineSide, 'away');
assert.equal(parsed.games[1].fullRunline.line, '1.5');
assert.equal(parsed.games[1].fullRunline.awayWater, 1.15);
assert.equal(parsed.games[1].fullRunline.homeWater, 0.75);
assert.equal(parsed.games[1].fullTotal.line, '6平');
assert.equal(parsed.games[1].fullTotal.overWater, 1.005);
assert.equal(parsed.games[1].fullTotal.underWater, 0.855);
assert.equal(selectAuthoritativeBoard([{ tabId: 1, frameId: 0, active: true, capture, parsed }], { league: 'NHL', now: +now }).ok, true);
const wire = nhlReaderEvidencePayload(readerPayloadsByDate(parsed)[0]);
const checked = validateNhlCapture(wire, { now: +now, headerVersion: '2.1.33' });
assert.equal(checked.ok, true, JSON.stringify(checked.errors));
assert.equal(checked.payload.games[1].parsedMarkets.fullRunline.homeWater, 0.75);
assert.equal(checked.payload.games[0].rawMarketEvidence.find(value => value.key === 'total').rawRows[0], '大6平 0.93');
assert.equal(checked.payload.games[0].includesOvertime, null);
assert.equal(checked.payload.executable, false);
// Shared baseball/NBA parsing and settlement semantics are not loosened.
assert.equal(parseReaderMarketRows('fullRunline', ['1.5 1.15', '0.75']), null);
assert.equal(parseNhlReaderMarketRows('fullRunline', ['1.5', '0.75']), null);
for (const badLabel of ['NHL 導覽', `${label} 第一節`, `${label} 正規時間`, `${label} LIVE`, label.replace('NHL', 'KHL')]) assert.equal(normalize([{ ...section, label: badLabel }]).tables.length, 0, badLabel);
for (const mutation of [
  value => { value.fragments.find(item => item.text === '明尼蘇達荒野[主]').text = '明尼蘇達荒野'; },
  value => { value.fragments.find(item => item.text === '哥倫布藍衣').text = '哥倫布藍衣[主]'; },
  value => { value.fragments.push(fragment('0.999', 750, 700)); },
  value => { value.fragments.find(item => item.text === '1.125').text = '未知'; },
]) {
  const altered = structuredClone(section); mutation(altered);
  assert.equal(normalize([altered]).diagnostics.gameCount, 1, mutation.toString());
  assert.equal(normalize([altered]).diagnostics.expectedGameCount, 2, 'missing card must not shrink expected slate');
}
const mixed = structuredClone(section); mixed.fragments.push(fragment('聯盟：KHL俄羅斯冰球(1)', 40, 1500));
assert.equal(normalize([mixed]).tables.length, 0);
const privateSidebar = structuredClone(section);
privateSidebar.fragments.push(fragment('PRIVATE_SIDEBAR_BALANCE', 40, 760));
assert.equal(normalize([privateSidebar]).diagnostics.gameCount, 2);
assert.equal(JSON.stringify(normalize([privateSidebar])).includes('PRIVATE_SIDEBAR_BALANCE'), false, 'unrelated page text must not be transmitted as raw event evidence');

// Execute the actual content-script message handler with a minimal rendered-DOM
// fixture. This verifies collector -> adapter -> multi-league capture wiring,
// rather than only calling the adapter directly. No browser/network is used.
class ElementFixture {
  constructor(text, tag = 'DIV', parent = null) { this.innerText = text; this.textContent = text; this.tagName = tag; this.parentElement = parent; this.children = []; this.ownerDocument = null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 1150, bottom: 1500, width: 1150, height: 1500 }; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  getAttribute() { return null; }
  matches() { return false; }
}
const sectionElement = new ElementFixture(fragments.map(value => value.text).join('\n'), 'SECTION');
const headingElement = new ElementFixture(label, 'H2', sectionElement);
sectionElement.children = [headingElement];
const domNodes = fragments.map(value => ({ nodeValue: value.text, parentElement: sectionElement, fragment: value }));
let rangeNode; let messageHandler;
const documentFixture = {
  location: { protocol: 'https:', hostname: 'tai888.in', origin: 'https://tai888.in', pathname: '/newapp/', hash: '#/IB', ancestorOrigins: [] },
  documentElement: Object.assign(new ElementFixture('', 'HTML'), { isConnected: true }),
  visibilityState: 'visible', readyState: 'complete', referrer: '', addEventListener() {},
  querySelectorAll(selector) { return selector.includes('h1') ? [headingElement] : []; },
  createTreeWalker(element) {
    const nodes = element === sectionElement ? domNodes : []; let index = -1;
    return { currentNode: null, nextNode() { index += 1; this.currentNode = nodes[index]; return Boolean(this.currentNode); } };
  },
  createRange() { return { selectNodeContents(node) { rangeNode = node; }, getClientRects() { return [{ ...rangeNode.fragment, width: 100, height: 20 }]; } }; },
};
sectionElement.ownerDocument = documentFixture; headingElement.ownerDocument = documentFixture;
const domContext = vm.createContext({ Element: ElementFixture, document: documentFixture, location: documentFixture.location,
  NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 }, Node: { ELEMENT_NODE: 1 },
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  performance: { timeOrigin: +now, now: () => 0, getEntriesByType: () => [] },
  MutationObserver: class { observe() {} disconnect() {} },
  chrome: { runtime: { id: 'fixture', sendMessage: async () => ({}), onMessage: { addListener(handler) { messageHandler = handler; } } } },
  addEventListener() {}, setInterval() {}, setTimeout() {}, clearTimeout() {}, URL, Date, console });
for (const file of ['capture-policy.js', 'league-registry.js', 'nhl-teams.js', 'nhl-card-normalizer.js', 'row-normalizer.js', 'tai888-content.js']) vm.runInContext(fs.readFileSync(`reader/${file}`, 'utf8'), domContext);
let response;
messageHandler({ type: 'TAI888_CAPTURE_BASEBALL_TABLE' }, {}, value => { response = value; });
assert.equal(response.ok, true, JSON.stringify(response));
assert.equal(response.capture.captures.length, 1);
assert.equal(response.capture.captures[0].league, 'NHL');
assert.equal(response.capture.captures[0].diagnostics.gameCount, 2);
assert.equal(parseTai888Capture(response.capture.captures[0], now).games.length, 2);
console.log('NHL responsive screenshot fixture: exact two games, home-first order, 2/3 decimal odds, column isolation, server reparse and fail-closed boundaries PASS (live DOM not verified)');
