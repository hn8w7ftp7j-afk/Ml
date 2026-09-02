import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  allLeagueBoardDate,
  allLeagueAnalysisProgress,
  allLeagueRunContainsDate,
  createAllLeagueAnalysisRun,
  mergePreparedLeagueBoard,
  preserveCompletedReaderResult,
  summarizeAllLeagueBatchResult,
  updateAllLeagueAnalysisLeague,
} from '../lib/all-league-analysis-v117.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const page = read('app/page.js');
const route = read('app/api/analysis-jobs/route.js');
const workflow = read('workflows/analyze-board.js');

let run = createAllLeagueAnalysisRun('2026-08-30', 1_777_777_777_000);
assert.deepEqual(Object.keys(run.leagues), ['MLB', 'NPB', 'KBO', 'CPBL']);
run = updateAllLeagueAnalysisLeague(run, 'MLB', { status: 'done', total: 2, completed: 2 });
run = updateAllLeagueAnalysisLeague(run, 'NPB', { status: 'no_games', boardDate: '2026-08-29' });
assert.equal(allLeagueAnalysisProgress(run).terminal, 2);
assert.equal(allLeagueBoardDate(run, 'MLB'), '2026-08-30');
assert.equal(allLeagueBoardDate(run, 'NPB'), '2026-08-29');
assert.equal(allLeagueRunContainsDate(run, '2026-08-29'), true);
assert.deepEqual(summarizeAllLeagueBatchResult({
  total: 3,
  results: [{ ok: true }, { ok: false, status: 422 }, { ok: false, status: 500 }],
}), { status: 'partial', total: 3, completed: 1, blocked: 1, failed: 1 });
assert.equal(summarizeAllLeagueBatchResult({ total: 0, emptyReason: 'no_games', results: [] }).status, 'no_games');

const previous = [{
  game: { gamePk: 10, gameDate: '2026-08-30T10:00:00Z', leagueId: 'MLB' },
  customData: { analysis: { results: [{ modelEV: 0.02 }] } },
  status: 'done',
  statusLabel: '分析完成',
}];
const prepared = [{
  game: { gamePk: 10, gameDate: '2026-08-30T10:00:00Z', leagueId: 'MLB' },
  status: 'queued',
  statusLabel: '等待分析',
}];
const merged = mergePreparedLeagueBoard(previous, prepared);
assert.equal(merged.length, 1);
assert.equal(merged[0].status, 'running');
assert.equal(merged[0].customData.analysis.results[0].modelEV, 0.02, 'a refresh must preserve the completed league score until replacement');

const completedWhileReaderEmpty = preserveCompletedReaderResult(null, {
  ok: true,
  task: {
    game: { gamePk: 11, gameDate: '2026-08-30T11:00:00Z', leagueId: 'MLB' },
    readerPayloadHash: 'old-reader-board',
    actualSource: { provider: 'TAI888_READER_AUTO' },
    actualMarkets: [{ market: '全場讓分', water: 0.95 }],
  },
  payload: { analysis: { results: [{ modelEV: 0.17, scoreBreakdown: { rawScore: 8.1 } }] } },
}, null);
assert.equal(completedWhileReaderEmpty.customData.analysis.results[0].modelEV, 0.17, 'completed W/R must remain visible when Reader temporarily returns 0/0');
assert.equal(completedWhileReaderEmpty.readerPayloadHash, null, 'a retained completed result must not keep stale Reader execution authority');
assert.equal(completedWhileReaderEmpty.preservedCurrentReaderGame, true);
assert.match(completedWhileReaderEmpty.statusLabel, /保留已完成分析/);

assert.match(workflow, /export async function analyzeAllLeaguesWorkflow[\s\S]*'use workflow'/, 'all leagues need one durable server workflow');
assert.match(workflow, /for \(const batch of input\.batches\)[\s\S]*for \(let offset = 0; offset < tasks\.length; offset \+= concurrency\)/, 'league batches must execute sequentially with bounded per-league concurrency');
assert.match(workflow, /Promise\.allSettled[\s\S]*batches\.push/, 'one game or league failure must not stop later league groups');
assert.match(route, /body\?\.mode === 'all-leagues'[\s\S]*start\(analyzeAllLeaguesWorkflow/, 'job API must start the durable four-league workflow');
assert.match(route, /new Set\(leagues\)\.size === leagues\.length/, 'batch leagues must be unique');
assert.match(route, /requestedLeague[\s\S]*result\?\.batches[\s\S]*find\(value => value\?\.league === requestedLeague\)/, 'one league tab must retrieve only its own batch result');
assert.match(route, /summaryOnly[\s\S]*result\.batches\.map[\s\S]*results: \(batch\.results \|\| \[\]\)\.map/, 'global progress polling must omit large per-game analysis payloads');
assert.match(page, /一鍵分析全部聯盟/, 'the UI needs one all-league action');
assert.match(page, /for \(const id of LEAGUE_IDS\)[\s\S]*allLeagueTargetDate\(id,[\s\S]*prepareAllLeagueBatch\(id, batchDate\)/, 'every league must resolve and precheck its own Reader board date');
assert.match(page, /mode: 'all-leagues'[\s\S]*batches: batches\.map/, 'the client must submit one isolated batch per prepared league');
assert.match(page, /const BACKGROUND_JOB_START_TIMEOUT_MS = 75_000/, 'workflow submission timeout must exceed the 60 second server route ceiling');
assert.match(page, /mode: 'all-leagues'[\s\S]*\}, BACKGROUND_JOB_START_TIMEOUT_MS\)/, 'all-league submission must not abort before the server route ceiling');
assert.match(page, /league: batch\.league,[\s\S]*date: batch\.date,[\s\S]*emptyReason: batch\.emptyReason/, 'each submitted league batch must retain its own date');
assert.match(route, /const batchDate = cleanText\(batch\?\.date, 20\)[\s\S]*date: batchDate/, 'the server must not replace every league date with the MLB outer date');
assert.match(page, /saveBackgroundJob\(\{[\s\S]*batchMode: 'all-leagues'[\s\S]*league: batch\.league,[\s\S]*date: batch\.date,[\s\S]*preparedBoard/, 'each league must retain reconnect metadata, date and prepared slate');
assert.match(page, /mergePreparedLeagueBoard\(current, saved\.preparedBoard\)/, 'switching to a league must restore its independent slate without deleting cached scores');
assert.match(page, /completedDisplayRows[\s\S]*preserveCompletedReaderResult/, 'a completed job must remain visible when Reader temporarily becomes empty or advances');
const completedRetentionBranch = page.slice(page.indexOf('const completedDisplayRows'), page.indexOf('if (!applicableRows.length)', page.indexOf('const completedDisplayRows')));
assert.doesNotMatch(completedRetentionBranch, /sort\(byStartTime\)/, 'completed result retention must not reference a comparator scoped inside another function');
assert.match(completedRetentionBranch, /Date\.parse\(left\?\.game\?\.gameDate/, 'completed retained rows need an in-scope chronological comparator');
assert.match(page, /analysis-jobs\?runId=\$\{encodeURIComponent\(runId\)\}&league=\$\{encodeURIComponent\(league\)\}/, 'visible polling must request only the selected league result');
assert.match(page, /const expectedRunId = allLeagueRun\.runId[\s\S]*analysis-jobs\?runId=\$\{encodeURIComponent\(expectedRunId\)\}&summary=1/, 'four-league progress polling must request the compact summary for the captured run only');
assert.doesNotMatch(page, /leagueTabs[\s\S]{0,900}disabled=\{(?:busy|allLeague)/, 'league tabs must remain switchable during all-league analysis');

console.log('Durable isolated one-click analysis for MLB, NPB, KBO and CPBL PASS');
