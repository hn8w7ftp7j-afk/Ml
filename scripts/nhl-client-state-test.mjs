import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { preferNhlWorkspaceRecord, persistNhlWorkspaceResult, readNhlWorkspace } from '../lib/nhl/client-workspace.js';

// Execute the actual client handlers, not copies of their state logic. The
// controlled request promises exercise ordering without a browser/framework.
const source = await readFile(new URL('../app/nhl/page.js', import.meta.url), 'utf8');
function blockAt(start) {
  assert.equal(source[start], '{');
  let depth = 0;
  let quote = null;
  let comment = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (comment === 'line') { if (char === '\n') comment = null; continue; }
    if (comment === 'block') { if (char === '*' && next === '/') { comment = null; index += 1; } continue; }
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') { comment = 'line'; index += 1; continue; }
    if (char === '/' && next === '*') { comment = 'block'; index += 1; continue; }
    if (['"', "'", '`'].includes(char)) { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
    if (char !== '}') continue;
  }
  throw new Error('Client handler extraction failed: unclosed block');
}
function declaration(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `Actual client handler ${name} must exist`);
  // These handlers have plain parameter lists. request's default {} needs
  // the body after the closing parameter list, rather than its first brace.
  const bodyStart = source.indexOf('{', source.indexOf(') {', match.index));
  assert.ok(bodyStart > match.index, `Cannot locate ${name} body`);
  return source.slice(match.index, bodyStart) + blockAt(bodyStart);
}
const handlers = ['run', 'loadSchedule', 'loadGame', 'loadTeam', 'loadPlayer', 'loadContext', 'loadVersions', 'loadResearch', 'loadTeamSummary'];
const historicalMarker = 'onClick={() => { setDate(row.taipeiDate);';
const historicalStart = source.indexOf(historicalMarker);
assert.ok(historicalStart >= 0, 'Historical detail click must be extracted from its actual JSX');
const historicalBody = blockAt(source.indexOf('{', historicalStart + 'onClick={() => '.length));
const hydrateStart = source.indexOf('useEffect(() => {');
assert.ok(hydrateStart >= 0);
const hydrationBody = blockAt(source.indexOf('{', hydrateStart));
const plain = value => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(initial = {}) {
  const state = {
    date: '2026-09-06', busy: {}, error: '', boards: {}, details: {}, rosters: {}, player: null, teamSummaries: {},
    contexts: {}, versions: {}, status: null, selectedGame: null, selectedTeam: null, tab: 'schedule', ready: false,
    ...initial,
  };
  const calls = [];
  const context = {
    preferNhlWorkspaceRecord, persistNhlWorkspaceResult, readNhlWorkspace,
    ...state, inFlight: { current: new Set() }, activePlayerRequest: { current: null }, CACHE: 'test:nhl',
    localStorage: { getItem: () => initial.saved == null ? null : JSON.stringify(initial.saved) },
    request(action, args = {}) {
      const request = deferred();
      calls.push({ action, args, ...request });
      return request.promise;
    },
  };
  for (const key of ['date', 'busy', 'error', 'boards', 'details', 'rosters', 'player', 'contexts', 'versions', 'status', 'selectedGame', 'selectedTeam', 'tab', 'ready', 'teamSummaries']) {
    context[`set${key[0].toUpperCase()}${key.slice(1)}`] = next => {
      state[key] = typeof next === 'function' ? next(state[key]) : next;
      context[key] = state[key];
    };
  }
  context.setResearch = value => { state.research = value; context.research = value; };
  vm.createContext(context);
  vm.runInContext(`${handlers.map(declaration).join('\n')}\nglobalThis.api = {${handlers.join(',')}};`, context);
  return {
    state, calls, api: context.api,
    clickHistory(row, games) { context.row = row; context.research = { games }; vm.runInContext(`(() => ${historicalBody})()`, context); },
    hydrate() { vm.runInContext(`(() => ${hydrationBody})()`, context); },
  };
}

let groups = 0;
async function test(name, operation) { await operation(); groups += 1; console.log(`PASS ${name}`); }
const nhlGame = (id = '2023020001', date = '2023-10-11') => ({ league: 'NHL', gameId: id, taipeiDate: date, source: { fetchedAt: '2026-09-06T00:00:00Z' } });
const playerReply = id => ({ ok: true, league: 'NHL', player: { playerId: id, league: 'NHL' } });

await test('same player double-click coalesces one request and still displays its successful result', async () => {
  const h = harness();
  const first = h.api.loadPlayer(847001);
  const second = h.api.loadPlayer(847001);
  assert.equal(h.calls.length, 1);
  assert.equal(h.state.busy['player:847001'], true);
  h.calls[0].resolve(playerReply(847001));
  await Promise.all([first, second]);
  assert.equal(h.state.player.player.playerId, 847001);
  assert.equal(h.state.error, '');
  assert.equal(h.state.busy['player:847001'], false);
});

await test('A to B to A displays the last selected player for both possible response orders', async () => {
  for (const order of [[1, 0], [0, 1]]) {
    const h = harness();
    const tasks = [h.api.loadPlayer(847001), h.api.loadPlayer(847002), h.api.loadPlayer(847001)];
    assert.equal(h.calls.length, 2);
    for (const index of order) {
      h.calls[index].resolve(playerReply(index ? 847002 : 847001));
      await tasks[index];
    }
    await Promise.all(tasks);
    assert.equal(h.state.player.player.playerId, 847001);
  }
});

await test('switching teams invalidates an outstanding old-player response', async () => {
  const h = harness();
  const player = h.api.loadPlayer(847001);
  const team = h.api.loadTeam({ abbrev: 'NJD', teamId: 1 }, 20262027);
  h.calls[1].resolve({ league: 'NHL', roster: { leagueId: 'NHL', teamId: 1, abbrev: 'NJD', season: 20262027, players: [] } });
  await team;
  h.calls[0].resolve(playerReply(847001));
  await player;
  assert.equal(h.state.player, null);
  assert.equal(h.state.selectedTeam.teamId, 1);
  assert.equal(h.state.tab, 'team');
});

await test('historical viewing preserves a newer live game, full board, source warning and persistence evidence', async () => {
  const sample = nhlGame();
  const live = { league: 'NHL', acquisition: 'OFFICIAL_LIVE_FETCH', game: { ...sample, source: { fetchedAt: '2026-09-06T04:00:00Z' }, playerStatistics: { goalie: 'new evidence' } }, warning: 'partial upstream failure', observation: { persisted: true } };
  const board = { league: 'NHL', date: sample.taipeiDate, games: [sample, nhlGame('2023020002')] };
  const h = harness({ details: { [sample.gameId]: live }, boards: { [sample.taipeiDate]: board } });
  h.clickHistory(sample, [sample]);
  assert.equal(h.state.details[sample.gameId], live);
  assert.equal(h.state.boards[sample.taipeiDate], board);
  assert.equal(h.state.details[sample.gameId].observation.persisted, true);
  assert.equal(h.state.selectedGame, sample.gameId);
  assert.equal(h.state.date, sample.taipeiDate);
});

await test('first historical view carries an explicit archive warning and incomplete-board marker', async () => {
  const sample = nhlGame();
  const h = harness();
  h.clickHistory(sample, [sample, nhlGame('2023020002', '2023-10-12')]);
  assert.equal(h.state.boards[sample.taipeiDate].sampleOnly, true);
  assert.equal(h.state.boards[sample.taipeiDate].games.length, 1);
  assert.equal(h.state.details[sample.gameId].acquisition, 'ARCHIVED_OFFICIAL_HISTORICAL_SAMPLE');
  assert.ok(h.state.details[sample.gameId].warning);
});

await test('date switches keep concurrent responses in their own board and never change selected date', async () => {
  const h = harness({ date: '2026-10-11' });
  const first = h.api.loadSchedule('2026-10-10');
  const second = h.api.loadSchedule('2026-10-11');
  h.calls[1].resolve({ league: 'NHL', date: '2026-10-11', games: [] });
  await second;
  h.calls[0].resolve({ league: 'NHL', date: '2026-10-10', games: [nhlGame('2026020001', '2026-10-10')] });
  await first;
  assert.equal(h.state.date, '2026-10-11');
  assert.equal(h.state.boards['2026-10-10'].games[0].gameId, '2026020001');
  assert.equal(h.state.boards['2026-10-11'].games.length, 0);
});

await test('source failure and mismatched game/date leave previous completed data intact and unlock buttons', async () => {
  const stored = { league: 'NHL', game: nhlGame() };
  const board = { league: 'NHL', date: '2026-09-06', games: [] };
  const h = harness({ details: { '2023020001': stored }, boards: { '2026-09-06': board } });
  const failed = h.api.loadGame('2023020001');
  h.calls[0].reject(new Error('official source timeout'));
  await failed;
  assert.equal(h.state.details['2023020001'], stored);
  assert.equal(h.state.error, 'official source timeout');
  assert.equal(h.state.busy['game:2023020001'], false);
  const wrongGame = h.api.loadGame('2023020001');
  h.calls[1].resolve({ league: 'NHL', game: nhlGame('2023020002') });
  await wrongGame;
  assert.equal(h.state.details['2023020001'], stored);
  const wrongDate = h.api.loadSchedule();
  h.calls[2].resolve({ league: 'NHL', date: '2026-09-05', games: [] });
  await wrongDate;
  assert.equal(h.state.boards['2026-09-06'], board);
  assert.equal(h.state.busy['schedule:2026-09-06'], false);
});

await test('hydration rejects another league nested under an NHL wrapper and wrong game/date keys', async () => {
  const good = nhlGame();
  const baseball = { ...good, league: 'MLB' };
  const h = harness({ saved: { league: 'NHL', date: '2023-10-11', selectedGame: good.gameId, boards: {
    '2023-10-11': { league: 'NHL', date: '2023-10-11', games: [good] },
    '2023-10-12': { league: 'NHL', date: '2023-10-12', games: [{ ...baseball, taipeiDate: '2023-10-12' }] },
    '2023-10-13': { league: 'NHL', date: '2023-10-13', games: [good] },
    '2026-02-30': { league: 'NHL', date: '2026-02-30', games: [] },
  }, details: {
    [good.gameId]: { league: 'NHL', game: good },
    '2023020002': { league: 'NHL', game: { ...baseball, gameId: '2023020002' } },
    '2023020003': { league: 'NHL', game: good },
  } } });
  h.hydrate();
  assert.deepEqual(Object.keys(h.state.boards), ['2023-10-11']);
  assert.deepEqual(Object.keys(h.state.details), [good.gameId]);
  assert.equal(h.state.date, '2023-10-11', 'Returning from another league must reopen the saved historical board');
  assert.equal(h.state.selectedGame, good.gameId, 'The previously selected completed detail remains visible');
  h.calls[0].resolve({ ok: true, league: 'NHL' });
  await h.calls[0].promise;
  assert.equal(h.state.ready, true);
});

function actualRequest(body, status = 200) {
  const context = {
    AbortController, URLSearchParams, setTimeout, clearTimeout,
    fetch: async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }),
  };
  return vm.runInNewContext(`(${declaration('request')})`, context);
}

await test('the actual HTTP boundary rejects failed responses and foreign league envelopes', async () => {
  await assert.rejects(actualRequest({ ok: true, league: 'MLB' })('schedule'), /聯盟識別/);
  await assert.rejects(actualRequest({ ok: false, league: 'NHL', error: 'upstream unavailable' }, 503)('schedule'), /upstream unavailable/);
  await assert.rejects(actualRequest({ ok: false }, 401)('status'), /登入已過期/);
  const body = { ok: true, league: 'NHL', game: nhlGame() };
  assert.deepEqual(plain(await actualRequest(body)('game')), body);
});

await test('team summary duplicate clicks coalesce and out-of-order phases never overwrite another scope', async () => {
  const h = harness(); const team = { teamId: 18, season: 20232024 };
  const regular = h.api.loadTeamSummary(team, 2); h.api.loadTeamSummary(team, 2);
  const preseason = h.api.loadTeamSummary(team, 1); assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ league: 'NHL', ...team, gameType: 1, statistics: null }); await preseason;
  h.calls[0].resolve({ league: 'NHL', ...team, gameType: 2, statistics: { gamesPlayed: 82 } }); await regular;
  assert.equal(h.state.teamSummaries['18:20232024:2'].statistics.gamesPlayed, 82);
  assert.equal(h.state.teamSummaries['18:20232024:1'].statistics, null);
  assert.ok(Object.values(h.state.busy).every(value => value === false));
});
await test('team summary mismatch and failed refresh preserve previous results and release loading', async () => {
  const prior = { league: 'NHL', teamId: 18, season: 20232024, gameType: 2, statistics: { gamesPlayed: 82 } };
  const h = harness({ teamSummaries: { '18:20232024:2': prior } });
  const first = h.api.loadTeamSummary(prior, 2); h.calls[0].resolve({ ...prior, teamId: 10 }); await first;
  assert.equal(h.state.teamSummaries['18:20232024:2'].teamId, 18); assert.match(h.state.error, /不符/);
  const retry = h.api.loadTeamSummary(prior, 2); h.calls[1].reject(new Error('source timeout')); await retry;
  assert.equal(h.state.teamSummaries['18:20232024:2'].statistics.gamesPlayed, 82);
  assert.equal(h.state.busy['team-summary:18:20232024:2'], false);
});
console.log(`NHL client: ${groups} actual-handler async/state regression groups passed.`);
