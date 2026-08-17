import { NextResponse } from 'next/server';
import { taipeiDate } from '../../../lib/mlb.js';
import {
  fetchLeagueTaipeiSlate,
  filterLeaguePrestartGames,
  getLeagueProvider,
} from '../../../lib/league-provider.js';
import { requestedLeagueId } from '../../../lib/leagues.js';
import { checkRateLimit, rateLimitResponse, requireApiAuth, validDateString } from '../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    const rate = checkRateLimit(request, { id: 'league-schedule', limit: 180, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const searchParams = new URL(request.url).searchParams;
    const league = requestedLeagueId(searchParams.get('league'));
    if (!league) {
      return NextResponse.json({ ok: false, code: 'UNKNOWN_LEAGUE', error: '不支援的聯盟' }, { status: 400 });
    }
    const date = searchParams.get('date') || taipeiDate();
    if (!validDateString(date)) {
      return NextResponse.json({ ok: false, error: '日期格式錯誤' }, { status: 400 });
    }
    const provider = getLeagueProvider(league);
    const slate = await fetchLeagueTaipeiSlate(league, date);
    const games = filterLeaguePrestartGames(league, slate);
    return NextResponse.json({
      ok: true,
      league,
      date,
      games,
      provider: provider.scheduleProvider,
      analysisMode: provider.analysisMode,
      betEligible: provider.betEligible,
      providerVersion: provider.version,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error), code: error?.code || undefined }, {
      status: Number(error?.status) || 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
