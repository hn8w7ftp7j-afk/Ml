import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildNhlAnalysisBoard, loadNhlAnalysisBoard } from '../lib/nhl/analysis-board.js';
import { normalizeNhlAnalysisTasks, analyzeNhlJobTask } from '../lib/nhl/analysis-job.js';
import { normalizeNhlSchedule } from '../lib/nhl/data.js';
import { validNhlDate } from '../lib/nhl/identity.js';
import { ANALYSIS_LEAGUE_IDS, analysisLeagueIdsForRun, isAnalysisLeagueId } from '../lib/analysis-leagues.js';
import { LEAGUE_IDS, requestedLeagueId, leagueCanAnalyze } from '../lib/leagues.js';
import { cloudBetLeagueCanWrite } from '../lib/cloud-bet-store.js';
import { createAllLeagueAnalysisRun, summarizeAllLeagueBatchResult } from '../lib/all-league-analysis-v117.js';
import { createAnalysisJobProgress } from '../lib/analysis-job-progress.js';
import { completionMessage } from '../lib/analysis-push.js';
import { nhlAnalysisResultHref } from '../lib/nhl/analysis-link.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const strip = source => source.replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
const date = '2026-10-12';
const next = '2026-10-13';
const now = Date.parse('2026-10-12T08:00:00Z');
const raw = (id, startTimeUTC, gameState = 'FUT') => ({ id, season: 20262027, gameType: 2,
  gameState, gameScheduleState: 'OK', startTimeUTC, awayTeam: { id: 10, abbrev: 'TOR' }, homeTeam: { id: 8, abbrev: 'MTL' } });
const source = { provider: 'NHL', url: 'https://api-web.nhle.com/v1/schedule/2026-10-11', fetchedAt: new Date(now).toISOString() };
const schedule = normalizeNhlSchedule({ games: [
  raw(2026020001, '2026-10-12T01:00:00Z', 'OFF'),
  raw(2026020002, '2026-10-12T23:00:00Z'),
  raw(2026020003, '2026-10-14T01:00:00Z'),
] }, source);
assert.equal(buildNhlAnalysisBoard(date, schedule, { now }).emptyReason, 'no_games');
const board = buildNhlAnalysisBoard(date, schedule, { now, upcoming: true });
assert.equal(board.date, next);
assert.equal(board.tasks.length, 1, 'one weekly response identifies the next upcoming Taiwan slate');
assert.equal(board.emptyReason, null, 'NHL score shadow analysis must run without any Reader price');
assert.equal(board.executable, false);
assert.equal(buildNhlAnalysisBoard(next, { ...schedule, games: schedule.games.map(game => ({ ...game, gameScheduleState: 'PPD' })) }, { now }).tasks.length, 0);
assert.throws(() => buildNhlAnalysisBoard('2026-02-30', schedule, { now }));
assert.throws(() => buildNhlAnalysisBoard(date, { ok: false, games: [] }, { now }));
let scheduleFetches = 0;
const fetched = await loadNhlAnalysisBoard(date, { now, upcoming: true, fetchJson: async url => {
  scheduleFetches++; assert.equal(url, source.url); return { ok: true, data: { games: schedule.games.map(game => raw(Number(game.gameId), game.startTimeUTC, game.gameState)) }, source };
} });
assert.equal(scheduleFetches, 1);
assert.equal(fetched.date, next);

const original = board.tasks[0];
const task = normalizeNhlAnalysisTasks([{ ...original, body: { league: 'MLB', score: 999 }, actualMarkets: [{ line: '999' }], executable: true }], next)[0];
assert.deepEqual(Object.keys(task).sort(), ['game', 'league', 'nhlQuery']);
assert.deepEqual(Object.keys(task.nhlQuery).sort(), ['date', 'gameId']);
assert.equal(task.game.startTimeUTC, '2026-10-12T23:00:00.000Z', 'admitted task times use a canonical instant');
for (const change of [
  { nhlQuery: { date, gameId: original.nhlQuery.gameId } },
  { game: { ...original.game, league: 'MLB' } },
  { game: { ...original.game, gamePk: 1 } },
  { game: { ...original.game, awayTeamId: original.game.homeTeamId } },
]) assert.throws(() => normalizeNhlAnalysisTasks([{ ...original, ...change }], next));
assert.throws(() => normalizeNhlAnalysisTasks([original, original], next));
assert.deepEqual(normalizeNhlAnalysisTasks([], next), []);
assert.equal(requestedLeagueId('NHL'), null);
assert.equal(leagueCanAnalyze('NHL'), false);
assert.equal(cloudBetLeagueCanWrite('NHL'), false);
assert.deepEqual(Object.keys(createAllLeagueAnalysisRun(date).leagues), ANALYSIS_LEAGUE_IDS);
assert.deepEqual(analysisLeagueIdsForRun({ leagues: Object.fromEntries([...LEAGUE_IDS, 'NBA'].map(id => [id, {}])) }), [...LEAGUE_IDS, 'NBA'], 'an old run gains no phantom NHL work');

const payload = { league: 'NHL', gameId: task.nhlQuery.gameId, taipeiDate: next, game: task.game,
  mode: 'PREGAME_SHADOW', model: { scopes: { REGULATION: { expectedGoals: { away: 3, home: 2 } } } },
  qa: { status: 'WARNING' }, persistence: { persisted: true },
  readiness: { formalRecommendations: false, realBetExecutionEnabled: false } };
const result = await analyzeNhlJobTask(task, async query => { assert.deepEqual(query, task.nhlQuery); return payload; });
assert.equal(result.ok, true); assert.equal(result.shadow, true); assert.equal(result.saved, true);
assert.equal(summarizeAllLeagueBatchResult({ total: 1, results: [result] }).status, 'partial', 'shadow forecasting cannot be reported as formal success');
assert.match(completionMessage('run-nhl-test', { league: 'NHL', total: 1, completed: 1, ok: true, results: [result] }).title, /部分/);
assert.match(completionMessage('run-nhl-test', { league: 'NHL', total: 1, completed: 1, ok: true, results: [result] }).body, /影子分析/);
const unsaved = await analyzeNhlJobTask(task, async () => ({ ...payload, persistence: { persisted: false } }));
assert.equal(unsaved.ok, true); assert.equal(unsaved.saved, false);
for (const serializedTime of ['2026-10-12T23:00:00Z', '2026-10-12T23:00:00.000Z', '2026-10-13T07:00:00+08:00']) {
  const replay = { ...payload, mode: 'SAVED_PREGAME_REPLAY', game: { ...payload.game, startTimeUTC: serializedTime } };
  const before = structuredClone(replay);
  const received = await analyzeNhlJobTask(task, async () => replay);
  assert.equal(received.ok, true, 'same-instant official/replay ISO formats must retain the same NHL identity');
  assert.equal(received.saved, true);
  assert.equal(received.task.game.startTimeUTC, serializedTime, 'recovery context shares the validated snapshot time format');
  assert.deepEqual(replay, before, 'identity normalization cannot alter saved snapshot evidence');
}
for (const change of [
  { gameId: '2026029999' }, { taipeiDate: date }, { game: { ...task.game, awayTeamId: 1 } },
  { game: { ...task.game, startTimeUTC: '2026-10-12T23:00:01.000Z' } },
  { game: { ...task.game, startTimeUTC: 'not-an-iso-date' } },
  { mode: 'NO_PREGAME_RECORD', model: null }, { qa: { status: 'BLOCK' } },
  { readiness: { formalRecommendations: true, realBetExecutionEnabled: true } },
]) assert.equal((await analyzeNhlJobTask(task, async () => ({ ...payload, ...change }))).ok, false);

// Execute the real workflow with NHL success and source failures before baseball.
// A hockey task must never call the generic baseball API, even on a failure.
const publications = [];
let nhlCalls = 0, baseballCalls = 0;
const workflow = vm.createContext({ Request, Response, FatalError: Error, RetryableError: Error,
  getWorkflowMetadata: () => ({ workflowRunId: 'run-nhl-orchestration' }),
  createAnalysisJobProgress, saveAnalysisJobProgress: async (_id, progress) => { publications.push(progress); return true; },
  analyzeNhlJobTask: async value => { nhlCalls++; if (nhlCalls === 2) throw new Error('isolated NHL source failure'); return { ...result, task: value }; },
  analyzeNbaJobTask: async () => { throw new Error('unexpected NBA call'); },
  createBackgroundAnalysisAuthorization: async body => { assert.notEqual(body.league, 'NHL'); return { timestamp: '1', signature: 'test' }; },
  analyzeRequest: async request => { baseballCalls++; const body = await request.json(); assert.notEqual(body.league, 'NHL'); return Response.json({ ok: true, game: body.game, analysis: {} }); },
});
vm.runInContext(strip(read('workflows/analyze-board.js')) + '\nthis.all=analyzeAllLeaguesWorkflow;', workflow);
const output = await workflow.all({ date, batches: [
  { league: 'NHL', date: next, tasks: [task, { ...task, game: { ...task.game, gamePk: 2026020004 } }] },
  ...LEAGUE_IDS.map((league, index) => ({ league, date, tasks: [{ game: { gamePk: index + 1 }, body: { league, game: { gamePk: index + 1 } }, requestId: `fixture-${index}` }] })),
] });
assert.equal(nhlCalls, 2); assert.equal(baseballCalls, 4);
assert.equal(output.batches[0].results.length, 2);
assert.equal(output.batches.slice(1).every(batch => batch.completed === 1), true);
assert.equal(publications.at(-1).league, 'CPBL');

// Exercise actual task admission and compact result delivery with controlled
// workflow adapters, retaining both NHL identity and honest shadow/save flags.
const submissions = []; let authorized = true;
const route = vm.createContext({ Request, Response, URL, NextResponse: Response, crypto: globalThis.crypto, Date,
  cleanText: (value, max = 1000) => String(value || '').slice(0, max), ANALYSIS_LEAGUE_IDS, isAnalysisLeagueId,
  normalizeNhlAnalysisTasks, normalizeNbaAnalysisTasks: tasks => tasks,
  requireApiAuth: async () => authorized ? null : Response.json({}, { status: 401 }), validateSameOrigin: () => true,
  checkRateLimit: () => ({ allowed: true }), validAnalysisJobRequestKey: () => false,
  readJsonBody: request => request.json(), deviceHash: () => null, readCookie: () => '', PUSH_COOKIE: 'test',
  analyzeAllLeaguesWorkflow: 'all', analyzeBoardWorkflow: 'one',
  start: async (kind, input) => { submissions.push({ kind, input: input[0] }); return { runId: 'run-nhl-route' }; },
  failAnalysisJobRequest: async () => {}, getNotificationResult: async () => null,
  getRun: () => ({ exists: true, status: 'completed', returnValue: { mode: 'all-leagues', date, batches: [{ league: 'NHL', date: next, total: 1, completed: 1, ok: true, results: [result] }] } }),
});
vm.runInContext(strip(read('app/api/analysis-jobs/route.js')) + '\nthis.post=POST;this.get=GET;', route);
const post = body => route.post(new Request('https://fixture.test/api/analysis-jobs', { method: 'POST', body: JSON.stringify(body) }));
assert.equal((await post({ league: 'NHL', date: next, tasks: [original] })).status, 202);
assert.equal(submissions[0].input.tasks[0].league, 'NHL');
const allBatches = ANALYSIS_LEAGUE_IDS.map(league => ({ league, date: league === 'NHL' ? next : date,
  tasks: league === 'NHL' ? [original] : [], emptyReason: league === 'NHL' ? null : 'no_games' }));
assert.equal((await post({ mode: 'all-leagues', date, batches: allBatches })).status, 202);
assert.equal(submissions[1].input.batches.length, 6);
assert.deepEqual([...submissions[1].input.batches.map(batch => batch.league)], ['NBA', 'NHL', ...LEAGUE_IDS], 'NHL snapshots save before slower baseball groups while NBA remains first');
assert.equal((await post({ league: 'NHL', date: next, tasks: [{ ...original, game: { ...original.game, league: 'MLB' } }] })).status, 400);
const summary = await (await route.get(new Request('https://fixture.test/api/analysis-jobs?runId=run-nhl-route&summary=1'))).json();
assert.equal(summary.result.batches[0].results[0].shadow, true);
assert.equal(summary.result.batches[0].results[0].saved, true);
assert.equal(summarizeAllLeagueBatchResult(summary.result.batches[0]).status, 'partial');
assert.equal((await route.get(new Request('https://fixture.test/api/analysis-jobs?runId=run-nhl-route&league=NHL'))).status, 200);
authorized = false;
assert.equal((await post({ league: 'NHL', date: next, tasks: [original] })).status, 401);

const boardRoute = vm.createContext({ Request, Response, URL, NextResponse: Response, validNhlDate,
  requireApiAuth: async () => authorized ? null : Response.json({}, { status: 401 }), checkRateLimit: () => ({ allowed: true }),
  loadNhlAnalysisBoard: async (_date, options) => { assert.equal(options.upcoming, true); return board; } });
vm.runInContext(strip(read('app/api/nhl/analysis-board/route.js')) + '\nthis.get=GET;', boardRoute);
const getBoard = query => boardRoute.get(new Request(`https://fixture.test/api/nhl/analysis-board?${query}`));
assert.equal((await getBoard(`date=${date}&upcoming=1`)).status, 401);
authorized = true;
for (const query of [`date=2026-02-30`, `date=${date}&league=MLB`, `date=${date}&upcoming=2`, `date=${date}&date=${date}`]) assert.equal((await getBoard(query)).status, 400);
assert.equal((await getBoard(`date=${date}&upcoming=1`)).status, 200);
const page = read('app/page.js');
assert.match(page, /id === 'NHL' \? await prepareNhlBatch\(batchDate\)/);
assert.match(page, /!\['NBA', 'NHL'\]\.includes\(id\)[\s\S]*materializeAllLeagueResult/);
assert.match(page, /href=\{nhlAnalysisResultHref\(state.boardDate/);
assert.equal(nhlAnalysisResultHref(next, 'run-nhl-route'), '/nhl?date=2026-10-13&analysisRun=run-nhl-route');
assert.equal(nhlAnalysisResultHref('2026-02-30', 'run-nhl-route'), null);
assert.equal(nhlAnalysisResultHref(next, 'bad?secret=5'), null);
const start = page.indexOf('        const batches = state.result?.batches || [state.result];');
const end = page.indexOf('\n      } catch (error)', start);
let notifiedScope = null;
const notify = vm.createContext({ state: { result: { league: 'NHL', date: next, total: 1, completed: 1, results: [result] } },
  runId: 'run-nhl-route', nhlAnalysisResultHref, LEAGUE_IDS,
  setNhlNotificationScope: scope => { notifiedScope = scope; },
  currentLeagueRef: { current: 'MLB' }, currentDateRef: { current: date }, boardRef: { current: [] },
  independentRunsRef: { current: new Map() }, allLeagueRunRef: { current: null }, loadBackgroundJob: () => null,
  operationBusyRef: { current: false }, allLeagueBusyRef: { current: false }, setIndependentRunRevision() {}, setNotificationResultNotice() {},
});
vm.runInContext(page.slice(start, end), notify);
assert.equal(nhlAnalysisResultHref(notifiedScope.date, notifiedScope.runId), '/nhl?date=2026-10-13&analysisRun=run-nhl-route', 'a fresh device notification retains the original NHL date without cached run state');
assert.match(page, /nhlNotificationScope && <a href=\{nhlAnalysisResultHref\(nhlNotificationScope.date, nhlNotificationScope.runId\)\}/);
console.log('NHL orchestration PASS: one-fetch upcoming Taiwan date, strict identity and task isolation, shadow/save truth, partial summary, background failure isolation, authenticated API and standalone recovery link');
