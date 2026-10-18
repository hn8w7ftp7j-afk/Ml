// Behavioral tests for the shipped soccer service, durable job route and workflow.
// ESPN responses are retained source fixtures; durable writes use isolated PostgreSQL.
// This never calls Production or enables formal soccer recommendations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { register } from 'node:module';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

register('./next-route-test-loader.mjs', import.meta.url);
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const stripImports = source => source.replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
const fixture = name => JSON.parse(read(`scripts/fixtures/soccer/${name}.json`));
const summaries = { epl: fixture('epl-summary'), ucl: fixture('ucl-summary') };
const at = '2026-10-18T13:35:00.000Z', now = Date.parse(at);
const source = { provider: 'ESPN', fetchedAt: at, url: 'https://fixture.invalid', contentHash: 'retained-provider-response' };
const games = Object.fromEntries(Object.entries(summaries).map(([league, value]) => {
  const competition = value.header.competitions[0];
  const board = normalizeSoccerSchedule({ leagues: [value.header.league], events: [{ ...value.header, date: competition.date, status: competition.status }] }, league, source);
  assert.equal(board.ok, true);
  return [league, board.games[0]];
}));
const queryFor = league => ({ league, date: games[league].date, eventId: games[league].sourceId });
const taskFor = league => {
  const game = games[league], id = league.toUpperCase();
  return { league: id, soccerQuery: queryFor(league), game: {
    id: game.id, sourceId: game.sourceId, gamePk: Number(game.sourceId), league: id, leagueId: id,
    date: game.date, startTime: game.startTime, gameDate: game.startTime,
    homeTeamId: game.home.sourceId, awayTeamId: game.away.sourceId,
  } };
};
const database = await soccerSqlFixture(), { db } = database;
const { analyzeSoccerGame, loadSoccerCurrentAnalysis } = await import('../lib/soccer/analysis-service.js');
const { normalizeSoccerAnalysisTasks, analyzeSoccerJobTask } = await import('../lib/soccer/analysis-job.js');
const { ANALYSIS_LEAGUE_IDS, ACTIVE_ANALYSIS_LEAGUE_IDS, analysisBatchScope, isAnalysisLeagueId, isSoccerAnalysisLeague } = await import('../lib/analysis-leagues.js');
const { normalizeNbaAnalysisTasks } = await import('../lib/nba/analysis-job.js');
const { normalizeNhlAnalysisTasks } = await import('../lib/nhl/analysis-job.js');
const { createAnalysisJobProgress } = await import('../lib/analysis-job-progress.js');
const normalized = {};
for (const league of ['epl', 'ucl']) {
  const id = league.toUpperCase(), task = taskFor(league);
  normalized[league] = normalizeSoccerAnalysisTasks([{ ...task,
    settings: { rebateRate: 1, candidateThreshold: -999 }, score: 999, executable: true,
    actualMarkets: [{ line: '999', water: 99 }], body: { league: 'MLB', settings: { rebateRate: 1 } },
    game: { ...task.game, score: 999, executable: true, prediction: { home: 99 }, settings: { rebateRate: 1 } },
  }], task.game.date, id)[0];
  assert.deepEqual(Object.keys(normalized[league]).sort(), ['game', 'league', 'soccerQuery']);
  assert.deepEqual(normalized[league].soccerQuery, task.soccerQuery);
  for (const key of ['settings', 'score', 'executable', 'prediction', 'actualMarkets', 'body']) assert.equal(Object.hasOwn(normalized[league].game, key), false);
  assert.equal(normalized[league].game.gamePk, Number(task.soccerQuery.eventId));
  for (const input of [
    { ...task, league: league === 'epl' ? 'UCL' : 'EPL' },
    { ...task, game: { ...task.game, gamePk: task.game.gamePk + 1 } },
    { ...task, game: { ...task.game, id: `soccer:${league}:999` } },
    { ...task, game: { ...task.game, leagueId: 'MLB' } },
    { ...task, game: { ...task.game, startTime: '2026-10-18T13:35:00' } },
    { ...task, soccerQuery: { ...task.soccerQuery, date: '2026-02-30' } },
    { ...task, soccerQuery: { ...task.soccerQuery, settings: { rebateRate: 1 } } },
    { ...task, soccerQuery: { ...task.soccerQuery, league: league === 'epl' ? 'ucl' : 'epl' } },
    { ...task, soccerQuery: { ...task.soccerQuery, eventId: '9007199254740993' }, game: { ...task.game, id: `soccer:${league}:9007199254740993`, sourceId: '9007199254740993', gamePk: Number('9007199254740993') } },
  ]) assert.throws(() => normalizeSoccerAnalysisTasks([input], task.game.date, id));
  assert.throws(() => normalizeSoccerAnalysisTasks([task, task], task.game.date, id), undefined, 'one event cannot run twice in the same batch');
  assert.throws(() => normalizeSoccerAnalysisTasks([task], '2026-02-30', id));
}
assert.ok(ACTIVE_ANALYSIS_LEAGUE_IDS.includes('EPL') && ACTIVE_ANALYSIS_LEAGUE_IDS.includes('UCL'));
assert.equal(ACTIVE_ANALYSIS_LEAGUE_IDS.includes('NHL'), false);
console.log('PASS soccer job input: exact league/date/event/team scope, safe numeric progress identities, duplicate rejection and stripped client scores, prices, settings and execution flags');

const envKeys = ['DATABASE_URL', 'DATABASE_V2_URL'];
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const oldFetch = globalThis.fetch, oldNow = Date.now;
const snapshots = {};
try {
  process.env.DATABASE_URL = 'postgres://fixture.invalid/soccer-jobs';
  delete process.env.DATABASE_V2_URL;
  Date.now = () => now;
  const calls = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input)); calls.push(url.href);
    assert.equal(url.origin, 'https://site.api.espn.com');
    assert.match(url.pathname, /^\/apis\/site\/v2\/sports\/soccer\//);
    if (url.pathname.includes('/all/teams/')) return Response.json({}, { status: 503 });
    const league = url.pathname.includes('/eng.1/') ? 'epl' : url.pathname.includes('/uefa.champions/') ? 'ucl' : null;
    assert.ok(league, url.href);
    const value = summaries[league], competition = value.header.competitions[0];
    if (url.pathname.endsWith('/summary')) {
      assert.equal(url.searchParams.get('event'), value.header.id);
      return Response.json(value);
    }
    assert.ok(url.pathname.endsWith('/scoreboard'), url.href);
    return Response.json({ leagues: [value.header.league], events: [{ ...value.header, date: competition.date, status: competition.status }] });
  };
  const count = async table => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  for (const league of ['epl', 'ucl']) {
    const response = await analyzeSoccerGame(queryFor(league));
    assert.equal(response.status, 200, JSON.stringify(response.payload));
    const payload = response.payload; snapshots[league] = payload;
    assert.equal(payload.gameId, games[league].id); assert.equal(payload.league, league);
    assert.equal(payload.date, games[league].date); assert.equal(payload.analysisStatus, 'COMPLETED');
    assert.equal(payload.persisted, true); assert.equal(payload.journalPersisted, true);
    assert.equal(payload.selectionResult, 'RESEARCH_SHADOW'); assert.equal(payload.executable, false);
    assert.equal(payload.formalScoringEnabled, false); assert.equal(payload.directions.length, 8);
    assert.ok(payload.directions.every(direction => direction.executable === false && direction.eligible === false && direction.score === null && direction.W === null && direction.R === null));
    assert.equal(payload.prediction.status, 'RESEARCH_ONLY');
    const saved = (await db.query('SELECT league,game_id,payload FROM sports_soccer_analysis_v1 WHERE league=$1', [league])).rows;
    assert.equal(saved.length, 1); assert.equal(saved[0].game_id, games[league].id);
    assert.equal(saved[0].payload.analysisRunId, payload.analysisRunId);
    const events = (await db.query('SELECT e.analysis_status,e.selection_result FROM sports_soccer_analysis_events_v2 e JOIN sports_soccer_analysis_runs_v2 r USING(run_id) WHERE r.league=$1', [league])).rows;
    assert.deepEqual(events, [{ analysis_status: 'COMPLETED', selection_result: 'RESEARCH_SHADOW' }]);
  }
  assert.equal(await count('sports_soccer_analysis_v1'), 2);
  assert.equal(await count('sports_soccer_analysis_runs_v2'), 2);
  assert.ok(await count('sports_soccer_cohort_v2') >= 2);
  // The retained fixture cutoff is deliberately historical. Give its existing
  // terminal receipt a current expiry to exercise the actual qualified-head
  // SQL without replacing PostgreSQL's clock or fabricating a second snapshot.
  const { finishSoccerAnalysisRun } = await import('../lib/soccer/journal.js');
  const savedEpl = snapshots.epl;
  await finishSoccerAnalysisRun({ runId: savedEpl.analysisRunId, league: 'epl', date: savedEpl.date, gameId: savedEpl.gameId,
    startedAt: savedEpl.runStartedAt, requestSeq: savedEpl.qualificationVersion, quoteGeneration: savedEpl.quoteGeneration }, {
    analysisStatus: savedEpl.analysisStatus, qaFlag: savedEpl.qaFlag, selectionResult: savedEpl.selectionResult,
    revision: savedEpl.revision, validUntil: new Date(oldNow() + 60000).toISOString(), reasons: [],
  });
  const recovered = await loadSoccerCurrentAnalysis('epl', savedEpl.date, games.epl.sourceId);
  assert.equal(recovered.currentVersion.gameId, games.epl.id);
  assert.equal(recovered.currentVersion.publishedCurrent, true);
  assert.equal(recovered.currentRun.analysisRunId, savedEpl.analysisRunId);
  assert.equal((await loadSoccerCurrentAnalysis('ucl', savedEpl.date, games.epl.sourceId)).currentVersion, null);
  assert.equal(recovered.currentVersion.executable, false);
  const noSource = await analyzeSoccerGame(queryFor('epl'), { fetchSoccerSchedule: async () => ({ ok: false, code: 'CONTROLLED_SOURCE_FAILURE' }) });
  assert.equal(noSource.status, 503); assert.equal(noSource.payload.analysisStatus, 'INSUFFICIENT_DATA');
  assert.equal(noSource.payload.journalPersisted, true); assert.equal(noSource.payload.selectionResult, null);
  assert.equal((await loadSoccerCurrentAnalysis('epl', savedEpl.date, games.epl.sourceId)).currentVersion, null, 'a newer failed run cannot restore an older completed snapshot as current');
  const missing = await analyzeSoccerGame(queryFor('epl'), { fetchSoccerSchedule: async () => ({ ok: true, games: [] }) });
  assert.equal(missing.status, 404); assert.equal(missing.payload.journalPersisted, true);
  const badEvidence = await analyzeSoccerGame(queryFor('epl'), { fetchSoccerPrematch: async () => ({ ok: false, code: 'CONTROLLED_IDENTITY_FAILURE' }) });
  assert.equal(badEvidence.status, 503); assert.equal(badEvidence.payload.journalPersisted, true);
  const failedSave = await analyzeSoccerGame(queryFor('epl'), { saveSoccerAnalysis: async () => { throw Error('controlled durable store outage'); } });
  assert.equal(failedSave.status, 503); assert.equal(failedSave.payload.analysisStatus, 'FAILED');
  assert.equal(failedSave.payload.journalPersisted, true); assert.equal(failedSave.payload.publishedCurrent, false);
  assert.equal(await count('sports_soccer_analysis_v1'), 2, 'failed sources or durable save cannot claim or insert a successful snapshot');
  const terminal = (await db.query('SELECT analysis_status,qa_flag,selection_result FROM sports_soccer_analysis_events_v2 ORDER BY finished_at')).rows;
  assert.equal(terminal.filter(row => row.analysis_status === 'INSUFFICIENT_DATA').length, 3);
  assert.equal(terminal.filter(row => row.analysis_status === 'FAILED').length, 1);
  assert.ok(terminal.filter(row => row.analysis_status !== 'COMPLETED').every(row => row.qa_flag === 'BLOCKED' && row.selection_result === null));
  const optional = await analyzeSoccerGame(queryFor('epl'), {
    fetchSoccerWorkload: async () => { throw Error('optional workload unavailable'); },
    loadSoccerReaderSnapshot: async () => { throw Error('reader unavailable'); },
  });
  assert.equal(optional.status, 200); assert.equal(optional.payload.persisted, true);
  assert.equal(optional.payload.journalPersisted, true); assert.equal(optional.payload.readerUnavailable, true);
  assert.equal(optional.payload.evidence.workload.ok, false); assert.equal(optional.payload.executable, false);
  const unrecorded = await analyzeSoccerGame(queryFor('epl'), { beginSoccerAnalysisRun: async () => { throw Error('journal offline'); } });
  assert.equal(unrecorded.status, 503); assert.equal(unrecorded.payload.journalPersisted, false);
  let unexpectedBegin = 0;
  for (const query of [{ league: 'nhl', date: games.epl.date, eventId: games.epl.sourceId }, { ...queryFor('epl'), date: '2026-02-30' }, { ...queryFor('epl'), eventId: '../1' }, { ...queryFor('epl'), settings: {} }]) {
    const rejected = await analyzeSoccerGame(query, { beginSoccerAnalysisRun: async () => { unexpectedBegin++; throw Error('must not begin'); } });
    assert.equal(rejected.status, 400);
  }
  assert.equal(unexpectedBegin, 0);
  assert.ok(calls.length > 0);
  console.log('PASS shipped soccer service + PostgreSQL: retained EPL/UCL provider fixtures, immutable per-league snapshots, journal/cohort receipts, honest terminal failures and optional-source isolation');
} finally {
  globalThis.fetch = oldFetch; Date.now = oldNow;
  for (const key of envKeys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
  await database.close();
}

for (const league of ['epl', 'ucl']) {
  const task = normalized[league], payload = snapshots[league];
  const result = await analyzeSoccerJobTask(task, async query => { assert.deepEqual(query, task.soccerQuery); return { status: 200, payload }; });
  assert.equal(result.ok, true); assert.equal(result.research, true); assert.equal(result.saved, true);
  assert.equal(result.blocked, false); assert.equal(result.payload.executable, false);
  for (const flags of [{ persisted: false }, { journalPersisted: false }]) {
    const unsaved = await analyzeSoccerJobTask(task, async () => ({ status: 200, payload: { ...payload, ...flags } }));
    assert.equal(unsaved.saved, false, 'saving requires both durable snapshot and journal receipts');
  }
  const insufficient = await analyzeSoccerJobTask(task, async () => ({ status: 503, payload: { ...payload, ok: false, analysisStatus: 'INSUFFICIENT_DATA', selectionResult: null, prediction: null } }));
  assert.equal(insufficient.ok, false); assert.equal(insufficient.status, 422); assert.equal(insufficient.blocked, true); assert.equal(insufficient.research, false);
  const failed = await analyzeSoccerJobTask(task, async () => ({ status: 503, payload: {
    ok: false, analysisStatus: 'FAILED', code: 'SOCCER_ANALYSIS_OR_STORAGE_FAILED', journalPersisted: true,
    formalScoringEnabled: false, executable: false,
  } }));
  assert.equal(failed.ok, false); assert.equal(failed.status, 503); assert.equal(failed.blocked, false);
  assert.equal(failed.research, false); assert.equal(failed.saved, false);
  const missing = await analyzeSoccerJobTask(task, async () => ({ status: 503, payload: {
    ok: false, analysisStatus: 'INSUFFICIENT_DATA', code: 'SOCCER_SOURCE_UNAVAILABLE', journalPersisted: true,
    formalScoringEnabled: false, executable: false,
  } }));
  assert.equal(missing.status, 422); assert.equal(missing.blocked, true, 'a source insufficiency remains a data block even without identity/directions');
  for (const patch of [
    { league: league === 'epl' ? 'ucl' : 'epl' }, { gameId: `soccer:${league}:999` }, { date: '2026-02-30' },
    { executable: true }, { formalScoringEnabled: true },
    { directions: payload.directions.map((direction, index) => index ? direction : { ...direction, eligible: true }) },
    { directions: payload.directions.map((direction, index) => index ? direction : { ...direction, executable: true }) },
    { directions: payload.directions.map((direction, index) => index ? direction : { ...direction, score: 9 }) },
  ]) {
    const rejected = await analyzeSoccerJobTask(task, async () => ({ status: 200, payload: { ...payload, ...patch } }));
    assert.equal(rejected.ok, false, JSON.stringify(patch)); assert.equal(rejected.research, false); assert.equal(rejected.saved, false); assert.equal(rejected.blocked, true);
  }
}
console.log('PASS soccer job output: exact server identity, eight non-executable research directions, blocked insufficient data and dual durable save receipts');

// Execute the shipped route with real normalizers and isolated workflow/storage adapters.
const submitted = []; let authorized = true, sameOrigin = true;
const finished = { mode: 'all-leagues', date: games.epl.date, batches: [{ league: 'EPL', date: games.epl.date, total: 1, completed: 1,
  results: [{ ok: true, status: 200, research: true, saved: true, blocked: false, payload: snapshots.epl, task: normalized.epl }] }] };
const route = vm.createContext({ Request, Response, URL, NextResponse: Response, crypto: globalThis.crypto, Date, console: { info() {} },
  cleanText: (value, max = 1000) => String(value || '').slice(0, max), isAnalysisLeagueId, isSoccerAnalysisLeague, ANALYSIS_LEAGUE_IDS, analysisBatchScope,
  normalizeSoccerAnalysisTasks, normalizeNbaAnalysisTasks, normalizeNhlAnalysisTasks,
  requireApiAuth: async () => authorized ? null : Response.json({}, { status: 401 }), validateSameOrigin: () => sameOrigin,
  originErrorResponse: () => Response.json({}, { status: 403 }), checkRateLimit: () => ({ allowed: true }),
  validAnalysisJobRequestKey: () => false, readJsonBody: request => request.json(), deviceHash: () => null, readCookie: () => '', PUSH_COOKIE: 'unused',
  analyzeAllLeaguesWorkflow: 'all', analyzeBoardWorkflow: 'one',
  start: async (workflow, input) => { submitted.push({ workflow, input: input[0] }); return { runId: 'run-soccer-fixture' }; },
  failAnalysisJobRequest: async () => {}, getRun: () => ({ exists: true, status: 'completed', returnValue: finished }),
});
vm.runInContext(stripImports(read('app/api/analysis-jobs/route.js')) + '\nthis.post=POST;this.get=GET;', route);
const post = body => route.post(new Request('https://fixture.invalid/api/analysis-jobs', { method: 'POST', body: JSON.stringify(body) }));
for (const league of ['epl', 'ucl']) {
  const task = normalized[league];
  const result = await post({ league: league.toUpperCase(), date: task.game.date, tasks: [task] });
  assert.equal(result.status, 202, JSON.stringify(await result.clone().json()));
  assert.equal(submitted.at(-1).input.tasks[0].league, league.toUpperCase());
  assert.deepEqual(submitted.at(-1).input.tasks[0].soccerQuery, task.soccerQuery);
  assert.equal(Object.hasOwn(submitted.at(-1).input.tasks[0], 'body'), false, 'soccer never receives the baseball settings/body');
}
const batches = ANALYSIS_LEAGUE_IDS.map(league => ({ league, date: games.epl.date, tasks: league === 'EPL' ? [normalized.epl] : [], emptyReason: league === 'EPL' ? null : 'no_games' }));
assert.equal((await post({ mode: 'all-leagues', date: games.epl.date, requestedLeagues: ANALYSIS_LEAGUE_IDS, batches })).status, 202);
assert.equal(submitted.at(-1).input.batches.length, ANALYSIS_LEAGUE_IDS.length);
assert.deepEqual(Array.from(submitted.at(-1).input.batches, batch => batch.league), ['NBA', 'EPL', 'UCL', 'NHL', 'MLB', 'NPB', 'KBO', 'CPBL'], 'soccer runs before slow baseball work while existing non-soccer order remains stable');
const activeBatches = batches.filter(batch => ACTIVE_ANALYSIS_LEAGUE_IDS.includes(batch.league));
assert.equal((await post({ mode: 'all-leagues', date: games.epl.date, requestedLeagues: ACTIVE_ANALYSIS_LEAGUE_IDS, batches: activeBatches })).status, 202);
assert.equal(submitted.at(-1).input.preflightFailures, 0, 'seven active leagues do not count retired NHL as a failed preflight');
const beforeBad = submitted.length;
assert.equal((await post({ league: 'EPL', date: games.epl.date, tasks: [{ ...normalized.epl, soccerQuery: { ...normalized.epl.soccerQuery, league: 'ucl' } }] })).status, 400);
assert.equal(submitted.length, beforeBad);
authorized = false; assert.equal((await post({ league: 'EPL', date: games.epl.date, tasks: [normalized.epl] })).status, 401);
authorized = true; sameOrigin = false; assert.equal((await post({ league: 'EPL', date: games.epl.date, tasks: [normalized.epl] })).status, 403); sameOrigin = true;
const statusRequest = query => new Request(`https://fixture.invalid/api/analysis-jobs?runId=run-soccer-fixture&${query}`);
const soccerReceipt = await (await route.get(statusRequest('league=EPL'))).json();
assert.equal(soccerReceipt.status, 'completed'); assert.equal(soccerReceipt.result.league, 'EPL');
assert.equal(soccerReceipt.result.results[0].research, true); assert.equal(soccerReceipt.result.results[0].saved, true);
const summary = await (await route.get(statusRequest('summary=1'))).json();
assert.equal(summary.result.batches[0].results[0].research, true);
assert.equal((await route.get(statusRequest('league=UCL'))).status, 404);
console.log('PASS shipped job route: EPL/UCL dispatch, all-registry batch capacity, auth/origin, malformed-task rejection and recoverable research/save receipts');

// Execute actual durable workflow functions, replacing only external calls.
const publications = [], analysisCalls = [], serviceCalls = [];
const baseTask = { game: { gamePk: 7 }, requestId: 'baseball-fixture', body: { league: 'MLB', game: { gamePk: 7 } } };
const workflow = vm.createContext({ Request, Response, FatalError: Error, RetryableError: Error,
  ANALYSIS_LEAGUE_IDS, isAnalysisLeagueId, isSoccerAnalysisLeague,
  getWorkflowMetadata: () => ({ workflowRunId: 'run-soccer-workflow-fixture' }), createAnalysisJobProgress,
  saveAnalysisJobProgress: async (_id, data) => { publications.push(structuredClone(data)); return true; },
  analyzeSoccerJobTask: async task => { serviceCalls.push(task.league); if (task.soccerQuery.eventId === '999') throw Error('controlled soccer service error'); return analyzeSoccerJobTask(task, async () => ({ status: 200, payload: snapshots[task.soccerQuery.league] })); },
  analyzeNbaJobTask: async () => assert.fail('no NBA task in fixture'), analyzeNhlJobTask: async () => assert.fail('no NHL task in fixture'),
  createBackgroundAnalysisAuthorization: async () => ({ timestamp: '1', signature: 'fixture' }),
  analyzeRequest: async request => { const body = await request.json(); analysisCalls.push(body.league); assert.equal(body.league, 'MLB'); return Response.json({ ok: true, game: body.game }); },
});
vm.runInContext(stripImports(read('workflows/analyze-board.js')) + '\nthis.all=analyzeAllLeaguesWorkflow;this.one=analyzeBoardWorkflow;', workflow);
const throwing = { ...normalized.epl, soccerQuery: { ...normalized.epl.soccerQuery, eventId: '999' }, game: { ...normalized.epl.game, gamePk: 999 } };
const input = { date: games.epl.date, batches: [
  { league: 'EPL', date: games.epl.date, tasks: [normalized.epl, throwing] },
  { league: 'UCL', date: games.ucl.date, tasks: [normalized.ucl] },
  { league: 'MLB', date: games.epl.date, tasks: [baseTask] },
  ...['NPB', 'KBO', 'CPBL', 'NBA'].map(league => ({ league, date: games.epl.date, tasks: [], emptyReason: 'no_games' })),
] };
const output = await workflow.all(input);
assert.equal(output.batches.length, 7); assert.equal(output.batches[0].total, 2); assert.equal(output.batches[0].completed, 1);
assert.equal(output.batches[0].results[1].ok, false); assert.equal(output.batches[0].results[1].code, 'BACKGROUND_STEP_FAILED');
assert.equal(output.batches[1].results[0].research, true); assert.equal(output.batches[1].results[0].saved, true);
assert.equal(output.batches[2].completed, 1); assert.deepEqual(analysisCalls, ['MLB']); assert.deepEqual(serviceCalls, ['EPL', 'EPL', 'UCL']);
assert.ok(publications.some(progress => progress.league === 'EPL' && progress.results.length === 1));
assert.ok(publications.some(progress => progress.league === 'UCL' && progress.results.length === 1));
assert.ok(publications.every(progress => progress.gamePks.every(pk => Number.isSafeInteger(pk) && pk > 0)));
const single = await workflow.one({ league: 'EPL', date: games.epl.date, tasks: [normalized.epl] });
assert.equal(single.completed, 1); assert.equal(single.results[0].research, true);
console.log('PASS shipped workflow: seven active batches, isolated soccer service dispatch, partial failure/progress, saved research recovery and continued baseball analysis; Production and real browser remain separate');
