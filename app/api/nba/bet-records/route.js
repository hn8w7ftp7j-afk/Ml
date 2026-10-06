import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse, readJsonBody } from '../../../../lib/security.js';
import { validDate } from '../../../../lib/nba/identity.js';
import { archiveNbaManualBetRecord, listNbaManualBetRecords, changeNbaManualBetRecordStatus } from '../../../../lib/nba/manual-bet-store.js';
import { settleOpenNbaManualRecords } from '../../../../lib/nba/manual-bet-settlement-service.js';
export const maxDuration = 60;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = error => response({ ok: false, error: error.status === 400 ? error.message : '永久紀錄暫時無法讀寫，未確認保存；請稍後重試。' }, error.status || 503);
export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  const date = new URL(request.url).searchParams.get('date');
  if (!validDate(date)) return response({ ok: false, error: '日期不正確。' }, 400);
  try { return response({ ok: true, records: await listNbaManualBetRecords(date) }); } catch (error) { return failure(error); }
}
export async function POST(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'nba-manual-record', limit: 60, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 12000);
    if (body.action === 'settle') {
      if (!validDate(body.date)) return response({ ok: false, error: '日期不正確。' }, 400);
      const summary = await settleOpenNbaManualRecords({ date: body.date, limit: 100, timeBudgetMs: 15000 });
      return response({ ok: true, summary, records: await listNbaManualBetRecords(body.date) });
    }
    if (['cancel', 'restore'].includes(body.action)) return response({ ok: true, ...await changeNbaManualBetRecordStatus(body.id, body.action) });
    if (body.action != null) return response({ ok: false, error: '不支援的紀錄操作。' }, 400);
    return response({ ok: true, ...await archiveNbaManualBetRecord(body) });
  } catch (error) { return failure(error); }
}
