import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as workspace from '../lib/nhl/client-workspace.js';

const source = await readFile(new URL('../app/nhl/page.js', import.meta.url), 'utf8');
function declaration(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `${name} must be the actual client handler`);
  const start = source.indexOf('{', source.indexOf(') {', match.index));
  let depth = 0; let quote = null; let comment = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]; const next = source[index + 1];
    if (comment === 'line') { if (char === '\n') comment = null; continue; }
    if (comment === 'block') { if (char === '*' && next === '/') { comment = null; index += 1; } continue; }
    if (quote) { if (char === '\\') { index += 1; continue; } if (char === quote) quote = null; continue; }
    if (char === '/' && next === '/') { comment = 'line'; index += 1; continue; }
    if (char === '/' && next === '*') { comment = 'block'; index += 1; continue; }
    if (['"', "'", '`'].includes(char)) { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`Unclosed actual ${name} handler`);
}
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}
const fixedNow = Date.parse('2026-10-12T08:00:00Z');
const game = (id = '2026020001', date = '2026-10-13', gameState = 'FUT') => ({ league: 'NHL', leagueId: 'NHL', gameId: id, taipeiDate: date,
  gameState, startTimeUTC: `${date}T02:00:00Z`, awayTeamId: 1, homeTeamId: 2, away: { abbrev: 'NJD' }, home: { abbrev: 'NYI' } });
const record = (row = game(), mode = 'PREGAME_SHADOW', generatedAt = '2026-10-12T08:00:00Z') => ({ league: 'NHL', date: row.taipeiDate, gameId: row.gameId,
  analysis: { league: 'NHL', gameId: row.gameId, taipeiDate: row.taipeiDate, game: row, mode, generatedAt,
    model: { expectedGoals: { away: 2.1, home: 2.9 }, probabilities: { regulationAwayWin: 0.3, regulationDraw: 0.2, regulationHomeWin: 0.5 } },
    persistence: { persisted: true } } });
const board = (date, rows = []) => ({ ok: true, league: 'NHL', date, games: rows });
function deferred() {
  let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(initial = {}) {
  let mounted = true;
  const localStorage = storage();
  globalThis.window = { localStorage, dispatchEvent() {} };
  const state = { date: '2026-10-13', selectedGame: null, busy: {}, error: '', analyses: {}, analysisErrors: {}, boards: {}, batchProgress: {}, tab: 'analysis', ...initial };
  const calls = [];
  const context = { ...workspace, ...state, localStorage, taipeiDay: () => '2026-10-12', canAnalyzeNhlPregame: row => workspace.canAnalyzeNhlPregame(row, fixedNow),
    inFlight: { current: new Set() }, analysisInFlight: { current: new Map() }, boardRequests: { current: new Map() }, activeDate: { current: state.date },
    request(action, args) { const pending = deferred(); calls.push({ kind: action, args, ...pending }); return pending.promise; },
    analysisRequest(method, args) { const pending = deferred(); calls.push({ kind: method, args, ...pending }); return pending.promise; },
  };
  for (const key of Object.keys(state)) context[`set${key[0].toUpperCase()}${key.slice(1)}`] = value => {
    if (!mounted) return;
    state[key] = typeof value === 'function' ? value(state[key]) : value; context[key] = state[key];
  };
  const names = ['run', 'selectDate', 'storeAnalysis', 'loadSavedAnalyses', 'restoreAnalysisRun', 'analyzeGame', 'analysisBoard', 'nextPregameBoard', 'goNextGameDate', 'analyzeAll'];
  vm.createContext(context);
  vm.runInContext(`${names.map(declaration).join('\n')}\nglobalThis.api = {${names.join(',')}};`, context);
  return { state, calls, api: context.api, localStorage, context, unmount() { mounted = false; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
let passed = 0;
async function test(name, operation) { await operation(); passed += 1; console.log(`PASS ${name}`); }

await test('analysis persistence rejects nested foreign leagues, date keys and mismatched game identities', async () => {
  const valid = record(); const key = workspace.nhlAnalysisKey(valid.date, valid.gameId);
  assert.equal(workspace.validNhlWorkspaceRecord('analyses', key, valid), true);
  for (const mutate of [
    value => { value.analysis.leagueId = 'NBA'; },
    value => { value.analysis.game.league = 'MLB'; },
    value => { value.analysis.taipeiDate = '2026-10-14'; },
    value => { value.analysis.game.gameId = '2026020002'; },
    value => { value.analysis.mode = 'RECOMPUTED_FROM_RESULT'; },
  ]) {
    const wrong = structuredClone(valid); mutate(wrong);
    assert.equal(workspace.validNhlWorkspaceRecord('analyses', key, wrong), false);
  }
  assert.equal(workspace.validNhlWorkspaceRecord('analyses', `2026-10-14:${valid.gameId}`, valid), false);
});
await test('an empty archive response or older generation cannot erase a saved pregame analysis', async () => {
  const previous = record(); const empty = record(game(), 'NO_PREGAME_RECORD', '2026-10-12T09:00:00Z');
  assert.equal(workspace.preferNhlWorkspaceRecord(previous, empty), previous);
  assert.equal(workspace.preferNhlWorkspaceRecord(previous, record(game(), 'PREGAME_SHADOW', '2026-10-12T07:00:00Z')), previous);
});
await test('entry URL accepts a unique valid date and run ID without reopening unrelated stored dates', async () => {
  assert.deepEqual(workspace.initialNhlWorkspaceLocation('?date=2026-10-13&analysisRun=wrun_nhl123'), { date: '2026-10-13', analysisRun: 'wrun_nhl123' });
  assert.deepEqual(workspace.initialNhlWorkspaceLocation('?date=2026-02-30&analysisRun=invalid.run'), { date: null, analysisRun: null });
  assert.equal(workspace.initialNhlWorkspaceLocation('?date=2026-10-13&date=2026-10-14').date, null);
});
await test('all-league workflow fallback restores only matching NHL game/date identities and truthful saved flags', async () => {
  const makeBatch = saved => ({ league: 'NHL', date: '2026-10-13', total: 1, completed: 1,
    results: [{ ok: true, shadow: true, saved, payload: record().analysis,
      task: { league: 'NHL', game: game(), nhlQuery: { date: '2026-10-13', gameId: game().gameId } } }] });
  const h = harness(); const batch = makeBatch(true); h.api.restoreAnalysisRun(batch, '2026-10-13');
  assert.ok(h.state.analyses['2026-10-13:2026020001']);
  assert.equal(h.state.batchProgress['2026-10-13'].running, false);
  for (const mutate of [
    value => { value.results[0].saved = false; },
    value => { value.results[0].task.game.awayTeamId = 3; },
    value => { value.results[0].task.game.startTimeUTC = '2026-10-13T02:05:00Z'; },
    value => { value.results[0].task.nhlQuery.date = '2026-10-14'; },
  ]) {
    const wrong = makeBatch(true); mutate(wrong);
    assert.throws(() => h.api.restoreAnalysisRun(wrong, '2026-10-13'), /身分或保存狀態/);
  }
  const unsaved = makeBatch(false); unsaved.results[0].payload.persistence.persisted = false;
  h.api.restoreAnalysisRun(unsaved, '2026-10-13');
  assert.equal(h.state.analyses['2026-10-13:2026020001'].analysis.persistence.persisted, false);
});
await test('same-game double click reuses one analysis promise and renders its completion immediately', async () => {
  const h = harness(); const row = game();
  const first = h.api.analyzeGame(row); const second = h.api.analyzeGame(row);
  assert.equal(first, second); assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ ok: true, ...record(row) }); await first;
  assert.equal(h.state.analyses[`2026-10-13:${row.gameId}`].analysis.gameId, row.gameId);
  assert.equal(h.state.busy[`analysis:2026-10-13:${row.gameId}`], false);
});
await test('late completion survives page departure without changing another selected date', async () => {
  const h = harness(); const row = game(); const task = h.api.analyzeGame(row);
  h.api.selectDate('2026-10-14'); h.unmount();
  h.calls[0].resolve({ ok: true, ...record(row) }); await task;
  const saved = workspace.readNhlWorkspace(h.localStorage);
  assert.equal(saved.analyses[`2026-10-13:${row.gameId}`].analysis.gameId, row.gameId);
  assert.equal(h.state.date, '2026-10-14');
});
await test('failed refresh preserves prior analysis and allows a successful retry', async () => {
  const row = game(); const key = `2026-10-13:${row.gameId}`; const previous = record(row);
  const h = harness({ analyses: { [key]: previous } });
  const first = h.api.analyzeGame(row); h.calls[0].reject(new Error('upstream timeout')); await first;
  assert.equal(h.state.analyses[key], previous); assert.match(h.state.analysisErrors[key], /timeout/);
  const second = h.api.analyzeGame(row); h.calls[1].resolve({ ok: true, ...record(row, 'PREGAME_SHADOW', '2026-10-12T08:01:00Z') }); await second;
  assert.equal(h.state.analysisErrors[key], ''); assert.equal(h.state.analyses[key].analysis.generatedAt, '2026-10-12T08:01:00Z');
});
await test('archive reads validate all game/date records before displaying any response', async () => {
  const h = harness(); const task = h.api.loadSavedAnalyses('2026-10-13');
  h.calls[0].resolve({ league: 'NHL', date: '2026-10-13', analyses: [record().analysis, record(game('2026020002', '2026-10-14')).analysis] }); await task;
  assert.equal(Object.keys(h.state.analyses).length, 0); assert.match(h.state.error, /不同日期/);
});
await test('batch completes cards progressively with two workers and excludes started games', async () => {
  const h = harness(); const first = game(); const second = game('2026020002'); const third = game('2026020003');
  const task = h.api.analyzeAll();
  h.calls[0].resolve(board('2026-10-13', [first, second, third, game('2026020004', '2026-10-13', 'FINAL')])); await flush();
  assert.equal(h.calls.filter(call => call.kind === 'POST').length, 2);
  h.calls[2].resolve({ ok: true, ...record(second) }); await flush();
  assert.ok(h.state.analyses[`2026-10-13:${second.gameId}`]);
  assert.equal(h.state.batchProgress['2026-10-13'].completed, 1);
  assert.equal(h.calls.filter(call => call.kind === 'POST').length, 3);
  h.calls[3].resolve({ ok: true, ...record(third) }); h.calls[1].resolve({ ok: true, ...record(first) }); await task;
  assert.equal(h.state.batchProgress['2026-10-13'].completed, 3);
  assert.equal(h.state.batchProgress['2026-10-13'].running, false);
  assert.equal(h.state.busy.batch, false);
  assert.equal(h.calls.some(call => call.args.gameId === '2026020004'), false);
});
await test('today completed games advance batch to the next pregame Taipei board without postdiction', async () => {
  const h = harness({ date: '2026-10-12' }); const task = h.api.analyzeAll();
  h.calls[0].resolve(board('2026-10-12', [game('2026020005', '2026-10-12', 'FINAL')])); await flush();
  assert.equal(h.calls[1].args.date, '2026-10-13');
  h.calls[1].resolve(board('2026-10-13', [game()])); await flush();
  assert.equal(h.state.date, '2026-10-13'); assert.equal(h.calls[2].args.date, '2026-10-13');
  h.calls[2].resolve({ ok: true, ...record() }); await task;
  assert.equal(h.calls.some(call => call.kind === 'POST' && call.args.date === '2026-10-12'), false);
});
await test('next game date search cannot steal a manually changed date while its source is pending', async () => {
  const h = harness({ date: '2026-10-12' }); const task = h.api.goNextGameDate();
  h.api.selectDate('2026-10-20'); h.calls[0].resolve(board('2026-10-13', [game()])); await task;
  assert.equal(h.state.date, '2026-10-20'); assert.ok(h.state.boards['2026-10-13']);
});
await test('actual analysis HTTP boundary rejects authentication, cross-league and cross-date responses', async () => {
  const boundary = (body, status = 200) => vm.runInNewContext(`(${declaration('analysisRequest')})`, {
    AbortController, URLSearchParams, setTimeout, clearTimeout,
    fetch: async () => ({ ok: status < 400, status, json: async () => body }),
  });
  await assert.rejects(boundary({ ok: true, league: 'NBA', date: '2026-10-13' })('GET', { date: '2026-10-13' }), /聯盟不符/);
  await assert.rejects(boundary({ ok: true, league: 'NHL', date: '2026-10-14' })('GET', { date: '2026-10-13' }), /日期/);
  await assert.rejects(boundary({ ok: false }, 401)('GET', { date: '2026-10-13' }), /登入已過期/);
});

delete globalThis.window;
console.log(`NHL analysis client: ${passed} actual-handler isolation, persistence and progressive flow groups passed. Production and real-device checks remain separate.`);
