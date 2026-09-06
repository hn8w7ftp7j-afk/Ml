import { NHL_HISTORICAL_SAMPLES, NHL_HISTORICAL_SAMPLE_VERSION } from './historical-samples.js';
import { walkForwardNhlModel, NHL_MODEL_VERSION } from './model.js';
import { normalizeNhlModelGame } from './model-qa.js';

export function nhlHistoricalResearch() {
  const games = NHL_HISTORICAL_SAMPLES;
  for (const game of games) normalizeNhlModelGame(game);
  const retrospective = walkForwardNhlModel(games, { gameType: 2, availabilityMode: 'RETROSPECTIVE_48H_EMBARGO', initialTrainingGames: 3 });
  const strict = walkForwardNhlModel(games, { gameType: 2, availabilityMode: 'STRICT_PIT', initialTrainingGames: 3 });
  return {
    ok: true, league: 'NHL', sampleVersion: NHL_HISTORICAL_SAMPLE_VERSION, modelVersion: NHL_MODEL_VERSION,
    games, completePeriodGames: games.filter(game => game.qa?.canUseHistoricalPeriods === true).length,
    message: `已收錄 ${games.length} 場可追溯的官方歷史樣本。這是工程驗證資料集，未涵蓋完整賽季，不代表模型預測效力或正式校準通過。`,
    validation: {
      historicalPeriodIntegrity: 'PASS', engineeringCorpusOnly: true, fullSeasonCoverage: false,
      retrospective: { status: retrospective.status, folds: retrospective.foldCount, regulationBrier: retrospective.meanRegulationBrier,
        regulationSquaredError: retrospective.meanRegulationSquaredError, embargoHours: 48, pointInTimeVerified: false },
      strictPointInTime: { status: strict.status, folds: strict.foldCount, reason: '未取得當時發布的完整傷病、門將、陣容與結果可得時間快照；不得偽造 PIT 回測。' },
      productionModelCalibrated: false, historicalTai888PayoffVerified: false,
      featuresMissing: ['timestamped injury/lineup/goalie', '5v5 exposure', 'xG/xGF/xGA', 'high-danger xG', 'travel evidence'],
      folds: retrospective.folds.map(fold => ({ gameId: fold.targetGameId, asOf: fold.asOf, trainingGames: fold.trainingGameIds.length,
        trainingGameIds: fold.trainingGameIds, regulationBrier: fold.regulationBrier })),
    },
  };
}
