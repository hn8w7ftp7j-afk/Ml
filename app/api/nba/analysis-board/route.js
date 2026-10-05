import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit, rateLimitResponse } from '../../../../lib/security.js';
import { validDate } from '../../../../lib/nba/identity.js';
import { loadNbaAnalysisBoard } from '../../../../lib/nba/analysis-board.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  const query = new URL(request.url).searchParams;
  if (query.size !== 1 || !validDate(query.get('date'))) return response({ ok: false, error: 'NBA 日期或參數無效' }, 400);
  const rate = checkRateLimit(request, { id: 'nba-analysis-board', limit: 60, windowMs: 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try { return response({ ok: true, ...await loadNbaAnalysisBoard(query.get('date')) }); }
  catch { return response({ ok: false, error: 'NBA 賽程或盤口暫時無法核對，請重試。' }, 503); }
}
