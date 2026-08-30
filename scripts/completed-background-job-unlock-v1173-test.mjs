import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');

assert.match(
  page,
  /function loadBackgroundJob\(league, date\)[\s\S]*job\?\.batchMode === 'all-leagues'[\s\S]*!allLeagueRunIsActive\(run\)[\s\S]*clearBackgroundJob\(league, date, job\.runId\);[\s\S]*return null;/,
  'a terminal all-league run must remove its stale per-league reconnect record before it can lock the screen',
);
assert.match(
  page,
  /if \(saved && !allLeagueRunIsActive\(saved\)\) clearAllLeagueBackgroundJobs\(saved\);/,
  'opening a completed 4/4 run must synchronously clear every stale league job',
);
assert.match(
  page,
  /if \(state\.status === 'completed'\)[\s\S]*clearAllLeagueBackgroundJobs\(completedRun\);[\s\S]*publishAllLeagueRun\(completedRun\);/,
  'the 4/4 completion transition must clear reconnect records before publishing terminal UI state',
);
assert.match(
  page,
  /const locksForeground = saved\.batchMode !== 'all-leagues';[\s\S]*if \(locksForeground\) \{[\s\S]*operationBusyRef\.current = true;[\s\S]*setBusy\(true\);/,
  'all-league background reconnect must not occupy the single-league foreground busy lock',
);

console.log('Completed all-league jobs release stale storage and foreground controls PASS');
