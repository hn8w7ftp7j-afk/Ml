import { NextResponse } from 'next/server';
import { collectSoccerMinutesForward } from '../../../../lib/soccer/minutes-forward-collection.js';
import { evaluateSoccerMinutesForward } from '../../../../lib/soccer/minutes-forward-validation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function GET(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  const respond = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return respond({ ok: false, error: 'Unauthorized' }, 401);
  const deadline = Date.now() + 160000, remaining = () => Math.max(0, deadline - Date.now());
  const collection = [], summaries = [], leagues = ['epl','ucl'];
  const unavailable = (league,status) => ({ league,status,persisted:false,accepted:false,formalEligible:false,executable:false });
  // Validate both leagues before collection, so one slow source cannot starve
  // the existing result queue. This is its own budget, not calibration's 180s.
  for (const [i,league] of leagues.entries()) {
    const timeBudgetMs = Math.min(18000, Math.floor(remaining() / (leagues.length - i)));
    if (timeBudgetMs < 1000) { summaries.push(unavailable(league,'BUDGET_DEFERRED')); continue; }
    try {
      const result = await evaluateSoccerMinutesForward({ league, limit: 2, timeBudgetMs });
      const summary = typeof result.status === 'string' ? result : result.summary;
      summaries.push(summary?.league === league ? summary : unavailable(league,'STORAGE_UNAVAILABLE'));
    }
    catch { summaries.push(unavailable(league,'STORAGE_UNAVAILABLE')); }
  }
  for (const [i,league] of leagues.entries()) {
    const timeBudgetMs = Math.min(50000, Math.floor(remaining() / (leagues.length - i)));
    if (timeBudgetMs < 1000) { collection.push(unavailable(league,'BUDGET_DEFERRED')); continue; }
    try { collection.push(await collectSoccerMinutesForward({ league, limit: 1, timeBudgetMs })); }
    catch { collection.push(unavailable(league,'STORAGE_UNAVAILABLE')); }
  }
  const failed = value => !value || value.persisted !== true || ['BUDGET_DEFERRED','STORAGE_UNAVAILABLE','RETRYABLE','PARTIAL'].includes(value.status);
  const ok = [...summaries,...collection].every(value => !failed(value));
  return respond({ ok, collection, summaries, accepted:false,formalEligible:false,executable:false }, ok ? 200 : 503);
}
