import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LEAGUE_IDS } from '../lib/leagues.js';
import { createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague } from '../lib/all-league-analysis-v117.js';

// Execute the actual page's resolver and four-league submission flow. Provider
// responses and the workflow submission are isolated mocks; no live writes.
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const TODAY = '2026-09-06';
const MLB_DATE = '2026-09-07';
let passed = 0;

function functionSource(name) {
  const start = page.indexOf(`  async function ${name}(`);
  const end = page.indexOf('\n  }\n', start);
  assert.ok(start >= 0 && end > start, `${name} must remain executable in the regression harness`);
  return page.slice(start, end + 4);
}

function harness({ manual = [], latest = id => ({ fresh: true, boardDate: id === 'MLB' ? MLB_DATE : TODAY }) } = {}) {
  const requested = [];
  const prepared = [];
  const saved = [];
  const submitted = [];
  const context = vm.createContext({
    Date, Number, String, encodeURIComponent, LEAGUE_IDS, createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague,
    manualDateSelectionRef: { current: new Set(manual) },
    leagueDatesRef: { current: Object.fromEntries(LEAGUE_IDS.map(id => [id, TODAY])) },
    requestJSONWithTransientRetry: async url => {
      const id = new URL(url, 'https://isolated.test').searchParams.get('league');
      requested.push(id);
      return latest(id);
    },
    // A full route mount while CPBL is visible initializes hidden MLB to today.
    league: 'CPBL', date: TODAY, allLeagueRun: null, allLeagueRunning: false,
    readerPollBusyRef: { current: false }, allLeagueBusyRef: { current: false }, operationBusyRef: { current: false },
    analysisGenerationRef: { current: 1 }, restoredBoardNeedsValidationRef: { current: false },
    manualAnalysisScopesRef: { current: new Set() },
    submittedAllLeagueRunRef: { current: null },
    loadAllLeagueAnalysisRun: () => null, clearAllLeagueBackgroundJobs: () => {}, clearBackgroundJob: () => {},
    markAppOperationBusy: () => {}, setAllLeaguePreparing: () => {}, setNotice: () => {}, setError: () => {},
    publishAllLeagueRun: value => { context.allLeagueRun = value; }, setBackgroundJobRevision: () => {},
    prepareAllLeagueBatch: async (id, date) => {
      prepared.push({ id, date });
      const total = id === 'MLB' ? (date === MLB_DATE ? 9 : 0) : { NPB: 4, KBO: 5, CPBL: 3 }[id];
      return { league: id, date, preparedBoard: [], emptyReason: total ? null : 'no_games',
        tasks: Array.from({ length: total }, (_, index) => ({ game: { league: id, gamePk: 1000 + index } })) };
    },
    startBackgroundAnalysisJob: async payload => { submitted.push(payload); return { runId: 'isolated-date-run' }; },
    saveBackgroundJob: value => { saved.push(value); return true; },
  });
  for (const name of ['allLeagueTargetDate', 'oneClickAnalyzeAll']) vm.runInContext(functionSource(name), context);
  return { context, requested, prepared, saved, submitted };
}

async function test(name, action) { await action(); passed += 1; console.log(`PASS ${name}`); }

await test('hidden MLB uses its fresh next-day Reader board after a full route mount on CPBL', async () => {
  const state = harness();
  assert.equal(await state.context.oneClickAnalyzeAll(), true);
  assert.equal(state.context.submittedAllLeagueRunRef.current, 'isolated-date-run', 'only an explicitly submitted run authorizes automatic full-result delivery');
  assert.deepEqual([...state.requested].sort(), [...LEAGUE_IDS].sort(), 'all four leagues must consult their own latest Reader status');
  assert.deepEqual(state.prepared.find(row => row.id === 'MLB'), { id: 'MLB', date: MLB_DATE });
  const mlb = state.submitted[0].batches.find(batch => batch.league === 'MLB');
  assert.equal(mlb.date, MLB_DATE);
  assert.equal(mlb.tasks.length, 9, 'the latest MLB slate may not be lost as an empty current-day batch');
  for (const id of ['NPB', 'KBO', 'CPBL']) {
    assert.equal(state.submitted[0].batches.find(batch => batch.league === id).date, TODAY);
  }
  assert.equal(state.saved.find(job => job.league === 'MLB').date, MLB_DATE, 'the reconnect handle must use the same resolved board date');
  assert.equal(state.context.allLeagueRun.leagues.MLB.boardDate, MLB_DATE);
  assert.equal(state.context.leagueDatesRef.current.MLB, MLB_DATE);
});

await test('an explicitly selected league date remains authoritative for all four leagues', async () => {
  for (const id of LEAGUE_IDS) {
    const state = harness({ manual: [id] });
    assert.equal(await state.context.allLeagueTargetDate(id, TODAY), TODAY);
    assert.deepEqual(state.requested, [], 'manual selection must not be replaced by automatic Reader discovery');
  }
  const state = harness({ manual: ['MLB'] });
  await state.context.oneClickAnalyzeAll();
  assert.equal(state.submitted[0].batches.find(batch => batch.league === 'MLB').date, TODAY);
  assert.equal(state.submitted[0].batches.find(batch => batch.league === 'MLB').emptyReason, 'no_games');
  assert.deepEqual([...state.requested].sort(), ['CPBL', 'KBO', 'NPB']);
});

await test('fresh Reader discovery moves forward only and never rolls a league back to an older board', async () => {
  for (const id of LEAGUE_IDS) {
    for (const readerDate of ['2026-09-05', TODAY, MLB_DATE]) {
      const state = harness({ latest: () => ({ fresh: true, boardDate: readerDate }) });
      assert.equal(await state.context.allLeagueTargetDate(id, TODAY), readerDate > TODAY ? readerDate : TODAY);
    }
  }
});

await test('stale, unavailable and rejected Reader status retain the selected date', async () => {
  for (const latest of [
    () => ({ fresh: false, boardDate: MLB_DATE }),
    () => ({ boardDate: MLB_DATE }),
    () => null,
    () => { throw Object.assign(new Error('isolated unavailable source'), { status: 503 }); },
    () => { throw Object.assign(new Error('isolated rejected source'), { status: 403 }); },
  ]) {
    const state = harness({ latest });
    assert.equal(await state.context.allLeagueTargetDate('MLB', TODAY), TODAY);
  }
});

await test('malformed or impossible calendar dates cannot become a new all-league board', async () => {
  for (const boardDate of ['2026-02-30', '2026-13-01', '2026-9-07', '', '2026-09-07T00:00:00Z']) {
    const state = harness({ latest: () => ({ fresh: true, boardDate }) });
    assert.equal(await state.context.allLeagueTargetDate('MLB', '2026-01-01'), '2026-01-01');
  }
});

await test('one unavailable league date lookup does not change or prevent the other leagues from submitting', async () => {
  const state = harness({ latest: id => {
    if (id === 'MLB') throw new Error('isolated MLB Reader unavailable');
    return { fresh: true, boardDate: TODAY };
  } });
  assert.equal(await state.context.oneClickAnalyzeAll(), true);
  assert.equal(state.submitted[0].batches.find(batch => batch.league === 'MLB').date, TODAY);
  assert.deepEqual([...state.submitted[0].batches.filter(batch => batch.league !== 'MLB').map(batch => batch.tasks.length)], [4, 5, 3]);
});

console.log(`All-league Reader dates: ${passed} groups passed; actual page functions, isolated sources and workflow submission.`);
