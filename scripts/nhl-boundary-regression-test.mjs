import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as workspace from '../lib/nhl/client-workspace.js';
import { validateNhlPersonnelObservation, nhlPersonnelFreshness, makeNhlPersonnelObservation } from '../lib/nhl/personnel-observation.js';
import { parseNhlLineupArticle, mergeNhlPersonnelIdentitySources } from '../lib/nhl/personnel-feed.js';

// Deliberately synthetic boundary cases, never presented as official evidence.
// Client cases execute the actual page handlers and real storage merge helper.
const source = await readFile(new URL('../app/nhl/page.js', import.meta.url), 'utf8');
function declaration(name, sourceText = source) {
  const source = sourceText;
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `Actual handler ${name} exists`);
  const start = source.indexOf('{', source.indexOf(') {', match.index));
  let depth = 0; let quote = null; let comment = null;
  for (let i = start; i < source.length; i++) {
    const char = source[i]; const next = source[i + 1];
    if (comment === 'line') { if (char === '\n') comment = null; continue; }
    if (comment === 'block') { if (char === '*' && next === '/') { comment = null; i++; } continue; }
    if (quote) { if (char === '\\') i++; else if (char === quote) quote = null; continue; }
    if (char === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (char === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (['"', "'", '`'].includes(char)) { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error(`Unclosed handler ${name}`);
}
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function harness(initial = {}) {
  const state = { busy: {}, error: '', details: {}, player: null, versions: {}, selectedGame: null, ...initial };
  const calls = []; const localStorage = storage(); let mounted = true;
  const context = { ...workspace, ...state, inFlight: { current: new Set() }, activePlayerRequest: { current: null },
    localStorage, persistNhlWorkspaceResult(section, key, value) {
      assert.equal(workspace.validNhlWorkspaceRecord(section, key, value), true);
      workspace.saveNhlWorkspace({ [section]: { [key]: value } }, localStorage);
    },
    request(action, args) {
      let resolve; let reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      calls.push({ action, args, resolve, reject }); return promise;
    },
  };
  for (const key of Object.keys(state)) context[`set${key[0].toUpperCase()}${key.slice(1)}`] = next => {
    if (!mounted) return;
    state[key] = typeof next === 'function' ? next(state[key]) : next; context[key] = state[key];
  };
  const names = ['run', 'loadGame', 'loadPlayer', 'loadVersions'];
  vm.createContext(context);
  vm.runInContext(`${names.map(name => declaration(name)).join('\n')}\nglobalThis.api = {${names.join(',')}};`, context);
  return { state, calls, localStorage, api: context.api, unmount: () => { mounted = false; } };
}
let passed = 0; const failures = [];
async function test(name, operation) {
  try { await operation(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error }); console.error(`FAIL ${name}: ${error.message}`); }
}
const gameId = '2023020001';
const detail = (fetchedAt = '2026-09-06T14:00:00Z', acquisition = 'OFFICIAL_LIVE_FETCH') => ({ league: 'NHL', acquisition,
  game: { league: 'NHL', leagueId: 'NHL', gameId, taipeiDate: '2023-10-11', source: { fetchedAt } } });

await test('mismatched player ID and nested foreign league cannot replace the selected player', async () => {
  for (const player of [{ playerId: 8470002, leagueId: 'NHL' }, { playerId: 8470001, leagueId: 'NBA' }, { playerId: 8470001, league: 'MLB', leagueId: 'NHL' }]) {
    const prior = { league: 'NHL', player: { playerId: 8470000, leagueId: 'NHL' } };
    const h = harness({ player: prior }); const task = h.api.loadPlayer(8470001);
    h.calls[0].resolve({ league: 'NHL', player }); await task;
    assert.equal(h.state.player, prior); assert.ok(h.state.error); assert.equal(h.state.busy['player:8470001'], false);
  }
});
await test('version responses verify requested game and every stored payload before rendering', async () => {
  for (const result of [
    { league: 'NHL', gameId: '2023020002', versions: [] },
    { league: 'NHL', gameId, versions: [{ league: 'NHL', game: { league: 'NHL', gameId: '2023020002' } }] },
    { league: 'NHL', gameId, versions: [{ league: 'NBA', game: { league: 'NBA', gameId } }] },
  ]) {
    const prior = [{ revision: 'previous' }]; const h = harness({ versions: { [gameId]: prior } });
    const task = h.api.loadVersions(gameId); h.calls[0].resolve(result); await task;
    assert.equal(h.state.versions[gameId], prior); assert.ok(h.state.error); assert.equal(h.state.busy[`versions:${gameId}`], false);
  }
});
await test('older live or archived response never downgrades a newer completed game', async () => {
  for (const result of [detail('2026-09-06T13:00:00Z'), detail('2026-09-06T15:00:00Z', 'ARCHIVED_OFFICIAL_HISTORICAL_SAMPLE')]) {
    const prior = detail(); const h = harness({ details: { [gameId]: prior } });
    const task = h.api.loadGame(gameId); h.calls[0].resolve(result); await task;
    assert.equal(h.state.details[gameId], prior); assert.equal(h.state.busy[`game:${gameId}`], false);
  }
});
await test('a game finishing after component departure persists without relying on React setters', async () => {
  const h = harness(); const result = detail(); const task = h.api.loadGame(gameId);
  h.unmount(); h.calls[0].resolve(result); await task;
  const saved = workspace.readNhlWorkspace(h.localStorage);
  assert.equal(saved.details[gameId]?.game.gameId, gameId);
  assert.equal(saved.details[gameId]?.game.source.fetchedAt, result.game.source.fetchedAt);
});
await test('late completion merges durable display data without changing another selected day or NHL scope', async () => {
  const store = storage();
  workspace.saveNhlWorkspace({ date: '2026-09-07', selectedGame: null, boards: { '2026-09-07': { league: 'NHL', date: '2026-09-07', games: [] } } }, store);
  workspace.saveNhlWorkspace({ details: { [gameId]: detail() } }, store);
  const saved = workspace.readNhlWorkspace(store);
  assert.equal(saved.date, '2026-09-07'); assert.equal(saved.selectedGame, null);
  assert.equal(saved.details[gameId].game.league, 'NHL'); assert.equal(saved.boards['2026-09-07'].games.length, 0);
  const corrupted = workspace.mergeNhlWorkspace(saved, { details: { [gameId]: { ...detail(), game: { ...detail().game, league: 'NBA' } } } });
  assert.equal(corrupted.details[gameId].game.league, 'NHL');
});

await test('every existing league and leagueId must agree across persisted NHL display boundaries', async () => {
  const mixedGame = { ...detail().game, leagueId: 'NBA' };
  const cases = [
    ['details', gameId, { ...detail(), leagueId: 'MLB' }],
    ['details', gameId, { ...detail(), game: mixedGame }],
    ['boards', '2023-10-11', { league: 'NHL', date: '2023-10-11', games: [mixedGame] }],
    ['personnel', gameId, { league: 'NHL', gameId, personnel: { leagueId: 'NHL', league: 'NBA', gameId } }],
    ['rosters', 'NSH:20232024', { league: 'NHL', roster: { leagueId: 'NHL', league: 'MLB', abbrev: 'NSH', season: 20232024, players: [] } }],
    ['rosters', 'NSH:20232024', { league: 'NHL', roster: { leagueId: 'NHL', teamId: 18, abbrev: 'NSH', season: 20232024,
      players: [{ leagueId: 'NHL', league: 'KBO', playerId: 847001, teamId: 18 }] } }],
    ['shotResearch', gameId, { league: 'NHL', gameId, research: { league: 'NHL', leagueId: 'NBA', pregameModel: false, game: detail().game } }],
    ['shotResearch', gameId, { league: 'NHL', gameId, research: { leagueId: 'NHL', pregameModel: false, game: mixedGame } }],
  ];
  for (const [section, key, value] of cases) assert.equal(workspace.validNhlWorkspaceRecord(section, key, value), false, section);
  assert.equal(workspace.validNhlWorkspaceRecord('details', gameId, detail()), true);
});

const observedAt = '2026-09-06T14:00:00Z'; const now = Date.parse('2026-09-06T14:05:00Z');
const articleSource = { provider: 'NHL_EDITORIAL', url: 'https://www.nhl.com/news/synthetic-boundary-test',
  sourcePublishedAt: '2025-09-01T00:00:00Z', sourceUpdatedAt: '2026-09-06T13:55:00Z',
  availableAt: '2026-09-06T13:55:00Z', observedAt, fetchedAt: observedAt, contentHash: 'a'.repeat(64) };
function personnelPayload() {
  const gameIdentity = { league: 'NHL', leagueId: 'NHL', gameId: '2026020001', season: 20262027, gameType: 2,
    startTimeUTC: '2026-09-06T18:00:00Z', awayTeamId: 1, homeTeamId: 2, awayAbbrev: 'NJD', homeAbbrev: 'NYI' };
  const teams = {}; const players = [];
  for (const side of ['away', 'home']) {
    const teamId = gameIdentity[`${side}TeamId`]; const abbrev = gameIdentity[`${side}Abbrev`];
    const makePlayer = (offset, position) => ({ playerId: 8470000 + teamId * 100 + offset, teamId, name: `Synthetic ${side} ${offset}`, position,
      sourceUrl: articleSource.url, sourcePublishedAt: articleSource.sourcePublishedAt, sourceUpdatedAt: articleSource.sourceUpdatedAt,
      availableAt: articleSource.availableAt, observedAt, source: structuredClone(articleSource),
      membershipBasis: 'OFFICIAL_SEASON_ROSTER_AND_ARTICLE_TEAM_BLOCK',
      identitySources: [{ provider: 'NHL', url: `https://api-web.nhle.com/v1/roster/${abbrev}/20262027`, fetchedAt: observedAt, contentHash: 'b'.repeat(64) }] });
    const lines = [[makePlayer(1, 'C'), makePlayer(2, 'L'), makePlayer(3, 'R')]];
    const pairs = [[makePlayer(4, 'D'), makePlayer(5, 'D')]]; const listedGoalies = [makePlayer(6, 'G'), makePlayer(7, 'G')];
    const goalie = { ...listedGoalies[0], gameId: gameIdentity.gameId, side, status: 'PROJECTED', confirmationExplicit: false };
    teams[side] = { teamId, lineupStatus: 'PROJECTED', lineCombinations: lines, defensivePairings: pairs, listedGoalies,
      injuries: [], scratched: [], goalie, issues: [], warnings: [], unresolvedAvailability: [] };
    players.push(...lines.flat(), ...pairs.flat(), ...listedGoalies);
  }
  return { league: 'NHL', gameId: gameIdentity.gameId, observedAt: new Date(observedAt).toISOString(), gameIdentity, personnel: { league: 'NHL', leagueId: 'NHL',
    gameId: gameIdentity.gameId, ok: true, matched: true, qa: { status: 'WARNING' }, revision: 'c'.repeat(64),
    source: structuredClone(articleSource), teams, players, goalies: { away: teams.away.goalie, home: teams.home.goalie }, pointInTimeEligible: true } };
}
await test('personnel source freshness uses article revision, not original publication or a new fetch', async () => {
  const value = personnelPayload(); value.personnel.freshness = { maxAgeMs: 15 * 60_000 };
  assert.equal(validateNhlPersonnelObservation(value, value.gameId, { now }).ok, true);
  assert.equal(nhlPersonnelFreshness(value.personnel, now).fresh, true);
  assert.equal(nhlPersonnelFreshness(value.personnel, now + 20 * 60_000).fresh, false);
  value.personnel.source.observedAt = '2026-09-06T14:25:00Z';
  assert.equal(nhlPersonnelFreshness(value.personnel, now + 20 * 60_000).fresh, false);
});
await test('personnel deep membership, goalie evidence and source chronology reject corrupt counterexamples', async () => {
  const mutations = [
    p => { p.personnel.teams.away.lineCombinations[0][0] = structuredClone(p.personnel.players.find(row => row.teamId === 2)); },
    p => { p.personnel.teams.away.defensivePairings = [{}]; },
    p => { p.personnel.teams.away.listedGoalies = {}; },
    p => { p.personnel.players[0] = null; },
    p => { p.personnel.goalies.away = { ...p.personnel.goalies.away, playerId: 8470999 }; },
    p => { p.personnel.goalies.away.sourceUrl = 'https://attacker.example'; },
    p => { p.personnel.source.availableAt = '2026-09-06T13:56:00Z'; },
    p => { p.personnel.source.sourceUpdatedAt = '2024-09-01T00:00:00Z'; },
    p => { p.personnel.players[0].identitySources[0].url = 'https://api-web.nhle.com/v1/roster/NYI/20262027'; },
    p => { p.personnel.players[0].identitySources[0].fetchedAt = '2026-09-06T18:30:00Z'; },
    p => { p.personnel.players.push(structuredClone(p.personnel.players[0])); },
    p => { p.personnel.teams.away.lineupStatus = 'BLOCK'; },
  ];
  for (const mutate of mutations) {
    const payload = personnelPayload(); mutate(payload);
    assert.equal(validateNhlPersonnelObservation(payload, payload.gameId, { now }).ok, false, mutate.toString());
  }
});
await test('unresolved availability remains visibly quarantined without discarding valid lines', async () => {
  const payload = personnelPayload(); payload.personnel.qa.status = 'BLOCK'; payload.personnel.status = 'PARTIAL';
  payload.personnel.teams.away.unresolvedAvailability = [{ name: 'Unresolved synthetic spelling', category: 'injuries', status: 'IDENTITY_UNRESOLVED', reason: 'source text' }];
  assert.equal(validateNhlPersonnelObservation(payload, payload.gameId, { now }).ok, true);
  assert.equal(payload.personnel.qa.status, 'BLOCK'); assert.equal(payload.personnel.players.some(row => row.name === 'Unresolved synthetic spelling'), false);
});

await test('personnel observation completes after the last identity proof without rewriting article time', async () => {
  const payload = personnelPayload();
  const later = '2026-09-06T14:03:00.000Z';
  payload.personnel.players[0].identitySources[0].fetchedAt = later;
  assert.equal(validateNhlPersonnelObservation(payload, payload.gameId, { now }).ok, false, 'Article acquisition is not the complete record acquisition');
  const completed = makeNhlPersonnelObservation(payload.gameIdentity, payload.personnel, { now });
  assert.equal(completed.observedAt, later);
  assert.equal(completed.personnel.source.observedAt, observedAt);
  assert.equal(validateNhlPersonnelObservation(completed, completed.gameId, { now }).ok, true);
  assert.equal(completed.personnel.players[0].identitySources[0].fetchedAt, later);
});

await test('official factual article extract passes the deep persistence contract without claiming a PIT archive', async () => {
  const facts = JSON.parse(await readFile(new URL('./fixtures/nhl/personnel-official-20260614-facts.json', import.meta.url), 'utf8'));
  const parserTest = await readFile(new URL('./nhl-personnel-feed-test.mjs', import.meta.url), 'utf8');
  const fixtureContext = { facts, mergeNhlPersonnelIdentitySources, esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
  // Reuse the explicit factual-extract fixture builder; the constructed HTML
  // is not relabelled as an archived raw article or acquisition-time evidence.
  vm.createContext(fixtureContext);
  vm.runInContext(`${declaration('article', parserTest)}\n${declaration('identities', parserTest)}\nglobalThis.fixture = {html: article(), rosters: identities()};`, fixtureContext);
  const acquired = Date.parse('2026-09-06T20:00:00Z');
  const parsed = parseNhlLineupArticle(fixtureContext.fixture.html, { game: facts.game, rosters: fixtureContext.fixture.rosters,
    sourceUrl: facts.sourceUrl, observedAt: new Date(acquired).toISOString(), now: acquired });
  const payload = makeNhlPersonnelObservation(facts.game, parsed, { now: acquired });
  assert.equal(validateNhlPersonnelObservation(payload, facts.game.gameId, { now: acquired }).ok, true);
  assert.equal(parsed.pointInTimeEligible, false); assert.equal(parsed.status, 'PARTIAL'); assert.equal(parsed.qa.status, 'BLOCK');
  assert.equal(parsed.teams.away.lineCombinations.length + parsed.teams.home.lineCombinations.length, 8);
  assert.equal(parsed.goalies.away.status, 'PROJECTED'); assert.equal(parsed.goalies.home.status, 'PROJECTED');
  assert.equal(parsed.teams.home.unresolvedAvailability.length, 3);
  assert.equal(facts.fixtureKind, 'FACTUAL_EXTRACT_NOT_RAW_ARTICLE_OR_PREGAME_ARCHIVE');
});

console.log(`NHL boundary regression: ${passed} groups passed; ${failures.length} failed. Synthetic cases are not Production or real-device verification.`);
if (failures.length) process.exitCode = 1;
