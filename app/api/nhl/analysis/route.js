import { NextResponse } from 'next/server';
import { requireApiAuth, readJsonBody, checkRateLimit, rateLimitResponse } from '../../../../lib/security.js';
import { analyzeNhlPregame, listNhlPregameAnalyses, validNhlPregameRequest } from '../../../../lib/nhl/pregame-analysis.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const response = (body, status = 200) => NextResponse.json({ ...body, league: 'NHL' }, { status,
  headers: { 'Cache-Control': 'no-store' } });
const failure = cause => response({ ok: false, code: cause.code || 'NHL_ANALYSIS_ERROR',
  error: cause.status ? cause.message : 'NHL 分析暫時無法完成，先前紀錄仍保留。' }, cause.status || 503);

export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'nhl-analysis-read', limit: 90, windowMs: 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const params = new URL(request.url).searchParams;
    if (params.getAll('date').length !== 1 || [...params.keys()].some(key => key !== 'date'))
      return response({ ok: false, code: 'NHL_INVALID_ANALYSIS_DATE', error: '請提供唯一的 NHL 台灣日期。' }, 400);
    return response({ ok: true, ...await listNhlPregameAnalyses(params.get('date')) });
  } catch (cause) { return failure(cause); }
}

export async function POST(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'nhl-analysis-run', limit: 45, windowMs: 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 8_000);
    if (!validNhlPregameRequest(body) || Object.keys(body).some(key => !['league', 'date', 'gameId', 'force'].includes(key)))
      return response({ ok: false, code: 'NHL_INVALID_ANALYSIS_REQUEST', error: 'NHL 分析只接受日期與官方賽事 ID。' }, 400);
    const analysis = await analyzeNhlPregame(body);
    return response({ ok: true, date: body.date, gameId: body.gameId, analysis });
  } catch (cause) { return failure(cause); }
}
