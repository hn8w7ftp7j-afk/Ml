import { NextResponse } from 'next/server';
import { syncNbaLiveHistory } from '../../../../lib/nba/live-history-service.js';
import { evaluatePendingNbaCaptures } from '../../../../lib/nba/forward-service.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
export async function GET(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  // Independent budgets: model research must not consume the existing bet-
  // settlement cron's time or require someone to open a website tab.
  const run = async task => { try { return await task(); } catch { return { status: 'unavailable' }; } };
  const history = await run(() => syncNbaLiveHistory({ lookbackDays: 3, limit: 18, timeBudgetMs: 45000 }));
  const validation = await run(() => evaluatePendingNbaCaptures({ limit: 50, timeBudgetMs: 35000 }));
  return NextResponse.json({ ok: history.status !== 'unavailable' && validation.status !== 'unavailable', history, validation,
    executable: false, promotionEligible: false }, { headers: { 'Cache-Control': 'no-store' } });
}
