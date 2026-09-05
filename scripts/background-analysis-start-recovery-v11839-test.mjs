import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validAnalysisJobRequestKey } from '../lib/analysis-job-request-store.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const page = read('app/page.js');
const route = read('app/api/analysis-jobs/route.js');
const store = read('lib/analysis-job-request-store.js');

assert.equal(validAnalysisJobRequestKey('12345678-1234-1234-1234-123456789012'), true);
assert.equal(validAnalysisJobRequestKey('short'), false);
assert.match(store, /request_key TEXT PRIMARY KEY/, 'one browser request must own one durable recovery row');
assert.match(store, /ON CONFLICT \(request_key\) DO NOTHING/, 'retries must not create a second workflow claim');
assert.match(route, /requestClaim\.runId[\s\S]*recovered: true/, 'a lost 202 response must recover its existing run id');
assert.match(route, /status: 'starting'[\s\S]*recovered: true/, 'a concurrent retry must wait for the first start attempt');
assert.match(route, /completeAnalysisJobRequest\(requestKey, run\.runId\)/, 'the run id must be saved before the accepted response');
assert.match(route, /searchParams\.get\('requestId'\)[\s\S]*getAnalysisJobRequest\(requestKey\)/, 'the client must be able to reconnect while the first request is still starting');
assert.match(page, /startBackgroundAnalysisJob\([\s\S]*requestJSONWithTransientRetry\('\/api\/analysis-jobs',[\s\S]*Idempotency-Key': requestId/, 'Safari transport retries must reuse one idempotency key');
assert.match(page, /requestId=\$\{encodeURIComponent\(job\.requestId\)\}/, 'a starting response must poll the durable request mapping');
assert.equal((page.match(/startBackgroundAnalysisJob\(\{/g) || []).length, 2, 'single-league and four-league starts must use recovery');
assert.match(page, /function isInterruptedPreSubmitRun\(run\)[\s\S]*!run \|\| run\.runId[\s\S]*送出伺服器背景工作前中斷/, 'legacy pre-submit failures must be recognized without touching a real durable run');
assert.match(page, /isInterruptedPreSubmitRun\(saved\)[\s\S]*clearAllLeagueAnalysisRun\(saved\)[\s\S]*setAllLeagueRun\(null\)[\s\S]*setProgress\(\{ active: false/, 'a stale local-only batch must be removed and all controls unlocked on reload');
assert.doesNotMatch(page, /message: '上次在送出伺服器背景工作前中斷，請重新執行'/, 'a local pre-submit interruption must not be presented as three league failures');

console.log('Background workflow start recovery and duplicate prevention PASS');
