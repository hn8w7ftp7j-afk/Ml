import assert from 'node:assert/strict';
import { createCompletedAnalysisReceipt, upsertCompletedAnalysisReceipt, findMissingCompletedAnalysisReceipt,
  completedReceiptGameMatches, analysisItemMatchesScope, ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY } from '../lib/analysis-completed-receipt-v1.js';

const NOW = Date.parse('2026-09-06T04:00:00.000Z');
const HOURS_72 = 72 * 3600_000;
const job = { runId: 'workflow-completed-1', league: 'MLB', date: '2026-09-06' };
function calculatedRow(gamePk, { league = 'MLB', date = '2026-09-06', weightedEV = 0.034, robustEV = -0.007, score = 7.0 } = {}) {
  const game = { gamePk, leagueId: league, taipeiDate: date, officialDate: '2026-09-05', gameDate: '2026-09-06T01:00:00.000Z' };
  return { ok: true, task: { game }, payload: { game: { ...game }, analysis: {
    inputHash: `input-${gamePk}`, distributionHash: `distribution-${gamePk}`, priceFingerprint: `price-${gamePk}`,
    modelVersion: 'test-model', analysisAsOf: new Date(NOW - 1000).toISOString(),
    results: [{ market: '全場大小', pick: '大8+50', weightedEV, robustEV, score }],
    directionSlots: [{ slotId: 'FULL_TOTAL_OVER', status: 'CALCULATED', modelEV: weightedEV, robustEV, formulaDiagnosticScore: score }],
  } } };
}
const rows = [101, 102, 103, 104].map(gamePk => calculatedRow(gamePk));
const result = { league: job.league, date: job.date, total: rows.length, results: rows };
const boardFor = results => results.map(row => ({ game: { ...row.task.game }, customData: structuredClone(row.payload), status: 'done' }));
const receipt = createCompletedAnalysisReceipt(job, result, { now: NOW });
let checks = 0;
const test = (name, fn) => { fn(); checks += 1; console.log(`PASS ${name}`); };

test('four completed games with only two cached always recover the missing two', () => {
  assert.equal(ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY, 'sports-positive-ev-completed-analysis-v1');
  assert.deepEqual(receipt.gamePks, [101, 102, 103, 104]);
  assert.equal(receipt.total, 4);
  const store = upsertCompletedAnalysisReceipt([], receipt, { now: NOW });
  const partial = boardFor(rows.slice(0, 2));
  const missing = findMissingCompletedAnalysisReceipt(store, { ...job, board: partial, now: NOW });
  assert.deepEqual(missing.missingGamePks, [103, 104]);
  assert.equal(missing.runId, job.runId);
  // Merely finding any one calculated game never marks the entire run restored.
  assert.deepEqual(findMissingCompletedAnalysisReceipt(store, { ...job, board: partial.slice(0, 1), now: NOW }).missingGamePks, [102, 103, 104]);
  assert.equal(findMissingCompletedAnalysisReceipt(store, { ...job, board: boardFor(rows), now: NOW }), null);
});

test('receipt tracks calculated success only, including nonpositive R and zero W', () => {
  const zeroEV = calculatedRow(105, { weightedEV: 0, robustEV: -0.05, score: 6 });
  const waiting = { ...calculatedRow(106), payload: { analysis: { calculatedDirectionCount: 0,
    results: [], directionSlots: [{ status: 'UNOPENED', modelEV: null, robustEV: null }] } } };
  const failed = { ...calculatedRow(107), ok: false };
  const empty = { ...calculatedRow(108), payload: { analysis: { results: [] } } };
  const saved = createCompletedAnalysisReceipt(job, { ...result, results: [zeroEV, waiting, failed, empty] }, { now: NOW });
  assert.deepEqual(saved.gamePks, [105]);
  assert.equal(saved.total, 1);
  assert.equal(createCompletedAnalysisReceipt(job, { ...result, results: [waiting, failed, empty] }, { now: NOW }), null);
  const countOnly = calculatedRow(109);
  countOnly.payload.analysis = { ...countOnly.payload.analysis, results: [], directionSlots: [], calculatedDirectionCount: 2 };
  assert.deepEqual(createCompletedAnalysisReceipt(job, { ...result, results: [countOnly] }, { now: NOW }).gamePks, [109]);
});

test('job/result/task/payload league and Taiwan board date identities cannot cross', () => {
  for (const bad of [{ league: 'NPB' }, { date: '2026-09-05' }, { runId: 'other-run' }]) {
    assert.equal(createCompletedAnalysisReceipt(job, { ...result, ...bad }, { now: NOW }), null);
  }
  for (const badGame of [{ leagueId: 'KBO' }, { taipeiDate: '2026-09-05' }, { gameDate: '2026-09-05T00:00:00.000Z' },
    { leagueId: undefined }, { league: 'CPBL' }, { gameDate: '2026-09-06T01:00:00' }]) {
    const row = calculatedRow(101);
    row.task.game = { ...row.task.game, ...badGame };
    assert.equal(createCompletedAnalysisReceipt(job, { ...result, results: [row] }, { now: NOW }), null, JSON.stringify(badGame));
  }
  for (const badGame of [{ gamePk: 999 }, { leagueId: 'KBO' }, { taipeiDate: '2026-09-05' }]) {
    const row = calculatedRow(101);
    row.payload.game = { ...row.payload.game, ...badGame };
    assert.equal(createCompletedAnalysisReceipt(job, { ...result, results: [row] }, { now: NOW }), null);
  }
  // The previous North American officialDate is valid for this Taiwan board.
  assert.equal(createCompletedAnalysisReceipt(job, result, { now: NOW }).total, 4);
  const overnight = calculatedRow(110);
  delete overnight.task.game.taipeiDate;
  overnight.task.game.gameDate = '2026-09-05T20:00:00.000Z';
  overnight.payload.game = { ...overnight.task.game };
  assert.deepEqual(createCompletedAnalysisReceipt(job, { ...result, results: [overnight] }, { now: NOW }).gamePks, [110]);
});

test('null, blank, coerced, fractional and unsafe IDs cannot become recovery targets', () => {
  for (const invalid of [null, 0, -1, ' ', true, [], {}, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const row = calculatedRow(invalid);
    assert.equal(createCompletedAnalysisReceipt(job, { ...result, results: [row] }, { now: NOW }), null, String(invalid));
  }
  assert.deepEqual(createCompletedAnalysisReceipt(job, { ...result, results: [calculatedRow('103')] }, { now: NOW }).gamePks, [103]);
  assert.deepEqual(createCompletedAnalysisReceipt(job, { ...result, results: [rows[0], rows[0]] }, { now: NOW }).gamePks, [101]);
  for (const runId of [null, '', ' ', {}, 'bad/run']) assert.equal(createCompletedAnalysisReceipt({ ...job, runId }, result, { now: NOW }), null);
});

test('future and expired receipts, malformed dates and invalid clocks are rejected', () => {
  const store = [receipt];
  assert.equal(findMissingCompletedAnalysisReceipt(store, { ...job, now: NOW - 1 }), null);
  assert.equal(findMissingCompletedAnalysisReceipt(store, { ...job, now: NOW + HOURS_72 + 1 }), null);
  assert.ok(findMissingCompletedAnalysisReceipt(store, { ...job, now: NOW + HOURS_72 }));
  assert.equal(findMissingCompletedAnalysisReceipt(store, { ...job, now: NaN }), null);
  assert.equal(findMissingCompletedAnalysisReceipt(store, { ...job, maxAgeMs: Infinity, now: NOW }), null);
  assert.equal(createCompletedAnalysisReceipt(job, { ...result, completedAt: new Date(NOW + 1).toISOString() }, { now: NOW }), null);
  assert.equal(createCompletedAnalysisReceipt({ ...job, completedAt: 'invalid' }, result, { now: NOW }), null);
  assert.equal(createCompletedAnalysisReceipt({ ...job, date: '2026-02-30' }, { ...result, date: '2026-02-30' }, { now: NOW }), null);
  for (const patch of [{ version: 0 }, { completedReceipt: false }, { total: 0 }, { gamePks: [101, null] },
    { gamePks: [101, 101], total: 2 }, { completedAt: '2026-09-06T04:00:00' }]) {
    assert.equal(findMissingCompletedAnalysisReceipt([{ ...receipt, ...patch }], { ...job, now: NOW }), null);
  }
  assert.deepEqual(upsertCompletedAnalysisReceipt(store, null, { now: NOW + HOURS_72 + 1 }), []);
});

test('foreign or waiting cached cards with the same game ID never count as restored', () => {
  const wrongLeague = boardFor(rows);
  wrongLeague.forEach(item => { item.game.leagueId = 'NPB'; });
  assert.deepEqual(findMissingCompletedAnalysisReceipt([receipt], { ...job, board: wrongLeague, now: NOW }).missingGamePks, receipt.gamePks);
  const wrongDate = boardFor(rows);
  wrongDate.forEach(item => { item.game.taipeiDate = '2026-09-05'; });
  assert.deepEqual(findMissingCompletedAnalysisReceipt([receipt], { ...job, board: wrongDate, now: NOW }).missingGamePks, receipt.gamePks);
  const wrongPayload = boardFor(rows);
  wrongPayload.forEach(item => { item.customData.game.gamePk += 1000; });
  assert.deepEqual(findMissingCompletedAnalysisReceipt([receipt], { ...job, board: wrongPayload, now: NOW }).missingGamePks, receipt.gamePks);
  const waiting = boardFor(rows);
  waiting.forEach(item => { item.customData.analysis = { results: [], directionSlots: [{ status: 'UNOPENED' }] }; });
  assert.deepEqual(findMissingCompletedAnalysisReceipt([receipt], { ...job, board: waiting, now: NOW }).missingGamePks, receipt.gamePks);
  assert.equal(findMissingCompletedAnalysisReceipt([receipt], { league: 'KBO', date: job.date, now: NOW }), null);
  assert.equal(findMissingCompletedAnalysisReceipt([receipt], { league: job.league, date: '2026-09-05', now: NOW }), null);
});

test('distinct runs on the same day keep distinct coverage and recover the next missing run', () => {
  const earlier = createCompletedAnalysisReceipt(job, { ...result, results: rows.slice(0, 2) }, { now: NOW });
  const later = createCompletedAnalysisReceipt({ ...job, runId: 'workflow-completed-2' }, { ...result, results: rows.slice(2) }, { now: NOW + 1000 });
  const store = upsertCompletedAnalysisReceipt(upsertCompletedAnalysisReceipt([], earlier, { now: NOW }), later, { now: NOW + 1000 });
  assert.equal(store.length, 2);
  assert.deepEqual(store.find(row => row.runId === later.runId).gamePks, [103, 104]);
  assert.deepEqual(store.find(row => row.runId === earlier.runId).gamePks, [101, 102]);
  assert.equal(findMissingCompletedAnalysisReceipt(store, { ...job, board: [], now: NOW + 1000 }).runId, later.runId);
  const next = findMissingCompletedAnalysisReceipt(store, { ...job, board: boardFor(rows.slice(2)), now: NOW + 1000 });
  assert.equal(next.runId, earlier.runId);
  assert.deepEqual(next.missingGamePks, [101, 102]);
  assert.equal(findMissingCompletedAnalysisReceipt(store, { ...job, board: boardFor(rows), now: NOW + 1000 }), null);
});

test('partial re-observation of the same run preserves documented games without extending expiry', () => {
  const partialAgain = createCompletedAnalysisReceipt(job, { ...result, results: rows.slice(2) }, { now: NOW + 1000 });
  const store = upsertCompletedAnalysisReceipt([receipt], partialAgain, { now: NOW + 1000 });
  assert.equal(store.length, 1);
  assert.deepEqual(store[0].gamePks, [101, 102, 103, 104]);
  assert.equal(store[0].completedAt, receipt.completedAt);
  assert.equal(findMissingCompletedAnalysisReceipt(store, { ...job, now: NOW + HOURS_72 + 1 }), null);
});

test('receipt storage is bounded and strips payloads instead of competing with the large board cache', () => {
  let store = [];
  for (let index = 0; index < 20; index++) {
    const value = { ...receipt, runId: `workflow-${index}`, completedAt: new Date(NOW + index).toISOString(), payload: { huge: 'x'.repeat(100000) } };
    store = upsertCompletedAnalysisReceipt(store, value, { now: NOW + index });
  }
  assert.equal(store.length, 12);
  assert.equal(store[0].runId, 'workflow-19');
  assert.equal(store.at(-1).runId, 'workflow-8');
  assert.ok(JSON.stringify(store).length < 30000);
  assert.ok(store.every(row => row.payload === undefined && row.results === undefined));
});

test('receipt creation and lookup never mutate or replace original W/R/S rows', () => {
  const board = boardFor(rows);
  const beforeResult = JSON.stringify(result);
  const beforeBoard = JSON.stringify(board);
  const created = createCompletedAnalysisReceipt(job, result, { now: NOW });
  const store = upsertCompletedAnalysisReceipt([], created, { now: NOW });
  findMissingCompletedAnalysisReceipt(store, { ...job, board, now: NOW });
  assert.equal(JSON.stringify(result), beforeResult);
  assert.equal(JSON.stringify(board), beforeBoard);
  assert.equal(board[0].customData.analysis.directionSlots[0].modelEV, 0.034);
  assert.equal(board[0].customData.analysis.directionSlots[0].robustEV, -0.007);
  assert.equal(board[0].customData.analysis.directionSlots[0].formulaDiagnosticScore, 7);
});

test('same game with a different analysis or price version remains missing until its exact result returns', () => {
  const oldBoard = boardFor(rows);
  oldBoard[0].customData.analysis.inputHash = 'previous-input-version';
  oldBoard[0].customData.analysis.distributionHash = 'previous-distribution-version';
  assert.equal(completedReceiptGameMatches(oldBoard[0], receipt, 101, { now: NOW }), false);
  assert.deepEqual(findMissingCompletedAnalysisReceipt([receipt], { ...job, board: oldBoard, now: NOW }).missingGamePks, [101]);
  oldBoard[0].customData.analysis = { ...rows[0].payload.analysis, priceFingerprint: 'previous-price-version' };
  assert.deepEqual(findMissingCompletedAnalysisReceipt([receipt], { ...job, board: oldBoard, now: NOW }).missingGamePks, [101]);
  oldBoard[0].customData.analysis = structuredClone(rows[0].payload.analysis);
  assert.equal(completedReceiptGameMatches(oldBoard[0], receipt, 101, { now: NOW }), true);
  assert.equal(findMissingCompletedAnalysisReceipt([receipt], { ...job, board: oldBoard, now: NOW }), null);
});

test('the latest receipt owns each game so an older run cannot replace a newer cached snapshot', () => {
  const oldRun = createCompletedAnalysisReceipt(job, { ...result, results: rows.slice(0, 2) }, { now: NOW });
  const newRow = calculatedRow(101);
  newRow.payload.analysis = { ...newRow.payload.analysis, inputHash: 'latest-input', priceFingerprint: 'latest-price', analysisAsOf: new Date(NOW).toISOString() };
  const newRun = createCompletedAnalysisReceipt({ ...job, runId: 'workflow-newer' }, { ...result, results: [newRow] }, { now: NOW + 1000 });
  const store = upsertCompletedAnalysisReceipt([oldRun], newRun, { now: NOW + 1000 });
  const oldCache = boardFor(rows.slice(0, 2));
  assert.deepEqual(findMissingCompletedAnalysisReceipt(store, { ...job, board: oldCache, now: NOW + 1000 }).missingGamePks, [101]);
  const newestCache = boardFor([newRow, rows[1]]);
  assert.equal(findMissingCompletedAnalysisReceipt(store, { ...job, board: newestCache, now: NOW + 1000 }), null);
  const remainingOldGame = findMissingCompletedAnalysisReceipt(store, { ...job, board: boardFor([newRow]), now: NOW + 1000 });
  assert.equal(remainingOldGame.runId, oldRun.runId);
  assert.deepEqual(remainingOldGame.missingGamePks, [102]);
});

test('a genuinely newer analysis timestamp preserves current data; Reader heartbeats never count as newer analysis', () => {
  const current = boardFor(rows)[0];
  current.customData.analysis.inputHash = 'more-recent-model';
  current.customData.analysis.analysisAsOf = new Date(NOW).toISOString();
  assert.equal(completedReceiptGameMatches(current, receipt, 101, { now: NOW }), true);
  assert.equal(completedReceiptGameMatches(current, receipt, 101, { now: NOW, allowNewer: false }), false);
  current.customData.analysis.analysisAsOf = rows[0].payload.analysis.analysisAsOf;
  current.customData.fetchedAt = new Date(NOW + 60000).toISOString();
  current.latestReaderSource = { observedAt: new Date(NOW + 60000).toISOString() };
  assert.equal(completedReceiptGameMatches(current, receipt, 101, { now: NOW + 60000 }), false);
  current.customData.analysis.analysisAsOf = new Date(NOW + 60000).toISOString();
  assert.equal(completedReceiptGameMatches(current, receipt, 101, { now: NOW }), false);
});

test('unversioned receipts and calculated rows cannot falsely mark another snapshot as recovered', () => {
  const noEvidence = calculatedRow(101);
  delete noEvidence.payload.analysis.inputHash;
  delete noEvidence.payload.analysis.distributionHash;
  delete noEvidence.payload.analysis.priceFingerprint;
  assert.equal(createCompletedAnalysisReceipt(job, { ...result, results: [noEvidence] }, { now: NOW }), null);
  const oldReceipt = { ...receipt };
  delete oldReceipt.gameVersions;
  assert.equal(findMissingCompletedAnalysisReceipt([oldReceipt], { ...job, now: NOW }), null);
  const pitOnly = structuredClone(noEvidence);
  pitOnly.payload.pitPersistence = { snapshotId: 'MLB:101:FULL:test-snapshot' };
  const pitReceipt = createCompletedAnalysisReceipt(job, { ...result, results: [pitOnly] }, { now: NOW });
  assert.ok(pitReceipt);
  assert.equal(completedReceiptGameMatches(boardFor([pitOnly])[0], pitReceipt, 101, { now: NOW }), true);
});

test('receiving an older workflow later cannot displace a known newer model for the same game', () => {
  const newerRow = calculatedRow(101);
  newerRow.payload.analysis.inputHash = 'newer-authoritative-model';
  newerRow.payload.analysis.analysisAsOf = new Date(NOW).toISOString();
  const newer = createCompletedAnalysisReceipt({ ...job, runId: 'newer-model-run' }, { ...result, results: [newerRow] }, { now: NOW + 1000 });
  const oldReceivedLater = createCompletedAnalysisReceipt(job, { ...result, results: [rows[0]] }, { now: NOW + 2000 });
  const store = upsertCompletedAnalysisReceipt([newer], oldReceivedLater, { now: NOW + 2000 });
  assert.equal(findMissingCompletedAnalysisReceipt(store, { ...job, now: NOW + 2000 }).runId, newer.runId);
  assert.equal(findMissingCompletedAnalysisReceipt(store, { ...job, board: boardFor([newerRow]), now: NOW + 2000 }), null);
});

test('conflicting PIT snapshot identifiers cannot masquerade as one immutable analysis version', () => {
  const conflict = calculatedRow(101);
  conflict.payload.pitPersistence = { snapshotId: 'MLB:101:FULL:original' };
  conflict.payload.analysis.pitSnapshotId = 'MLB:101:FULL:different';
  assert.equal(createCompletedAnalysisReceipt(job, { ...result, results: [conflict] }, { now: NOW }), null);
  conflict.payload.analysis.pitSnapshotId = 'MLB:101:FULL:original';
  const coherent = createCompletedAnalysisReceipt(job, { ...result, results: [conflict] }, { now: NOW });
  assert.ok(coherent);
  const invalidCache = boardFor([conflict])[0];
  invalidCache.customData.analysis.pitSnapshotId = 'MLB:101:FULL:different';
  assert.equal(completedReceiptGameMatches(invalidCache, coherent, 101, { now: NOW }), false);
  conflict.payload.analysis.pitPersistence = { snapshotId: 'MLB:101:FULL:third' };
  assert.equal(createCompletedAnalysisReceipt(job, { ...result, results: [conflict] }, { now: NOW }), null);
});

test('board scope excludes foreign and old-date cards while retaining legitimate QA/BLOCK cards', () => {
  const item = boardFor(rows)[0];
  assert.equal(analysisItemMatchesScope(item, job), true);
  assert.equal(analysisItemMatchesScope(item, { ...job, league: 'KBO' }), false);
  assert.equal(analysisItemMatchesScope(item, { ...job, date: '2026-09-05' }), false);
  const blocked = structuredClone(item);
  blocked.status = 'blocked';
  blocked.customData.analysis = { results: [], qa: { status: 'BLOCK' } };
  assert.equal(analysisItemMatchesScope(blocked, job), true);
  assert.equal(completedReceiptGameMatches(blocked, receipt, 101, { now: NOW }), false);
  assert.equal(analysisItemMatchesScope({ game: item.game, status: 'queued', customData: null }, job), true);
  for (const patch of [{ league: 'NPB' }, { leagueId: 'CPBL' }, { date: '2026-09-05' },
    { game: { ...item.game, gamePk: 999 } }, { game: { ...item.game, leagueId: 'KBO' } },
    { game: { ...item.game, taipeiDate: '2026-09-05' } }]) {
    assert.equal(analysisItemMatchesScope({ ...item, customData: { ...item.customData, ...patch } }, job), false);
  }
  assert.equal(analysisItemMatchesScope({ ...item, game: { ...item.game, gamePk: null } }, job), false);
});

console.log(`Completed analysis receipts: ${checks} recovery/isolation/retention groups PASS.`);
