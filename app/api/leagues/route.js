import { NextResponse } from 'next/server';
import { LEAGUE_REGISTRY_VERSION, publicLeagueRegistry } from '../../../lib/leagues.js';
import { publicSoccerLeagues, SOCCER_DATA_VERSION } from '../../../lib/soccer/contracts.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    version: LEAGUE_REGISTRY_VERSION,
    leagues: publicLeagueRegistry(),
    soccerVersion: SOCCER_DATA_VERSION,
    soccerLeagues: publicSoccerLeagues(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

