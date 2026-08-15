import { NextResponse } from 'next/server';
import { LEAGUE_REGISTRY_VERSION, publicLeagueRegistry } from '../../../lib/leagues.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    version: LEAGUE_REGISTRY_VERSION,
    leagues: publicLeagueRegistry(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

