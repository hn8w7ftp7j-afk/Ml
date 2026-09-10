import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as cache from '../lib/analysis-board-cache-v1.js';
import * as receipts from '../lib/analysis-completed-receipt-v1.js';
import { analysisHasCalculatedDirections } from '../lib/analysis-display-state-v116.js';
import { allLeagueBoardDate, preserveCompletedReaderResult } from '../lib/all-league-analysis-v117.js';
import { normalizeLeagueId } from '../lib/leagues.js';

// Execute the real page persistence/recovery functions with an isolated Storage
// implementation. No browser state, provider, Production API or database is read.
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const BOARD_KEY = 'sports-positive-ev-analysis-board-v1';
const JOB_KEY = 'sports-positive-ev-background-jobs-v1';
const RUN_KEY = 'sports-positive-ev-all-league-analysis-v1';
const RECEIPT_KEY = receipts.ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY;
const DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const NOW = Date.now();
let passed = 0;

function functionSource(name, indentation = '') {
  const prefix = `${indentation}function ${name}(`;
  const asyncPrefix = `${indentation}async function ${name}(`;
  const at = page.indexOf(prefix) >= 0 ? page.indexOf(prefix) : page.indexOf(asyncPrefix);
  assert.ok(at >= 0, name);
  const end = page.indexOf(`\n${indentation}}\n`, at);
  assert.ok(end > at, name);
  return page.slice(at, end + indentation.length + 2);
}

class MemoryStorage {
  rows = new Map();
  limit = Infinity;
  deniedKey = null;
  getItem(key) { return this.rows.get(key) ?? null; }
  removeItem(key) { this.rows.delete(key); }
  setItem(key, value) {
    const candidate = new Map(this.rows).set(key, String(value));
    const size = [...candidate].reduce((sum, [entryKey, entry]) => sum + 2 * (entryKey.length + entry.length), 0);
    if (key === this.deniedKey || size > this.limit) throw Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' });
    this.rows = candidate;
  }
}

function row(pk, { league = 'NPB', revision = 'original', asOf = NOW - 60_000 } = {}) {
  const game = { league, leagueId: league, gamePk: pk, taipeiDate: DATE,
    gameDate: `${DATE}T12:00:00+08:00`, away: 'synthetic away', home: 'synthetic home' };
  const analysis = {
    pitSnapshotId: `${league}:${pk}:${revision}`,
    inputHash: `input-${revision}`, distributionHash: `distribution-${revision}`, priceFingerprint: `price-${revision}`,
    analysisAsOf: new Date(asOf).toISOString(), calculatedDirectionCount: 8,
    results: Array.from({ length: 8 }, (_, index) => ({ slotId: `slot-${index}`, status: 'CALCULATED',
      modelEV: index % 2 ? -0.012 : 0.027, robustEV: -0.021, formulaDiagnosticScore: 7.125,
      sourceType: 'ACTUAL_TW_CREDIT', qa: { status: 'WARNING', reasons: ['storage fixture only'] } })),
    distributionEvidence: { immutableNumbers: [0, 0.12345678901234566, -0.27], source: 'synthetic-storage-test' },
  };
  const payload = { league, game, analysis, pitPersistence: { confirmed: true, snapshotId: analysis.pitSnapshotId }, openMarkets: [] };
  return { ok: true, task: { league, date: DATE, game, actualMarkets: [], readerPayloadHash: 'old-reader-version' }, payload };
}
const item = result => ({ game: result.task.game, actualSource: { provider: 'TAI888_READER_AUTO' },
  readerPayloadHash: 'old-reader-version', customData: result.payload, referenceData: result.payload });
const result = (rows, league = 'NPB') => ({ league, date: DATE, total: rows.length, completed: rows.length, results: rows });

function sandbox(storage = new MemoryStorage()) {
  const context = vm.createContext({ ...cache, ...receipts, normalizeLeagueId, allLeagueBoardDate, analysisHasCalculatedDirections,
    preserveCompletedReaderResult, console, Date, Map, Set, Number, JSON, Array, String,
    window: { localStorage: storage, setTimeout, clearTimeout },
    backgroundJobsInMemory: new Map(), supersededBackgroundRuns: new Set(),
    safeParse: value => { try { return JSON.parse(value); } catch { return null; } },
    ANALYSIS_BOARD_CACHE_STORAGE: BOARD_KEY, ANALYSIS_JOB_STORAGE: JOB_KEY, ALL_LEAGUE_ANALYSIS_STORAGE: RUN_KEY,
  });
  for (const name of ['loadAnalysisBoardCache', 'saveAnalysisBoardCache', 'backgroundJobKey', 'saveBackgroundJob',
    'clearBackgroundJob', 'saveCompletedAnalysisReceipt', 'clearCompletedAnalysisReceipt', 'markBackgroundResultUnavailable', 'loadBackgroundJob']) {
    vm.runInContext(functionSource(name), context);
  }
  return context;
}

async function test(name, action) { await action(); passed += 1; console.log(`PASS ${name}`); }

await test('quota failure preserves other league boards atomically and a receipt recovers all missing games', () => {
  const storage = new MemoryStorage();
  const context = sandbox(storage);
  const cpbl = [row(701001, { league: 'CPBL' }), row(701002, { league: 'CPBL' })];
  const npb = [row(501001), row(501002), row(501003), row(501004)];
  assert.equal(context.saveAnalysisBoardCache('CPBL', DATE, cpbl.map(item)), true);
  const prior = storage.getItem(BOARD_KEY);
  assert.equal(context.saveCompletedAnalysisReceipt({ runId: 'run-npb-complete', league: 'NPB', date: DATE }, result(npb)).stored, true);
  const npbOnly = JSON.stringify(cache.upsertAnalysisBoardCache({}, cache.createAnalysisBoardCacheEntry({ league: 'NPB', date: DATE, board: npb.map(item) })));
  // Enough capacity for NPB alone, but not for deleting CPBL to make NPB fit.
  storage.limit = 2 * (BOARD_KEY.length + npbOnly.length + RECEIPT_KEY.length + storage.getItem(RECEIPT_KEY).length) + 32;
  assert.equal(context.saveAnalysisBoardCache('NPB', DATE, npb.map(item)), false);
  assert.equal(storage.getItem(BOARD_KEY), prior, 'quota handling must not silently evict CPBL');
  const recovered = context.loadBackgroundJob('NPB', DATE);
  assert.equal(recovered.runId, 'run-npb-complete');
  assert.deepEqual([...recovered.missingGamePks], npb.map(value => value.task.game.gamePk));
  assert.equal(context.loadBackgroundJob('CPBL', DATE), null);
});

await test('partial or wrong-version cache resumes the completed run; exact complete cache does not refetch', () => {
  const context = sandbox();
  const rows = [row(501011), row(501012), row(501013), row(501014)];
  context.saveCompletedAnalysisReceipt({ runId: 'run-partial', league: 'NPB', date: DATE }, result(rows));
  context.saveAnalysisBoardCache('NPB', DATE, rows.slice(0, 2).map(item));
  assert.deepEqual([...context.loadBackgroundJob('NPB', DATE).missingGamePks], [501013, 501014]);
  assert.equal(context.loadBackgroundJob('NPB', DATE, rows.map(item)), null, 'visible complete results must stop replay even when disk is partial');
  context.saveAnalysisBoardCache('NPB', DATE, rows.map(item));
  assert.equal(context.loadBackgroundJob('NPB', DATE), null);
  const changed = row(501011, { revision: 'new', asOf: NOW - 1000 });
  context.saveCompletedAnalysisReceipt({ runId: 'run-new-revision', league: 'NPB', date: DATE }, result([changed]));
  assert.deepEqual([...context.loadBackgroundJob('NPB', DATE).missingGamePks], [501011]);
});

await test('receipt-key quota falls back to the already durable job without claiming an unsaved receipt', () => {
  const storage = new MemoryStorage();
  const context = sandbox(storage);
  context.saveBackgroundJob({ runId: 'run-fallback', league: 'NPB', date: DATE, gamePks: [501021], preparedBoard: [item(row(501021))] });
  storage.deniedKey = RECEIPT_KEY;
  const saved = context.saveCompletedAnalysisReceipt({ runId: 'run-fallback', league: 'NPB', date: DATE }, result([row(501021)]));
  assert.equal(saved.stored, true);
  assert.equal(saved.retainJob, true);
  assert.equal(storage.getItem(RECEIPT_KEY), null);
  assert.equal(context.loadBackgroundJob('NPB', DATE).completedReceipt, true);
});

await test('a full fallback receipt store durably retains the newly saved key before reporting success', () => {
  const storage = new MemoryStorage();
  const context = sandbox(storage);
  for (let index = 0; index < 12; index += 1) {
    const league = ['MLB', 'NPB', 'KBO', 'CPBL'][index % 4];
    const oldDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(NOW - (Math.floor(index / 4) + 1) * 86_400_000));
    const previous = row(501200 + index, { league });
    previous.task.date = oldDate;
    previous.task.game.taipeiDate = oldDate;
    previous.task.game.gameDate = `${oldDate}T12:00:00+08:00`;
    const receipt = receipts.createCompletedAnalysisReceipt({ runId: `prior-${index}`, league, date: oldDate },
      { ...result([previous], league), date: oldDate });
    assert.ok(receipt);
    assert.equal(context.saveBackgroundJob(receipt), true);
  }
  assert.equal(Object.keys(JSON.parse(storage.getItem(JOB_KEY))).length, 12);
  storage.deniedKey = RECEIPT_KEY;
  const saved = context.saveCompletedAnalysisReceipt({ runId: 'new-thirteenth', league: 'NPB', date: DATE }, result([row(501299)]));
  assert.equal(saved.stored, true);
  assert.equal(saved.retainJob, true);
  const durable = JSON.parse(storage.getItem(JOB_KEY));
  assert.equal(Object.keys(durable).length, 12);
  assert.equal(durable[`NPB|||${DATE}`].runId, 'new-thirteenth');
  assert.equal(context.loadBackgroundJob('NPB', DATE).runId, 'new-thirteenth');
});

await test('versioned completed receipts outrank older terminal all-league runs while newer pending work stays first', () => {
  const storage = new MemoryStorage();
  const context = sandbox(storage);
  const latest = row(501025, { revision: 'latest-single', asOf: NOW - 10_000 });
  context.saveCompletedAnalysisReceipt({ runId: 'newer-single', league: 'NPB', date: DATE }, result([latest]));
  storage.setItem(RUN_KEY, JSON.stringify({ runId: 'old-four-league', date: DATE, state: 'completed',
    startedAt: new Date(NOW - 3_600_000).toISOString(), completedAt: new Date(NOW - 1_800_000).toISOString(),
    leagues: { NPB: { date: DATE, total: 1, resultLoaded: true } } }));
  assert.equal(context.loadBackgroundJob('NPB', DATE).runId, 'newer-single');
  assert.equal(storage.getItem(JOB_KEY), null, 'legacy summary may not overwrite the completed receipt with an older job');
  assert.equal(context.loadBackgroundJob('NPB', DATE, [item(latest)]), null, 'a restored visible board remains complete even when its durable cache did not fit');
  context.saveBackgroundJob({ runId: 'newer-running', league: 'NPB', date: DATE,
    startedAt: new Date(Date.now() + 1).toISOString(), gamePks: [501025] });
  assert.equal(context.loadBackgroundJob('NPB', DATE).runId, 'newer-running');
});

await test('foreign or old-date visible cards cannot mask recovery or be persisted under a new board scope', () => {
  const storage = new MemoryStorage();
  const context = sandbox(storage);
  const npb = item(row(501027));
  const cpbl = item(row(701027, { league: 'CPBL' }));
  storage.setItem(RUN_KEY, JSON.stringify({ runId: 'terminal-npb', date: DATE, state: 'completed',
    completedAt: new Date(NOW - 1000).toISOString(), leagues: { NPB: { date: DATE, total: 1, resultLoaded: true } } }));
  assert.equal(context.loadBackgroundJob('NPB', DATE, [cpbl]).runId, 'terminal-npb');
  assert.equal(context.saveAnalysisBoardCache('NPB', DATE, [npb]), true);
  const previous = storage.getItem(BOARD_KEY);
  assert.equal(context.saveAnalysisBoardCache('NPB', DATE, [cpbl]), false);
  assert.equal(context.saveAnalysisBoardCache('NPB', '2099-01-02', [npb]), false);
  assert.equal(storage.getItem(BOARD_KEY), previous, 'a stale render may not overwrite another league/date cache');
  const contaminated = cache.createAnalysisBoardCacheEntry({ league: 'NPB', date: DATE, board: [cpbl] });
  storage.setItem(BOARD_KEY, JSON.stringify({ [`NPB|||${DATE}`]: contaminated }));
  assert.equal(context.loadAnalysisBoardCache('NPB', DATE).length, 0, 'legacy wrongly labelled cache payloads must be filtered on read too');
  assert.equal(context.loadBackgroundJob('NPB', DATE, [cpbl]).runId, 'terminal-npb');
  storage.setItem(RUN_KEY, JSON.stringify({ runId: 'tomorrow-npb', date: '2099-01-02', state: 'completed',
    completedAt: new Date(NOW - 1000).toISOString(), leagues: { NPB: { date: '2099-01-02', total: 1, resultLoaded: true } } }));
  assert.equal(context.loadBackgroundJob('NPB', '2099-01-02', [npb]).runId, 'tomorrow-npb');
  assert.match(page, /const restoredBoard = storageReady \? \(allLeagueBoardsRef\.current\.get\(`\$\{league\}:\$\{date\}`\) \|\| loadAnalysisBoardCache\(league, date\)\) : \[\];\s*boardRef\.current = restoredBoard;/,
    'date hydration must update the ref before the same commit runs the reconnect effect');
});

await test('single-league pending jobs retain lightweight loading cards through a full route remount', async () => {
  const context = sandbox();
  Object.assign(context, { league: 'CPBL', uid: () => 'test-request', setProgress: () => {}, setNotice: () => {},
    startBackgroundAnalysisJob: async () => ({ runId: 'run-pending-cpbl' }), pollBackgroundJob: async () => ({ detached: true }) });
  vm.runInContext(functionSource('runDurableAnalysisTasks', '  '), context);
  await context.runDurableAnalysisTasks([row(701031, { league: 'CPBL' }).task, row(701032, { league: 'CPBL' }).task], 1, DATE);
  const restored = context.loadBackgroundJob('CPBL', DATE);
  assert.equal(restored.preparedBoard.length, 2);
  assert.ok(restored.preparedBoard.every(value => value.game.league === 'CPBL' && value.status === 'queued' && value.customData == null && value.readerPayloadHash == null));
});

async function pollHarness(rows, initial = [], receiptOverrides = {}) {
  const context = sandbox();
  const job = { runId: 'run-immutable', league: 'NPB', date: DATE };
  const receipt = receipts.createCompletedAnalysisReceipt(job, result(rows));
  context.saveCompletedAnalysisReceipt(job, result(rows));
  const expected = { ...receipt, missingGamePks: receipt.gamePks, ...receiptOverrides };
  let requests = 0;
  Object.assign(context, { league: 'NPB', boardRef: { current: initial }, currentDateRef: { current: DATE },
    analysisGenerationRef: { current: 1 }, backgroundJobPollsRef: { current: new Map() }, completedRecoveryFailuresRef: { current: new Set() },
    restoredBoardNeedsValidationRef: { current: true },
    setBoard: value => { context.boardRef.current = typeof value === 'function' ? value(context.boardRef.current) : value; },
    setSchedule: () => {}, setProgress: () => {}, setNotice: () => {}, releaseTerminalBackgroundCards: () => {},
    requestJSON: async () => { requests += 1; return { status: 'completed', result: result(rows) }; },
  });
  vm.runInContext(functionSource('compactAnalysisData'), context);
  vm.runInContext(functionSource('pollBackgroundJob', '  '), context);
  return { context, receipt: expected, count: () => requests };
}

await test('immutable replay replaces an older same-game snapshot without changing its W/R/S or evidence', async () => {
  const older = row(501041, { revision: 'old', asOf: NOW - 120_000 });
  const latest = row(501041, { revision: 'new', asOf: NOW - 10_000 });
  latest.payload.analysis.results[0].formulaDiagnosticScore = 8.125;
  const harness = await pollHarness([latest], [item(older)]);
  const restored = await harness.context.pollBackgroundJob('run-immutable', 1, DATE, [501041], { completedReceipt: harness.receipt });
  assert.equal(restored.restoredCompleted, true);
  assert.equal(harness.count(), 1);
  const restoredItem = harness.context.boardRef.current[0];
  assert.deepEqual(restoredItem.customData.analysis, latest.payload.analysis);
  assert.equal(restoredItem.restoredFromCache, true);
  assert.equal(restoredItem.readerPayloadHash, null);
  assert.equal(harness.context.loadBackgroundJob('NPB', DATE, harness.context.boardRef.current), null);
});

await test('replay cannot overwrite a newer live snapshot which completed while the request was pending', async () => {
  const received = row(501051, { revision: 'receipt', asOf: NOW - 120_000 });
  const newer = row(501051, { revision: 'newer-live', asOf: NOW - 1000 });
  const harness = await pollHarness([received], [item(newer)]);
  await harness.context.pollBackgroundJob('run-immutable', 1, DATE, [501051], { completedReceipt: harness.receipt });
  assert.deepEqual(harness.context.boardRef.current[0].customData.analysis, newer.payload.analysis);
});

await test('changed completed-source identity and terminal 404 remove only their own receipt and stop recovery loops', async () => {
  for (const mode of ['wrong-version', 'not-found']) {
    const latest = row(501061);
    const harness = await pollHarness([latest]);
    harness.context.saveCompletedAnalysisReceipt({ runId: 'other-cpbl-run', league: 'CPBL', date: DATE }, result([row(701061, { league: 'CPBL' })], 'CPBL'));
    if (mode === 'wrong-version') latest.payload.analysis.pitSnapshotId = 'changed-provider-snapshot';
    else harness.context.requestJSON = async () => { throw Object.assign(new Error('missing workflow'), { status: 404 }); };
    await assert.rejects(harness.context.pollBackgroundJob('run-immutable', 1, DATE, [501061], { completedReceipt: harness.receipt }));
    assert.equal(harness.context.completedRecoveryFailuresRef.current.has(`NPB|||${DATE}|||run-immutable`), true);
    assert.equal(harness.context.loadBackgroundJob('NPB', DATE), null);
    assert.equal(harness.context.loadBackgroundJob('CPBL', DATE).runId, 'other-cpbl-run');
  }
});

await test('a terminal source failure cannot resurrect the same legacy run or block another league in that run', async () => {
  const harness = await pollHarness([row(501065)]);
  const storage = harness.context.window.localStorage;
  storage.setItem(RUN_KEY, JSON.stringify({ runId: 'run-immutable', date: DATE, state: 'completed',
    completedAt: new Date(NOW - 1000).toISOString(),
    leagues: { NPB: { date: DATE, total: 1, resultLoaded: true }, CPBL: { date: DATE, total: 2, resultLoaded: false } } }));
  assert.equal(harness.context.loadBackgroundJob('NPB', DATE).completedReceipt, true);
  harness.context.requestJSON = async () => { throw Object.assign(new Error('expired workflow'), { status: 404 }); };
  await assert.rejects(harness.context.pollBackgroundJob('run-immutable', 1, DATE, [], { completedReceipt: harness.receipt }), /expired/);
  assert.equal(harness.context.loadBackgroundJob('NPB', DATE), null);
  const remounted = sandbox(storage);
  assert.equal(remounted.loadBackgroundJob('NPB', DATE), null, 'the unavailable marker must survive a full route remount');
  assert.equal(remounted.loadBackgroundJob('CPBL', DATE).runId, 'run-immutable');
  assert.equal(harness.context.completedRecoveryFailuresRef.current.has(`CPBL|||${DATE}|||run-immutable`), false);
});

await test('a rejected old request detaches without releasing queued cards on the newly selected board', async () => {
  for (const change of ['generation', 'date']) {
    const harness = await pollHarness([row(501067)]);
    let rejectRequest;
    let released = 0;
    let progressWrites = 0;
    harness.context.requestJSON = () => new Promise((resolve, reject) => { rejectRequest = reject; });
    harness.context.releaseTerminalBackgroundCards = () => { released += 1; };
    harness.context.setProgress = () => { progressWrites += 1; };
    const pending = harness.context.pollBackgroundJob('run-immutable', 1, DATE, [], { completedReceipt: harness.receipt });
    if (change === 'generation') harness.context.analysisGenerationRef.current = 2;
    else harness.context.currentDateRef.current = '2099-01-02';
    const activeBoard = [item(row(701067, { league: 'CPBL' }))];
    harness.context.boardRef.current = activeBoard;
    rejectRequest(Object.assign(new Error('old request unavailable'), { status: 404 }));
    assert.equal((await pending).detached, true);
    assert.equal(released, 0);
    assert.equal(progressWrites, 0);
    assert.equal(harness.context.boardRef.current, activeBoard);
    assert.equal(harness.context.loadBackgroundJob('NPB', DATE).runId, 'run-immutable', 'a detached request must not retire the old scope from a new page');
  }
});

await test('successful terminal work retains its recovery receipt while failed work clears its pending job only', async () => {
  const completed = row(501071);
  completed.task.readerPayloadHash = null;
  const harness = await pollHarness([completed]);
  harness.context.clearCompletedAnalysisReceipt('NPB', DATE, 'run-immutable');
  harness.context.saveBackgroundJob({ runId: 'run-immutable', league: 'NPB', date: DATE, gamePks: [501071] });
  harness.context.commitAnalysisPayload = () => true;
  harness.context.commitAnalysisFailure = () => true;
  harness.context.analysisFailureState = () => ({ blocked: false });
  const done = await harness.context.pollBackgroundJob('run-immutable', 1, DATE, [501071]);
  assert.equal(done.recoveryPersisted, true);
  const recovered = harness.context.loadBackgroundJob('NPB', DATE);
  assert.equal(recovered.completedReceipt, true, 'clearing the active job may not remove its immutable recovery source');
  harness.context.saveBackgroundJob({ runId: 'run-failed', league: 'NPB', date: DATE, gamePks: [501072] });
  harness.context.requestJSON = async () => ({ status: 'failed' });
  await assert.rejects(harness.context.pollBackgroundJob('run-failed', 1, DATE, [501072]), /未完成/);
  assert.equal(harness.context.loadBackgroundJob('NPB', DATE).runId, 'run-immutable', 'a failed replacement run must not erase an older completed recovery source');
});

await test('exhausted storage retains the pending handle and cannot report a durably consumed completed result', async () => {
  const completed = row(501081);
  completed.task.readerPayloadHash = null;
  const harness = await pollHarness([completed]);
  harness.context.clearCompletedAnalysisReceipt('NPB', DATE, 'run-immutable');
  harness.context.saveBackgroundJob({ runId: 'run-immutable', league: 'NPB', date: DATE, gamePks: [501081] });
  harness.context.window.localStorage.limit = 0;
  harness.context.commitAnalysisPayload = () => true;
  harness.context.commitAnalysisFailure = () => true;
  harness.context.analysisFailureState = () => ({ blocked: false });
  const done = await harness.context.pollBackgroundJob('run-immutable', 1, DATE, [501081]);
  assert.equal(done.recoveryPersisted, false);
  const pending = harness.context.loadBackgroundJob('NPB', DATE);
  assert.equal(pending.runId, 'run-immutable');
  assert.equal(pending.completedReceipt, undefined, 'failed receipt writes must leave the original durable handle intact');
  assert.match(page, /saved\.batchMode === 'all-leagues' && resultActuallyLoaded && result\?\.recoveryPersisted === true[\s\S]{0,350}resultLoaded: true/,
    'the all-league summary may be marked consumed only after durable receipt confirmation');
});

console.log(`Analysis board recovery: ${passed} groups passed; isolated quota injection, no live API/database writes.`);
