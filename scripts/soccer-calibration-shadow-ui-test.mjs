import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';

const compiled = await transform(fs.readFileSync('app/soccer/calibration-shadow-panel.js', 'utf8')
  .replace(/^import .*?;\n/gm, '').replace(/export function/g, 'function'), {
  filename: 'calibration-shadow-panel.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
});
const readContext = vm.createContext({ React }); vm.runInContext(compiled.code, readContext);
const report = (league = 'epl') => ({ version: 'SOCCER-CALIBRATION-SHADOW-v1', league,
  status: 'SHADOW_COLLECTION_ACTIVE', freeze: { status: 'DATABASE_FROZEN', frozenAt: '2026-11-01T00:00:00Z',
    candidateHash: 'a'.repeat(64), planHash: 'b'.repeat(64), modelHash: 'c'.repeat(64), halfTimeModelHash: 'd'.repeat(64) },
  captureGames: 2, fullTimeCaptures: 2, halfTimeCaptures: 2, untouchedValidatedGames: 0,
  latestCapturedAt: '2026-11-01T00:01:00Z', accepted: false, formalEligible: false, promotionEligible: false,
  baselineChanged: false, executable: false, W: null, R: null, S: null });
const valid = readContext.calibrationShadowReportValid;
assert.equal(valid(report(), 'epl'), true);
assert.equal(valid({ ...report(), status: 'AWAITING_FIRST_ANALYSIS', freeze: null,
  captureGames: 0, fullTimeCaptures: 0, halfTimeCaptures: 0 }, 'epl'), true);
for (const patch of [{ league: 'ucl' }, { captureGames: -1 }, { untouchedValidatedGames: 3 }, { formalEligible: true },
  { R: 0 }, { freeze: null }, { fullTimeCaptures: 1 }, { accepted: true }, { baselineChanged: true }])
  assert.equal(valid({ ...report(), ...patch }, 'epl'), false, 'invalid scope, counts or promotion flags cannot appear as verified statistics');

function harness() {
  let index = 0, dirty = false, tree, mounted = true, updatesAfterUnmount = 0, props = { league: 'epl' };
  const hooks = [], effects = [], calls = [], timers = new Map(); let timerId = 0;
  const context = vm.createContext({ React, URLSearchParams, AbortController,
    useState: initial => { const at = index++; if (!(at in hooks)) hooks[at] = initial;
      return [hooks[at], value => { if (!mounted) { updatesAfterUnmount++; return; }
        hooks[at] = typeof value === 'function' ? value(hooks[at]) : value; dirty = true; }]; },
    useRef: initial => { const at = index++; if (!(at in hooks)) hooks[at] = { current: initial }; return hooks[at]; },
    useEffect: (fn, deps) => { const at = index++, previous = hooks[at]; if (previous && deps.every((value, i) => value === previous.deps[i])) return;
      hooks[at] = { deps }; effects.push(() => { previous?.cleanup?.(); hooks[at].cleanup = fn(); }); },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: (url, options) => new Promise(resolve => calls.push({ url, options,
      respond: (body, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }) })),
  }); vm.runInContext(compiled.code, context);
  const render = (next = props) => { props = next; let turns = 0; do { dirty = false; index = 0;
    tree = context.SoccerCalibrationShadowPanel(props); effects.splice(0).forEach(fn => fn()); assert.ok(turns++ < 20);
  } while (dirty); return renderToStaticMarkup(tree); };
  const settle = async () => { for (let i = 0; i < 15; i++) { await Promise.resolve(); if (dirty && mounted) render(); } return renderToStaticMarkup(tree); };
  const buttons = value => !value || typeof value !== 'object' ? [] : Array.isArray(value)
    ? value.flatMap(buttons) : [...(value.type === 'button' ? [value] : []), ...buttons(value.props?.children)];
  return { calls, render, settle,
    click(text) { const button = buttons(tree).find(value => String(value.props.children).includes(text));
      assert.ok(button, `button ${text} exists`); assert.equal(button.props.disabled, false); button.props.onClick(); render(); },
    unmount() { mounted = false; for (const hook of hooks) hook?.cleanup?.(); },
    get updatesAfterUnmount() { return updatesAfterUnmount; },
    get markup() { return renderToStaticMarkup(tree); } };

}
const h = harness(); assert.match(h.render(), /正在讀取/); assert.equal(h.calls[0].options.cache, 'no-store');
assert.doesNotMatch(h.markup, /不同賽事 0 場/, 'loading is unknown rather than an invented empty database');
h.calls[0].respond({ ok: true, report: report() }); await h.settle();
assert.match(h.markup, /不同賽事 2 場/); assert.match(h.markup, /已核對前瞻賽果 0 場/);
assert.match(h.markup, /已保存的預測筆數不等於模型驗收通過/);
h.render({ league: 'ucl' }); assert.doesNotMatch(h.markup, /不同賽事 2 場/, 'a league switch hides the old league immediately');
h.calls[1].respond({ ok: true, report: report('epl') }); await h.settle();
assert.match(h.markup, /筆數未知/); assert.doesNotMatch(h.markup, /不同賽事 2 場/);
const e = harness(); e.render(); e.calls[0].respond({ ok: false, error: '保存紀錄無法讀取，筆數未知。' }, 503); await e.settle();
assert.match(e.markup, /筆數未知/); assert.doesNotMatch(e.markup, /不同賽事 0 場/);
const partial = harness(); partial.render(); partial.calls[0].respond({ ok: true, report: { ...report(), untouchedValidatedGames: 1,
  validationCoverage: { completeWithinRequestedScope: false, readCaptures: 1, totalCaptures: 2 } } }); await partial.settle();
assert.match(partial.markup, /核對尚未讀完/); assert.match(partial.markup, /已讀範圍核對賽果 1 場/);
assert.equal(valid({ ...report(), untouchedValidatedGames: 2,
  validationCoverage: { completeWithinRequestedScope: false, readCaptures: 1, totalCaptures: 2 } }, 'epl'), false);

// A late POST must never replace the next league's already loaded report or
// refresh its revision; aborted transports can still deliver a response.
for (const staleOutcome of ['error', 'success']) {
  const switched = harness(); switched.render(); switched.calls[0].respond({ ok: true, report: report() }); await switched.settle();
  switched.click('核對校準預測賽果');
  assert.equal(switched.calls[1].options.method, 'POST');
  assert.equal(JSON.parse(switched.calls[1].options.body).league, 'epl');
  switched.render({ league: 'ucl' });
  assert.equal(switched.calls[1].options.signal.aborted, true, 'switching leagues aborts the previous evaluation');
  switched.calls[2].respond({ ok: true, report: { ...report('ucl'), captureGames: 4, fullTimeCaptures: 4, halfTimeCaptures: 4 } });
  await switched.settle();
  if (staleOutcome === 'error') switched.calls[1].respond({ ok: false, error: 'old EPL evaluation failure' }, 503);
  else switched.calls[1].respond({ ok: true });
  await switched.settle();
  assert.match(switched.markup, /不同賽事 4 場/);
  assert.doesNotMatch(switched.markup, /old EPL|正在讀取|核對中/);
  assert.equal(switched.calls.length, 3, 'old success cannot refresh the new league');
  switched.click('核對校準預測賽果');
  assert.equal(JSON.parse(switched.calls[3].options.body).league, 'ucl', 'the new league can evaluate immediately');
  switched.unmount();
  assert.equal(switched.calls[3].options.signal.aborted, true, 'unmount aborts the active evaluation');
  switched.calls[3].respond({ ok: false, error: 'late unmounted result' }, 503); await switched.settle();
  assert.equal(switched.updatesAfterUnmount, 0, 'late completion and finally do not update an unmounted component');
}

console.log('PASS calibration shadow UI: actual scoped counts, saved-vs-validated distinction, no invented zero on loading/error, invalid promotion rejection and request-fenced league/unmount isolation for late evaluation success and errors');
const diagnostics=harness();diagnostics.render();diagnostics.calls[0].respond({ok:true,report:{...report(),validation:{checkReasonUnit:'CHECKS_AND_VALIDATION_RECORDS_NOT_UNIQUE_GAMES',checkReasons:{CALIBRATION_SAVED_PREDICTION_RECOMPUTE_FAILED:2,RESULT_NORMAL_FINAL_UNCONFIRMED:1,'private raw source text':99,CALIBRATION_RESULT_DOCUMENTS_UNAVAILABLE:-1}}}});await diagnostics.settle();
assert.match(diagnostics.markup,/保存的預測與固定模型重算結果不一致/);
assert.match(diagnostics.markup,/不等於不同賽事數/);
assert.match(diagnostics.markup,/已核對前瞻賽果 0 場/);
assert.doesNotMatch(diagnostics.markup,/private raw source text|來源尚未取得/);
console.log('PASS calibration failure diagnostics: exact replay reason counts shown separately from game counts, unsafe text and malformed counts hidden, no acceptance manufactured');
