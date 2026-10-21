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
    date: '2026-10-05', dateRef: { current: '2026-10-05' }, load: async () => { boardReads++; return board; }, crypto: { randomUUID: () => 'fixture-uuid' }, Date,
    setStarting() {}, setError() {}, setMessage() {}, setProgress() {}, setRows() {}, store: () => true, setJob: value => { job = value; },
    api: async (url, options) => { submissions++; assert.equal(url, '/api/analysis-jobs'); assert.equal(JSON.parse(options.body).date, board.date); return { runId: 'fixture-run-id' }; } });
  vm.runInContext(start + '\nthis.startNba = start;', context);
  await Promise.race([context.startNba(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('notification blocked analysis')), 500); timer.unref(); })]);
  assert.equal(boardReads, 1); assert.equal(submissions, 1); assert.equal(job.status, 'running'); assert.equal(context.operation.current, false);
}
assert.ok(source.includes("window.addEventListener('focus', resume)"));
assert.ok(source.includes("document.addEventListener('visibilitychange', resume)"));
const pollSource=source.slice(source.indexOf('    async function poll()'),source.indexOf('    void poll(); return'));
for(const kind of ['invalid-result','wrong-run','transport','completed']) {
  let job, message='', retries=0, error='', saved;
  const handle={runId:'fixture-nba-run',date:'2026-10-22',status:'running'};
  const batch={runId:kind==='wrong-run'?'another-run':handle.runId};
  const context=vm.createContext({job:handle,dateRef:{current:handle.date},rowsRef:{current:[]},current:()=>true,
    api:async()=>{if(kind==='transport')throw Error('temporary transport');return{status:'completed',result:batch};},
    mergeNbaAnalysisResults:()=>{if(kind==='invalid-result')throw Error('NBA 跨季例行賽分析無效');return[];},
    setRows(){},setProgress(){},onBatchProgress(){},nbaBatchFinished:()=>true,summarizeNbaBatchOutcome:()=>({status:'done'}),
    nbaCompletionSummary:()=>'completed',setError:value=>{error=value;},setMessage:value=>{message=value;},
    store:value=>{saved=value;},setJob:value=>{job=value;},setTimeout:()=>{retries++;},timer:null});
  vm.runInContext(pollSource+'\nthis.pollNba=poll;',context);await context.pollNba();
  if(kind==='transport'){assert.equal(retries,1);assert.equal(job,undefined);}
  else {assert.equal(retries,0);assert.equal(job.status,kind==='completed'?'completed':'failed');assert.equal(saved,job);
    if(kind!=='completed'){assert.ok(error);assert.match(message,/可重新分析/);}}
}
console.log('NBA actual start: pending/rejected/throwing push setup cannot block submission; latest board date preserved; foreground reconnect PASS');
