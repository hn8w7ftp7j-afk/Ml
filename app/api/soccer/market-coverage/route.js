import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse } from '../../../../lib/security.js';
import { readSoccerOfficialMarketCoverage } from '../../../../lib/soccer/official-market-coverage.js';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'soccer-market-coverage', limit: 90, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['league', 'date', 'cursor'].includes(key) || params.getAll(key).length !== 1)) return response({ ok: false, error: '足球市場覆蓋查詢欄位無效。', formalEligible: false, executable: false }, 400);
    return response(await readSoccerOfficialMarketCoverage(Object.fromEntries(params)));
  } catch (error) {
    const status = [400, 409].includes(error?.status) ? error.status : 503;
    return response({ ok: false, code: status === 409 ? 'SOCCER_MARKET_COVERAGE_SCOPE_CHANGED' : status === 400 ? 'SOCCER_MARKET_COVERAGE_QUERY_INVALID' : 'SOCCER_MARKET_COVERAGE_UNAVAILABLE',
      error: status === 409 ? '賽程或原盤範圍已變動，請重新核對。' : status === 400 ? '足球市場覆蓋查詢範圍或游標無效。' : '官方賽程或原盤暫時無法核對，覆蓋數量未知。', formalEligible: false, executable: false }, status);
  }
}
