import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');

assert.match(page, /const CORE_DATA_BLOCK_RECHECK_MS = 5 \* 60 \* 1000/, 'same-hash core QA blocks need a five-minute backoff');
assert.match(page, /function readerGameEvidenceHash\(value\)[\s\S]*readerGameMarketHash[\s\S]*readerPayloadHash/, 'QA backoff must prefer each game market hash over the global board hash');
assert.match(page, /function analysisFailureState\(value\)[\s\S]*code === 'CORE_DATA_MISSING'[\s\S]*status === 422/, 'CORE_DATA_MISSING and HTTP 422 must be structured QA blocks');
assert.match(page, /error\.blocking = Array\.isArray\(data\.blocking\)/, 'client transport must preserve blocking metadata');
assert.match(page, /commitAnalysisFailure\(row\?\.task, row\)/, 'background polling must pass the full result row instead of dropping code and status');
assert.match(page, /const state = await requestJSON\(`\/api\/analysis-jobs[\s\S]*generation !== analysisGenerationRef\.current \|\| currentDateRef\.current !== targetDate\)[\s\S]*return \{ detached: true/, 'a completed old job must detach before mutating a newly selected league or date');
assert.match(page, /const pollKey = `\$\{runId\}\|\|\|\$\{generation\}\|\|\|\$\{targetDate\}`;[\s\S]*backgroundJobPollsRef\.current\.get\(pollKey\)/, 'reconnect polling must not reuse a detached promise from an older league/date generation');
assert.match(page, /const saved = loadBackgroundJob\(league, date\)[\s\S]*\}, \[date, league, storageReady, busy\]\);/, 'a new league/date must retry saved-job reconnect after the old operation releases busy state');
assert.match(page, /status: terminalGame \? 'done' : failure\.blocked \? 'blocked' : 'failed'/, 'terminal games must stop while QA blocks remain distinct from generic analysis failures');
assert.match(page, /資料不足｜QA BLOCK｜不評分/, 'blocked cards need explicit fail-closed copy');

const pollStart = page.indexOf('async function pollReaderAndReprice()');
const pollEnd = page.indexOf('async function recordBet(', pollStart);
assert.ok(pollStart >= 0 && pollEnd > pollStart, 'Reader repricing function must remain discoverable');
const poll = page.slice(pollStart, pollEnd);
assert.match(poll, /!boardRef\.current\.length[\s\S]*const currentBoard = boardRef\.current;[\s\S]*runPool\(currentBoard, 2/, 'Reader repricing must use one current board snapshot instead of a stale render closure');
assert.doesNotMatch(poll, /runPool\(board,/, 'Reader repricing must not iterate a stale board closure');
assert.match(page, /function blockedReaderHashRecheckDue\(payloadHash,[\s\S]*retryAt <= now/, 'an acknowledged Reader hash must still revalidate when its core-data block backoff expires');
assert.match(page, /function readerBoardNeedsCoreRefresh\(now[\s\S]*assessCoreSnapshotFreshnessV109[\s\S]*retryAt <= now/, 'the Reader poll must detect stale core data without a resettable foreground timer');
assert.match(poll, /statusRevision === creditRevisionRef\.current\s*&& !blockedReaderHashRecheckDue\(currentStatus\.payloadHash\)\s*&& !readerBoardNeedsCoreRefresh\(\)/, 'status fast return must yield to due QA-block or stale-core revalidation');
assert.match(poll, /creditRevision === creditRevisionRef\.current\s*&& !blockedReaderHashRecheckDue\(credit\.payloadHash\)\s*&& !readerBoardNeedsCoreRefresh\(\)/, 'credit fast return must yield to due QA-block or stale-core revalidation');
assert.doesNotMatch(page, /needsCoreRefresh[\s\S]{0,240}oneClickAnalyze\(\)/, 'core expiry must not use the foreground full-board retry timer');
assert.match(poll, /sameBlockedEvidence[\s\S]*retryAt > Date\.now\(\)/, 'the same blocked per-game evidence must be suppressed during backoff');
assert.match(poll, /rebuildTasks\.push\(rebuildTask\)/, 'missing snapshots must be collected for durable rebuild');
assert.match(poll, /if \(!snapshot \|\| !item\.referenceData \|\| !coreSnapshotReusable\(item\)\) \{[\s\S]*readerPayloadHash: null[\s\S]*rebuildTasks\.push\(rebuildTask\)/, 'stale core snapshots must revoke execution and use durable rebuild instead of looping through reprice 409');
assert.match(poll, /runDurableAnalysisTasks\(rebuildTasks, generation, targetDate/, 'automatic rebuilds must use the durable Workflow route');
assert.doesNotMatch(poll, /const rebuilt = await analyzeBoardItem\(/, 'Reader polling must not rebuild distributions in the foreground');
assert.match(poll, /let blocked = 0;[\s\S]*let completed = 0;[\s\S]*let updated = 0/, 'blocked and successful outcomes must be counted separately');
assert.match(poll, /rebuiltFailed = Math\.max\(0, rebuildTasks\.length - rebuiltCompleted - rebuiltBlocked\)/, 'transient failures must remain separate from QA blocks');
assert.match(poll, /同一盤面每5分鐘重驗一次，也可按「同步今日 \$\{activeLeague\.id\}」立即重驗/, 'UI must explain slow automatic revalidation and immediate manual retry');

const oneClickStart = page.indexOf('async function oneClickAnalyze(');
const oneClickEnd = page.indexOf('function blockedReaderHashRecheckDue(', oneClickStart);
const oneClick = page.slice(oneClickStart, oneClickEnd);
assert.match(oneClick, /runDurableAnalysisTasks\(tasks, generation, targetDate\)/, 'manual sync must always launch a durable job');
assert.doesNotMatch(oneClick, /coreDataBlockRetryRef\.current\.get/, 'manual sync must bypass automatic same-hash backoff');
assert.match(oneClick, /previousBlocked = analysisFailureState\(previous\?\.analysisFailure \|\| \{\}\)\.blocked;[\s\S]*hasOpenRows && !coverageRegression && previous && !previousBlocked/, 'manual sync must not resume a blocked or Reader-regressed prior result without revalidation');
assert.match(page, /function commitAnalysisFailure\(task, value\)[\s\S]*taskReaderStateIsStale\(task\)/, 'a late failure from an old Reader hash must be ignored before it can install a QA retry');

console.log('Structured QA BLOCK display, five-minute same-hash throttle and durable Reader rebuild PASS');
