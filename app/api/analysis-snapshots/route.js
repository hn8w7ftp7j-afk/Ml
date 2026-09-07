import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitResponse, requireApiAuth } from '../../../lib/security.js';
import { classifyDatabaseError, isDatabaseError } from '../../../lib/database-error.js';
import { isAnalysisPitIntegrityError, listAnalysisPitComparisonSnapshots, loadAnalysisPitComparisonSnapshot } from '../../../lib/analysis-pit-snapshot-store-v1.js';
import { parseSnapshotDiagnosticQuery, readSnapshotDiagnostics } from '../../../lib/analysis-snapshot-diagnostics-v1.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  const rate = checkRateLimit(request, { id: 'pit-snapshot-diagnostics-v1', limit: 20, windowMs: 600_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  let query;
  try { query = parseSnapshotDiagnosticQuery(new URL(request.url).searchParams); }
  catch (error) { return NextResponse.json({ ok: false, code: 'INVALID_SNAPSHOT_QUERY', error: error.message }, { status: 400, headers }); }
  try {
    const report = await readSnapshotDiagnostics(query, {
      listSnapshots: listAnalysisPitComparisonSnapshots, loadSnapshot: loadAnalysisPitComparisonSnapshot,
    });
    return NextResponse.json({ ok: true, ...report }, { headers });
  } catch (error) {
    if (isDatabaseError(error)) {
      const failure = classifyDatabaseError(error);
      return NextResponse.json({ ok: false, code: failure.code, error: failure.publicMessage },
        { status: failure.status, headers: { ...headers, 'Retry-After': String(failure.retryAfterSeconds) } });
    }
    const integrity = isAnalysisPitIntegrityError(error);
    return NextResponse.json({ ok: false, code: integrity ? 'PIT_INTEGRITY_FAILED' : 'PIT_DIAGNOSTIC_FAILED',
      error: integrity ? '原始快照完整性驗證失敗，無法比較。' : '原始快照診斷暫時無法完成。' }, { status: integrity ? 409 : 500, headers });
  }
}
