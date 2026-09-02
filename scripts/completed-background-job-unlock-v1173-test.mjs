import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');

assert.match(
  page,
  /function loadBackgroundJob\(league, date\)[\s\S]*terminalRunMatches[\s\S]*cachedResultLoaded[\s\S]*loadAnalysisBoardCache\(id, date\)[\s\S]*!cachedResultLoaded[\s\S]*saveBackgroundJob\(recovered\);[\s\S]*return recovered;/,
  'a terminal all-league run must recover each unconsumed league result, including after an overlapping individual job replaced its reconnect record',
);
assert.match(
  page,
  /resultActuallyLoaded = result\?\.detached !== true && result\?\.discarded !== true[\s\S]*saved\.batchMode === 'all-leagues'[\s\S]*resultActuallyLoaded[\s\S]*resultLoaded: true/,
  'a league result must be marked consumed only after its completed payload has loaded into that league board',
);
assert.match(
  page,
  /if \(!resultActuallyLoaded\)[\s\S]*結果保留待重新驗證載入[\s\S]*return;/,
  'a discarded terminal payload must remain recoverable and must not claim that its rows were loaded',
);
assert.match(
  page,
  /if \(state\.status === 'completed'\)[\s\S]*publishAllLeagueRun\(completedRun\);/,
  'the 4/4 completion transition must retain per-league reconnect records until every result is consumed',
);
assert.doesNotMatch(
  page,
  /if \(state\.status === 'completed'\)[\s\S]{0,1800}clearAllLeagueBackgroundJobs\(completedRun\);/,
  'the compact summary must not delete unvisited league result handles',
);
assert.match(
  page,
  /const locksForeground = saved\.batchMode !== 'all-leagues';[\s\S]*if \(locksForeground\) \{[\s\S]*operationBusyRef\.current = true;[\s\S]*setBusy\(true\);/,
  'all-league background reconnect must not occupy the single-league foreground busy lock',
);
assert.match(
  page,
  /async function pollReaderAndReprice\(\) \{[\s\S]{0,300}allLeagueBusyRef\.current[\s\S]{0,120}allLeagueRunning/,
  'automatic Reader repricing must not create an individual workflow while the four-league workflow is active',
);

assert.match(
  page,
  /const resumed = hasOpenRows && !coverageRegression && previous && !previousBlocked[\s\S]{0,160}pitPersistence\?\.confirmed === true[\s\S]{0,160}advanceUnchangedReaderGame/,
  'an unchanged Reader market may resume only after permanent PIT confirmation; failed PIT must be resubmitted',
);
assert.match(
  page,
  /const tasks = items\.map[\s\S]{0,500}!item\.resumedCurrentReaderGame && !item\.preservedCurrentReaderGame/,
  'an unconfirmed PIT item must remain eligible for the durable analysis retry task',
);

console.log('Completed all-league jobs release stale storage and foreground controls PASS');
