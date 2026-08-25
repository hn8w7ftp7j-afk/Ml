import assert from 'node:assert/strict';
import {
  ASIAN_ANALYSIS_MODE,
  asianLeagueConfig,
  buildAsianGameContext,
  fetchAsianFinalResult,
  parseCpblSchedulePayload,
  parseKboOfficialSchedulePayload,
  parseKboScheduleHtml,
  parseNpbMonthHtml,
  parseNpbScheduleHtml,
} from '../lib/asian-baseball.js';
import {
  fetchLeagueTaipeiSlate,
  filterLeaguePrestartGames,
  leagueAnalysisContract,
  validateLeagueScheduleSubset,
} from '../lib/league-provider.js';

const npbDay = `
<div class="unit"><a href="/bis/eng/2099/games/s2099081800001.html">
  <div class="team_name">DeNA</div><div class="score_text score_left">&nbsp;</div>
  <div class="round">Yokohama<br>17:45</div>
  <div class="score_text score_right">&nbsp;</div><div class="team_name">Yomiuri</div>
</a></div>`;
const npb = parseNpbScheduleHtml(npbDay, '2099-08-18');
assert.equal(npb.length, 1);
assert.equal(npb[0].league, 'NPB');
assert.equal(npb[0].awayTeamId, 501);
assert.equal(npb[0].homeTeamId, 503);
assert.equal(npb[0].awayScore, null, '未賽空白比分不得正規化為 0');
assert.equal(npb[0].statusCode, 'S');
assert.equal(npb[0].gameDate, '2099-08-18T08:45:00.000Z');
assert.equal(Number.isSafeInteger(npb[0].gamePk), true);
assert.ok(npb[0].gamePk > 999_999_999, 'Asian gamePk 必須覆蓋舊 security 上限回歸');

const npbRealBoardShape = `
<div class="unit"><a href="/bis/eng/2026/games/s2026082000001.html">
  <div class="team_name">DeNA</div><div class="score_text score_left">&nbsp;</div>
  <div class="round">Yokohama<br>17:45</div>
  <div class="score_text score_right">&nbsp;</div><div class="team_name">Yomiuri</div>
</a></div>
<div class="unit"><a href="/bis/eng/2026/games/s2026082000002.html">
  <div class="team_name">Hanshin</div><div class="score_text score_left">&nbsp;</div>
  <div class="round">Kyocera Dome<br>18:00</div>
  <div class="score_text score_right">&nbsp;</div><div class="team_name">Yakult</div>
</a></div>`;
const npbRealBoard = parseNpbScheduleHtml(npbRealBoardShape, '2026-08-20');
assert.deepEqual(
  npbRealBoard.map(game => [game.awayCode, game.homeCode]),
  [['YOM', 'YDB'], ['YAK', 'HAN']],
  'NPB 官方日程卡左側是主隊、右側是客隊，不得反向配對 Tai888',
);

const npbMonth = `<table class="tetblmain"><tr><td class="stschedule">
  <div class="teschedate"><a>17</a></div><div class="stvsteam">
    <div><a href="/bis/eng/2099/games/s2099081700001.html">DB 4 - 3 G</a></div>
    <div>S * - * C</div>
  </div></td></tr></table>`;
const npbHistory = parseNpbMonthHtml(npbMonth, 2099, 8);
assert.equal(npbHistory.length, 2);
assert.ok(npbHistory.some(game => game.statusCode === 'F'));
assert.ok(npbHistory.some(game => game.statusCode === 'D'));

const kboDoubleheader = `<table><tbody>
<tr><td title="DATE">08.18(TUE)</td><td class="TIME">14:00</td><td title="GAME" class="loop_r">LG</td><td title="GAME"><span class="score_schedule">:</span></td><td title="GAME" class="loop_l">DOOSAN</td><td class="LOCATION">JAMSIL</td><td class="ETC">-</td></tr>
<tr><td class="TIME">14:00</td><td title="GAME" class="loop_r">LG</td><td title="GAME"><span class="score_schedule">:</span></td><td title="GAME" class="loop_l">DOOSAN</td><td class="LOCATION">JAMSIL</td><td class="ETC">-</td></tr>
</tbody></table>`;
const kbo = parseKboScheduleHtml(kboDoubleheader, 2099, 8);
assert.equal(kbo.length, 2, '同日同隊同時間雙重賽不得碰撞');
assert.notEqual(kbo[0].gamePk, kbo[1].gamePk);
assert.deepEqual(kbo.map(game => game.gameNumber), [1, 2]);
assert.equal(kbo[1].doubleHeader, 'Y');

const officialKbo = parseKboOfficialSchedulePayload({ rows: [
  { row: [
    { Text: '08.18(화)', Class: 'day' }, { Text: '<b>14:00</b>', Class: 'time' },
    { Text: '<span>LG</span><em><span>vs</span></em><span>두산</span>', Class: 'play' },
    { Text: "<a href='?gameId=20990818LGOB0&section=PREVIEW'>프리뷰</a>", Class: 'relay' },
    { Text: '' }, { Text: '' }, { Text: '잠실' }, { Text: '-' },
  ] },
  { row: [
    { Text: '<b>18:00</b>', Class: 'time' },
    { Text: '<span>LG</span><em><span>vs</span></em><span>두산</span>', Class: 'play' },
    { Text: "<a href='?gameId=20990818LGOB1&section=PREVIEW'>프리뷰</a>", Class: 'relay' },
    { Text: '' }, { Text: '' }, { Text: '잠실' }, { Text: '-' },
  ] },
] }, 2099, 8);
assert.equal(officialKbo.length, 2);
assert.deepEqual(new Set(officialKbo.map(game => game.providerGameId)), new Set(['20990818LGOB0', '20990818LGOB1']));
assert.notEqual(officialKbo[0].gamePk, officialKbo[1].gamePk, '官方 gameId 必須隔離 KBO 雙重賽');

const scheduledKbo = parseKboOfficialSchedulePayload({ rows: [{ row: [
  { Text: '08.20(목)', Class: 'day' }, { Text: '<b>19:00</b>', Class: 'time' },
  { Text: '<span>KT</span><em><span class="same">0</span><span>vs</span><span class="same">0</span></em><span>LG</span>', Class: 'play' },
  { Text: '', Class: 'relay' }, { Text: '' }, { Text: 'SPO-T' }, { Text: '' }, { Text: '잠실' }, { Text: '-' },
] }] }, 2099, 8);
assert.equal(scheduledKbo.length, 1);
assert.equal(scheduledKbo[0].statusCode, 'S', 'KBO 賽前 same 0:0 是 placeholder，不得誤判終場');
assert.equal(scheduledKbo[0].awayScore, null);
assert.equal(scheduledKbo[0].homeScore, null);
assert.equal(filterLeaguePrestartGames('KBO', scheduledKbo, Date.parse('2099-08-20T00:00:00Z')).length, 1);

const cpbl = parseCpblSchedulePayload({ Data: { Games: [
  {
    GameId: '2099-A-101', KindCode: 'A', GameStatus: 'SCHEDULED', PreExeDate: '2099-08-18T18:35:00', GameSno: 101, InningSeq: 0,
    Visiting: { Team: { Code: 'AJL011', Name: '樂天桃猿' }, Score: 0 },
    Home: { Team: { Code: 'AAA011', Name: '味全龍' }, Score: 0 }, Field: { Abbe: '大巨蛋' },
  },
  {
    GameId: '2099-A-102', KindCode: 'A', GameStatus: 'FINISHED', PreExeDate: '2099-08-18T18:35:00', GameSno: 102, InningSeq: 11,
    Visiting: { Team: { Code: 'AEO011', Name: '富邦悍將' }, Score: 5 },
    Home: { Team: { Code: 'ADD011', Name: '統一7-ELEVEn獅' }, Score: 4 }, Field: { Abbe: '亞太' },
  },
  {
    GameId: '2099-D-103', KindCode: 'D', GameStatus: 'SCHEDULED', PreExeDate: '2099-08-18T13:05:00', GameSno: 103, InningSeq: 0,
    Visiting: { Team: { Code: 'AJL011', Name: '樂天桃猿' }, Score: 0 },
    Home: { Team: { Code: 'AAA011', Name: '味全龍' }, Score: 0 }, Field: { Abbe: '二軍球場' },
  },
] } }, '2099-08-18');
assert.equal(cpbl.length, 2);
assert.equal(cpbl.find(game => game.statusCode === 'S').awayScore, null, 'CPBL SCHEDULED 的官方 0 只是 placeholder');
assert.equal(cpbl.find(game => game.statusCode === 'F').innings, 11, 'CPBL 必須使用 InningSeq，不可誤用 GameSno');

const fetchImpl = async url => {
  if (String(url).includes('/announcement/starter/')) return { ok: true, text: async () => '' };
  assert.match(String(url), /npb\.jp\/bis\/eng\/2099\/games\/gm20990818\.html/);
  return { ok: true, text: async () => npbDay };
};
const slate = await fetchLeagueTaipeiSlate('NPB', '2099-08-18', { fetchImpl, timeoutMs: 1_000 });
assert.equal(slate[0].league, 'NPB');
assert.equal(slate[0].leagueId, 'NPB');
assert.deepEqual(validateLeagueScheduleSubset('NPB', [slate[0]], slate, '2099-08-18'), slate);
assert.throws(
  () => validateLeagueScheduleSubset('NPB', [{ ...slate[0], homeTeamId: 999 }], slate, '2099-08-18'),
  error => error?.code === 'OFFICIAL_IDENTITY_MISMATCH',
);
assert.equal(filterLeaguePrestartGames('NPB', slate, Date.parse('2099-08-18T00:00:00Z')).length, 1);

for (const league of ['NPB', 'KBO', 'CPBL']) {
  const config = asianLeagueConfig(league);
  const contract = leagueAnalysisContract(league);
  assert.equal(contract.analysisMode, ASIAN_ANALYSIS_MODE);
  assert.equal(contract.betEligible, false);
  assert.equal(contract.executable, false);
  assert.notEqual(config.modelVersion, leagueAnalysisContract('MLB').modelVersion);
  assert.equal(config.mlbFallbackAllowed, false);
  assert.equal(config.featureContract.starter.teamRunsAllowedProxyAllowed, false);
  assert.equal(config.featureContract.bullpen.teamRunsAllowedProxyAllowed, false);
  assert.equal(config.featureContract.lineup.emptyPlayersQualify, false);
  assert.equal(config.featureContract.park.neutralPlaceholderQualifies, false);
  for (const section of ['baselineBounds', 'scoreClamps']) {
    for (const period of ['full', 'first5']) {
      assert.ok(Number.isFinite(config.modelConfig[section][period].min));
      assert.ok(Number.isFinite(config.modelConfig[section][period].max));
    }
  }
  assert.ok(Number.isFinite(config.modelConfig.homeCoefficient.full));
  assert.ok(Number.isFinite(config.modelConfig.shrink.first5));
}

const historyGames = [
  { ...npb[0], gamePk: 1101, gameDate: '2099-08-15T09:00:00.000Z', officialDate: '2099-08-15', statusCode: 'F', awayScore: 5, homeScore: 2 },
  { ...npb[0], gamePk: 1102, gameDate: '2099-08-16T09:00:00.000Z', officialDate: '2099-08-16', statusCode: 'F', awayScore: 1, homeScore: 4 },
];
const context = await buildAsianGameContext('NPB', npb[0], { historyGames });
assert.equal(context.coreModelable, false);
assert.equal(context.analysisMode, ASIAN_ANALYSIS_MODE);
assert.equal(context.betEligible, false);
assert.equal(context.executable, false);
assert.equal(context.league.id, 'NPB');
assert.match(context.modelVersion, /^NPB-/);
assert.match(context.rulesVersion, /^NPB-/);
assert.ok(context.historyGameCount === 2);
assert.deepEqual(Object.keys(context.modelConfig.baselineBounds).sort(), ['first5', 'full']);
assert.equal(context.dataGateV10.passedForShadowScore, false);
assert.equal(context.dataGateV10.passedForFormalScore, false);
for (const missing of ['pointInTimeFeatureSnapshot', 'teamStrengthBaseline', 'starterIdentityAndIndependentPerformance', 'credibleLineupScenario', 'pureReliefBullpen', 'recognizedVenueParkFactor']) {
  assert.ok(context.dataGateV10.missing.includes(missing), `${missing} 必須 fail closed`);
}
assert.equal(context.away.starter.projectionMode, 'STARTER_IDENTITY_AND_PERFORMANCE_MISSING');
assert.equal(context.away.starter.expectedInnings, null);
assert.equal(context.away.starter.era, null, '整隊 RA 不得偽裝成個別先發 ERA');
assert.equal(context.away.starter.fip, null, '整隊 RA 不得偽裝成個別先發 FIP');
assert.equal(context.away.starter.whip, null, '整隊 RA 不得偽裝成個別先發 WHIP');
assert.equal(context.away.seasonPitching.era, null, '整隊比分代理不得命名成投手 ERA');
assert.equal(context.away.bullpen.pureRelief, false);
assert.equal(context.away.bullpen.usageAvailable, false, '整隊賽程推估不得偽裝成純牛棚 workload');
assert.equal(context.away.lineup.players.length, 0);
assert.equal(context.away.lineup.available, false, '空打線不得被視為可信預估');
assert.equal(context.park.isNeutralPlaceholder, true);
assert.equal(context.park.recognized, false, '中性 1.00 placeholder 不得通過球場資料');
assert.equal(context.asianProxyAudit.teamRunsUsedAsStarterPerformance, false);
assert.equal(context.asianProxyAudit.teamRunsUsedAsPureBullpenQuality, false);
assert.equal(context.gameStateModel.bottomNinthMayBeSkipped, true);
assert.equal(context.gameStateModel.regulationWalkoff, true);
assert.equal(context.gameStateModel.allowDraw, true);
assert.equal(context.gameStateModel.automaticRunner, false);

const sufficientHistory = Array.from({ length: 12 }, (_, index) => ({
  ...npb[0],
  gamePk: 2100 + index,
  gameDate: `2099-08-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
  officialDate: `2099-08-${String(index + 1).padStart(2, '0')}`,
  statusCode: 'F',
  awayScore: [2, 5, 1, 4][index % 4],
  homeScore: [3, 1, 6, 2][index % 4],
  innings: index % 5 === 0 ? 10 : 9,
}));
const projectedContext = await buildAsianGameContext('NPB', npb[0], { historyGames: sufficientHistory });
assert.equal(projectedContext.coreModelable, false, '增加整隊比分樣本仍不得補出先發、打線、純牛棚與球場能力');
assert.equal(projectedContext.dataGateV10.passedForShadowScore, false);
assert.equal(projectedContext.away.lineup.status, 'MISSING');
assert.equal(projectedContext.away.bullpen.projectionBased, true);
assert.equal(projectedContext.away.bullpen.pureRelief, false);
assert.equal(projectedContext.away.lineup.offensiveIndex, 1, '近期得分不得再透過預估打線指數重複計算');
assert.ok(projectedContext.asianCalibration.sampleReliability > 0 && projectedContext.asianCalibration.sampleReliability < 1);
assert.ok(projectedContext.modelConfig.shrink.full < 0.30, '小樣本必須以經驗貝氏方式強烈收縮');

const namedStarterContext = await buildAsianGameContext('NPB', {
  ...npb[0],
  awayProbable: 'Named Away Starter', awayProbableId: 99001,
  homeProbable: 'Named Home Starter', homeProbableId: 99002,
  probableSource: 'NPB_OFFICIAL_PROBABLE_STARTER',
}, { historyGames: sufficientHistory });
assert.equal(namedStarterContext.away.starter.identityConfirmed, true);
assert.equal(namedStarterContext.away.starter.confirmed, false, '確認先發姓名不等於確認投手能力資料');
assert.equal(namedStarterContext.away.starter.performanceAvailable, false);
assert.equal(namedStarterContext.away.starter.era, null);
assert.equal(namedStarterContext.sourceStatuses.starters, 'MISSING_INDIVIDUAL_PERFORMANCE');
assert.equal(namedStarterContext.starterModelingMode, 'IDENTITY_ONLY_CORE_PERFORMANCE_BLOCKED');
assert.equal(namedStarterContext.dataGateV10.passedForShadowScore, false);

function qualifiedTeamSnapshot(id, name, throws, label, teamId) {
  return {
    teamStrength: {
      available: true,
      metricScope: 'TEAM_STRENGTH_BASELINE',
      baselineMethod: 'CURRENT_SEASON_WITH_REGRESSED_PRIOR',
      priorSeasonRegressed: true,
      source: `SYNTHETIC_${label}_TEAM_STRENGTH`,
      seasonHitting: { gamesPlayed: 100, runsPerGame: 4.1, ops: 0.73, iso: 0.15, kRate: 0.22, bbRate: 0.09 },
      recentHitting: { gamesPlayed: 10, runsPerGame: 4.0, ops: 0.72, iso: 0.14, kRate: 0.23, bbRate: 0.08 },
    },
    starter: {
      id,
      teamId,
      name,
      identityConfirmed: true,
      performanceAvailable: true,
      performanceScope: 'INDIVIDUAL_STARTER',
      independentOfTeamResults: true,
      performanceSource: `SYNTHETIC_${label}_INDIVIDUAL_STARTER`,
      throws,
      expectedInnings: 5.2,
      season: { gamesStarted: 18, inningsPitched: 101, era: 3.4, fip: 3.6, whip: 1.18, kMinusBB: 0.16, hrPer9: 0.9 },
      recent: { gamesStarted: 5, inningsPitched: 28, era: 3.2, fip: 3.5, whip: 1.15, kMinusBB: 0.17, hrPer9: 0.8 },
      pitchQuality: { available: true, runFactor: 0.98 },
    },
    lineup: {
      available: true,
      official: false,
      projected: true,
      credibleScenario: true,
      source: `SYNTHETIC_${label}_PROJECTED_LINEUP`,
      offensiveIndex: 1.01,
      players: Array.from({ length: 9 }, (_, index) => ({ id: `${label}-BAT-${index + 1}` })),
    },
    bullpen: {
      available: true,
      pureRelief: true,
      usageAvailable: true,
      qualityScope: 'PURE_RELIEF',
      source: `SYNTHETIC_${label}_RELIEF_ONLY`,
      projectionBased: true,
      qualityFactor: 0.99,
      fatigueIndex: 0.22,
      highLeverageAvailability: 0.78,
    },
  };
}

const qualifiedGame = {
  ...npb[0],
  awayProbable: 'Synthetic Away Starter', awayProbableId: 'NPB-A-1',
  homeProbable: 'Synthetic Home Starter', homeProbableId: 'NPB-H-1',
  probableSource: 'NPB_OFFICIAL_PROBABLE_STARTER',
};
const qualifiedFeatures = {
  asOf: '2099-08-18T07:00:00.000Z',
  away: qualifiedTeamSnapshot('NPB-A-1', 'Synthetic Away Starter', 'R', 'AWAY', npb[0].awayTeamId),
  home: qualifiedTeamSnapshot('NPB-H-1', 'Synthetic Home Starter', 'L', 'HOME', npb[0].homeTeamId),
  park: {
    available: true,
    recognized: true,
    isNeutralPlaceholder: false,
    name: 'Synthetic NPB Park',
    runFactor: 0.98,
    roof: 'outdoor',
    roofConfirmed: true,
    factorMethod: 'SYNTHETIC_REGRESSED_MULTI_SEASON',
    source: 'SYNTHETIC_NPB_PARK_REGISTRY',
  },
};
const qualifiedContext = await buildAsianGameContext('NPB', qualifiedGame, {
  historyGames: sufficientHistory,
  featureSnapshot: qualifiedFeatures,
});
assert.equal(qualifiedContext.coreModelable, true);
assert.equal(qualifiedContext.dataGateV10.passedForShadowScore, true);
assert.equal(qualifiedContext.dataGateV10.passedForFormalScore, false);
assert.equal(qualifiedContext.betEligible, false);
assert.equal(qualifiedContext.executable, false);
assert.equal(qualifiedContext.away.starter.confirmed, true);
assert.equal(qualifiedContext.away.starter.performanceScope, 'INDIVIDUAL_STARTER');
assert.equal(qualifiedContext.away.bullpen.pureRelief, true);
assert.equal(qualifiedContext.away.lineup.players.length, 9);
assert.equal(qualifiedContext.park.recognized, true);
assert.equal(qualifiedContext.leagueRuleState.npb.status, 'RESOLVED');
assert.equal(qualifiedContext.leagueRuleState.npb.designatedHitter, false, '央聯主場測試場應解析為無 DH');

const identityMismatch = await buildAsianGameContext('NPB', qualifiedGame, {
  historyGames: sufficientHistory,
  featureSnapshot: {
    ...qualifiedFeatures,
    away: {
      ...qualifiedFeatures.away,
      starter: { ...qualifiedFeatures.away.starter, id: 'WRONG-PITCHER-ID' },
    },
  },
});
assert.equal(identityMismatch.coreModelable, false);
assert.equal(identityMismatch.away.starter.identityMismatch, true);
assert.ok(identityMismatch.dataGateV10.blocking.includes('starterIdentityAndIndependentPerformance'));

await assert.rejects(
  () => buildAsianGameContext('NPB', npb[0], {
    fetchImpl: async url => ({
      ok: !String(url).includes('index_07.html'),
      status: 503,
      text: async () => npbMonth,
    }),
  }),
  error => error?.code === 'ASIAN_HISTORY_INCOMPLETE',
  '任一歷史月份失敗不得靜默縮短樣本後繼續評分',
);

await assert.rejects(
  () => fetchAsianFinalResult('NPB', npb[0].gamePk, ''),
  error => error?.code === 'RESULT_DATE_REQUIRED',
);

console.log('Asian official fixture parsers, safe identity, doubleheader and shadow context PASS');
