import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';

const source = fs.readFileSync('app/soccer/official-market-coverage-panel.js', 'utf8').replace(/^import .*?;\n/gm, '').replace(/export function/g, 'function');
const { code } = await transform(source, { filename: 'official-market-coverage-panel.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } } });
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
function harness() {
  let i = 0, dirty = false, tree, props = { league: 'epl', date: '2026-11-10' }, timerId = 0;
  const hooks = [], effects = [], calls = [], timers = new Map();
  const context = vm.createContext({ React, Date, AbortController, URLSearchParams,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id),
    useState: initial => { const n = i++; if (!(n in hooks)) hooks[n] = initial; return [hooks[n], value => { hooks[n] = typeof value === 'function' ? value(hooks[n]) : value; dirty = true; }]; },
    useRef: initial => { const n = i++; return hooks[n] ??= { current: initial }; },
    useEffect: (fn, deps) => { const n = i++, old = hooks[n]; if (old && deps.every((value, j) => Object.is(value, old.deps[j]))) return;
      hooks[n] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[n].cleanup = fn(); }); },
    fetch: (url, options) => new Promise(resolve => calls.push({ url, options, respond: (body, status = 200, headers = {}) => resolve({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body }) })),
  });
  vm.runInContext(code, context);
  function render(next = props) { props = next; let turns = 0; do { dirty = false; i = 0; tree = context.SoccerOfficialMarketCoveragePanel(props); effects.splice(0).forEach(fn => fn()); assert.ok(turns++ < 20); } while (dirty); }
  async function settle() { for (let n = 0; n < 40; n++) { await Promise.resolve(); if (dirty) render(); } }
  return { render, settle, calls, context, get tree() { return tree; }, get markup() { return renderToStaticMarkup(tree); },
    button(label) { const button = nodes(tree).find(node => node.type === 'button' && text(node.props.children) === label); assert.ok(button, `missing ${label}`); return button; },
    advance(ms) { const match = [...timers].find(([, timer]) => timer.ms === ms); assert.ok(match, `missing ${ms}ms timer`); timers.delete(match[0]); match[1].fn(); },
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}
const sha = value => value.repeat(64), cursor = 'abc.' + 'a'.repeat(43), day = '2026-11-10';
const keys = ['FT:HANDICAP', 'FT:TOTAL', 'HT:HANDICAP', 'HT:TOTAL'];
const cells = fn => Object.fromEntries(keys.map(key => fn([key])));
function report({ from = 0, read = 1, total = 2, league = 'epl', date = day, unknown = false, change = {} } = {}) {
  const hasMore = from + read < total;
  return { version: 'SOCCER-OFFICIAL-MARKET-COVERAGE-v1', league, date, status: !hasMore && from === 0 ? 'COMPLETE_PROVIDER_SCOPE' : 'PARTIAL',
    schedule: { fingerprint: sha('a'), sourceScope: 'RETURNED_PROVIDER_PAGES_ONLY', officialGameCount: 1, empty: false, sourceVerified: true, providerCompletenessVerified: false },
    history: { snapshotHash: sha('b'), cutoffAt: '2026-11-09T04:00:00.000000Z', totalReceipts: total, readFrom: from, readCount: read, readThrough: from + read,
      hasMore, nextCursor: hasMore ? cursor : null, scopeComplete: !hasMore && from === 0, integrityStatus: 'VERIFIED_PAGE', historicalAvailabilityVerified: false },
    games: [{ gameId: `soccer:${league}:9001`, label: '水晶宮 @ 布萊頓', startTime: '2026-11-10T13:00:00.000Z', status: 'scheduled',
      seen: { cells: cells(([key]) => [key, { marketIds: key === 'FT:TOTAL' ? [sha('c')] : [], completeMarketIds: key === 'FT:TOTAL' ? [sha('c')] : [], quoteIds: key === 'FT:TOTAL' ? [sha('d')] : [] }]), unknownPeriodQuoteCount: 0 },
      current: { status: unknown ? 'NOT_VERIFIED' : 'AVAILABLE', observedAt: '2026-11-09T04:00:00.000Z', cells: unknown ? null : cells(([key]) => [key, { marketCount: 1, completePriceMarketCount: 1, freshPregameMarketCount: 1, quoteCount: 2 }]) } }],
    unmatched: [{ key: sha('e'), label: '未配對原盤', status: 'UNMATCHED', observationCount: 1 }], currentUnmatched: [],
    diagnostics: { currentStatus: unknown ? 'NOT_VERIFIED' : 'AVAILABLE', currentAsOf: '2026-11-09T04:00:00.000Z', reasonCodes: [] },
    coverageComplete: false, formalEligible: false, executable: false, ...change };
}
const h = harness(); h.render(); assert.equal(h.calls.length, 1);
assert.equal(new URL('http://test' + h.calls[0].url).searchParams.get('date'), day);
assert.equal(h.calls[0].options.cache, 'no-store'); h.calls[0].respond({ ok: true, report: report() }); await h.settle();
assert.match(h.markup, /PARTIAL/); assert.match(h.markup, /本輪未見/); assert.equal(h.calls.length, 1, 'initial active view reads one bounded page');
const running = h.button('繼續核對來源').props.onClick(); assert.equal(h.calls.length, 2);
assert.equal(new URL('http://test' + h.calls[1].url).searchParams.get('cursor'), cursor);
h.calls[1].respond({ ok: true, report: report({ from: 1 }) }); await running; await h.settle();
assert.match(h.markup, /來源範圍讀取完成/); assert.match(h.markup, /1 盤線（雙邊 1）/); assert.match(h.markup, /未見/);
assert.match(h.markup, /尚未證明所有賽程或所有盤線已收齊/); assert.match(h.markup, /未配對原盤/);
const valid = h.context.soccerOfficialCoveragePageValid, merge = h.context.mergeSoccerOfficialCoveragePage;
assert.equal(valid(report(), 'epl', day), true); assert.equal(valid(report({ league: 'ucl' }), 'epl', day), false);
assert.throws(() => merge(null, report({ from: 1 }), 'epl', day));
const first = merge(null, report(), 'epl', day); assert.equal(first.sourceReadComplete, false);
const done = merge(first, report({ from: 1 }), 'epl', day); assert.equal(done.sourceReadComplete, true);
assert.equal(done.games[0].seen.cells['FT:TOTAL'].marketIds.length, 1); assert.equal(done.games[0].current.cells['FT:TOTAL'].freshPregameMarketCount, 1, 'current heads are replaced, never summed across pages');
assert.throws(() => merge(first, report({ from: 0 }), 'epl', day));
const changed = report({ from: 1 }); changed.history.snapshotHash = sha('f'); assert.throws(() => merge(first, changed, 'epl', day));
const falseComplete = report(); falseComplete.history.scopeComplete = true; assert.equal(valid(falseComplete, 'epl', day), false);
const badCount = report(); badCount.games[0].current.cells['FT:TOTAL'].freshPregameMarketCount = 2; assert.equal(valid(badCount, 'epl', day), false);
const unknown = harness(); unknown.render(); unknown.calls[0].respond({ ok: true, report: report({ unknown: true }) }); await unknown.settle();
assert.match(unknown.markup, /目前未知/); assert.doesNotMatch(unknown.markup, /有效 0/);
const failure = harness(); failure.render(); failure.calls[0].respond({ ok: false, error: 'sensitive database body' }, 503); await failure.settle();
assert.match(failure.markup, /數量未知/); assert.doesNotMatch(failure.markup, /sensitive database|返回 0 場/);
const hidden = harness(); hidden.render({ league: 'epl', date: day, active: false }); assert.equal(hidden.calls.length, 0); assert.equal(hidden.markup, '');
hidden.render({ league: 'epl', date: day, active: true }); assert.equal(hidden.calls.length, 1); hidden.render({ league: 'epl', date: day, active: false }); assert.equal(hidden.calls[0].options.signal.aborted, true);
const race = harness(); race.render(); race.render({ league: 'ucl', date: '2026-11-11' }); assert.equal(race.calls[0].options.signal.aborted, true);
race.calls[0].respond({ ok: true, report: report() }); race.calls[1].respond({ ok: true, report: report({ league: 'ucl', date: '2026-11-11', total: 1 }) }); await race.settle();
assert.match(race.markup, /來源範圍讀取完成/); assert.equal(race.calls.length, 2);
const throttle = harness(); throttle.render(); throttle.calls[0].respond({ ok: false }, 429, { 'Retry-After': '7' }); await throttle.settle();
assert.match(throttle.markup, /等待請求額度/); throttle.advance(7000); await throttle.settle(); assert.equal(throttle.calls.length, 2);
throttle.calls[1].respond({ ok: true, report: report() }); await throttle.settle();
const conflict = harness(); conflict.render(); conflict.calls[0].respond({ ok: true, report: report() }); await conflict.settle();
const conflictRun = conflict.button('繼續核對來源').props.onClick(); conflict.calls[1].respond({ ok: false, code: 'SOCCER_MARKET_COVERAGE_SCOPE_CHANGED' }, 409); await conflict.settle();
conflict.advance(1100); await conflict.settle(); assert.equal(new URL('http://test' + conflict.calls[2].url).searchParams.has('cursor'), false);
conflict.calls[2].respond({ ok: true, report: report({ total: 1 }) }); await conflictRun; await conflict.settle(); assert.match(conflict.markup, /來源範圍讀取完成/);
const paced = harness(); paced.render(); paced.calls[0].respond({ ok: true, report: report({ total: 3 }) }); await paced.settle();
const pacedRun = paced.button('繼續核對來源').props.onClick(); paced.calls[1].respond({ ok: true, report: report({ from: 1, total: 3 }) }); await paced.settle();
assert.equal(paced.calls.length, 2); paced.advance(1100); await paced.settle(); assert.equal(paced.calls.length, 3);
paced.calls[2].respond({ ok: true, report: report({ from: 2, total: 3 }) }); await pacedRun; await paced.settle(); assert.match(paced.markup, /已核對 3／3/);
const paused = harness(); paused.render(); paused.calls[0].respond({ ok: true, report: report({ total: 3 }) }); await paused.settle();
const pauseRun = paused.button('繼續核對來源').props.onClick(); paused.calls[1].respond({ ok: true, report: report({ from: 1, total: 3 }) }); await paused.settle();
paused.button('暫停核對').props.onClick(); await pauseRun; await paused.settle(); assert.match(paused.markup, /已暫停或逾時/); assert.match(paused.markup, /已核對 2／3/);
for (const instance of [h, unknown, failure, hidden, race, throttle, conflict, paced, paused]) instance.unmount();
console.log('PASS real coverage JSX/hooks: active-only initial read, strict league/date/manifest/page sequence, ID dedup, independent current heads, explicit partial/unknowns, paced full continuation, Retry-After, source restart, pause/resume and scope-switch cancellation');
