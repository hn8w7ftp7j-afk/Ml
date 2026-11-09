import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { taipeiHistoryTime } from '../app/market-line-history/history-view.js';

const source = fs.readFileSync('app/market-line-history/raw-history-maintenance-panel.js', 'utf8');
const { code } = await transform(source.replace(/^import .*?;\n/gm, '').replace(/export default function/g, 'function').replace(/export function/g, 'function'), {
  filename: 'raw-history-maintenance-panel.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
});
const flags = { archiveOnly: true, currentBoardUpdated: false, historicalAvailabilityVerified: false, executable: false,
  formalEligible: false, calibrationEligible: false, coverageComplete: false, closingCoverage: 'NOT_VERIFIED', indexCoverage: 'NOT_VERIFIED' };
const countKeys = ['sourceFragments', 'sourceBatches', 'indexedBatches', 'unindexedBatches', 'stableAttemptBatches', 'retryPendingBatches', 'indexedGames'];
const count = (sources, indexed, attempted, fragments = sources, games = indexed * 9) => ({ sourceFragments: fragments, sourceBatches: sources,
  indexedBatches: indexed, unindexedBatches: sources - indexed, stableAttemptBatches: attempted,
  retryPendingBatches: sources - indexed - attempted, indexedGames: games });
function progress(extraIndexed = 0) {
  const leagues = [
    { league: 'EPL', counts: count(60, 6 + extraIndexed, 9, 72), days: [], reasons: [{ code: 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT', batches: 9 }] },
    { league: 'UCL', counts: count(40, 4, 6, 48), days: [], reasons: [{ code: 'RAW_SEEN_RECOVERY_BATCH_INCOMPLETE', batches: 6 }] },
  ];
  for (const row of leagues) row.days = [{ sourceDate: '2026-11-03', counts: structuredClone(row.counts) }];
  return { ok: true, schema: 'soccer-raw-history-maintenance-v1', ...flags, status: 'PENDING', derivationVersion: 'SOCCER-RAW-CREDIT-TABLE-HISTORY-v2',
    until: '2026-11-09T04:00:00.000Z', countUnit: 'CANONICAL_SOURCE_BATCHES', dateBasis: 'SOURCE_OBSERVATION_TAIPEI_DATE',
    dateBucketBasis: 'EARLIEST_SOURCE_OBSERVATION_OF_BATCH',
    counts: Object.fromEntries(countKeys.map(key => [key, leagues.reduce((sum, row) => sum + row.counts[key], 0)])), leagues };
}
function receipt({ partial = false, status = 'BATCH_LIMIT_REACHED' } = {}) {
  const results = [{ league: 'EPL', mode: 'COVERAGE', status: 'INDEXED', captureId: 'a'.repeat(64), indexedGames: 9 }];
  if (partial) results.push({ league: 'UCL', mode: 'BACKLOG', status: 'RETRYABLE', captureId: 'b'.repeat(64), reason: 'RAW_HISTORY_INDEX_UNAVAILABLE' });
  return { ok: !partial, schema: 'soccer-raw-history-maintenance-v1', ...flags, until: '2026-11-09T04:00:00.000Z', status: partial ? 'RETRYABLE' : status,
    budgetKind: 'SOFT_DEADLINE', hardDeadlineEnforced: false, completeWithinWindow: false, results,
    processedBatches: results.length, indexedBatches: 1, stableAttemptBatches: 0, retryableBatches: partial ? 1 : 0, maxBatches: 24, timeBudgetMs: 40000 };
}
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
function harness() {
  let index = 0, dirty = false, tree, timerSequence = 0, unmounted = false, afterUnmountMutations = 0;
  const hooks = [], effects = [], calls = [], timers = new Map();
  const scope = vm.createContext({ React, taipeiHistoryTime, AbortController, styles: {},
    window: { setTimeout: (fn, ms) => { const id = ++timerSequence; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) },
    useState: initial => { const n = index++; if (!(n in hooks)) hooks[n] = typeof initial === 'function' ? initial() : initial;
      return [hooks[n], value => { if (unmounted) afterUnmountMutations++; hooks[n] = typeof value === 'function' ? value(hooks[n]) : value; dirty = true; }]; },
    useRef: initial => { const n = index++; return hooks[n] ??= { current: initial }; },
    useEffect: (fn, deps) => { const n = index++, old = hooks[n]; if (old && deps.every((value, j) => Object.is(value, old.deps[j]))) return;
      hooks[n] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[n].cleanup = fn(); }); },
    fetch: (url, options) => new Promise((resolve, reject) => calls.push({ url, options,
      respond: (body, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }), reject })),
  });
  vm.runInContext(code, scope);
  function render() { let turns = 0; do { dirty = false; index = 0; tree = scope.RawHistoryMaintenancePanel(); effects.splice(0).forEach(fn => fn());
    assert.ok(turns++ < 20); } while (dirty); }
  async function settle() { for (let i = 0; i < 35; i++) { await Promise.resolve(); if (dirty && !unmounted) render(); } }
  function click(label) { return nodes(tree).find(node => node.type === 'button' && text(node.props.children).includes(label)).props.onClick(); }
  return { scope, calls, timers, render, settle, click, get tree() { return tree; }, get markup() { return renderToStaticMarkup(tree); },
    get afterUnmountMutations() { return afterUnmountMutations; },
    expire: () => { const [id, timer] = [...timers.entries()][0] || []; assert.ok(timer); timers.delete(id); assert.ok(timer.ms > 40000 && timer.ms <= 55000); timer.fn(); },
    unmount: () => { unmounted = true; hooks.forEach(hook => hook?.cleanup?.()); } };
}

const h = harness(); h.render();
assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, '/api/soccer/raw-seen-history-maintenance');
assert.equal(h.calls[0].options.method, undefined); assert.equal(h.calls[0].options.cache, 'no-store'); assert.equal(h.calls[0].options.credentials, 'same-origin');
assert.equal(h.scope.validateRawHistoryMaintenanceProgress(progress()).counts.sourceBatches, 100);
for (const mutate of [
  value => { value.ok = false; }, value => { value.schema = 'wrong'; }, value => { value.until = '2026-02-30T04:00:00.000Z'; },
  value => { value.until = '2026-11-09T24:00:00.000Z'; }, value => { value.until = '2026-11-09T23:60:00.000Z'; },
  value => { value.countUnit = 'GAMES'; }, value => { value.dateBasis = 'BOARD_DATE'; }, value => { value.derivationVersion = ''; },
  value => { value.dateBucketBasis = 'LATEST_SOURCE_OBSERVATION_OF_BATCH'; },
  value => { value.counts = null; }, value => { value.counts.sourceBatches = '100'; }, value => { value.counts.sourceFragments = 1; },
  value => { value.counts.indexedBatches++; }, value => { value.counts.retryPendingBatches++; }, value => { delete value.counts.indexedGames; },
  value => { value.status = 'DONE'; }, value => { value.status = 'NO_PENDING_SOURCE'; }, value => { value.status = 'SOURCE_UNINDEXED'; },
  value => { value.leagues.pop(); }, value => { value.leagues[1].league = 'EPL'; }, value => { value.leagues[1].league = 'NBA'; },
  value => { value.identityVerified = true; }, value => { value.leagues[0].executable = true; }, value => { value.leagues[0].days[0].coverageComplete = true; },
  value => { value.leagues[0].days[0].sourceDate = '2026-02-30'; }, value => { value.leagues[0].days.push(structuredClone(value.leagues[0].days[0])); },
  value => { value.leagues[0].days[0].counts.sourceBatches--; }, value => { value.leagues[0].reasons[0].batches--; },
  value => { value.leagues[0].reasons[0].code = '<script>'; }, value => { value.leagues[0].reasons.push(structuredClone(value.leagues[0].reasons[0])); },
  ...Object.keys(flags).map(key => value => { value[key] = typeof flags[key] === 'boolean' ? !flags[key] : 'COMPLETE'; }),
]) { const value = progress(); mutate(value); assert.throws(() => h.scope.validateRawHistoryMaintenanceProgress(value), /未通過核對/); }
const absent = progress(); absent.status = 'NOT_INITIALIZED'; absent.counts = null;
for (const row of absent.leagues) { row.counts = null; row.days = []; row.reasons = []; }
assert.equal(h.scope.validateRawHistoryMaintenanceProgress(absent).counts, null);
const falseZero = structuredClone(absent); falseZero.counts = count(0, 0, 0);
assert.throws(() => h.scope.validateRawHistoryMaintenanceProgress(falseZero), /未通過核對/);
for (const name of ['constructor', '__proto__', 'toString']) {
  const inherited = structuredClone(absent); inherited.leagues[1].league = name;
  assert.throws(() => h.scope.validateRawHistoryMaintenanceProgress(inherited), /未通過核對/);
}

assert.equal(h.scope.validateRawHistoryMaintenanceReceipt(receipt()).indexedBatches, 1);
for (const mutate of [
  value => { value.schema = 'wrong'; }, value => { value.ok = 'yes'; }, value => { value.until = ''; }, value => { value.status = 'COMPLETE'; },
  value => { value.completeWithinWindow = true; }, value => { value.hardDeadlineEnforced = true; }, value => { value.budgetKind = 'HARD_DEADLINE'; },
  value => { value.timeBudgetMs = 60000; }, value => { value.maxBatches = 10000; }, value => { value.processedBatches++; },
  value => { value.indexedBatches = 0; }, value => { value.results[0].captureId = 'bad'; }, value => { value.results[0].league = 'NBA'; },
  value => { value.results[0].indexedGames = 0; }, value => { value.results[0].status = 'SOURCE_UNINDEXED'; },
  value => { value.identityVerified = true; }, value => { value.results[0].executable = true; },
  ...Object.keys(flags).map(key => value => { value[key] = typeof flags[key] === 'boolean' ? !flags[key] : 'COMPLETE'; }),
]) { const value = receipt(); mutate(value); assert.throws(() => h.scope.validateRawHistoryMaintenanceReceipt(value), /未通過核對/); }

h.calls[0].respond(progress()); await h.settle();
assert.match(h.markup, /已保存來源/); assert.match(h.markup, /英超 EPL/); assert.match(h.markup, /歐冠 UCL/);
assert.match(h.markup, /尚未轉成可查盤口 9 批/); assert.match(h.markup, /來源片段仍待核對 6 批/);
assert.match(h.markup, /可能包含附加文字、其他賽事與未支援格式/); assert.match(h.markup, /批次數不等於缺失場次/);
assert.doesNotMatch(h.markup, /來源版面尚待支援/);
assert.match(h.markup, /與賽事盤日不同/); assert.match(h.markup, /一批可能包含多場/); assert.equal(h.calls.length, 1, 'pending counts do not start an automatic write loop');
const drain = h.click('整理已保存盤口'); h.click('整理已保存盤口'); h.click('重新查詢'); await h.settle();
assert.equal(h.calls.length, 2, 'a synchronous in-flight guard prevents both double clicks and overlapping refreshes');
const post = h.calls[1]; assert.equal(post.url, '/api/soccer/raw-seen-history-maintenance'); assert.equal(post.options.method, 'POST');
assert.deepEqual(JSON.parse(post.options.body), { action: 'drain' }); assert.equal(post.options.headers['Content-Type'], 'application/json');
assert.equal(post.options.credentials, 'same-origin'); assert.equal(post.options.cache, 'no-store');
post.respond(receipt()); await h.settle(); assert.equal(h.calls.length, 3, 'one write receipt is followed by one fresh progress GET');
assert.equal(h.calls[2].options.method, undefined); assert.equal(h.calls[2].options.signal, post.options.signal);
h.calls[2].respond(progress(1)); await drain; await h.settle();
assert.match(h.markup, /本輪已建立 1 批查閱資料/); assert.match(h.markup, /已達處理上限，剩餘量以最新進度為準/); assert.equal(h.calls.length, 3);
const invalidPost = h.click('整理已保存盤口'); await h.settle(); const brokenReceipt = receipt(); brokenReceipt.executable = true;
h.calls[3].respond(brokenReceipt); await invalidPost; await h.settle();
assert.match(h.markup, /整理回條未通過核對/); assert.match(h.markup, /來源量與待整理數量：未確認/); assert.equal(h.calls.length, 4, 'an invalid receipt cannot publish success or issue the chained progress fetch');

const partial = h.click('整理已保存盤口'); await h.settle(); h.calls[4].respond(receipt({ partial: true }), 503); await h.settle();
assert.equal(h.calls.length, 6); h.calls[5].respond(progress(1)); await partial; await h.settle();
assert.match(h.markup, /本輪已建立 1 批查閱資料，部分整理結果尚未確認/); assert.doesNotMatch(h.markup, /全部完成/);
const failedProgress = h.click('重新查詢'); await h.settle(); h.calls[6].respond({ error: 'private-db-error' }, 503); await failedProgress; await h.settle();
assert.match(h.markup, /數量仍未確認/); assert.doesNotMatch(h.markup, /private-db-error/); assert.doesNotMatch(h.markup, /尚未轉成可查盤口 9 批/);
const noSchema = h.click('重新查詢'); await h.settle(); h.calls[7].respond(absent); await noSchema; await h.settle();
assert.match(h.markup, /整理進度尚未建立/); assert.doesNotMatch(h.markup, /<td>0<\/td>/);

// A timeout explicitly ends waiting without claiming server cancellation. A
// late aborted POST cannot overwrite the subsequent, newer progress response.
const timed = h.click('整理已保存盤口'); await h.settle(); const stale = h.calls[8]; h.expire(); await h.settle();
assert.equal(stale.options.signal.aborted, true); assert.match(h.markup, /等候整理結果逾時，結果仍未確認/);
const retry = h.click('重新查詢'); await h.settle(); h.calls[9].respond(progress(2)); await retry; await h.settle();
const freshMarkup = h.markup; stale.respond(receipt()); await timed; await h.settle();
assert.equal(h.calls.length, 10); assert.equal(h.markup, freshMarkup, 'late aborted result is fenced before any state change or chained GET');
const unresolved = h.click('重新查詢'); await h.settle(); const last = h.calls[10]; h.unmount(); assert.equal(last.options.signal.aborted, true);
last.respond(progress()); await unresolved; await h.settle(); assert.equal(h.afterUnmountMutations, 0); assert.equal(h.timers.size, 0);

const refreshTimeout = harness(); refreshTimeout.render(); refreshTimeout.calls[0].respond(progress()); await refreshTimeout.settle();
const knownWrite = refreshTimeout.click('整理已保存盤口'); await refreshTimeout.settle(); refreshTimeout.calls[1].respond(receipt()); await refreshTimeout.settle();
assert.equal(refreshTimeout.calls.length, 3); const staleRead = refreshTimeout.calls[2]; refreshTimeout.expire(); await refreshTimeout.settle();
assert.match(refreshTimeout.markup, /本輪已建立 1 批查閱資料/); assert.match(refreshTimeout.markup, /整理回條已收到，最新進度查詢逾時/);
staleRead.respond(progress()); await knownWrite; await refreshTimeout.settle();
assert.match(refreshTimeout.markup, /來源量與待整理數量：未確認/); refreshTimeout.unmount();

const limited = harness(); limited.render(); limited.calls[0].respond({ private: 'unpublished-upstream-message' }, 429); await limited.settle();
assert.match(limited.markup, /查詢較密集/); assert.doesNotMatch(limited.markup, /unpublished-upstream-message/);
const deniedWrite = limited.click('整理已保存盤口'); await limited.settle(); limited.calls[1].respond({}, 429); await deniedWrite; await limited.settle();
assert.match(limited.markup, /整理操作較密集/); assert.doesNotMatch(limited.markup, /整理回條未通過核對/); assert.equal(limited.calls.length, 2);
const recheck = limited.click('重新查詢'); await limited.settle(); limited.calls[2].respond(progress()); await recheck; await limited.settle();
assert.match(limited.markup, /已保存來源/); limited.unmount();

const page = fs.readFileSync('app/market-line-history/page.js', 'utf8');
assert.match(page, /<RawHistoryMaintenancePanel\/>/); assert.match(page, /<RawSeenHistoryIndexPanel\/>/); assert.match(page, /<ArchivePanel\/>/);
assert.doesNotMatch(source, /dangerouslySetInnerHTML|\/api\/(?:analy|bets|soccer\/(?:analysis|reader)[?'"`])/);
for (const path of process.argv.slice(2).map(value => value === '--contract-fixture' ? join(tmpdir(), 'history-maintenance-contract-fixtures.json') : value)) {
  const actual = JSON.parse(fs.readFileSync(path, 'utf8'));
  h.scope.validateRawHistoryMaintenanceProgress(actual.progress);
  h.scope.validateRawHistoryMaintenanceReceipt(actual.receipt);
  console.log('PASS maintenance UI validates actual database progress and drain receipts');
}
console.log('PASS shipped maintenance progress UI: validated canonical counts and date buckets, source-unindexed reasons, unknown instead of zero, explicit owner-only drain then single GET, partial receipts, double-click guard, 52s timeout, abort/unmount/late-response fencing, no financial or model actions; Production NOT VERIFIED');
