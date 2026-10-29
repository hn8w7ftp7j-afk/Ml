import { NextResponse } from 'next/server';
import { bearerToken, readerCorsHeaders, readerOriginAllowed, verifyReaderToken } from '../../../../lib/reader-auth-v2.js';
import { checkRateLimit, readJsonBody, requireApiAuth } from '../../../../lib/security.js';
import { saveReaderCaptureArchive, listReaderCaptureArchives } from '../../../../lib/reader-capture-archive.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const response = (request, body, status = 200) => NextResponse.json(body, { status, headers: readerCorsHeaders(request) });
const rejected = (request, code, status) => response(request, { ok: false, durable: false, archiveOnly: true,
  currentBoardUpdated: false, historicalAvailabilityVerified: false, executable: false, code,
  error: status >= 500 ? '盤口補傳尚未確認保存，Reader 會保留並重試' : '盤口補傳核對未通過' }, status);
export async function OPTIONS(request) {
  return new Response(null, { status: readerOriginAllowed(request) ? 204 : 403, headers: readerCorsHeaders(request) });
}
export async function POST(request) {
  if (!readerOriginAllowed(request)) return rejected(request, 'READER_ARCHIVE_ORIGIN_FORBIDDEN', 403);
  try {
    const token = await verifyReaderToken(bearerToken(request));
    if (!token || request.headers.get('x-device-id') !== token.deviceId) return rejected(request, 'READER_ARCHIVE_AUTH_INVALID', 401);
    const rate = checkRateLimit(request, { id: 'reader-archive-write', limit: 360, windowMs: 600_000 });
    if (!rate.allowed) return rejected(request, 'READER_ARCHIVE_RATE_LIMIT', 429);
    const body = await readJsonBody(request, 600_000);
    const saved = await saveReaderCaptureArchive(body, { deviceId: token.deviceId,
      headerVersion: request.headers.get('x-reader-version'), now: Date.now() });
    return response(request, saved);
  } catch (error) {
    const status = [400, 401, 409, 413, 422, 426, 429].includes(error?.status) ? error.status : 503;
    const code = /^READER_ARCHIVE_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'READER_ARCHIVE_SAVE_FAILED';
    console.warn('[READER_ARCHIVE_REJECTED]', { code, status });
    return rejected(request, code, status);
  }
}
export async function GET(request) {
  if (!readerOriginAllowed(request)) return rejected(request, 'READER_ARCHIVE_ORIGIN_FORBIDDEN', 403);
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!checkRateLimit(request, { id: 'reader-archive-summary', limit: 120, windowMs: 600_000 }).allowed)
    return rejected(request, 'READER_ARCHIVE_RATE_LIMIT', 429);
  if ([...new URL(request.url).searchParams.keys()].length) return rejected(request, 'READER_ARCHIVE_QUERY_INVALID', 400);
  try { return response(request, await listReaderCaptureArchives()); }
  catch { return rejected(request, 'READER_ARCHIVE_SUMMARY_UNAVAILABLE', 503); }
}
