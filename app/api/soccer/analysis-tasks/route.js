import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitResponse, requireApiAuth } from '../../../../lib/security.js';
import { soccerLeague, validSoccerDate } from '../../../../lib/soccer/contracts.js';
import { loadSoccerAnalysisBoard } from '../../../../lib/soccer/analysis-board.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const query = new URL(request.url).searchParams;
  if (!soccerLeague(query.get('league')) || !validSoccerDate(query.get('date'))
    || [...query.keys()].some(key => !['league', 'date', 'upcoming'].includes(key))
    || query.getAll('league').length !== 1 || query.getAll('date').length !== 1 || query.getAll('upcoming').length > 1
    || query.has('upcoming') && query.get('upcoming') !== '1')
    return response({ ok: false, code: 'SOCCER_INVALID_BOARD_SCOPE', error: '足球聯盟、日期或參數無效' }, 400);
  const rate = checkRateLimit(request, { id: 'soccer-analysis-tasks', limit: 60, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try { return response({ ok: true, ...await loadSoccerAnalysisBoard(query.get('league'), query.get('date'), { upcoming: query.get('upcoming') === '1' }) }); }
  catch (error) { return response({ ok: false, code: error?.code || 'SOCCER_SCHEDULE_UNAVAILABLE', error: '足球官方賽程暫時無法核對，請重試。' }, 503); }
}
