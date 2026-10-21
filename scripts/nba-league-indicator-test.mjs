import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { nbaLeagueIndicator, nbaOpeningMarketCoverage } from '../lib/nba/league-indicator.js';
import { analyzeNbaOpening } from '../lib/nba/opening-model.js';
import { nbaBatchFinished, summarizeNbaBatchOutcome } from '../lib/nba/analysis-outcome.js';
import { validNbaJob, mergeNbaAnalysisResults } from '../lib/nba/analysis-job-display.js';
import { summarizeAllLeagueBatchResult } from '../lib/all-league-analysis-v117.js';
const date = '2026-10-14';
const ready = { ok: true, payload: { status: 'ready' } };
const batch = results => ({ league: 'NBA', date, total: results.length, results });
const outcome = summarizeNbaBatchOutcome(batch([ready, ready]));
assert.deepEqual(nbaLeagueIndicator(date, { date, status: 'completed', outcome }), { status: 'done', label: '分析完成' });
assert.equal(nbaLeagueIndicator(date, { date, status: 'completed' }).status, 'result_pending');
assert.equal(nbaLeagueIndicator(date, { date, status: 'running' }).status, 'running');
assert.equal(nbaLeagueIndicator(date, { date, status: 'failed' }).status, 'failed');
assert.equal(nbaLeagueIndicator('2026-10-15', { date, status: 'completed' }).status, 'idle');
assert.equal(nbaLeagueIndicator(date, null, { boardDate: date, status: 'done' }).status, 'result_pending');
assert.equal(nbaLeagueIndicator(date, null, { boardDate: date, ...outcome }).status, 'done');
assert.equal(nbaLeagueIndicator(date, null, { boardDate: '2026-10-13', status: 'done' }).status, 'idle');
assert.equal(nbaLeagueIndicator(date, { date, status: 'completed' }, null, true).status, 'running');
assert.equal(nbaLeagueIndicator(date, null, null, true).status, 'running');

for (const [rows, expected] of [
  [[ready], 'done'],
  [[{ ok: true, payload: { status: 'reference' } }], 'insufficient_data'],
  [[{ ok: false, payload: { status: 'insufficient' } }], 'insufficient_data'],
  [[{ ok: false, payload: { status: 'blocked' } }], 'failed'],
  [[{ ok: false, error: 'provider failed' }], 'failed'],
  [[{ ok: true }], 'failed'],
  [[ready, { ok: false, status: 422, payload: { status: 'insufficient' } }], 'partial'],
]) {
  const full = batch(rows), summary = summarizeNbaBatchOutcome(full);
  assert.equal(summary.status, expected);
  assert.deepEqual(summarizeAllLeagueBatchResult(full), summary);
  const compact = { ...full, results: rows.map(row => ({ ok: row.ok, analysisStatus: row.payload?.status || null })) };
  assert.deepEqual(summarizeNbaBatchOutcome(compact), summary, 'summary API and full results must agree');
  assert.equal(nbaLeagueIndicator(date, { date, status: 'completed', outcome: summary }).status, expected);
}
for (const emptyReason of ['no_games', 'no_open_markets']) {
  assert.equal(summarizeNbaBatchOutcome({ ...batch([]), emptyReason }).status, emptyReason);
}
for (const pending of [null, batch([]), { ...batch([ready]), total: 2 }, { ...batch([ready]), runningGamePks: [123] }, { ...batch([ready]), league: 'EPL' }]) {
  assert.equal(nbaBatchFinished(pending), false);
  assert.equal(summarizeNbaBatchOutcome(pending).status, 'result_pending');
}
const oldJob = { date, runId: 'old-run', startedAt: '2026-10-14T00:00:00Z', status: 'completed', outcome };
for (const status of ['preparing', 'queued', 'running', 'failed', 'no_open_markets', 'insufficient_data']) {
  const newerBatch = { boardDate: date, runId: status === 'preparing' ? '' : 'new-run', startedAt: '2026-10-14T01:00:00Z', status };
  assert.equal(nbaLeagueIndicator(date, oldJob, newerBatch).status, status, 'old completed jobs must never hide the current run');
  assert.equal(nbaLeagueIndicator(date, { ...oldJob, status: 'running' }, newerBatch, true).status, status, 'late old running callbacks cannot replace the newer batch');
}
const olderBatch = { boardDate: date, runId: 'older-run', startedAt: '2026-10-13T23:00:00Z', status: 'running' };
const emptyQuoteBatch = { boardDate: date, runId: 'new-empty-run', startedAt: '2026-10-14T01:00:00Z', status: 'no_open_markets' };
const recoveredBoard = { date, readerStatus: 'stale', analysisGameCount: 2 };
assert.deepEqual(nbaLeagueIndicator(date, oldJob, emptyQuoteBatch, false, recoveredBoard), { status: 'done', label: '分析完成｜盤口待更新' },
  'an empty quote preflight cannot hide recovered valid analyses still shown in NBA');
assert.deepEqual(nbaLeagueIndicator(date, oldJob, emptyQuoteBatch, false, { ...recoveredBoard, analysisGameCount: 0 }), { status: 'no_open_markets', label: '盤口待更新' },
  'without recovered results an old completed job cannot manufacture completion');
assert.equal(nbaLeagueIndicator(date, oldJob, { ...emptyQuoteBatch, status: 'running' }, false, recoveredBoard).status, 'running');
assert.equal(nbaLeagueIndicator(date, oldJob, emptyQuoteBatch, false, { ...recoveredBoard, date: '2026-10-15' }).status, 'no_open_markets');
assert.deepEqual(nbaLeagueIndicator(date, null, null, false, recoveredBoard), { status: 'no_open_markets', label: '盤口待更新' });
assert.equal(nbaLeagueIndicator(date, oldJob, olderBatch).status, 'done', 'a delayed old batch must not reset a newer independent analysis');
assert.equal(nbaLeagueIndicator(date, oldJob, { ...olderBatch, runId: oldJob.runId, status: 'running' }).status, 'done', 'NBA can finish before the other leagues in the same run');
assert.equal(nbaLeagueIndicator('2026-10-15', oldJob, olderBatch, true).status, 'idle');
assert.deepEqual(nbaLeagueIndicator(date, null, { boardDate: date, status: 'running', total: 1, reference: 1 }), { status: 'running', label: '分析中' });
const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const child = readFileSync(new URL('../app/nba/main-workspace.js', import.meta.url), 'utf8');
assert.match(page, /onJobChange=\{setNbaIndicatorJob\}/);
assert.match(child, /onJobChange\?\.\(job\)/);
assert.match(page, /leagueDot batch-\$\{nbaIndicator.status\}/);
// Execute the shipped polling effect: the NBA batch can finish while the same
// workflow is still analysing other leagues. Only accepted results grant done.
const effectStart = child.indexOf('  useEffect(() => {\n    if (!validNbaJob(job)');
const effectEnd = child.indexOf('\n\n  async function start', effectStart);
assert.ok(effectStart >= 0 && effectEnd > effectStart);
const observedAt = '2026-10-14T00:00:00Z';
const game = id => ({ id: `nba:espn:game:${id}`, gamePk: Number(id), league: 'NBA' });
const entry = (id, status = 'ready') => ({
  ok: status === 'ready', task: { game: game(id), nbaQuery: { id, date, observedAt } },
  payload: { league: 'NBA', date, gameId: game(id).id, observedAt, executable: false, status,
    ...(status === 'ready' ? { modelVersion: 'nba-total-pace-rest-v1', prediction: { home: 110, away: 109, baseTotal: 220, total: 219, correction: -1 }, assessment: { positiveExpectedNet: -3, negativeExpectedNet: 1 } } : {}) },
});
async function polling(states) {
  const jobs = [], publications = [], timers = [], errors = [];
  const job = { date, runId: 'run-nba-indicator-fixture', status: 'running' };
  const jobRef = { current: job }, rowsRef = { current: [] };
  let cleanup;
  const scope = { job, jobRef, rowsRef, dateRef: { current: date }, reconnectRevision: 0,
    validNbaJob, mergeNbaAnalysisResults, nbaBatchFinished, summarizeNbaBatchOutcome,
    nbaCompletionSummary: () => 'fixture summary',
    api: async () => states.shift(), store: () => {},
    setJob: next => { jobs.push(next); jobRef.current = next; },
    setRows: () => {}, setProgress: () => {}, setMessage: () => {},
    setError: message => errors.push(message), onBatchProgress: value => publications.push(value),
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: () => {},
    useEffect: effect => { cleanup = effect(); },
  };
  vm.runInNewContext(child.slice(effectStart, effectEnd), scope);
  const flush = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };
  await flush();
  return { jobs, errors, publications, timers, get rows() { return rowsRef.current; }, async tick() { timers.shift()?.(); await flush(); }, cleanup };
}
const first = entry('401999001'), second = entry('401999002');
const partialBatch = { league: 'NBA', date, total: 2, results: [first], runningGamePks: [401999002] };
const fullBatch = { ...partialBatch, results: [first, second], runningGamePks: [] };
const flow = await polling([{ status: 'running', progress: partialBatch }, { status: 'running', progress: fullBatch }]);
assert.equal(flow.jobs.length, 0);
await flow.tick();
assert.equal(flow.jobs.at(-1).outcome.status, 'done');
assert.equal(flow.publications.length, 2);
assert.equal(flow.timers.length, 0, 'finishing NBA must not wait for unrelated leagues');
flow.cleanup();
for (const status of ['insufficient', 'blocked']) {
  const run = await polling([{ status: 'completed', result: batch([entry('401999001', status)]) }]);
  assert.equal(run.jobs.at(-1).outcome.status, status === 'insufficient' ? 'insufficient_data' : 'failed');
  run.cleanup();
}
const invalid = await polling([{ status: 'completed', result: { ...fullBatch, date: '2026-10-15' } }]);
assert.equal(invalid.jobs.length, 0, 'mismatched results must never publish completion');
assert.match(invalid.errors[0], /聯盟或日期/);
invalid.cleanup();
const incomplete = await polling([{ status: 'completed', result: partialBatch }]);
assert.equal(incomplete.jobs.at(-1).outcome.status, 'result_pending');
incomplete.cleanup();

// A completed workflow may only have scored spreads. Exercise the real model,
// polling merge, shipped board-state callback and top badge together so failed
// totals cannot disappear behind a green game-level completion count.
const openingGame = { ...game('401999003'), sourceId: '401999003', taipeiDate: date,
  season: { year: 2027, type: 'regular' }, seasonType: 'regular', neutralSite: false,
  home: { id: 'nba:espn:team:19' }, away: { id: 'nba:espn:team:1' } };
const openingQuotes = { fullTotal: { line: '235.5', overWater: .94, underWater: .94 },
  fullRunline: { line: '3-50', lineSide: 'home', homeWater: .95, awayWater: .95 } };
const openingEntry = quotes => {
  const payload = { ...analyzeNbaOpening(openingGame, quotes), league: 'NBA', date, gameId: openingGame.id, observedAt };
  return { ok: payload.status === 'ready', task: { game: openingGame, nbaQuery: { id: openingGame.sourceId, date, observedAt } }, payload };
};
const coverageStart = child.indexOf('  const openingMarketCoverage = useMemo(');
const coverageEnd = child.indexOf('\n  return <NbaBetRecordProvider', coverageStart);
assert.ok(coverageStart >= 0 && coverageEnd > coverageStart);
const publishBoard = (rows, job, readerStatus = 'fresh') => {
  let published;
  vm.runInNewContext(child.slice(coverageStart, coverageEnd), { rows, date, job, readerStatus,
    nbaOpeningMarketCoverage, betReminder: { analysisGameCount: rows.filter(row => row.result?.status === 'ready').length },
    useMemo: callback => callback(), useEffect: callback => callback(), onBoardStateChange: value => { published = value; } });
  return published;
};
const partialMarketFlow = await polling([{ status: 'completed', result: batch([openingEntry(openingQuotes)]) }]);
const openingJob = partialMarketFlow.jobs.at(-1), openingRows = partialMarketFlow.rows;
assert.equal(openingJob.outcome.status, 'done', 'workflow completion is still independent of per-market scoring');
assert.equal(openingRows[0].resultRunId, openingJob.runId, 'poll results must bind to the requested run even when the transport omits runId');
const openingBoard = publishBoard(openingRows, openingJob);
assert.equal(openingBoard.openingMarketCoverage.date, date);
assert.equal(openingBoard.openingMarketCoverage.runId, openingJob.runId);
assert.equal(openingBoard.openingMarketCoverage.games, 1);
assert.equal(openingBoard.openingMarketCoverage.quoted, 2);
assert.equal(openingBoard.openingMarketCoverage.ready, 1);
assert.equal(openingBoard.openingMarketCoverage.validationFailed, 1);
assert.deepEqual(nbaLeagueIndicator(date, openingJob, null, false, openingBoard), { status: 'partial', label: '部分市場已分析' });
assert.deepEqual(nbaLeagueIndicator(date, openingJob, null, false, { ...openingBoard, readerStatus: 'stale' }), { status: 'partial', label: '部分市場已分析｜盤口待更新' });
assert.match(child, /resultRunId: previous\.resultRunId/, 'quote reloads must preserve the recovered result run binding');
partialMarketFlow.cleanup();

const failedTotalFlow = await polling([{ status: 'completed', result: batch([openingEntry({ fullTotal: openingQuotes.fullTotal })]) }]);
const failedTotalJob = failedTotalFlow.jobs.at(-1), failedTotalBoard = publishBoard(failedTotalFlow.rows, failedTotalJob);
assert.equal(failedTotalBoard.analysisGameCount, 0);
assert.equal(failedTotalBoard.openingMarketCoverage.quoted, 1);
assert.equal(failedTotalBoard.openingMarketCoverage.validationFailed, 1);
assert.deepEqual(nbaLeagueIndicator(date, failedTotalJob, null, false, failedTotalBoard), { status: 'insufficient_data', label: '市場驗證未通過' });
failedTotalFlow.cleanup();

for (const rows of [
  openingRows.map(row => ({ ...row, resultRunId: 'older-result-run' })),
  openingRows.map(row => ({ ...row, result: { ...row.result, date: '2026-10-13' } })),
  openingRows.map(row => ({ ...row, result: { ...row.result, league: 'MLB' } })),
]) {
  assert.equal(nbaOpeningMarketCoverage(rows, date, openingJob).validationFailed, 0);
}
assert.equal(nbaOpeningMarketCoverage(openingRows, date, { ...openingJob, status: 'running' }), null);
assert.equal(nbaOpeningMarketCoverage(openingRows, '2026-10-15', openingJob), null);
for (const change of [{ date: '2026-10-13' }, { runId: 'other-run' }, { version: 'other-version' },
  { ready: -1 }, { validationFailed: 3 }, { startedAt: '2026-10-14T02:00:00Z' }]) {
  const isolatedBoard = { ...openingBoard, openingMarketCoverage: { ...openingBoard.openingMarketCoverage, ...change } };
  assert.equal(nbaLeagueIndicator(date, { ...openingJob, startedAt: '2026-10-14T01:00:00Z' }, null, false, isolatedBoard).label, '分析完成');
}
for (const status of ['preparing', 'running', 'failed', 'no_open_markets']) {
  const newBatch = { boardDate: date, runId: 'newer-opening-run', startedAt: '2026-10-14T03:00:00Z', status };
  if (status === 'no_open_markets') {
    assert.equal(nbaLeagueIndicator(date, openingJob, newBatch, false, openingBoard).label, '部分市場已分析', 'empty preflight may preserve visible old analyses, scoped to the old job');
  } else assert.equal(nbaLeagueIndicator(date, openingJob, newBatch, false, openingBoard).status, status, 'old market failures cannot relabel a newer workflow');
}
const sameRunBatch = { boardDate: date, runId: openingJob.runId, ...openingJob.outcome };
assert.equal(nbaLeagueIndicator(date, null, sameRunBatch, false, openingBoard).label, '部分市場已分析');
assert.equal(nbaLeagueIndicator(date, { ...openingJob, status: 'running' }, null, true, openingBoard).label, '分析中');
for (const mutate of [
  result => { result.quotes.fullTotal = null; result.marketAnalyses.fullTotal.status = 'unavailable'; },
  result => { result.quotes.fullTotal.line = 'invalid'; },
  result => { result.quotes.fullTotal.overWater = null; },
  result => { result.marketAnalyses.fullTotal.status = 'blocked'; },
  result => { result.marketAnalyses.fullTotal.validationDiagnostics.market = 'firstHalfTotal'; },
]) {
  const rows = structuredClone(openingRows);
  mutate(rows[0].result);
  const board = publishBoard(rows, openingJob);
  assert.equal(board.openingMarketCoverage.validationFailed, 0, 'unopened, invalid, blocked or foreign-market data is not a validation failure');
  assert.equal(nbaLeagueIndicator(date, openingJob, null, false, board).label, '分析完成');
}
const wrongRunFlow = await polling([{ status: 'completed', result: { ...batch([openingEntry(openingQuotes)]), runId: 'different-transport-run' } }]);
assert.equal(wrongRunFlow.jobs.length, 0, 'a conflicting explicit transport run cannot acquire current-run provenance');
assert.match(wrongRunFlow.errors[0], /工作編號/);
wrongRunFlow.cleanup();
// Exercise both real GET summary transports so NBA outcome information cannot
// disappear between full payloads and the all-league progress card.
let storedResult;
const routeScope = { Request, Response, URL, Date, NextResponse: Response,
  console: { info() {} }, cleanText: value => String(value || ''),
  requireApiAuth: async () => null,
  getRun: () => ({ exists: true, status: 'completed', returnValue: storedResult }),
};
const route = readFileSync(new URL('../app/api/analysis-jobs/route.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
vm.runInNewContext(`${route}\nthis.get = GET;`, routeScope);
for (const multi of [false, true]) {
  const nba = batch([first, entry('401999002', 'insufficient')]);
  storedResult = multi ? { batches: [nba, { league: 'EPL', total: 1, results: [{ ok: true, analysisStatus: 'COMPLETED', research: true }] }] } : nba;
  const response = await routeScope.get(new Request('https://fixture.test/api/analysis-jobs?runId=run-indicator-fixture&summary=1'));
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  const compact = multi ? result.batches[0] : result;
  assert.deepEqual(summarizeAllLeagueBatchResult(compact), summarizeAllLeagueBatchResult(nba));
  if (multi) {
    assert.equal(result.batches[1].results[0].analysisStatus, 'COMPLETED');
    assert.equal(summarizeAllLeagueBatchResult(result.batches[1]).status, 'research');
  }
}
console.log('NBA indicator PASS: real poll/merge, opening-market board callback and badge coverage, independent completion, outcome/compact parity, missing results, reference/data failures and newer-run/date isolation');
