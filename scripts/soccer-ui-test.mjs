import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { soccerTeamLabel } from '../lib/soccer/team-labels.js';

const source = await readFile(new URL('../app/soccer/main-workspace.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/soccer/soccer.css', import.meta.url), 'utf8');
function blockAt(start) {
  assert.equal(source[start], '{');
  let depth = 0;
  let quote = null;
  let comment = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]; const next = source[i + 1];
    if (comment === 'line') { if (ch === '\n') comment = null; continue; }
    if (comment === 'block') { if (ch === '*' && next === '/') { comment = null; i += 1; } continue; }
    if (quote) { if (ch === '\\') { i += 1; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '/' && next === '/') { comment = 'line'; i += 1; continue; }
    if (ch === '/' && next === '*') { comment = 'block'; i += 1; continue; }
    if (['"', "'", '`'].includes(ch)) { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unclosed source block');
}
function declaration(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `Actual handler ${name} must exist`);
  const start = source.indexOf('{', source.indexOf(') {', match.index));
  return source.slice(match.index, start) + blockAt(start);
}
const helpers = ['taipeiDate', 'validDate', 'shiftDate', 'readLocation', 'workspaceUrl', 'savedAllRun', 'runLocation', 'boardKey', 'teamName', 'scoreValue', 'verifiedScore', 'safeSourceUrl', 'validateBoard', 'requestBoard', 'navigate'];
function context(extra = {}) {
  const ctx = {
    URLSearchParams, URL, Date, Intl, AbortController, setTimeout, clearTimeout, soccerTeamLabel,
    SOCCER_LEAGUES: { EPL: {}, UCL: {} }, VIEW_NAMES: { schedule: '', upcoming: '', standings: '' },
    ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(`${helpers.map(declaration).join('\n')}\nglobalThis.api = {${helpers.join(',')}};`, ctx);
  return ctx;
}
const plain = value => JSON.parse(JSON.stringify(value));
const location = { league: 'EPL', date: '2026-10-18', view: 'schedule' };
const game = (league = 'epl', date = location.date) => ({ id: `soccer:${league}:1`, league, date, status: 'scheduled', home: { id: '1', name: 'Home', score: null }, away: { id: '2', name: 'Away', score: null } });
const board = (args = location) => ({ ok: true, league: { id: args.league.toLowerCase() }, date: args.date, timeZone: 'Asia/Taipei', games: [game(args.league.toLowerCase(), args.date)], source: { fetchedAt: '2026-10-18T00:00:00Z' } });
let count = 0;
async function test(name, operation) { await operation(); count += 1; console.log(`PASS ${name}`); }

await test('Taipei day rolls over independently of the server timezone', () => {
  const { api } = context();
  assert.equal(api.taipeiDate(new Date('2026-10-17T16:00:00Z')), '2026-10-18');
  assert.equal(api.taipeiDate(new Date('2026-10-17T15:59:59Z')), '2026-10-17');
  assert.equal(api.shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(api.shiftDate('2024-03-01', -1), '2024-02-29');
  assert.equal(api.validDate('2026-02-30'), false);
});
await test('direct UCL links retain league, real date and view; invalid inputs fail safely', () => {
  const { api } = context();
  assert.deepEqual(plain(api.readLocation('?league=ucl&date=2026-10-22&view=upcoming')), { league: 'UCL', date: '2026-10-22', view: 'upcoming' });
  assert.deepEqual(plain(api.readLocation('?league=NBA&date=2026-02-30&view=unknown', new Date('2026-10-17T16:00:00Z'))), location);
  assert.equal(api.workspaceUrl({ league: 'UCL', date: '2026-10-22', view: 'upcoming' }), '/soccer?league=UCL&date=2026-10-22&view=upcoming');
  assert.notEqual(api.boardKey(location), api.boardKey({ ...location, league: 'UCL' }));
});
await test('club names translate without changing provider identities or league membership', () => {
  const { api } = context();
  const labels = { Arsenal: '兵工廠', 'Manchester City': '曼城', 'Manchester United': '曼聯', 'Tottenham Hotspur': '熱刺', Liverpool: '利物浦', Chelsea: '切爾西', 'Real Madrid': '皇家馬德里', Barcelona: '巴塞隆納', 'Paris Saint-Germain': '巴黎聖日耳曼', 'Bayern München': '拜仁慕尼黑', 'Borussia Dortmund': '多特蒙德', Internazionale: '國際米蘭', Juventus: '尤文圖斯' };
  for (const [name, expected] of Object.entries(labels)) {
    const team = { id: 'soccer:ucl:team:123', sourceId: '123', name };
    const before = { ...team };
    assert.equal(api.teamName(team), expected);
    assert.equal(api.teamName({ ...team, id: 'soccer:epl:team:123' }), expected);
    assert.deepEqual(team, before);
  }
  assert.equal(api.teamName({ name: 'Inter Miami CF' }), 'Inter Miami CF');
  assert.equal(api.teamName({ name: 'Arsenal de Sarandi', shortName: 'Arsenal' }), 'Arsenal de Sarandi');
  assert.equal(api.teamName({ shortName: 'Arsenal' }), '兵工廠');
  assert.equal(api.teamName({ name: 'Unknown Official Club', shortName: 'Unknown' }), 'Unknown Official Club');
  assert.equal(api.teamName({ name: 'Arsenal', nameZh: '兵工廠' }), '兵工廠');
  assert.equal(api.teamName(null), '隊名尚未提供');
});
await test('scores require active/final status and two actual nonnegative integers', () => {
  const { api } = context();
  const scored = { ...game(), home: { score: 0 }, away: { score: 1 } };
  assert.equal(api.verifiedScore(scored), null);
  assert.equal(api.verifiedScore({ ...scored, status: 'final' }), '0 : 1');
  assert.equal(api.verifiedScore({ ...scored, status: 'live', home: { score: null } }), null);
  assert.equal(api.verifiedScore({ ...scored, status: 'final', away: { score: '1' } }), null);
  assert.equal(api.verifiedScore({ ...scored, status: 'postponed' }), null);
  assert.equal(api.verifiedScore({ ...scored, status: 'live', away: { score: -1 } }), null);
});
await test('source navigation permits HTTPS only', () => {
  const { api } = context();
  assert.equal(api.safeSourceUrl('javascript:alert(1)'), null);
  assert.equal(api.safeSourceUrl('http://example.com'), null);
  assert.equal(api.safeSourceUrl('https://www.espn.com/soccer/'), 'https://www.espn.com/soccer/');
});
await test('HTTP boundary rejects foreign outer league/date/timezone and nested identities', () => {
  const { api } = context();
  for (const wrong of [
    { ...board(), league: { id: 'ucl' } }, { ...board(), date: '2026-10-19' }, { ...board(), timeZone: 'UTC' },
    { ...board(), games: [game('ucl')] }, { ...board(), games: [game('epl', '2026-10-19')] },
    { ...board(), games: [{ ...game(), id: 'soccer:ucl:1' }] }, { ...board(), games: null },
  ]) assert.throws(() => api.validateBoard(wrong, location));
  assert.deepEqual(plain(api.validateBoard(board(), location)), board());
});
await test('standings rejects a foreign-league team inside a valid outer response', () => {
  const { api } = context();
  const args = { ...location, view: 'standings' };
  const valid = { ...board(args), standings: [{ name: 'League', rows: [{ team: { id: 'soccer:epl:team:1' } }] }] };
  assert.ok(api.validateBoard(valid, args));
  assert.throws(() => api.validateBoard({ ...valid, standings: [{ rows: [{ team: { id: 'soccer:ucl:team:1' } }] }] }, args));
  assert.throws(() => api.validateBoard({ ...valid, standings: null }, args));
});
await test('successful empty source data is accepted separately from failed data', () => {
  const { api } = context();
  assert.equal(api.validateBoard({ ...board(), games: [] }, location).games.length, 0);
  assert.throws(() => api.validateBoard({ ...board(), ok: false, games: [] }, location));
  const upcoming = { ...location, view: 'upcoming' };
  assert.equal(api.validateBoard({ ...board(upcoming), games: [game('epl', '2026-10-19')] }, upcoming).games[0].date, '2026-10-19');
});
await test('actual request sends league and date, rejects source errors and expired sessions', async () => {
  let captured;
  const ctx = context({ fetch: async (url, options) => { captured = { url, options }; return { ok: true, status: 200, json: async () => board() }; } });
  const signal = new AbortController().signal;
  assert.deepEqual(plain(await ctx.api.requestBoard(location, signal)), board());
  assert.equal(captured.url, '/api/soccer?league=epl&date=2026-10-18');
  assert.equal(captured.options.signal, signal);
  assert.equal(captured.options.cache, 'no-store');
  ctx.fetch = async () => ({ status: 503, ok: false, json: async () => ({ ok: false, message: 'source unavailable' }) });
  await assert.rejects(ctx.api.requestBoard(location, signal), /source unavailable/);
  ctx.fetch = async () => ({ status: 401, ok: false, json: async () => ({ ok: false }) });
  await assert.rejects(ctx.api.requestBoard(location, signal), /登入已過期/);
});

const effectMarker = source.indexOf('  useEffect(() => {', source.indexOf('  useEffect(() => {') + 1);
const effectCode = `(() => ${blockAt(source.indexOf('{', effectMarker))})()`;
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(initial = {}) {
  const state = { responses: {}, loadingKey: '', failure: null, location, ...initial };
  const calls = []; const history = []; const timers = [];
  const ctx = context({
    ...state, active: true, embedded: false, allRun: null, manualRun: { current: '' }, key: `soccer:${state.location.league}:${state.location.date}:${state.location.view}`, generation: { current: 0 },
    setLoadingKey: value => { state.loadingKey = value; },
    setFailure: value => { state.failure = value; },
    setResponses: update => { state.responses = update(state.responses); },
    setLocation: value => { state.location = value; ctx.location = value; ctx.key = ctx.api.boardKey(value); },
    window: { history: { pushState: (...args) => history.push(args) } },
    setTimeout: callback => { timers.push(callback); return timers.length - 1; }, clearTimeout: () => {},
  });
  ctx.requestBoard = (args, signal) => { const task = deferred(); calls.push({ args, signal, ...task }); return task.promise; };
  return { state, calls, ctx, history, timers, start: () => vm.runInContext(effectCode, ctx) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
await test('actual effect aborts stale requests and rejects out-of-order results after a league switch', async () => {
  const h = harness();
  const cleanup = h.start();
  const next = { ...location, league: 'UCL' };
  h.ctx.api.navigate(next);
  cleanup();
  h.start();
  assert.equal(h.calls[0].signal.aborted, true);
  h.calls[1].resolve(board(next)); await flush();
  h.calls[0].resolve(board()); await flush();
  assert.equal(h.state.responses[h.ctx.api.boardKey(next)].league.id, 'ucl');
  assert.equal(h.state.responses[h.ctx.api.boardKey(location)], undefined);
  assert.equal(h.state.loadingKey, '');
  assert.equal(h.state.failure, null);
});
await test('a date switch retains each successful cached board under its own date and league', async () => {
  const h = harness();
  const cleanup = h.start(); h.calls[0].resolve(board()); await flush();
  const next = { ...location, date: '2026-10-19' }; h.ctx.api.navigate(next); cleanup(); h.start();
  h.calls[1].resolve(board(next)); await flush();
  assert.equal(Object.keys(h.state.responses).length, 2);
  assert.equal(h.state.responses[h.ctx.api.boardKey(location)].date, location.date);
  assert.equal(h.state.responses[h.ctx.api.boardKey(next)].date, next.date);
});
await test('failed refresh preserves prior data and makes retry available', async () => {
  const saved = board(); const key = `soccer:EPL:${location.date}:schedule`;
  const h = harness({ responses: { [key]: saved } });
  h.start(); h.calls[0].reject(new Error('network unavailable')); await flush();
  assert.equal(h.state.responses[key], saved);
  assert.equal(h.state.failure.key, key);
  assert.equal(h.state.failure.message, 'network unavailable');
  assert.equal(h.state.loadingKey, '');
});
await test('timeout exceeds the bounded 32 second source window and releases loading', async () => {
  assert.match(source, /\}, 45_000\);/);
  const h = harness(); h.start(); h.timers[0]();
  assert.equal(h.calls[0].signal.aborted, true);
  h.calls[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); await flush();
  assert.match(h.state.failure.message, /逾時/);
  assert.equal(h.state.loadingKey, '');
});
await test('clicking the current view does not invalidate a running request or add browser history', async () => {
  const h = harness(); h.start();
  const generation = h.ctx.generation.current; h.ctx.api.navigate({ ...location });
  assert.equal(h.ctx.generation.current, generation);
  assert.equal(h.history.length, 0);
  h.calls[0].resolve(board()); await flush();
  assert.ok(h.state.responses[h.ctx.api.boardKey(location)]);
});
await test('page exposes navigation, source evidence, empty/error states and mobile-safe controls', () => {
  assert.match(source, /aria-label="聯盟切換"/);
  assert.match(source, /window\.addEventListener\('popstate'/);
  assert.match(source, /type="date"/);
  assert.match(source, /game\.halfTime\?\.verified === true/);
  assert.match(source, /正式評分驗證中/);
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-busy=\{busy\}/);
  assert.match(source, /當日無賽事/);
  assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.soccerTableWrap\{overflow-x:auto/);
  assert.match(css, /min-height:44px/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(source, /onClick=\{[^\n]*(?:placeBet|recordBet)/);
});
console.log(`Soccer UI: ${count} client boundary, navigation and async regression groups passed.`);
