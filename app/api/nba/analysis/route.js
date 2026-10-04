import { NextResponse } from 'next/server';
import { checkRateLimit, requireApiAuth } from '../../../../lib/security.js';
import { loadNbaAnalysis, validNbaAnalysisQuery } from '../../../../lib/nba/analysis-service.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const respond = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const query = { date: params.get('date'), id: params.get('id'), observedAt: params.get('observedAt') };
  if (!validNbaAnalysisQuery(query) || [...params.keys()].some(key => !['date', 'id', 'observedAt'].includes(key))
    || ['date', 'id', 'observedAt'].some(key => params.getAll(key).length !== 1))
    return respond({ league: 'NBA', executable: false, error: 'NBA 分析參數無效，請重新讀取盤口。' }, 400);
  const rate = checkRateLimit(request, { id: 'nba-total-analysis', limit: 30, windowMs: 60_000 });
  if (!rate.allowed) return respond({ league: 'NBA', executable: false, error: '分析太頻繁，請稍後重試。' }, 429);
  try {
    const result = await loadNbaAnalysis(query);
    return respond(result, result.status === 'blocked' ? 409 : 200);
  } catch (error) {
    console.warn('[NBA_ANALYSIS_UNAVAILABLE]', { code: error?.code || 'NBA_ANALYSIS_UNAVAILABLE' });
    return respond({ league: 'NBA', executable: false, status: 'blocked', code: 'NBA_ANALYSIS_UNAVAILABLE',
      error: 'NBA 分析來源暫時無法取得，請稍後再試。' }, 503);
  }
}
