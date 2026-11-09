import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';

const path = 'app/soccer/minutes-forward-panel.js';
const source = fs.readFileSync(path, 'utf8');
const { code } = await transform(source.replace(/^import .*?;\n/gm, '').replace(/export function/g, 'function'), {
  filename: 'minutes-forward-panel.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
});
const pure = vm.createContext({ React }); vm.runInContext(code, pure);
const valid = pure.minutesForwardReportValid, merge = pure.mergeMinutesForwardPage;
const fixture = ({ league = 'epl', game = '1', captures = 1, evaluated = 1, after = '0', next = null, revision = 'f'.repeat(64), rmse = 2 } = {}) => {
  const key = `soccer:${league}:${game}`, m = { games: evaluated, playerTargets: evaluated * 20, minuteMAE: evaluated ? Math.min(1, rmse) : null,
    minuteRMSE: evaluated ? rmse : null, logLoss: evaluated ? .2 : null, logLossState: evaluated ? 'FINITE' : 'UNAVAILABLE', brier: evaluated ? .3 : null };
  return { version: 'SOCCER-MINUTES-FORWARD-v1', league, metricWeighting: 'EQUAL_REAL_GAME_THEN_EQUAL_PRIOR_CANDIDATE_PLAYER',
    protocol: { status: 'DATABASE_FROZEN', protocolId: 'a'.repeat(64), protocolHash: 'b'.repeat(64), registeredAt: '2026-11-09T08:00:00.000Z',
      protocol: { version: 'SOCCER-MINUTES-FORWARD-v1', league, modelHash: 'c'.repeat(64), artifactHash: 'd'.repeat(64),
        modelCreatedAt: '2026-11-01T00:00:00.000Z', trainingBefore: '2025-12-01T00:00:00.000Z',
        clockBasis: 'PROVIDER_REGULATION_MINUTES_EXCLUDES_ADDED_TIME', zeroProbabilityPolicy: 'POSITIVE_INFINITY_WITHOUT_PROBABILITY_CLIPPING',
        baselineMethod: 'PRIOR_THREE_MATCH_MEAN_MINUTES_AND_ROLE_FREQUENCIES_WITH_ONE_TRAINING_GLOBAL_PSEUDO_OBSERVATION',
        metricWeighting: 'EQUAL_REAL_GAME_THEN_EQUAL_PRIOR_CANDIDATE_PLAYER', sourceScope: 'ESPN_TWO_ENDPOINT_CROSSCHECK_NOT_INDEPENDENT_OFFICIAL_CONFIRMATION' } },
    counts: { captures, evaluated, pending: captures - evaluated, quarantined: 0, upcoming: 0 },
    metrics: { model: m, baseline: { ...m, minuteMAE: evaluated ? Math.min(1.5, rmse + 1) : null, minuteRMSE: evaluated ? rmse + 1 : null } },
    coverage: { evaluatedGames: evaluated, modeledPlayerTargets: m.playerTargets, unmodeledCurrentRosterPlayers: evaluated ? 2 : 0,
      unseenAppearingPlayers: evaluated ? 1 : 0, unseenRegulationMinutes: evaluated ? 12 : null },
    readCaptureGameKeys: captures ? [key] : [], evaluatedGameKeys: evaluated ? [key] : [], quarantinedGameKeys: [],
    reasons: [], completeWithinRequestedScope: next === null,
    page: { afterSequence: after, nextSequence: next, revision, complete: true, reachedEnd: next === null },
    sourceScope: 'ESPN_TWO_ENDPOINT_CROSSCHECK_NOT_INDEPENDENT_OFFICIAL_CONFIRMATION', accepted: false, formalEligible: false, executable: false, W: null, R: null, S: null };
};
const clone = value => JSON.parse(JSON.stringify(value));
assert.equal(valid(fixture(), 'epl'), true);
for (const mutate of [r => { r.league = 'ucl'; }, r => { r.accepted = true; }, r => { r.formalEligible = true; }, r => { r.W = 0; },
  r => { r.metrics.baseline.games = 2; }, r => { r.metrics.baseline.playerTargets++; }, r => { r.metrics.model.logLoss = null; },
  r => { r.metrics.model.minuteMAE = 3; }, r => { r.metrics.model.minuteRMSE = 91; }, r => { r.metrics.model.brier = 3; },
  r => { r.coverage.modeledPlayerTargets++; }, r => { r.counts.pending++; }, r => { r.protocol.registeredAt = null; },
  r => { r.protocol.protocol.modelHash = 'unverified'; }, r => { r.evaluatedGameKeys = ['soccer:ucl:1']; },
  r => { r.protocol.protocol.league = 'ucl'; }, r => { r.sourceScope = 'INDEPENDENT_OFFICIAL'; }, r => { r.protocol.protocol.sourceScope = 'INDEPENDENT_OFFICIAL'; },
  r => { r.protocol.protocol.clockBasis = 'PROVIDER_REGULATION_SECONDS_EXCLUDES_ADDED_TIME'; }, r => { r.protocol.protocol.zeroProbabilityPolicy = 'CLIPPED'; },
  r => { r.readCaptureGameKeys.push(r.readCaptureGameKeys[0]); }, r => { r.reasons = [null]; }, r => { r.reasons = [{ code: '<script>', count: 1 }]; }]) {
  const r = fixture(); mutate(r); assert.equal(valid(r, 'epl'), false, 'invalid/provisional response cannot display verified numeric results');
}
const zero = fixture({ captures: 0, evaluated: 0 }); assert.equal(valid(zero, 'epl'), true);
assert.equal(valid({ ...zero, protocol: null }, 'epl'), true);
const badZero = clone(zero); badZero.metrics.model.minuteMAE = 0; assert.equal(valid(badZero, 'epl'), false, 'no samples cannot supply numeric zero errors');
const infinity = fixture(); infinity.metrics.model.logLoss = null; infinity.metrics.model.logLossState = 'POSITIVE_INFINITY';
assert.equal(valid(infinity, 'epl'), true);

const first = fixture({ captures: 2, next: '1', rmse: 0 });
const second = fixture({ game: '2', captures: 2, after: '1', rmse: 10 });
const combined = merge(merge(null, first, '0'), second, '1');
assert.equal(combined.counts.evaluated, 2); assert.equal(combined.counts.pending, 0);
assert.equal(combined.metrics.model.minuteRMSE, Math.sqrt(50));
assert.notEqual(combined.metrics.model.minuteRMSE, 5, 'RMSE cannot be averaged between pages');
assert.equal(combined.metrics.model.playerTargets, 40); assert.equal(combined.readCaptureGameKeys.length, 2);
const infiniteSecond = clone(second); infiniteSecond.metrics.model.logLoss = null; infiniteSecond.metrics.model.logLossState = 'POSITIVE_INFINITY';
const infiniteCombined = merge(merge(null, first, '0'), infiniteSecond, '1');
assert.equal(infiniteCombined.metrics.model.logLoss, null); assert.equal(infiniteCombined.metrics.model.logLossState, 'POSITIVE_INFINITY');
const unknownSecond = clone(second); unknownSecond.coverage.unseenRegulationMinutes = null;
assert.equal(merge(merge(null, first, '0'), unknownSecond, '1').coverage.unseenRegulationMinutes, null);
for (const mutate of [r => { r.readCaptureGameKeys = ['soccer:epl:1']; r.evaluatedGameKeys = ['soccer:epl:1']; },
  r => { r.page.revision = 'e'.repeat(64); }, r => { r.page.afterSequence = '2'; }, r => { r.protocol.protocolHash = 'e'.repeat(64); },
  r => { r.counts.captures = 3; r.counts.pending = 2; }, r => { r.page.nextSequence = '1'; r.page.reachedEnd = false; }]) {
  const r = clone(second); mutate(r); assert.throws(() => merge(merge(null, first, '0'), r, '1'), /PAGE_INVALID/);
}
const partial = fixture({ captures: 2, evaluated: 0, next: '0' }); partial.readCaptureGameKeys = []; partial.page.complete = false;
assert.equal(merge(null, partial, '0').completeWithinRequestedScope, false);
assert.equal(merge(merge(null, partial, '0'), first, '0').counts.evaluated, 1);
const emptyAdvancing = clone(partial); emptyAdvancing.page.complete = true; emptyAdvancing.page.nextSequence = '1';
assert.throws(() => merge(null, emptyAdvancing, '0'), /PAGE_INVALID/, 'empty completed pages cannot advance forever');

const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
function harness() {
  let props = { league: 'epl' }, index = 0, dirty = false, tree, mounted = true, afterUnmount = 0, timerId = 0;
  const hooks = [], effects = [], calls = [], timers = new Map();
  const context = vm.createContext({ React, URLSearchParams, AbortController,
    useState: initial => { const at = index++; if (!(at in hooks)) hooks[at] = initial; return [hooks[at], value => {
      if (!mounted) { afterUnmount++; return; } hooks[at] = typeof value === 'function' ? value(hooks[at]) : value; dirty = true;
    }]; },
    useRef: initial => { const at = index++; return hooks[at] ??= { current: initial }; },
    useEffect: (fn, deps) => { const at = index++, old = hooks[at]; if (old && deps.every((v, i) => Object.is(v, old.deps[i]))) return;
      hooks[at] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[at].cleanup = fn(); }); },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: (url, options) => new Promise((resolve, reject) => calls.push({ url, options, reject,
      respond: (body, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }) })),
  }); vm.runInContext(code, context);
  const render = (next = props) => { props = next; let turns = 0; do { dirty = false; index = 0; tree = context.SoccerMinutesForwardPanel(props);
    effects.splice(0).forEach(fn => fn()); assert.ok(turns++ < 20); } while (dirty); return renderToStaticMarkup(tree); };
  const settle = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); if (dirty && mounted) render(); } };
  const button = label => nodes(tree).find(node => node.type === 'button' && text(node.props.children) === label);
  return { calls, timers, render, settle, button, get markup() { return renderToStaticMarkup(tree); },
    click(label) { const b = button(label); assert.ok(b); assert.equal(b.props.disabled, false); b.props.onClick(); render(); },
    expire() { const [id, timer] = [...timers.entries()][0]; timers.delete(id); timer.fn(); render(); return timer.delay; },
    unmount() { mounted = false; hooks.forEach(h => h?.cleanup?.()); }, get afterUnmount() { return afterUnmount; } };
}
const h = harness(); assert.match(h.render(), /筆數尚未確認/); assert.equal(h.calls[0].options.cache, 'no-store');
assert.match(h.calls[0].url, /league=epl&afterSequence=0/); assert.doesNotMatch(h.markup, /已封存不同賽事 0/);
h.calls[0].respond({ ok: true, report: fixture() }); await h.settle();
assert.match(h.markup, /已封存不同賽事 1 場/); assert.match(h.markup, /球員人次不能當成獨立比賽數/);
assert.match(h.markup, /ESPN 兩個端點交叉核對，並非獨立官方來源確認/);
assert.match(h.markup, /人員預測的前瞻研究核對/); assert.match(h.markup, /不套用下方比分驗證的日期範圍/);
assert.match(h.markup, /同聯盟最近 14 日、距開賽至少 24 小時/); assert.match(h.markup, /不保證所有賽程都有可用預測/);
h.click('核對已封存分鐘'); const post = h.calls[1];
assert.equal(post.options.method, 'POST'); assert.deepEqual(JSON.parse(post.options.body), { league: 'epl', action: 'evaluate' });
const oldClick = h.button('更新分鐘驗證').props.onClick; oldClick(); oldClick(); assert.equal(h.calls.length, 2, 'synchronous request fence prevents double submit');
post.respond({ ok: true }); await h.settle(); assert.equal(h.calls.length, 3, 'POST completion reads the saved report separately');
h.calls[2].respond({ ok: true, report: zero }); await h.settle(); assert.match(h.markup, /0 樣本不代表誤差為 0/);
assert.match(h.markup, /不能據此判定全部賽程已蒐集或沒有比賽/);
assert.doesNotMatch(h.markup, /<td>0\.0000<\/td>/);
h.click('更新分鐘驗證'); h.calls[3].respond({ ok: true, report: infinity }); await h.settle();
assert.match(h.markup, /\+∞（實際角色曾被預估為零機率）/);

const paged = harness(); paged.render(); paged.calls[0].respond({ ok: true, report: first }); await paged.settle();
assert.match(paged.markup, /本次範圍尚未完整/); assert.match(paged.calls[1].url, /afterSequence=1&revision=f{64}/);
paged.calls[1].respond({ ok: true, report: second }); await paged.settle();
assert.match(paged.markup, /已核對 2 場/); assert.match(paged.markup, /7\.0711/); assert.doesNotMatch(paged.markup, /本次範圍尚未完整/);
const partialUi = harness(); partialUi.render(); partialUi.calls[0].respond({ ok: true, report: partial }); await partialUi.settle();
assert.equal(partialUi.calls.length, 1); assert.match(partialUi.markup, /本次範圍尚未完整/); assert.equal(partialUi.button('更新分鐘驗證').props.disabled, false);

for (const status of [401, 403, 429, 503]) {
  const bad = harness(); bad.render(); bad.calls[0].respond({ ok: false, error: 'private-database-secret' }, status); await bad.settle();
  assert.match(bad.markup, /未知/); assert.doesNotMatch(bad.markup, /private-database-secret|已封存不同賽事 0/);
}
for (const staleOutcome of ['error', 'success']) {
  const switched = harness(); switched.render(); switched.calls[0].respond({ ok: true, report: fixture() }); await switched.settle();
  switched.click('核對已封存分鐘'); const stale = switched.calls[1]; switched.render({ league: 'ucl' });
  assert.equal(stale.options.signal.aborted, true); assert.doesNotMatch(switched.markup, /已封存不同賽事 1/);
  switched.calls[2].respond({ ok: true, report: fixture({ league: 'ucl' }) }); await switched.settle(); const before = switched.markup;
  stale.respond(staleOutcome === 'success' ? { ok: true } : { ok: false, error: 'private-old-error' }, staleOutcome === 'success' ? 200 : 503);
  await switched.settle(); assert.equal(switched.markup, before); assert.equal(switched.calls.length, 3, 'old POST cannot refresh the new league');
}
const timeout = harness(); timeout.render(); const stale = timeout.calls[0]; assert.equal(timeout.expire(), 25000);
assert.equal(stale.options.signal.aborted, true); assert.match(timeout.markup, /逾時/);
timeout.click('更新分鐘驗證'); timeout.calls[1].respond({ ok: true, report: fixture() }); await timeout.settle(); const current = timeout.markup;
stale.respond({ ok: true, report: zero }); await timeout.settle(); assert.equal(timeout.markup, current);
timeout.click('核對已封存分鐘'); const unmounted = timeout.calls[2]; timeout.unmount();
assert.equal(unmounted.options.signal.aborted, true); unmounted.respond({ ok: true }); await timeout.settle(); assert.equal(timeout.afterUnmount, 0); assert.equal(timeout.timers.size, 0);
const restarted = harness(); restarted.render(); restarted.calls[0].respond({ ok: true, report: first }); await restarted.settle();
restarted.calls[1].respond({ ok: false, code: 'MINUTES_FORWARD_HISTORY_CHANGED_DURING_READ' }, 409); await restarted.settle();
assert.match(restarted.calls[2].url, /afterSequence=0/); assert.doesNotMatch(restarted.calls[2].url, /revision=/);
restarted.calls[2].respond({ ok: true, report: { ...first, page: { ...first.page, revision: 'e'.repeat(64) } } }); await restarted.settle();
restarted.calls[3].respond({ ok: false, code: 'MINUTES_FORWARD_HISTORY_CHANGED_DURING_READ' }, 409); await restarted.settle();
assert.equal(restarted.calls.length, 4); assert.match(restarted.markup, /未知/);
const unsupported = harness(); unsupported.render({ league: 'nba' }); assert.equal(unsupported.calls.length, 0); assert.equal(unsupported.markup, '');
const parent = fs.readFileSync('app/soccer/forward-validation-panel.js', 'utf8');
assert.match(parent, /<SoccerMinutesForwardPanel key=\{`minutes-\$\{league\}`\} league=\{league\}/);
assert.doesNotMatch(source, /dangerouslySetInnerHTML|\/api\/(?:bets|soccer\/analysis)|action:\s*['"](?:register|capture)['"]/);
// Exercise the actual report producer and database-clock protocol receipt,
// rather than only hand-written client fixtures. No external network or live
// database is used by this isolated PostgreSQL/WASM transport.
const { soccerSqlFixture } = await import('./helpers/soccer-sql-fixture.mjs');
const sql = await soccerSqlFixture(), previousEnv = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_V2_URL: process.env.DATABASE_V2_URL };
process.env.DATABASE_URL = 'postgres://fixture.invalid/minutes-forward-ui'; delete process.env.DATABASE_V2_URL;
try {
  const { readSoccerMinutesForwardReport } = await import('../lib/soccer/minutes-forward-validation.js');
  const { freezeSoccerMinutesForwardProtocol } = await import('../lib/soccer/minutes-forward-store.js');
  for (const league of ['epl', 'ucl']) {
    const emptyReport = await readSoccerMinutesForwardReport(league);
    assert.equal(valid(emptyReport, league), true, 'actual empty store response satisfies shipped client contract');
    assert.equal(merge(null, emptyReport, '0').completeWithinRequestedScope, true);
    await freezeSoccerMinutesForwardProtocol(league);
    const frozenReport = await readSoccerMinutesForwardReport(league);
    assert.equal(valid(frozenReport, league), true, 'actual nested frozen protocol receipt satisfies shipped client contract');
    assert.equal(frozenReport.counts.evaluated, 0); assert.equal(frozenReport.metrics.model.logLoss, null);
  }
} finally {
  for (const [key, value] of Object.entries(previousEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  await sql.close();
}
for (const fixturePath of process.argv.slice(2)) {
  const values = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const aggregates = new Map(), reports = Array.isArray(values) ? values : values.reports;
  for (const report of reports) {
    assert.equal(valid(report, report.league), true, 'actual captured/evaluated report satisfies client contract');
    const previous = report.page.afterSequence === '0' ? null : aggregates.get(report.league);
    const merged = merge(previous, report, report.page.afterSequence); aggregates.set(report.league, merged);
    const markup = renderToStaticMarkup(React.createElement(pure.MinutesForwardReport, { report: merged }));
    assert.doesNotMatch(markup, /NaN|undefined/); assert.match(markup, /每場先對共同球員目標平均/);
    if (!merged.counts.evaluated) assert.match(markup, /0 樣本不代表誤差為 0/);
  }
  console.log(`PASS actual minutes report → shipped client validator/whole-game merge/JSX: ${reports.length} database-produced report pages`);
}
console.log('PASS minutes forward UI: honest prospective scope/zero and Infinity states, same-game model/baseline denominators and coverage, exact source/revision/game pagination with squared-RMSE merge, partial zero, bounded restarts, auth/error secrecy, request timeout/double submit/league/unmount fencing; no formal promotion or wagering writes');
