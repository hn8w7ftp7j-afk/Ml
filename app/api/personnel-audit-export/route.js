import { NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../../../lib/database-url.js';
import { requireApiAuth, checkRateLimit, rateLimitResponse } from '../../../lib/security.js';
import { decodeAnalysisPitPayload } from '../../../lib/analysis-pit-snapshot-store-v1.js';
import { parsePersonnelAuditQuery, buildPersonnelAuditPage } from '../../../lib/personnel-audit-export.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export async function GET(request) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  const rate = checkRateLimit(request, { id: 'personnel-audit-export', limit: 120, windowMs: 600000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  let query;
  try { query = parsePersonnelAuditQuery(new URL(request.url).searchParams); }
  catch { return NextResponse.json({ ok: false, code: 'INVALID_QUERY' }, { status: 400, headers }); }
  try {
    const url = durableDatabaseUrl();
    if (!url) throw new Error('DATABASE_NOT_CONFIGURED');
    const sql = neon(url);
    // SELECT only. No ensureSchema, source hydration, model run or persistence.
    const rows = await sql`
      SELECT snapshot_id, league_id, external_game_id, game_identity, game_start,
             data_as_of, analysis_as_of, created_at, analysis_type, parent_snapshot_id,
             input_hash, core_fingerprint, model_version, versions, provider_timestamps,
             frozen_context_payload, market_analysis_payload
      FROM baseball_analysis_pit_snapshots
      WHERE created_at <= ${query.until}::timestamptz
        AND snapshot_id > ${query.after} AND analysis_type = 'FULL'
      ORDER BY snapshot_id LIMIT ${query.limit + 1}
    `;
    const packed = buildPersonnelAuditPage(rows, query, { decode: decodeAnalysisPitPayload });
    return NextResponse.json(packed, { headers });
  } catch {
    return NextResponse.json({ ok: false, code: 'PERSONNEL_EXPORT_READ_FAILED' }, { status: 503, headers });
  }
}
