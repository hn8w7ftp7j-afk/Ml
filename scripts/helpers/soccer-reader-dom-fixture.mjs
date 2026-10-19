import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

export const manifest = JSON.parse(fs.readFileSync('reader/manifest.json', 'utf8'));
export const now = Date.parse('2026-10-18T21:29:30.000Z');
export class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}

export class RenderedElement {
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

export function desktopDocument(league, { homeFirst = true, separatedRows = false, malformed = false, foreignHeading = false,
  lockMarket = '', lockCount = 1, fullyLocked = false, omitColumnHeader = false, layout = 'table', iconText = '★', nestedFragments = false,
  cardProp = '罰牌數', headingCount = 5, malformedCard = false, malformedAlternative = false, singleRow = false } = {}) {
  const label = `聯盟：${league === 'EPL' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽'}(${headingCount})`;
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
    { prop: cardProp, line: '0.5', water: ['0.890', '0.910'], total: '3平', totals: ['0.730', '1.050'], money: ['', '', ''] },
  ];
  if (fullyLocked || singleRow) definitions = definitions.slice(0, 1);
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
    if (malformedAlternative && index === 1) waters[0] = 'UNKNOWN';
    if (malformedCard && definition.prop === cardProp) waters[0] = 'UNKNOWN';
    const values = [
      [455, 45, ['10-20', '03:00', '']], [500, 110, [...teams, iconText]],
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
  if (layout !== 'table') {
    assert.ok(['split-tables', 'nested-tables', 'div-grid'].includes(layout), `unsupported fixture layout: ${layout}`);
    const originalRows = [...table.children];
    const headers = originalRows.filter(row => row.children.some(child => child.tagName === 'TH'));
    const matches = originalRows.filter(row => !headers.includes(row) && !row.innerText.startsWith(label));
    body.children = [];
    const board = body.append(new RenderedElement('DIV', { left: 455, top: 100, width: 650, height: 450 }));
    if (headers.length) {
      if (layout === 'div-grid') {
        for (const row of headers) {
          row.tagName = 'DIV'; for (const child of row.children) child.tagName = 'DIV'; board.append(row);
        }
      } else {
        const headerTable = board.append(new RenderedElement('TABLE', { left: 455, top: 100, width: 650, height: 20 }));
        for (const row of headers) headerTable.append(row);
      }
    }
    // Two nested visible DIVs intentionally reproduce the repeated accepted
    // section diagnostics from the user's actual v2.1.36 report. Neither is a
    // TR or an ARIA row, and the heading belongs to the same rendered board.
    const heading = board.append(new RenderedElement('DIV', { left: 455, top: 125, width: 650, height: 20 }));
    const innerHeading = heading.append(new RenderedElement('DIV', { left: 458, top: 127, width: 640, height: 18 }));
    innerHeading.append(new RenderedElement('SPAN', { left: 461, top: 129, width: 630, height: 16,
      fragments: [{ text: label, left: 464, top: 129 }] }));
    const outerTable = layout === 'nested-tables'
      ? board.append(new RenderedElement('TABLE', { left: 455, top: 155, width: 650, height: 400 })) : null;
    for (const row of matches) {
      if (layout === 'div-grid') {
        row.tagName = 'DIV'; for (const child of row.children) child.tagName = 'DIV'; board.append(row);
      } else if (layout === 'split-tables') {
        const matchTable = board.append(new RenderedElement('TABLE', { left: 455, top: row.top, width: 650, height: row.height }));
        matchTable.append(row);
      } else {
        const wrapper = outerTable.append(new RenderedElement('TR', { left: 455, top: row.top, width: 650, height: row.height }));
        const wrapperCell = wrapper.append(new RenderedElement('TD', { left: 455, top: row.top, width: 650, height: row.height }));
        const matchTable = wrapperCell.append(new RenderedElement('TABLE', { left: 455, top: row.top, width: 650, height: row.height }));
        matchTable.append(row);
      }
    }
  }
  if (nestedFragments) {
    // The public Angular football template nests individual date/time and odds
    // labels inside DIV/SPAN descendants. Retain identical text rectangles;
    // only the DOM ownership changes. Partial date descendants are not events.
    const cells = [root, ...root.descendants()].filter(element => element.fragments.length && element.tagName !== 'SPAN');
    for (const element of cells) {
      const fragments = element.fragments; element.fragments = [];
      for (const fragment of fragments) {
        if (!fragment.text) continue;
        const box = { left: fragment.left, top: fragment.top, width: Math.max(2, element.width - 6), height: 10 };
        const line = element.append(new RenderedElement('DIV', box));
        line.append(new RenderedElement('SPAN', { ...box, fragments: [fragment] }));
      }
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

export function captureDesktop(league, options = {}) {
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
  if (options.envelopeOnly) return envelope;
  const capture = envelope.captures.find(value => value.league === league);
  assert.ok(capture, `${league}: desktop table must reach the actual content handler; ${JSON.stringify(envelope)}`);
  assert.equal(capture.pageLeagueLabel, label);
  return capture;
}

