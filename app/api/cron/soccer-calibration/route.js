import { NextResponse } from 'next/server';
import { evaluateSoccerCalibrationShadow } from '../../../../lib/soccer/calibration-shadow-validation.js';
import { collectSoccerCalibrationPredictions } from '../../../../lib/soccer/calibration-collection.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

// Keep calibration checks outside the existing settlement cron's 278 s budget.
// All predictions, source URLs and results are recovered from server records.
export async function GET(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  const respond = (body, status = 200) => NextResponse.json(body, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return respond({ ok: false, error: 'Unauthorized' }, 401);

  const summaries = [], collection = [];
  for (const league of ['epl', 'ucl']) {
    try { collection.push(await collectSoccerCalibrationPredictions({ league, limit: 2, timeBudgetMs: 50000 })); }
    catch { collection.push({ league, status: 'STORAGE_UNAVAILABLE', persisted: false, formalEligible: false, executable: false }); }
    try {
      const { summary } = await evaluateSoccerCalibrationShadow({ league, limit: 3 });
      summaries.push(summary);
    } catch {
      // One league's source or storage failure must not stop the other league.
      summaries.push({ league, status: 'STORAGE_UNAVAILABLE', persisted: false,
        accepted: false, formalEligible: false, executable: false });
    }
  }
  const ok = collection.every(summary => summary.persisted === true && summary.status !== 'PARTIAL')
    && summaries.every(summary => summary.persisted === true
      && ['NO_PENDING_CAPTURES', 'EVALUATED', 'PENDING'].includes(summary.status));
  return respond({ ok, summaries, collection, formalEligible: false, executable: false }, ok ? 200 : 503);
}
