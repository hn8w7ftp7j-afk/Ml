import { NextResponse } from 'next/server';
import { taipeiDate } from '../../../lib/mlb.js';
import { fetchOfficialTaipeiSlate, officialPrestartSlate } from '../../../lib/official-schedule-v1.js';
import { checkRateLimit, rateLimitResponse, requireApiAuth, validDateString } from '../../../lib/security.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    const rate = checkRateLimit(request, { id: 'mlb-schedule', limit: 180, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const date = new URL(request.url).searchParams.get('date') || taipeiDate();
    if (!validDateString(date)) return NextResponse.json({ ok: false, error: '日期格式錯誤' }, { status: 400 });
    // The UI date is a Taipei board date, while MLB's `date` query is an
    // official/local-calendar date. Resolve the same strict +/-1-day Taipei
    // slate used by Reader ingest, credit lines, reference lines and analyze.
    const games = officialPrestartSlate(await fetchOfficialTaipeiSlate(date));
    return NextResponse.json({ ok: true, date, games }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, {
      status: Number(error?.status) || 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
