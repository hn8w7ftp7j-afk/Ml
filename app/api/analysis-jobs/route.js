import { getAnalysisJobProgress } from '../../../lib/analysis-job-progress-store.js';
import { NextResponse } from 'next/server';
import { getRun, start } from 'workflow/api';
import { analyzeAllLeaguesWorkflow, analyzeBoardWorkflow } from '../../../workflows/analyze-board.js';
import {
  checkRateLimit,
  cleanText,
  originErrorResponse,
  rateLimitResponse,
  readJsonBody,
  requireApiAuth,
  validateSameOrigin,
} from '../../../lib/security.js';
import { isLeagueId } from '../../../lib/leagues.js';
import { ANALYSIS_LEAGUE_IDS, isAnalysisLeagueId } from '../../../lib/analysis-leagues.js';
import { normalizeNbaAnalysisTasks } from '../../../lib/nba/analysis-job.js';
import { readCookie } from '../../../lib/security.js';
import { deviceHash, getNotificationResult, PUSH_COOKIE } from '../../../lib/analysis-push.js';
import {
  claimAnalysisJobRequest,
  completeAnalysisJobRequest,
  failAnalysisJobRequest,
  getAnalysisJobRequest,
  validAnalysisJobRequestKey,
} from '../../../lib/analysis-job-request-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RUN_ID = /^[a-zA-Z0-9_:-]{8,300}$/;
const REQUEST_ID = /^[a-zA-Z0-9-]{16,100}$/;
const EMPTY_REASONS = new Set(['no_games', 'no_open_markets']);

function normalizeTasks(tasks, league, prefix = '') {
  if (league === 'NBA') return normalizeNbaAnalysisTasks(tasks, tasks[0]?.nbaQuery?.date);
  return tasks.map((task, index) => {
    const requestId = REQUEST_ID.test(String(task?.requestId || ''))
      ? String(task.requestId)
      : `background-${prefix}${Date.now()}-${index}-${crypto.randomUUID()}`;
    return {
      requestId,
      game: task?.game || null,
      actualMarkets: Array.isArray(task?.actualMarkets) ? task.actualMarkets : [],
      actualSource: task?.actualSource || null,
      marketCoverage: task?.marketCoverage || null,
      readerProvenance: task?.readerProvenance || null,
      readerPayloadHash: cleanText(task?.readerPayloadHash, 64) || null,
      verificationMarkets: Array.isArray(task?.verificationMarkets) ? task.verificationMarkets : [],
      referenceEvidence: task?.referenceEvidence || null,
      body: {
        league,
        game: task?.game || null,
        markets: Array.isArray(task?.actualMarkets) ? task.actualMarkets : [],
        readerProvenance: task?.readerProvenance || null,
        verificationMarkets: Array.isArray(task?.verificationMarkets) ? task.verificationMarkets : [],
        referenceEvidence: task?.referenceEvidence || null,
        settings: { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
      },
    };
  });
}

export async function POST(request) {
  let requestKey = '';
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'analysis-job-start-v1', limit: 12, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    requestKey = cleanText(request.headers.get('idempotency-key'), 100);
    let requestClaim = null;
    if (validAnalysisJobRequestKey(requestKey)) {
      try { requestClaim = await claimAnalysisJobRequest(requestKey); }
      catch { requestClaim = null; }
    }
    if (requestClaim && !requestClaim.claimed) {
      if (requestClaim.runId) {
        return NextResponse.json({ ok: true, runId: requestClaim.runId, requestId: requestKey, recovered: true }, { status: 202 });
      }
      if (requestClaim.status === 'failed') {
        return NextResponse.json({ ok: false, code: 'BACKGROUND_JOB_START_FAILED', error: requestClaim.error || '背景工作啟動失敗' }, { status: 503 });
      }
      return NextResponse.json({ ok: true, requestId: requestKey, status: 'starting', recovered: true }, { status: 202 });
    }
    const body = await readJsonBody(request, 6_000_000);
    const date = cleanText(body?.date, 20);
    if (body?.mode === 'all-leagues') {
      const batches = Array.isArray(body?.batches) ? body.batches : [];
      const normalizedBatches = batches.map((batch, batchIndex) => {
        const league = cleanText(batch?.league, 10).toUpperCase();
        const batchDate = cleanText(batch?.date, 20);
        const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
        return {
          league,
          date: batchDate,
          emptyReason: EMPTY_REASONS.has(batch?.emptyReason) ? batch.emptyReason : null,
          tasks: league === 'NBA' ? normalizeNbaAnalysisTasks(tasks, batchDate) : normalizeTasks(tasks, league, `${league}-${batchIndex}-`),
        };
      });
      const leagues = normalizedBatches.map(batch => batch.league);
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(date)
        && normalizedBatches.length > 0
        && normalizedBatches.length <= ANALYSIS_LEAGUE_IDS.length
        && normalizedBatches.every(batch => isAnalysisLeagueId(batch.league)
          && /^\d{4}-\d{2}-\d{2}$/.test(batch.date)
          && batch.tasks.length <= 20)
        && new Set(leagues).size === leagues.length;
      if (!valid) {
        return NextResponse.json({ ok: false, code: 'INVALID_ALL_LEAGUE_BACKGROUND_JOB', error: '全部聯盟背景分析工作內容無效' }, { status: 400 });
      }
      // NBA's short, quote-bound pass runs first; preserve baseball group order.
      normalizedBatches.sort((left, right) => Number(right.league === 'NBA') - Number(left.league === 'NBA'));
      const pushDevice = deviceHash(readCookie(request, PUSH_COOKIE));
      const run = await start(analyzeAllLeaguesWorkflow, [{ date, batches: normalizedBatches, pushDevice, preflightFailures: ANALYSIS_LEAGUE_IDS.length - normalizedBatches.length }]);
      if (requestClaim?.claimed) {
        try { await completeAnalysisJobRequest(requestKey, run.runId); }
        catch {}
      }
      return NextResponse.json({
        ok: true,
        mode: 'all-leagues',
        runId: run.runId,
        date,
        leagues,
        total: normalizedBatches.reduce((sum, batch) => sum + batch.tasks.length, 0),
      }, { status: 202 });
    }
    const league = cleanText(body?.league, 10).toUpperCase();
    const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
    if (!isAnalysisLeagueId(league) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !tasks.length || tasks.length > 20) {
      return NextResponse.json({ ok: false, code: 'INVALID_BACKGROUND_JOB', error: '背景分析工作內容無效' }, { status: 400 });
    }
    const normalizedTasks = league === 'NBA' ? normalizeNbaAnalysisTasks(tasks, date) : normalizeTasks(tasks, league);
    const pushDevice = deviceHash(readCookie(request, PUSH_COOKIE));
    const run = await start(analyzeBoardWorkflow, [{ league, date, tasks: normalizedTasks, pushDevice }]);
    if (requestClaim?.claimed) {
      try { await completeAnalysisJobRequest(requestKey, run.runId); }
      catch {}
    }
    return NextResponse.json({ ok: true, runId: run.runId, league, date, total: normalizedTasks.length }, { status: 202 });
  } catch (error) {
    if (requestKey) {
      try { await failAnalysisJobRequest(requestKey, error?.message || error); }
      catch {}
    }
    const invalidNba = String(error?.message || '').startsWith('NBA 分析身分') || String(error?.message || '').startsWith('NBA 工作場次');
    return NextResponse.json({ ok: false, code: invalidNba ? 'INVALID_NBA_BACKGROUND_JOB' : 'BACKGROUND_JOB_START_FAILED', error: String(error?.message || error) }, { status: invalidNba ? 400 : 500 });
  }
}

export async function GET(request) {
  const startedAt = Date.now();
  const stages = [];
  const measure = async (stage, read) => {
    const start = Date.now();
    let outcome = 'failed';
    try { const value = await read(); outcome = 'ok'; return value; }
    finally { stages.push({ stage, ms: Date.now() - start, outcome }); }
  };
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    const searchParams = new URL(request.url).searchParams;
    const requestKey = cleanText(searchParams.get('requestId'), 100);
    if (requestKey) {
      if (!validAnalysisJobRequestKey(requestKey)) {
        return NextResponse.json({ ok: false, error: '背景工作請求編號無效' }, { status: 400 });
      }
      const requestState = await getAnalysisJobRequest(requestKey);
      if (!requestState) return NextResponse.json({ ok: false, code: 'BACKGROUND_JOB_REQUEST_NOT_FOUND', error: '找不到背景工作請求' }, { status: 404 });
      return NextResponse.json({ ok: requestState.status !== 'failed', ...requestState });
    }
    const runId = searchParams.get('runId') || '';
    const requestedLeague = cleanText(searchParams.get('league'), 10).toUpperCase();
    const summaryOnly = searchParams.get('summary') === '1';
    if (requestedLeague && requestedLeague !== 'NBA' && !isLeagueId(requestedLeague)) {
      return NextResponse.json({ ok: false, error: '聯盟識別無效' }, { status: 400 });
    }
    if (!RUN_ID.test(runId)) return NextResponse.json({ ok: false, error: '缺少有效背景工作編號' }, { status: 400 });
    const run = getRun(runId);
    if (!(await measure('exists', async () => await run.exists))) return NextResponse.json({ ok: false, code: 'BACKGROUND_JOB_NOT_FOUND', error: '找不到背景分析工作' }, { status: 404 });
    const workflowStatus = await measure('workflow_status', async () => await run.status);
    // Independent, optional stores must not serialize every active poll or
    // prevent the authoritative workflow status from being returned on failure.
    const progressRead = requestedLeague && !summaryOnly
      && !['completed', 'failed', 'cancelled'].includes(workflowStatus)
      ? measure('progress', () => getAnalysisJobProgress(runId, requestedLeague, searchParams.get('afterRevision'))).catch(() => null)
      : Promise.resolve(null);
    const publishedResult = workflowStatus === 'completed' ? null
      : await measure('notification_result', () => getNotificationResult(runId)).catch(() => null);
    const status = publishedResult ? 'completed' : workflowStatus;
    if (status === 'completed') {
      const result = publishedResult || await measure('result', async () => await run.returnValue);
      if (requestedLeague && Array.isArray(result?.batches)) {
        const batch = result.batches.find(value => value?.league === requestedLeague);
        if (!batch) return NextResponse.json({ ok: false, code: 'BACKGROUND_JOB_LEAGUE_NOT_FOUND', error: '背景工作沒有這個聯盟' }, { status: 404 });
        return NextResponse.json({ ok: true, runId, status, mode: result.mode, result: batch });
      }
      if (summaryOnly && Array.isArray(result?.batches)) {
        return NextResponse.json({
          ok: true,
          runId,
          status,
          result: {
            ok: result.ok,
            mode: result.mode,
            date: result.date,
            total: result.total,
            completed: result.completed,
            batches: result.batches.map(batch => ({
              ok: batch.ok,
              league: batch.league,
              date: batch.date,
              emptyReason: batch.emptyReason,
              total: batch.total,
              completed: batch.completed,
              results: (batch.results || []).map(row => ({
                ok: row?.ok === true,
                status: row?.status,
                code: row?.code,
                blocked: row?.blocked === true,
              })),
            })),
          },
        });
      }
      if (summaryOnly) {
        return NextResponse.json({
          ok: true, runId, status,
          result: {
            ok: result.ok, league: result.league, date: result.date,
            total: result.total, completed: result.completed,
            results: (result.results || []).map(row => ({
              ok: row?.ok === true, status: row?.status, code: row?.code, blocked: row?.blocked === true,
            })),
          },
        });
      }
      return NextResponse.json({ ok: true, runId, status, result });
    }
    const progress = await progressRead;
    return NextResponse.json({ ok: true, runId, status, progress });
  } catch (error) {
    return NextResponse.json({ ok: false, code: 'BACKGROUND_JOB_STATUS_FAILED', error: String(error?.message || error) }, { status: 500 });
  } finally {
    // No run IDs, query parameters, result bodies or raw errors in telemetry.
    try { console.info(JSON.stringify({ event: 'JOB_STATUS_TIMING', ms: Date.now() - startedAt, stages })); } catch {}
  }
}
