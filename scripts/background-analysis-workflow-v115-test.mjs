import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createBackgroundAnalysisAuthorization,
  verifyBackgroundAnalysisAuthorization,
} from '../lib/security.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = read('workflows/analyze-board.js');
const jobsRoute = read('app/api/analysis-jobs/route.js');
const analyzeRoute = read('app/api/analyze/route.js');
const page = read('app/page.js');
const nextConfig = read('next.config.mjs');
const middleware = read('middleware.js');
const vercel = JSON.parse(read('vercel.json'));

assert.match(workflow, /'use workflow'/, 'board orchestration must be durable');
assert.match(workflow, /'use step'/, 'each game analysis must be a retryable durable step');
assert.match(workflow, /Promise\.allSettled/, 'MLB background work must retain bounded parallel progress');
assert.match(workflow, /analyzeGameStep\.maxRetries = 2/, 'transient per-game failures must retry automatically');
assert.match(jobsRoute, /start\(analyzeBoardWorkflow/, 'job API must return after starting server work');
assert.match(jobsRoute, /getRun\(runId\)/, 'job API must reconnect to an existing run');
assert.match(jobsRoute, /await run\.returnValue/, 'completed workflow results must be recoverable');
assert.match(analyzeRoute, /verifyBackgroundAnalysisAuthorization/, 'internal background analysis must use scoped HMAC authorization');
assert.match(page, /saveBackgroundJob/, 'run identity must persist across iOS suspension or app close');
assert.match(page, /loadBackgroundJob/, 'app reopen must recover the active run');
assert.match(page, /伺服器背景分析中｜可離開App/, 'UI must explain that leaving the app is safe');
assert.match(nextConfig, /withWorkflow\(nextConfig\)/, 'Next.js must compile workflow directives');
assert.match(middleware, /well-known\/workflow/, 'authentication middleware must not intercept Workflow internal callbacks');
assert.ok(vercel.functions['app/api/analyze/route.js'].maxDuration >= 120, 'per-game background analysis needs enough server duration');

const previousSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = 'background-analysis-test-secret-at-least-32-characters';
const body = { league: 'MLB', game: { gamePk: 123 }, markets: [] };
const token = await createBackgroundAnalysisAuthorization(body, 2_000_000);
const request = new Request('https://example.test/api/analyze', { headers: {
  'X-Background-Analysis-Time': token.timestamp,
  'X-Background-Analysis-Signature': token.signature,
} });
assert.equal(await verifyBackgroundAnalysisAuthorization(request, body, 2_000_100), true);
assert.equal(await verifyBackgroundAnalysisAuthorization(request, { ...body, league: 'KBO' }, 2_000_100), false);
assert.equal(await verifyBackgroundAnalysisAuthorization(request, body, 2_000_000 + 25 * 60 * 60 * 1000), false);
if (previousSecret == null) delete process.env.SESSION_SECRET;
else process.env.SESSION_SECRET = previousSecret;

console.log('Durable server background analysis, HMAC boundary, reconnect and iOS lifecycle recovery PASS');
