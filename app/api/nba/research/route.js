import { NextResponse } from 'next/server';
import { requireApiAuth } from '../../../../lib/security.js';
import evidence from '../../../../docs/nba-shadow-cle-2026-evidence.json';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  return NextResponse.json({ league: 'NBA', generatedAt: evidence.generatedAt, team: evidence.team, season: evidence.season, seasonType: evidence.seasonType, failures: evidence.failures, research: evidence.research, sourceCount: evidence.sources.length, coverage: 'one_team_one_season_not_leaguewide', probabilityCalibration: 'not_evaluated_point_forecasts_only' }, { headers: { 'Cache-Control': 'no-store' } });
}
