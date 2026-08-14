import { NextResponse } from 'next/server';
import {
  readerCorsHeaders,
  readerOriginAllowed,
  readerPairingConfigured,
} from '../../../../lib/reader-auth-v2.js';
import {
  loadReaderSnapshot,
  readerSnapshotPublicView,
  READER_FRESH_SECONDS,
  READER_STORE_VERSION,
} from '../../../../lib/reader-store-v2.js';
import { readerSnapshotIsComplete } from '../../../../lib/tai888-reader-parser-v2.js';
import { checkRateLimit, rateLimitResponse, validDateString } from '../../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  const headers = readerCorsHeaders(request);
  if (!readerOriginAllowed(request)) return new Response(null, { status: 403, headers });
  return new Response(null, { status: 204, headers });
}

export async function GET(request) {
  const headers = readerCorsHeaders(request);
  if (!readerOriginAllowed(request)) {
    return NextResponse.json({ ok: false, error: '不允許的 Reader 請求來源' }, { status: 403, headers });
  }
  const rate = checkRateLimit(request, { id: 'reader-status-v2', limit: 240, windowMs: 10 * 60 * 1000 });
  if (!rate.allowed) {
    const response = rateLimitResponse(rate);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }
  const date = new URL(request.url).searchParams.get('date') || '';
  if (date && !validDateString(date)) {
    return NextResponse.json({ ok: false, error: 'Reader 查詢日期格式錯誤' }, { status: 400, headers });
  }
  const snapshot = await loadReaderSnapshot(date);
  const complete = readerSnapshotIsComplete(snapshot);
  const publicView = readerSnapshotPublicView(snapshot, { complete });
  return NextResponse.json({
    ok: true,
    pairingConfigured: readerPairingConfigured(),
    storeVersion: READER_STORE_VERSION,
    freshnessTtlSeconds: READER_FRESH_SECONDS,
    ...publicView,
  }, { headers: { ...headers, 'Cache-Control': 'no-store' } });
}
