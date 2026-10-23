import assert from 'node:assert/strict';
import { createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague, applyAllLeagueLiveProgress } from '../lib/all-league-analysis-v117.js';
let run = createAllLeagueAnalysisRun('2026-10-24');
for (const id of ['MLB','NBA','EPL']) run = updateAllLeagueAnalysisLeague(run,id,{status:'queued',boardDate:'2026-10-24',total:3});
const row = {league:'NBA',date:run.date,total:3,settled:1,running:1,completed:1,failed:0};
let next = applyAllLeagueLiveProgress(run,[row]);
assert.equal(next.leagues.NBA.status,'running');
assert.equal(next.leagues.MLB.status,'queued');
assert.equal(next.leagues.EPL.status,'queued');
assert.match(next.leagues.NBA.message,/1\/3/);
next = applyAllLeagueLiveProgress(next,[{...row,settled:3,running:0,completed:2,failed:1}]);
assert.equal(next.leagues.NBA.status,'result_pending');
assert.notEqual(next.leagues.NBA.resultLoaded,true);
for (const invalid of [{date:'2026-10-23'},{total:4},{settled:4},{running:-1},{completed:2},{league:'NHL'}]) {
 assert.deepEqual(applyAllLeagueLiveProgress(run,[{...row,...invalid}]),run);
}
assert.deepEqual(applyAllLeagueLiveProgress(next,[row]),next);
console.log('PASS live progress: real counters, queued leagues, scope isolation, no completion authority, invalid counters rejected');
