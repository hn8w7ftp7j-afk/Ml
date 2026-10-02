import { MLB_FULL_TOTAL_ARTIFACT_V2 as artifact } from './mlb-full-total-artifact-v2.js';
import { parseTaiwanLine, hasActualWater } from './markets.js';
import { sha256 } from './snapshot-v9.js';

export const MLB_FULL_TOTAL_V2_VERSION = artifact.version;
export const MLB_FULL_TOTAL_V2_ALIGNMENT = 'WATER_CALIBRATION_DISABLED_FULL_TOTAL_LINE_FEATURE_V2';
const clamp = value => Math.max(artifact.scoreMinimum, Math.min(artifact.scoreMaximum, value));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const artifactHash = sha256(artifact);
const day = timestamp => new Date(timestamp).toISOString().slice(0, 10);

export function fullTotalV2AlignmentPassed(analysis) {
  const meta = analysis?.fullTotalForecast;
  if (analysis?.leagueId !== 'MLB' || analysis?.alignmentAudit?.targetMarketCalibration !== MLB_FULL_TOTAL_V2_ALIGNMENT
    || meta?.active !== true || meta?.version !== artifact.version || meta?.artifactHash !== artifactHash
    || meta?.executionWaterUsedAsFeature !== false || meta?.promotionEligible !== false || meta?.independentValidation !== false) return false;
  const rows = analysis.results || [];
  const updated = rows.filter(row => row.fullTotalForecastVersion != null);
  return updated.length > 0 && updated.length <= 2
    && updated.every(row => row.market === '全場大小' && row.fullTotalForecastVersion === artifact.version
      && row.fullTotalArtifactHash === artifactHash && row.targetLineUsedAsFeature === true && row.executionWaterUsedAsFeature === false)
    && rows.filter(row => row.market !== '全場大小').every(row => row.fullTotalForecastVersion == null && row.targetLineUsedAsFeature !== true);
}

// The server owns this fitted candidate. No request may supply coefficients,
// residuals, effective dates, or a fabricated validation/promotion result.
export function fullTotalV2Availability(context = {}) {
  const league = String(context.leagueId || context.game?.leagueId || context.game?.league || 'MLB').toUpperCase();
  const start = Date.parse(context.game?.gameDate || '');
  const asOf = Date.parse(context.fetchedAt || '');
  if (league !== 'MLB') return { active: false, reason: 'NOT_MLB' };
  if (!Number.isFinite(start) || !Number.isFinite(asOf)) return { active: false, reason: 'CONTEXT_TIME_MISSING' };
  if (start < Date.parse(artifact.availableFrom) || asOf < Date.parse(artifact.availableFrom)) return { active: false, reason: 'CANDIDATE_NOT_YET_AVAILABLE' };
  if (start <= asOf) return { active: false, reason: 'GAME_NOT_PREGAME' };
  if (new Date(start).getUTCFullYear() !== artifact.season) return { active: false, reason: 'OUTSIDE_FROZEN_SEASON' };
  const through = day(start - artifact.minimumOutcomeLagDays * 86400000);
  if (artifact.trainingThrough > through || artifact.residuals.some(row => row.date > through)) return { active: false, reason: 'TRAINING_OUTCOME_LAG_NOT_MET' };
  return { active: true, reason: 'FROZEN_RESEARCH_CANDIDATE', trainingThrough: artifact.trainingThrough };
}

export function attachFullTotalV2Snapshot(snapshot, context) {
  const availability = fullTotalV2Availability(context);
  if (!availability.active) return snapshot;
  const { distributionId, distributionHash, ...base } = snapshot;
  const compact = { ...base, fullTotalForecast: {
    ...availability, version: artifact.version, artifactHash,
    availableFrom: artifact.availableFrom, trainingGames: artifact.trainingGames,
    trainingThrough: artifact.trainingThrough, residualGames: artifact.residuals.length,
    independentValidation: false, strictHistoricalPointInTime: false, promotionEligible: false,
    scope: 'MLB_FULL_TOTAL_MARGINAL_ONLY', targetLineUsedAsFeature: true,
    executionWaterUsedAsFeature: false, uncertaintyTransfer: artifact.uncertaintyTransfer,
  } };
  const hash = sha256(compact);
  return { ...compact, distributionId: `${context.game.gamePk}:${hash.slice(0, 20)}`, distributionHash: hash };
}

function predict(features) {
  if (features.length !== artifact.model.centers.length || !features.every(Number.isFinite)) throw new Error('MLB_FULL_TOTAL_V2_PREDICTOR_INCOMPLETE');
  return clamp(artifact.model.coefficients[0] + features.reduce((sum, value, index) => sum
    + (value - artifact.model.centers[index]) / artifact.model.scales[index] * artifact.model.coefficients[index + 1], 0));
}

// All real over/under contracts share one anchor and one total distribution.
// Water, tails and direction do not enter the fitted forecast. They enter the
// unchanged production settlement only. Changing water alone cannot change it.
export function fullTotalV2ScenarioDistributions({ context, markets, snapshot, resolveScoreDistribution }) {
  const availability = fullTotalV2Availability(context);
  if (!availability.active) return null;
  if (snapshot.fullTotalForecast?.artifactHash !== artifactHash
    || snapshot.fullTotalForecast?.version !== artifact.version) {
    const error = new Error('全場大小分模型版本已更新，請重新分析；不得把舊快照當作新模型');
    error.code = 'MLB_FULL_TOTAL_V2_SNAPSHOT_REBUILD_REQUIRED'; error.status = 409; throw error;
  }
  const rows = (markets || []).filter(row => row.market === '全場大小');
  if (!rows.length) return null;
  if (rows.length > 2) throw new Error('MLB_FULL_TOTAL_V2_DUPLICATE_DIRECTION');
  const parsed = rows.map(row => parseTaiwanLine(row.pick));
  if (parsed.some(row => !row.valid || !row.isTotal)
    || rows.some(row => !hasActualWater(row.water) || row.waterEstimated === true)) return { blocked: 'MLB_FULL_TOTAL_V2_REQUIRES_REAL_VALID_CONTRACTS' };
  const lines = parsed.map(row => mean(row.legs));
  if (lines.some(value => !Number.isFinite(value) || value <= 0)) return { blocked: 'MLB_FULL_TOTAL_V2_INVALID_ANCHOR' };
  const referenceLine = mean(lines);
  const c = snapshot.profile?.components || {};
  const factors = [mean([c.awayOffense, c.homeOffense]), mean([c.awayStarter, c.homeStarter]),
    mean([c.awayBullpen, c.homeBullpen]), mean([c.awayStarterExpectedInnings, c.homeStarterExpectedInnings]), c.park * c.weather];
  if (!factors.every(Number.isFinite) || artifact.residuals.length < artifact.minimumResidualGames) return { blocked: 'MLB_FULL_TOTAL_V2_PREDICTOR_INCOMPLETE' };
  const distributions = new Map();
  let expectedTotal = 0;
  for (const scenario of snapshot.scenarios) {
    const original = resolveScoreDistribution(scenario, false);
    const baseMean = original.cells.reduce((sum, cell) => sum + cell.probability * (cell.awayRuns + cell.homeRuns), 0);
    if (!Number.isFinite(baseMean)) return { blocked: 'MLB_FULL_TOTAL_V2_BASE_MEAN_INVALID' };
    const forecast = predict([referenceLine, baseMean - referenceLine, ...factors]);
    const counts = new Map();
    for (const residual of artifact.residuals) {
      const totalRuns = clamp(Math.round(forecast + residual.error));
      counts.set(totalRuns, (counts.get(totalRuns) || 0) + 1);
    }
    const cells = [...counts].sort(([a], [b]) => a - b).map(([totalRuns, count]) => ({ totalRuns, probability: count / artifact.residuals.length }));
    const coverage = cells.reduce((sum, cell) => sum + cell.probability, 0);
    if (Math.abs(coverage - 1) > 1e-9 || cells.some(cell => !Number.isSafeInteger(cell.totalRuns) || !Number.isFinite(cell.probability))) throw new Error('MLB_FULL_TOTAL_V2_INVALID_PROBABILITY_MASS');
    distributions.set(scenario.id, { cells, coverage, marginalOnly: true });
    expectedTotal += scenario.weight * cells.reduce((sum, cell) => sum + cell.probability * cell.totalRuns, 0);
  }
  return { distributions, metadata: { ...snapshot.fullTotalForecast,
    referenceLine, expectedTotal, anchorMethod: 'EQUAL_DIRECTION_MEAN_OF_REAL_CONTRACT_LEG_LINES',
    sharedAcrossFullTotalDirections: true, sharedWithRunlineOrFirst5: false,
    rankingMethod: 'EXISTING_W_R_AND_S_FORMULA_AND_QA_GATES',
    outcomeProbabilityScope: 'SETTLEMENT_EQUIVALENT_CONDITIONAL_NOT_EXPLORATORY_WIN_RATE',
    note: '全場大小分用凍結攻守回歸與歷史預測誤差；W/R沿用27情境與保守扣減。水位使用實際盤口，不假設小分報價。尚未完成獨立驗證；其他市場仍用原比分分布。',
  } };
}
