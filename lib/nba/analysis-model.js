import { defaultTraining } from './analysis-training.js';
import { createScorePredictor } from './analysis-core/score-recent.js';
import { mean } from './analysis-core/score-conservative.js';
import { createPaceCalibrationFeatures } from './analysis-core/pace-features.js';
import { fitTotalCorrection } from './analysis-core/total-calibration.js';
import { parseCreditLine, evaluateWeightedContract } from './analysis-core/credit-total.js';

export const NBA_ANALYSIS_MODEL_VERSION = 'nba-total-pace-rest-v1';
const order = (a,b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId);
const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) === date;
const teamId = id => typeof id === 'string' && /^nba:espn:team:([1-9]|[12]\d|30)$/.test(id);
const prior = (rows,game) => rows.filter(row => row.year === game.year && row.seasonType === game.seasonType && row.date < game.date).sort(order);

// Full-game Taiwan credit totals only. Quarter/split quotes are deliberately not
// approximated: the study's single-base fractional payoff cannot represent them.
export function parseNbaAnalysisTotal(fullTotal) {
  const value = fullTotal?.line;
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  const line = parseCreditLine(text,'total');
  if (!line || !Number.isFinite(line.base) || !Number.isFinite(line.tail) || !Number.isFinite(line.coordinate)) return null;
  const {overWater,underWater} = fullTotal;
  if (![overWater,underWater].every(water => typeof water === 'number' && Number.isFinite(water) && water > 0 && water <= 3)) return null;
  return { line, lineText:text.trim(), waters:{positive:overWater,negative:underWater} };
}

/** Fixed study adapter. No target boxscore/lineup/user-supplied model covariates. */
export function analyzeNbaModel(gameNormalized,fullTotal,{trainingData=defaultTraining,scoreOnly=false}={}) {
  const seasonYear = gameNormalized?.season?.year ?? null, seasonType = gameNormalized?.seasonType ?? null;
  const result = {
    status:'blocked', modelVersion:NBA_ANALYSIS_MODEL_VERSION,
    prediction:null, assessment:null, probabilityEstimate:null,
    executable:false, strictPointInTime:false, promotionEligible:false,
    training:{seasonYear,seasonType,availableGames:0,minimumResiduals:50,teamPriorGames:{home:0,away:0},pairedResiduals:0,eligibleInnovations:0,through:null,sourceBasis:'verified_archived_after_season_not_verified_pregame_capture',sourceHashes:trainingData?.provenance?.hashes ?? null},
    issues:[]
  };
  const fail = (status,code,message) => { result.status=status; result.issues.push({code,message}); return result; };
  if (!gameNormalized || gameNormalized.league !== 'NBA' || !/^nba:espn:game:[1-9]\d{0,14}$/.test(gameNormalized.id ?? '') || !teamId(gameNormalized.home?.id) || !teamId(gameNormalized.away?.id) || gameNormalized.home.id === gameNormalized.away.id || !validDate(gameNormalized.taipeiDate) || !Number.isInteger(seasonYear) || seasonYear < 1947 || seasonYear > 2200 || !['preseason','regular','postseason'].includes(seasonType) || typeof gameNormalized.neutralSite !== 'boolean' || (gameNormalized.season.type != null && gameNormalized.season.type !== seasonType)) {
    return fail('blocked','NBA_MODEL_GAME_INVALID','NBA 賽事身分、日期、主客隊或賽季類型未通過核對。');
  }
  const contract = parseNbaAnalysisTotal(fullTotal);
  if (!contract && !scoreOnly) return fail('blocked','NBA_MODEL_TOTAL_UNSUPPORTED','全場大小分盤口或水位格式不支援；不可將四分盤、分拆盤或缺少對邊水位近似成信用盤。');
  if (!trainingData || trainingData.kind !== 'NBA_PACE_REST_FIXED_TRAINING' || trainingData.modelVersion !== NBA_ANALYSIS_MODEL_VERSION || !Array.isArray(trainingData.history) || !Array.isArray(trainingData.pairedResiduals) || !Array.isArray(trainingData.observations) || !Array.isArray(trainingData.paceHistory?.rows)) {
    return fail('blocked','NBA_MODEL_TRAINING_INVALID','NBA 訓練檔缺失或版本格式不正確。');
  }
  const {scorePlan,scoreStudy,paceStudy} = trainingData;
  if (scorePlan?.model?.minimumPriorGamesEachTeam !== 3 || scorePlan?.model?.priorEquivalentGames !== 10 || scorePlan?.calibration?.minimumEarlierPairedResiduals !== 20 || paceStudy?.minimumResiduals !== 50 || paceStudy?.halfLifeDays !== 30 || paceStudy?.ridgeZeroPrior !== 20 || paceStudy?.paceRecentGames !== 5 || paceStudy?.minimumPaceGamesPerTeam !== 1 || paceStudy?.paceCenter !== 100 || paceStudy?.paceScale !== 10 || paceStudy?.restGapCapDays !== 7 || paceStudy?.restGapCenterDays !== 3 || scoreStudy?.minimumLeagueGamesForRidge !== 60) {
    return fail('blocked','NBA_MODEL_PLAN_MISMATCH','NBA 固定評估規格與訓練檔不一致。');
  }
  const validRecord = row => row && typeof row.gameId === 'string' && validDate(row.date) && Number.isInteger(row.year) && ['preseason','regular','postseason'].includes(row.seasonType);
  if (![trainingData.history,trainingData.pairedResiduals,trainingData.observations,trainingData.paceHistory.rows].every(rows => rows.every(validRecord))) return fail('blocked','NBA_MODEL_TRAINING_ROW_INVALID','NBA 歷史訓練列的日期、賽季或身分格式不正確。');
  const game = {gameId:gameNormalized.id,date:gameNormalized.taipeiDate,year:seasonYear,seasonType,homeId:gameNormalized.home.id,awayId:gameNormalized.away.id,neutralSite:gameNormalized.neutralSite};
  const history = prior(trainingData.history,game), paired = prior(trainingData.pairedResiduals,game), observations = prior(trainingData.observations,game);
  if (history.some(row => ![row.homeScore,row.awayScore].every(value => Number.isInteger(value) && value >= 0) || !teamId(row.homeId) || !teamId(row.awayId) || row.homeId === row.awayId || typeof row.neutralSite !== 'boolean') || paired.some(row => ![row.rawHome,row.rawAway].every(Number.isFinite)) || observations.some(row => ![row.rawError,row.error].every(Number.isFinite) || !Array.isArray(row.features) || row.features.length !== 4 || !row.features.every(Number.isFinite))) return fail('blocked','NBA_MODEL_TRAINING_VALUES_INVALID','NBA 較早比分或校正誤差缺少有效數值。');
  const homePrior = history.filter(row => row.homeId === game.homeId || row.awayId === game.homeId).length;
  const awayPrior = history.filter(row => row.homeId === game.awayId || row.awayId === game.awayId).length;
  Object.assign(result.training,{availableGames:history.length,teamPriorGames:{home:homePrior,away:awayPrior},pairedResiduals:paired.length,eligibleInnovations:observations.length,through:history.at(-1)?.date ?? null});
  if (homePrior < 3 || awayPrior < 3 || observations.length < 50) {
    return fail('insufficient','NBA_MODEL_SAME_SEASON_HISTORY_INSUFFICIENT',`此賽季 ${seasonYear}／${seasonType} 的賽前歷史不足：主隊 ${homePrior}、客隊 ${awayPrior} 場（各需 3），可用校正誤差 ${observations.length} 筆（需 50）。不沿用其他賽季或賽制的結果。`);
  }
  try {
    // A fresh predictor intentionally scopes its date-only score-fit cache to
    // this training call. Different injected histories cannot share a fit.
    const recent = scoreStudy.candidates.find(candidate => candidate.id === 'recent');
    if (!recent || recent.ridgePenalty !== 10 || recent.halfLifeDays !== 30) return fail('blocked','NBA_MODEL_SCORE_SPEC_MISMATCH','NBA 比分底模規格不一致。');
    const raw = createScorePredictor(recent,scoreStudy)(game,history,scorePlan);
    if (raw.status !== 'ready') return fail('insufficient','NBA_MODEL_SCORE_HISTORY_INSUFFICIENT','此賽季的比分底模缺少足夠先前比賽。');
    const home = raw.predictedHome + (paired.length >= 20 ? mean(paired.map(row => row.rawHome)) : 0);
    const away = raw.predictedAway + (paired.length >= 20 ? mean(paired.map(row => row.rawAway)) : 0);
    const baseTotal = home+away;
    const features = createPaceCalibrationFeatures(trainingData.paceHistory)(game,baseTotal,trainingData.history,paceStudy,'pace_rest');
    const fit = fitTotalCorrection(game,baseTotal,features.features,observations,paceStudy), total = baseTotal+fit.correction;
    const valuation = contract ? evaluateWeightedContract(total,observations,contract.line,contract.waters,game.date,30,0.015) : null;
    if (![home,away,baseTotal,total,fit.correction,...(valuation ? [valuation.positive.expectedNet,valuation.negative.expectedNet] : [])].every(Number.isFinite)) return fail('blocked','NBA_MODEL_NONFINITE','NBA 校正結果不是有效數值。');
    result.status='ready';
    result.prediction={home,away,baseTotal,total,correction:fit.correction};
    result.assessment=valuation ? {paceProxy:features.paceProxy,restProxy:features.restProxy,features:features.features,coefficients:fit.coefficients,calibrationSamples:fit.calibrationSamples,calibrationThrough:fit.calibrationThrough,distributionSamples:observations.length,distributionThrough:observations.at(-1).date,distributionEffectiveN:valuation.effectiveN,positiveExpectedNet:valuation.positive.expectedNet,negativeExpectedNet:valuation.negative.expectedNet,direction:valuation.positive.expectedNet >= valuation.negative.expectedNet ? 'over' : 'under',bothNonpositive:valuation.positive.expectedNet <= 0 && valuation.negative.expectedNet <= 0,estimateBasis:'strictly_earlier_same_year_type_prequential_pace_rest_innovations_not_certified_pregame_EV',rebateRate:0.015,unitStake:100,probabilityEstimate:null} : null;
    result.issues.push({code:'NBA_MODEL_ARCHIVED_DEVELOPMENT_ONLY',message:'使用已核對的賽後歷史檔，以嚴格較早日期評估；尚未完成未使用樣本與賽前快照驗證，結果不具正式投注執行資格。'});
    return result;
  } catch (error) {
    if (['PACE_EARLIER_TEAM_GAMES_INSUFFICIENT','REST_GAP_PRIOR_DATE_MISSING'].includes(error.message)) return fail('insufficient','NBA_MODEL_PACE_HISTORY_INSUFFICIENT','此賽季缺少兩隊較早逐場節奏或賽程間隔資料。');
    return fail('blocked','NBA_MODEL_TRAINING_CONTRACT_FAILED','NBA 訓練資料或模型數學規格未通過核對。');
  }
}
