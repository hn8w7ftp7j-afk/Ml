import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { referenceGameMap } from '../lib/reference-acquisition-evidence.js';
import * as cache from '../lib/analysis-board-cache-v1.js';
import * as receipts from '../lib/analysis-completed-receipt-v1.js';
import { analysisHasCalculatedDirections } from '../lib/analysis-display-state-v116.js';
import { allLeagueBoardDate, createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague } from '../lib/all-league-analysis-v117.js';
import { LEAGUE_IDS, normalizeLeagueId } from '../lib/leagues.js';

// Execute the real page's preparation, submission, storage and reconnect code.
// These are explicit provider-shaped stress fixtures, never live odds/results.
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const BOARD_KEY = 'sports-positive-ev-analysis-board-v1';
const JOB_KEY = 'sports-positive-ev-background-jobs-v1';
const RUN_KEY = 'sports-positive-ev-all-league-analysis-v1';
const BET_KEY = 'isolated-existing-ledger';
const NOW = Date.now();
const DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(NOW));
const NEXT_DATE = new Date(Date.parse(`${DATE}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const COUNTS = { MLB: 10, NPB: 3, KBO: 4, CPBL: 3 };
let passed = 0;
const bytes = rows => [...rows].reduce((sum, [key, value]) => sum + 2 * (key.length + value.length), 0);

function functionSource(name, indentation = '') {
  const prefixes = [`${indentation}function ${name}(`, `${indentation}async function ${name}(`];
  const start = prefixes.map(prefix => page.indexOf(prefix)).find(index => index >= 0);
  const end = page.indexOf(`\n${indentation}}\n`, start);
  assert.ok(start >= 0 && end > start, name);
  return page.slice(start, end + indentation.length + 2);
}

class MemoryStorage {
  rows = new Map();
  limit = Infinity;
  denied = false;
  deniedRead = false;
  ignoreWrites = false;
  attempts = [];
  getItem(key) {
    if (this.deniedRead) throw new Error('isolated SecurityError');
    return this.rows.get(key) ?? null;
  }
  setItem(key, value) {
    const candidate = new Map(this.rows).set(key, String(value));
    this.attempts.push({ key, size: bytes(candidate) });
    if (this.denied || bytes(candidate) > this.limit) throw Object.assign(new Error('isolated quota'), { name: 'QuotaExceededError' });
    if (!this.ignoreWrites) this.rows = candidate;
  }
  removeItem(key) { this.rows.delete(key); }
}

function game(league, index) {
  const date = league === 'MLB' ? NEXT_DATE : DATE;
  return { league, leagueId: league, gamePk: 800000 + LEAGUE_IDS.indexOf(league) * 1000 + index,
    providerGameId: `isolated:${league}:${index}`, taipeiDate: date, officialDate: date,
    gameDate: `${date}T12:00:00+08:00`, status: '尚未開賽', statusCode: 'S',
    away: `fixture away ${index}`, home: `fixture home ${index}`, awayTeamId: index * 2 + 1,
    homeTeamId: index * 2 + 2, awayProbable: 'fixture away pitcher', homeProbable: 'fixture home pitcher',
    gameNumber: 1, doubleHeader: 'N', awayScore: null, homeScore: null };
}

const verificationMarkets = Array.from({ length: 120 }, (_, index) => ({
  market: index % 2 ? '全場大小' : '全場讓分', pick: `fixture ${index}`, water: 0.93,
  sourceType: 'REFERENCE_ONLY', rawText: `source-fixture-${index}:`.repeat(80),
  referenceBookProbabilities: Array.from({ length: 32 }, (_, book) => ({
    bookmakerKey: `isolated-book-${book}`, observedAt: new Date(NOW - 1000).toISOString(), probability: 0.51,
  })),
}));

function sandbox(storage = new MemoryStorage()) {
  const context = vm.createContext({ ...cache, ...receipts, analysisHasCalculatedDirections, referenceGameMap,
    allLeagueBoardDate, createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague, LEAGUE_IDS, normalizeLeagueId,
    Date, Map, Set, Number, String, Array, JSON, encodeURIComponent,
    backgroundJobsInMemory: new Map(), supersededBackgroundRuns: new Set(), window: { localStorage: storage },
    safeParse: value => { try { return JSON.parse(value); } catch { return null; } },
    ANALYSIS_BOARD_CACHE_STORAGE: BOARD_KEY, ANALYSIS_JOB_STORAGE: JOB_KEY, ALL_LEAGUE_ANALYSIS_STORAGE: RUN_KEY,
  });
  for (const name of ['backgroundJobKey', 'loadAnalysisBoardCache', 'loadBackgroundJob', 'saveBackgroundJob', 'clearBackgroundJob']) {
    vm.runInContext(functionSource(name), context);
  }
  return context;
}

function submissionHarness(storage = new MemoryStorage()) {
  const context = sandbox(storage);
  const prepared = [];
  const submitted = [];
  const notices = [];
  Object.assign(context, {
    league: 'CPBL', date: DATE, allLeagueRun: null, allLeagueRunning: false,
    leagueDatesRef: { current: Object.fromEntries(LEAGUE_IDS.map(id => [id, id === 'MLB' ? NEXT_DATE : DATE])) },
    allLeagueBusyRef: { current: false }, readerPollBusyRef: { current: false }, operationBusyRef: { current: false },
    analysisGenerationRef: { current: 1 }, restoredBoardNeedsValidationRef: { current: false }, manualAnalysisScopesRef: { current: new Set() },
    submittedAllLeagueRunRef: { current: null },
    allLeagueTargetDate: async (league, date) => date,
    leagueConfig: () => ({ label: 'isolated league', capabilities: { analysis: true, reader: true } }),
    fetchScheduleForLeague: async league => Array.from({ length: COUNTS[league] }, (_, index) => game(league, index)),
    fetchReferenceLines: async games => ({ games: games.map(game => ({ gamePk: game.gamePk, markets: verificationMarkets })) }),
    requestJSONWithTransientRetry: async (url, options) => {
      assert.equal(url, '/api/credit-lines');
      const request = JSON.parse(options.body);
      return { provider: 'TAI888_READER_AUTO', readerFresh: true, blocked: false, payloadHash: 'isolated-reader',
        games: request.schedule.map(game => ({ gamePk: game.gamePk,
          markets: [{ market: '全場大小', pick: '大8.5', water: 0.93 }],
          source: { provider: 'TAI888_READER_AUTO', rawText: 'source evidence fixture'.repeat(8000) },
          marketCoverage: { open: 8 }, readerProvenance: { payloadHash: 'isolated-reader' },
        })), unopenedGames: [] };
    },
    uid: () => 'isolated-request', loadAllLeagueAnalysisRun: () => null, clearAllLeagueBackgroundJobs: () => {},
    markAppOperationBusy: () => {}, setAllLeaguePreparing: () => {}, setBackgroundJobRevision: () => {}, setError: () => {},
    setNotice: value => notices.push(value), publishAllLeagueRun: value => { context.allLeagueRun = value; },
    startBackgroundAnalysisJob: async value => { submitted.push(value); return { runId: 'isolated-four-leagues' }; },
  });
  vm.runInContext(functionSource('prepareAllLeagueBatch', '  '), context);
  const prepare = context.prepareAllLeagueBatch;
  context.prepareAllLeagueBatch = async (...args) => {
    const value = await prepare(...args);
    prepared.push(value);
    return value;
  };
  vm.runInContext(functionSource('oneClickAnalyzeAll', '  '), context);
  return { context, storage, prepared, submitted, notices };
}

async function test(name, action) { await action(); passed += 1; console.log(`PASS ${name}`); }

await test('real four-league preparation saves all 20 handles under quota while preserving workflow payloads', async () => {
  const state = submissionHarness();
  state.storage.limit = 64 * 1024;
  assert.equal(await state.context.oneClickAnalyzeAll(), true);
  const original = JSON.stringify(state.prepared);
  assert.ok(original.length > 5 * 1024 * 1024, 'fixture must reproduce oversized source and verification arrays');
  const saved = JSON.parse(state.storage.getItem(JOB_KEY));
  assert.equal(Object.keys(saved).length, 4);
  assert.ok(state.notices.at(-1).includes('自由切換聯盟'));
  const remounted = sandbox(state.storage);
  for (const id of LEAGUE_IDS) {
    const date = id === 'MLB' ? NEXT_DATE : DATE;
    const row = saved[`${id}|||${date}`];
    const batch = state.prepared.find(batch => batch.league === id);
    assert.equal(row.gamePks.length, COUNTS[id]);
    assert.deepEqual(row.gamePks, batch.tasks.map(task => task.game.gamePk));
    assert.equal(remounted.loadBackgroundJob(id, date).runId, 'isolated-four-leagues');
    for (let index = 0; index < row.preparedBoard.length; index += 1) {
      assert.deepEqual(row.preparedBoard[index].game, batch.preparedBoard[index].game);
      assert.equal(row.preparedBoard[index].status, batch.preparedBoard[index].status);
      assert.equal(row.preparedBoard[index].statusLabel, batch.preparedBoard[index].statusLabel);
      assert.equal(row.preparedBoard[index].readerPayloadHash, null);
      assert.equal(row.preparedBoard[index].verificationMarkets, undefined);
      assert.equal(row.preparedBoard[index].actualSource, undefined);
    }
    assert.equal(state.submitted[0].batches.find(batch => batch.league === id).tasks[0].verificationMarkets.length, 120);
  }
  assert.equal(JSON.stringify(state.prepared), original, 'persistence cannot mutate real workflow or prepared inputs');
  console.log(`Storage evidence: ${Buffer.byteLength(original)} original prepared bytes; ${Buffer.byteLength(state.storage.getItem(JOB_KEY))} durable job bytes.`);
});

await test('legacy large prepared boards compact together without changing any completed receipt evidence', () => {
  const storage = new MemoryStorage();
  const context = sandbox(storage);
  const old = { runId: 'old-npb', league: 'NPB', date: DATE, startedAt: new Date(NOW - 1000).toISOString(),
    gamePks: [game('NPB', 0).gamePk], total: 1, resultMetadata: { W: 0, R: -0.021, S: 7.125 },
    preparedBoard: [{ game: game('NPB', 0), status: 'queued', verificationMarkets, actualSource: { raw: 'fixture'.repeat(50000) } }] };
  const receipt = { completedReceipt: true, league: 'KBO', date: DATE, runId: 'completed-kbo', completedAt: new Date(NOW).toISOString(),
    gamePks: [803000], gameVersions: { 803000: { fingerprint: '["pit","input","distribution","price","model","score"]', analysisAsOf: new Date(NOW - 1000).toISOString() } },
    resultMetadata: { exact: [0, -0.01, 0.12345678901234566] } };
  storage.setItem(JOB_KEY, JSON.stringify({ [`NPB|||${DATE}`]: old, [`KBO|||${DATE}`]: receipt }));
  storage.limit = 8192;
  const original = JSON.stringify({ old, receipt });
  assert.equal(context.saveBackgroundJob({ runId: 'new-cpbl', league: 'CPBL', date: DATE, gamePks: [804000], startedAt: new Date(NOW).toISOString() }), true);
  const saved = JSON.parse(storage.getItem(JOB_KEY));
  assert.deepEqual(saved[`KBO|||${DATE}`], receipt);
  assert.deepEqual(saved[`NPB|||${DATE}`].resultMetadata, old.resultMetadata);
  assert.equal(saved[`NPB|||${DATE}`].preparedBoard[0].verificationMarkets, undefined);
  assert.equal(JSON.stringify({ old, receipt }), original);
});

await test('quota fallback removes loading cards only and never evicts another retained run or unrelated storage', async () => {
  const state = submissionHarness();
  await state.context.oneClickAnalyzeAll();
  const before = JSON.parse(state.storage.getItem(JOB_KEY));
  state.storage.setItem(BOARD_KEY, 'immutable existing board');
  state.storage.setItem(BET_KEY, 'immutable existing bets');
  const handles = Object.fromEntries(Object.entries(before).map(([key, value]) => { const { preparedBoard, ...handle } = value; return [key, handle]; }));
  const expectedRows = new Map(state.storage.rows).set(JOB_KEY, JSON.stringify(handles));
  state.storage.limit = bytes(expectedRows) + 64;
  const attemptsBefore = state.storage.attempts.length;
  assert.equal(state.context.saveBackgroundJob(before[`CPBL|||${DATE}`]), true);
  const saved = JSON.parse(state.storage.getItem(JOB_KEY));
  assert.deepEqual(saved, handles);
  assert.ok(state.storage.attempts.length >= attemptsBefore + 2);
  assert.equal(state.storage.getItem(BOARD_KEY), 'immutable existing board');
  assert.equal(state.storage.getItem(BET_KEY), 'immutable existing bets');
  for (const id of LEAGUE_IDS) assert.equal(sandbox(state.storage).loadBackgroundJob(id, id === 'MLB' ? NEXT_DATE : DATE).runId, 'isolated-four-leagues');
});

await test('denied durable writes still reconnect every league in this tab without claiming reload survival', async () => {
  const state = submissionHarness();
  state.storage.denied = true;
  await state.context.oneClickAnalyzeAll();
  assert.ok(state.notices.at(-1).includes('無法保存工作編號'));
  assert.equal(state.storage.getItem(JOB_KEY), null);
  for (const id of LEAGUE_IDS) {
    const date = id === 'MLB' ? NEXT_DATE : DATE;
    assert.equal(state.context.loadBackgroundJob(id, date).runId, 'isolated-four-leagues');
    assert.equal(sandbox(state.storage).loadBackgroundJob(id, date), null, 'a new document has no durable handle');
  }
  assert.equal(state.context.loadBackgroundJob('CPBL', NEXT_DATE), null);
  assert.equal(state.context.loadBackgroundJob('NHL', DATE), null);
});

await test('a silently discarded write fails read-back confirmation while memory keeps the exact current handle', () => {
  const storage = new MemoryStorage();
  storage.ignoreWrites = true;
  const context = sandbox(storage);
  const value = { runId: 'not-durable', league: 'NPB', date: DATE, gamePks: [800001], startedAt: new Date(NOW).toISOString() };
  assert.equal(context.saveBackgroundJob(value), false);
  assert.equal(storage.getItem(JOB_KEY), null);
  assert.equal(context.loadBackgroundJob('NPB', DATE).runId, value.runId);
});

await test('unavailable Storage cannot block scoped memory reads or make stale cleanup delete a newer run', () => {
  const storage = new MemoryStorage();
  storage.denied = true;
  storage.deniedRead = true;
  const context = sandbox(storage);
  for (const league of ['NPB', 'CPBL']) {
    assert.equal(context.saveBackgroundJob({ runId: `new-${league}`, league, date: DATE, gamePks: [800001] }), false);
  }
  context.clearBackgroundJob('NPB', DATE, 'old-npb');
  assert.equal(context.loadBackgroundJob('NPB', DATE).runId, 'new-NPB');
  context.clearBackgroundJob('NPB', DATE, 'new-NPB');
  assert.equal(context.loadBackgroundJob('NPB', DATE), null);
  assert.equal(context.loadBackgroundJob('CPBL', DATE).runId, 'new-CPBL');
});

await test('newer durable state from another tab outranks older memory when reading and preserving sibling jobs', () => {
  const storage = new MemoryStorage();
  const context = sandbox(storage);
  context.saveBackgroundJob({ runId: 'old-memory', league: 'NPB', date: DATE, startedAt: new Date(NOW - 2000).toISOString() });
  const newer = { runId: 'new-other-tab', league: 'NPB', date: DATE, startedAt: new Date(NOW).toISOString(), gamePks: [800099] };
  storage.setItem(JOB_KEY, JSON.stringify({ [`NPB|||${DATE}`]: newer }));
  assert.equal(context.loadBackgroundJob('NPB', DATE).runId, newer.runId);
  context.saveBackgroundJob({ runId: 'cpbl-now', league: 'CPBL', date: DATE, startedAt: new Date(NOW).toISOString() });
  assert.deepEqual(JSON.parse(storage.getItem(JOB_KEY))[`NPB|||${DATE}`], newer);
});

await test('completed memory-only replacement cannot resurrect an older pending disk run after scoped cleanup', () => {
  const storage = new MemoryStorage();
  const context = sandbox(storage);
  const old = { runId: 'old-disk', league: 'NPB', date: DATE, gamePks: [game('NPB', 0).gamePk], startedAt: new Date(NOW - 5000).toISOString() };
  assert.equal(context.saveBackgroundJob(old), true);
  storage.denied = true;
  assert.equal(context.saveBackgroundJob({ ...old, runId: 'new-memory', startedAt: new Date(NOW - 1000).toISOString() }), false);
  assert.equal(context.loadBackgroundJob('NPB', DATE).runId, 'new-memory');
  // The separate, small completed-receipt key can be durable even when the
  // pending-job key still contains the old handle. Exact results are visible.
  const currentGame = game('NPB', 0);
  const payload = { league: 'NPB', game: currentGame, analysis: { inputHash: 'new-input', distributionHash: 'new-distribution',
    priceFingerprint: 'new-price', analysisAsOf: new Date(NOW - 1000).toISOString(),
    results: [{ status: 'CALCULATED', modelEV: 0, robustEV: -0.01, formulaDiagnosticScore: 7.125 }] } };
  const receipt = receipts.createCompletedAnalysisReceipt({ runId: 'new-memory', league: 'NPB', date: DATE },
    { league: 'NPB', date: DATE, results: [{ ok: true, task: { league: 'NPB', date: DATE, game: currentGame }, payload }] });
  assert.ok(receipt);
  storage.rows.set(receipts.ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY, JSON.stringify([receipt]));
  storage.rows.set(RUN_KEY, JSON.stringify({ runId: 'old-disk', state: 'completed', date: DATE,
    completedAt: new Date(NOW - 2000).toISOString(), leagues: {
      NPB: { boardDate: DATE, total: 1, resultLoaded: false },
      CPBL: { boardDate: DATE, total: 3, resultLoaded: false },
    } }));
  context.clearBackgroundJob('NPB', DATE, 'new-memory');
  const visible = [{ game: currentGame, customData: payload }];
  assert.equal(context.loadBackgroundJob('NPB', DATE, visible), null);
  assert.equal(context.loadBackgroundJob('NPB', DATE).runId, 'new-memory', 'missing results must recover the receipt rather than superseded pending work');
  assert.equal(JSON.parse(storage.getItem(JOB_KEY))[`NPB|||${DATE}`].runId, 'old-disk', 'no unrelated old persisted record is silently overwritten after a denied write');

  // Actual quota can permit the smaller cleanup even when replacing the old
  // job with a new slate did not fit. That cleanup must survive a route reload.
  context.backgroundJobsInMemory.set(`NPB|||${DATE}`, { ...old, runId: 'new-memory', startedAt: new Date(NOW - 1000).toISOString() });
  storage.denied = false;
  storage.limit = bytes(storage.rows) + 128;
  context.clearBackgroundJob('NPB', DATE, 'new-memory');
  assert.equal(JSON.parse(storage.getItem(JOB_KEY))[`NPB|||${DATE}`], undefined);
  assert.equal(sandbox(storage).loadBackgroundJob('NPB', DATE, visible), null);
  assert.deepEqual(JSON.parse(storage.getItem(receipts.ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY)), [receipt]);
  const summary = JSON.parse(storage.getItem(RUN_KEY));
  assert.equal(summary.leagues.NPB.resultSuperseded, true);
  assert.equal(summary.leagues.CPBL.resultSuperseded, undefined);
  assert.equal(sandbox(storage).loadBackgroundJob('CPBL', DATE).runId, 'old-disk', 'another league may still recover its own old batch');
});

console.log(`Background job storage: ${passed} real-handler quota/read-back/memory groups PASS; no live browser storage or provider writes.`);
