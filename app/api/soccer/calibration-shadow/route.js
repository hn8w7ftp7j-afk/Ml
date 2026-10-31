import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit, rateLimitResponse, validateSameOrigin, originErrorResponse, readJsonBody } from '../../../../lib/security.js';
import { soccerLeague } from '../../../../lib/soccer/contracts.js';
import { readSoccerCalibrationShadowReport, evaluateSoccerCalibrationShadow } from '../../../../lib/soccer/calibration-shadow-validation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = () => response({ ok: false, error: '校準預測保存或賽果紀錄暫時無法核對，目前筆數未知。', formalEligible: false, executable: false }, 503);
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'soccer-calibration-shadow-read', limit: 60, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  const params = new URL(request.url).searchParams, league = soccerLeague(params.get('league'))?.id;
  if (!league || [...params.keys()].some(key => key !== 'league' || params.getAll(key).length !== 1))
    return response({ ok: false, error: '校準保存查詢只接受英超或歐冠聯盟。' }, 400);
  try { return response({ ok: true, report: await readSoccerCalibrationShadowReport(league) }); }
  catch { return failure(); }
}
export async function POST(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'soccer-calibration-shadow-evaluate', limit: 4, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 1000), league = soccerLeague(body?.league)?.id;
    if (!league || body?.action !== 'evaluate' || Object.keys(body).some(key => !['league', 'action'].includes(key)))
      return response({ ok: false, error: '只接受核對伺服器已保存的校準預測，不接受傳入預測、來源或賽果。' }, 400);
    const { summary } = await evaluateSoccerCalibrationShadow({ league, limit: 3 });
    if (summary.status === 'STORAGE_UNAVAILABLE') return failure();
    return response({ ok: true, summary });
  } catch (error) { return error.status === 400 || error.status === 413 ? response({ ok: false, error: '校準核對請求無效。' }, error.status) : failure(); }
}
