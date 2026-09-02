import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');

assert.match(
  page,
  /function loadBackgroundJob\(league, date\)[\s\S]*terminalRunMatches[\s\S]*batch\?\.resultLoaded !== true[\s\S]*saveBackgroundJob\(recovered\);[\s\S]*return recovered;/,
  'a terminal all-league run must recover each unconsumed league result, including after an overlapping individual job replaced its reconnect record',
);
assert.match(
  page,
  /saved\.batchMode === 'all-leagues'[\s\S]*result\?\.detached !== true[\s\S]*resultLoaded: true/,
  'a league result must be marked consumed only after its completed payload has loaded into that league board',
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

console.log('Completed all-league jobs release stale storage and foreground controls PASS');
