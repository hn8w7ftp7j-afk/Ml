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

export function nbaResultQuoteCurrent(row, now = Date.now()) {
  const result = row?.result;
  const quote = row?.quote?.fullTotal;
  return ['ready', 'reference'].includes(result?.status) && row.canAnalyze === true && result.observedAt === row.observedAt
    && now - Date.parse(row.observedAt) < 180000 && now - Date.parse(row.pageActivityAt || row.observedAt) < 180000
    && Date.parse(row.game.startTime) > now && quote && ['line', 'overWater', 'underWater'].every(key => quote[key] === result.quote?.[key]);
}
