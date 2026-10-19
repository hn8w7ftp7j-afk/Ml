import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse, readJsonBody } from '../../../../lib/security.js';
import { normalizeSoccerForwardScope } from '../../../../lib/soccer/forward-validation.js';
import { readSoccerForwardValidation, runSoccerForwardValidation } from '../../../../lib/soccer/forward-validation-service.js';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = error => response({ ok: false, error: error.status === 400 ? error.message : '前瞻驗證資料暫時無法核對，未確認賽果不會列入統計。' }, error.status || 503);
const keys = new Set(['league', 'date', 'from', 'through']);
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'soccer-forward-read', limit: 60, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !keys.has(key) || params.getAll(key).length !== 1)) return response({ ok: false, error: '不支援的前瞻驗證查詢。' }, 400);
    const scope = normalizeSoccerForwardScope(Object.fromEntries(params));
    return response({ ok: true, report: await readSoccerForwardValidation(scope) });
  } catch (error) { return fail(error); }
}
export async function POST(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'soccer-forward-evaluate', limit: 4, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 2000);
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.action !== 'evaluate'
      || Object.keys(body).some(key => !keys.has(key) && !['action', 'limit'].includes(key))) return response({ ok: false, error: '只接受核對伺服器已封存的預測，不接受傳入預測或賽果。' }, 400);
    if (body.limit != null && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 25)) return response({ ok: false, error: '一次最多核對 25 場。' }, 400);
    const scope = normalizeSoccerForwardScope(body);
    const summary = await runSoccerForwardValidation(scope, { limit: body.limit || 25, timeBudgetMs: 18000 });
    return response({ ok: true, summary, report: await readSoccerForwardValidation(scope) });
  } catch (error) { return fail(error); }
}
