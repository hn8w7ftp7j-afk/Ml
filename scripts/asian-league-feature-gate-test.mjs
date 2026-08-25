import assert from 'node:assert/strict';
import { buildAsianGameContext } from '../lib/asian-baseball.js';
import { buildDistributionSnapshot } from '../lib/analysis-v11.js';

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

for (const league of ['NPB', 'KBO', 'CPBL']) {
  const context = await contextFor(league);
  assert.equal(context.dataGateV10.passedForShadowScore, true, `${league} 完整 synthetic feature contract 應可建立影子分布`);
  assert.equal(context.dataGateV10.passedForFormalScore, false);
  assert.equal(context.betEligible, false);
  assert.equal(context.executable, false);
  assert.equal(context.provider.mlbFallbackAllowed, false);
  assert.equal(context.asianProxyAudit.mlbFallbackUsed, false);
  assert.throws(
    () => buildDistributionSnapshot({ context }),
    error => error?.code === 'LEAGUE_DISTRIBUTION_ENGINE_NOT_RELEASED' && String(error?.message || '').includes('禁止回退'),
    `${league} 獨立比分引擎未發布時，即使上游完整也不得回退legacy／MLB產生數字分數`,
  );
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

const disguisedTeamRa = featuresFor('NPB');
disguisedTeamRa.away.starter.performanceSource = 'OFFICIAL_TEAM_RESULTS_TEAM_RATE_PRIOR';
const disguisedTeamRaContext = await contextFor('NPB', gameFor('NPB'), disguisedTeamRa);
assert.equal(disguisedTeamRaContext.away.starter.performanceAvailable, false, '即使標記 independent，整隊比分來源仍不得冒充個別先發能力');
assert.ok(disguisedTeamRaContext.dataGateV10.blocking.includes('starterIdentityAndIndependentPerformance'));

const neutralParkFeatures = featuresFor('NPB');
neutralParkFeatures.park = { runFactor: 1, roof: 'unknown' };
const neutralPark = await contextFor('NPB', gameFor('NPB'), neutralParkFeatures);
assert.equal(neutralPark.park.isNeutralPlaceholder, true);
assert.ok(neutralPark.dataGateV10.blocking.includes('recognizedVenueParkFactor'));

const emptyLineupFeatures = featuresFor('NPB');
emptyLineupFeatures.away.lineup.players = [];
const emptyLineup = await contextFor('NPB', gameFor('NPB'), emptyLineupFeatures);
assert.equal(emptyLineup.away.lineup.emptyLineup, true);
assert.ok(emptyLineup.dataGateV10.blocking.includes('credibleLineupScenario'));

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
assert.ok(kboOutdoor.dataGateV10.blocking.includes('kboWeatherOrDomeScenario'));

const kboDh2Game = gameFor('KBO', { gameNumber: 2, doubleHeader: 'Y' });
const kboDh2Blocked = await contextFor('KBO', kboDh2Game, featuresFor('KBO'));
assert.ok(kboDh2Blocked.dataGateV10.blocking.includes('kboDoubleheaderState'));
const kboDh2Features = featuresFor('KBO');
kboDh2Features.rules.doubleheader = { secondGameBullpenRecomputed: true };
const kboDh2Ready = await contextFor('KBO', kboDh2Game, kboDh2Features);
assert.equal(kboDh2Ready.leagueRuleState.kbo.doubleheader.bullpenRecomputed, true);
assert.equal(kboDh2Ready.dataGateV10.passedForShadowScore, true);

const cpblMissingRuleFeatures = featuresFor('CPBL');
cpblMissingRuleFeatures.rules = {};
const cpblMissingRule = await contextFor('CPBL', gameFor('CPBL'), cpblMissingRuleFeatures);
assert.ok(cpblMissingRule.dataGateV10.blocking.includes('cpblForeignPlayerConstraintState'));

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
