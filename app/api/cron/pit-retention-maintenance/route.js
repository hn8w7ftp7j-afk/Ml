import { NextResponse } from 'next/server';
import { planPitRetentionMaintenance } from '../../../../lib/pit-retention-maintenance-v1.js';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function authorized(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  return Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, {
      status: 401,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  try {
    const plan = await planPitRetentionMaintenance();
    console.log('[PIT_RETENTION_PLAN]', JSON.stringify(plan));
    return NextResponse.json({ ok: true, mode: 'PLAN_ONLY', plan }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[PIT_RETENTION_PLAN_FAILED]', String(error?.message || error));
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
