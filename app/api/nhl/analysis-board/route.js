import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitResponse, requireApiAuth } from '../../../../lib/security.js';
import { validNhlDate } from '../../../../lib/nhl/identity.js';
import { loadNhlAnalysisBoard } from '../../../../lib/nhl/analysis-board.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  const query = new URL(request.url).searchParams;
  if (!validNhlDate(query.get('date')) || [...query.keys()].some(key => !['date', 'upcoming'].includes(key))
    || query.getAll('date').length !== 1 || query.getAll('upcoming').length > 1
    || (query.has('upcoming') && query.get('upcoming') !== '1')) return response({ ok: false, code: 'NHL_INVALID_DATE', error: 'NHL 日期或參數無效' }, 400);
  const rate = checkRateLimit(request, { id: 'nhl-analysis-board', limit: 60, windowMs: 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try { return response({ ok: true, ...await loadNhlAnalysisBoard(query.get('date'), { upcoming: query.get('upcoming') === '1' }) }); }
  catch (error) { return response({ ok: false, code: error?.code || 'NHL_SCHEDULE_UNAVAILABLE', error: 'NHL 官方賽程暫時無法核對，請重試。' }, 503); }
}
