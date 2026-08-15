import { NextResponse } from 'next/server';
import { fetchFinalResult } from '../../../lib/mlb.js';
import { leagueCanAnalyze, leagueConfig, requestedLeagueId } from '../../../lib/leagues.js';
import { checkRateLimit, positiveInteger, rateLimitResponse, requireApiAuth } from '../../../lib/security.js';

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
    if (!leagueCanAnalyze(league)) {
      const config = leagueConfig(league);
      return NextResponse.json({
        ok: false,
        code: 'LEAGUE_NOT_READY',
        league,
        error: `${config.label}賽果來源尚未完成正式驗證`,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    const gamePk = positiveInteger(searchParams.get('gamePk'));
    if (!gamePk) return NextResponse.json({ ok: false, error: '缺少或無效的 gamePk' }, { status: 400 });
    const result = await Promise.race([
      fetchFinalResult(gamePk),
      new Promise((_, reject) => setTimeout(() => reject(new Error('賽果資料取得逾時')), 15000)),
    ]);
    return NextResponse.json({ ok: true, league, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
