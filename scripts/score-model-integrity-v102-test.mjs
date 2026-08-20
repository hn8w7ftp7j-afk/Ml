import assert from 'node:assert/strict';
import { estimateRunProfileV11, buildJointScoreSnapshotV11 } from '../lib/joint-score-v11.js';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';

const league = { runsPerTeamGame: 4.5, era: 4.2, whip: 1.30, ops: .720 };
const team = { hitting: { runsPerGame: 4.5, ops: .720, games: 120, status: 'CONFIRMED' }, recentHitting: { runsPerGame: 4.5, ops: .720, games: 14, status: 'PROJECTED' }, pitching: { era: 4.2, fip: 4.2, whip: 1.30, inningsPitched: 1000, status: 'CONFIRMED' }, recentPitching: { era: 2.0, fip: 2.0, whip: 1.0, inningsPitched: 120, status: 'PROJECTED' }, starter: { era: 4.2, fip: 4.2, whip: 1.30, inningsPitched: 100, status: 'CONFIRMED' }, scoring: { meanRuns: 4.5, varianceRuns: 9 }, injuriesAvailable: true, injuries: [] };
const context = { game: { gamePk: 1, away: 'A', home: 'H' }, league, away: structuredClone(team), home: structuredClone(team), park: { runFactor: 1, factorStatus: 'PROJECTED' }, weather: { meanRunFactor: 1, status: 'PROJECTED' }, sourceStatuses: {} };
const base = estimateRunProfileV11(context);
context.away.injuries = Array.from({length: 8}, (_, i) => ({ id: i + 1, position: 'OF' }));
const injured = estimateRunProfileV11(context);
assert.equal(injured.components.awayInjury, 1, 'injuries must not increase mean offense');
assert.ok(Math.abs(injured.first5.away - base.first5.away) < 1e-12, 'injury roster without run value must keep mean neutral');
assert.ok(injured.uncertainty.away > base.uncertainty.away, 'injury uncertainty must increase');
assert.ok(base.components.awayBullpen > .94 && base.components.awayBullpen < 1.06, 'bullpen proxy must be heavily shrunk');

const snapshot = buildJointScoreSnapshotV11({ context, modelVersion: 'test', rulesVersion: 'test' });
const weightedAwayF5 = snapshot.scenarios.reduce((sum, row) => sum + row.weight * row.means.awayFirst5, 0);
assert.ok(Math.abs(weightedAwayF5 / injured.first5.away - 1) < .006, 'scenario shocks must approximately preserve central mean');

const fakeAnalysis = { leagueId: 'KBO', results: [{ market: '全場大小', pick: '大8平', water: .94, weightedEV: .10, robustEV: .05, distributionCoverage: 1, sourceType: 'ACTUAL_TW_CREDIT', scoreAudit: { ok: true } }] };
const blocked = finalizeDeterministicAnalysis({ analysis: fakeAnalysis, game: { leagueId: 'KBO', away: 'A', home: 'H' } });
assert.equal(blocked.results[0].shadowDiagnosticScore, null, 'non-MLB legacy numeric score must be suppressed');
assert.equal(blocked.results[0].scoreStatus, 'LEAGUE_MODEL_NOT_VALIDATED');

console.log('score-model-integrity-v102-test: PASS');
