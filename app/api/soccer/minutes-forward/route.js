import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit, rateLimitResponse, validateSameOrigin, originErrorResponse, readJsonBody } from '../../../../lib/security.js';
import { readSoccerMinutesForwardReport, evaluateSoccerMinutesForward } from '../../../../lib/soccer/minutes-forward-validation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const respond = (value, status = 200) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const validLeague = value => ['epl', 'ucl'].includes(value);
const failure = () => respond({ ok: false, error: '分鐘預測的封存或賽果暫時無法核對，目前筆數未知。', formalEligible: false, executable: false }, 503);

export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'soccer-minutes-forward-read', limit: 30, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  const params = new URL(request.url).searchParams, league = params.get('league');
  if (!validLeague(league) || [...params.keys()].some(key => !['league','afterSequence','revision'].includes(key) || params.getAll(key).length !== 1)
    || !/^(?:0|[1-9]\d{0,17})$/.test(params.get('afterSequence') ?? '0')
    || params.has('revision') && !/^[a-f0-9]{64}$/.test(params.get('revision'))
    || (params.get('afterSequence') ?? '0') !== '0' && !params.has('revision'))
    return respond({ ok: false, error: '分鐘驗證查詢只接受英超或歐冠聯盟。' }, 400);
  try { return respond({ ok: true, report: await readSoccerMinutesForwardReport(league,
    { afterSequence: params.get('afterSequence') ?? '0', revision: params.get('revision') }) }); }
  catch (error) {
    if (error?.status === 409) return respond({ ok: false, code: 'MINUTES_FORWARD_HISTORY_CHANGED_DURING_READ',
      error: '核對期間有新分鐘紀錄，請重新讀取完整範圍。' }, 409);
    return failure();
  }
}

export async function POST(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'soccer-minutes-forward-evaluate', limit: 4, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 1000);
    if (!validLeague(body?.league) || body?.action !== 'evaluate' || Object.keys(body).some(key => !['league', 'action'].includes(key)))
      return respond({ ok: false, error: '只接受核對伺服器封存的分鐘預測；不接受傳入球員、預測或賽果。' }, 400);
    const result = await evaluateSoccerMinutesForward({ league: body.league, limit: 2, timeBudgetMs: 18000 });
    return respond({ ok: true, ...result });
  } catch (error) {
    if ([400, 413].includes(error?.status)) return respond({ ok: false, error: '分鐘核對請求無效。' }, error.status);
    return failure();
  }
}
