import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitResponse, requireApiAuth, validateSameOrigin, originErrorResponse, readJsonBody } from '../../../../lib/security.js';
import { listSoccerPerformanceLedgerPage, normalizeSoccerPerformanceReadOptions } from '../../../../lib/soccer/manual-record-store.js';
import { settleOpenSoccerManualRecords } from '../../../../lib/soccer/manual-settlement-service.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
function failure(error) {
  if (error?.status === 400) return response({ ok: false, code: error.code || 'SOCCER_PERFORMANCE_OPTIONS_INVALID', error: error.message }, 400);
  console.warn('[SOCCER_PERFORMANCE_UNAVAILABLE]', { code: error?.code || 'SOCCER_PERFORMANCE_UNAVAILABLE' });
  return response({ ok: false, code: 'SOCCER_PERFORMANCE_UNAVAILABLE',
    error: '足球永久績效帳本尚未完成讀取或結算，請稍後重試；不會將失敗回應視為零筆紀錄。' }, 503);
}
async function readWithDeadline(options) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Soccer performance ledger read timed out'), {
      code: 'SOCCER_PERFORMANCE_READ_TIMEOUT', status: 503,
    })), 12000);
  });
  try { return await Promise.race([listSoccerPerformanceLedgerPage(options), deadline]); }
  finally { clearTimeout(timer); }
}
export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  const rate = checkRateLimit(request, { id: 'soccer-performance-read', limit: 120, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['league', 'date', 'limit', 'cursor'].includes(key))
      || [...new Set(params.keys())].some(key => params.getAll(key).length > 1)) {
      return response({ ok: false, code: 'SOCCER_PERFORMANCE_READ_OPTIONS_INVALID', error: '足球績效查詢參數不正確。' }, 400);
    }
    const options = Object.fromEntries(['league', 'date', 'limit', 'cursor'].map(key => [key, params.get(key)]));
    normalizeSoccerPerformanceReadOptions(options);
    return response({ ok: true, ...await readWithDeadline(options), statsScope: 'RETURNED_RECORDS_ONLY' });
  } catch (error) { return failure(error); }
}
export async function POST(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'soccer-performance-settle', limit: 30, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 2000);
    if (body.action !== 'settle' || !['epl', 'ucl'].includes(body.league)
      || Object.keys(body).some(key => !['action', 'league'].includes(key))) {
      return response({ ok: false, code: 'SOCCER_PERFORMANCE_ACTION_INVALID', error: '足球績效操作不正確。' }, 400);
    }
    const summary = await settleOpenSoccerManualRecords({ league: body.league, limit: 100, timeBudgetMs: 15000 });
    return response({ ok: true, league: body.league, summary });
  } catch (error) { return failure(error); }
}
