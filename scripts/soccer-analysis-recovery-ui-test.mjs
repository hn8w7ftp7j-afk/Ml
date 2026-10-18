import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import * as recovery from '../lib/soccer/background-client.js';

// Run the shipped provider and its real recovery helpers. Effects and fetches
// are controlled so races are reproducible without depending on a real clock.
const raw = fs.readFileSync('app/soccer/analysis-panel.js', 'utf8')
  .replace(/^import .*?;\n/gm, '').replace(/export default function/g, 'function').replace(/export function/g, 'function');
const { code } = await transform(raw, { filename: 'soccer-recovery-ui.jsx', jsc: {
  parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } },
} });
const now = Date.now();
const game = (id = '101', date = '2026-10-20', league = 'epl') => ({
  id: `soccer:${league}:${id}`, sourceId: id, league, date, status: 'scheduled',
  startTime: '2099-10-20T13:00:00Z', home: { name: 'Home' }, away: { name: 'Away' },
});
const analysis = (row = game(), extra = {}) => {
 const value=({
  ok: true, gameId: row.id, league: row.league, date: row.date,
  formalScoringEnabled: false, executable: false,
  directions: Array.from({ length: 8 }, () => ({ executable: false, eligible: false })),
  persisted: true, publishedCurrent: true, analysisStatus: 'COMPLETED', selectionResult: 'RESEARCH_SHADOW', qaFlag: 'WARN',
  analysisRunId: `soccer-saved-${row.sourceId}`, observedAt: new Date(now).toISOString(),
  qualificationValidUntil: new Date(now + 120000).toISOString(), revision: `saved-${row.sourceId}`,
  evidence: { game: { id: row.id, sourceId: row.sourceId, league: row.league, date: row.date } }, ...extra,
});
 value.currentResearch={analysisRunId:value.analysisRunId,revision:value.revision,publishedCurrent:true,reason:'ACTIVE',checkedAt:new Date(now).toISOString(),validUntil:value.qualificationValidUntil||value.validUntil,formalScoringEnabled:false,executable:false};
 return value;
};
const head = (row = game(), value = analysis(row)) => ({
  ok: true, gameId: row.id, league: row.league, date: row.date, versions: value ? [value] : [], runs: [],
  currentResearch:value?{...value.currentResearch,validUntil:value.qualificationValidUntil||value.validUntil}:null,
  currentVersion: value, currentRun: value ? { analysisRunId: value.analysisRunId, analysisStatus: 'COMPLETED' } : null,
});
const clone = value => structuredClone(value);
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness({ games = [game()], runId = '', date = games[0]?.date || '', saved = null } = {}) {
  const state = [], refs = [], effects = [], calls = [], timers = new Map(), listeners = new Map();
  let si = 0, ri = 0, ei = 0, nextTimer = 0, mounted = false, clientNow = now;
  class ClientDate extends Date { static now() { return clientNow; } }
  const ctx = vm.createContext({
    React, Date: ClientDate, URLSearchParams, AbortController, AbortSignal, ...recovery, SoccerWorkspace:({children})=>children,
    createContext: () => ({ Provider: 'provider' }),
    useContext: () => ({ states: state[0], run: render().props.value.run }),
    useState: initial => { const i = si++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
    useRef: initial => refs[ri++] || (refs[ri - 1] = { current: initial }),
    useEffect: (effect, deps) => { const i = ei++; if (!effects[i]) effects[i] = { effect, deps, cleanup: null }; },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay,interval:true});return id;},clearInterval:id=>timers.delete(id),
    window: {
      localStorage: { getItem: key => key === recovery.SOCCER_ALL_LEAGUE_STORAGE ? JSON.stringify(saved) : null },
      addEventListener: (event, listener) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener); },
      removeEventListener: (event, listener) => listeners.get(event)?.delete(listener),
    },
    fetch: (url, options = {}) => {
      const task = deferred(), call = { url: String(url), options, ...task, respond: (value, status = 200) => task.resolve(Response.json(value, { status })) };
      calls.push(call);
      const abort = () => task.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
      return task.promise;
    },
  });
  vm.runInContext(code, ctx);
  function render() { si = 0; ri = 0; ei = 0; return ctx.SoccerAnalysisProvider({ games, runId, date, children: [] }); }
  function mount() { assert.equal(mounted, false); mounted = true; const tree = render(); for (const effect of effects) effect.cleanup = effect.effect(); return tree; }
  function unmount() { if (!mounted) return; mounted = false; for (const effect of effects) effect.cleanup?.(); }
  return {
    ctx, state, calls, timers, listeners, mount, render, unmount,
    get reads() { return calls.filter(call => call.url.startsWith('/api/soccer/analysis?')); },
    get polls() { return calls.filter(call => call.url.startsWith('/api/analysis-jobs?')); },
    get posts() { return calls.filter(call => call.options.method === 'POST'); },
    counts: () => plain(ctx.soccerAnalysisCounts(games, state[0])),
    setNow: value => { clientNow = value; },
    setSaved: value => { saved = value; },
    fire: event => { for (const listener of listeners.get(event) || []) listener(); },
    tick: async delay => { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry, `Expected ${delay} ms timer`); if(!entry[1].interval)timers.delete(entry[0]); entry[1].callback(); await flush(); },
  };
}
function workflow(row, runId, payload = analysis(row), status = 'completed') {
  const league = row.league.toUpperCase(), result = { league, date: row.date, total: 1,
    gamePks: [Number(row.sourceId)], runningGamePks: status === 'completed' ? [] : [Number(row.sourceId)],
    results: status === 'completed' ? [{ ok: true, task: { soccerQuery: { league: row.league, date: row.date, eventId: row.sourceId },
      game: { id: row.id, league, gamePk: Number(row.sourceId) } }, payload }] : [],
  };
  return { ok: true, runId, status, [status === 'completed' ? 'result' : 'progress']: result };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('mount restores saved current analysis with GET only and at most two concurrent reads', async () => {
  const games = [game('101'), game('102'), game('103')], h = harness({ games });
  try {
    h.mount(); assert.equal(h.reads.length, 2); assert.equal(h.posts.length, 0);
    h.reads[0].respond(head(games[0])); await flush(); assert.equal(h.reads.length, 3);
    h.reads[1].respond(head(games[1])); h.reads[2].respond(head(games[2])); await flush();
    assert.equal(h.counts().completed, 3); assert.equal(h.counts().research, 3); assert.equal(h.counts().candidates, 0);
    assert.equal(h.posts.length, 0); assert.equal(h.polls.length, 0);
    assert.match(renderToStaticMarkup(h.render()), /載入已保存分析/);
    for (const call of h.reads) { assert.equal(call.options.cache, 'no-store'); assert.ok(call.options.signal); }
  } finally { h.unmount(); await flush(); }
});

await test('upcoming saved reads use each game actual date instead of the outer selected board date', async () => {
  const games = [game('201', '2026-10-20'), game('202', '2026-10-22')], h = harness({ games, date: '2026-10-19' });
  try {
    h.mount();
    assert.deepEqual(h.reads.map(call => new URL(call.url, 'https://fixture.invalid').searchParams.get('date')), games.map(row => row.date));
    h.reads.forEach((call, index) => call.respond(head(games[index]))); await flush();
    assert.equal(h.state[0][games[0].id].data.date, games[0].date); assert.equal(h.state[0][games[1].id].data.date, games[1].date);
    assert.equal(h.counts().completed, 2); assert.equal(h.posts.length, 0);
  } finally { h.unmount(); await flush(); }
});

await test('local all-league job resumes polling and only fresh server head can mark workflow results current', async () => {
  const row = game(), runId = 'wrun_soccer_resume_101', h = harness({ saved: { runId, leagues: { EPL: { boardDate: row.date } } } });
  try {
    h.mount(); assert.equal(h.polls.length, 1); assert.equal(h.reads.length, 1); assert.equal(h.posts.length, 0);
    assert.equal(new URL(h.polls[0].url, 'https://fixture.invalid').searchParams.get('league'), 'EPL');
    h.polls[0].respond(workflow(row, runId, analysis(row), 'running')); h.reads[0].respond(head(row, null)); await flush();
    assert.equal(h.state[0][row.id].status, 'loading'); assert.equal(h.counts().processing, 1);
    await h.tick(2500); assert.equal(h.polls.length, 2);
    h.polls[1].respond(workflow(row, runId)); await flush();
    assert.equal(h.state[0][row.id].data.publishedCurrent, false); assert.equal(h.counts().completed, 0);
    assert.equal(h.reads.length, 2, 'workflow completion triggers a separate fresh head read');
    h.reads[1].respond(head(row)); await flush();
    assert.equal(h.counts().completed, 1); assert.equal(h.state[0].__soccerJob.status, 'completed');
    assert.equal([...h.timers.values()].some(timer => timer.delay === 2500), false, 'terminal job stops polling');
    assert.equal(h.posts.length, 0);
  } finally { h.unmount(); await flush(); }
});

await test('workflow completion during an initial saved read queues an immediate fresh head reload', async () => {
  const row = game(), runId = 'wrun_soccer_read_race_101', h = harness({ runId });
  try {
    h.mount(); h.polls[0].respond(workflow(row, runId)); await flush();
    assert.equal(h.reads.length, 1, 'an overlapping completion read waits for the active saved read');
    assert.equal(h.state[0][row.id].data.publishedCurrent, false);
    h.reads[0].respond(head(row, null)); await flush();
    assert.equal(h.reads.length, 2, 'the pending completion reload must not wait for the periodic 60 second refresh');
    h.reads[1].respond(head(row)); await flush(); assert.equal(h.counts().completed, 1);
  } finally { h.unmount(); await flush(); }
});

await test('an old saved GET cannot replace a newer explicit manual analysis', async () => {
  const row = game(), h = harness();
  try {
    const provider = h.mount(); const run = provider.props.value.run(row);
    assert.equal(h.posts.length, 1); h.posts[0].respond(analysis(row, { revision: 'new-manual', analysisRunId: 'new-manual-run' }));
    await run; await flush(); assert.equal(h.state[0][row.id].data.revision, 'new-manual');
    h.reads[0].respond(head(row, analysis(row, { revision: 'old-saved' }))); await flush();
    assert.equal(h.state[0][row.id].data.revision, 'new-manual'); assert.equal(h.counts().completed, 1);
  } finally { h.unmount(); await flush(); }
});

await test('an old in-flight workflow poll cannot replace a newer explicit manual result', async () => {
  const row = game(), runId = 'wrun_soccer_manual_race_101', h = harness({ runId });
  try {
    const provider = h.mount(); h.reads[0].respond(head(row, null)); await flush();
    const run = provider.props.value.run(row); h.posts[0].respond(analysis(row, { revision: 'new-manual', analysisRunId: 'new-manual-run' }));
    await run; await flush();
    h.polls[0].respond(workflow(row, runId, analysis(row, { revision: 'old-background' }))); await flush();
    assert.equal(h.state[0][row.id].data.revision, 'new-manual'); assert.equal(h.state[0][row.id].data.publishedCurrent, true);
    assert.equal(h.reads.length, 2, 'server head is reloaded independently after old workflow completion');
    h.reads[1].respond(head(row, analysis(row, { revision: 'new-manual', analysisRunId: 'new-manual-run' }))); await flush();
    assert.equal(h.state[0][row.id].data.revision, 'new-manual'); assert.equal(h.posts.length, 1);
  } finally { h.unmount(); await flush(); }
});

await test('a newly discovered older background job cannot demote an already current manual result', async () => {
  const row = game(), runId = 'wrun_soccer_late_discovery_101', h = harness();
  const current = analysis(row, { revision: 'manual-before-discovery', analysisRunId: 'manual-before-discovery-run' });
  try {
    const provider = h.mount(); h.reads[0].respond(head(row, null)); await flush();
    const run = provider.props.value.run(row); h.posts[0].respond(current); await run; await flush();
    h.setSaved({ runId, leagues: { EPL: { boardDate: row.date } } }); h.fire('storage');
    assert.equal(h.polls.length, 1); h.reads[1].respond(head(row, current)); await flush();
    h.polls[0].respond(workflow(row, runId, analysis(row, { revision: 'older-global', analysisRunId: 'older-global-run' }))); await flush();
    assert.equal(h.state[0][row.id].data.revision, current.revision); assert.equal(h.state[0][row.id].data.publishedCurrent, true);
    assert.equal(h.counts().completed, 1); assert.equal(h.reads.length, 3);
    h.reads[2].respond(head(row, current)); await flush(); assert.equal(h.posts.length, 1);
  } finally { h.unmount(); await flush(); }
});

await test('foreign identity and unexpected formal or executable saved payloads cannot enter current results', async () => {
  const mutations = [
    value => { value.league = 'ucl'; }, value => { value.date = '2026-10-22'; },
    value => { value.currentVersion.gameId = 'soccer:epl:999'; },
    value => { value.currentVersion.evidence.game.league = 'ucl'; },
    value => { value.currentVersion.formalScoringEnabled = true; },
    value => { value.currentVersion.executable = true; },
    value => { value.currentVersion.directions[0].eligible = true; },
    value => { value.currentVersion.directions[0].executable = true; },
    value => { value.currentVersion.selectionResult = 'CANDIDATE'; },
    value => { value.currentVersion.persisted = false; },
    value => { value.currentVersion.publishedCurrent = false; },
    value => { value.currentVersion.qaFlag = 'BLOCKED'; },
    value => { value.currentVersion.qaFlag = 'UNKNOWN'; },
    value => { delete value.currentVersion.qaFlag; },
    value => { value.currentRun.analysisRunId = 'foreign-run-id'; },
    value => { delete value.currentVersion.analysisRunId; delete value.currentRun.analysisRunId; },
  ];
  for (const mutate of mutations) {
    const h = harness();
    try {
      h.mount(); const body = clone(head()); mutate(body); h.reads[0].respond(body); await flush();
      assert.equal(h.counts().completed, 0); assert.equal(h.counts().research, 0); assert.equal(h.counts().candidates, 0);
      assert.ok(h.state[0][game().id].recoveryError, 'rejected head is surfaced as a recovery failure'); assert.equal(h.posts.length, 0);
    } finally { h.unmount(); await flush(); }
  }
});

await test('qualification deadline schedules early head refresh and presentation cannot keep expired completion', async () => {
  for (const field of ['qualificationValidUntil', 'validUntil']) {
    const row = game(), expiry = Date.now() + 10000, h = harness(), value = analysis(row);
    delete value.qualificationValidUntil; value[field] = new Date(expiry).toISOString();
    try {
      h.mount(); h.reads[0].respond(head(row, value)); await flush();
      assert.equal(h.counts().completed, 1);
      const delay = [...h.timers.values()].filter(timer=>!timer.interval).map(timer => timer.delay).find(value => value >= 250 && value < 15000);
      assert.ok(delay, 'the qualification deadline should refresh sooner than the normal 60 second interval');
      h.setNow(expiry + 1); assert.equal(h.counts().completed, 0, `${field} expiry removes current completion`); assert.equal(h.counts().waiting, 1);
      await h.tick(delay); assert.equal(h.reads.length, 2);
      value[field] = new Date(now - 1000).toISOString(); h.reads[1].respond(head(row, value)); await flush();
      assert.equal(h.state[0][row.id].data.publishedCurrent, false); assert.equal(h.posts.length, 0);
    } finally { h.unmount(); await flush(); }
  }
});

await test('expired or stale saved head remains historical and cannot count as current completion', async () => {
  for (const extra of [{ qualificationValidUntil: new Date(now - 1000).toISOString() }, { observedAt: new Date(now - 181000).toISOString() }]) {
    const row = game(), h = harness();
    try {
      h.mount(); h.reads[0].respond(head(row, analysis(row, extra))); await flush();
      assert.equal(h.state[0][row.id].data.persisted, true); assert.equal(h.state[0][row.id].data.publishedCurrent, false);
      assert.equal(h.counts().completed, 0); assert.equal(h.counts().research, 0); assert.equal(h.counts().waiting, 1);
    } finally { h.unmount(); await flush(); }
  }
});

await test('an entirely empty head after qualification expiry clears previously current completion', async () => {
  const row = game(), expiry = Date.now() + 10000, h = harness();
  try {
    h.mount(); h.reads[0].respond(head(row, analysis(row, { qualificationValidUntil: new Date(expiry).toISOString() }))); await flush();
    assert.equal(h.counts().completed, 1);
    const delay = [...h.timers.values()].filter(timer=>!timer.interval).map(timer => timer.delay).find(value => value >= 250 && value < 15000);
    h.setNow(expiry + 1); await h.tick(delay); assert.equal(h.reads.length, 2);
    h.reads[1].respond(head(row, null)); await flush();
    assert.equal(h.state[0][row.id].status, 'idle'); assert.equal(h.state[0][row.id].data, undefined);
    assert.equal(h.counts().completed, 0); assert.equal(h.counts().research, 0); assert.equal(h.counts().waiting, 1);
    assert.equal(h.posts.length, 0);
  } finally { h.unmount(); await flush(); }
});

await test('foreign background workflow cannot attach results or launch a fresh analysis', async () => {
  const row = game(), runId = 'wrun_soccer_explicit_101', h = harness({ runId });
  try {
    h.mount(); h.reads[0].respond(head(row, null)); const response = workflow(row, runId); response.result.league = 'UCL';
    h.polls[0].respond(response); await flush();
    assert.equal(h.state[0][row.id].status, 'idle'); assert.equal(h.state[0][row.id].data, undefined); assert.equal(h.counts().completed, 0);
    assert.match(h.state[0].__soccerJob.error, /聯盟或日期/); assert.equal(h.posts.length, 0);
  } finally { h.unmount(); await flush(); }
});

await test('one failed and one data-shortage workflow row preserve an independent successful result', async () => {
  const games = [game('401'), game('402'), game('403')], runId = 'wrun_soccer_partial_401', h = harness({ games, runId });
  try {
    h.mount(); h.reads[0].respond(head(games[0], null)); h.reads[1].respond(head(games[1], null)); await flush();
    h.reads[2].respond(head(games[2], null)); await flush();
    const response = workflow(games[0], runId); response.result.total = 3;
    response.result.results.push(...games.slice(1).map((row, index) => {
      const entry = workflow(row, runId).result.results[0];
      return { ...entry, ok: false, error: index === 0 ? 'temporary source failure' : 'insufficient source evidence',
        payload: { analysisStatus: index === 0 ? 'FAILED' : 'INSUFFICIENT_DATA', analysisRunId: `failed-run-${row.sourceId}` } };
    }));
    h.polls[0].respond(response); await flush();
    assert.equal(h.state[0][games[0].id].data.publishedCurrent, false);
    assert.equal(h.state[0][games[1].id].analysisStatus, 'FAILED'); assert.equal(h.state[0][games[2].id].analysisStatus, 'INSUFFICIENT_DATA');
    assert.equal(h.counts().completed, 0); assert.equal(h.counts().failed, 1); assert.equal(h.counts().insufficient, 1);
    h.reads[3].respond(head(games[0]));
    h.reads[4].respond({ ...head(games[1], null), runs: [{ analysisRunId: 'failed-run-402', analysisStatus: 'FAILED', qaFlag: 'BLOCKED' }] }); await flush();
    h.reads[5].respond({ ...head(games[2], null), runs: [{ analysisRunId: 'failed-run-403', analysisStatus: 'INSUFFICIENT_DATA', qaFlag: 'BLOCKED' }] }); await flush();
    assert.equal(h.counts().completed, 1); assert.equal(h.counts().failed, 1); assert.equal(h.counts().insufficient, 1);
    assert.equal(h.counts().candidates, 0); assert.equal(h.posts.length, 0);
  } finally { h.unmount(); await flush(); }
});

await test('unchanged queued and settled poll results do not repeatedly refetch every saved game', async () => {
  const games = [game('501'), game('502'), game('503')], runId = 'wrun_soccer_coalesced_501', h = harness({ games, runId });
  try {
    h.mount(); h.reads[0].respond(head(games[0], null)); h.reads[1].respond(head(games[1], null)); await flush();
    h.reads[2].respond(head(games[2], null)); await flush();
    const queued = workflow(games[0], runId, null, 'running');
    queued.progress.total = 3; queued.progress.gamePks = games.map(row => Number(row.sourceId));
    h.polls[0].respond(queued); await flush(); assert.equal(h.reads.length, 3);
    await h.tick(2500); h.polls[1].respond(clone(queued)); await flush(); assert.equal(h.reads.length, 3, 'queued-only poll must not refetch any saved head');
    const settled = clone(queued); settled.progress.results = workflow(games[0], runId).result.results;
    settled.progress.runningGamePks = [Number(games[1].sourceId)];
    await h.tick(2500); h.polls[2].respond(settled); await flush();
    assert.equal(h.reads.length, 4, 'new settled row refetches just that game');
    assert.equal(new URL(h.reads[3].url, 'https://fixture.invalid').searchParams.get('eventId'), games[0].sourceId);
    h.reads[3].respond(head(games[0])); await flush(); assert.equal(h.counts().completed, 1);
    await h.tick(2500); h.polls[3].respond(clone(settled)); await flush();
    assert.equal(h.reads.length, 4, 'unchanged settled row must not refetch saved heads');
    assert.equal(h.state[0][games[0].id].data.publishedCurrent, true, 'repeated workflow history must not demote a fresh current head');
    assert.equal(h.posts.length, 0);
  } finally { h.unmount(); await flush(); }
});

await test('abandoned PROCESSING attempts older than two minutes release loading and permit manual retry', async () => {
  const row = game(), h = harness();
  try {
    const provider = h.mount();
    h.reads[0].respond({ ...head(row, null), runs: [{ analysisRunId: 'abandoned-run-101', analysisStatus: 'PROCESSING', startedAt: new Date(now - 121000).toISOString() }] }); await flush();
    assert.equal(h.state[0][row.id].status, 'idle'); assert.equal(h.counts().processing, 0); assert.equal(h.counts().waiting, 1);
    assert.match(h.state[0][row.id].recoveryError, /可重新核對/);
    const run = provider.props.value.run(row); assert.equal(h.posts.length, 1);
    h.posts[0].respond(analysis(row, { revision: 'retried-abandoned' })); await run; await flush();
    assert.equal(h.counts().completed, 1); assert.equal(h.state[0][row.id].recoveryError, '');
  } finally { h.unmount(); await flush(); }
});

await test('unmount aborts head and job reads, removes reconnect listeners and cancels polling timers', async () => {
  const h = harness({ runId: 'wrun_soccer_unmount_101' });
  h.mount(); assert.equal(h.calls.length, 2); const signals = h.calls.map(call => call.options.signal);
  h.unmount(); await flush();
  assert.ok(signals.every(signal => signal.aborted)); assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.get('focus').size, 0); assert.equal(h.listeners.get('storage').size, 0);
  h.fire('focus'); h.fire('storage'); assert.equal(h.calls.length, 2); assert.deepEqual(plain(h.state[0]), {});
});

await test('unmount resolves queued manual work and aborts active manual work without starting the queued game', async () => {
  const games = [game('301'), game('302'), game('303')], h = harness({ games });
  const provider = h.mount(), runs = games.map(row => provider.props.value.run(row));
  assert.equal(h.posts.length, 2); assert.equal(h.state[0][games[2].id].status, 'queued');
  h.unmount(); await Promise.all(runs); await flush();
  assert.equal(h.posts.length, 2); assert.ok(h.posts.every(call => call.options.signal.aborted)); assert.equal(h.timers.size, 0);
});

await test('an older ACTIVE saved head cannot overwrite a newer lightweight invalidation receipt', async () => {
  const row=game(),h=harness();
  try{
    h.mount();h.reads[0].respond(head(row));await flush();h.render();
    h.fire('focus');assert.equal(h.reads.length,2,'saved head request starts first');
    h.setNow(now+30000);await h.tick(1000);assert.equal(h.reads.length,3);
    assert.equal(new URL(h.reads[2].url,'https://fixture.invalid').searchParams.get('view'),'current');
    const invalid={...analysis(row).currentResearch,publishedCurrent:false,reason:'QUOTE_CHANGED',checkedAt:new Date(now+30000).toISOString()};
    h.reads[2].respond({ok:true,gameId:row.id,league:row.league,date:row.date,currentResearch:invalid});await flush();
    assert.equal(h.counts().completed,0);assert.equal(h.state[0][row.id].currentResearch.reason,'QUOTE_CHANGED');
    h.reads[1].respond(head(row));await flush();
    assert.equal(h.state[0][row.id].data.revision,analysis(row).revision,'older head evidence remains readable');
    assert.equal(h.state[0][row.id].currentResearch.reason,'QUOTE_CHANGED','stale ACTIVE head cannot revive qualification across read channels');
    assert.equal(h.counts().completed,0);assert.equal(h.posts.length,0);
  }finally{h.unmount();await flush();}
});

await test('an older ACTIVE lightweight receipt cannot overwrite a newer saved-head invalidation', async () => {
  const row=game(),h=harness();
  try{
    h.mount();h.reads[0].respond(head(row));await flush();h.render();
    h.setNow(now+30000);await h.tick(1000);assert.equal(h.reads.length,2);
    h.fire('focus');assert.equal(h.reads.length,3,'saved head starts after the held lightweight read');
    const invalid={...analysis(row).currentResearch,publishedCurrent:false,reason:'EXPIRED',checkedAt:new Date(now+30000).toISOString()};
    h.reads[2].respond({...head(row,null),versions:[analysis(row)],currentResearch:invalid});await flush();
    assert.equal(h.counts().completed,0);assert.equal(h.state[0][row.id].currentResearch.reason,'EXPIRED');
    h.reads[1].respond({ok:true,gameId:row.id,league:row.league,date:row.date,currentResearch:analysis(row).currentResearch});await flush();
    assert.equal(h.state[0][row.id].currentResearch.reason,'EXPIRED','stale lightweight ACTIVE response cannot overwrite a newer head');
    assert.equal(h.counts().completed,0);assert.equal(h.posts.length,0);
  }finally{h.unmount();await flush();}
});

console.log(`Soccer automatic recovery UI: ${passed} shipped-provider behavior groups passed.`);
