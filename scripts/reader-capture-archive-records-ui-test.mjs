import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { taipeiHistoryTime } from '../app/market-line-history/history-view.js';
import { nbaHistoricalAvailabilityLabel } from '../app/market-line-history/coverage-display.js';

const source = fs.readFileSync('app/market-line-history/archive-records.js', 'utf8');
const { code } = await transform(source.replace(/^import .*?;\n/gm, '').replace(/export default function/g, 'function').replace(/export function/g, 'function'), {
  filename: 'archive-records.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
});
const metadata = id => ({ captureId: id.repeat(64), league: 'NBA', boardDate: '2026-11-06',
  observedAt: '2026-11-05T22:00:00.000Z', persistedAt: '2026-11-06T01:00:00.000001Z', payloadHash: 'a'.repeat(64), readerVersion: '2.1.54',
  games: [{ gameKey: '08:05|LAL|GSW', away: 'LAL', home: 'GSW', boardTime: '08:05' }], integrity: { status: 'NOT_VERIFIED' } });
const base = { ok: true, schema: 'READER-CAPTURE-ARCHIVE-v1', archiveOnly: true, currentBoardUpdated: false, historicalAvailabilityVerified: false, executable: false, productionWrites: false };
const page = (id = 'a', more = true) => ({ ...base, records: [metadata(id)], totalCount: more ? 2 : 1, until: '2026-11-06T02:00:00.000Z', hasMore: more, nextAfter: more ? 'signed-cursor-fixture' : null });
const detail = (id = 'a') => ({ ...base, record: { ...metadata(id), integrity: { status: 'PASS' }, payload: { games: [
  { awayCode: 'LAL', homeCode: 'GSW', boardTime: '08:05', marketStatus: 'open', fullRunline: { line: '3+50', lineSide: 'home', awayWater: 0.95, homeWater: 0.94 },
    fullTotal: { line: '224-50', overWater: 0.93, underWater: 0.92 }, firstHalfRunline: null, firstHalfTotal: null },
] } } });
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = payload => ({ ok: true, json: async () => payload });
function harness() {
  const states = [], refs = [], calls = [], responses = [];
  let stateIndex = 0, refIndex = 0, cleanup;
  const scope = vm.createContext({ React, taipeiHistoryTime, nbaHistoricalAvailabilityLabel, AbortController, URLSearchParams, styles: {},
    useState: initial => { const index = stateIndex++; if (states.length <= index) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
    useRef: initial => { const index = refIndex++; return refs[index] ||= { current: initial }; },
    useEffect: fn => { cleanup = fn(); },
    FormData: class { constructor(fields) { this.fields = fields; } get(key) { return this.fields[key]; } },
    window: { setTimeout: () => 1, clearTimeout() {} },
    fetch: (url, options) => { calls.push({ url, options }); const next = responses.shift(); assert.ok(next, `missing fixture for ${url}`); return next(); },
  });
  vm.runInContext(code, scope);
  const tree = () => { stateIndex = refIndex = 0; return scope.ArchiveRecords(); };
  const submit = async (fields = {}) => { nodes(tree()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {}, currentTarget: fields }); await flush(); };
  return { scope, states, refs, calls, responses, tree, submit, render: () => renderToStaticMarkup(tree()),
    click: name => nodes(tree()).find(node => node.type === 'button' && node.props.children === name).props.onClick(), cleanup: () => cleanup?.() };
}
const h = harness();
assert.equal(h.scope.validateArchiveRecords(page()).records.length, 1);
assert.equal(h.scope.validateArchiveRecords(detail(), true).record.integrity.status, 'PASS');
for (const mutate of [x => { x.productionWrites = true; }, x => { x.totalCount = null; }, x => { x.nextAfter = null; }, x => { x.records[0].captureId = 'bad'; }]) {
  const value = page(); mutate(value); assert.throws(() => h.scope.validateArchiveRecords(value));
}
assert.match(h.scope.archiveRecordsUrl({ league: 'NBA', from: '2026-11-06', through: '', gameKey: '08:05|LAL|GSW' }), /view=records/);
assert.throws(() => h.scope.archiveRecordsUrl({ league: 'NHL', from: '', through: '', gameKey: '' }));
const markets = h.scope.archiveGameMarkets({ markets: [{ period: 'HT', kind: 'TOTAL', line: '1.5', overWater: 0.9, underWater: 0.95 }] });
assert.equal(markets[0].label, '上半場 大小'); assert.equal(markets[0].value.line, '1.5');

h.responses.push(async () => response(page()));
await h.submit({ 'archive-league': 'NBA', 'archive-from': '2026-11-06' });
assert.match(h.calls[0].url, /view=records&limit=25&league=NBA&from=2026-11-06/);
assert.equal(h.calls[0].options.cache, 'no-store'); assert.equal(h.calls[0].options.credentials, 'same-origin');
assert.match(h.render(), /符合篩選 2 筆擷取/); assert.match(h.render(), /不等於棒球官方 gamePk/);
h.responses.push(async () => response({ ...page('b', false), totalCount: 2 }));
await h.click('載入下一頁補傳擷取');
assert.match(h.calls[1].url, /until=2026-11-06T02%3A00%3A00.000Z&after=signed-cursor-fixture/);
assert.match(h.render(), /已載入 2 筆/);
h.responses.push(async () => response(detail()));
await h.click('查看原盤與水位');
assert.equal(h.calls[2].url, `/api/reader/archive?captureId=${'a'.repeat(64)}`);
const html = h.render();
assert.match(html, /3\+50/); assert.match(html, /224-50/); assert.match(html, /0\.95/);
assert.match(html, /這筆擷取未保存此市場/); assert.match(html, /完整原始保存 JSON/);
assert.match(html, /沒有官方賽事配對保證/);
assert.doesNotMatch(html, /已完整|可下注|完整尾盤已保存/);

const classified = detail();
classified.record.payload.games = ['EXPLICIT_SOURCE_LOCK', 'NO_PARSED_MARKETS', undefined].map((availabilityEvidence, index) => ({
  awayCode: 'LAL', homeCode: 'GSW', boardTime: `08:0${index}`, marketStatus: 'locked',
  fullRunline: null, fullTotal: null, firstHalfRunline: null, firstHalfTotal: null,
  ...(availabilityEvidence === undefined ? {} : { availabilityEvidence }),
}));
const originalClassified = JSON.stringify(classified);
const classifiedHtml = renderToStaticMarkup(h.scope.ArchiveDetail({ record: classified.record }));
assert.match(classifiedHtml, /08:00｜來源明示鎖盤<\/h4>/);
assert.match(classifiedHtml, /08:01｜未讀到價格<\/h4>/);
assert.match(classifiedHtml, /08:02｜來源標記鎖盤，實際狀態未確認<\/h4>/);
assert.equal(JSON.stringify(classified), originalClassified, 'display labels cannot change original statuses, payload JSON or source hash');
const baseballHtml = renderToStaticMarkup(h.scope.ArchiveDetail({ record: { ...classified.record, league: 'MLB' } }));
assert.match(baseballHtml, /08:00｜鎖盤<\/h4>/);
assert.doesNotMatch(baseballHtml, /來源明示鎖盤|實際狀態未確認/);
const corruptClassifiedHtml = renderToStaticMarkup(h.scope.ArchiveDetail({ record: { ...classified.record, integrity: { status: 'FAIL' } } }));
assert.match(corruptClassifiedHtml, /保存內容雜湊核對失敗/);
assert.doesNotMatch(corruptClassifiedHtml, /來源明示鎖盤|08:00｜|完整原始保存 JSON/);

h.responses.push(async () => response({ ...detail(), record: { ...metadata('a'), integrity: { status: 'FAIL' }, payload: null } }));
await h.click('查看原盤與水位');
assert.match(h.render(), /保存內容雜湊核對失敗/); assert.doesNotMatch(h.render(), /3\+50/);
h.responses.push(async () => ({ ok: false, json: async () => ({ error: '保存清單暫時無法讀取' }) }));
await h.submit(); assert.match(h.render(), /保存清單暫時無法讀取/); assert.doesNotMatch(h.render(), /符合篩選 0/);

let resolveOld;
h.responses.push(() => new Promise(resolve => { resolveOld = resolve; }));
const old = h.submit({ 'archive-league': 'NBA' });
await flush(); const signal = h.calls.at(-1).options.signal;
h.responses.push(async () => response(page('b', false)));
await h.submit({ 'archive-league': 'NBA' }); assert.equal(signal.aborted, true);
resolveOld(response(page('a', false))); await old; await flush();
assert.equal(h.states[0].records[0].captureId, 'b'.repeat(64), 'late previous response cannot replace current result');
console.log('PASS archive records UI: real handlers query original Reader identity, complete cursor pages, single verified quote/water display, missing/corrupt distinction, no-store reads and stale-request protection; browser NOT VERIFIED');
