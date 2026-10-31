import { NextResponse } from 'next/server';
import { evaluateSoccerCalibrationShadow } from '../../../../lib/soccer/calibration-shadow-validation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

// Keep calibration checks outside the existing settlement cron's 278 s budget.
// All predictions, source URLs and results are recovered from server records.
export async function GET(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  const respond = (body, status = 200) => NextResponse.json(body, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return respond({ ok: false, error: 'Unauthorized' }, 401);

  const summaries = [];
  for (const league of ['epl', 'ucl']) {
    try {
      const { summary } = await evaluateSoccerCalibrationShadow({ league, limit: 3 });
      summaries.push(summary);
    } catch {
      // One league's source or storage failure must not stop the other league.
      summaries.push({ league, status: 'STORAGE_UNAVAILABLE', persisted: false,
        accepted: false, formalEligible: false, executable: false });
    }
  }
  const ok = summaries.every(summary => summary.persisted === true);
  return respond({ ok, summaries, formalEligible: false, executable: false }, ok ? 200 : 503);
}
