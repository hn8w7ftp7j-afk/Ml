import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { buildSoccerProbabilityAudit } from '../lib/soccer/probability-audit.js';
import { mergeSoccerProbabilityAudits } from '../lib/soccer/probability-audit-aggregation.js';

const compiled = await transform(fs.readFileSync('app/soccer/calibration-shadow-panel.js', 'utf8')
  .replace(/^import .*?;\n/gm, '').replace(/export function/g, 'function'), {
  filename: 'calibration-shadow-panel.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
});
const calibrationCompiled = await transform(fs.readFileSync('app/soccer/calibration-panel.js', 'utf8').replace(/export function/g, 'function'), {
  filename: 'calibration-panel.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
});
const calibrationContext = vm.createContext({ React }); vm.runInContext(calibrationCompiled.code, calibrationContext);
const componentGlobals = { React, SoccerCalibrationPanel: calibrationContext.SoccerCalibrationPanel, mergeSoccerProbabilityAudits };
const readContext = vm.createContext(componentGlobals); vm.runInContext(compiled.code, readContext);
const report = (league = 'epl') => ({ version: 'SOCCER-CALIBRATION-SHADOW-v1', league,
  status: 'SHADOW_COLLECTION_ACTIVE', freeze: { status: 'DATABASE_FROZEN', frozenAt: '2026-11-01T00:00:00Z',
    candidateHash: 'a'.repeat(64), planHash: 'b'.repeat(64), modelHash: 'c'.repeat(64), halfTimeModelHash: 'd'.repeat(64) },
  captureGames: 2, fullTimeCaptures: 2, halfTimeCaptures: 2, untouchedValidatedGames: 0,
  latestCapturedAt: '2026-11-01T00:01:00Z', accepted: false, formalEligible: false, promotionEligible: false,
  baselineChanged: false, executable: false, W: null, R: null, S: null });
const valid = readContext.calibrationShadowReportValid;
const schedule = (patch = {}) => ({ observedAt: '2026-11-05T00:00:00Z', startedGames: 1, upcomingGames: 1,
  nextUpcomingKickoffAt: '2026-11-07T12:30:00Z', kickoffStatusInterpretation: 'KICKOFF_REACHED_NOT_FINISHED', ...patch });
assert.equal(valid(report(), 'epl'), true);
assert.equal(valid({ ...report(), ...schedule() }, 'epl'), true);
for (const patch of [{ startedGames: -1 }, { upcomingGames: '1' }, { startedGames: 2 }, { observedAt: null },
  { observedAt: 'invalid' }, { observedAt: '2026-10-31T00:00:00Z' }, { nextUpcomingKickoffAt: null },
  { nextUpcomingKickoffAt: '2026-11-04T00:00:00Z' }, { upcomingGames: 0, startedGames: 2 },
  { kickoffStatusInterpretation: 'FINISHED' }])
  assert.equal(valid({ ...report(), ...schedule(patch) }, 'epl'), false, 'invalid or misleading kickoff counts/times fail closed');
assert.equal(valid({ ...report(), ...schedule({ startedGames: 2, upcomingGames: 0, nextUpcomingKickoffAt: null }) }, 'epl'), true);
assert.equal(valid({ ...report(), status: 'AWAITING_FIRST_ANALYSIS', freeze: null,
  captureGames: 0, fullTimeCaptures: 0, halfTimeCaptures: 0 }, 'epl'), true);
for (const patch of [{ league: 'ucl' }, { captureGames: -1 }, { untouchedValidatedGames: 3 }, { formalEligible: true },
  { R: 0 }, { freeze: null }, { fullTimeCaptures: 1 }, { accepted: true }, { baselineChanged: true }])
  assert.equal(valid({ ...report(), ...patch }, 'epl'), false, 'invalid scope, counts or promotion flags cannot appear as verified statistics');

function harness() {
  let index = 0, dirty = false, tree, mounted = true, updatesAfterUnmount = 0, props = { league: 'epl' };
  const hooks = [], effects = [], calls = [], timers = new Map(); let timerId = 0;
  const context = vm.createContext({ ...componentGlobals, URLSearchParams, AbortController,
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
assert.doesNotMatch(h.markup, /尚未開賽 \d+ 場/, 'older responses cannot infer upcoming games from missing result checks');
const kickoff = harness(); kickoff.render(); kickoff.calls[0].respond({ ok: true, report: { ...report(), ...schedule() } }); await kickoff.settle();
assert.match(kickoff.markup, /已達開賽時間 1 場/); assert.match(kickoff.markup, /尚未開賽 1 場/);
assert.match(kickoff.markup, /最近開賽：2026\/11\/7/); assert.match(kickoff.markup, /不代表已完賽或賽果已核對/);
assert.match(kickoff.markup, /已核對前瞻賽果 0 場/);
h.click('補存未開賽預測');
assert.deepEqual(JSON.parse(h.calls[1].options.body), {league:'epl',action:'collect'});
h.calls[1].respond({ok:true,summary:{league:'epl',capturedGames:1,alreadyCapturedGames:2,deferredGames:3,failedGames:1,scheduleFailures:1,formalEligible:false,executable:false}});
await h.settle();
assert.match(h.markup,/本批新增 1 場/);assert.match(h.markup,/涵蓋範圍尚未完整/);
h.calls[2].respond({ok:true,report:report()});await h.settle();
h.render({ league: 'ucl' }); assert.doesNotMatch(h.markup, /不同賽事 2 場/, 'a league switch hides the old league immediately');
assert.doesNotMatch(h.markup,/本批新增 1 場/,'collection result cannot cross leagues');
h.calls[3].respond({ ok: true, report: report('epl') }); await h.settle();
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

const metric=n=>({games:1,scoreLogLoss:n,scoreLogLossState:'FINITE',logLoss:n,brier:n,logLossState:'FINITE'});
const page=(after='0',league='epl')=>({...report(league),untouchedValidatedGames:1,quarantinedGames:0,
  validationCoverage:{readCaptures:1,totalCaptures:2,readResultCheckRows:3,completeWithinRequestedScope:false},
  validationPage:{afterSequence:after,nextSequence:after==='0'?'7':null,complete:true,reachedEnd:after!=='0',revision:'e'.repeat(64)},
  validation:{untouchedVerifiedGames:1,quarantinedGames:0,checkReasons:{CALIBRATION_MATCH_NOT_FINISHED:1},
    before:{FT:metric(after==='0'?1:3),HT:metric(2)},after:{FT:metric(1),HT:metric(2)}}});
const pages=harness();pages.render();
assert.match(pages.calls[0].url,/page=1&afterSequence=0/);
pages.calls[0].respond({ok:true,report:page()});await pages.settle();
assert.match(pages.markup,/正在接續/);assert.match(pages.markup,/已讀 1／2/);
assert.match(pages.calls[1].url,/afterSequence=7&revision=eeee/);
pages.calls[1].respond({ok:true,report:page('7')});await pages.settle();
assert.match(pages.markup,/已核對前瞻賽果 2 場/);assert.doesNotMatch(pages.markup,/正在接續|尚未讀完/);
const merge=readContext.mergeCalibrationReportPage,one=merge(null,page(),'0'),both=merge(one,page('7'),'7');
assert.equal(both.validation.before.FT.scoreLogLoss,2);assert.equal(both.validationCoverage.readCaptures,2);
assert.equal(both.validationCoverage.readResultCheckRows,6);assert.equal(both.validation.checkReasons.CALIBRATION_MATCH_NOT_FINISHED,2);
assert.equal(both.formalEligible,false);assert.equal(both.S,null);
const unfinished=(after='0')=>({...page(after),untouchedValidatedGames:0,
  validationCoverage:{readCaptures:0,totalCaptures:2,readResultCheckRows:3,completeWithinRequestedScope:false},
  validationPage:{...page(after).validationPage,afterSequence:after,nextSequence:after,complete:false,reachedEnd:false},
  validation:{untouchedVerifiedGames:0,quarantinedGames:0,checkReasons:{},before:{FT:{games:0},HT:{games:0}},after:{FT:{games:0},HT:{games:0}}}});
const firstInterrupted=merge(null,unfinished(),'0');
assert.equal(firstInterrupted.validationCoverage.readCaptures,0);assert.equal(firstInterrupted.captureGames,2);
assert.equal(firstInterrupted.validationPage.nextSequence,'0');assert.equal(firstInterrupted.validationCoverage.completeWithinRequestedScope,false);
const laterInterrupted=merge(one,unfinished('7'),'7');
assert.equal(laterInterrupted.validationCoverage.readCaptures,1);assert.equal(laterInterrupted.untouchedValidatedGames,1);
const unfinishedUi=harness();unfinishedUi.render();unfinishedUi.calls[0].respond({ok:true,report:unfinished()});await unfinishedUi.settle();
assert.match(unfinishedUi.markup,/已讀 0／2 場/);assert.doesNotMatch(unfinishedUi.markup,/範圍不一致/);
assert.equal(unfinishedUi.calls.length,1,'unfinished first capture retains cursor 0 without launching an unbounded retry loop');
unfinishedUi.click('更新保存狀態');assert.match(unfinishedUi.calls[1].url,/afterSequence=0/);unfinishedUi.unmount();
for(const malformed of [{...unfinished(),validationPage:{...unfinished().validationPage,nextSequence:'7'}},
  {...unfinished(),validationCoverage:{...unfinished().validationCoverage,readCaptures:1}},
  {...page(),validationPage:{...page().validationPage,nextSequence:'0'}}])
  assert.throws(()=>merge(null,malformed,'0'),/範圍不一致/,'only an incomplete capture may keep the exact input cursor; completed pages still advance');
const kickoffFirst = merge(null, { ...page(), ...schedule() }, '0');
const kickoffLast = merge(kickoffFirst, { ...page('7'), ...schedule({ observedAt: '2026-11-05T00:01:00Z' }) }, '7');
assert.equal(kickoffLast.startedGames, 1); assert.equal(kickoffLast.upcomingGames, 1);
assert.equal(kickoffLast.nextUpcomingKickoffAt, schedule().nextUpcomingKickoffAt);
assert.equal(kickoffLast.observedAt, '2026-11-05T00:01:00Z', 'global kickoff inventory uses the latest page observation, not an additive sample count');
const kickoffReached = merge(kickoffFirst, { ...page('7'), ...schedule({ observedAt: '2026-11-08T00:00:00Z',
  startedGames: 2, upcomingGames: 0, nextUpcomingKickoffAt: null }) }, '7');
assert.equal(kickoffReached.startedGames, 2); assert.equal(kickoffReached.upcomingGames, 0,
  'a kickoff can pass while pages load without inventing a history revision or double-counting the global population');
for(const [prior,incoming,cursor]of [[one,page(),'0'],[null,page('7'),'7'],[one,page('7','ucl'),'7'],
  [one,{...page('7'),validationPage:{...page('7').validationPage,revision:'f'.repeat(64)}},'7']])
  assert.throws(()=>merge(prior,incoming,cursor),/範圍不一致/);
const race=harness();race.render();race.calls[0].respond({ok:true,report:page()});await race.settle();
race.calls[1].respond({ok:false,code:'CALIBRATION_HISTORY_CHANGED_DURING_READ'},409);await race.settle();
assert.match(race.calls[2].url,/afterSequence=0/);assert.doesNotMatch(race.markup,/已讀範圍核對賽果 1 場/);
race.calls[2].respond({ok:false,code:'CALIBRATION_HISTORY_CHANGED_DURING_READ',error:'紀錄仍持續更新，筆數未知。'},409);await race.settle();
assert.equal(race.calls.length,3,'revision churn has a bounded retry and never becomes an infinite request loop');
assert.match(race.markup,/筆數未知/);
const moving=harness();moving.render();moving.calls[0].respond({ok:true,report:page()});await moving.settle();
moving.render({league:'ucl'});assert.equal(moving.calls[1].options.signal.aborted,true);
moving.calls[1].respond({ok:true,report:page('7')});await moving.settle();
assert.equal(moving.calls.length,3);assert.doesNotMatch(moving.markup,/已核對前瞻賽果 2 場/);
moving.unmount();
console.log('PASS automatic calibration continuation: cumulative counts and weighted metrics, exact cursor/revision chain, incomplete-to-complete transition, bounded snapshot restart, duplicate/gap/cross-league rejection and cancellation');

const auditModels = { before: { FT: 'c'.repeat(64), HT: '1'.repeat(64) }, after: { FT: '2'.repeat(64), HT: '3'.repeat(64) } };
const probabilityAuditScope = () => ({ version: 'SOCCER-PROSPECTIVE-CALIBRATION-AUDIT-SCOPE-v1', league: 'epl',
  candidateHash: 'a'.repeat(64), planHash: 'b'.repeat(64), fold: 'CALIBRATION_PROSPECTIVE_FROZEN',
  modelHashes: structuredClone(auditModels) });
const forecasts = { before: { FT: { home: .6, draw: .2, away: .2 }, HT: { home: .2, draw: .6, away: .2 } },
  after: { FT: { home: .8, draw: .1, away: .1 }, HT: { home: .2, draw: .2, away: .6 } } };
function probabilityAudit(arm, period, outcomes, league = 'epl') {
  const scope = { league, period: `REGULATION_${period}`, fold: 'CALIBRATION_PROSPECTIVE_FROZEN', modelHash: auditModels[arm][period] };
  const records = outcomes.map(([eventId, actualOutcome]) => ({ ...scope, eventId, actualOutcome, status: 'EVALUATED',
    probabilities: forecasts[arm][period], retainedMass: 1, tailMass: 0 }));
  return buildSoccerProbabilityAudit(records, { ...scope, includeGameIdentities: true });
}
function auditedPage(cursor = '0') {
  const value = page(cursor), outcome = cursor === '0' ? ['101', 'home'] : ['102', 'draw'];
  value.validation.probabilityAuditScope = probabilityAuditScope();
  for (const arm of ['before', 'after']) for (const period of ['FT', 'HT'])
    value.validation[arm][period].probabilityAudit = probabilityAudit(arm, period, [outcome]);
  return value;
}
const firstAuditPage = merge(null, auditedPage(), '0'), joinedAuditPages = merge(firstAuditPage, auditedPage('7'), '7');
const compositionScopedPage = auditedPage();
for (const arm of ['before', 'after']) for (const period of ['FT', 'HT']) {
  compositionScopedPage.validation[arm][period].probabilityAudit.league = null;
  compositionScopedPage.validation[arm][period].probabilityAudit.fold = null;
}
assert.equal(valid(compositionScopedPage, 'epl'), true, 'the actual producer can leave top-level optional scope null only when every composition row proves the expected exact scope');
assert.equal(merge(null, compositionScopedPage, '0').validation.after.HT.probabilityAudit.league, 'epl');
for (const arm of ['before', 'after']) for (const period of ['FT', 'HT']) {
  const actual = joinedAuditPages.validation[arm][period].probabilityAudit;
  const expected = probabilityAudit(arm, period, [['101', 'home'], ['102', 'draw']]);
  assert.equal(actual.league, 'epl'); assert.equal(actual.period, `REGULATION_${period}`);
  assert.equal(actual.modelHash, auditModels[arm][period]); assert.equal(actual.cohort.sample, 2);
  for (const key of ['home', 'draw', 'away']) {
    assert.ok(Math.abs(actual.classes[key].ECE_L1 - expected.classes[key].ECE_L1) < 1e-12);
    assert.ok(Math.abs(actual.classes[key].REL_L2 - expected.classes[key].REL_L2) < 1e-12);
    assert.deepEqual(JSON.parse(JSON.stringify(actual.classes[key].bins)), expected.classes[key].bins);
  }
}
const combinedHome = joinedAuditPages.validation.before.FT.probabilityAudit.classes.home;
assert.ok(Math.abs(combinedHome.ECE_L1 - .1) < 1e-12, 'opposite residuals in the same bin cancel after sufficient-statistic merge; averaging page ECE would be .5');
assert.ok(Math.abs(combinedHome.REL_L2 - .01) < 1e-12); assert.ok(Math.abs(combinedHome.MCE_Linf - .1) < 1e-12);
const auditedUi = harness(); auditedUi.render(); auditedUi.calls[0].respond({ ok: true, report: auditedPage() }); await auditedUi.settle();
auditedUi.calls[1].respond({ ok: true, report: auditedPage('7') }); await auditedUi.settle();
for (const label of ['封存基準｜全場', '封存基準｜上半場', '校準候選｜全場', '校準候選｜上半場'])
  assert.match(auditedUi.markup, new RegExp(`${label}勝平負校準核對`));
assert.match(auditedUi.markup, /最大非空分箱絕對差 MCE：主勝 0\.1000/);
assert.match(auditedUi.markup, /<th scope="row">主勝<\/th><td>2<\/td><td>0\.1000<\/td><td>0\.0100<\/td>/);
assert.match(auditedUi.markup, /開賽前已封存的預測與賽後核對/);
assert.match(auditedUi.markup, /同一場的三種結果不計為三場比賽/);
assert.match(auditedUi.markup, /0 樣本不代表校準通過/);
assert.doesNotMatch(auditedUi.markup, /NaN|undefined|Infinity|資料為事後回補/);
const legacyAuditPage = page('7'); legacyAuditPage.validation.probabilityAuditScope = probabilityAuditScope();
const legacyMerged = merge(firstAuditPage, legacyAuditPage, '7');
assert.equal(legacyMerged.validation.before.FT.probabilityAudit, null, 'a missing nonempty page audit cannot be silently treated as empty');
const interruptedAuditPage = unfinished('7'); interruptedAuditPage.validation.probabilityAuditScope = probabilityAuditScope();
const partialAudit = merge(firstAuditPage, interruptedAuditPage, '7');
assert.equal(partialAudit.validation.before.FT.probabilityAudit.cohort.sample, 1, 'an incomplete zero-capture page preserves already replayed bins');
const zero = report(); zero.validation = { before: {}, after: {}, probabilityAuditScope: probabilityAuditScope() };
for (const arm of ['before', 'after']) for (const period of ['FT', 'HT']) zero.validation[arm][period] = {
  games: 0, probabilityAudit: probabilityAudit(arm, period, []) };
const emptyAuditUi = harness(); emptyAuditUi.render(); emptyAuditUi.calls[0].respond({ ok: true, report: zero }); await emptyAuditUi.settle();
assert.match(emptyAuditUi.markup, /目前可評估 0 場；尚無分箱指標樣本/);
assert.match(emptyAuditUi.markup, /<th scope="row">主勝<\/th><td>0<\/td><td>—<\/td><td>—<\/td>/);
assert.doesNotMatch(emptyAuditUi.markup, /主勝 0\.0000|可評估 0／0 筆（100/);
for (const mutate of [
  value => { value.validation.before.FT.probabilityAudit.league = 'ucl'; },
  value => { value.validation.before.FT.probabilityAudit.period = 'REGULATION_HT'; },
  value => { value.validation.before.FT.probabilityAudit.fold = 'CALIBRATION_DEVELOPMENT_REUSED'; },
  value => { value.validation.before.FT.probabilityAudit.modelHash = '9'.repeat(64); },
  value => { value.validation.before.FT.probabilityAudit.classes.home.bins[6].count++; },
  value => { value.validation.after.HT.probabilityAudit = probabilityAudit('after', 'HT', [['999', 'home']]); },
]) {
  const bad = auditedPage(); mutate(bad); assert.equal(valid(bad, 'epl'), false, 'mis-scoped or inconsistent audit data cannot be labelled prospective');
  assert.throws(() => merge(null, bad, '0'), /範圍不一致/);
}
const duplicateAuditPage = auditedPage('7');
for (const arm of ['before', 'after']) for (const period of ['FT', 'HT'])
  duplicateAuditPage.validation[arm][period].probabilityAudit = probabilityAudit(arm, period, [['101', 'draw']]);
assert.throws(() => merge(firstAuditPage, duplicateAuditPage, '7'), /範圍不一致/, 'the same real game cannot be counted again on a later page');
for (const arm of ['before', 'after']) for (const period of ['FT', 'HT']) {
  const arbitraryModel = auditedPage(), audit = arbitraryModel.validation[arm][period].probabilityAudit;
  audit.modelHash = '9'.repeat(64); audit.composition.forEach(row => { row.modelHash = audit.modelHash; });
  assert.equal(valid(arbitraryModel, 'epl'), false, `${arm}.${period}: an internally consistent arbitrary model cannot stand in for the frozen arm`);
  assert.throws(() => merge(null, arbitraryModel, '0'), /範圍不一致/);
}
for (const period of ['FT', 'HT']) {
  const swapped = auditedPage(), before = swapped.validation.before[period].probabilityAudit;
  swapped.validation.before[period].probabilityAudit = swapped.validation.after[period].probabilityAudit;
  swapped.validation.after[period].probabilityAudit = before;
  assert.equal(valid(swapped, 'epl'), false, `${period}: baseline and candidate model audits cannot exchange arm labels`);
  assert.throws(() => merge(null, swapped, '0'), /範圍不一致/);
}
for (const arm of ['before', 'after']) {
  const swappedPeriods = auditedPage(), fullTime = swappedPeriods.validation[arm].FT.probabilityAudit;
  swappedPeriods.validation[arm].FT.probabilityAudit = swappedPeriods.validation[arm].HT.probabilityAudit;
  swappedPeriods.validation[arm].HT.probabilityAudit = fullTime;
  for (const period of ['FT', 'HT']) {
    const audit = swappedPeriods.validation[arm][period].probabilityAudit;
    audit.period = `REGULATION_${period}`; audit.composition.forEach(row => { row.period = audit.period; });
  }
  assert.equal(valid(swappedPeriods, 'epl'), false, `${arm}: relabelling the period cannot move a model into the other frozen period slot`);
}
for (const mutate of [
  value => { delete value.validation.probabilityAuditScope; },
  value => { value.validation.probabilityAuditScope.version = 'UNVERIFIED'; },
  value => { value.validation.probabilityAuditScope.league = 'ucl'; },
  value => { value.validation.probabilityAuditScope.candidateHash = '9'.repeat(64); },
  value => { value.validation.probabilityAuditScope.planHash = '9'.repeat(64); },
  value => { value.validation.probabilityAuditScope.modelHashes.before.HT = value.freeze.halfTimeModelHash; },
  value => { value.validation.probabilityAuditScope.modelHashes.after.FT = null; },
]) {
  const unbound = auditedPage(); mutate(unbound);
  assert.equal(valid(unbound, 'epl'), false, 'all four hashes require an exact frozen candidate/plan-bound server descriptor');
  assert.throws(() => merge(null, unbound, '0'), /範圍不一致/);
}
const changedMappingPage = auditedPage('7'), changedMappingAudit = changedMappingPage.validation.after.HT.probabilityAudit;
changedMappingPage.validation.probabilityAuditScope.modelHashes.after.HT = changedMappingAudit.modelHash = '8'.repeat(64);
changedMappingAudit.composition.forEach(row => { row.modelHash = changedMappingAudit.modelHash; });
assert.throws(() => merge(firstAuditPage, changedMappingPage, '7'), /範圍不一致/,
  'an internally consistent replacement descriptor cannot change frozen arm mappings midway through the same revision');
assert.notEqual(auditModels.before.HT, report().freeze.halfTimeModelHash,
  'the joint baseline HT distribution hash is not confused with its component half-time model hash');
assert.equal(joinedAuditPages.accepted, false); assert.equal(joinedAuditPages.formalEligible, false); assert.equal(joinedAuditPages.S, null);
console.log('PASS prospective four-arm classwise UI: exact fixed-bin sufficient-statistic merge, ECE/REL/MCE recomputation, each arm bound to trusted frozen candidate/plan model mapping, arbitrary self-consistent hash and arm/period swaps rejected, duplicate and malformed audit rejection, legacy unknown, zero samples and existing page fences preserved');
