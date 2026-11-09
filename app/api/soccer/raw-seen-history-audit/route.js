import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse } from '../../../../lib/security.js';
import { parseRawSeenHistoryAuditQuery, readRawSeenHistoryAudit, RAW_HISTORY_AUDIT_SCHEMA, RAW_HISTORY_AUDIT_FLAGS } from '../../../../lib/soccer/raw-seen-history-audit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 40;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'soccer-raw-history-audit-read', limit: 30, windowMs: 600000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const result = await readRawSeenHistoryAudit(parseRawSeenHistoryAuditQuery(new URL(request.url).searchParams));
    return NextResponse.json(result, { status: result.ok ? 200 : 503, headers });
  } catch (error) {
    const invalid = error?.status === 400;
    return NextResponse.json({ ok: false, schema: RAW_HISTORY_AUDIT_SCHEMA, ...RAW_HISTORY_AUDIT_FLAGS,
      status: invalid ? 'INVALID_QUERY' : 'UNKNOWN', samples: [],
      reason: invalid ? 'RAW_HISTORY_AUDIT_QUERY_INVALID' : 'RAW_HISTORY_AUDIT_UNAVAILABLE' }, { status: invalid ? 400 : 503, headers });
  }
}
