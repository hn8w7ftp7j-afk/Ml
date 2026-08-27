export const ASIAN_LEAGUE_READINESS_VERSION = 'ASIAN-LEAGUE-RUNTIME-PIT-READINESS-2026-08-v2.0.0';

const ASIAN_LEAGUES = Object.freeze(['NPB', 'KBO', 'CPBL']);

function blocker(code, feature, stage, message, blocks = ['MODEL_EV_W', 'ROBUST_EV_R']) {
  return Object.freeze({
    code,
    feature,
    stage,
    message,
    blocks: Object.freeze([...blocks]),
  });
}

const DISTRIBUTION_ENGINE_BLOCKER = blocker(
  'INDEPENDENT_JOINT_DISTRIBUTION_ENGINE_NOT_RELEASED',
  'independentJointScoreDistribution',
  'DISTRIBUTION',
  '聯盟專屬上半／全場聯合比分引擎尚未發布；禁止回退 analysis-v10 或 MLB 參數。',
);

const COMMON_PRODUCTION_PIPELINE_BLOCKERS = Object.freeze([
  blocker(
    'PIT_TEAM_STRENGTH_PIPELINE_NOT_CONNECTED',
    'teamStrengthBaseline',
    'UPSTREAM',
    'Production 尚未接上可追溯、開賽前截點的聯盟獨立球隊能力基準。',
  ),
  blocker(
    'PIT_STARTER_PERFORMANCE_PIPELINE_NOT_CONNECTED',
    'starterIdentityAndIndependentPerformance',
    'UPSTREAM',
    'Production 尚未接上與整隊失分代理獨立的先發投手能力快照。',
  ),
  blocker(
    'PIT_LINEUP_PIPELINE_NOT_CONNECTED',
    'credibleLineupScenario',
    'UPSTREAM',
    'Production 尚未接上含球員名單與來源時間的正式或可信預估打線快照。',
  ),
  blocker(
    'PIT_PURE_RELIEF_PIPELINE_NOT_CONNECTED',
    'pureReliefBullpen',
    'UPSTREAM',
    'Production 尚未接上排除先發局數的純後援能力與使用量快照。',
  ),
  blocker(
    'PIT_PARK_FACTOR_PIPELINE_NOT_CONNECTED',
    'recognizedVenueParkFactor',
    'UPSTREAM',
    'Production 尚未接上已識別球場的獨立得分因子；中性 1.00 placeholder 不具模型資格。',
  ),
]);

const FIRST5_SETTLEMENT_BLOCKER = blocker(
  'FIRST5_OFFICIAL_RESULT_FEED_NOT_CONNECTED',
  'officialFirst5Result',
  'SETTLEMENT',
  '目前官方賽果介面只回傳全場比分，尚無前五局比分可自動結算上半市場。',
  ['FIRST5_AUTO_SETTLEMENT'],
);

const FULL_GAME_INNINGS_BLOCKER = Object.freeze({
  NPB: blocker(
    'NPB_FULL_GAME_OFFICIAL_INNINGS_NOT_CONNECTED',
    'officialFullGameInnings',
    'SETTLEMENT',
    'NPB 官方排程目前可讀取終場比分，但缺少可驗證的正式完賽局數；全場自動結算必須 fail closed。',
    ['FULL_GAME_AUTO_SETTLEMENT'],
  ),
  KBO: blocker(
    'KBO_FULL_GAME_OFFICIAL_INNINGS_NOT_CONNECTED',
    'officialFullGameInnings',
    'SETTLEMENT',
    'KBO 官方排程目前可讀取終場比分，但缺少可驗證的正式完賽局數；全場自動結算必須 fail closed。',
    ['FULL_GAME_AUTO_SETTLEMENT'],
  ),
});

const LEAGUE_SPECIFIC_PIPELINE_BLOCKERS = Object.freeze({
  NPB: Object.freeze([]),
  KBO: Object.freeze([
    blocker(
      'KBO_OFFICIAL_STARTER_IDENTITY_PIPELINE_NOT_CONNECTED',
      'officialStarterIdentityAndHandedness',
      'UPSTREAM',
      'KBO Production 賽程介面尚未接上官方先發身分與左右投資料。',
    ),
    blocker(
      'KBO_WEATHER_OR_DOME_PIPELINE_NOT_CONNECTED',
      'kboWeatherOrDomeScenario',
      'UPSTREAM',
      'KBO 戶外天氣情境與已確認巨蛋狀態尚未接入 Production 特徵快照。',
    ),
    blocker(
      'KBO_DOUBLEHEADER_RECOMPUTE_PIPELINE_NOT_CONNECTED',
      'kboDoubleheaderState',
      'UPSTREAM',
      'KBO 雙重賽第二場尚無重新計算牛棚可用性的 Production 管線。',
    ),
  ]),
  CPBL: Object.freeze([
    blocker(
      'CPBL_OFFICIAL_STARTER_IDENTITY_PIPELINE_NOT_CONNECTED',
      'officialStarterIdentityAndHandedness',
      'UPSTREAM',
      'CPBL Production 賽程介面尚未接上可驗證的先發身分與左右投資料。',
    ),
    blocker(
      'CPBL_FOREIGN_PLAYER_RULE_SNAPSHOT_NOT_CONNECTED',
      'cpblForeignPlayerConstraintState',
      'UPSTREAM',
      'CPBL 洋將名額、登錄與投手退場後打線轉換狀態尚未接入 PIT 快照。',
    ),
  ]),
});

const FORMAL_ONLY_BLOCKERS = Object.freeze([
  blocker(
    'LOCKED_OOS_FORWARD_VALIDATION_INCOMPLETE',
    'formalRecommendationValidation',
    'VALIDATION',
    '尚未完成固定版本的 OOS 與 forward 驗證；此項只封鎖正式下注資格，不應封鎖已可計算的 W。',
    ['FORMAL_RECOMMENDATION', 'FORMAL_BET_ELIGIBILITY'],
  ),
]);

const FEATURE_BLOCKER_DEFINITIONS = Object.freeze({
  officialScheduleIdentity: blocker(
    'OFFICIAL_SCHEDULE_IDENTITY_MISSING',
    'officialScheduleIdentity',
    'RUNTIME_INPUT',
    '官方賽事身分、隊伍或開賽時間不完整。',
  ),
  leagueRunEnvironment: blocker(
    'LEAGUE_RUN_ENVIRONMENT_MISSING',
    'leagueRunEnvironment',
    'RUNTIME_INPUT',
    '開賽前可用的聯盟完賽比分環境不足。',
  ),
  pointInTimeFeatureSnapshot: blocker(
    'POINT_IN_TIME_FEATURE_SNAPSHOT_MISSING',
    'pointInTimeFeatureSnapshot',
    'RUNTIME_INPUT',
    '缺少時間不晚於開賽的 PIT 特徵快照。',
  ),
  teamStrengthBaseline: blocker(
    'TEAM_STRENGTH_BASELINE_MISSING_OR_INVALID',
    'teamStrengthBaseline',
    'RUNTIME_INPUT',
    '兩隊可追溯的聯盟獨立球隊能力基準缺失或未通過格式／樣本檢查。',
  ),
  starterIdentityAndIndependentPerformance: blocker(
    'STARTER_IDENTITY_OR_INDEPENDENT_PERFORMANCE_MISSING',
    'starterIdentityAndIndependentPerformance',
    'RUNTIME_INPUT',
    '兩隊先發身分或與整隊失分代理獨立的個人能力資料缺失。',
  ),
  officialStarterHandedness: blocker(
    'OFFICIAL_STARTER_HANDEDNESS_MISSING',
    'officialStarterHandedness',
    'RUNTIME_INPUT',
    '兩隊先發的官方左右投資料不完整。',
  ),
  credibleLineupScenario: blocker(
    'CREDIBLE_LINEUP_SCENARIO_MISSING',
    'credibleLineupScenario',
    'RUNTIME_INPUT',
    '兩隊正式或可信預估打線情境不完整。',
  ),
  pureReliefBullpen: blocker(
    'PURE_RELIEF_BULLPEN_SNAPSHOT_MISSING',
    'pureReliefBullpen',
    'RUNTIME_INPUT',
    '兩隊排除先發局數的純後援能力或使用量資料不完整。',
  ),
  recognizedVenueParkFactor: blocker(
    'RECOGNIZED_VENUE_PARK_FACTOR_MISSING',
    'recognizedVenueParkFactor',
    'RUNTIME_INPUT',
    '已識別球場的獨立得分因子缺失或只提供中性 placeholder。',
  ),
  npbDhAndInterleagueRuleState: blocker(
    'NPB_DH_INTERLEAGUE_RULE_STATE_UNRESOLVED',
    'npbDhAndInterleagueRuleState',
    'RUNTIME_RULE',
    '無法由 NPB 球隊聯盟與主場解析當場 DH 規則。',
  ),
  kboWeatherOrDomeScenario: LEAGUE_SPECIFIC_PIPELINE_BLOCKERS.KBO[1],
  kboDoubleheaderState: LEAGUE_SPECIFIC_PIPELINE_BLOCKERS.KBO[2],
  cpblForeignPlayerConstraintState: LEAGUE_SPECIFIC_PIPELINE_BLOCKERS.CPBL[1],
});

function strictAsianLeague(value) {
  const leagueId = String(value || '').trim().toUpperCase();
  if (!ASIAN_LEAGUES.includes(leagueId)) throw new Error(`不支援的亞洲棒球聯盟：${value}`);
  return leagueId;
}

function cloneBlocker(row) {
  return { ...row, blocks: [...row.blocks] };
}

function readinessFor(leagueId) {
  return Object.freeze({
    version: ASIAN_LEAGUE_READINESS_VERSION,
    leagueId,
    status: 'ENABLED_RUNTIME_PIT_FAIL_CLOSED',
    analysisEnabled: true,
    canBuildDistribution: true,
    canCalculateModelEvW: true,
    canCalculateRobustEvR: true,
    fullGameResultFeedAvailable: leagueId === 'CPBL',
    fullGameScoreAvailable: true,
    fullGameAutoSettlementReady: leagueId === 'CPBL',
    first5ResultFeedAvailable: false,
    mlbFallbackAllowed: false,
    tai888ProbabilityInputAllowed: false,
    availableServices: Object.freeze([
      'OFFICIAL_SCHEDULE',
      'OFFICIAL_PIT_PLAYER_FEATURES',
      'INDEPENDENT_JOINT_SCORE_DISTRIBUTION',
      'TAI888_READER',
      'BET_LEDGER',
      'FULL_GAME_FINAL_SCORE',
    ]),
    displayAnalysisBlockers: Object.freeze([]),
    settlementBlockers: Object.freeze([
      ...(FULL_GAME_INNINGS_BLOCKER[leagueId] ? [FULL_GAME_INNINGS_BLOCKER[leagueId]] : []),
      FIRST5_SETTLEMENT_BLOCKER,
    ]),
    formalRecommendationBlockers: FORMAL_ONLY_BLOCKERS,
  });
}

export const ASIAN_LEAGUE_RELEASE_READINESS = Object.freeze(Object.fromEntries(
  ASIAN_LEAGUES.map(leagueId => [leagueId, readinessFor(leagueId)]),
));

export function asianLeagueReleaseReadiness(value) {
  const source = ASIAN_LEAGUE_RELEASE_READINESS[strictAsianLeague(value)];
  return {
    ...source,
    availableServices: [...source.availableServices],
    displayAnalysisBlockers: source.displayAnalysisBlockers.map(cloneBlocker),
    settlementBlockers: source.settlementBlockers.map(cloneBlocker),
    formalRecommendationBlockers: source.formalRecommendationBlockers.map(cloneBlocker),
  };
}

export function asianFeatureBlockerDetails(value, featureNames = []) {
  const leagueId = strictAsianLeague(value);
  return [...new Set(Array.isArray(featureNames) ? featureNames : [])].map(feature => {
    const definition = FEATURE_BLOCKER_DEFINITIONS[feature] || blocker(
      'REQUIRED_ASIAN_FEATURE_MISSING',
      feature,
      'RUNTIME_INPUT',
      `缺少 ${leagueId} 聯盟必要特徵：${feature}`,
    );
    return { leagueId, ...cloneBlocker(definition) };
  });
}

export function asianDistributionEngineBlocker(value) {
  return {
    leagueId: strictAsianLeague(value),
    code: 'ASIAN_INDEPENDENT_JOINT_DISTRIBUTION_ENGINE_RELEASED',
    feature: 'independentJointScoreDistribution',
    stage: 'DISTRIBUTION',
    message: '聯盟專屬聯合比分引擎已發布；逐場資料仍由runtime PIT gate失敗關閉。',
    blocks: [],
    released: true,
  };
}
