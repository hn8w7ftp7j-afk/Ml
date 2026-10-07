import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse, readJsonBody } from '../../../../lib/security.js';
import { normalizeNbaForwardScope } from '../../../../lib/nba/forward-store.js';
import { evaluatePendingNbaCaptures, readNbaForwardValidation } from '../../../../lib/nba/forward-service.js';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = error => response({ ok: false, error: error.status === 400 ? error.message : '前瞻驗證資料暫時無法核對；沒有將未確認結果列入勝率。' }, error.status || 503);
const allowed = new Set(['from', 'through', 'date']);
export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) return response({ ok: false, error: '不支援的驗證查詢。' }, 400);
    const range = normalizeNbaForwardScope(Object.fromEntries(params));
    return response({ ok: true, report: await readNbaForwardValidation(range) });
  } catch (error) { return failure(error); }
}
export async function POST(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'nba-forward-evaluate', limit: 4, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 2000);
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.action !== 'evaluate' || Object.keys(body).some(key => !allowed.has(key) && !['action', 'limit'].includes(key)))
      return response({ ok: false, error: '只接受伺服器原始預測的 evaluate 操作，不接受注入預測或賽果。' }, 400);
    if (body.limit != null && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 50)) return response({ ok: false, error: '一次最多核對 50 場。' }, 400);
    const range = normalizeNbaForwardScope(body);
    const summary = await evaluatePendingNbaCaptures({ ...range, limit: body.limit || 50, timeBudgetMs: 35000 });
    return response({ ok: true, summary, report: await readNbaForwardValidation(range) });
  } catch (error) { return failure(error); }
}
