import assert from 'node:assert/strict';
import { ACTIVE_ANALYSIS_LEAGUE_IDS, ANALYSIS_LEAGUE_IDS, analysisBatchScope, isAnalysisLeagueId } from '../lib/analysis-leagues.js';
import { allLeagueAnalysisProgress, createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague } from '../lib/all-league-analysis-v117.js';
import { isLeagueId, requestedLeagueId } from '../lib/leagues.js';

const active = [...ACTIVE_ANALYSIS_LEAGUE_IDS];
assert.deepEqual(active, ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA']);
assert.equal(analysisBatchScope(active, active).preflightFailures, 0);
assert.equal(analysisBatchScope(active.slice(1), active).preflightFailures, 1);
assert.equal(analysisBatchScope(ANALYSIS_LEAGUE_IDS).preflightFailures, 0, 'legacy six-league clients retain their scope');
assert.equal(analysisBatchScope(active).preflightFailures, 1, 'legacy omitted batch still reports failure');
assert.equal(analysisBatchScope([...active, 'NHL'], active), null);
assert.equal(analysisBatchScope(['NBA', 'NBA'], active), null);
assert.equal(analysisBatchScope(active, ['NBA', 'NBA']), null);
assert.equal(analysisBatchScope(active, null), null);
assert.equal(analysisBatchScope([], active), null);
for (const id of ['EPL', 'UCL']) {
  assert.equal(isAnalysisLeagueId(id), false, `${id} cannot enter existing sport models`);
  assert.equal(isLeagueId(id), false);
  assert.equal(requestedLeagueId(id), null, `${id} must never fall back to MLB at the API boundary`);
  assert.equal(analysisBatchScope([id], [id]), null);
}
let run = createAllLeagueAnalysisRun('2026-10-18', Date.now(), active);
assert.deepEqual(Object.keys(run.leagues), active);
for (const id of active) run = updateAllLeagueAnalysisLeague(run, id, { status: 'done' });
assert.equal(allLeagueAnalysisProgress(run).total, 5);
assert.equal(allLeagueAnalysisProgress(run).terminal, 5);
const legacy = updateAllLeagueAnalysisLeague(createAllLeagueAnalysisRun('2026-10-17'), 'NHL', { status: 'done', completed: 2 });
assert.equal(legacy.leagues.NHL.completed, 2);
assert.equal(allLeagueAnalysisProgress(legacy).terminal, 1, 'saved NHL receipts stay readable');
console.log('PASS soccer isolation, five-league preflight counts, explicit scope rejection and legacy NHL recovery');
