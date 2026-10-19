import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { soccerTeamLabel } from '../lib/soccer/team-labels.js';

const shipped = fs.readFileSync('app/soccer/main-workspace.js', 'utf8');
const source = shipped.replace(/^import .*?;\n/gm, '').replace('export default function', 'function');
const compiled = await transform(source, { filename: 'main-workspace.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } } });
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (league, date) => ({ ok: true, league: { id: league.toLowerCase() }, timeZone: 'Asia/Taipei', date,
  games: [{ id: `soccer:${league.toLowerCase()}:101`, league: league.toLowerCase(), date, status: 'scheduled', home: { name: 'Arsenal' }, away: { name: 'Liverpool' } }] });
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) { const match = find(child, predicate); if (match) return match; }
  return null;
}
function harness(initialProps = {}, search = '?sport=EPL&date=2026-10-19') {
  let cursor = 0, dirty = false, tree, props = initialProps;
  const hooks = [], effects = [], requests = [], history = [], listeners = new Map(), scopes = [];
  const timerMap = new Map(); let timerId = 0;
  function SoccerAnalysisProvider({ children }) { return React.createElement('div', { 'data-analysis-provider': true }, children); }
  function SoccerReaderPanel() { return React.createElement('div', { 'data-reader': true }); }
  const window = { location: { search }, localStorage: { getItem: () => null },
    addEventListener: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener: (name, listener) => listeners.get(name)?.delete(listener),
    history: Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (_state, _title, url) => {
      history.push({ method, url }); window.location.search = new URL(url, 'https://fixture.invalid').search;
    }])) };
  const ctx = vm.createContext({ React, URL, URLSearchParams, Date, Intl, AbortController, soccerTeamLabel, APP_VERSION: 'test', window,
    SoccerReaderPanel, SoccerAnalysisProvider, SoccerAnalysisPanel: () => null,
    Link: ({ children, prefetch, ...attributes }) => React.createElement('a', attributes, children),
    useState: initial => { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], update => { const next = typeof update === 'function' ? update(hooks[index]) : update; if (!Object.is(next, hooks[index])) { hooks[index] = next; dirty = true; } }]; },
    useRef: initial => { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useEffect: (fn, deps) => { const index = cursor++, previous = hooks[index]; if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      hooks[index] = { deps }; effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = fn(); }); },
    setTimeout: (fn, delay) => { timerMap.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timerMap.delete(id),
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, respond: value => resolve({ ok: true, status: 200, json: async () => value }) })),
  });
  vm.runInContext(compiled.code, ctx);
  function render(next = props) {
    props = next; let iterations = 0;
    do { dirty = false; cursor = 0; tree = ctx.SoccerMainWorkspace({ onScopeChange: scope => scopes.push(plain(scope)), ...props });
      for (const effect of effects.splice(0)) effect(); assert.ok(iterations++ < 20, 'workspace effects must settle');
    } while (dirty);
    return tree;
  }
  async function settle() { await flush(); if (dirty) render(); await flush(); if (dirty) render(); }
  const provider = () => find(tree, element => element.type === SoccerAnalysisProvider);
  const control = className => find(tree, element => element.props?.className?.split(' ').includes(className));
  return { render, settle, requests, history, scopes, provider, control, window, listeners,
    get tree() { return tree; }, html: () => tree ? renderToStaticMarkup(tree) : '',
    unmount: () => { for (const hook of hooks) hook?.cleanup?.(); },
  };
}
let passed = 0;
async function test(name, operation) { await operation(); passed++; console.log(`PASS ${name}`); }

await test('unopened inactive football does not fetch; embedded activation shares the home header and keeps the analysis provider mounted while hidden', async () => {
  const reportBusy = () => {};
  const h = harness({ active: false, embedded: true, selectedLeague: 'EPL', onBusyChange: reportBusy, otherBusy: true });
  h.render(); assert.equal(h.tree, null); assert.equal(h.requests.length, 0);
  h.render({ active: true, embedded: true, selectedLeague: 'EPL', onBusyChange: reportBusy, otherBusy: true }); assert.equal(h.requests.length, 1);
  assert.equal(h.tree.type, 'section'); assert.equal(h.tree.props.className, 'soccerApp soccerEmbedded');
  assert.doesNotMatch(h.html(), /<main|<header|<nav|FOOTBALL|\/soccer\?league/);
  h.requests[0].respond(response('EPL', '2026-10-19')); await h.settle();
  const provider = h.provider(); assert.ok(provider); assert.equal(provider.props.onBusyChange, reportBusy); assert.equal(provider.props.externalBusy, true); assert.match(h.html(), /data-reader/);
  h.render({ active: false, embedded: true, selectedLeague: 'EPL' });
  assert.equal(h.tree.props.hidden, true); assert.equal(h.provider().key, provider.key);
  assert.doesNotMatch(h.html(), /data-reader/); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.signal.aborted, true); h.unmount();
});
await test('the embedded analyze-all button calls the parent orchestration and respects other league work', () => {
  let calls = 0, requestedDate; const h = harness({ embedded: true, onAnalyzeAll: date => { calls++; requestedDate = date; } }); h.render();
  const button = h.control('allLeagueAnalyzeButton'); assert.equal(button.type, 'button'); assert.equal(button.props.disabled, false);
  button.props.onClick(); assert.equal(calls, 1); assert.equal(requestedDate, '2026-10-19'); assert.equal(h.history.length, 0);
  h.render({ embedded: true, onAnalyzeAll: () => calls++, otherBusy: true }); assert.equal(h.control('allLeagueAnalyzeButton').props.disabled, true);
  h.unmount();
});
await test('UCL embedded requests and scope callbacks are isolated; foreign EPL responses are rejected', async () => {
  const h = harness({ embedded: true, selectedLeague: 'UCL' }, '?sport=UCL&date=2026-10-22&view=upcoming&runId=wrun_ucl_fixture_101');
  h.render(); assert.match(h.requests[0].url, /league=ucl&date=2026-10-22&view=upcoming/);
  assert.deepEqual(h.scopes.at(-1), { league: 'UCL', date: '2026-10-22', view: 'upcoming', runId: 'wrun_ucl_fixture_101' });
  h.requests[0].respond(response('EPL', '2026-10-22')); await h.settle();
  assert.match(h.html(), /賽事聯盟或日期不符/); assert.equal(h.provider(), null); h.unmount();
});
await test('manual dates survive old batch updates; an explicit batch result scope restores its date and run in place', async () => {
  const run = { runId: 'wrun_soccer_fixture_101', leagues: { EPL: { boardDate: '2026-10-20' }, UCL: { boardDate: '2026-10-22' } } };
  let props = { embedded: true, selectedLeague: 'EPL', allRun: run };
  const h = harness(props, '?sport=EPL&date=2026-10-20&runId=wrun_soccer_fixture_101'); h.render();
  const input = find(h.tree, element => element.type === 'input' && element.props.type === 'date');
  input.props.onChange({ target: { value: '2026-10-25' } }); h.render();
  assert.match(h.history.at(-1).url, /^\/\?sport=EPL&date=2026-10-25$/); assert.equal(h.scopes.at(-1).runId, '');
  props = { ...props, allRun: { ...run, status: 'complete', leagues: { ...run.leagues, EPL: { boardDate: '2026-10-20', status: 'complete' } } } };
  h.render(props); assert.equal(h.scopes.at(-1).date, '2026-10-25');
  props = { ...props, requestedScope: { league: 'EPL', date: '2026-10-20', runId: run.runId } }; h.render(props);
  assert.equal(h.scopes.at(-1).date, '2026-10-20'); assert.equal(h.scopes.at(-1).runId, run.runId);
  assert.match(h.history.at(-1).url, /^\/\?sport=EPL&date=2026-10-20&runId=/);
  const before = h.requests.length; h.render({ ...props, otherBusy: true }); assert.equal(h.requests.length, before, 'same requestedScope must not refetch');
  props = { ...props, allRun: { runId: 'wrun_soccer_newbatch_202', leagues: { EPL: { boardDate: '2026-10-26' } } } }; h.render(props);
  assert.equal(h.scopes.at(-1).date, '2026-10-26'); assert.equal(h.scopes.at(-1).runId, 'wrun_soccer_newbatch_202'); h.unmount();
});
await test('view buttons keep run scope and write only the root URL; backward navigation restores the requested view and date', () => {
  const h = harness({ embedded: true }, '?sport=EPL&date=2026-10-20&runId=wrun_soccer_fixture_101'); h.render();
  const tabs = h.control('soccerViewNav'); React.Children.toArray(tabs.props.children)[1].props.onClick(); h.render();
  assert.equal(h.history.at(-1).url, '/?sport=EPL&date=2026-10-20&view=upcoming&runId=wrun_soccer_fixture_101');
  h.window.location.search = '?sport=EPL&date=2026-10-18&view=standings';
  for (const listener of h.listeners.get('popstate')) listener(); h.render();
  assert.deepEqual(h.scopes.at(-1), { league: 'EPL', date: '2026-10-18', view: 'standings', runId: '' }); h.unmount();
});
await test('fixed league instances have unique accessible date controls and a newly started first batch can update an open workspace', () => {
  const epl = harness({ embedded: true, selectedLeague: 'EPL' });
  const ucl = harness({ embedded: true, selectedLeague: 'UCL' }, '?sport=UCL&date=2026-10-22');
  epl.render(); ucl.render();
  const inputId = h => find(h.tree, element => element.type === 'input' && element.props.type === 'date').props.id;
  assert.equal(inputId(epl), 'soccer-date-epl'); assert.equal(inputId(ucl), 'soccer-date-ucl');
  for (const h of [epl, ucl]) assert.ok(find(h.tree, element => element.type === 'label' && element.props.htmlFor === inputId(h)));
  epl.render({ embedded: true, selectedLeague: 'EPL', allRun: { runId: 'wrun_new_first_batch_101', leagues: { EPL: { boardDate: '2026-10-20' } } } });
  assert.equal(epl.scopes.at(-1).date, '2026-10-20'); assert.equal(epl.scopes.at(-1).runId, 'wrun_new_first_batch_101');
  epl.unmount(); ucl.unmount();
});
await test('legacy football route redirects to the root with valid query scope and strips unrelated controls', async () => {
  const route = fs.readFileSync('app/soccer/page.js', 'utf8').replace(/^import .*?;\n/gm, '').replace('export default async function', 'async function');
  let url; const ctx = vm.createContext({ URLSearchParams, redirect: value => { url = value; } }); vm.runInContext(route, ctx);
  await ctx.SoccerPage({ searchParams: Promise.resolve({ league: 'ucl', date: '2026-10-22', view: 'upcoming', runId: 'wrun_ucl_fixture_101', analyzeAll: '1' }) });
  assert.equal(url, '/?sport=UCL&date=2026-10-22&view=upcoming&runId=wrun_ucl_fixture_101');
  await ctx.SoccerPage({ searchParams: Promise.resolve({ league: 'NBA', date: 'bad', runId: 'bad<script>' }) }); assert.equal(url, '/?sport=EPL');
});
console.log(`Soccer embedded main workspace: ${passed} shipped component and route behavior groups passed.`);
