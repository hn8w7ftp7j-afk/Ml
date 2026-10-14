import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitResponse, requireApiAuth, validateSameOrigin, originErrorResponse, readJsonBody } from '../../../../lib/security.js';
import { listNbaPerformanceLedgerPage, normalizeNbaPerformanceReadOptions } from '../../../../lib/nba/manual-bet-store.js';
import { settleOpenNbaManualRecords } from '../../../../lib/nba/manual-bet-settlement-service.js';

export const maxDuration = 60;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
function failure(error) {
  if (error?.status === 400) return response({ ok: false, code: error.code || 'NBA_PERFORMANCE_OPTIONS_INVALID', error: error.message }, 400);
  console.warn('[NBA_PERFORMANCE_UNAVAILABLE]', { code: error?.code || 'NBA_PERFORMANCE_UNAVAILABLE' });
  return response({ ok: false, code: 'NBA_PERFORMANCE_UNAVAILABLE',
    error: 'NBA 永久績效帳本尚未完成讀取或結算，請稍後重試；不會將失敗回應視為零筆紀錄。' }, 503);
}
async function readWithDeadline(options) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('NBA performance ledger read timed out'), {
      code: 'NBA_PERFORMANCE_READ_TIMEOUT', status: 503,
    })), 12000);
  });
  try { return await Promise.race([listNbaPerformanceLedgerPage(options), deadline]); }
  finally { clearTimeout(timer); }
}

export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  const rate = checkRateLimit(request, { id: 'nba-performance-read', limit: 120, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['date', 'limit', 'cursor'].includes(key))
      || [...new Set(params.keys())].some(key => params.getAll(key).length > 1)) {
      return response({ ok: false, code: 'NBA_PERFORMANCE_READ_OPTIONS_INVALID', error: 'NBA 績效查詢參數不正確。' }, 400);
    }
    const options = { date: params.get('date'), limit: params.get('limit'), cursor: params.get('cursor') };
    normalizeNbaPerformanceReadOptions(options);
    return response({ ok: true, ...await readWithDeadline(options), statsScope: 'RETURNED_RECORDS_ONLY' });
  } catch (error) { return failure(error); }
}

export async function POST(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'nba-performance-settle', limit: 30, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 2000);
    if (body.action !== 'settle' || Object.keys(body).some(key => key !== 'action')) {
      return response({ ok: false, code: 'NBA_PERFORMANCE_ACTION_INVALID', error: 'NBA 績效操作不正確。' }, 400);
    }
    const summary = await settleOpenNbaManualRecords({ limit: 100, timeBudgetMs: 15000 });
    return response({ ok: true, summary });
  } catch (error) { return failure(error); }
}
