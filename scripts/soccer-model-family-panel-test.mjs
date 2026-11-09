import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';

const source = fs.readFileSync('app/soccer/model-family-panel.js', 'utf8').replace(/^import .*?;\n/gm, '').replace(/export function/g, 'function');
const { code } = await transform(source, { filename: 'model-family-panel.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } } });
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
function harness() {
  let i = 0, dirty = false, tree, props = { league: 'epl' }, timerId = 0;
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
  function render(next = props) { props = next; let turns = 0; do { dirty = false; i = 0; tree = context.SoccerModelFamilyPanel(props); effects.splice(0).forEach(fn => fn()); assert.ok(turns++ < 20); } while (dirty); }
  async function settle() { for (let n = 0; n < 40; n++) { await Promise.resolve(); if (dirty) render(); } }
  return { render, settle, calls, context, get tree() { return tree; }, get markup() { return renderToStaticMarkup(tree); },
    button(label) { const button = nodes(tree).find(node => node.type === 'button' && text(node.props.children) === label); assert.ok(button, `missing ${label}`); return button; },
    advance(ms) { const match = [...timers].find(([, timer]) => timer.ms === ms); assert.ok(match, `missing ${ms}ms timer`); timers.delete(match[0]); match[1].fn(); },
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}
const sha = digit => digit.repeat(64), cursor = 'a'.repeat(48);
const restrictions = { formalEligible: false, executable: false, W: null, R: null, S: null };
function notStarted(league, period) { return { version: 'SOCCER-MODEL-FAMILY-DURABLE-REPLAY-v1', league, period, status: 'NOT_STARTED', ...restrictions }; }
function report({ league = 'epl', period = 'FT', complete = false, processed = 1, games = 2, change = {} } = {}) {
  return { ...notStarted(league, period), status: complete ? 'REPLAY_COMPLETE' : 'REPLAY_PARTIAL', cursor, sourceRevision: sha('b'),
    asOf: '2026-11-09T08:00:00.000Z', processedCaptures: processed, totalCaptures: 2, completeWithinRequestedScope: complete,
    nextCursor: complete ? null : cursor, quarantinedGames: 0, excludedReasons: {}, sourceModelFreezeVerified: true,
    confidenceSet: complete ? { independentRealGames: games, contentHash: sha('c'), protocolHash: sha('d'),
      baseline: { league, period, modelHash: sha('e'), trainingHash: sha('f') }, ...restrictions,
      coverageAssumptionsVerified: false, marginals: { home: { multiplier: { lower: 0.8, upper: 1.4 } }, away: { multiplier: { lower: 0.7, upper: 1.8 } } } } : null,
    diagnostics: complete ? { calibration: { sides: { home: { pearsonPerGame: { value: 1.2 } }, away: { pearsonPerGame: { value: 2 } } } } } : null, ...change };
}
function freeze(artifactReport, change = {}) { return { status: 'DATABASE_FROZEN_FAMILY_RESEARCH', league: artifactReport.league,
  period: artifactReport.period, modelHash: artifactReport.confidenceSet.baseline.modelHash, trainingHash: artifactReport.confidenceSet.baseline.trainingHash,
  protocolHash: artifactReport.confidenceSet.protocolHash, sourceArtifactHash: artifactReport.confidenceSet.contentHash,
  freezeId: sha('1'), parameterHash: sha('2'), frozenAt: '2026-11-09T08:10:00.000Z', testFrom: '2026-11-10T00:00:00.000Z',
  testBefore: '2026-12-23T00:00:00.000Z', coverageAssumptionsVerified: false, ...restrictions, ...change }; }
async function initial(h, reports = {}) {
  h.render(); assert.equal(h.calls.length, 2);
  for (const call of h.calls) { const params = new URL(`http://test${call.url}`).searchParams;
    assert.equal(params.get('league'), 'epl'); call.respond({ ok: true, report: reports[params.get('period')] || notStarted('epl', params.get('period')) }); }
  await h.settle();
}
const h = harness(); await initial(h); assert.match(h.markup, /NOT VERIFIED/);
assert.equal(h.context.soccerModelFamilyReportValid(report(), 'epl', 'FT'), true);
assert.equal(h.context.soccerModelFamilyReportValid(report({ period: 'HT' }), 'epl', 'FT'), false);
assert.equal(h.context.soccerModelFamilyReportValid(report({ change: { confidenceSet: { independentRealGames: 1 } } }), 'epl', 'FT'), false,
  'partial replay never displays a fitted confidence set');
assert.equal(h.context.soccerModelFamilyReportValid(report({ complete: true, processed: 1 }), 'epl', 'FT'), false);
assert.equal(h.context.soccerModelFamilyReportValid(report({ complete: true, processed: 2, change: { R: 0.1 } }), 'epl', 'FT'), false);
const running = h.button('核對全場模型誤差').props.onClick(); assert.equal(h.calls.length, 3);
assert.deepEqual(JSON.parse(h.calls[2].options.body), { league: 'epl', period: 'FT', action: 'replay' });
h.calls[2].respond({ ok: true, report: report() }); await h.settle();
assert.match(h.markup, /PARTIAL/); assert.doesNotMatch(h.markup, /有效獨立賽事/);
assert.equal(h.button('核對上半場模型誤差').props.disabled, true, 'only one period may consume replay allowance at a time');
assert.equal(h.calls.length, 3, 'continuation is paced, not immediate');
h.advance(1100); await h.settle(); assert.equal(h.calls.length, 4);
assert.deepEqual(JSON.parse(h.calls[3].options.body), { league: 'epl', period: 'FT', cursor, action: 'replay' });
const complete = report({ complete: true, processed: 2 }); h.calls[3].respond({ ok: true, report: complete });
await running; await h.settle(); assert.match(h.markup, /有效獨立賽事 2 場/); assert.match(h.markup, /正式 R／S：尚未驗收/);
const freezing = h.button('固定後續驗證版本').props.onClick();
assert.deepEqual(JSON.parse(h.calls[4].options.body), { league: 'epl', period: 'FT', cursor, action: 'freeze' });
h.calls[4].respond({ ok: true, freeze: freeze(complete) }); await freezing; await h.settle();
assert.match(h.markup, /後續驗證版本已固定/); assert.match(h.markup, /尚未代表後續驗證通過/);
assert.equal(h.context.soccerModelFamilyFreezeValid(freeze(complete, { period: 'HT' }), complete), false);
assert.equal(h.context.soccerModelFamilyFreezeValid(freeze(complete, { frozenAt: '2026-11-10T00:00:00.000Z' }), complete), false);
const zero = harness(); await initial(zero, { FT: report({ complete: true, processed: 2, games: 0 }) });
assert.match(zero.markup, /誤差不可當成 0/); assert.doesNotMatch(zero.markup, /固定後續驗證版本/);
const reload = harness(); await initial(reload, { FT: { ...complete, freeze: freeze(complete), freezeMatchesReplay: true } });
assert.match(reload.markup, /後續驗證版本已固定/);
const different = harness(); await initial(different, { FT: { ...complete, freeze: freeze(complete, { sourceArtifactHash: sha('9') }), freezeMatchesReplay: false } });
assert.match(different.markup, /已有固定版本，本次來源版本不同/);
const error = harness(); await initial(error);
const errorRun = error.button('核對全場模型誤差').props.onClick(); error.calls[2].respond({ ok: false, error: 'sensitive-source-body' }, 503);
await errorRun; await error.settle(); assert.match(error.markup, /結果未知/); assert.doesNotMatch(error.markup, /sensitive-source-body|有效獨立賽事 0/);
const conflict = harness(); await initial(conflict);
const conflictRun = conflict.button('核對全場模型誤差').props.onClick(); conflict.calls[2].respond({ ok: false, code: 'MODEL_FAMILY_DATA_SOURCE_CHANGED' }, 409);
await conflict.settle(); conflict.advance(1100); await conflict.settle();
assert.equal(JSON.parse(conflict.calls[3].options.body).cursor, undefined, 'source revision changes start a clean server-owned snapshot');
conflict.calls[3].respond({ ok: true, report: complete }); await conflictRun; await conflict.settle(); assert.match(conflict.markup, /有效獨立賽事 2 場/);
const throttle = harness(); await initial(throttle);
const throttleRun = throttle.button('核對全場模型誤差').props.onClick(); throttle.calls[2].respond({ ok: false }, 429, { 'Retry-After': '7' });
await throttle.settle(); assert.match(throttle.markup, /等待請求額度/); throttle.advance(7000); await throttle.settle();
throttle.calls[3].respond({ ok: true, report: complete }); await throttleRun; await throttle.settle(); assert.match(throttle.markup, /來源讀取完成/);
const race = harness(); await initial(race);
const raceRun = race.button('核對全場模型誤差').props.onClick(); race.render({ league: 'ucl' });
assert.equal(race.calls[2].options.signal.aborted, true); race.calls[2].respond({ ok: true, report: complete });
await raceRun; await race.settle(); assert.doesNotMatch(race.markup, /有效獨立賽事 2 場/);
for (const call of race.calls.slice(3)) { const params = new URL(`http://test${call.url}`).searchParams; assert.equal(params.get('league'), 'ucl'); call.respond({ ok: true, report: notStarted('ucl', params.get('period')) }); }
await race.settle(); assert.match(race.markup, /NOT VERIFIED/);
for (const instance of [h, zero, reload, different, error, conflict, throttle, race]) instance.unmount();
console.log('PASS model-family UI: exact league/period, whole durable progress, partial/no-result semantics, paced continuation, source restart, Retry-After, immutable freeze timing, refresh, outage handling and league-switch cancellation');
