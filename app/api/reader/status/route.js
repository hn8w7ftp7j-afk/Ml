import { NextResponse } from 'next/server';
import { readerCorsHeaders, readerPairingConfigured } from '../../../../lib/reader-auth-v2.js';
import {
  loadReaderSnapshot,
  readerSnapshotStatus,
  READER_FRESH_SECONDS,
  READER_STORE_VERSION,
} from '../../../../lib/reader-store-v2.js';
import { checkRateLimit, rateLimitResponse } from '../../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: readerCorsHeaders(request) });
}

export async function GET(request) {
  const headers = readerCorsHeaders(request);
  const rate = checkRateLimit(request, { id: 'reader-status-v2', limit: 240, windowMs: 10 * 60 * 1000 });
  if (!rate.allowed) {
    const response = rateLimitResponse(rate);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }
  const date = new URL(request.url).searchParams.get('date') || '';
  const snapshot = await loadReaderSnapshot(date);
  const status = readerSnapshotStatus(snapshot);
  return NextResponse.json({
    ok: true,
    pairingConfigured: readerPairingConfigured(),
    storeVersion: READER_STORE_VERSION,
    freshnessTtlSeconds: READER_FRESH_SECONDS,
    ...status,
    boardDate: snapshot?.boardDate || null,
    payloadHash: snapshot?.payloadHash || null,
    rawGameCount: snapshot?.rawGameCount || 0,
    matchedGameCount: snapshot?.matchedGameCount || 0,
    scheduleGameCount: snapshot?.scheduleGameCount || 0,
    observedAt: snapshot?.observedAt || null,
    receivedAt: snapshot?.receivedAt || null,
    readerVersion: snapshot?.readerVersion || null,
    sourceHost: snapshot?.sourceHost || null,
    unmatched: snapshot?.unmatched || [],
  }, { headers });
}
