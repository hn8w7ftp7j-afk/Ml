import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse } from '../../../../lib/security.js';
import { READER_LEGACY_HISTORY_SCHEMA, READER_LEGACY_HISTORY_FLAGS, parseReaderLegacyHistoryQuery, readReaderLegacyHistory } from '../../../../lib/reader-legacy-history.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export async function GET(request) {
  // A paired Reader can submit current boards but cannot read forensic data.
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'reader-legacy-history-read', limit: 60, windowMs: 600000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const scope = parseReaderLegacyHistoryQuery(new URL(request.url).searchParams);
    return NextResponse.json(await readReaderLegacyHistory(scope), { headers });
  } catch (error) {
    const known = /^LEGACY_READER_[A-Z_]+$/.test(error?.code || '');
    const status = known && [400, 409, 413].includes(error.status) ? error.status : 503;
    return NextResponse.json({ ok: false, schema: READER_LEGACY_HISTORY_SCHEMA, ...READER_LEGACY_HISTORY_FLAGS,
      status: 'NOT_VERIFIED', count: null, code: known ? error.code : 'LEGACY_READER_STORAGE_UNAVAILABLE',
      error: status === 400 ? '保留快照查詢條件無效。' : status === 413 ? '單筆保留快照超過查閱上限，尚未讀取價格。'
        : status === 409 ? '保留快照未通過內容或來源核對，未當成有效盤口。' : '保留快照暫時無法核對，數量未當成零。',
    }, { status, headers });
  }
}
