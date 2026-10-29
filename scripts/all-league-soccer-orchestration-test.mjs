import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ACTIVE_ANALYSIS_LEAGUE_IDS, ANALYSIS_LEAGUE_IDS, analysisBatchScope, isSoccerAnalysisLeague } from '../lib/analysis-leagues.js';
import { createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague, allLeagueStateForDisplay, allLeaguePreflightFailureState, allLeagueAnalysisProgress, allLeagueAnalysisOutcomeText, summarizeAllLeagueBatchResult, allLeagueStatusLabel } from '../lib/all-league-analysis-v117.js';
import { soccerAnalysisResultHref } from '../lib/soccer/analysis-link.js';
import { validSoccerDate, soccerLeague } from '../lib/soccer/contracts.js';
import { isLeagueId, requestedLeagueId, LEAGUE_IDS } from '../lib/leagues.js';

const ids = [...ACTIVE_ANALYSIS_LEAGUE_IDS];
assert.deepEqual(ids, ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL']);
assert.equal(ANALYSIS_LEAGUE_IDS.includes('NHL'), true, 'saved NHL jobs stay readable');
assert.equal(analysisBatchScope(ids, ids).preflightFailures, 0);
assert.equal(analysisBatchScope(ids.slice(0, -1), ids).preflightFailures, 1);
for (const id of ['EPL', 'UCL']) {
  assert.equal(isLeagueId(id), false);
  assert.equal(requestedLeagueId(id), null, 'orchestration never enables baseball execution for soccer');
}
const page = fs.readFileSync('app/page.js', 'utf8');
const startIndex = page.indexOf('  async function oneClickAnalyzeAll(');
const action = page.slice(startIndex, page.indexOf('\n  useEffect(', startIndex));
const prepareIndex = page.indexOf('  async function prepareSoccerBatch(');
const prepare = page.slice(prepareIndex, startIndex);
const copy = value => JSON.parse(JSON.stringify(value));
function harness({ failure = '', empty = '', nbaReaderStatus = '' } = {}) {
  const calls = [], saved = [], jobs = [], notices = [];
  const ctx = { Date, URLSearchParams, ANALYSIS_LEAGUE_IDS: ids, LEAGUE_IDS, isSoccerAnalysisLeague,
    createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague, allLeagueStateForDisplay, allLeaguePreflightFailureState,
    readerPollBusyRef: { current: false }, independentRunsRef: { current: new Map() },
    allLeagueBusyRef: { current: false }, operationBusyRef: { current: false }, allLeagueRunning: false, nbaRunning: false, soccerRunning: false,
    leagueDatesRef: { current: { MLB: '2026-10-19', NPB: '2026-10-18', KBO: '2026-10-19', CPBL: '2026-10-19' } },
    date: '2026-10-19', nbaDate: '2026-10-19', allLeagueRun: null,
    analysisGenerationRef: { current: 0 }, restoredBoardNeedsValidationRef: {},
    manualAnalysisScopesRef: { current: new Set() }, submittedAllLeagueRunRef: {}, requestedRecoveryScopeRef: {},
    currentLeagueRef: { current: 'MLB' }, currentDateRef: { current: '2026-10-19' },
    loadAllLeagueAnalysisRun: () => null, clearAllLeagueBackgroundJobs() {}, clearBackgroundJob() {},
    markAppOperationBusy() {}, setAllLeaguePreparing() {}, setError() {}, setNotice: value => notices.push(value),
    publishAllLeagueRun: value => { ctx.run = value; }, setBackgroundJobRevision() {},
    allLeagueTargetDate: async (_id, date) => date,
    prepareAllLeagueBatch: async (league, date) => { calls.push(league); return batch(league, date); },
    prepareNbaBatch: async date => { calls.push('NBA'); return batch('NBA', date); },
    requestJSON: async url => {
      const query = new URL(url, 'https://fixture.invalid').searchParams;
      const league = query.get('league'); calls.push(league);
      if (league === failure) throw new Error('source unavailable');
      return batch(league, league === 'EPL' ? '2026-10-20' : '2026-10-21');
    },
    startBackgroundAnalysisJob: async value => { jobs.push(copy(value)); return { runId: 'workflow-seven-leagues' }; },
    saveBackgroundJob: value => { saved.push(copy(value)); return true; },
  };
  function batch(league, date) {
    const readerWaiting = league === 'NBA' && nbaReaderStatus;
    return { league, date, tasks: league === empty || readerWaiting ? [] : [{ game: { gamePk: 12, leagueId: league } }], preparedBoard: [],
      emptyReason: readerWaiting ? 'no_open_markets' : league === empty ? 'no_games' : null,
      ...(readerWaiting ? { readerStatus: nbaReaderStatus } : {}),
    };
  }
  vm.createContext(ctx); vm.runInContext(prepare + action, ctx);
  return { ctx, calls, saved, jobs, notices };
}
const happy = harness();
assert.equal(await happy.ctx.oneClickAnalyzeAll(), true);
assert.deepEqual([...happy.calls].sort(), [...ids].sort());
assert.deepEqual(happy.jobs[0].requestedLeagues, ids);
assert.equal(happy.jobs[0].batches.length, 7);
assert.deepEqual(happy.jobs[0].batches.filter(b => isSoccerAnalysisLeague(b.league)).map(b => [b.league, b.date]), [['EPL', '2026-10-20'], ['UCL', '2026-10-21']]);
assert.deepEqual(happy.saved.map(row => row.league), [...LEAGUE_IDS], 'football results cannot enter baseball caches or ledgers');
assert.equal(happy.ctx.run.leagues.EPL.boardDate, '2026-10-20');
assert.equal(happy.ctx.run.leagues.UCL.status, 'queued', 'accepted work stays queued until server progress confirms execution');
happy.ctx.allLeagueBusyRef.current = true;
assert.equal(await happy.ctx.oneClickAnalyzeAll(), false);
assert.equal(happy.jobs.length, 1, 'duplicate submission is blocked');
const manualFootball = harness();
manualFootball.ctx.soccerRunning = true;
assert.equal(await manualFootball.ctx.oneClickAnalyzeAll(), false);
assert.equal(manualFootball.calls.length, 0, 'an active football manual operation blocks another whole-site job');
assert.equal(manualFootball.jobs.length, 0);
const partial = harness({ failure: 'EPL' });
assert.equal(await partial.ctx.oneClickAnalyzeAll(), true);
assert.equal(partial.ctx.run.leagues.EPL.status, 'failed');
assert.equal(partial.jobs[0].batches.some(b => b.league === 'UCL'), true, 'EPL preflight failure cannot drop UCL');
const empty = harness({ empty: 'UCL' });
assert.equal(await empty.ctx.oneClickAnalyzeAll(), true);
assert.equal(empty.ctx.run.leagues.UCL.status, 'no_games', 'an empty football slate is explicit');
for (const readerStatus of ['stale', 'waiting']) {
  const waiting = harness({ nbaReaderStatus: readerStatus });
  assert.equal(await waiting.ctx.oneClickAnalyzeAll(), true);
  assert.equal(waiting.ctx.run.leagues.NBA.status, 'waiting_reader');
  assert.equal(waiting.jobs[0].batches.find(row => row.league === 'NBA').tasks.length, 0, 'waiting quotes cannot enter a model task');
  assert.equal(waiting.jobs[0].batches.find(row => row.league === 'NBA').emptyReason, 'no_open_markets', 'display classification does not change the server batch contract');
  assert.equal(waiting.ctx.run.leagues.EPL.status, 'queued', 'NBA waiting cannot block healthy football work');
}

const research = { league: 'EPL', total: 1, results: [{ ok: true, research: true, saved: true }] };
assert.equal(summarizeAllLeagueBatchResult(research).status, 'research');
assert.equal(summarizeAllLeagueBatchResult({ league: 'UCL', total: 1, results: [{ ok: false, blocked: true, status: 422 }] }).status, 'insufficient_data');
let run = createAllLeagueAnalysisRun('2026-10-19', Date.now(), ids);
for (const id of ids) run = updateAllLeagueAnalysisLeague(run, id, { status: isSoccerAnalysisLeague(id) ? 'research' : 'done' });
const progress = allLeagueAnalysisProgress(run);
assert.equal(progress.total, 7); assert.equal(progress.terminal, 7);
assert.equal(progress.succeeded, 5); assert.equal(progress.research, 2);
assert.match(allLeagueAnalysisOutcomeText(progress), /成功 5 聯盟｜研究完成 2 聯盟/);
assert.equal(allLeagueStatusLabel('insufficient_data'), '資料不足');
assert.equal(soccerAnalysisResultHref('EPL', '2026-10-20', 'workflow-seven-leagues'), '/?sport=EPL&date=2026-10-20&runId=workflow-seven-leagues');
assert.equal(soccerAnalysisResultHref('MLB', '2026-10-20'), null);
assert.equal(soccerAnalysisResultHref('UCL', '2026-02-30'), null);
// Execute the football-page entry effect before React has rendered a saved
// running job. Reopening the route must reconnect rather than replace that run.
const entryEnd = page.indexOf('  function recheckReaderItem(');
const entry = page.slice(page.lastIndexOf('  useEffect(() => {', entryEnd), entryEnd);
const resumed = harness(), starts = [];
let href = 'https://fixture.invalid/?analyzeAll=1&date=2026-10-20';
Object.assign(resumed.ctx, { URL, validSoccerDate, storageReady: true, readerPolling: false, busy: false,
  allLeaguePreparing: false, useEffect: fn => fn(),
  window: { location: { get href() { return href; } }, history: { replaceState: (_a, _b, url) => { href = String(url); } } },
  loadAllLeagueAnalysisRun: () => ({ date: '2026-10-20', runId: 'existing-running-job', state: 'running' }),
  oneClickAnalyzeAll: value => starts.push(value),
});
vm.runInContext(entry, resumed.ctx);
assert.equal(starts.length, 0); assert.equal(resumed.ctx.run.runId, 'existing-running-job');
assert.equal(new URL(href).searchParams.has('analyzeAll'), false);
href = 'https://fixture.invalid/?analyzeAll=1&date=2026-10-20';
resumed.ctx.loadAllLeagueAnalysisRun = () => null;
vm.runInContext(entry, resumed.ctx); vm.runInContext(entry, resumed.ctx);
assert.deepEqual(starts, ['2026-10-20'], 'one explicit football button starts one shared job, never a reload loop');
assert.match(prepare, /\/api\/soccer\/analysis-tasks\?/, 'job preflight must not collide with the saved workspace analysis-board API');
const routeSource = fs.readFileSync('app/api/soccer/analysis-tasks/route.js', 'utf8')
  .replace(/^import .*?;\n/gm, '').replace(/^export /gm, '');
let denied = false, rateAllowed = true, loadCount = 0;
const routeContext = vm.createContext({ URL, Date, soccerLeague, validSoccerDate,
  NextResponse: { json: (body, options) => Response.json(body, options) },
  requireApiAuth: async () => denied ? Response.json({ ok: false }, { status: 401 }) : null,
  checkRateLimit: () => ({ allowed: rateAllowed }), rateLimitResponse: () => Response.json({ ok: false }, { status: 429 }),
  loadSoccerAnalysisBoard: async (league, date, options) => { loadCount++; assert.equal(options.upcoming, true); return { league: league.toUpperCase(), date, tasks: [] }; },
});
vm.runInContext(routeSource, routeContext);
const request = query => new Request(`https://fixture.invalid/api/soccer/analysis-tasks?${query}`);
denied = true;
assert.equal((await routeContext.GET(request('league=EPL&date=2026-10-20&upcoming=1'))).status, 401); assert.equal(loadCount, 0);
denied = false;
for (const query of ['league=NHL&date=2026-10-20', 'league=EPL&date=2026-02-30', 'league=EPL&league=UCL&date=2026-10-20', 'league=EPL&date=2026-10-20&through=2026-10-22']) {
  assert.equal((await routeContext.GET(request(query))).status, 400);
}
const boardResponse = await routeContext.GET(request('league=EPL&date=2026-10-20&upcoming=1'));
assert.equal(boardResponse.status, 200); assert.equal((await boardResponse.json()).league, 'EPL'); assert.equal(loadCount, 1);
rateAllowed = false;
assert.equal((await routeContext.GET(request('league=UCL&date=2026-10-20&upcoming=1'))).status, 429); assert.equal(loadCount, 1);
console.log('PASS actual seven-league action: independent football preflights/dates, one durable job, failure isolation, no baseball materialization, explicit research/insufficient results and safe receipt links.');
