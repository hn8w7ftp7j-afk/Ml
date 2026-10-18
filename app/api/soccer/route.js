import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitResponse, requireApiAuth } from '../../../lib/security.js';
import { SOCCER_CAPABILITIES, SOCCER_DATA_VERSION, SOCCER_LEAGUES, soccerDate, soccerLeague, validSoccerDate } from '../../../lib/soccer/contracts.js';
import { fetchSoccerSchedule, fetchSoccerStandings } from '../../../lib/soccer/data.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const response = (payload, status = 200) => NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'soccer-data-v1', limit: 90, windowMs: 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  const params = new URL(request.url).searchParams;
  for (const name of ['league', 'date', 'view']) if (params.getAll(name).length > 1) return response({ ok: false, code: 'SOCCER_DUPLICATE_PARAMETER', error: '查詢條件重複' }, 400);
  const league = soccerLeague(params.get('league') || 'epl');
  if (!league) return response({ ok: false, code: 'SOCCER_INVALID_LEAGUE', error: '只支援英超 EPL 或歐冠 UCL' }, 400);
  const view = params.get('view') || 'schedule';
  if (view === 'status') return response({ ok: true, version: SOCCER_DATA_VERSION, leagues: Object.values(SOCCER_LEAGUES), capabilities: SOCCER_CAPABILITIES });
  if (!['schedule', 'upcoming', 'standings'].includes(view)) return response({ ok: false, code: 'SOCCER_INVALID_VIEW', error: '查詢類型無效' }, 400);
  const date = params.get('date') || soccerDate();
  if (!validSoccerDate(date)) return response({ ok: false, code: 'SOCCER_INVALID_DATE', error: '請輸入有效的台灣日期' }, 400);
  try {
    const result = view === 'standings' ? await fetchSoccerStandings(league.id) : await fetchSoccerSchedule(league.id, date, { windowDays: view === 'upcoming' ? 14 : 1 });
    return response({ ...result, date, view, ...(view === 'standings' ? { standingsScope: 'CURRENT_PROVIDER_TABLE', historicalAsOfVerified: false, requestedDateIsNavigationOnly: true } : {}), ...(!result.ok ? { error: result.code?.includes('IDENTITY') || result.code?.includes('INVALID') || result.code?.includes('CONFLICT') ? '資料身分或格式核對未通過，請稍後重試' : '足球資料來源暫時無法更新，請稍後重試' } : {}) }, result.ok ? 200 : 503);
  } catch { return response({ ok: false, league, code: 'SOCCER_DATA_UNAVAILABLE', error: '足球資料暫時無法更新，請稍後重試' }, 503); }
}
