import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit, rateLimitResponse } from '../../../lib/security.js';
import { MARKET_LINE_HISTORY_QUERY_HEADERS, parseMarketLineHistoryQuery, queryMarketLineHistory } from '../../../lib/market-line-history-query.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  const rate = checkRateLimit(request, { id: 'market-line-history', limit: 60, windowMs: 600_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const query = parseMarketLineHistoryQuery(new URL(request.url).searchParams);
    return NextResponse.json(await queryMarketLineHistory(query), { headers: MARKET_LINE_HISTORY_QUERY_HEADERS });
  } catch (error) {
    const status = error?.status === 400 ? 400 : 503;
    const code = error?.code || 'HISTORY_READ_FAILED';
    if (status === 503) console.error('[MARKET_LINE_HISTORY_READ_FAILED]', { code });
    return NextResponse.json({ ok: false, code, error: error?.status ? error.message : '歷史盤口查詢失敗，請稍後重試', productionWrites: false },
      { status, headers: MARKET_LINE_HISTORY_QUERY_HEADERS });
  }
}
