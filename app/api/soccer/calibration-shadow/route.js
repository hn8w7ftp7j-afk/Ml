import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit, rateLimitResponse, validateSameOrigin, originErrorResponse, readJsonBody } from '../../../../lib/security.js';
import { soccerLeague } from '../../../../lib/soccer/contracts.js';
import { readSoccerCalibrationShadowReport, evaluateSoccerCalibrationShadow } from '../../../../lib/soccer/calibration-shadow-validation.js';
import { recordSoccerCalibrationFailure } from '../../../../lib/soccer/calibration-diagnostics.js';
import { collectSoccerCalibrationPredictions } from '../../../../lib/soccer/calibration-collection.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = () => response({ ok: false, error: '校準預測保存或賽果紀錄暫時無法核對，目前筆數未知。', formalEligible: false, executable: false }, 503);
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'soccer-calibration-shadow-read', limit: 60, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  const params = new URL(request.url).searchParams, league = soccerLeague(params.get('league'))?.id;
  const paged=params.get('page') === '1';
  if (!league || [...params.keys()].some(key => !['league','page','afterSequence','revision'].includes(key) || params.getAll(key).length !== 1)
    || params.has('page') && !paged || !paged && (params.has('afterSequence') || params.has('revision'))
    || paged && (!/^(?:0|[1-9]\d{0,17})$/.test(params.get('afterSequence') ?? '0')
      || params.has('revision') && !/^[a-f0-9]{64}$/.test(params.get('revision'))
      || (params.get('afterSequence') ?? '0') !== '0' && !params.has('revision')))
    return response({ ok: false, error: '校準保存查詢只接受英超或歐冠聯盟。' }, 400);
  try { return response({ ok: true, report: await readSoccerCalibrationShadowReport(league, {}, paged
    ? { afterSequence: params.get('afterSequence') ?? '0', revision: params.get('revision') } : null) }); }
  catch (error) {
    if (error?.status === 409) return response({ok:false, code:'CALIBRATION_HISTORY_CHANGED_DURING_READ',error:'核對期間有新紀錄，正在重新讀取完整範圍。'},409);
    recordSoccerCalibrationFailure('read', error); return failure();
  }
}
export async function POST(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'soccer-calibration-shadow-evaluate', limit: 4, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 1000), league = soccerLeague(body?.league)?.id;
    if (!league || !['evaluate', 'collect'].includes(body?.action) || Object.keys(body).some(key => !['league', 'action'].includes(key)))
      return response({ ok: false, error: '只接受核對伺服器已保存的校準預測，不接受傳入預測、來源或賽果。' }, 400);
    if (body.action === 'collect') {
      const summary = await collectSoccerCalibrationPredictions({ league, limit: 2, timeBudgetMs: 50000 });
      return response({ ok: true, summary });
    }
    const { summary } = await evaluateSoccerCalibrationShadow({ league, limit: 3 });
    if (summary.status === 'STORAGE_UNAVAILABLE') return failure();
    return response({ ok: true, summary });
  } catch (error) {
    if (error?.status === 400 || error?.status === 413) return response({ ok: false, error: '校準核對請求無效。' }, error.status);
    recordSoccerCalibrationFailure('evaluate', error); return failure();
  }
}
