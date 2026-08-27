import assert from 'node:assert/strict';
import {
  ASIAN_LEAGUE_READINESS_VERSION,
  asianDistributionEngineBlocker,
  asianFeatureBlockerDetails,
  asianLeagueReleaseReadiness,
} from '../lib/asian-league-readiness.js';

assert.equal(ASIAN_LEAGUE_READINESS_VERSION, 'ASIAN-LEAGUE-RUNTIME-PIT-READINESS-2026-08-v2.0.0');

for (const leagueId of ['NPB', 'KBO', 'CPBL']) {
  const readiness = asianLeagueReleaseReadiness(leagueId);
  assert.equal(readiness.leagueId, leagueId);
  assert.equal(readiness.status, 'ENABLED_RUNTIME_PIT_FAIL_CLOSED');
  assert.equal(readiness.analysisEnabled, true);
  assert.equal(readiness.canBuildDistribution, true);
  assert.equal(readiness.canCalculateModelEvW, true);
  assert.equal(readiness.canCalculateRobustEvR, true);
  assert.equal(readiness.fullGameScoreAvailable, true);
  assert.equal(readiness.fullGameResultFeedAvailable, leagueId === 'CPBL');
  assert.equal(readiness.fullGameAutoSettlementReady, leagueId === 'CPBL');
  assert.equal(readiness.first5ResultFeedAvailable, false);
  assert.equal(readiness.mlbFallbackAllowed, false);
  assert.equal(readiness.tai888ProbabilityInputAllowed, false);
  assert.ok(readiness.availableServices.includes('OFFICIAL_SCHEDULE'));
  assert.ok(readiness.availableServices.includes('TAI888_READER'));
  assert.deepEqual(readiness.displayAnalysisBlockers, []);
  assert.ok(readiness.availableServices.includes('OFFICIAL_PIT_PLAYER_FEATURES'));
  assert.ok(readiness.availableServices.includes('INDEPENDENT_JOINT_SCORE_DISTRIBUTION'));
  assert.ok(readiness.settlementBlockers.some(row => row.code === 'FIRST5_OFFICIAL_RESULT_FEED_NOT_CONNECTED'));
  assert.ok(readiness.formalRecommendationBlockers.some(row => row.code === 'LOCKED_OOS_FORWARD_VALIDATION_INCOMPLETE'));
  assert.equal(readiness.displayAnalysisBlockers.some(row => row.code === 'LOCKED_OOS_FORWARD_VALIDATION_INCOMPLETE'), false,
    'OOS／forward 驗證只能封鎖正式下注，不得混入 W 顯示 blocker');

  const engine = asianDistributionEngineBlocker(leagueId);
  assert.equal(engine.leagueId, leagueId);
  assert.equal(engine.code, 'ASIAN_INDEPENDENT_JOINT_DISTRIBUTION_ENGINE_RELEASED');
  assert.equal(engine.released, true);
  assert.deepEqual(engine.blocks, []);
}

const npb = asianLeagueReleaseReadiness('NPB');
const kbo = asianLeagueReleaseReadiness('KBO');
const cpbl = asianLeagueReleaseReadiness('CPBL');
assert.ok(npb.settlementBlockers.some(row => row.code === 'NPB_FULL_GAME_OFFICIAL_INNINGS_NOT_CONNECTED'));
assert.ok(kbo.settlementBlockers.some(row => row.code === 'KBO_FULL_GAME_OFFICIAL_INNINGS_NOT_CONNECTED'));
assert.equal(cpbl.settlementBlockers.some(row => row.blocks.includes('FULL_GAME_AUTO_SETTLEMENT')), false);
assert.deepEqual(npb.displayAnalysisBlockers, []);
assert.deepEqual(kbo.displayAnalysisBlockers, []);
assert.deepEqual(cpbl.displayAnalysisBlockers, []);

const details = asianFeatureBlockerDetails('KBO', [
  'pointInTimeFeatureSnapshot',
  'officialStarterHandedness',
  'kboWeatherOrDomeScenario',
  'pointInTimeFeatureSnapshot',
]);
assert.deepEqual(details.map(row => row.feature), [
  'pointInTimeFeatureSnapshot',
  'officialStarterHandedness',
  'kboWeatherOrDomeScenario',
]);
assert.ok(details.every(row => row.leagueId === 'KBO'));
assert.throws(() => asianLeagueReleaseReadiness('MLB'), /不支援的亞洲棒球聯盟/);
assert.throws(() => asianLeagueReleaseReadiness('UNKNOWN'), /不支援的亞洲棒球聯盟/);

const mutableCopy = asianLeagueReleaseReadiness('NPB');
mutableCopy.availableServices[0] = 'MUTATED';
assert.equal(asianLeagueReleaseReadiness('NPB').availableServices[0], 'OFFICIAL_SCHEDULE');

console.log('Asian release readiness enables all three independent engines while preserving runtime PIT fail-close and formal blockers PASS');
