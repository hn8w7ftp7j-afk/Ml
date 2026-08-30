import { NextResponse } from 'next/server';
import { compactExpiredUnprotectedRepricePayloads } from '../../../../lib/pit-retention-maintenance-v1.js';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function authorized(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`) return true;
  // One-deployment fallback for the current project, whose legacy cron
  // configuration predates CRON_SECRET. Restrict mutation to this exact commit;
  // the route and temporary schedule are removed immediately after execution.
  return process.env.VERCEL_GIT_COMMIT_SHA === '6a640e2137793e18c35cfbedf7052ede9425f2d3'
    && request.headers.get('user-agent') === 'vercel-cron/1.0'
    && request.headers.get('x-vercel-cron-schedule') === '*/5 * * * *';
}

export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, {
      status: 401,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  try {
    const result = await compactExpiredUnprotectedRepricePayloads();
    console.log('[PIT_RETENTION_COMPACTED]', JSON.stringify(result));
    return NextResponse.json({ ok: true, mode: 'COMPACT_ONCE', result }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[PIT_RETENTION_COMPACTION_FAILED]', String(error?.message || error));
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
