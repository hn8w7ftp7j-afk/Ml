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
assert.match(page, /state\.status === 'completed'[\s\S]*expectedReaderHashes[\s\S]*\/api\/credit-lines[\s\S]*taskEvidenceHash = readerGameEvidenceHash\(row\.task\)[\s\S]*liveEvidenceHash = readerGameEvidenceHash\(liveGame\)[\s\S]*applicableRows\.forEach/, 'completed Reader jobs must be re-attested per game against the official prestart slate and live Reader evidence before their saved result is applied');
assert.doesNotMatch(page, /expectedReaderHashes\.some\(hash => hash !== credit\.payloadHash\)/, 'one unrelated game changing the whole-board hash must not discard otherwise unchanged game results');
assert.match(page, /taskEvidenceHash !== liveEvidenceHash[\s\S]*discardedReaderPks\.add\(gamePk\)[\s\S]*return \[\]/, 'only a game whose own Reader evidence changed may be discarded from a completed batch');
assert.doesNotMatch(page, /!officialGames\.length \|\| !applicableRows\.length/, 'an obsolete early-game job must not globally finalize unrelated later prestart games');
assert.match(page, /if \(!officialGames\.length\) \{[\s\S]*finalizeReaderBoardAtStart[\s\S]*if \(!applicableRows\.length\) \{[\s\S]*該批場次已開始、延期或取消/, 'only an empty full official slate may globally finalize the board; an empty job subset must stop locally');
assert.match(page, /credit\?\.code === 'NO_PRESTART_GAMES'[\s\S]*const taskPks = new Set\(applicableRows[\s\S]*if \(!taskPks\.has/, 'a background subset crossing first pitch must finalize only that job subset');
assert.match(page, /function directRepriceAuthorityMatches\(item, task, now = Date\.now\(\)\)[\s\S]*!gameIsPrestartNow\(item\.game, now\)[\s\S]*pendingReaderEvidenceHash === expectedEvidenceHash/, 'a late direct reprice response must require the same existing prestart game and exact per-game Reader evidence');
assert.doesNotMatch(page.match(/function directRepriceAuthorityMatches[\s\S]*?\n  \}/)?.[0] || '', /readerEvidenceIsOlder/, 'an unrelated Reader heartbeat must not discard an unchanged-game direct reprice result');
assert.match(page, /const directRepriceTask = rebuildTask;[\s\S]*pendingReaderEvidenceHash: directRepriceEvidenceHash[\s\S]*requestJSON\('\/api\/reprice'[\s\S]*taskReaderStateIsStale\(directRepriceTask\)[\s\S]*directRepriceAuthorityMatches\(currentDirectItem, directRepriceTask\)[\s\S]*setBoard\((?:current|items) => \{[\s\S]*directRepriceAuthorityMatches\(currentItem, directRepriceTask\)[\s\S]*snapshots\.current\.set/, 'direct reprice must re-check authority both after the response and inside the atomic React state updater before storing a new snapshot');
assert.match(page, /catch \(cause\) \{[\s\S]*taskReaderStateIsStale\(rebuildTask\)[\s\S]*directRepriceAuthorityMatches\(currentDirectItem, rebuildTask\)[\s\S]*commitAnalysisFailure\(rebuildTask, cause\)/, 'a late direct reprice failure must also be rejected after start or per-game evidence change');
assert.match(page, /function releaseTerminalBackgroundCards\(gamePks = \[\], workflowStatus = 'failed'\)[\s\S]*\['queued', 'running'\]\.includes\(item\?\.status\)[\s\S]*!gameIsPrestartNow[\s\S]*!analysisHasCalculatedDirections[\s\S]*status: 'failed'/, 'fatal workflow states must release queued and running cards even when they have no previous analysis');
assert.match(page, /\['failed', 'cancelled'\]\.includes[\s\S]*clearBackgroundJob[\s\S]*releaseTerminalBackgroundCards\(gamePks, state\.status\)/, 'failed and cancelled durable runs must clear their persisted identity and release their cards');
assert.match(page, /saveBackgroundJob\(\{[\s\S]*gamePks: tasks\.map[\s\S]*pollBackgroundJob\([\s\S]*tasks\.map/, 'durable reconnect metadata must scope fatal card cleanup to the games owned by that run');
assert.match(page, /pollBackgroundJob\(saved\.runId, generation, date, saved\.gamePks\)/, 'app reopen must restore the saved game scope when reconnecting to a durable run');
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
