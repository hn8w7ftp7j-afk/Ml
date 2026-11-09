import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse } from '../../../../lib/security.js';
import { parseRawMarketCoverageQuery, readRawMarketCoverage, RAW_MARKET_COVERAGE_SCHEMA, RAW_MARKET_COVERAGE_FLAGS } from '../../../../lib/soccer/raw-market-coverage.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 40;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'soccer-raw-market-coverage-read', limit: 30, windowMs: 600000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const value = await readRawMarketCoverage(parseRawMarketCoverageQuery(new URL(request.url).searchParams));
    return NextResponse.json(value, { status: value.ok ? 200 : 503, headers });
  } catch (error) {
    const invalid = error?.status === 400;
    return NextResponse.json({ ok: false, schema: RAW_MARKET_COVERAGE_SCHEMA, ...RAW_MARKET_COVERAGE_FLAGS,
      status: 'UNKNOWN', schedule: null, inventory: null, games: [], sources: [],
      reasonCodes: [invalid ? 'RAW_MARKET_COVERAGE_QUERY_INVALID' : 'RAW_MARKET_COVERAGE_UNAVAILABLE'] }, { status: invalid ? 400 : 503, headers });
  }
}
