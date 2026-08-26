import { NextResponse } from 'next/server';
import { settlePendingAnalysisDirections } from '../../../../lib/analysis-direction-history-v1.js';

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
    const settlement = await settlePendingAnalysisDirections({
      limitGames: 500,
      concurrency: 4,
      timeBudgetMs: 240_000,
    });
    const failureCount = Array.isArray(settlement?.failures) ? settlement.failures.length : 0;
    const ok = settlement?.stored !== false && failureCount === 0;
    return NextResponse.json({ ok, settlement }, {
      status: ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: String(error?.message || error),
      settlement: null,
    }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
