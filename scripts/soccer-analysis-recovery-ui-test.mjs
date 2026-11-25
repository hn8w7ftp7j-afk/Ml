import { soccerHighScoreCandidates } from '../lib/soccer/league-bet-status.js';
import { soccerTeamLabel } from '../lib/soccer/team-labels.js';
import { buildSoccerRanking, SOCCER_RANK_MARKETS } from '../lib/soccer/ranking.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import * as recovery from '../lib/soccer/background-client.js';
import { soccerPredictionLiveFixture } from './helpers/soccer-prediction-live-fixture.mjs';
import { publishSoccerAnalysisCandidates } from '../lib/soccer/candidate-publication.js';

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
function harness({ games = [game()], runId = '', date = games[0]?.date || '', saved = null, onState = null } = {}) {
  const state = [], refs = [], effects = [], changedEffects=[], calls = [], timers = new Map(), listeners = new Map();
  let si = 0, ri = 0, ei = 0, nextTimer = 0, mounted = false, clientNow = now, holdUpdates = false;const deferredUpdates=[];
  class ClientDate extends Date { static now() { return clientNow; } }
  const ctx = vm.createContext({buildSoccerRanking,
    React, Date: ClientDate, URLSearchParams, AbortController, AbortSignal, ...recovery, SoccerWorkspace:({children})=>children,
    createContext: () => ({ Provider: 'provider' }),
    useContext: () => ({ states: state[0], run: render().props.value.run }),
    useState: initial => { const i = si++; if (!(i in state)) state[i] = initial; return [state[i], value => { const apply=()=>{state[i] = typeof value === 'function' ? value(state[i]) : value;if(i===0)onState?.(state[0],clientNow,ctx);};if(i===0&&holdUpdates)deferredUpdates.push(apply);else apply(); }]; },
    useRef: initial => refs[ri++] || (refs[ri - 1] = { current: initial }),
    useEffect: (effect, deps) => { const i = ei++,previous=effects[i];if(!previous)effects[i]={effect,deps,cleanup:null};else if(!deps.every((value,index)=>Object.is(value,previous.deps[index]))){effects[i]={effect,deps,cleanup:null};changedEffects.push(()=>{previous.cleanup?.();effects[i].cleanup=effect();});} },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay,interval:true});return id;},clearInterval:id=>timers.delete(id),
    window: {
      localStorage: { getItem: key => key === recovery.SOCCER_ALL_LEAGUE_STORAGE ? JSON.stringify(saved) : null },
      addEventListener: (event, listener) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener); },
      removeEventListener: (event, listener) => listeners.get(event)?.delete(listener),
    },
    fetch: (url, options = {}) => {
      const task = deferred(), call = { url: String(url), options, ...task, respond: (value, status = 200, headers = {}) => task.resolve(Response.json(value, { status, headers })) };
      calls.push(call);
      const abort = () => task.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
      return task.promise;
    },
  });
  vm.runInContext(code, ctx);
  function render(next={}) { if(next.games)games=next.games;if(next.date)date=next.date;si = 0; ri = 0; ei = 0; const tree=ctx.SoccerAnalysisProvider({ games, runId, date, children: [] });if(mounted)for(const apply of changedEffects.splice(0))apply();return tree; }
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
    fire: (event,detail) => { for (const listener of listeners.get(event) || []) listener(detail===undefined?undefined:{detail}); },
    holdStateUpdates:()=>{holdUpdates=true;},flushStateUpdates:()=>{holdUpdates=false;for(const apply of deferredUpdates.splice(0))apply();},
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
    assert.equal(h.counts().restoring,3,'includes games still waiting for a head-read worker');
    assert.equal(h.counts().waiting,0); assert.equal(h.counts().processing,0);
    assert.equal(h.ctx.soccerAnalysisPresentation(undefined,now,games[2]).analysisLabel,'正在讀取已保存分析');
    h.reads[0].respond(head(games[0])); await flush(); assert.equal(h.reads.length, 3);
    h.reads[1].respond(head(games[1])); h.reads[2].respond(head(games[2])); await flush();
    assert.equal(h.counts().completed, 3); assert.equal(h.counts().research, 3); assert.equal(h.counts().candidates, 0);
    assert.equal(h.posts.length, 0); assert.equal(h.polls.length, 0);
    assert.match(renderToStaticMarkup(h.render()), /載入已保存分析/);
    for (const call of h.reads) { assert.equal(call.options.cache, 'no-store'); assert.ok(call.options.signal); }
  } finally { h.unmount(); await flush(); }
});

await test('a throttled head stops fanout and automatically retries only missing games at Retry-After', async () => {
  const rows=[game('11'),game('12'),game('13'),game('14'),game('15')],h=harness({games:rows});
  const ids=()=>h.reads.map(call=>new URL(call.url,'https://fixture.invalid').searchParams.get('eventId'));
  try{
    h.mount();
    const nearExpiry=analysis(rows[0],{qualificationValidUntil:new Date(now+2000).toISOString()});
    h.reads[0].respond(head(rows[0],nearExpiry));await flush();
    assert.deepEqual(ids(),['11','12','13']);
    h.reads[1].respond({},429,{'Retry-After':'4'});await flush();
    h.reads[2].respond(head(rows[2]));await flush();h.render();
    assert.deepEqual(ids(),['11','12','13'],'the remainder of the wave waits');
    assert.equal(h.counts().completed,2);
    h.setNow(now+2999);
    assert.equal(h.ctx.soccerResearchIsCurrent(h.state[0][rows[0].id]),false,'the verified score expires during cooldown');
    h.fire('focus');h.fire('soccer:reader-content-changed',{league:'epl',date:rows[0].date,contentHash:'f'.repeat(64)});
    await h.tick(1000);
    assert.equal(h.reads.length,3,'focus, timer and lightweight status share the server deadline');
    h.setNow(now+4000);await h.tick(1001);
    assert.deepEqual(ids().slice(3),['12','14']);
    h.reads[3].respond(head(rows[1]));await flush();
    h.reads[4].respond(head(rows[3]));h.reads[5].respond(head(rows[4]));await flush();
    assert.deepEqual(ids(),['11','12','13','12','14','15']);
    assert.ok(rows.every(row=>h.state[0][row.id]?.data?.persisted===true));assert.equal(h.counts().recoveryFailed,0);assert.equal(h.posts.length,0);
  }finally{h.unmount();await flush();}
});

await test('a throttled current receipt blocks other status and head requests until its HTTP-date', async () => {
  const rows=[game('21'),game('22'),game('23')],h=harness({games:rows});
  try{
    h.mount();h.reads[0].respond(head(rows[0]));await flush();
    h.reads[1].respond(head(rows[1]));h.reads[2].respond(head(rows[2]));await flush();h.render();
    const start=Math.ceil((now+30000)/1000)*1000;
    h.setNow(start);await h.tick(1000);assert.equal(h.reads.length,5);
    const read=rows[1],status=analysis(read).currentResearch;
    h.reads[3].respond({},429,{'Retry-After':new Date(start+5000).toUTCString()});await flush();
    h.reads[4].respond({ok:true,league:read.league,date:read.date,gameId:read.id,currentResearch:status});await flush();h.render();
    assert.equal(h.state[0][rows[0].id].currentResearch,null,'failed verification cannot assert current authority');
    h.fire('focus');h.setNow(start+4000);await h.tick(1000);
    assert.equal(h.reads.length,5,'no head or current request dispatched while blocked');
    h.setNow(start+5000);await h.tick(5000);
    assert.equal(h.reads.length,7,'full-head refresh can resume when the server deadline passes');
    assert.equal(h.posts.length,0);
  }finally{h.unmount();await flush();}
});

await test('a hidden board skips scheduled full reads, resumes once and ignores unrelated storage writes', async () => {
  const row=game(),h=harness(),events=new Map();
  h.ctx.document={visibilityState:'visible',addEventListener:(k,fn)=>{if(!events.has(k))events.set(k,new Set());events.get(k).add(fn);},removeEventListener:(k,fn)=>events.get(k)?.delete(fn)};
  try{
    h.mount();h.reads[0].respond(head(row,null));await flush();h.render();
    h.ctx.document.visibilityState='hidden';await h.tick(60000);
    assert.equal(h.reads.length,1);
    h.ctx.document.visibilityState='visible';
    for(const fn of events.get('visibilitychange'))fn();
    h.fire('focus');assert.equal(h.reads.length,2,'one recovery for the foreground transition');
    h.reads[1].respond(head(row,null));await flush();h.render();
    for(const fn of h.listeners.get('storage'))fn({key:'unrelated-account-preference'});
    assert.equal(h.reads.length,2);
    for(const fn of h.listeners.get('storage'))fn({key:recovery.SOCCER_ALL_LEAGUE_STORAGE});
    assert.equal(h.reads.length,3,'a genuine workflow change still reconnects');
    assert.equal(h.posts.length,0);
  }finally{h.unmount();await flush();}
});

await test('initial head timeout is distinct from no saved result, manual failure and unmount', async () => {
  const row=game(),h=harness({games:[row]});
  try {
    h.mount(); await h.tick(20000);
    assert.equal(h.counts().restoring,0); assert.equal(h.counts().recoveryFailed,1);
    assert.equal(h.counts().waiting,0); assert.equal(h.counts().failed,0);
    assert.match(h.state[0][row.id].recoveryError,/逾時/);
    assert.equal(h.ctx.soccerAnalysisPresentation(h.state[0][row.id],now,row).analysisStatus,'RECOVERY_FAILED');
    h.render(); h.fire('focus'); await flush();
    assert.equal(h.counts().restoring,1); assert.equal(h.counts().recoveryFailed,0);
    h.reads[1].respond({ok:true,gameId:row.id,league:row.league,date:row.date,versions:[],runs:[]}); await flush();
    assert.equal(h.counts().restoring,0); assert.equal(h.counts().waiting,1);
    assert.equal(h.ctx.soccerAnalysisPresentation(h.state[0][row.id],now,row).analysisStatus,'NOT_STARTED');
    assert.equal(h.posts.length,0);
  } finally {h.unmount(); await flush();}
  const abandoned=harness({games:[row]});
  abandoned.mount(); abandoned.unmount(); await flush();
  assert.equal(abandoned.state[0][row.id],undefined,'cleanup abort must not report a read failure');
});

await test('first load and immediate manual recovery retain read-only archive separately from the live payload', async () => {
  const row = game(), h = harness({games:[row]});
  const latest = analysis(row, {predictionContext:{mode:'PREDICTION'}});
  const archive = {status:'HISTORICAL_PREDICTION', revision:'a'.repeat(64), eligible:false, executable:false};
  try {
    const provider = h.mount();
    h.reads[0].respond({...head(row,latest), historicalPrediction:archive});
    await flush(); h.render();
    assert.deepEqual(plain(h.state[0][row.id].historicalPrediction), archive);
    h.fire('focus');
    const second = analysis(row,{predictionContext:{mode:'PREDICTION'}, revision:'saved-manual',analysisRunId:'manual-without-score'});
    const run = provider.props.value.run(row);
    h.posts[0].respond(second); await run; await flush(); h.render();
    h.reads[1].respond({...head(row,latest), historicalPrediction:{...archive,revision:'older'}});
    await flush();
    assert.equal(h.state[0][row.id].historicalPrediction.revision, archive.revision, 'late old head is fenced');
    assert.equal(h.reads.length,3,'persisted manual result with no prices immediately requests its saved head');
    h.reads[2].respond({...head(row,second),historicalPrediction:{...archive,revision:'b'.repeat(64)}});
    await flush(); h.render();
    assert.equal(h.state[0][row.id].historicalPrediction.revision, 'b'.repeat(64));
    assert.equal(Object.hasOwn(h.state[0][row.id].data, 'historicalPrediction'), false);
    assert.equal(h.state[0][row.id].data.revision, second.revision);
    h.fire('focus');
    h.reads[3].respond({...head(row,second),historicalPrediction:null,historicalPredictionReadFailed:true});
    await flush(); h.render();
    assert.equal(h.state[0][row.id].historicalPrediction.revision, 'b'.repeat(64));
    assert.equal(h.state[0][row.id].historicalPredictionReadFailed, true);
    assert.equal(h.counts().candidates,0);
  } finally { h.unmount(); await flush(); }
});

await test('manual match card carries archive without a second head, preserves it on outage and fences invalidations', async () => {
  const row=game(),h=harness({games:[row]}),base=analysis(row,{predictionContext:{mode:'PREDICTION'}});
  const archive={status:'HISTORICAL_PREDICTION',revision:'a'.repeat(64),eligible:false,executable:false};
  const headers='application/vnd.soccer.match-card+json';
  try {
    const provider=h.mount();
    assert.equal(h.reads[0].options.headers.Accept,headers);
    h.reads[0].respond(head(row,base));await flush();h.render();
    const run=provider.props.value.run(row);
    assert.equal(h.posts[0].options.headers.Accept,headers);
    h.posts[0].respond({...base,historicalPrediction:archive});const result=await run;await flush();h.render();
    assert.equal(result.historicalPrediction,undefined);
    assert.deepEqual(plain(h.state[0][row.id].historicalPrediction),archive);
    assert.equal(h.state[0][row.id].data.historicalPrediction,undefined);
    assert.equal(h.reads.length,1);assert.equal(h.counts().candidates,0);
    const next=analysis(row,{predictionContext:{mode:'PREDICTION'},revision:'manual-next',analysisRunId:'manual-next-run'});
    const retry=provider.props.value.run(row);
    h.posts[1].respond({...next,historicalPrediction:null,historicalPredictionReadFailed:true});
    await retry;await flush();h.render();
    assert.equal(h.state[0][row.id].data.revision,next.revision);
    assert.deepEqual(plain(h.state[0][row.id].historicalPrediction),archive);
    assert.equal(h.state[0][row.id].historicalPredictionReadFailed,true);
    assert.equal(h.reads.length,1,'a failed optional archive does not download current again');
    const late=provider.props.value.run(row);
    h.fire('soccer:reader-content-changed',{league:row.league,date:row.date,contentHash:'c'.repeat(64)});
    h.posts[2].respond({...next,historicalPrediction:null});await late;await flush();h.render();
    assert.deepEqual(plain(h.state[0][row.id].historicalPrediction),archive,'superseded response cannot clear the archive');
    assert.equal(h.state[0][row.id].currentResearch,null);
    h.setNow(now+30000);await h.tick(1000);
    assert.equal(h.reads.at(-1).options.headers.Accept,headers,'atomic replacement via current uses the same card format');
    assert.match(h.reads.at(-1).url,/view=current/);
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

await test('next-date Reader changes only invalidate and recheck that date on a combined board', async () => {
  const games=[game('201','2026-10-20'),game('202','2026-10-21')],h=harness({games,date:games[0].date});
  try{
    h.mount();h.reads.forEach((call,index)=>call.respond(head(games[index])));await flush();h.render();
    const previous=h.state[0][games[0].id].currentResearch;
    h.fire('soccer:reader-content-changed',{league:'epl',date:games[1].date,contentHash:'c'.repeat(64)});h.render();
    assert.equal(h.state[0][games[0].id].currentResearch,previous,'today authority is not revoked by tomorrow Reader update');
    assert.equal(h.state[0][games[1].id].currentResearch,null,'tomorrow authority is revoked immediately');
    assert.equal(h.reads.length,3);assert.equal(new URL(h.reads[2].url,'https://fixture.invalid').searchParams.get('date'),games[1].date);
    assert.equal(h.posts.length,0,'read-only source reconciliation cannot start analysis or record bets');
  }finally{h.unmount();await flush();}
});

await test('identical market refreshes preserve in-flight current reads while real lifecycle changes restart them', async () => {
  const row=game(),h=harness({games:[row]});
  try{
    h.mount();h.reads[0].respond(head(row));await flush();h.render();
    h.fire('soccer:reader-content-changed',{league:row.league,date:row.date,contentHash:'d'.repeat(64)});h.render();
    const pending=h.reads[1],listener=[...h.listeners.get('soccer:reader-content-changed')][0];assert.ok(pending);
    h.render({games:[{...row,home:{...row.home},source:{fetchedAt:new Date(now+30000).toISOString()}}]});
    assert.equal(pending.options.signal.aborted,false,'new array and refreshed metadata cannot abort the current receipt request');
    assert.equal([...h.listeners.get('soccer:reader-content-changed')][0],listener,'unchanged identity preserves the polling age and fast-handoff budgets');
    h.render({games:[{...row,status:'live'}]});assert.equal(pending.options.signal.aborted,true,'real kickoff lifecycle change still retires old current reads');
  }finally{h.unmount();await flush();}
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

await test('a new current run immediately loads its immutable head before restoring ranking authority', async () => {
  const row=game(),h=harness();
  try{
    h.mount();assert.equal(new URL(h.reads[0].url,'https://fixture.invalid').searchParams.get('view'),'head');
    h.reads[0].respond(head(row));await flush();h.render();
    h.setNow(now+30000);await h.tick(1000);
    const refreshed=analysis(row,{analysisRunId:'soccer-refreshed-101',revision:'refreshed-101',observedAt:new Date(now+20000).toISOString()});
    refreshed.currentResearch.checkedAt=new Date(now+30000).toISOString();
    h.reads[1].respond({ok:true,gameId:row.id,league:row.league,date:row.date,currentResearch:{...refreshed.currentResearch,analysisStatus:'COMPLETED'}});await flush();
    assert.equal(h.counts().completed,0,'the new receipt must not authorize the old scores');
    assert.equal(h.reads.length,3,'new revision is loaded immediately rather than waiting for the minute timer');
    assert.equal(new URL(h.reads[2].url,'https://fixture.invalid').searchParams.get('view'),'head');
    assert.equal(h.posts.length,0,'the browser never invents a new analysis or extends a receipt');
    h.reads[2].respond(head(row,refreshed));await flush();h.render();
    assert.equal(h.state[0][row.id].data.revision,refreshed.revision);assert.equal(h.counts().completed,1);
    h.setNow(now+60000);await h.tick(1000);
    h.reads[3].respond({ok:true,gameId:row.id,league:row.league,date:row.date,currentResearch:{...refreshed.currentResearch,analysisStatus:'COMPLETED'}});await flush();
    assert.equal(h.reads.length,4,'same-run status polling must not reload a full head every time');
  }finally{h.unmount();await flush();}
});

await test('a delayed replacement receipt cannot reload or overwrite a newer manual result', async () => {
  const row=game(),h=harness();
  try{
    const provider=h.mount();h.reads[0].respond(head(row));await flush();h.render();
    h.setNow(now+30000);await h.tick(1000);
    const manual=analysis(row,{analysisRunId:'soccer-manual-new-101',revision:'manual-new-101',observedAt:new Date(now+25000).toISOString()});
    manual.currentResearch.checkedAt=new Date(now+30000).toISOString();
    const task=provider.props.value.run(row);h.posts[0].respond(manual);await task;await flush();h.render();
    const obsolete=analysis(row,{analysisRunId:'soccer-obsolete-101',revision:'obsolete-101'});
    h.reads[1].respond({ok:true,gameId:row.id,league:row.league,date:row.date,currentResearch:{...obsolete.currentResearch,analysisStatus:'COMPLETED'}});await flush();
    assert.equal(h.reads.length,2,'a superseded status request must not schedule recovery work');
    assert.equal(h.state[0][row.id].data.revision,manual.revision);assert.equal(h.counts().completed,1);
  }finally{h.unmount();await flush();}
});

await test('a staged background refresh never demotes a still-authorized current head', async () => {
  const row=game(),h=harness();
  try{
    h.mount();
    h.reads[0].respond({...head(row),runs:[{analysisRunId:'soccer-staged-next-101',analysisStatus:'PROCESSING',startedAt:new Date(now).toISOString()}]});await flush();h.render();
    assert.equal(h.state[0][row.id].status,'done');assert.equal(h.counts().completed,1);
    assert.equal(h.state[0][row.id].currentResearch.analysisRunId,analysis(row).analysisRunId);
    h.setNow(now+5000);await h.tick(1000);assert.equal(h.reads.length,1,'an unrelated staged attempt does not trigger empty/loading or a tight poll loop');
  }finally{h.unmount();await flush();}
});

await test('a server PROCESSING receipt follows up in five seconds and only for its own game', async () => {
  const rows=[game('101'),game('102')],h=harness({games:rows});
  try{
    h.mount();for(let i=0;i<2;i++)h.reads[i].respond(head(rows[i]));await flush();h.render();
    h.setNow(now+30000);await h.tick(1000);assert.equal(h.reads.length,4);
    const pending={...analysis(rows[0]).currentResearch,analysisRunId:'soccer-pending-next-101',revision:null,analysisStatus:'PROCESSING',publishedCurrent:false,reason:'REANALYSIS_PENDING',checkedAt:new Date(now+30000).toISOString()};
    h.reads[2].respond({ok:true,gameId:rows[0].id,league:rows[0].league,date:rows[0].date,currentResearch:pending});
    h.reads[3].respond({ok:true,gameId:rows[1].id,league:rows[1].league,date:rows[1].date,currentResearch:{...analysis(rows[1]).currentResearch,analysisStatus:'COMPLETED',checkedAt:new Date(now+30000).toISOString()}});await flush();h.render();
    assert.equal(h.counts().completed,1,'pending source does not retain the old game authority');
    h.setNow(now+34999);await h.tick(1000);assert.equal(h.reads.length,4);
    h.setNow(now+35000);await h.tick(1000);assert.equal(h.reads.length,5);assert.equal(new URL(h.reads[4].url,'https://fixture.invalid').searchParams.get('eventId'),'101');
    const next=analysis(rows[0],{analysisRunId:pending.analysisRunId,revision:'soccer-fresh-next-101',observedAt:new Date(now+32000).toISOString()});next.currentResearch.checkedAt=new Date(now+35000).toISOString();
    h.reads[4].respond({ok:true,gameId:rows[0].id,league:rows[0].league,date:rows[0].date,currentResearch:{...next.currentResearch,analysisStatus:'COMPLETED'}});await flush();
    assert.equal(h.reads.length,6);assert.equal(h.counts().completed,1,'new receipt cannot authorize old data while head loads');
    h.reads[5].respond(head(rows[0],next));await flush();h.render();assert.equal(h.counts().completed,2);assert.equal(h.posts.length,0);
  }finally{h.unmount();await flush();}
});

await test('server-restored loading keeps lightweight polling while a local manual request is excluded', async () => {
  const row=game(),h=harness();
  try{
    const provider=h.mount(),pending={...analysis(row).currentResearch,analysisRunId:'soccer-restored-pending-101',revision:null,analysisStatus:'PROCESSING',publishedCurrent:false,reason:'REANALYSIS_PENDING'};
    h.reads[0].respond({...head(row,null),versions:[analysis(row)],runs:[{analysisRunId:pending.analysisRunId,analysisStatus:'PROCESSING',startedAt:new Date(now).toISOString()}],currentResearch:pending});await flush();h.render();
    assert.equal(h.state[0][row.id].status,'loading');
    h.setNow(now+1000);await h.tick(1000);assert.equal(h.reads.length,2,'loading from a server run must not leave the current-status polling set');
    h.reads[1].respond({ok:true,gameId:row.id,league:row.league,date:row.date,currentResearch:pending});await flush();h.render();
    const manual=provider.props.value.run(row);h.render();h.setNow(now+6000);await h.tick(1000);
    assert.equal(h.reads.length,2,'a local POST is never raced by automatic status recovery');
    const result=analysis(row,{analysisRunId:'soccer-manual-after-pending',revision:'manual-after-pending',observedAt:new Date(now+5000).toISOString()});result.currentResearch.checkedAt=new Date(now+6000).toISOString();
    h.posts[0].respond(result);await manual;await flush();h.render();assert.equal(h.counts().completed,1);
  }finally{h.unmount();await flush();}
});

await test('fast handoff polling stops after its bounded window and unmount aborts a held status read', async () => {
  const row=game(),h=harness();
  try{
    const pending={...analysis(row).currentResearch,analysisRunId:'soccer-long-pending-101',revision:null,analysisStatus:'PROCESSING',publishedCurrent:false,reason:'REANALYSIS_PENDING'};
    h.mount();h.reads[0].respond({...head(row,null),versions:[analysis(row)],runs:[{analysisRunId:pending.analysisRunId,analysisStatus:'PROCESSING',startedAt:new Date(now).toISOString()}],currentResearch:pending});await flush();h.render();
    h.setNow(now+1000);await h.tick(1000);
    for(let at=1000;at<=121000;at+=5000){
      if(at>1000){h.setNow(now+at);await h.tick(1000);}
      const last=h.reads.at(-1);assert.equal(new URL(last.url,'https://fixture.invalid').searchParams.get('view'),'current');
      if(at===121000){assert.equal(h.reads.length,25,'the unchanged 120-second handoff must return to the normal interval');break;}
      last.respond({ok:true,gameId:row.id,league:row.league,date:row.date,currentResearch:{...pending,checkedAt:new Date(now+at).toISOString()}});await flush();h.render();
    }
    h.setNow(now+135999);await h.tick(1000);assert.equal(h.reads.length,25,'after the fast window, normal polling still waits twenty seconds');
    h.setNow(now+136000);await h.tick(1000);assert.equal(h.reads.length,26,'bounded fast follow-up returns to the transport-safe normal cadence');const held=h.reads.at(-1);assert.equal(held.options.signal.aborted,false);
    h.unmount();await flush();assert.equal(held.options.signal.aborted,true);assert.equal(h.timers.size,0);assert.equal(h.posts.length,0);
  }finally{h.unmount();await flush();}
});

await test('large upcoming boards pace fast follow-up below sixty status reads per minute', async () => {
  const rows=Array.from({length:12},(_,index)=>game(String(201+index))),h=harness({games:rows});
  try{
    h.mount();
    const pending=row=>({...analysis(row).currentResearch,analysisRunId:`soccer-pending-${row.sourceId}`,revision:null,analysisStatus:'PROCESSING',publishedCurrent:false,reason:'REANALYSIS_PENDING'});
    for(let i=0;i<rows.length;i++){
      const row=rows[i],receipt=pending(row);
      h.reads[i].respond({...head(row,null),versions:[analysis(row)],runs:[{analysisRunId:receipt.analysisRunId,analysisStatus:'PROCESSING',startedAt:new Date(now).toISOString()}],currentResearch:receipt});await flush();
    }
    h.render();h.setNow(now+1000);await h.tick(1000);assert.equal(h.reads.length,14,'two lightweight workers at most');
    for(let i=0;i<rows.length;i++){
      const row=rows[i];h.reads[12+i].respond({ok:true,gameId:row.id,league:row.league,date:row.date,currentResearch:pending(row)});await flush();
    }
    h.render();h.setNow(now+6000);await h.tick(1000);assert.equal(h.reads.length,24,'twelve pending games do not issue twelve reads every five seconds');
    h.setNow(now+13000);await h.tick(1000);assert.equal(h.reads.length,26,'twelve-second board cadence retains bounded workers');
  }finally{h.unmount();await flush();}
});

function atomicBody(row,value,sequence='2',checkedAt=now+30000){
  const deadline=value.qualificationValidUntil||value.validUntil||new Date(now+180000).toISOString();
  const receipt={analysisRunId:value.analysisRunId,revision:value.revision,qualificationVersion:sequence,quoteGeneration:'1',
    checkedAt:new Date(checkedAt).toISOString(),validUntil:deadline,publishedCurrent:true,reason:'ACTIVE',analysisStatus:'COMPLETED',selectionResult:'RESEARCH_SHADOW',formalScoringEnabled:false,executable:false};
  return{ok:true,league:row.league,date:row.date,gameId:row.id,versions:[],runs:[],currentResearch:receipt,
    currentVersion:{...value,qualificationVersion:sequence,quoteGeneration:'1',validUntil:deadline,qualificationValidUntil:deadline,currentResearch:receipt},
    currentRun:{analysisRunId:value.analysisRunId,revision:value.revision,requestSeq:sequence,quoteGeneration:'1',analysisStatus:'COMPLETED',publishedCurrent:true,validUntil:deadline}};
}

await test('conditional current response atomically replaces real model rankings without an empty intermediate state', async () => {
  const f=await soccerPredictionLiveFixture({now}),raw=f.build(),row=f.game;
  const base={...raw,persisted:true,publishedCurrent:true,analysisStatus:'COMPLETED',selectionResult:'RESEARCH_SHADOW',validUntil:new Date(now+180000).toISOString()};
  function body(letter,seq,checkedAt){
    const result=atomicBody(row,{...base,revision:letter.repeat(64),analysisRunId:`soccer-atomic-${seq}`},seq,checkedAt);
    result.currentVersion=publishSoccerAnalysisCandidates(result.currentVersion,{currentStatus:result.currentResearch,now:checkedAt});return result;
  }
  const original=body('a','1',now),next=body('b','2',now+30000),frames=[];
  const count=(states,clock,ctx)=>buildSoccerRanking([row],Object.fromEntries(Object.entries(states).map(([id,state])=>[id,{...state,data:state.data?{...state.data,publishedCurrent:ctx.soccerResearchIsCurrent(state,clock)}:null}])),{now:clock}).entries.length;
  const h=harness({games:[row],onState:(states,clock,ctx)=>frames.push(count(states,clock,ctx))});
  try{
    h.mount();h.reads[0].respond(original);await flush();h.render();const before=count(h.state[0],now,h.ctx);assert.ok(before>0,'real parser, model, proof and ranking produce actual qualified rows');frames.length=0;
    h.fire('focus');assert.equal(h.reads.length,2,'hold an older full-head read across the newer conditional response');
    h.setNow(now+30000);await h.tick(1000);assert.equal(h.reads.length,3);
    assert.equal(new URL(h.reads[2].url,'https://fixture.invalid').searchParams.get('revision'),original.currentVersion.revision);
    assert.equal(count(h.state[0],now+30000,h.ctx),before,'old evidence remains valid only until the new response is received');
    h.reads[2].respond(next);await flush();h.render();
    assert.equal(h.state[0][row.id].data.revision,next.currentVersion.revision);assert.equal(h.state[0][row.id].currentResearch.revision,next.currentVersion.revision);
    assert.equal(h.reads.length,3,'complete conditional response needs no second full-head fetch');assert.ok(frames.length>0&&frames.every(size=>size>0),'every state render keeps valid rows; new receipt and data are committed together');
    h.reads[1].respond(original);await flush();h.render();assert.equal(h.state[0][row.id].data.revision,next.currentVersion.revision,'late old full head with equal source timestamps cannot replace atomic new authority');assert.ok(frames.every(size=>size>0));
    const changed={...next.currentResearch,publishedCurrent:false,reason:'QUOTE_CHANGED',checkedAt:new Date(now+60000).toISOString()};h.setNow(now+60000);await h.tick(1000);
    h.reads[3].respond({ok:true,league:row.league,date:row.date,gameId:row.id,currentResearch:changed});await flush();assert.equal(count(h.state[0],now+60000,h.ctx),0,'a genuine source change still removes the prior ranking immediately');
  }finally{h.unmount();await flush();}
});

await test('metadata-only new heads fail closed and recover immediately without waiting for another status worker', async () => {
  const rows=[game('101'),game('102')],h=harness({games:rows});
  try{
    h.mount();h.reads[0].respond(head(rows[0]));h.reads[1].respond(head(rows[1]));await flush();h.render();h.setNow(now+30000);await h.tick(1000);
    const next=analysis(rows[0],{analysisRunId:'soccer-metadata-next',revision:'c'.repeat(64)});
    h.reads[2].respond({ok:true,league:rows[0].league,date:rows[0].date,gameId:rows[0].id,currentResearch:{...next.currentResearch,analysisStatus:'COMPLETED'}});await flush();
    assert.equal(h.counts().completed,1,'the known superseded game is removed while the other game remains');assert.equal(h.reads.length,5,'head recovery starts before the other held status response');
    assert.equal(new URL(h.reads[4].url,'https://fixture.invalid').searchParams.get('view'),'head');assert.equal(h.posts.length,0);
  }finally{h.unmount();await flush();}
});

await test('conditional full results reject mixed head receipts, run metadata and foreign identity', async () => {
  const row=game(),original=analysis(row,{revision:'a'.repeat(64)}),next=atomicBody(row,analysis(row,{analysisRunId:'soccer-atomic-replacement',revision:'b'.repeat(64)}));
  const mutations=[
    body=>{body.currentRun.revision='c'.repeat(64);},body=>{body.currentRun.requestSeq='9';},body=>{body.currentRun.quoteGeneration='9';},
    body=>{body.currentRun.validUntil=new Date(now+50000).toISOString();},body=>{body.currentVersion.currentResearch.revision='c'.repeat(64);},
    body=>{body.currentVersion.currentResearch.analysisRunId='soccer-foreign-run';},body=>{body.currentVersion.currentResearch.quoteGeneration='9';},
    body=>{body.currentVersion.currentResearch.checkedAt=new Date(now+29000).toISOString();},body=>{body.currentVersion.evidence.game.sourceId='999';},
    body=>{body.gameId='soccer:ucl:101';},body=>{body.currentResearch.qualificationVersion='9';},
  ];
  for(const mutate of mutations){const h=harness();try{
    h.mount();h.reads[0].respond(head(row,original));await flush();h.render();h.setNow(now+30000);await h.tick(1000);
    const response=structuredClone(next);response.currentVersion.currentResearch=structuredClone(response.currentVersion.currentResearch);mutate(response);h.reads[1].respond(response);await flush();
    assert.equal(h.state[0][row.id].data.revision,original.revision,'malformed replacement cannot overwrite the previous full result');assert.equal(h.state[0][row.id].currentResearch,null);assert.equal(h.counts().completed,0);
  }finally{h.unmount();await flush();}}
});

await test('a queued manual run fences a conditional full response and its transport uses the full-head timeout', async () => {
  const rows=[game('101'),game('102'),game('103')],h=harness({games:rows});let tasks=[];
  try{
    const provider=h.mount();h.reads[0].respond(head(rows[0]));await flush();h.reads[1].respond(head(rows[1],null));h.reads[2].respond(head(rows[2],null));await flush();h.render();
    h.setNow(now+30000);await h.tick(1000);assert.equal(h.reads.length,4);assert.ok([...h.timers.values()].some(timer=>timer.delay===20000),'conditional full body is allowed the same twenty-second transport budget as head');
    tasks=[provider.props.value.run(rows[1]),provider.props.value.run(rows[2]),provider.props.value.run(rows[0])];assert.equal(h.state[0][rows[0].id].status,'queued');
    h.reads[3].respond(atomicBody(rows[0],analysis(rows[0],{analysisRunId:'soccer-superseded-atomic',revision:'b'.repeat(64)})));await flush();
    assert.equal(h.state[0][rows[0].id].status,'queued','queued work is protected even before pump allocates its next receipt');assert.equal(h.state[0][rows[0].id].data.analysisRunId,analysis(rows[0]).analysisRunId);
  }finally{h.unmount();await Promise.all(tasks);await flush();}
});

await test('Reader invalidation fences a delayed conditional full result before its atomic state update', async () => {
  const row=game(),h=harness(),original=analysis(row,{revision:'a'.repeat(64)});
  try{
    h.mount();h.reads[0].respond(head(row,original));await flush();h.render();h.setNow(now+30000);await h.tick(1000);
    h.fire('soccer:reader-content-changed',{league:row.league,date:row.date,contentHash:'c'.repeat(64)});h.render();assert.equal(h.state[0][row.id].currentResearch,null);
    h.reads[1].respond(atomicBody(row,analysis(row,{analysisRunId:'soccer-obsolete-full-result',revision:'b'.repeat(64)})));await flush();
    assert.equal(h.state[0][row.id].data.revision,original.revision);assert.equal(h.state[0][row.id].currentResearch,null);assert.equal(h.counts().completed,0);
    assert.equal(h.posts.length,0,'source invalidation only schedules a new read');
  }finally{h.unmount();await flush();}
});

await test('an immediate fallback child read cannot cancel its parent revocation in deferred React updates', async () => {
  const row=game(),h=harness();
  try{
    h.mount();h.reads[0].respond(head(row));await flush();h.render();h.setNow(now+30000);await h.tick(1000);h.holdStateUpdates();
    const next=analysis(row,{analysisRunId:'soccer-fallback-next-result',revision:'b'.repeat(64)});
    h.reads[1].respond({ok:true,league:row.league,date:row.date,gameId:row.id,currentResearch:{...next.currentResearch,analysisStatus:'COMPLETED'}});await flush();
    assert.equal(h.reads.length,3,'fallback child has already allocated a newer receipt sequence');
    h.flushStateUpdates();h.render();assert.equal(h.state[0][row.id].currentResearch.revision,next.revision);assert.equal(h.counts().completed,0,'known supersession is applied before child data arrives, even when React deferred the updater');
    h.reads[2].respond(head(row,next));await flush();h.render();assert.equal(h.counts().completed,1);
  }finally{h.flushStateUpdates();h.unmount();await flush();}
});

await test('normal polling budgets a slow full response inside the unchanged 45-second receipt lifetime', async () => {
  const f=await soccerPredictionLiveFixture({now}),row=f.game,raw=f.build();
  const make=(letter,sequence,checkedAt)=>{
    const body=atomicBody(row,{...raw,persisted:true,publishedCurrent:true,analysisStatus:'COMPLETED',selectionResult:'RESEARCH_SHADOW',
      revision:letter.repeat(64),analysisRunId:`soccer-slow-current-${sequence}`,validUntil:new Date(now+180000).toISOString()},sequence,checkedAt);
    body.currentVersion=publishSoccerAnalysisCandidates(body.currentVersion,{currentStatus:body.currentResearch,now:checkedAt});return body;
  };
  const before=make('a','1',now),after=make('b','2',now+20001),h=harness({games:[row]});
  const ranked=()=>buildSoccerRanking([row],{[row.id]:{...h.state[0][row.id],data:{...h.state[0][row.id].data,
    publishedCurrent:h.ctx.soccerResearchIsCurrent(h.state[0][row.id])}}},{now:h.ctx.Date.now()}).entries.length;
  try{
    h.mount();h.reads[0].respond(before);await flush();h.render();const count=ranked();assert.ok(count>0);
    h.setNow(now+19999);await h.tick(1000);assert.equal(h.reads.length,1);
    h.setNow(now+20000);await h.tick(1000);assert.equal(h.reads.length,2,'normal current read starts with room for its whole 20-second timeout');
    assert.equal(new URL(h.reads[1].url,'https://fixture.invalid').searchParams.get('revision'),before.currentVersion.revision);
    for(const at of [30000,35000,38000]){h.setNow(now+at);await h.tick(1000);h.render();assert.equal(ranked(),count,'the prior authorized receipt stays valid while the full body travels');}
    h.reads[1].respond(after);await flush();h.render();assert.equal(ranked(),count);assert.equal(h.state[0][row.id].data.revision,after.currentVersion.revision);
    assert.equal(h.reads.length,2,'the complete response needs no fallback head');
    h.setNow(now+65001);h.render();assert.equal(h.ctx.soccerResearchIsCurrent(h.state[0][row.id]),false,'a lost future poll still expires 45 seconds after the actual request start');
  }finally{h.unmount();await flush();}
});

console.log(`Soccer automatic recovery UI: ${passed} shipped-provider behavior groups passed.`);

// A new current response can arrive between the workspace's ten-second timer
// ticks. Execute the actual parent JSX with persistent hooks, real model quotes
// and publication proof so the candidate list and league badge share the clock.
{
  const workspaceSource=fs.readFileSync('app/soccer/workspace.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export default function|export function/g,'function');
  const workspaceCompiled=await transform(workspaceSource,{filename:'workspace-clock.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
  const baseTime=Date.now(),f=await soccerPredictionLiveFixture({now:baseTime}),raw=f.build();
  const published=(letter,checkedAt)=>{
    const data={...raw,persisted:true,publishedCurrent:true,analysisStatus:'COMPLETED',selectionResult:'RESEARCH_SHADOW',
      revision:letter.repeat(64),analysisRunId:`soccer-workspace-clock-${letter}`,qualificationVersion:'2',quoteGeneration:'9',validUntil:new Date(baseTime+180000).toISOString()};
    const receipt={publishedCurrent:true,reason:'ACTIVE',analysisStatus:'COMPLETED',selectionResult:'RESEARCH_SHADOW',
      revision:data.revision,analysisRunId:data.analysisRunId,qualificationVersion:data.qualificationVersion,quoteGeneration:data.quoteGeneration,
      checkedAt:new Date(checkedAt).toISOString(),validUntil:data.validUntil,formalScoringEnabled:false,executable:false};
    return publishSoccerAnalysisCandidates(data,{currentStatus:receipt,now:checkedAt});
  };
  let wallTime=baseTime+30000,index=0,effectCount=0,timerCount=0,cleanupCount=0;
  const hookState=[],effects=[],intervals=new Map();
  class WorkspaceDate extends Date {static now(){return wallTime;}}
  const live=vm.createContext({React,Date:WorkspaceDate,buildSoccerRanking,SOCCER_RANK_MARKETS,soccerTeamLabel,soccerHighScoreCandidates,
    SoccerRecordProvider:({children})=>children,SoccerRecordButton:()=>null,SoccerBetRecords:()=>null,
    useState:initial=>{const at=index++;if(!(at in hookState))hookState[at]=typeof initial==='function'?initial():initial;
      return[hookState[at],value=>{hookState[at]=typeof value==='function'?value(hookState[at]):value;}];},
    useEffect:effect=>{if(effectCount++===0)effects.push(effect);},
    setInterval:(callback,delay)=>{const id=++timerCount;intervals.set(id,{callback,delay});return id;},
    clearInterval:id=>{cleanupCount++;intervals.delete(id);}});
  vm.runInContext(workspaceCompiled.code,live);
  function renderLive(data){index=0;const tree=live.SoccerWorkspace({league:f.league,date:f.date,games:[f.game],
    states:{[f.game.id]:{status:'done',data}},run:()=>{},children:[],onHighScoreStatusChange:()=>{}});
    return{tree,html:renderToStaticMarkup(tree),candidates:tree.props.candidates};}
  const old=published('a',baseTime+20000);
  renderLive(old);hookState[0]='ranking';
  const cleanups=effects.map(effect=>effect());
  const first=renderLive(old),count=first.candidates.length;assert.ok(count>0);
  assert.equal(intervals.size,1);assert.equal([...intervals.values()][0].delay,10000);
  wallTime=baseTime+33000;const next=published('b',baseTime+31000);
  const stale=buildSoccerRanking([f.game],{[f.game.id]:{status:'done',data:next}},{now:baseTime+30000});
  assert.equal(stale.currentGames,1);assert.equal(stale.entries.length,0,'the previous timer snapshot reproduces one current game with zero rows');
  const arrival=renderLive(next);
  assert.equal(arrival.candidates.length,count,'arrival must immediately update the league badge without waiting for a timer tick');
  assert.equal((arrival.html.match(/class="soccerRankRow"/g)||[]).length,count,'the actual ranking JSX must use the same current render time');
  assert.match(arrival.html,new RegExp(`1 場分析有效｜目前 ${count} 個候選方向`));
  assert.equal(timerCount,1,'payload re-renders never restart the clock interval');
  assert.equal(cleanupCount,0);
  const future=published('c',wallTime+1);
  assert.equal(renderLive(future).candidates.length,0,'a genuinely future receipt is still rejected');
  wallTime=baseTime+180000;
  assert.equal(renderLive(next).candidates.length,0,'an unrelated render at the exact original expiry cannot retain scores until the next timer');
  for(const cleanup of cleanups)cleanup?.();assert.equal(intervals.size,0);assert.equal(cleanupCount,1);
  console.log('PASS actual workspace clock: real model rows and league badge survive a valid receipt between ticks; future receipts and exact immutable expiry remain rejected, with one stable timer and cleanup.');

  await test('first head reads distinguish partial rankings, failures and a confirmed empty board', async () => {
    const missingGame = game('102', f.date, f.league);
    const h = harness({ games: [f.game, missingGame] });
    wallTime = baseTime + 30000;
    h.setNow(wallTime);
    function element(tree, matches) {
      if (!React.isValidElement(tree)) return null;
      if (matches(tree)) return tree;
      for (const child of React.Children.toArray(tree.props.children)) {
        const found = element(child, matches);
        if (found) return found;
      }
      return null;
    }
    function rankedPage(next) {
      const provider = h.render(next);
      const workspace = element(provider, node => node.type === h.ctx.SoccerWorkspace);
      index = 0;
      const tree = live.SoccerWorkspace(workspace.props);
      const ranking = element(tree, node => node.type === live.SoccerRanking);
      const content = live.SoccerRanking(ranking.props);
      return { progress: plain(workspace.props.readProgress), html: renderToStaticMarkup(content),
        retry: element(content, node => node.type === 'button' && node.props.children === '重試讀取') };
    }
    const assertPending = html => assert.doesNotMatch(html, /目前沒有通過|目前 0 個候選方向/);
    try {
      h.mount();
      const first = rankedPage();
      assert.deepEqual(first.progress, { total: 2, loaded: 0, failed: 0 });
      assert.match(first.html, /已載回 0\s*\/\s*2 場/);
      assertPending(first.html);
      h.reads[0].respond(head(f.game, old));
      await flush();
      const partial = rankedPage();
      assert.deepEqual(partial.progress, { total: 2, loaded: 1, failed: 0 });
      assert.match(partial.html, /已載回 1\s*\/\s*2 場/);
      assert.equal((partial.html.match(/data-soccer-rank-key=/g) || []).length, count,
        'the first trustworthy candidates remain visible while the other read is pending');

      h.reads[1].respond({ ok: false, error: 'head unavailable' }, 503);
      await flush();
      const failure = rankedPage();
      assert.deepEqual(failure.progress, { total: 2, loaded: 1, failed: 1 });
      assert.match(failure.html, /讀取失敗/);
      assert.ok(failure.retry && !failure.retry.props.disabled);
      assert.equal((failure.html.match(/data-soccer-rank-key=/g) || []).length, count);
      failure.retry.props.onClick();
      await flush();
      assert.equal(h.reads.length, 3, 'retry reads only the failed game');
      assert.equal(new URL(h.reads[2].url, 'https://fixture.invalid').searchParams.get('eventId'), missingGame.sourceId);
      assert.equal(h.posts.length, 0, 'first-load retry cannot start a model run');
      h.reads[2].respond(head(missingGame, null));
      await flush();
      const finished = rankedPage();
      assert.deepEqual(finished.progress, { total: 2, loaded: 2, failed: 0 });
      assert.doesNotMatch(finished.html, /讀取失敗|重試讀取/);
      assert.equal((finished.html.match(/data-soccer-rank-key=/g) || []).length, count);

      // Focus drives the normal background GET. Keep displayed results and
      // first-read completion while the identical scope is refreshed.
      h.fire('focus');
      assert.deepEqual(rankedPage().progress, finished.progress);
      const otherDate = f.date === '2099-01-02' ? '2099-01-03' : '2099-01-02';
      const moved = { ...f.game, date: otherDate, startTime: otherDate + 'T13:00:00Z' };
      const newScope = rankedPage({ games: [moved], date: otherDate });
      assert.deepEqual(newScope.progress, { total: 1, loaded: 0, failed: 0 });
      assertPending(newScope.html);
      assert.doesNotMatch(newScope.html, /data-soccer-rank-key=/);
      h.reads.at(-1).respond(head(moved, null));
      await flush();
      const empty = rankedPage();
      assert.deepEqual(empty.progress, { total: 1, loaded: 1, failed: 0 });
      assert.match(empty.html, /目前 0 個候選方向/);
      assert.match(empty.html, /目前沒有通過/);
      assert.doesNotMatch(empty.html, /讀取失敗|重試讀取/);

      // A confirmed empty response is local to its original match date.
      // Reusing the same source ID on another date must not inherit that idle state.
      const timedDate = '2099-01-04';
      const timedGame = { ...moved, date: timedDate, startTime: timedDate + 'T13:00:00Z' };
      const timedScope = { games: [timedGame], date: timedGame.date };
      assertPending(rankedPage(timedScope).html);
      await h.tick(20000);
      const timeout = rankedPage();
      assert.deepEqual(timeout.progress, { total: 1, loaded: 0, failed: 1 });
      assertPending(timeout.html);
      assert.match(timeout.html, /讀取失敗/);
      timeout.retry.props.onClick();
      await flush();
      const retriedHead = h.reads.at(-1);
      const manual = h.render().props.value.run(timedGame);
      h.posts.at(-1).respond(analysis(timedGame, { revision: 'manual-wins', analysisRunId: 'current-manual-run' }));
      await manual; await flush();
      assert.deepEqual(rankedPage().progress, { total: 1, loaded: 1, failed: 0 });
      retriedHead.respond({ ok: false }, 503); await flush();
      assert.equal(h.state[0][timedGame.id].data.revision, 'manual-wins');
      assert.deepEqual(rankedPage().progress, { total: 1, loaded: 1, failed: 0 },
        'an obsolete head failure cannot revoke a newer completed manual result');

      const failedGame = game('304', moved.date, f.league);
      rankedPage({ games: [failedGame], date: failedGame.date });
      const firstRead = h.reads.at(-1), readsBeforeRun = h.reads.length;
      const failedRun = h.render().props.value.run(failedGame);
      h.posts.at(-1).respond({ ok: false, error: 'analysis unavailable' }, 503);
      await failedRun; await flush();
      firstRead.respond(head(failedGame, null)); await flush();
      assert.equal(h.reads.length, readsBeforeRun + 1, 'an unsuccessful manual run schedules a new read for the fenced head');
      assertPending(rankedPage().html);
      h.reads.at(-1).respond(head(failedGame, null)); await flush();
      assert.deepEqual(rankedPage().progress, { total: 1, loaded: 1, failed: 0 });
      const confirmedEmptyScope = rankedPage({ games: [], date: failedGame.date });
      assert.deepEqual(confirmedEmptyScope.progress, { total: 0, loaded: 0, failed: 0 });
      assert.match(confirmedEmptyScope.html, /目前範圍沒有未開賽場次/);
      assert.doesNotMatch(confirmedEmptyScope.html, /目前沒有通過|讀取失敗|重試讀取|已載回/);
    } finally { h.unmount(); await flush(); }
  });
}
