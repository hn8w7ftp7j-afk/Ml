import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ANALYSIS_LEAGUE_IDS, analysisLeagueIdsForRun, isAnalysisLeagueId } from '../lib/analysis-leagues.js';
import { LEAGUE_IDS, requestedLeagueId, leagueCanAnalyze } from '../lib/leagues.js';
import { cloudBetLeagueCanWrite } from '../lib/cloud-bet-store.js';
import { buildNbaAnalysisBoard } from '../lib/nba/analysis-board.js';
import { normalizeNbaAnalysisTasks, analyzeNbaJobTask } from '../lib/nba/analysis-job.js';
import { mergeNbaAnalysisResults, nbaResultQuoteCurrent } from '../lib/nba/analysis-job-display.js';
import { createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague, allLeagueAnalysisProgress } from '../lib/all-league-analysis-v117.js';
import { createAnalysisJobProgress } from '../lib/analysis-job-progress.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const strip = text => text.replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
const date = '2026-10-05', now = Date.parse('2026-10-05T00:00:00Z'), observedAt = new Date(now).toISOString();
const team = id => ({ id: `nba:espn:team:${id}`, league: 'NBA', sourceId: String(id) });
const game = { id: 'nba:espn:game:401999001', sourceId: '401999001', gamePk: 401999001, league: 'NBA', leagueId: 'NBA',
  season: { year: 2027 }, seasonType: 'preseason', startTime: '2026-10-05T01:00:00Z',
  timeConfirmed: true, status: 'scheduled', completed: false, away: team(2), home: team(5) };
const quote = { boardDate: date, boardTime: '09:00', away: game.away, home: game.home, marketStatus: 'open', fullTotal: { line: '220+50', overWater: .94, underWater: .96 } };
const schedule = { league: 'NBA', status: 'ready', qa: { status: 'WARNING' }, data: { games: [game] } };
const reader = { league: 'NBA', status: 'fresh', observedAt, pageActivityAt: observedAt, games: [quote] };
const board = buildNbaAnalysisBoard(date, schedule, reader, now);
assert.equal(board.tasks.length, 1); assert.equal(board.tasks[0].nbaQuery.date, date);
assert.equal(buildNbaAnalysisBoard(date, schedule, { ...reader, observedAt: new Date(now - 180001).toISOString() }, now).tasks.length, 0);
assert.equal(buildNbaAnalysisBoard(date, schedule, { ...reader, games: [{ ...quote, fullTotal: null, firstHalfTotal: quote.fullTotal }] }, now).tasks.length, 0);
assert.equal(buildNbaAnalysisBoard(date, schedule, { ...reader, games: [{ ...quote, marketStatus: 'locked' }] }, now).tasks.length, 0);
assert.equal(buildNbaAnalysisBoard(date, { ...schedule, data: { games: [{ ...game, status: 'live' }] } }, reader, now).emptyReason, 'no_games');
assert.equal(buildNbaAnalysisBoard(date, schedule, null, now).emptyReason, 'no_open_markets');
assert.throws(() => buildNbaAnalysisBoard(date, { ...schedule, qa: { status: 'BLOCK' } }, reader, now));
assert.throws(() => buildNbaAnalysisBoard('2026-02-30', schedule, reader, now));
const task = normalizeNbaAnalysisTasks([{ ...board.tasks[0], actualMarkets: [{ line: '999' }], body: { score: 9999 }, executable: true }], date)[0];
assert.deepEqual(Object.keys(task).sort(), ['game', 'league', 'nbaQuery']);
assert.throws(() => normalizeNbaAnalysisTasks([{ ...task, game: { ...game, gamePk: 5 } }], date));
assert.throws(() => normalizeNbaAnalysisTasks([{ ...task, nbaQuery: { ...task.nbaQuery, date: '2026-10-06' } }], date));
const payload = { league: 'NBA', modelVersion: 'nba-total-pace-rest-v1', status: 'ready', game, gameId: game.id, date, observedAt, executable: false,
  prediction: { home: 110, away: 110, baseTotal: 220, total: 219, correction: -1 },
  assessment: { positiveExpectedNet: -3, negativeExpectedNet: 1, direction: 'under' }, quote: quote.fullTotal };
const fresh = { ...task, nbaQuery: { ...task.nbaQuery, observedAt: new Date(now + 1000).toISOString() } };
const ready = await analyzeNbaJobTask(task, async query => { assert.deepEqual(query, fresh.nbaQuery); return { ...payload, observedAt: query.observedAt }; }, async () => ({ tasks: [fresh] }));
assert.equal(ready.ok, true); assert.equal(ready.task.nbaQuery.observedAt, fresh.nbaQuery.observedAt);
const insufficient = await analyzeNbaJobTask(task, async () => ({ ...payload, status: 'insufficient', prediction: null, assessment: null, training: { availableGames: 0 } }), async () => ({ tasks: [task] }));
assert.equal(insufficient.ok, false); assert.equal(insufficient.status, 422); assert.equal(insufficient.blocked, true);
const readyOriginal = { ...ready, payload, task };
let display = mergeNbaAnalysisResults({ league: 'NBA', date, results: [readyOriginal] }, board.rows, date);
assert.equal(display[0].result.prediction.total, 219); assert.equal(nbaResultQuoteCurrent(display[0], now), true);
assert.equal(nbaResultQuoteCurrent(display[0], now + 180001), false);
assert.equal(nbaResultQuoteCurrent({ ...display[0], quote: { ...quote, fullTotal: { ...quote.fullTotal, line: '225' } } }, now), false);
assert.throws(() => mergeNbaAnalysisResults({ league: 'MLB', date, results: [readyOriginal] }, [], date));
assert.throws(() => mergeNbaAnalysisResults({ league: 'NBA', date, results: [readyOriginal, readyOriginal] }, [], date));
assert.throws(() => mergeNbaAnalysisResults({ league: 'NBA', date, results: [{ ...readyOriginal, payload: { ...payload, executable: true } }] }, [], date));
assert.throws(() => mergeNbaAnalysisResults({ league: 'NBA', date, results: [{ ...readyOriginal, payload: { ...payload, observedAt: 'other' } }] }, [], date));
display = mergeNbaAnalysisResults({ league: 'NBA', date, results: [insufficient] }, [], date);
assert.equal(display[0].jobState, 'insufficient');

const run = createAllLeagueAnalysisRun(date);
assert.deepEqual(Object.keys(run.leagues), ANALYSIS_LEAGUE_IDS);
assert.equal(allLeagueAnalysisProgress(updateAllLeagueAnalysisLeague(run, 'NBA', { status: 'partial' })).partial, 1);
assert.deepEqual(analysisLeagueIdsForRun({ leagues: Object.fromEntries(LEAGUE_IDS.map(id => [id, {}])) }), LEAGUE_IDS);
assert.equal(requestedLeagueId('NBA'), null); assert.equal(leagueCanAnalyze('NBA'), false); assert.equal(cloudBetLeagueCanWrite('NBA'), false);

// Execute the REAL job API with isolated workflow/storage/provider adapters.
const submitted = []; let authorized = true;
const route = vm.createContext({ Request, Response, URL, NextResponse: Response, crypto: globalThis.crypto, Date,
  cleanText: (v, max = 1000) => String(v || '').slice(0, max), isLeagueId: v => LEAGUE_IDS.includes(v),
  isAnalysisLeagueId, ANALYSIS_LEAGUE_IDS, normalizeNbaAnalysisTasks,
  requireApiAuth: async () => authorized ? null : Response.json({}, { status: 401 }), validateSameOrigin: () => true,
  checkRateLimit: () => ({ allowed: true }), validAnalysisJobRequestKey: () => false,
  readJsonBody: request => request.json(), deviceHash: () => null, readCookie: () => '', PUSH_COOKIE: 'unused',
  analyzeAllLeaguesWorkflow: 'all', analyzeBoardWorkflow: 'one',
  start: async (workflow, input) => { submitted.push({ workflow, input: input[0] }); return { runId: 'run-nba-isolated' }; },
  failAnalysisJobRequest: async () => {},
});
vm.runInContext(strip(read('app/api/analysis-jobs/route.js')) + '\nthis.post=POST;', route);
const post = body => route.post(new Request('https://fixture.test/api/analysis-jobs', { method: 'POST', body: JSON.stringify(body) }));
const batches = ANALYSIS_LEAGUE_IDS.map(league => ({ league, date, tasks: league === 'NBA' ? [task] : [], emptyReason: league === 'NBA' ? null : 'no_games' }));
assert.equal((await post({ mode: 'all-leagues', date, batches })).status, 202);
assert.equal(submitted[0].input.batches.length, 5); assert.equal(submitted[0].input.batches[0].league, 'NBA');
assert.equal((await post({ league: 'NBA', date, tasks: [task] })).status, 202);
assert.equal(submitted[1].input.league, 'NBA');
assert.equal((await post({ mode: 'all-leagues', date, batches: [...batches, batches[0]] })).status, 400);
assert.equal((await post({ league: 'NBA', date, tasks: [{ ...task, nbaQuery: { ...task.nbaQuery, date: '2026-10-06' } }] })).status, 400);
authorized = false; assert.equal((await post({ league: 'NBA', date, tasks: [task] })).status, 401);

// Real workflow continues through NBA insufficient/error to all baseball groups.
const publications = []; let nbaCalls = 0;
const workflow = vm.createContext({ Request, Response, FatalError: Error, RetryableError: Error,
  getWorkflowMetadata: () => ({ workflowRunId: 'run-unified-isolated' }), createAnalysisJobProgress,
  saveAnalysisJobProgress: async (_id, data) => { publications.push(structuredClone(data)); return true; },
  analyzeNbaJobTask: async () => { nbaCalls++; if (nbaCalls === 2) throw new Error('controlled NBA source failure'); return insufficient; },
  createBackgroundAnalysisAuthorization: async () => ({ timestamp: '1', signature: 'fixture' }),
  analyzeRequest: async request => { const body = await request.json(); return Response.json({ ok: true, game: body.game, analysis: { results: [{}] } }); },
});
vm.runInContext(strip(read('workflows/analyze-board.js')) + '\nthis.all=analyzeAllLeaguesWorkflow;', workflow);
const input = { date, batches: [{ league: 'NBA', date, tasks: [task, { ...task, game: { ...game, gamePk: 401999002 } }] }, ...LEAGUE_IDS.map((league, index) => ({ league, date, tasks: [{ game: { gamePk: index + 1 }, requestId: `test-${index}`, body: { game: { gamePk: index + 1 } } }] }))] };
const output = await workflow.all(input);
assert.equal(output.batches.length, 5); assert.equal(output.batches[0].results.length, 2); assert.equal(output.batches[0].completed, 0);
assert.equal(output.batches.slice(1).every(batch => batch.completed === 1), true);
assert.ok(publications.some(p => p.league === 'NBA' && p.results.length === 1 && p.runningGamePks.length === 0));
assert.equal(publications.at(-1).league, 'CPBL');
const page = read('app/page.js');
assert.ok(page.includes('NbaMainWorkspace active={nbaSelected}'));
assert.ok(!page.includes('<NbaEntry/>'));
assert.ok(page.includes('ANALYSIS_LEAGUE_IDS.map(async id'));
assert.ok(read('app/nba/page.js').includes("redirect('/?sport=NBA')"));
console.log('Unified NBA analysis PASS: five-league submission, NBA-first latest-server-quote execution, per-game progress, insufficient/error isolation, identity/date/quote binding, result recovery and baseball ledger boundaries');
