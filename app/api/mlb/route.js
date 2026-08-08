import { NextResponse } from 'next/server';
import { fetchSchedule, taipeiDate } from '../../../lib/mlb.js';
import { checkRateLimit, rateLimitResponse, requireApiAuth, validDateString } from '../../../lib/security.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    const rate = checkRateLimit(request, { id: 'mlb-schedule', limit: 180, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const date = new URL(request.url).searchParams.get('date') || taipeiDate();
    if (!validDateString(date)) return NextResponse.json({ ok: false, error: '日期格式錯誤' }, { status: 400 });
    const games = await Promise.race([
      fetchSchedule(date),
      new Promise((_, reject) => setTimeout(() => reject(new Error('賽程資料取得逾時')), 15000)),
    ]);
    return NextResponse.json({ ok: true, date, games }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
