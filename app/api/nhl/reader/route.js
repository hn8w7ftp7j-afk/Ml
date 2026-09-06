import { NextResponse } from 'next/server';
import { bearerToken, verifyReaderToken, readerOriginAllowed, readerCorsHeaders } from '../../../../lib/reader-auth-v2.js';
import { checkRateLimit, readJsonBody, requireApiAuth } from '../../../../lib/security.js';
import { validateNhlCapture, NHL_READER_WAITING_MESSAGE } from '../../../../lib/nhl/reader.js';
import { saveNhlObservation } from '../../../../lib/nhl/store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function OPTIONS(request) { return new Response(null, { status: readerOriginAllowed(request) ? 204 : 403, headers: readerCorsHeaders(request) }); }
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  return NextResponse.json({ ok: true, league: 'NHL', message: NHL_READER_WAITING_MESSAGE, verifiedMarkets: [], executable: false }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request) {
  const headers = readerCorsHeaders(request);
  const respond = (body, status) => NextResponse.json({ ...body, league: 'NHL' }, { status, headers });
  if (!readerOriginAllowed(request)) return respond({ ok: false, error: '不允許的 Reader 來源' }, 403);
  const token = await verifyReaderToken(bearerToken(request));
  if (!token) return respond({ ok: false, error: 'Reader 未配對或授權已過期' }, 401);
  if (request.headers.get('x-device-id') !== token.deviceId) return respond({ ok: false, error: 'Reader 裝置身分不符' }, 403);
  const rate = checkRateLimit(request, { id: 'nhl-reader-capture', limit: 20, windowMs: 60_000 });
  if (!rate.allowed) return respond({ ok: false, error: '請稍後再同步', retryAfter: rate.retryAfter }, 429);
  try {
    const input = await readJsonBody(request, 128_000);
    const capture = validateNhlCapture(input);
    if (!capture.ok) return respond(capture, 422);
    const stored = await saveNhlObservation('READER', capture.payload.boardDate, { ...capture.payload, deviceId: token.deviceId });
    return respond({ ok: true, ...stored, message: NHL_READER_WAITING_MESSAGE, executable: false, marketVerification: 'WAITING_REAL_DATA' }, 200);
  } catch (error) { return respond({ ok: false, error: error.status === 413 ? 'Reader資料過大' : 'NHL Reader來源快照未保存', code: error.code || 'NHL_READER_CAPTURE_FAILED' }, error.status || 503); }
}
