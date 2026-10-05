import { defaultTraining } from './analysis-training.js';
import { preseasonTraining } from './preseason-training.js';
import { PRESEASON_VERSION, PRESEASON_KEYS, priorSeasonBaseline, fitPreseason, preseasonMarket, validatePreseasonRows } from './preseason-core.js';
import { validDate } from './identity.js';
export function analyzeNbaPreseason(game, quotes, { trainingData = preseasonTraining, regularHistory = defaultTraining.history } = {}) {
  const fail = (status, code, message) => ({ status, modelVersion: PRESEASON_VERSION, prediction: null, assessment: null, probabilityEstimate: null, executable: false, promotionEligible: false, issues: [{ code, message }] });
  if (game?.league !== 'NBA' || game.seasonType !== 'preseason' || !Number.isInteger(game.season?.year) || !validDate(game.taipeiDate)
    || !/^nba:espn:game:[1-9]\d+$/.test(game.id || '') || game.home?.id === game.away?.id) return fail('blocked', 'NBA_PRESEASON_GAME_INVALID', '季前賽身分或日期無效');
  if (trainingData?.kind !== 'NBA_PRESEASON_FIXED_TRAINING' || trainingData.modelVersion !== PRESEASON_VERSION
    || !Array.isArray(trainingData.features) || !Array.isArray(trainingData.observations) || !Array.isArray(trainingData.history) || !Array.isArray(regularHistory)) return fail('blocked', 'NBA_PRESEASON_TRAINING_INVALID', '季前賽訓練檔缺失或版本不符');
  const eligible = row => validDate(row.date) && row.date < game.taipeiDate && row.year <= game.season.year && row.year >= game.season.year - 3;
  const chronological = (a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId);
  const features = trainingData.features.filter(eligible).sort(chronological), observations = trainingData.observations.filter(eligible).sort(chronological);
  if (observations.length < 50 || features.length < 30) return fail('insufficient', 'NBA_PRESEASON_CALIBRATION_INSUFFICIENT', `較早季前賽校正誤差 ${observations.length} 筆，至少需要 50 筆`);
  if (new Set(observations.map(row => row.gameId)).size !== observations.length || new Set(features.map(row => row.gameId)).size !== features.length || features.some(row => !['fullTotal', 'fullMargin', 'halfTotal', 'halfMargin'].every(key => Number.isFinite(row.baseline?.[key]) && Number.isFinite(row.actual?.[key]))) || observations.some(row => !validDate(row.trainedThrough) || !(row.trainedThrough < row.date) || !['fullTotal', 'fullMargin', 'halfTotal', 'halfMargin'].every(key => Number.isFinite(row.errors?.[key])))) return fail('blocked', 'NBA_PRESEASON_RESIDUAL_INVALID', '歷史誤差的時間順序或數值未通過核對');
  // Only completed prior regular-season results become team-strength inputs.
  const historyMap = new Map();
  for (const row of [...trainingData.history, ...regularHistory].filter(row => row.seasonType === 'regular')) {
    const existing = historyMap.get(row.gameId);
    if (existing && ['date', 'year', 'homeId', 'awayId', 'homeScore', 'awayScore'].some(key => existing[key] !== row[key])) return fail('blocked', 'NBA_PRESEASON_HISTORY_CONFLICT', '歷史場次資料不一致');
    historyMap.set(row.gameId, row);
  }
  const history = [...historyMap.values()];
  if (!validatePreseasonRows(history)) return fail('blocked', 'NBA_PRESEASON_HISTORY_INVALID', '歷史場次或比分核對未通過');
  const baseline = priorSeasonBaseline(game, history);
  if (!baseline) return fail('insufficient', 'NBA_PRESEASON_TEAM_HISTORY_INSUFFICIENT', '兩隊上一季有效例行賽資料各需至少 20 場');
  const fit = fitPreseason(features, baseline);
  const values = Object.fromEntries(Object.entries(fit).map(([key, value]) => [key, value.value]));
  if (!Object.values(values).every(Number.isFinite) || values.fullTotal <= Math.abs(values.fullMargin) || values.halfTotal <= Math.abs(values.halfMargin)) return fail('blocked', 'NBA_PRESEASON_PREDICTION_INVALID', '季前賽預測數學核對未通過');
  const markets = Object.fromEntries(PRESEASON_KEYS.map(key => [key, preseasonMarket(key, quotes?.[key], values, observations, game.taipeiDate)]));
  if (!Object.values(markets).some(market => market.status === 'ready')) return fail('blocked', 'NBA_PRESEASON_NO_SUPPORTED_QUOTE', '目前沒有可核對的季前賽盤口');
  const full = markets.fullTotal;
  return { status: 'ready', modelVersion: PRESEASON_VERSION, executable: false, probabilityEstimate: null, promotionEligible: false,
    prediction: { home: (values.fullTotal + values.fullMargin) / 2, away: (values.fullTotal - values.fullMargin) / 2, baseTotal: baseline.fullTotal, total: values.fullTotal, correction: values.fullTotal - baseline.fullTotal },
    assessment: { positiveExpectedNet: full.sides?.over?.expectedNet ?? null, negativeExpectedNet: full.sides?.under?.expectedNet ?? null },
    preseasonAnalysis: { ...values, baseline, fit, trainingSamples: features.length, distributionSamples: observations.length, through: features.at(-1).date,
      sourceSeasonYears: [...new Set(features.map(row => row.year))], validation: trainingData.validation, estimateBasis: 'prior_regular_team_strength_ridge_fit_to_earlier_preseason_only',
      limitations: ['模型估計勝率與淨額，並非已驗證的實際下注勝率或獲利', '尚未納入本季傷停、先發確認、輪換與上場時間', '歷史比分於賽後取得；未具備當時盤口及完整賽前快照'] },
    marketAnalyses: markets, quotes: Object.fromEntries(PRESEASON_KEYS.map(key => [key, quotes?.[key] || null])),
    training: { seasonYear: game.season.year, seasonType: 'preseason', availableGames: observations.length, minimumResiduals: 50, through: features.at(-1).date },
    issues: [{ code: 'NBA_PRESEASON_ESTIMATE_NOT_BETTING_VALIDATED', message: '使用較早季前賽校正並保留逐場時間切分；顯示模型估計，不具有正式下注執行資格。' }] };
}
