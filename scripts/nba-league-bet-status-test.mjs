import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transform } from 'next/dist/build/swc/index.js';
import { summarizeHighScoreBets } from '../lib/league-bet-status.js';
import { loadNbaUpcomingBoard } from '../lib/nba/analysis-ui-policy.js';
import { analyzeNbaPreseason } from '../lib/nba/preseason-model.js';
import { buildNbaShadowRanking, buildNbaShadowOrder } from '../lib/nba/shadow-ranking.js';

// Exercise the actual provider and its effects without a DOM or real timers.
// Only React's scheduling surface, network, and browser events are simulated.
const compiled = await transform(fs.readFileSync(new URL('../app/nba/bet-records.js', import.meta.url), 'utf8'), {
  filename: 'app/nba/bet-records.js',
  module: { type: 'commonjs' },
  jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' },
});

function mount(initialProps) {
  let cursor = 0, hooks = [], effects = [], dirty = false, tree, props = initialProps;
  const requests = [], intervals = new Map(), events = new Map();
  let nextTimer = 0;
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    createContext: () => ({ Provider: 'Provider' }),
    useContext: () => { throw Error('Unexpected child component render'); },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => {
        const next = typeof value === 'function' ? value(hooks[index]) : value;
        if (!Object.is(next, hooks[index])) { hooks[index] = next; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { deps, fn };
      return hooks[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (sameDeps(hooks[index]?.deps, deps)) return;
      const previous = hooks[index];
      hooks[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = fn(); });
    },
  };
  const surface = name => ({
    addEventListener: (event, callback) => events.set(`${name}:${event}`, callback),
    removeEventListener: (event, callback) => { if (events.get(`${name}:${event}`) === callback) events.delete(`${name}:${event}`); },
  });
  const document = { ...surface('document'), visibilityState: 'visible' };
  const sandbox = {
    exports: {}, AbortSignal, Set, JSON, Error, document, window: surface('window'),
    require(id) {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (id.endsWith('/league-bet-status.js')) return { summarizeHighScoreBets };
      if (id.endsWith('/manual-bet-stats.js')) return { nbaManualRecordStats: () => { throw Error('Unexpected child statistics render'); } };
      throw Error(`Unexpected provider dependency: ${id}`);
    },
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    setInterval(callback) { const id = ++nextTimer; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
  };
  vm.runInNewContext(compiled.code, sandbox, { filename: 'nba-bet-records-hook-test.js' });
  const render = () => {
    cursor = 0; dirty = false; tree = sandbox.exports.NbaBetRecordProvider(props);
    const current = effects; effects = []; current.forEach(effect => effect());
  };
  const flush = async () => {
    for (let turns = 0; turns < 20; turns++) { await Promise.resolve(); if (dirty) render(); }
    assert.equal(dirty, false, 'provider effects must reach a stable render');
  };
  render();
  return {
    requests, flush, document,
    ledger: () => tree.props.value,
    async update(patch) { props = { ...props, ...patch }; render(); await flush(); },
    async respond(request, value, ok = true) {
      assert.ok(request, 'expected a network request');
      request.resolve({ ok, json: async () => value }); await flush();
    },
    async tick() { [...intervals.values()].forEach(callback => callback()); await flush(); },
    async event(name) { events.get(name)?.(); await flush(); },
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); assert.equal(intervals.size, 0); assert.equal(events.size, 0); },
  };
}

const date = '2026-10-19';
const game = { id: 'nba:espn:game:401999001', startTime: '2026-10-20T00:00:00Z' };
const candidate = { stableKey: 'nba:espn:game:401999001:fullTotal:over', game, marketKey: 'fullTotal', side: 'over' };
const entry = { ...candidate, line: '216.5', water: .94, away: '客隊', home: '主隊' };
const record = { id: 'confirmed-record', date, gameId: game.id, marketKey: candidate.marketKey, side: candidate.side, status: 'OPEN' };
const changes = [];
const state = mount({ date, active: false, candidates: [candidate], onHighScoreStatusChange: value => changes.push(value) });
await state.flush();
assert.equal(changes.at(-1).state, 'pending');
assert.equal(changes.at(-1).label, '下注狀態待同步');
assert.equal(state.requests.length, 1, 'unselected NBA must still load its ledger');
assert.match(state.requests[0].url, /date=2026-10-19$/);
await state.respond(state.requests.shift(), { ok: true, records: [] });
assert.equal(changes.at(-1).state, 'unbet');
assert.equal(changes.at(-1).label, '有高分未下注');

let action = state.ledger().save(entry);
await state.flush();
assert.equal(changes.at(-1).state, 'unbet', 'a pending save cannot claim a confirmed bet');
assert.equal(JSON.parse(state.requests[0].options.body).stake, 10000);
await state.tick();
assert.equal(state.requests.length, 1, 'background refresh must not invalidate an in-flight save');
await state.respond(state.requests.shift(), { ok: true, record, persistence: 'durable_database' });
await action; await state.flush();
assert.equal(changes.at(-1).state, 'all_bet');
assert.equal(changes.at(-1).label, '高分已全下注');

for (const [operation, status, expected] of [['cancel', 'CANCELLED', 'unbet'], ['restore', 'OPEN', 'all_bet']]) {
  action = state.ledger().changeStatus(record, operation);
  await state.flush();
  await state.respond(state.requests.shift(), { ok: true, record: { ...record, status }, persistence: 'durable_database' });
  await action; await state.flush();
  assert.equal(changes.at(-1).state, expected, `${operation} must update the outer summary from the saved response`);
}

const published = changes.length;
await state.update({ active: true, onHighScoreStatusChange: value => changes.push(value) });
await state.update({ active: false, onHighScoreStatusChange: value => changes.push(value) });
assert.equal(changes.length, published, 'tab switches and fresh callback identities must not cause callback loops');
assert.equal(state.requests.length, 0, 'tab switches must retain the confirmed ledger');
assert.equal(state.ledger().records.length, 1);

await state.update({ analysisReady: false });
assert.equal(changes.at(-1).state, 'analysis_pending', 'a newer NBA job must fence the previous all-bet result');
assert.equal(changes.at(-1).label, '高分狀態待確認');
assert.equal(changes.at(-1).total, null, 'previous candidate totals cannot confirm a newer job');
await state.update({ analysisReady: true });
assert.equal(changes.at(-1).state, 'all_bet', 'confirmed candidates must recover when the new NBA job is ready');

const second = { ...candidate, stableKey: 'second-market', marketKey: 'firstHalfTotal' };
await state.update({ candidates: [candidate, second] });
assert.equal(changes.at(-1).state, 'unbet', 'a bet on another market cannot satisfy the remaining candidate');
assert.equal(changes.at(-1).recorded, 1);
assert.equal(changes.at(-1).unbet, 1);
await state.update({ candidates: [candidate] });

// A GET started before a write may finish later with the previous state.
await state.tick(); const staleRead = state.requests.shift();
action = state.ledger().changeStatus(record, 'cancel');
await state.flush();
await state.respond(state.requests.shift(), { ok: true, record: { ...record, status: 'CANCELLED' }, persistence: 'durable_database' });
await action; await state.flush();
assert.equal(changes.at(-1).state, 'unbet');
await state.respond(staleRead, { ok: true, records: [record] });
assert.equal(changes.at(-1).state, 'unbet', 'stale background GET must not overwrite confirmed cancellation');

action = state.ledger().changeStatus(record, 'restore');
await state.flush();
await state.respond(state.requests.shift(), { ok: true, record, persistence: 'memory_only' });
await action; await state.flush();
assert.equal(changes.at(-1).state, 'unbet', 'a response without durable confirmation cannot mark the candidate as recorded');
assert.equal(state.ledger().records[0].status, 'CANCELLED');

await state.tick(); const oldDateRead = state.requests.shift();
await state.update({ date: '2026-10-20' });
assert.equal(changes.at(-1).state, 'pending', 'previous-date ready records cannot confirm the new date');
assert.equal(state.ledger().status, 'loading');
assert.equal(state.ledger().records.length, 0);
await state.respond(oldDateRead, { ok: true, records: [record] });
assert.equal(changes.at(-1).state, 'pending', 'an old-date request finishing late must remain isolated');
await state.respond(state.requests.shift(), { ok: true, records: [record] });
assert.equal(changes.at(-1).state, 'unbet', 'wrong-date records in a response must not satisfy current-date candidates');
assert.equal(changes.at(-1).date, '2026-10-20');

state.document.visibilityState = 'hidden'; await state.tick();
assert.equal(state.requests.length, 0, 'hidden browser documents should avoid background ledger requests');
state.document.visibilityState = 'visible'; await state.event('document:visibilitychange');
await state.respond(state.requests.shift(), { ok: false, error: 'database unavailable' }, false);
assert.equal(changes.at(-1).state, 'pending', 'a failed refresh cannot claim all candidates are recorded');
await state.event('window:focus');
await state.respond(state.requests.shift(), { ok: true, records: [] });
assert.equal(changes.at(-1).state, 'unbet', 'focus refresh must recover failed ledger synchronization');
await state.update({ candidates: [] });
assert.equal(changes.at(-1).state, 'none');
assert.equal(changes.at(-1).label, '', 'zero candidates must never claim high scores were all recorded');
assert.equal(changes.at(-1).league, 'NBA');
state.unmount();

console.log('NBA league bet status PASS: hidden ledger, durable save/cancel/restore, no false confirmation, market/date isolation, stale GET/write protection, refresh recovery and stable callback');

// Run the actual board loader and refresh effect with another league still busy.
// The fixture has a genuine qualifying preseason direction; stale quotes must
// still expire under the existing ranking rules rather than a badge exception.
const workspace = fs.readFileSync(new URL('../app/nba/main-workspace.js', import.meta.url), 'utf8');
assert.match(workspace, /<NbaBetRecordProvider[^>]*analysisReady=\{!running\}/,
  'NBA readiness fence must track its own analysis job rather than other busy leagues');
const loadStart = workspace.indexOf('  async function load(');
const loadEnd = workspace.indexOf('\n  useEffect(', loadStart);
assert.ok(loadStart >= 0 && loadEnd > loadStart, 'NBA workspace board loader must be present');
const refreshEffect = workspace.split('\n').find(line => line.includes('useEffect(') && line.includes('setInterval(') && line.includes('30000') && line.includes('trackBoard'));
assert.ok(refreshEffect, 'NBA workspace must install a tracked-board refresh');

const boardDate = '2026-10-06', initialNow = Date.parse('2026-10-05T19:50:00Z');
let clock = initialNow;
const initialObservedAt = new Date(initialNow).toISOString();
const quotes = {
  fullTotal: { line: '232.5', overWater: .94, underWater: .94 },
  fullRunline: { line: '3平', lineSide: 'home', homeWater: .95, awayWater: .95 },
  firstHalfTotal: { line: '115+50', overWater: .94, underWater: .96 },
  firstHalfRunline: { line: '2-25', lineSide: 'away', homeWater: .95, awayWater: .95 },
};
const boardGame = {
  league: 'NBA', id: 'nba:espn:game:401999001', sourceId: '401999001', gamePk: 401999001,
  seasonType: 'preseason', season: { year: 2027 }, taipeiDate: boardDate, startTime: '2026-10-05T23:00:00Z',
  home: { id: 'nba:espn:team:1' }, away: { id: 'nba:espn:team:29' },
};
const initialRow = {
  game: boardGame, quote: quotes, observedAt: initialObservedAt, pageActivityAt: initialObservedAt, canAnalyze: true,
  result: { ...analyzeNbaPreseason(boardGame, quotes), league: 'NBA', gameId: boardGame.id, date: boardDate, observedAt: initialObservedAt },
  jobState: 'ready',
};
const qualifying = rows => buildNbaShadowOrder(buildNbaShadowRanking(rows, boardDate, clock).entries).flatMap(group => group.entries);
assert.ok(qualifying([initialRow]).length, 'test fixture must contain a real qualifying direction');
clock += 4 * 60_000;
assert.equal(qualifying([initialRow]).length, 0, 'unchanged stale timestamps must still remove expired candidates');
clock = initialNow;

let boardRows = [initialRow], readCount = 0, refresh, disposed = false, heldResponse;
const boardScope = {
  trackBoard: true, busy: true, operation: { current: false }, requestRevision: { current: 0 },
  dateRef: { current: boardDate }, explicitDate: { current: false }, jobRef: { current: { status: 'completed' } },
  setLoading: () => {}, setError: message => assert.equal(message, ''), setReaderStatus: () => {},
  setDate: () => { throw Error('Read-only quote refresh must not change this board date'); }, onDateChange: () => {},
  setProgress: () => {}, setSelected: () => {}, setRows: update => { boardRows = typeof update === 'function' ? update(boardRows) : update; },
  loadNbaUpcomingBoard: options => loadNbaUpcomingBoard({ ...options, now: clock }),
  async api(url) {
    assert.ok(url.startsWith('/api/nba/reader') || url.startsWith('/api/nba/analysis-board?'), 'quote refresh must only read Reader/board APIs');
    const observedAt = new Date(clock).toISOString();
    if (url === '/api/nba/reader') return { status: 'fresh', boardDate, observedAt, pageActivityAt: observedAt };
    readCount++;
    const board = { date: boardDate, readerStatus: 'fresh', rows: [{ game: boardGame, quote: quotes, observedAt, pageActivityAt: observedAt, canAnalyze: true }] };
    if (heldResponse) return new Promise(resolve => { heldResponse.resolve = () => resolve(board); });
    return board;
  },
  useEffect: effect => effect(),
  setInterval(callback, milliseconds) { assert.equal(milliseconds, 30000); refresh = callback; return 1; },
  clearInterval: () => { disposed = true; },
};
const disposeRefresh = vm.runInNewContext(`${workspace.slice(loadStart, loadEnd)}\n${refreshEffect.trim().replace(/^useEffect\(/, 'captureEffect(')}`, {
  ...boardScope, captureEffect: effect => effect(),
});
assert.equal(typeof refresh, 'function', 'another league being busy must not suspend read-only NBA quote refresh');
const settleReads = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
for (let step = 1; step <= 14; step++) {
  // NBA is complete, while the global run stays busy for another seven minutes.
  clock = initialNow + step * 30000;
  refresh(); await settleReads();
  assert.equal(boardRows[0].observedAt, new Date(clock).toISOString(), 'Reader quote timestamp must advance during the remaining leagues');
  assert.equal(boardRows[0].pageActivityAt, new Date(clock).toISOString());
  assert.equal(boardRows[0].result, initialRow.result, 'refresh must preserve the completed model result');
  assert.equal(summarizeHighScoreBets(qualifying(boardRows), { ledgerReady: true }).state, 'unbet', 'fresh same-price analysis must retain the high-score reminder');
}
assert.equal(readCount, 14);
boardScope.jobRef.current = { status: 'running' };
clock += 30000;
refresh(); await settleReads();
assert.equal(readCount, 15, 'NBA own model job must not pause read-only quote refresh either');
assert.equal(boardRows[0].observedAt, new Date(clock).toISOString());
boardScope.operation.current = true;
refresh(); await settleReads();
assert.equal(readCount, 15, 'starting a model operation must retain the preflight/request guard');
boardScope.operation.current = false;
heldResponse = {};
refresh(); await settleReads();
boardScope.dateRef.current = '2026-10-07';
const protectedRows = boardRows;
heldResponse.resolve(); await settleReads();
assert.equal(boardRows, protectedRows, 'late quote refresh from the previous date must not replace current rows');
assert.equal(typeof disposeRefresh, 'function');
disposeRefresh();
assert.equal(disposed, true);
console.log('NBA busy quote refresh PASS: delayed all-league completion, advancing Reader timestamps, unchanged model/eligibility and operation/date race guards');
