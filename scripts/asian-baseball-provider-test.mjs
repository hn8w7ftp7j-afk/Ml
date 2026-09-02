import assert from 'node:assert/strict';
import {
  ASIAN_ANALYSIS_MODE,
  asianLeagueConfig,
  buildAsianGameContext,
  fetchAsianFinalResult,
  normalizeAsianFinalResult,
  parseCpblSchedulePayload,
  parseKboOfficialSchedulePayload,
  parseKboScheduleHtml,
  parseNpbGameDetailHtml,
  parseNpbMonthHtml,
  parseNpbScheduleHtml,
} from '../lib/asian-baseball.js';
import { normalizeMlbFinalResult } from '../lib/mlb.js';
import {
  fetchLeagueTaipeiSlate,
  filterLeaguePrestartGames,
  leagueAnalysisContract,
  validateLeagueFinalResult,
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
  assert.equal(config.releaseReadiness.leagueId, league);
  assert.equal(config.releaseReadiness.canBuildDistribution, true);
  assert.equal(config.releaseReadiness.mlbFallbackAllowed, false);
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
for (const missing of ['officialPrecheckCompleted', 'pointInTimeFeatureSnapshot', 'teamStrengthBaseline', 'starterIdentityAndIndependentPerformance', 'credibleLineupScenario', 'pureReliefBullpen']) {
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
assert.equal(context.park.projectionBased, true);
assert.equal(context.park.recognized, true, '官方場地已知但球場樣本不足時應採聯盟中性預測並標示');
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

const scoreOnlyNpbDay = parseNpbScheduleHtml(npbDay
  .replace('<div class="score_text score_left">&nbsp;</div>', '<div class="score_text score_left">2</div>')
  .replace('<div class="score_text score_right">&nbsp;</div>', '<div class="score_text score_right">3</div>'), '2099-08-18');
assert.equal(scoreOnlyNpbDay[0].statusCode, 'S', 'NPB 日程只有即時比分、沒有明確完賽狀態時不得自動視為終場');
assert.equal(scoreOnlyNpbDay[0].awayScore, null);
assert.equal(scoreOnlyNpbDay[0].homeScore, null);

const npbFinalDetail = `
<div id="gmdivinfo"><table><tr><td>Kyocera Dome</td><td>T - 3:06 ( 18:00 - 21:06 )</td></tr></table></div>
<div id="gmdivscore"><table><tbody><tr><td class="gmboxrun">4</td></tr><tr><td class="gmboxrun">3</td></tr></tbody></table></div>
<div id="gmdivresult"><table><tbody>
<tr><td class="gmscorettl"></td><td class="gmscorettl">R</td><td class="gmscorettl">H</td><td class="gmscorettl">E</td></tr>
<tr><td class="gmscoreteam">Yomiuri</td><td class="gmscore">1</td><td class="gmscore">1</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">1</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">-</td><td class="gmscore">3</td><td class="gmscore">5</td><td class="gmscore">0</td></tr>
<tr><td class="gmscoreteam">DeNA</td><td class="gmscore">2</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">1</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">1</td><td class="gmscore">X</td><td class="gmscore">-</td><td class="gmscore">4</td><td class="gmscore">10</td><td class="gmscore">1</td></tr>
</tbody></table></div>`;
const parsedNpbDetail = parseNpbGameDetailHtml(npbFinalDetail, scoreOnlyNpbDay[0]);
assert.equal(parsedNpbDetail.statusCode, 'F');
assert.equal(parsedNpbDetail.innings, 9);
assert.equal(parsedNpbDetail.awayScore, 3);
assert.equal(parsedNpbDetail.homeScore, 4);
assert.equal(parsedNpbDetail.awayFirst5, 3);
assert.equal(parsedNpbDetail.homeFirst5, 3);
assert.equal(parsedNpbDetail.first5Complete, true);

const npbFinalDetailWithoutDashClass = `
<div id="gmdivinfo">Morioka T - 2:53 ( 18:31 - 21:24 ) Att. - 12,039</div>
<div id="gmdivscore"><span class="gmboxrun">4</span><span class="gmboxrun">0</span></div>
<div id="gmdivresult"><table><tbody>
<tr><th>Team</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th><th>8</th><th>9</th><th>R</th><th>H</th><th>E</th></tr>
<tr><th class="gmscoreteam">Yomiuri</th><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscorerun">0</td><td>7</td><td>0</td></tr>
<tr><th class="gmscoreteam">DeNA</th><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">2</td><td class="gmscore">0</td><td class="gmscore">2</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">0</td><td class="gmscore">X</td><td class="gmscorerun">4</td><td>8</td><td>0</td></tr>
<!-- NPB responsive markup may repeat an identical score table. -->
<tr><th class="gmscoreteam">Yomiuri</th><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>7</td><td>0</td></tr>
<tr><th class="gmscoreteam">DeNA</th><td>0</td><td>0</td><td>2</td><td>0</td><td>2</td><td>0</td><td>0</td><td>0</td><td>X</td><td>4</td><td>8</td><td>0</td></tr>
</tbody></table></div>`;
const parsedNpbNoDash = parseNpbGameDetailHtml(npbFinalDetailWithoutDashClass, scoreOnlyNpbDay[0]);
assert.equal(parsedNpbNoDash.statusCode, 'F', 'NPB 正式頁不把分隔符放在 gmscore 時仍須辨識終場');
assert.deepEqual(
  [parsedNpbNoDash.awayScore, parsedNpbNoDash.homeScore, parsedNpbNoDash.awayFirst5, parsedNpbNoDash.homeFirst5],
  [0, 4, 0, 4],
);

const npbPregameWithoutOfficialLink = `
<span class="link_box"><div class="unit">
  <div class="team_name">DeNA</div><div class="score_text score_left">&nbsp;</div>
  <div class="round">Yokohama<br>17:45</div>
  <div class="score_text score_right">&nbsp;</div><div class="team_name">Yomiuri</div>
</div></span>`;
const legacyNpbGame = parseNpbScheduleHtml(npbPregameWithoutOfficialLink, '2099-08-18')[0];
assert.match(legacyNpbGame.providerGameId, /^2099-08-18\|YOM\|YDB\|17:45\|1$/);

const npbPostgameWithOfficialLink = `
<a class="link_box" href="/bis/eng/2099/games/s2099081800001.html"><div class="unit">
  <div class="team_name">DeNA</div><div class="score_text score_left">4</div>
  <div class="round">Game 18<br>Yokohama</div>
  <div class="score_text score_right">3</div><div class="team_name">Yomiuri</div>
</div></a>`;
const currentNpbGame = parseNpbScheduleHtml(npbPostgameWithOfficialLink, '2099-08-18')[0];
assert.notEqual(currentNpbGame.gamePk, legacyNpbGame.gamePk,
  '回歸前提：NPB 補上官方明細連結後，來源 gamePk 會與賽前 fallback 不同');

const evolvingNpbFetch = async url => ({
  ok: true,
  status: 200,
  text: async () => {
    const value = String(url);
    if (value.includes('/games/gm20990818.html')) return npbPostgameWithOfficialLink;
    if (value.includes('/games/s2099081800001.html')) return npbFinalDetail;
    return '';
  },
});
const legacyNpbResult = await fetchAsianFinalResult('NPB', legacyNpbGame.gamePk, '2099-08-18', {
  fetchImpl: evolvingNpbFetch,
  timeoutMs: 1_000,
  expectedAway: legacyNpbGame.away,
  expectedHome: legacyNpbGame.home,
  expectedGameNumber: legacyNpbGame.gameNumber,
  expectedProviderGameId: legacyNpbGame.providerGameId,
});
assert.equal(legacyNpbResult.gamePk, legacyNpbGame.gamePk,
  '永久帳本必須保留賽前 gamePk，不可被完賽後新增的 NPB 明細 id 改寫');
assert.equal(legacyNpbResult.providerGameId, 's2099081800001');
assert.equal(legacyNpbResult.final, true);
assert.deepEqual(
  [legacyNpbResult.awayRuns, legacyNpbResult.homeRuns, legacyNpbResult.awayFirst5, legacyNpbResult.homeFirst5],
  [3, 4, 3, 3],
  '賽前 fallback identity 必須能唯一連到完賽明細並取得全場／前五局比分',
);

const ambiguousNpbSchedule = npbPostgameWithOfficialLink
  + npbPostgameWithOfficialLink.replaceAll('s2099081800001', 's2099081800002');
await assert.rejects(
  () => fetchAsianFinalResult('NPB', legacyNpbGame.gamePk, '2099-08-18', {
    fetchImpl: async url => ({
      ok: true,
      status: 200,
      text: async () => String(url).includes('/games/gm20990818.html') ? ambiguousNpbSchedule : '',
    }),
    timeoutMs: 1_000,
    expectedAway: legacyNpbGame.away,
    expectedHome: legacyNpbGame.home,
    expectedProviderGameId: legacyNpbGame.providerGameId,
  }),
  error => error?.code === 'OFFICIAL_IDENTITY_AMBIGUOUS',
  '同日同隊多場時不得猜測 NPB 場次或自動結算',
);
assert.equal(
  parseNpbGameDetailHtml(npbFinalDetail.replace('( 18:00 - 21:06 )', '18:00'), scoreOnlyNpbDay[0]).statusCode,
  'S',
  '沒有官方結束時間的進行中明細不得誤判為 Final',
);

const liveKbo = parseKboOfficialSchedulePayload({ rows: [{ row: [
  { Text: '08.18(화)', Class: 'day' }, { Text: '<b>18:00</b>', Class: 'time' },
  { Text: '<span>LG</span><em><span class="win">3</span><span>vs</span><span class="lose">1</span></em><span>두산</span>', Class: 'play' },
  { Text: "<a href='?gameId=20990818LGOB9&section=RELAY'>중계</a>", Class: 'relay' },
  { Text: '' }, { Text: '' }, { Text: '잠실' }, { Text: '5회말' },
] }] }, 2099, 8);
assert.equal(liveKbo[0].statusCode, 'I', 'KBO 진행中比分不得因 win/lose CSS 類別被誤判為終場');
assert.equal(liveKbo[0].awayScore, null);
assert.equal(liveKbo[0].homeScore, null);

const mlbGamePk = 990001;
const mlbInnings = [
  [1, 0], [0, 1], [2, 0], [0, 0], [0, 0],
  [1, 0], [0, 1], [0, 1], [0, 0],
].map(([awayRuns, homeRuns], index) => ({ num: index + 1, away: { runs: awayRuns }, home: { runs: homeRuns } }));
const mlbFeed = {
  gamePk: mlbGamePk,
  metaData: { timeStamp: '20990818123000' },
  gameData: {
    game: { pk: mlbGamePk, gameNumber: 2, scheduledInnings: 9 },
    datetime: { officialDate: '2099-08-18' },
    status: { abstractGameState: 'Final', detailedState: 'Final' },
    teams: {
      away: { id: 147, name: 'New York Yankees' },
      home: { id: 141, name: 'Toronto Blue Jays' },
    },
  },
  liveData: { linescore: { teams: { away: { runs: 4 }, home: { runs: 3 } }, innings: mlbInnings } },
};
const mlbResult = normalizeMlbFinalResult(mlbFeed, mlbGamePk);
assert.deepEqual({
  league: mlbResult.league,
  gamePk: mlbResult.gamePk,
  gameNumber: mlbResult.gameNumber,
  officialDate: mlbResult.officialDate,
  awayTeamId: mlbResult.awayTeamId,
  homeTeamId: mlbResult.homeTeamId,
  away: mlbResult.away,
  home: mlbResult.home,
  innings: mlbResult.innings,
  scheduledInnings: mlbResult.scheduledInnings,
  first5Complete: mlbResult.first5Complete,
}, {
  league: 'MLB', gamePk: mlbGamePk, gameNumber: 2, officialDate: '2099-08-18',
  awayTeamId: 147, homeTeamId: 141, away: 'New York Yankees', home: 'Toronto Blue Jays',
  innings: 9, scheduledInnings: 9, first5Complete: true,
});
assert.equal(mlbResult.awayFirst5, 3);
assert.equal(mlbResult.homeFirst5, 1);
assert.equal(mlbResult.provider, 'MLB_STATS_API_LIVE_FEED');
assert.match(mlbResult.sourceRecord, new RegExp(String(mlbGamePk)));
assert.equal(validateLeagueFinalResult('MLB', mlbGamePk, mlbResult, {
  date: '2099-08-18',
  game: { gamePk: mlbGamePk, gameNumber: 2, officialDate: '2099-08-18', awayTeamId: 147, homeTeamId: 141 },
}).final, true);

const missingMlbFirst5Feed = structuredClone(mlbFeed);
delete missingMlbFirst5Feed.liveData.linescore.innings[2].home.runs;
const missingMlbFirst5 = normalizeMlbFinalResult(missingMlbFirst5Feed, mlbGamePk);
assert.equal(missingMlbFirst5.final, true, '缺 F5 不得破壞可信全場終場');
assert.equal(missingMlbFirst5.first5Complete, false, '任一前五局半局缺失必須 fail closed');
assert.equal(missingMlbFirst5.awayFirst5, null);
assert.equal(missingMlbFirst5.homeFirst5, null);
assert.equal(validateLeagueFinalResult('MLB', mlbGamePk, missingMlbFirst5).first5Complete, false);

assert.throws(
  () => normalizeMlbFinalResult(mlbFeed, mlbGamePk + 1),
  error => error?.code === 'OFFICIAL_IDENTITY_MISMATCH',
  'MLB feed 回傳錯場不得被請求 gamePk 接受',
);
const shortMlbFinal = structuredClone(mlbFeed);
shortMlbFinal.liveData.linescore.innings = shortMlbFinal.liveData.linescore.innings.slice(0, 5);
assert.throws(
  () => normalizeMlbFinalResult(shortMlbFinal, mlbGamePk),
  error => error?.code === 'OFFICIAL_FINAL_RESULT_INVALID',
  'MLB 異常短局完賽不得自動結算',
);
const tiedMlbFinal = structuredClone(mlbFeed);
tiedMlbFinal.liveData.linescore.teams.home.runs = 4;
assert.throws(
  () => normalizeMlbFinalResult(tiedMlbFinal, mlbGamePk),
  error => error?.code === 'OFFICIAL_FINAL_RESULT_INVALID',
  'MLB Final 和局不符合聯盟規則',
);
const invalidMlbDate = structuredClone(mlbFeed);
invalidMlbDate.gameData.datetime.officialDate = '2099-02-30';
assert.throws(
  () => normalizeMlbFinalResult(invalidMlbDate, mlbGamePk),
  error => error?.code === 'OFFICIAL_FINAL_RESULT_INVALID',
  'MLB 不得接受只符合字串格式但不存在的日期',
);
const duplicateMlbTeam = structuredClone(mlbFeed);
duplicateMlbTeam.gameData.teams.home.id = duplicateMlbTeam.gameData.teams.away.id;
assert.throws(
  () => normalizeMlbFinalResult(duplicateMlbTeam, mlbGamePk),
  error => error?.code === 'OFFICIAL_FINAL_RESULT_INVALID',
  'MLB 主客隊 ID 相同時不得結算',
);

const npbFinalGame = {
  ...npb[0], status: '比賽結束', statusEnglish: 'Final', statusCode: 'F',
  awayScore: 4, homeScore: 4, innings: 12,
};
const npbResult = normalizeAsianFinalResult('NPB', npbFinalGame.gamePk, '2099-08-18', npbFinalGame);
const kboFinalGame = {
  ...officialKbo[1], status: '比賽結束', statusEnglish: '경기종료', statusCode: 'F',
  awayScore: 6, homeScore: 5, innings: 10,
};
const kboResult = normalizeAsianFinalResult('KBO', kboFinalGame.gamePk, '2099-08-18', kboFinalGame);
const cpblFinalGame = cpbl.find(game => game.statusCode === 'F');
const cpblResult = normalizeAsianFinalResult('CPBL', cpblFinalGame.gamePk, '2099-08-18', cpblFinalGame);

for (const result of [npbResult, kboResult, cpblResult]) {
  assert.ok(['NPB', 'KBO', 'CPBL'].includes(result.league));
  assert.equal(Number.isSafeInteger(result.gamePk), true);
  assert.equal(Number.isSafeInteger(result.gameNumber), true);
  assert.equal(result.officialDate, '2099-08-18');
  assert.ok(result.awayTeamId > 0 && result.homeTeamId > 0);
  assert.ok(result.away && result.home);
  assert.ok(result.provider && result.sourceRecord);
  assert.match(result.sourceRecord, new RegExp(result.providerGameId));
  assert.ok(result.innings >= 9 && result.innings <= 12);
  assert.equal(result.first5Complete, false, `${result.league} 尚無官方 F5 feed 時必須 fail closed`);
  assert.equal(result.awayFirst5, null);
  assert.equal(result.homeFirst5, null);
  assert.equal(validateLeagueFinalResult(result.league, result.gamePk, result, {
    date: result.officialDate,
    game: {
      gamePk: result.gamePk, gameNumber: result.gameNumber, officialDate: result.officialDate,
      awayTeamId: result.awayTeamId, homeTeamId: result.homeTeamId,
    },
  }).final, true);
}
assert.equal(npbResult.awayRuns, npbResult.homeRuns, 'NPB 只允許已發布規則上限局數的和局');
assert.equal(npbResult.innings, asianLeagueConfig('NPB').rules.extraInningsLimit);
assert.equal(kboResult.gameNumber, 2, 'KBO 雙重賽 gameNumber 必須保留至正式賽果');

assert.throws(
  () => normalizeAsianFinalResult('NPB', npbFinalGame.gamePk, '2099-08-18', { ...npbFinalGame, innings: null }),
  error => error?.code === 'OFFICIAL_FINAL_RESULT_INVALID',
  'NPB 完賽缺局數不得只憑總比分自動結算',
);
assert.throws(
  () => normalizeAsianFinalResult('KBO', kboFinalGame.gamePk, '2099-08-18', { ...kboFinalGame, awayScore: 3, homeScore: 3, innings: 11 }),
  error => error?.code === 'OFFICIAL_FINAL_RESULT_INVALID',
  'KBO 和局未達已發布上限局數必須 fail closed',
);
assert.throws(
  () => normalizeAsianFinalResult('CPBL', cpblFinalGame.gamePk, '2099-08-18', { ...cpblFinalGame, innings: 13 }),
  error => error?.code === 'OFFICIAL_FINAL_RESULT_INVALID',
  'CPBL 超出已發布延長局上限必須 fail closed',
);
assert.throws(
  () => normalizeAsianFinalResult('NPB', npbFinalGame.gamePk + 1, '2099-08-18', npbFinalGame),
  error => error?.code === 'OFFICIAL_IDENTITY_MISMATCH',
);
assert.throws(
  () => normalizeAsianFinalResult('NPB', npbFinalGame.gamePk, '2099-08-18', { ...npbFinalGame, league: 'KBO', leagueId: 'KBO' }),
  error => error?.code === 'OFFICIAL_IDENTITY_MISMATCH',
);
assert.throws(
  () => validateLeagueFinalResult('KBO', kboResult.gamePk, kboResult, {
    date: kboResult.officialDate,
    game: { ...kboFinalGame, awayTeamId: kboResult.awayTeamId + 1 },
  }),
  error => error?.code === 'OFFICIAL_IDENTITY_MISMATCH',
  '保存快照與賽果隊伍不一致不得結算',
);
assert.throws(
  () => validateLeagueFinalResult('NPB', mlbResult.gamePk, mlbResult),
  error => error?.code === 'OFFICIAL_IDENTITY_MISMATCH',
  '亞洲聯盟正式賽果不得回退或接受 MLB provider',
);
assert.equal(new Set(['NPB', 'KBO', 'CPBL'].map(league => asianLeagueConfig(league).rulesVersion)).size, 3);
assert.equal(['NPB', 'KBO', 'CPBL'].every(league => asianLeagueConfig(league).mlbFallbackAllowed === false), true);

console.log('Four-league official final-result identity, F5 fail-closed, abnormal-finish and independent-rule provider tests PASS');
