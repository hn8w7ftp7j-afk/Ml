import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse, readJsonBody } from '../../../../lib/security.js';
import { syncNbaLiveHistory } from '../../../../lib/nba/live-history-service.js';
import { readNbaHistoryStatus } from '../../../../lib/nba/history-status.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
const respond = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const failed = () => respond({ ok: false, error: 'NBA 歷史更新或永久保存暫時無法核對；未標記訓練資料完整。' }, 503);
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if ([...new URL(request.url).searchParams].length) return respond({ ok: false, error: '不接受自訂訓練資料查詢。' }, 400);
  try { return respond({ ok: true, history: await readNbaHistoryStatus() }); } catch { return failed(); }
}
export async function POST(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'nba-history-sync', limit: 2, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 1000);
    if (body.action !== 'sync' || Object.keys(body).some(key => key !== 'action')) return respond({ ok: false, error: '只接受近期完賽資料同步，不接受注入比分、球員或訓練資料。' }, 400);
    const summary = await syncNbaLiveHistory({ lookbackDays: 3, limit: 18, timeBudgetMs: 45000 });
    return respond({ ok: true, summary, history: await readNbaHistoryStatus() });
  } catch { return failed(); }
}
