import { NextResponse } from 'next/server';
import { bearerToken, readerCorsHeaders, readerOriginAllowed, verifyReaderToken } from '../../../../lib/reader-auth-v2.js';
import { checkRateLimit, readJsonBody, requireApiAuth } from '../../../../lib/security.js';
import { saveReaderSeenCapture, listReaderSeenCaptures, parseReaderSeenCaptureQuery } from '../../../../lib/reader-seen-capture.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const response = (request, body, status = 200) => NextResponse.json(body, { status, headers: readerCorsHeaders(request) });
const reject = (request, code, status) => response(request, { ok: false, durable: false, archiveOnly: true,
  currentBoardUpdated: false, historicalAvailabilityVerified: false, executable: false, coverageComplete: false, code,
  evidenceStatus: 'NOT_SAVED', error: status >= 500 ? '原始盤面尚未確認保存，Reader 會保留並重試' : '原始盤面未保存，Reader 會保留並顯示原因' }, status);
export async function OPTIONS(request) {
  return new Response(null, { status: readerOriginAllowed(request) ? 204 : 403, headers: readerCorsHeaders(request) });
}
export async function POST(request) {
  if (!readerOriginAllowed(request)) return reject(request, 'READER_SEEN_CAPTURE_ORIGIN_FORBIDDEN', 403);
  try {
    const token = await verifyReaderToken(bearerToken(request));
    if (!token || request.headers.get('x-device-id') !== token.deviceId) return reject(request, 'READER_SEEN_CAPTURE_AUTH_INVALID', 401);
    if (!checkRateLimit(request, { id: `reader-seen-captures-write:${token.deviceId}`, limit: 1200, windowMs: 600_000 }).allowed)
      return reject(request, 'READER_SEEN_CAPTURE_RATE_LIMIT', 429);
    const input = await readJsonBody(request, 650_000);
    const saved = await saveReaderSeenCapture(input, { deviceId: token.deviceId,
      headerVersion: request.headers.get('x-reader-version'), now: Date.now() });
    return response(request, saved);
  } catch (cause) {
    const status = [400, 401, 404, 409, 413, 422, 426, 429].includes(cause?.status) ? cause.status : 503;
    const code = /^READER_SEEN_CAPTURE_[A-Z0-9_]+$/.test(cause?.code || '') ? cause.code : 'READER_SEEN_CAPTURE_SAVE_FAILED';
    console.warn('[READER_SEEN_CAPTURE_REJECTED]', { code, status });
    return reject(request, code, status);
  }
}
export async function GET(request) {
  if (!readerOriginAllowed(request)) return reject(request, 'READER_SEEN_CAPTURE_ORIGIN_FORBIDDEN', 403);
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!checkRateLimit(request, { id: 'reader-seen-captures-read', limit: 120, windowMs: 600_000 }).allowed)
    return reject(request, 'READER_SEEN_CAPTURE_RATE_LIMIT', 429);
  try {
    const query = parseReaderSeenCaptureQuery(new URL(request.url).searchParams);
    return response(request, await listReaderSeenCaptures(query));
  } catch (cause) {
    const status = [400, 404].includes(cause?.status) ? cause.status : 503;
    const code = /^READER_SEEN_CAPTURE_[A-Z0-9_]+$/.test(cause?.code || '') ? cause.code : 'READER_SEEN_CAPTURE_READ_FAILED';
    return reject(request, code, status);
  }
}
