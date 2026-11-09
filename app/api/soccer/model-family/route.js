import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse, readJsonBody } from '../../../../lib/security.js';
import { continueSoccerModelFamilyScan, readSoccerModelFamilyScan, freezeSoccerModelFamilyScan } from '../../../../lib/soccer/model-family-scan.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const response = (body, status = 200) => NextResponse.json(body, { status, headers });
const cursorValid = value => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
const scopeValid = value => ['epl', 'ucl'].includes(value?.league) && ['FT', 'HT'].includes(value?.period)
  && (!Object.hasOwn(value, 'cursor') || cursorValid(value.cursor));
function invalid() { throw Object.assign(Error('MODEL_FAMILY_REQUEST_INVALID'), { code: 'MODEL_FAMILY_REQUEST_INVALID', status: 400 }); }
function failed(error) {
  const status = [400, 409, 413].includes(error?.status) ? error.status : 503;
  const code = [error?.code, error?.message].find(value => /^MODEL_FAMILY_[A-Z0-9_]{1,120}$/.test(value || '')) || 'MODEL_FAMILY_UNAVAILABLE';
  if (status === 503) console.error('Soccer model family verification unavailable', { code });
  return response({ ok: false, code, error: status === 409 ? '核對來源或驗證狀態已改變，請重新核對。'
    : status === 400 || status === 413 ? '請求範圍無效，只接受伺服器保存的英超或歐冠紀錄。'
      : '模型誤差核對暫時無法完成，樣本與結果未知。', formalEligible: false, executable: false, W: null, R: null, S: null }, status);
}
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'soccer-model-family-read', limit: 60, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['league', 'period', 'cursor'].includes(key) || params.getAll(key).length !== 1)) invalid();
    const scope = Object.fromEntries(params);
    if (!scopeValid(scope)) invalid();
    return response({ ok: true, report: await readSoccerModelFamilyScan(scope) });
  } catch (error) { return failed(error); }
}
export async function POST(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'soccer-model-family-write', limit: 60, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    if (new URL(request.url).search) invalid();
    const body = await readJsonBody(request, 1000);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['action', 'league', 'period', 'cursor'].includes(key))
      || !scopeValid(body) || !['replay', 'freeze'].includes(body.action)
      || body.action === 'freeze' && !cursorValid(body.cursor)) invalid();
    const scope = { league: body.league, period: body.period, ...(body.cursor ? { cursor: body.cursor } : {}) };
    if (body.action === 'freeze') return response(await freezeSoccerModelFamilyScan(scope));
    return response({ ok: true, report: await continueSoccerModelFamilyScan(scope) });
  } catch (error) { return failed(error); }
}
