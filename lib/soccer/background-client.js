// Soccer research results remain separate from baseball/NBA score caches.
export const SOCCER_ALL_LEAGUE_STORAGE = 'sports-positive-ev-all-league-analysis-v1';
const runPattern = /^[a-zA-Z0-9_:-]{8,300}$/;
const validRunId = value => typeof value === 'string' && runPattern.test(value);
const datePattern = /^20\d{2}-\d{2}-\d{2}$/;
const leagueId = value => ['epl', 'ucl'].includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : null;
const validDate = value => typeof value === 'string' && datePattern.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export function soccerClientGameValid(game) {
  return Boolean(leagueId(game?.league) && game.league === game.league.toLowerCase() && validDate(game.date)
    && typeof game.sourceId === 'string' && /^\d{1,16}$/.test(game.sourceId) && game.id === `soccer:${game.league}:${game.sourceId}`);
}
export function validateSoccerAnalysisPayload(value, game) {
  if (!soccerClientGameValid(game) || value?.gameId !== game.id || value.league !== game.league || value.date !== game.date
    || value.executable !== false || value.formalScoringEnabled !== false || !Array.isArray(value.directions) || value.directions.length !== 8
    || value.directions.some(direction => direction?.executable !== false || direction.eligible !== false)
    || value.analysisStatus != null && !['COMPLETED', 'INSUFFICIENT_DATA'].includes(value.analysisStatus)
    || value.selectionResult != null && (value.analysisStatus !== 'COMPLETED' || value.selectionResult !== 'RESEARCH_SHADOW')) throw new Error('分析身分核對未通過');
  const evidenceGame = value.evidence?.game;
  if (evidenceGame && (evidenceGame.id !== game.id || evidenceGame.league !== game.league || evidenceGame.date !== game.date
    || evidenceGame.sourceId !== game.sourceId)) throw new Error('分析資料與賽事身分不符');
  return value;
}
export function soccerSavedAnalysisState(body, game, now = Date.now()) {
  if (body?.ok !== true || body.gameId !== game.id || body.league !== game.league || body.date !== game.date
    || !Array.isArray(body.versions) || !Array.isArray(body.runs || [])) throw new Error('已保存分析身分核對未通過');
  for (const version of body.versions) validateSoccerAnalysisPayload(version, game);
  let history = body.versions[0] ? { ...body.versions[0], persisted: true, publishedCurrent: false } : null;
  const current = body.currentVersion;
  if (current != null) {
    validateSoccerAnalysisPayload(current, game);
    const until = Date.parse(current.qualificationValidUntil || current.validUntil || '');
    const observed = Date.parse(current.observedAt || '');
    if (current.persisted !== true || current.publishedCurrent !== true || current.analysisStatus !== 'COMPLETED'
      || current.selectionResult !== 'RESEARCH_SHADOW' || !['PASS', 'WARN'].includes(current.qaFlag)
      || !validRunId(current.analysisRunId)
      || body.currentRun?.analysisRunId !== current.analysisRunId || body.currentRun?.analysisStatus !== 'COMPLETED') throw new Error('目前分析授權核對未通過');
    if (Number.isFinite(until) && until > now && Number.isFinite(observed) && observed <= now + 5000 && now - observed <= 180000) {
      return { status: 'done', data: { ...current }, error: '', recoveryError: '' };
    }
    history ||= { ...current, publishedCurrent: false };
  }
  const latest = body.runs?.[0];
  if (latest && !['PROCESSING', 'COMPLETED', 'FAILED', 'INSUFFICIENT_DATA'].includes(latest.analysisStatus)) throw new Error('已保存分析狀態無效');
  if (latest?.analysisStatus === 'PROCESSING') {
    const started = Date.parse(latest.startedAt || '');
    if (!Number.isFinite(started) || started > now + 5000 || now - started > 120000) return {
      status: history ? 'done' : 'idle', ...(history ? { data: history } : {}), error: '',
      recoveryError: '先前核對尚無完成回報，可重新核對', analysisRunId: latest.analysisRunId,
    };
    return { status: 'loading', ...(history ? { data: history } : {}), error: '', recoveryError: '', analysisRunId: latest.analysisRunId };
  }
  if (['FAILED', 'INSUFFICIENT_DATA'].includes(latest?.analysisStatus)) return {
    status: 'error', ...(history ? { data: history } : {}), analysisStatus: latest.analysisStatus, qaFlag: latest.qaFlag || 'BLOCKED',
    analysisRunId: latest.analysisRunId, error: latest.analysisStatus === 'INSUFFICIENT_DATA' ? '最近一次分析資料不足' : '最近一次分析未完成，可重新核對', recoveryError: '',
  };
  return history ? { status: 'done', data: history, error: '', recoveryError: '' } : null;
}
export function findSoccerBackgroundJob(games, explicitRunId = '', saved = null, scopeDate = '') {
  if (!games.length || games.some(game => !soccerClientGameValid(game) || game.league !== games[0].league)) return null;
  if(explicitRunId&&!validRunId(explicitRunId))return null;
  const league = games[0].league.toUpperCase(), savedDate = (!explicitRunId||saved?.runId===explicitRunId)?saved?.leagues?.[league]?.boardDate:null;
  const date = validDate(savedDate) && games.some(game => game.date === savedDate) ? savedDate
    : validDate(scopeDate) && games.some(game => game.date === scopeDate) ? scopeDate : games[0].date;
  const runId = validRunId(explicitRunId) ? explicitRunId : saved?.runId;
  if (!validRunId(runId) || !explicitRunId && (!validDate(savedDate) || !games.some(game => game.date === savedDate))) return null;
  return { runId, league, date };
}
export function soccerBackgroundStates(response, job, games) {
  if (response?.ok !== true || response.runId !== job.runId) throw new Error('足球背景工作身分不符');
  const batch = response.status === 'completed' ? response.result : response.progress;
  if (!batch) return {};
  if (batch.league !== job.league || batch.date !== job.date || !Number.isInteger(batch.total) || batch.total < 0 || batch.total > 20
    || !Array.isArray(batch.results) || batch.results.length > batch.total) throw new Error('足球背景結果聯盟或日期不符');
  const byId = new Map(games.map(game => [game.id, game])), states = {}, seen = new Set();
  for (const row of batch.results) {
    const query = row.task?.soccerQuery, taskGame = row.task?.game;
    if (query?.league !== job.league.toLowerCase() || query.date !== job.date || !/^\d{1,16}$/.test(query.eventId || '')
      || taskGame?.id !== `soccer:${query.league}:${query.eventId}` || taskGame.league !== job.league
      || taskGame.gamePk !== Number(query.eventId) || seen.has(taskGame.id)) throw new Error('足球背景場次身分不符');
    seen.add(taskGame.id);
    const game = byId.get(taskGame.id);
    if (!game || game.date !== job.date) continue;
    if (row.ok !== true) {
      states[game.id] = { status: 'error', analysisStatus: row.payload?.analysisStatus === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT_DATA' : 'FAILED', qaFlag: 'BLOCKED',
        analysisRunId: row.payload?.analysisRunId || null, error: row.error || row.payload?.error || '背景分析未完成，可重新核對' };
    } else if (row.payload) {
      validateSoccerAnalysisPayload(row.payload, game);
      // A completed workflow is durable history. Only a fresh server head read
      // can establish its current request/quote generation and qualification.
      states[game.id] = { status: 'done', data: { ...row.payload, publishedCurrent: false }, error: '', recoveryError: '' };
    } else throw new Error('足球背景結果缺少已核對的分析');
  }
  if (response.status !== 'completed' && Array.isArray(batch.gamePks)) {
    const running = new Set(batch.runningGamePks || []);
    for (const game of games.filter(game => game.date === job.date && batch.gamePks.includes(Number(game.sourceId)))) {
      if (!states[game.id]) states[game.id] = { status: running.has(Number(game.sourceId)) ? 'loading' : 'queued', error: '' };
    }
  }
  return states;
}
