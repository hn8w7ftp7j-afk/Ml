import assert from 'node:assert/strict';
import { buildAsianGameContext } from '../lib/asian-baseball.js';
import { analyzeMarkets, buildDistributionSnapshot } from '../lib/analysis-v11.js';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';

const teams = {
  NPB: { away: '讀賣巨人', home: '埼玉西武獅', awayCode: 'YOM', homeCode: 'SEI', awayTeamId: 501, homeTeamId: 512 },
  KBO: { away: '三星獅', home: 'LG雙子', awayCode: 'SAM', homeCode: 'LGT', awayTeamId: 602, homeTeamId: 603 },
  CPBL: { away: '樂天桃猿', home: '中信兄弟', awayCode: 'RKM', homeCode: 'CTB', awayTeamId: 703, homeTeamId: 701 },
};

function gameFor(league, overrides = {}) {
  const row = teams[league];
  return {
    ...row,
    league,
    leagueId: league,
    gamePk: 990000 + row.awayTeamId,
    gameDate: '2099-08-25T10:00:00.000Z',
    officialDate: '2099-08-25',
    taipeiDate: '2099-08-25',
    statusCode: 'S',
    scheduledInnings: 9,
    gameNumber: 1,
    venue: `Synthetic ${league} Venue`,
    awayProbable: `${league} Synthetic Away Starter`,
    homeProbable: `${league} Synthetic Home Starter`,
    awayProbableId: `${league}-A-SP`,
    homeProbableId: `${league}-H-SP`,
    probableSource: `${league}_OFFICIAL_SYNTHETIC_FIXTURE`,
    ...overrides,
  };
}

function historyFor(game) {
  return Array.from({ length: 16 }, (_, index) => ({
    ...game,
    gamePk: game.gamePk + index + 1,
    gameDate: `2099-08-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
    officialDate: `2099-08-${String(index + 1).padStart(2, '0')}`,
    statusCode: 'F',
    awayScore: [2, 4, 5, 3][index % 4],
    homeScore: [3, 2, 1, 4][index % 4],
    innings: index % 6 === 0 ? 10 : 9,
  }));
}

function teamFeature(league, side, throws) {
  const shortSide = side === 'away' ? 'A' : 'H';
  return {
    teamStrength: {
      available: true,
      metricScope: 'TEAM_STRENGTH_BASELINE',
      baselineMethod: 'CURRENT_SEASON_WITH_REGRESSED_PRIOR',
      priorSeasonRegressed: true,
      source: `SYNTHETIC_${league}_${side}_TEAM_STRENGTH`,
      seasonHitting: { gamesPlayed: 100, runsPerGame: 4.2, ops: 0.73, iso: 0.15, kRate: 0.22, bbRate: 0.09 },
      recentHitting: { gamesPlayed: 10, runsPerGame: 4.1, ops: 0.72, iso: 0.14, kRate: 0.23, bbRate: 0.08 },
    },
    starter: {
      id: `${league}-${shortSide}-SP`,
      teamId: teams[league][side === 'away' ? 'awayTeamId' : 'homeTeamId'],
      name: `${league} Synthetic ${side === 'away' ? 'Away' : 'Home'} Starter`,
      identityConfirmed: true,
      performanceAvailable: true,
      performanceScope: 'INDIVIDUAL_STARTER',
      independentOfTeamResults: true,
      performanceSource: `SYNTHETIC_${league}_${side}_INDIVIDUAL_STARTER`,
      throws,
      expectedInnings: 5.3,
      season: { gamesStarted: 20, inningsPitched: 114, era: 3.5, fip: 3.7, whip: 1.2, kMinusBB: 0.16, hrPer9: 0.9 },
      recent: { gamesStarted: 5, inningsPitched: 29, era: 3.4, fip: 3.6, whip: 1.18, kMinusBB: 0.17, hrPer9: 0.85 },
      pitchQuality: { available: true, runFactor: 0.99 },
    },
    lineup: {
      available: true,
      official: false,
      projected: true,
      credibleScenario: true,
      source: `SYNTHETIC_${league}_${side}_LINEUP`,
      offensiveIndex: 1,
      players: Array.from({ length: 9 }, (_, index) => ({ id: `${league}-${side}-BAT-${index + 1}` })),
    },
    bullpen: {
      available: true,
      pureRelief: true,
      usageAvailable: true,
      qualityScope: 'PURE_RELIEF',
      source: `SYNTHETIC_${league}_${side}_RELIEF_ONLY`,
      projectionBased: true,
      qualityFactor: 1,
      fatigueIndex: 0.2,
      highLeverageAvailability: 0.8,
    },
  };
}

function featuresFor(league) {
  return {
    asOf: '2099-08-25T08:00:00.000Z',
    away: teamFeature(league, 'away', 'R'),
    home: teamFeature(league, 'home', 'L'),
    park: {
      available: true,
      recognized: true,
      isNeutralPlaceholder: false,
      name: `Synthetic ${league} Park`,
      runFactor: 0.99,
      roof: league === 'KBO' ? 'dome' : 'outdoor',
      roofConfirmed: true,
      dome: league === 'KBO',
      source: `SYNTHETIC_${league}_PARK_REGISTRY`,
      factorMethod: 'SYNTHETIC_REGRESSED_MULTI_SEASON',
    },
    rules: league === 'CPBL' ? {
      foreignPlayerConstraint: { status: 'NOT_APPLICABLE', source: 'SYNTHETIC_CPBL_ROSTER_AUDIT' },
    } : {},
  };
}

async function contextFor(league, game = gameFor(league), features = featuresFor(league)) {
  return buildAsianGameContext(league, game, { historyGames: historyFor(game), featureSnapshot: features });
}

function eightMarkets(game) {
  const row = (market, pick, water) => ({
    market, pick, water, waterEstimated: false, sourceType: 'ACTUAL_TW_CREDIT',
    provider: 'TAI888_READER_AUTO', lineFresh: true, executable: true,
    marketVerification: { verified: false, referencePriorEligible: false },
  });
  return [
    row('全場讓分', `${game.away}讓1平`, 0.95), row('全場讓分', `${game.home}受讓1平`, 0.95),
    row('全場大小', '大9平', 0.94), row('全場大小', '小9平', 0.94),
    row('上半讓分', `${game.away}讓0.5`, 0.94), row('上半讓分', `${game.home}受讓0.5`, 0.94),
    row('上半大小', '大5平', 0.93), row('上半大小', '小5平', 0.93),
  ];
}

for (const league of ['NPB', 'KBO', 'CPBL']) {
  const context = await contextFor(league);
  assert.equal(context.dataGateV10.passedForShadowScore, true, `${league} 完整 synthetic feature contract 應可建立影子分布`);
  assert.equal(context.dataGateV10.passedForFormalScore, false);
  assert.equal(context.betEligible, false);
  assert.equal(context.executable, false);
  assert.equal(context.provider.mlbFallbackAllowed, false);
  assert.equal(context.asianProxyAudit.mlbFallbackUsed, false);
  assert.equal(context.analysisReadiness.coreInputsReady, true);
  assert.equal(context.analysisReadiness.distributionEngineReady, true);
  assert.equal(context.analysisReadiness.status, 'READY_SHADOW_RUNTIME_PIT');
  assert.deepEqual(context.analysisReadiness.blockers, []);
  const distribution = buildDistributionSnapshot({ context });
  assert.equal(distribution.leagueId, league);
  assert.equal(distribution.legacyDistributionUsed, false);
  assert.equal(distribution.mlbParameterFallbackUsed, false);
  assert.equal(distribution.tai888ProbabilityInputUsed, false);
  assert.equal(distribution.scenarios.length, 27);
  const analysis = analyzeMarkets({ context, markets: eightMarkets(context.game), settings: { rebateRate: 0.015 } });
  assert.equal(analysis.results.length, 8, `${league}必須由同一份獨立分布計算八方向`);
  assert.equal(new Set(analysis.results.map(row => row.distributionId)).size, 1);
  for (const row of analysis.results) {
    assert.ok(Number.isFinite(row.weightedEV), `${league} ${row.pick} W必須可計算`);
    assert.ok(Number.isFinite(row.robustEV), `${league} ${row.pick} R必須可計算`);
    assert.ok(row.robustEV <= row.weightedEV + 1e-12);
    assert.equal(row.evDoubleCheck.passed, true);
    assert.ok(row.settlementIdentityAudit.probabilityIdentityError < 1e-12);
    assert.ok(row.settlementIdentityAudit.evIdentityError < 1e-9);
  }
  const finalized = finalizeDeterministicAnalysis({ analysis, game: context.game, settings: { candidateThreshold: 7.2 } });
  assert.equal(finalized.results.length, 8);
  assert.ok(finalized.results.every(row => Number.isFinite(row.formulaDiagnosticScore)), `${league}八方向必須沿用既有固定S公式`);
  assert.ok(finalized.results.every(row => row.scoreAudit?.ok === true), `${league}八方向固定S／W／R與Tai888逐腿結算QA必須通過`);
}

for (const league of ['NPB', 'KBO', 'CPBL']) {
  const officialNotPublished = featuresFor(league);
  officialNotPublished.away = { teamStrength: officialNotPublished.away.teamStrength };
  officialNotPublished.home = { teamStrength: officialNotPublished.home.teamStrength };
  officialNotPublished.park = null;
  officialNotPublished.rules = {};
  delete officialNotPublished.weather;
  const predicted = await contextFor(league, gameFor(league, {
    awayProbable: '', homeProbable: '', awayProbableId: null, homeProbableId: null, probableSource: '',
  }), officialNotPublished);
  assert.equal(predicted.dataGateV10.passedForShadowScore, true, `${league}官方先發／打線尚未公布時必須改走預測`);
  assert.equal(predicted.starterModelingMode, 'OFFICIAL_FIRST_ROTATION_PREDICTION_FALLBACK');
  assert.equal(predicted.away.starter.status, 'PROJECTED');
  assert.equal(predicted.away.lineup.status, 'PROJECTED_TEAM_OFFENSE_SCENARIO');
  assert.equal(predicted.away.bullpen.status, 'PROJECTED_NEUTRAL_RELIEF_SCENARIO');
  assert.equal(predicted.dataGateV10.rows.find(row => row.name === 'recognizedVenueParkFactor').status, 'PROJECTED');
  assert.ok(predicted.dataGateV10.projected.includes('starterIdentityAndIndependentPerformance'));
  const distribution = buildDistributionSnapshot({ context: predicted });
  assert.equal(distribution.scenarios.length, 27);
}

const npb = await contextFor('NPB');
assert.equal(npb.leagueRuleState.npb.interleague, true);
assert.equal(npb.leagueRuleState.npb.designatedHitter, true, 'NPB 交流戰應按太平洋聯盟主場解析 DH');
assert.equal(npb.leagueRules.dh.interleagueUsesHomeVenueRule, true);

const namedOnlyGame = gameFor('NPB');
const namedOnly = await buildAsianGameContext('NPB', namedOnlyGame, { historyGames: historyFor(namedOnlyGame) });
assert.equal(namedOnly.away.starter.identityConfirmed, true);
assert.equal(namedOnly.away.starter.performanceAvailable, false);
assert.equal(namedOnly.away.starter.era, null);
assert.equal(namedOnly.dataGateV10.passedForShadowScore, false);
assert.equal(namedOnly.analysisReadiness.status, 'BLOCKED_RUNTIME_INPUT');
assert.equal(namedOnly.analysisReadiness.distributionEngineReady, true);
assert.ok(namedOnly.dataGateV10.blockerDetails.every(row => typeof row.code === 'string' && row.code.length > 0));
assert.ok(namedOnly.dataGateV10.rows.every(row => typeof row.ready === 'boolean'));

const projectedCpblFeatures = featuresFor('CPBL');
projectedCpblFeatures.away.starter = {
  ...projectedCpblFeatures.away.starter,
  assignmentStatus: 'PROJECTED_ROTATION_SCENARIO',
  performanceSource: 'CPBL_OFFICIAL_INDIVIDUAL_STARTER_PIT',
  qualityMetricScope: 'INDIVIDUAL_STARTER_RUN_PREVENTION',
  qualityFactor: 1.02,
  expectedInnings: 5.5,
  season: { gamesStarted: 0, inningsPitched: 6, era: 1.5, whip: 1.5, battersFaced: 26 },
  recent: { gamesStarted: 1, inningsPitched: 6 },
};
const projectedCpbl = await contextFor('CPBL', gameFor('CPBL'), projectedCpblFeatures);
assert.equal(projectedCpbl.away.starter.performanceAvailable, true, '官方輪值預測可使用新投手已完成的一軍個人先發並高度回歸');
assert.equal(projectedCpbl.dataGateV10.passedForShadowScore, true);

const insufficientProjectedCpblFeatures = structuredClone(projectedCpblFeatures);
insufficientProjectedCpblFeatures.away.starter.season.battersFaced = 8;
insufficientProjectedCpblFeatures.away.starter.recent.inningsPitched = 1.2;
const insufficientProjectedCpbl = await contextFor('CPBL', gameFor('CPBL'), insufficientProjectedCpblFeatures);
assert.equal(insufficientProjectedCpbl.dataGateV10.passedForShadowScore, true, '個人樣本不足時應退回擴大不確定性的預測，不得整場QA BLOCK');
assert.ok(insufficientProjectedCpbl.dataGateV10.projected.includes('starterIdentityAndIndependentPerformance'));
assert.equal(insufficientProjectedCpbl.away.starter.status, 'PROJECTED');
assert.equal(insufficientProjectedCpbl.away.starter.performanceAvailable, false, '樣本不足不得冒充已確認的個人先發表現');

const disguisedTeamRa = featuresFor('NPB');
disguisedTeamRa.away.starter.performanceSource = 'OFFICIAL_TEAM_RESULTS_TEAM_RATE_PRIOR';
const disguisedTeamRaContext = await contextFor('NPB', gameFor('NPB'), disguisedTeamRa);
assert.equal(disguisedTeamRaContext.away.starter.performanceAvailable, false, '即使標記 independent，整隊比分來源仍不得冒充個別先發能力');
assert.equal(disguisedTeamRaContext.away.starter.projectionMode, 'LEAGUE_NEUTRAL_ROTATION_SCENARIO');
assert.equal(disguisedTeamRaContext.away.starter.qualityFactor, 1, '被拒絕的整隊RA不得滲入先發平均值');
assert.equal(disguisedTeamRaContext.dataGateV10.passedForShadowScore, true, '無效個人資料應改走中性預測，不應整場停分');

const neutralParkFeatures = featuresFor('NPB');
neutralParkFeatures.park = { runFactor: 1, roof: 'unknown' };
const neutralPark = await contextFor('NPB', gameFor('NPB'), neutralParkFeatures);
assert.equal(neutralPark.park.projectionBased, true);
assert.equal(neutralPark.park.runFactor, 1);
assert.equal(neutralPark.dataGateV10.rows.find(row => row.name === 'recognizedVenueParkFactor').status, 'PROJECTED');

const emptyLineupFeatures = featuresFor('NPB');
emptyLineupFeatures.away.lineup.players = [];
const emptyLineup = await contextFor('NPB', gameFor('NPB'), emptyLineupFeatures);
assert.equal(emptyLineup.away.lineup.emptyLineup, true);
assert.equal(emptyLineup.away.lineup.status, 'PROJECTED_TEAM_OFFENSE_SCENARIO');
assert.equal(emptyLineup.dataGateV10.passedForShadowScore, true);

for (const league of ['NPB', 'KBO', 'CPBL']) {
  const missingHandednessFeatures = featuresFor(league);
  missingHandednessFeatures.away.starter.throws = null;
  const missingHandedness = await contextFor(league, gameFor(league), missingHandednessFeatures);
  assert.equal(missingHandedness.dataGateV10.rows.find(row => row.name === 'officialStarterHandedness').status, 'PROJECTED', `${league}左右投未公布應使用中性混合情境`);
  assert.equal(missingHandedness.analysisReadiness.coreInputsReady, true);
}

const kboGame = gameFor('KBO', { awayProbableThrows: 'R' });
const kboConflictFeatures = featuresFor('KBO');
kboConflictFeatures.away.starter.throws = 'L';
const kboConflict = await contextFor('KBO', kboGame, kboConflictFeatures);
assert.equal(kboConflict.away.starter.throws, 'R', 'KBO官方先發左右投必須高於Reader或其他報告');
assert.equal(kboConflict.away.starter.handednessConflict, true);
assert.equal(kboConflict.away.starter.handednessResolution, 'OFFICIAL_SOURCE_WINS');
assert.equal(kboConflict.dataGateV10.passedForShadowScore, true);

const kboOutdoorFeatures = featuresFor('KBO');
kboOutdoorFeatures.park = { ...kboOutdoorFeatures.park, dome: false, roof: 'outdoor' };
const kboOutdoor = await contextFor('KBO', gameFor('KBO'), kboOutdoorFeatures);
assert.equal(kboOutdoor.dataGateV10.rows.find(row => row.name === 'kboWeatherOrDomeScenario').status, 'PROJECTED');
assert.equal(kboOutdoor.weather.meanRunFactor, 1);

const kboDh2Game = gameFor('KBO', { gameNumber: 2, doubleHeader: 'Y' });
const kboDh2Blocked = await contextFor('KBO', kboDh2Game, featuresFor('KBO'));
assert.equal(kboDh2Blocked.dataGateV10.rows.find(row => row.name === 'kboDoubleheaderState').status, 'PROJECTED');
assert.equal(kboDh2Blocked.leagueRuleState.kbo.doubleheader.uncertaintyExpanded, true);
const kboDh2Features = featuresFor('KBO');
kboDh2Features.rules.doubleheader = { secondGameBullpenRecomputed: true };
const kboDh2Ready = await contextFor('KBO', kboDh2Game, kboDh2Features);
assert.equal(kboDh2Ready.leagueRuleState.kbo.doubleheader.bullpenRecomputed, true);
assert.equal(kboDh2Ready.dataGateV10.passedForShadowScore, true);

const cpblMissingRuleFeatures = featuresFor('CPBL');
cpblMissingRuleFeatures.rules = {};
const cpblMissingRule = await contextFor('CPBL', gameFor('CPBL'), cpblMissingRuleFeatures);
assert.equal(cpblMissingRule.dataGateV10.rows.find(row => row.name === 'cpblForeignPlayerConstraintState').status, 'PROJECTED');
assert.equal(cpblMissingRule.dataGateV10.passedForShadowScore, true);

const cpblIncompleteTransition = featuresFor('CPBL');
cpblIncompleteTransition.rules.foreignPlayerConstraint = {
  status: 'MODELED',
  applies: true,
  source: 'SYNTHETIC_CPBL_ROSTER_AUDIT',
  pitcherExitLineupTransitionModeled: false,
  first5FullDifferentiated: false,
};
const cpblBlocked = await contextFor('CPBL', gameFor('CPBL'), cpblIncompleteTransition);
assert.ok(cpblBlocked.dataGateV10.blocking.includes('cpblForeignPlayerConstraintState'));
cpblIncompleteTransition.rules.foreignPlayerConstraint.pitcherExitLineupTransitionModeled = true;
cpblIncompleteTransition.rules.foreignPlayerConstraint.first5FullDifferentiated = true;
const cpblModeled = await contextFor('CPBL', gameFor('CPBL'), cpblIncompleteTransition);
assert.equal(cpblModeled.leagueRuleState.cpbl.foreignPlayerConstraint.status, 'MODELED');
assert.equal(cpblModeled.dataGateV10.passedForShadowScore, true);

console.log('Asian league-specific identity, handedness, park, lineup, bullpen and rule gates PASS');
