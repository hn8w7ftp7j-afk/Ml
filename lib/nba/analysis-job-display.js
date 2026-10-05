import { validDate } from './identity.js';

export const NBA_JOB_STORAGE = 'sports-nba-analysis-job-v1';
export function validNbaJob(job) {
  return job && validDate(job.date) && (typeof job.runId === 'string' && /^[a-zA-Z0-9_:-]{8,300}$/.test(job.runId)
    || typeof job.requestId === 'string' && /^[a-zA-Z0-9-]{16,100}$/.test(job.requestId));
}

// NBA results never pass through baseball materialization, scoring or caches.
export function mergeNbaAnalysisResults(batch, previous = [], date) {
  if (batch?.league !== 'NBA' || batch.date !== date || !Array.isArray(batch.results)) throw new Error('NBA 結果聯盟或日期不符');
  const rows = new Map(previous.map(row => [row.game.id, row]));
  const seen = new Set();
  for (const entry of batch.results) {
    const query = entry.task?.nbaQuery;
    const game = entry.task?.game;
    const pk = Number(game?.gamePk);
    const id = `nba:espn:game:${query?.id}`;
    if (!query || query.date !== date || game?.id !== id || game?.league !== 'NBA' || !Number.isSafeInteger(pk)
      || pk !== Number(query.id) || seen.has(id)) throw new Error('NBA 結果場次身分無效');
    seen.add(id);
    const result = entry.payload || null;
    if (result && (result.league !== 'NBA' || result.gameId !== id || result.date !== date
      || result.observedAt !== query.observedAt || result.executable !== false
      || !['ready', 'reference', 'insufficient', 'blocked'].includes(result.status))) throw new Error('NBA 分析與盤口時間不符');
    if (entry.ok && result?.status === 'reference') {
      const ref = result.referencePrediction;
      if (result.modelVersion !== 'nba-total-pace-rest-v1' || result.prediction !== null || result.assessment !== null
        || result.probabilityEstimate !== null || ref?.modelVersion !== 'nba-prior-regular-reference-v1'
        || ref.calibrated !== false || ref.probabilityEstimate !== null || ref.expectedNet !== null || ref.direction !== null
        || game.seasonType !== 'preseason' || ref.sourceSeasonYear !== game.season?.year - 1 || ref.sourceSeasonType !== 'regular' || !validDate(ref.through) || ref.through >= date
        || ![ref.home?.games, ref.away?.games].every(n => Number.isInteger(n) && n >= 20)
        || Math.abs(ref.total - ref.homePoints - ref.awayPoints) > 1e-8
        || !['homePoints', 'awayPoints', 'total'].every(key => Number.isFinite(ref[key]))) throw new Error('NBA 跨季基準結果無效');
    } else if (entry.ok && result?.modelVersion === 'nba-preseason-history-ridge-v1') {
      if (result.status !== 'ready' || game.seasonType !== 'preseason' || !validPreseasonResult(result, date)) throw new Error('NBA 季前賽盤口分析無效');
    } else if (entry.ok && (result?.status !== 'ready' || result.modelVersion !== 'nba-total-pace-rest-v1'
      || !['home', 'away', 'baseTotal', 'total', 'correction'].every(key => Number.isFinite(result.prediction?.[key]))
      || !result.assessment || !Number.isFinite(result.assessment.positiveExpectedNet)
      || !Number.isFinite(result.assessment.negativeExpectedNet))) throw new Error('NBA 已完成結果缺少有效分析');
    const previousRow = rows.get(id);
    rows.set(id, { ...(previousRow || { game, quote: null, canAnalyze: false, observedAt: null, reason: '請重新讀取盤口' }),
      result, jobState: result?.status || 'failed', jobError: entry.error || '',
      resultRunId: batch.runId || null });
  }
  return [...rows.values()].sort((a, b) => Date.parse(a.game.startTime) - Date.parse(b.game.startTime));
}

const marketKeys = ['fullTotal', 'fullRunline', 'firstHalfTotal', 'firstHalfRunline'];
export function validPreseasonResult(result, date) {
  const model = result.preseasonAnalysis;
  if (!model || !['fullTotal', 'fullMargin', 'halfTotal', 'halfMargin'].every(key => Number.isFinite(model[key]))
    || !validDate(model.through) || model.through >= date || model.trainingSamples < 30 || model.distributionSamples < 50) return false;
  let ready = 0;
  for (const key of marketKeys) {
    const market = result.marketAnalyses?.[key];
    if (!market || !['ready', 'blocked', 'unavailable'].includes(market.status)) return false;
    if (market.status !== 'ready') continue;
    ready++;
    if (market.samples < 50 || !Number.isFinite(market.effectiveN) || market.effectiveN <= 0 || !validDate(market.through) || market.through >= date
      || market.validatedBettingWinRate !== null || JSON.stringify(market.quote) !== JSON.stringify(result.quotes?.[key])) return false;
    for (const side of key.endsWith('Total') ? ['over', 'under'] : ['home', 'away']) {
      const value = market.sides?.[side];
      if (!value || !Number.isFinite(value.expectedNet) || !['winProbability', 'lossProbability', 'pushProbability'].every(name => Number.isFinite(value[name]) && value[name] >= 0 && value[name] <= 1)
        || Math.abs(value.winProbability + value.lossProbability + value.pushProbability - 1) > 1e-8) return false;
    }
  }
  return ready > 0;
}
const sameQuote = (left, right, total) => !left && !right || !!left && !!right && (total ? ['line', 'overWater', 'underWater'] : ['line', 'lineSide', 'homeWater', 'awayWater']).every(key => left[key] === right[key]);
export function nbaResultQuoteCurrent(row, now = Date.now()) {
  const result = row?.result;
  const fresh = row?.canAnalyze === true && now - Date.parse(row.observedAt) >= 0 && now - Date.parse(row.observedAt) < 180000
    && now - Date.parse(row.pageActivityAt || row.observedAt) < 180000 && Date.parse(row.game.startTime) > now;
  if (!fresh || !['ready', 'reference'].includes(result?.status)) return false;
  if (result.modelVersion === 'nba-preseason-history-ridge-v1') return marketKeys.every(key => sameQuote(row.quote?.[key], result.quotes?.[key], key.endsWith('Total')));
  return result.observedAt === row.observedAt && sameQuote(row.quote?.fullTotal, result.quote, true);
}
