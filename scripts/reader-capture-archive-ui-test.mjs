import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { taipeiHistoryTime } from '../app/market-line-history/history-view.js';

const source = fs.readFileSync('app/market-line-history/archive-panel.js', 'utf8');
const { code } = await transform(source.replace(/^import .*?;\n/gm, '').replace(/export default function/g, 'function').replace(/export function/g, 'function'), {
  filename: 'reader-capture-archive-panel.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
});
const leagueIds = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL'];
function summary(count = 1) {
  return { ok: true, schema: 'READER-CAPTURE-ARCHIVE-v1', archiveOnly: true, currentBoardUpdated: false,
    historicalAvailabilityVerified: false, executable: false,
    leagues: leagueIds.map(league => ({ league, captureCount: league === 'NBA' ? count : 0,
      firstBoardDate: league === 'NBA' && count ? '2026-10-30' : null, lastBoardDate: league === 'NBA' && count ? '2026-10-30' : null,
      lastObservedAt: league === 'NBA' && count ? '2026-10-29T17:00:00.000Z' : null,
      lastPersistedAt: league === 'NBA' && count ? '2026-10-30T01:00:00.000Z' : null })) };
}
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
function harness() {
  const states = [null, '', false], ref = { current: { sequence: 0, controller: null } }, calls = [], responses = [];
  let cursor = 0, effect, timer = 0;
  const scope = vm.createContext({ React, taipeiHistoryTime, AbortController, styles: {},
    useState: () => { const index = cursor++; return [states[index], value => { states[index] = value; }]; },
    useRef: () => ref, useCallback: fn => fn, useEffect: fn => { effect = fn; },
    window: { setTimeout: () => ++timer, clearTimeout() {} },
    fetch: (url, options) => { calls.push({ url, options }); const response = responses.shift(); assert.ok(response, 'fixture has a response for every read'); return response(); },
  });
  vm.runInContext(code, scope);
  const tree = () => { cursor = 0; return scope.ArchivePanel(); };
  return { scope, states, ref, calls, responses, tree,
    render: () => renderToStaticMarkup(tree()),
    load: () => nodes(tree()).find(node => node.type === 'button').props.onClick(),
    mount: () => { tree(); return effect(); } };
}
const response = payload => ({ ok: true, status: 200, json: async () => payload });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const h = harness();
assert.equal(h.scope.validateArchiveSummary(summary()).leagues.length, 7);
for (const mutate of [
  value => { value.ok = false; }, value => { value.schema = 'market-history-coverage-v1'; },
  value => { value.archiveOnly = false; }, value => { value.currentBoardUpdated = true; },
  value => { value.historicalAvailabilityVerified = true; }, value => { value.executable = true; },
  value => { value.leagues.pop(); }, value => { value.leagues[0] = value.leagues[1]; },
  value => { value.leagues[0].league = 'NHL'; }, value => { value.leagues[0].captureCount = null; },
  value => { value.leagues[0].captureCount = -1; }, value => { value.leagues[0].lastObservedAt = '2026-10-30T00:00:00Z'; },
  value => { value.leagues[4].firstBoardDate = '2026-02-30'; }, value => { value.leagues[4].lastObservedAt = null; },
  value => { value.leagues[4].lastPersistedAt = '2026-10-30 01:00:00'; },
]) {
  const value = summary(); mutate(value);
  assert.throws(() => h.scope.validateArchiveSummary(value), /未當作零筆或完整保存/);
}

h.responses.push(async () => response(summary()));
await h.load();
const html = h.render();
assert.match(html, /斷線補傳歸檔（1 筆擷取）/);
assert.match(html, /2026\/10\/30\s01:00:00/);
assert.match(html, /2026\/10\/30\s09:00:00/, 'late storage time is not substituted for the original observation');
assert.match(html, /零筆表示尚未收到此類歸檔，不能判定未開盤/);
assert.match(html, /不併入上方變盤版本，也不更新即時分析/);
assert.match(html, /沒有原始畫面截圖/);
assert.equal((html.match(/<tr>/g) || []).length, 8, 'allseven leagues andheader are rendered');
assert.doesNotMatch(html, /<details[^>]*\bopen/, 'supplemental archive remains collapsed');
assert.equal(h.calls[0].url, '/api/reader/archive');
assert.equal(h.calls[0].options.credentials, 'same-origin');
assert.equal(h.calls[0].options.cache, 'no-store');
assert.equal(h.calls[0].options.method, undefined, 'summary UI is read-only');

h.responses.push(async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) }));
await h.load();
const failed = h.render();
assert.match(failed, /role="alert"/);
assert.match(failed, /未當作零筆/);
assert.doesNotMatch(failed, /<table|1 筆擷取|0 筆擷取/, 'failed refresh clears old scope anddoesnot inventzero');
h.responses.push(async () => response(summary(0)));
await h.load();
assert.match(h.render(), /斷線補傳歸檔（0 筆擷取）/);

const oldRead = deferred(), newRead = deferred();
h.responses.push(() => oldRead.promise, () => newRead.promise);
const oldLoad = h.load(), oldSignal = h.calls.at(-1).options.signal;
const newLoad = h.load();
assert.equal(oldSignal.aborted, true);
newRead.resolve(response(summary(2))); await newLoad;
oldRead.resolve(response(summary(1))); await oldLoad;
assert.match(h.render(), /斷線補傳歸檔（2 筆擷取）/, 'late earlier response cannot overwrite newer read');

const mounted = harness(), mountRead = deferred();
mounted.responses.push(() => mountRead.promise);
const cleanup = mounted.mount();
assert.equal(mounted.calls.length, 1, 'page load automatically reads archive summary');
cleanup();
assert.equal(mounted.calls[0].options.signal.aborted, true, 'unmount aborts theinflightrequest');
mountRead.resolve(response(summary()));
await new Promise(resolve => setImmediate(resolve));
assert.equal(mounted.states[0], null, 'unmounted fetch cannot set a result');

const page = fs.readFileSync('app/market-line-history/page.js', 'utf8');
const history = fs.readFileSync('app/market-line-history/history-browser.js', 'utf8');
assert.match(page, /<HistoryBrowser><ArchivePanel\/><\/HistoryBrowser>/);
assert.match(history, /<CoveragePanel\/>\s*\{children\}/, 'archive slot follows existingcoveragewithoutchangingitscounts');
console.log('Reader capture archive UI: sevenleague receipt validation, source versus persistence time, failures distinct from zero, stale response suppression, andunmount abort PASS');
