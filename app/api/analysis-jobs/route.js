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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RUN_ID = /^[a-zA-Z0-9_:-]{8,300}$/;
const REQUEST_ID = /^[a-zA-Z0-9-]{16,100}$/;
const EMPTY_REASONS = new Set(['no_games', 'no_open_markets']);

function normalizeTasks(tasks, league, prefix = '') {
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
      body: {
        league,
        game: task?.game || null,
        markets: Array.isArray(task?.actualMarkets) ? task.actualMarkets : [],
        readerProvenance: task?.readerProvenance || null,
        verificationMarkets: Array.isArray(task?.verificationMarkets) ? task.verificationMarkets : [],
        settings: { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
      },
    };
  });
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'analysis-job-start-v1', limit: 12, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 6_000_000);
    const date = cleanText(body?.date, 20);
    if (body?.mode === 'all-leagues') {
      const batches = Array.isArray(body?.batches) ? body.batches : [];
      const normalizedBatches = batches.map((batch, batchIndex) => {
        const league = cleanText(batch?.league, 10).toUpperCase();
        const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
        return {
          league,
          date,
          emptyReason: EMPTY_REASONS.has(batch?.emptyReason) ? batch.emptyReason : null,
          tasks: normalizeTasks(tasks, league, `${league}-${batchIndex}-`),
        };
      });
      const leagues = normalizedBatches.map(batch => batch.league);
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(date)
        && normalizedBatches.length > 0
        && normalizedBatches.length <= 4
        && normalizedBatches.every(batch => isLeagueId(batch.league) && batch.tasks.length <= 20)
        && new Set(leagues).size === leagues.length;
      if (!valid) {
        return NextResponse.json({ ok: false, code: 'INVALID_ALL_LEAGUE_BACKGROUND_JOB', error: '四聯盟背景分析工作內容無效' }, { status: 400 });
      }
      const run = await start(analyzeAllLeaguesWorkflow, [{ date, batches: normalizedBatches }]);
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
    if (!isLeagueId(league) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !tasks.length || tasks.length > 20) {
      return NextResponse.json({ ok: false, code: 'INVALID_BACKGROUND_JOB', error: '背景分析工作內容無效' }, { status: 400 });
    }
    const normalizedTasks = normalizeTasks(tasks, league);
    const run = await start(analyzeBoardWorkflow, [{ league, date, tasks: normalizedTasks }]);
    return NextResponse.json({ ok: true, runId: run.runId, league, date, total: normalizedTasks.length }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ ok: false, code: 'BACKGROUND_JOB_START_FAILED', error: String(error?.message || error) }, { status: 500 });
  }
}

export async function GET(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    const searchParams = new URL(request.url).searchParams;
    const runId = searchParams.get('runId') || '';
    const requestedLeague = cleanText(searchParams.get('league'), 10).toUpperCase();
    const summaryOnly = searchParams.get('summary') === '1';
    if (requestedLeague && !isLeagueId(requestedLeague)) {
      return NextResponse.json({ ok: false, error: '聯盟識別無效' }, { status: 400 });
    }
    if (!RUN_ID.test(runId)) return NextResponse.json({ ok: false, error: '缺少有效背景工作編號' }, { status: 400 });
    const run = getRun(runId);
    if (!(await run.exists)) return NextResponse.json({ ok: false, code: 'BACKGROUND_JOB_NOT_FOUND', error: '找不到背景分析工作' }, { status: 404 });
    const status = await run.status;
    if (status === 'completed') {
      const result = await run.returnValue;
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
      return NextResponse.json({ ok: true, runId, status, result });
    }
    return NextResponse.json({ ok: true, runId, status });
  } catch (error) {
    return NextResponse.json({ ok: false, code: 'BACKGROUND_JOB_STATUS_FAILED', error: String(error?.message || error) }, { status: 500 });
  }
}
