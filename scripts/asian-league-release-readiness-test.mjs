import assert from 'node:assert/strict';
import {
  ASIAN_LEAGUE_READINESS_VERSION,
  asianDistributionEngineBlocker,
  asianFeatureBlockerDetails,
  asianLeagueReleaseReadiness,
} from '../lib/asian-league-readiness.js';

assert.equal(ASIAN_LEAGUE_READINESS_VERSION, 'ASIAN-LEAGUE-RELEASE-READINESS-2026-08-v1.0.0');

for (const leagueId of ['NPB', 'KBO', 'CPBL']) {
  const readiness = asianLeagueReleaseReadiness(leagueId);
  assert.equal(readiness.leagueId, leagueId);
  assert.equal(readiness.analysisEnabled, false);
  assert.equal(readiness.canBuildDistribution, false);
  assert.equal(readiness.canCalculateModelEvW, false);
  assert.equal(readiness.canCalculateRobustEvR, false);
  assert.equal(readiness.fullGameScoreAvailable, true);
  assert.equal(readiness.fullGameResultFeedAvailable, leagueId === 'CPBL');
  assert.equal(readiness.fullGameAutoSettlementReady, leagueId === 'CPBL');
  assert.equal(readiness.first5ResultFeedAvailable, false);
  assert.equal(readiness.mlbFallbackAllowed, false);
  assert.equal(readiness.tai888ProbabilityInputAllowed, false);
  assert.ok(readiness.availableServices.includes('OFFICIAL_SCHEDULE'));
  assert.ok(readiness.availableServices.includes('TAI888_READER'));
  assert.ok(readiness.displayAnalysisBlockers.some(row => row.code === 'INDEPENDENT_JOINT_DISTRIBUTION_ENGINE_NOT_RELEASED'));
  assert.ok(readiness.displayAnalysisBlockers.some(row => row.code === 'PIT_STARTER_PERFORMANCE_PIPELINE_NOT_CONNECTED'));
  assert.ok(readiness.settlementBlockers.some(row => row.code === 'FIRST5_OFFICIAL_RESULT_FEED_NOT_CONNECTED'));
  assert.ok(readiness.formalRecommendationBlockers.some(row => row.code === 'LOCKED_OOS_FORWARD_VALIDATION_INCOMPLETE'));
  assert.equal(readiness.displayAnalysisBlockers.some(row => row.code === 'LOCKED_OOS_FORWARD_VALIDATION_INCOMPLETE'), false,
    'OOS／forward 驗證只能封鎖正式下注，不得混入 W 顯示 blocker');

  const codes = readiness.displayAnalysisBlockers.map(row => row.code);
  assert.equal(new Set(codes).size, codes.length, `${leagueId} release blocker code 必須唯一`);
  assert.ok(readiness.displayAnalysisBlockers.every(row => row.blocks.includes('MODEL_EV_W')));
  assert.ok(readiness.displayAnalysisBlockers.every(row => !/TAI888/.test(row.code)), 'Tai888 不得成為比分分布輸入 blocker');

  const engine = asianDistributionEngineBlocker(leagueId);
  assert.equal(engine.leagueId, leagueId);
  assert.equal(engine.code, 'INDEPENDENT_JOINT_DISTRIBUTION_ENGINE_NOT_RELEASED');
}

const npb = asianLeagueReleaseReadiness('NPB');
const kbo = asianLeagueReleaseReadiness('KBO');
const cpbl = asianLeagueReleaseReadiness('CPBL');
assert.ok(npb.settlementBlockers.some(row => row.code === 'NPB_FULL_GAME_OFFICIAL_INNINGS_NOT_CONNECTED'));
assert.ok(kbo.settlementBlockers.some(row => row.code === 'KBO_FULL_GAME_OFFICIAL_INNINGS_NOT_CONNECTED'));
assert.equal(cpbl.settlementBlockers.some(row => row.blocks.includes('FULL_GAME_AUTO_SETTLEMENT')), false);
assert.equal(npb.displayAnalysisBlockers.some(row => row.code === 'KBO_WEATHER_OR_DOME_PIPELINE_NOT_CONNECTED'), false);
assert.ok(kbo.displayAnalysisBlockers.some(row => row.code === 'KBO_WEATHER_OR_DOME_PIPELINE_NOT_CONNECTED'));
assert.ok(kbo.displayAnalysisBlockers.some(row => row.code === 'KBO_DOUBLEHEADER_RECOMPUTE_PIPELINE_NOT_CONNECTED'));
assert.ok(cpbl.displayAnalysisBlockers.some(row => row.code === 'CPBL_FOREIGN_PLAYER_RULE_SNAPSHOT_NOT_CONNECTED'));

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
mutableCopy.displayAnalysisBlockers[0].code = 'MUTATED';
assert.equal(asianLeagueReleaseReadiness('NPB').displayAnalysisBlockers[0].code, 'INDEPENDENT_JOINT_DISTRIBUTION_ENGINE_NOT_RELEASED');

console.log('Asian league release readiness exposes exact fail-closed blockers without MLB/Tai888 fallback PASS');
