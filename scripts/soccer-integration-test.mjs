import assert from 'node:assert/strict';
import { ACTIVE_ANALYSIS_LEAGUE_IDS, ANALYSIS_LEAGUE_IDS, analysisBatchScope, isAnalysisLeagueId } from '../lib/analysis-leagues.js';
import { allLeagueAnalysisProgress, createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague } from '../lib/all-league-analysis-v117.js';
import { isLeagueId, requestedLeagueId } from '../lib/leagues.js';

const active = [...ACTIVE_ANALYSIS_LEAGUE_IDS];
const legacy = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL'];
assert.deepEqual(active, ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL']);
assert.deepEqual([...ANALYSIS_LEAGUE_IDS], [...legacy, 'EPL', 'UCL'], 'all saved sport receipts retain a known registry entry');
assert.equal(analysisBatchScope(active, active).preflightFailures, 0);
assert.equal(analysisBatchScope(active.slice(1), active).preflightFailures, 1);
assert.equal(analysisBatchScope(legacy).preflightFailures, 0, 'legacy six-league clients retain their scope');
assert.equal(analysisBatchScope(legacy.slice(1)).preflightFailures, 1, 'legacy omitted batch still reports failure');
assert.equal(analysisBatchScope([...active, 'NHL'], active), null);
assert.equal(analysisBatchScope(['NBA', 'NBA'], active), null);
assert.equal(analysisBatchScope(active, ['NBA', 'NBA']), null);
assert.equal(analysisBatchScope(active, null), null);
assert.equal(analysisBatchScope([], active), null);
for (const id of ['EPL', 'UCL']) {
  assert.equal(isAnalysisLeagueId(id), true, `${id} participates in research orchestration`);
  assert.equal(isLeagueId(id), false);
  assert.equal(requestedLeagueId(id), null, `${id} must never fall back to MLB at the API boundary`);
  assert.deepEqual(analysisBatchScope([id], [id]), { leagueIds: [id], preflightFailures: 0 });
}
let run = createAllLeagueAnalysisRun('2026-10-18', Date.now(), active);
assert.deepEqual(Object.keys(run.leagues), active);
for (const id of active) run = updateAllLeagueAnalysisLeague(run, id, { status: 'done' });
assert.equal(allLeagueAnalysisProgress(run).total, 7);
assert.equal(allLeagueAnalysisProgress(run).terminal, 7);
const recovered = updateAllLeagueAnalysisLeague(createAllLeagueAnalysisRun('2026-10-17', Date.now(), legacy), 'NHL', { status: 'done', completed: 2 });
assert.equal(recovered.leagues.NHL.completed, 2);
assert.equal(allLeagueAnalysisProgress(recovered).terminal, 1, 'saved NHL receipts stay readable');
console.log('PASS soccer research orchestration, seven-league preflight counts, explicit scope rejection and legacy NHL recovery');
