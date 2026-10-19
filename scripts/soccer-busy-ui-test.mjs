import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { transform } from 'next/dist/build/swc/index.js';
import * as recovery from '../lib/soccer/background-client.js';
const source = fs.readFileSync('app/soccer/analysis-panel.js', 'utf8').replace(/^import .*?;\n/gm, '').replace(/export default function|export function/g, 'function');
const { code } = await transform(source, { filename: 'soccer-busy.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } } });
const game = id => ({ id: `soccer:epl:${id}`, sourceId: String(id), league: 'epl', date: '2026-10-20', status: 'scheduled', startTime: '2099-10-20T13:00:00Z', home: { name: 'Home' }, away: { name: 'Away' } });
const games = [game(101), game(102), game(103), game(104)];
const plain = value => JSON.parse(JSON.stringify(value));
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness({ rows = games, ...initial } = {}) {
  let props = { games: rows, league: 'epl', date: '2026-10-20', children: [], ...initial }, cursor = 0, dirty = false, tree, nextTimer = 0;
  const hooks = [], effects = [], calls = [], reports = [], timers = new Map(), listeners = new Map();
  const callback = value => reports.push(plain(value));
  function SoccerWorkspace() { return null; }
  const ctx = vm.createContext({ React, URLSearchParams, Date, AbortController, ...recovery, SoccerWorkspace,
    createContext: () => ({ Provider: 'provider' }), useContext: () => tree.props.value,
    useState: initial => { const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], update => { const value = typeof update === 'function' ? update(hooks[index]) : update;
        if (!Object.is(value, hooks[index])) { hooks[index] = value; dirty = true; } }]; },
    useRef: initial => { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useEffect: (fn, deps) => { const index = cursor++, previous = hooks[index];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      hooks[index] = { deps }; effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = fn(); }); },
    setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; }, clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { timers.set(++nextTimer, { fn, delay, interval: true }); return nextTimer; }, clearInterval: id => timers.delete(id),
    window: { localStorage: { getItem: () => null }, addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); }, removeEventListener: (name, fn) => listeners.get(name)?.delete(fn) },
    fetch: (url, options) => new Promise((resolve, reject) => {
      const call = { url, options, respond: (value, status = 200) => resolve(Response.json(value, { status })) }; calls.push(call);
      options.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  vm.runInContext(code, ctx);
  function render(next = props) {
    props = next; let iterations = 0;
    do { cursor = 0; dirty = false; tree = ctx.SoccerAnalysisProvider({ onBusyChange: callback, ...props });
      for (const effect of effects.splice(0)) effect(); assert.ok(iterations++ < 20, 'busy callbacks must settle');
    } while (dirty);
    return tree;
  }
  async function settle() { for (let i = 0; i < 5; i++) { await flush(); if (dirty) render(); } }
  return { render, settle, calls, reports, timers, listeners,
    get tree() { return tree; }, get posts() { return calls.filter(call => call.options.method === 'POST'); },
    get reads() { return calls.filter(call => call.url.startsWith('/api/soccer/analysis?')); },
    get polls() { return calls.filter(call => call.url.startsWith('/api/analysis-jobs?')); },
    run: row => tree.props.value.run(row), toolbar: () => nodes(tree).find(node => node.props?.className === 'soccerAnalysisToolbar'),
    panel: row => { const saved = cursor; cursor = hooks.length; const result = ctx.SoccerAnalysisPanel({ game: row }); cursor = saved; return result; },
    workspace: () => nodes(tree).find(node => node.type === SoccerWorkspace),
    tick: async delay => { const [id, timer] = [...timers].find(([, timer]) => timer.delay === delay) || []; assert.ok(timer, `missing timer ${delay}`); timers.delete(id); timer.fn(); await settle(); },
    unmount: () => { for (const hook of hooks) hook?.cleanup?.(); },
  };
}
let passed = 0;
async function test(name, operation) { await operation(); passed++; console.log(`PASS ${name}`); }
await test('busy reports are league/date scoped and repeated parent callback references do not loop', async () => {
  const h = harness(); h.render();
  assert.deepEqual(h.reports, [{ league: 'EPL', date: '2026-10-20', busy: false }]);
  h.render(); assert.equal(h.reports.length, 1);
  h.render({ games, league: 'epl', date: '2026-10-20', onBusyChange: value => h.reports.push(plain(value)) }); assert.equal(h.reports.length, 1);
  h.unmount(); await h.settle();
});
await test('queued/manual work reports busy, blocks new work during external activity, and preserves its existing queue', async () => {
  const h = harness(); h.render(); const runs = games.slice(0, 3).map(h.run); h.render();
  assert.equal(h.posts.length, 2); assert.equal(h.reports.at(-1).busy, true);
  h.render({ games, league: 'epl', date: '2026-10-20', externalBusy: true });
  assert.equal(await h.run(games[3]), null); assert.equal(h.posts.length, 2);
  assert.equal(nodes(h.toolbar()).find(node => node.type === 'button').props.disabled, true);
  assert.equal(nodes(h.panel(games[3])).find(node => node.type === 'button').props.disabled, true);
  assert.equal(h.workspace().props.externalBusy, true);
  h.posts[0].respond({ ok: false, error: 'fixture source failure' }, 503); await h.settle(); assert.equal(h.posts.length, 3, 'already queued work must continue');
  for (const post of h.posts.slice(1)) post.respond({ ok: false, error: 'fixture source failure' }, 503);
  await Promise.all(runs); await h.settle(); assert.equal(h.reports.at(-1).busy, false);
  h.unmount(); await h.settle();
});
await test('external activity blocks the local run-all action while saved heads and background polling continue', async () => {
  const row = games[0], runId = 'wrun_busy_recovery_101', h = harness({ rows: [row], externalBusy: true, runId }); h.render();
  assert.equal(h.reads.length, 1); assert.equal(h.polls.length, 1);
  const runAllButton = nodes(h.toolbar()).find(node => node.type === 'button'); await runAllButton.props.onClick();
  assert.equal(h.posts.length, 0);
  const running = { ok: true, runId, status: 'running', progress: { league: 'EPL', date: row.date, total: 1, gamePks: [101], runningGamePks: [101], results: [] } };
  h.polls[0].respond(running); await h.settle(); assert.equal(h.reports.at(-1).busy, true);
  await h.tick(2500); assert.equal(h.polls.length, 2, 'busy must not stop read-only recovery');
  h.polls[1].respond({ ...running, status: 'failed' }); await h.settle();
  assert.equal(h.reports.at(-1).busy, false, 'terminal workflow must release queued status before retry'); assert.equal(h.posts.length, 0);
  h.unmount(); await h.settle();
});
await test('unmount clears an active busy report and aborts local requests without launching queued work', async () => {
  const h = harness(); h.render(); const runs = games.slice(0, 3).map(h.run); h.render();
  assert.equal(h.reports.at(-1).busy, true); h.unmount(); await Promise.all(runs); await h.settle();
  assert.equal(h.reports.at(-1).busy, false); assert.equal(h.posts.length, 2); assert.ok(h.posts.every(post => post.options.signal.aborted));
});
console.log(`Soccer busy integration: ${passed} shipped-provider behavior groups passed.`);
