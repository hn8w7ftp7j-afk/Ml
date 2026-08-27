import assert from 'node:assert/strict';
import {
  SHADOW_ANALYSIS_MODE,
  SHADOW_SCORE_TYPE,
  analyzeMarkets,
  buildDistributionSnapshot,
  enforceAnalysisModeSafety,
  evaluateMarketsFromDistribution,
  repriceMarkets,
} from '../lib/analysis-v11.js';
import { leagueAnalysisContract } from '../lib/league-provider.js';
import { LEAGUE_IDS, leagueConfig } from '../lib/leagues.js';
import {
  FORMAL_SCORING_ENABLED,
  SCORE_RELEASE_STATUS,
} from '../lib/deterministic-finalizer-v10.js';

assert.deepEqual(LEAGUE_IDS, ['MLB', 'NPB', 'KBO', 'CPBL']);
assert.equal(FORMAL_SCORING_ENABLED, false);
assert.equal(SCORE_RELEASE_STATUS, 'SHADOW_DIAGNOSTIC_UNCALIBRATED_NOT_FORMAL');

for (const league of LEAGUE_IDS) {
  const registry = leagueConfig(league);
  const contract = leagueAnalysisContract(league);
  assert.equal(contract.leagueId, league);
  assert.equal(contract.analysisMode, SHADOW_ANALYSIS_MODE);
  assert.equal(contract.betEligible, false);
  assert.equal(contract.executable, false);
  assert.equal(contract.formalScoringEnabled, false);
  assert.equal(registry.capabilities.formalRecommendations, false);
  assert.equal(registry.capabilities.bets, true, `${league}帳本必須保留`);
  assert.equal(registry.capabilities.analysis, true, `${league}分析能力Gate錯誤`);
  assert.equal(registry.capabilities.ranking, true, `${league}排名能力Gate錯誤`);
}

const unsafe = {
  leagueId: 'MLB', analysisMode: 'FORMAL', executable: true, betEligible: true,
  scoreType: 'FORMAL', unitSuggestion: 0.5, portfolio: [{ unit: 0.5 }],
  results: [{ market: '全場大小', pick: '大8平', executable: true, betEligible: true, scoreType: 'FORMAL', unitSuggestion: 0.5 }],
};
const locked = enforceAnalysisModeSafety(unsafe, { leagueId: 'MLB', analysisMode: SHADOW_ANALYSIS_MODE });
assert.equal(locked.analysisMode, SHADOW_ANALYSIS_MODE);
assert.equal(locked.executable, false);
assert.equal(locked.betEligible, false);
assert.equal(locked.formalRecommendationsEnabled, false);
assert.deepEqual(locked.portfolio, []);
assert.equal(locked.results[0].scoreType, SHADOW_SCORE_TYPE);
assert.equal(locked.results[0].unitSuggestion, null);

for (const leagueId of ['NPB', 'KBO', 'CPBL']) {
  const context = {
    leagueId,
    game: { leagueId, league: leagueId, gamePk: 900000 + leagueId.length },
    analysisMode: SHADOW_ANALYSIS_MODE,
  };
  const calls = [
    () => buildDistributionSnapshot({ context }),
    () => analyzeMarkets({ context, markets: [] }),
    () => evaluateMarketsFromDistribution({ context, markets: [], distributionSnapshot: {} }),
    () => repriceMarkets({ context, markets: [], distributionSnapshot: {} }),
  ];
  for (const call of calls) {
    assert.throws(call, error => error?.code === 'ASIAN_DISTRIBUTION_INPUT_GATE_BLOCKED'
      && /禁止回退analysis-v10或MLB參數/.test(error?.message || ''));
  }
}

console.log('Four-league boundary PASS: independent engines released; incomplete Asian PIT contexts fail closed');
