import { NextResponse } from 'next/server';
import { getRun, start } from 'workflow/api';
import { analyzeBoardWorkflow } from '../../../workflows/analyze-board.js';
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

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'analysis-job-start-v1', limit: 12, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 6_000_000);
    const league = cleanText(body?.league, 10).toUpperCase();
    const date = cleanText(body?.date, 20);
    const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
    if (!isLeagueId(league) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !tasks.length || tasks.length > 20) {
      return NextResponse.json({ ok: false, code: 'INVALID_BACKGROUND_JOB', error: '背景分析工作內容無效' }, { status: 400 });
    }
    const normalizedTasks = tasks.map((task, index) => {
      const requestId = REQUEST_ID.test(String(task?.requestId || '')) ? String(task.requestId) : `background-${Date.now()}-${index}-${crypto.randomUUID()}`;
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
    const run = await start(analyzeBoardWorkflow, [{ league, date, tasks: normalizedTasks }]);
    return NextResponse.json({ ok: true, runId: run.runId, league, date, total: normalizedTasks.length }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ ok: false, code: 'BACKGROUND_JOB_START_FAILED', error: String(error?.message || error) }, { status: 500 });
  }
}

export async function GET(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    const runId = new URL(request.url).searchParams.get('runId') || '';
    if (!RUN_ID.test(runId)) return NextResponse.json({ ok: false, error: '缺少有效背景工作編號' }, { status: 400 });
    const run = getRun(runId);
    if (!(await run.exists)) return NextResponse.json({ ok: false, code: 'BACKGROUND_JOB_NOT_FOUND', error: '找不到背景分析工作' }, { status: 404 });
    const status = await run.status;
    if (status === 'completed') {
      return NextResponse.json({ ok: true, runId, status, result: await run.returnValue });
    }
    return NextResponse.json({ ok: true, runId, status });
  } catch (error) {
    return NextResponse.json({ ok: false, code: 'BACKGROUND_JOB_STATUS_FAILED', error: String(error?.message || error) }, { status: 500 });
  }
}
