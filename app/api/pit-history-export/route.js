import { NextResponse } from 'next/server';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { requireApiAuth, checkRateLimit, rateLimitResponse } from '../../../lib/security.js';
import { parseHistorySnapshotIds, exportHistorySnapshot } from '../../../lib/pit-history-export.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  let scopes;
  try { scopes = parseHistorySnapshotIds(new URL(request.url).searchParams.get('snapshotIds')); }
  catch { return NextResponse.json({ ok: false, code: 'INVALID_SNAPSHOT_BATCH' }, { status: 400, headers }); }
  const rate = checkRateLimit(request, { id: 'pit-history-export', limit: 30, windowMs: 600000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  const results = [];
  for (const scope of scopes) {
    try { results.push({ snapshotId: scope.snapshotId, ok: true, ...await exportHistorySnapshot(scope) }); }
    catch { results.push({ snapshotId: scope.snapshotId, ok: false, code: 'SNAPSHOT_READ_OR_INTEGRITY_FAILED' }); }
  }
  const raw = Buffer.from(JSON.stringify({ schema: 'pit-history-export-v1', results, productionWrites: false }));
  const payload = gzipSync(raw).toString('base64');
  if (payload.length > 2800000) return NextResponse.json({ ok: false, code: 'EXPORT_BATCH_TOO_LARGE', message: '請減少每批快照數量。' }, { status: 413, headers });
  return NextResponse.json({ ok: true, encoding: 'gzip-base64', sha256: createHash('sha256').update(raw).digest('hex'), rawBytes: raw.length, payload }, { headers });
}
