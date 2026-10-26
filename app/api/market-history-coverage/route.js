import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit, rateLimitResponse } from '../../../lib/security.js';
import { MARKET_HISTORY_COVERAGE_HEADERS, parseMarketHistoryCoverageQuery, queryMarketHistoryCoverage } from '../../../lib/market-history-coverage.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  const rate = checkRateLimit(request, { id: 'market-history-coverage', limit: 60, windowMs: 600_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const result = await queryMarketHistoryCoverage(parseMarketHistoryCoverageQuery(new URL(request.url).searchParams));
    return NextResponse.json(result, { status: result.ok ? 200 : 503, headers: MARKET_HISTORY_COVERAGE_HEADERS });
  } catch (error) {
    const status = error?.status === 400 ? 400 : 503;
    return NextResponse.json({ ok: false, status: 'FAIL', code: error?.code || 'HISTORY_READ_FAILED',
      error: error?.status ? error.message : '盤口保存核對失敗，請稍後重試', productionWrites: false, coverageComplete: false },
    { status, headers: MARKET_HISTORY_COVERAGE_HEADERS });
  }
}
