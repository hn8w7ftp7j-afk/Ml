import { NextResponse } from 'next/server';
import { fetchLeagueFinalResult, getLeagueProvider, withLeagueProviderTimeout } from '../../../lib/league-provider.js';
import { requestedLeagueId } from '../../../lib/leagues.js';
import { checkRateLimit, positiveInteger, rateLimitResponse, requireApiAuth, validDateString } from '../../../lib/security.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    const rate = checkRateLimit(request, { id: 'mlb-result', limit: 180, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const searchParams = new URL(request.url).searchParams;
    const league = requestedLeagueId(searchParams.get('league'));
    if (!league) {
      return NextResponse.json({ ok: false, code: 'UNKNOWN_LEAGUE', error: '不支援的聯盟' }, { status: 400 });
    }
    const gamePk = positiveInteger(searchParams.get('gamePk'), Number.MAX_SAFE_INTEGER);
    if (!gamePk) return NextResponse.json({ ok: false, error: '缺少或無效的 gamePk' }, { status: 400 });
    const date = searchParams.get('date') || '';
    if (league !== 'MLB' && !validDateString(date)) {
      return NextResponse.json({
        ok: false, code: 'RESULT_DATE_REQUIRED',
        error: `${league} 賽果查詢必須提供 YYYY-MM-DD 日期`,
      }, { status: 400 });
    }
    if (date && !validDateString(date)) {
      return NextResponse.json({ ok: false, error: '日期格式錯誤' }, { status: 400 });
    }
    const result = await withLeagueProviderTimeout(
      league,
      fetchLeagueFinalResult(league, gamePk, { date }),
      15_000,
      '賽果資料取得逾時',
    );
    const provider = getLeagueProvider(league);
    return NextResponse.json({ ok: true, league, betEligible: provider.betEligible, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error), code: error?.code || undefined }, {
      status: Number(error?.status) || 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
