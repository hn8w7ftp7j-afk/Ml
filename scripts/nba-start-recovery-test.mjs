import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { prepareNbaNotification } from '../lib/nba/analysis-notification-start.js';
const source = readFileSync(new URL('../app/nba/main-workspace.js', import.meta.url), 'utf8');
const start = source.slice(source.indexOf('  async function start('), source.indexOf('  const changeDate'));
for (const prepare of [() => new Promise(() => {}), () => Promise.reject(new Error('push unavailable')), () => { throw new Error('push blocked'); }]) {
  let submissions = 0, boardReads = 0, job;
  const board = { date: '2026-10-06', tasks: [{ nbaQuery: { id: '401898388' }, game: { id: 'nba:espn:game:401898388' } }] };
  const context = vm.createContext({ operation: { current: false }, busy: false, notification: { current: { prepare } }, prepareNbaNotification,
    date: '2026-10-05', load: async () => { boardReads++; return board; }, crypto: { randomUUID: () => 'fixture-uuid' }, Date,
    setStarting() {}, setError() {}, setMessage() {}, setProgress() {}, setRows() {}, store: () => true, setJob: value => { job = value; },
    api: async (url, options) => { submissions++; assert.equal(url, '/api/analysis-jobs'); assert.equal(JSON.parse(options.body).date, board.date); return { runId: 'fixture-run-id' }; } });
  vm.runInContext(start + '\nthis.startNba = start;', context);
  await Promise.race([context.startNba(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('notification blocked analysis')), 500); timer.unref(); })]);
  assert.equal(boardReads, 1); assert.equal(submissions, 1); assert.equal(job.status, 'running'); assert.equal(context.operation.current, false);
}
assert.ok(source.includes("window.addEventListener('focus', resume)"));
assert.ok(source.includes("document.addEventListener('visibilitychange', resume)"));
console.log('NBA actual start: pending/rejected/throwing push setup cannot block submission; latest board date preserved; foreground reconnect PASS');
