import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit, rateLimitResponse } from '../../../../lib/security.js';
import { parseRawSeenHistoryQuery, queryRawSeenSoccerHistory, RAW_SEEN_HISTORY_SCHEMA, RAW_SEEN_HISTORY_FLAGS } from '../../../../lib/soccer/raw-seen-history.js';

export const dynamic='force-dynamic';
export const maxDuration=60;
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
export async function GET(request) {
  const denied=await requireApiAuth(request); if (denied) return denied;
  const rate=checkRateLimit(request,{id:'soccer-raw-seen-history',limit:30,windowMs:600_000});
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    return NextResponse.json(await queryRawSeenSoccerHistory(parseRawSeenHistoryQuery(new URL(request.url).searchParams)),{headers});
  } catch (error) {
    const status=[400,404,413,422].includes(error?.status)?error.status:503;
    return NextResponse.json({ok:false,schema:RAW_SEEN_HISTORY_SCHEMA,...RAW_SEEN_HISTORY_FLAGS,
      code:/^(?:RAW_SEEN_RECOVERY_|READER_SEEN_CAPTURE_)[A-Z0-9_]+$/.test(error?.code || '')?error.code:'RAW_SEEN_RECOVERY_UNAVAILABLE',
      error:'原始擷取尚未通過完整重播核對，未將缺少的資料視為零筆。'}, {status,headers});
  }
}
