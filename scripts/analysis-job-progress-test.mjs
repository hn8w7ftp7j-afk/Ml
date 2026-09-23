import assert from 'node:assert/strict';
import { createAnalysisJobProgress, applyAnalysisJobProgress } from '../lib/analysis-job-progress.js';

const games = [1, 2, 3].map(gamePk => ({ gamePk, league: 'NPB', awayTeamId: gamePk * 2,
  homeTeamId: gamePk * 2 + 1, gameDate: '2026-09-23T09:00:00Z' }));
const tasks = games.map(game => ({ game, actualMarkets: [] }));
const batch = { league: 'NPB', date: '2026-09-23', tasks };
const scope = { league: batch.league, date: batch.date, gamePks: [1, 2, 3] };
const board = games.map(game => ({ game, status: 'queued' }));
const success = { ok: true, task: tasks[0], payload: { game: games[0], analysis: { results: [{ pick: 'test' }] } } };
const failure = { ok: false, status: 422, code: 'CORE_DATA_MISSING', error: '缺少資料', task: tasks[1] };
const start = applyAnalysisJobProgress(createAnalysisJobProgress(batch, [], [1]), board, scope);
assert.deepEqual([start.completed, start.running, start.queued], [0, 1, 2]);
assert.equal(start.board[0].status, 'running');
const partial = applyAnalysisJobProgress(createAnalysisJobProgress(batch, [success], [2]), start.board, scope);
assert.deepEqual([partial.completed, partial.running, partial.queued], [1, 1, 1]);
assert.equal(partial.board[0].customData, success.payload);
assert.equal(partial.board[0].readerPayloadHash, null, 'Partial display must never authorize execution');
assert.equal(partial.board[1].status, 'running');
assert.equal(partial.board[2].status, 'queued');
const blocked = applyAnalysisJobProgress(createAnalysisJobProgress(batch, [success, failure], [3]), partial.board, scope);
assert.deepEqual([blocked.completed, blocked.failed, blocked.running, blocked.queued], [1, 1, 1, 0]);
assert.equal(blocked.board[1].status, 'blocked');
assert.equal(blocked.board[0].customData, success.payload, 'Earlier results survive later failures');
const snapshot = createAnalysisJobProgress(batch, [success], []);
assert.throws(() => applyAnalysisJobProgress(snapshot, board, { ...scope, league: 'KBO' }));
assert.throws(() => applyAnalysisJobProgress(snapshot, board, { ...scope, date: '2026-09-24' }));
assert.throws(() => applyAnalysisJobProgress(snapshot, board, { ...scope, gamePks: [4, 5, 6] }));
assert.throws(() => applyAnalysisJobProgress({ ...snapshot, results: [success, success] }, board, scope));
assert.throws(() => applyAnalysisJobProgress({ ...snapshot, runningGamePks: [1] }, board, scope));
assert.throws(() => applyAnalysisJobProgress({ ...snapshot, results: [{ ...success, payload: { ...success.payload, game: games[1] } }] }, board, scope));
assert.ok(createAnalysisJobProgress(batch, [success], [2]).revision > snapshot.revision);
assert.ok(createAnalysisJobProgress(batch, [success, failure], []).revision > createAnalysisJobProgress(batch, [success], [2]).revision);
console.log('PASS: partial results, running/queued transitions, failures, scope/identity isolation, execution safety');

// Execute the real workflow body with controlled analysis responses. Observe
// progress before the next game resolves, including a nonfatal failed game.
const { readFileSync } = await import('node:fs');
let workflowSource = readFileSync(new URL('../workflows/analyze-board.js', import.meta.url), 'utf8');
workflowSource = workflowSource.replace(/^import .*;\n/gm, '').replace(/export async function/g, 'async function');
const publications = [];
let calls = 0;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('saveAnalysisJobProgress', 'createAnalysisJobProgress', 'FatalError', 'RetryableError', 'getWorkflowMetadata', 'createBackgroundAnalysisAuthorization', 'analyzeRequest', 'sendPush', 'completionMessage', `${workflowSource}\nreturn analyzeBoardWorkflow(arguments[9]);`);
const result = await execute(async (id, progress) => {
  publications.push(structuredClone(progress));
  assert.equal(id, 'run-progress-test');
  return true;
}, createAnalysisJobProgress, Error, Error, () => ({ workflowRunId: 'run-progress-test' }), async () => ({ timestamp: '1', signature: 'test' }), async request => {
  calls++;
  const input = await request.json();
  if (calls === 2) {
    assert.ok(publications.some(p => p.completed === 1 && p.results[0].payload.game.gamePk === 1), 'First result published before second request');
    return Response.json({ ok: false, error: '缺少資料', code: 'CORE_DATA_MISSING' }, { status: 422 });
  }
  return Response.json({ ok: true, game: input.game, analysis: { results: [{}] } });
}, async () => {}, () => {}, { ...batch, tasks: tasks.map((task, i) => ({ ...task, requestId: `req-${i}`, body: { game: task.game } })) });
assert.equal(result.completed, 2);
assert.equal(result.total, 3);
assert.equal(publications.at(-1).failed, 1);
assert.deepEqual(publications.at(-1).runningGamePks, []);
console.log('PASS: actual workflow publishes first result before next game, continues after 422, preserves final result');
