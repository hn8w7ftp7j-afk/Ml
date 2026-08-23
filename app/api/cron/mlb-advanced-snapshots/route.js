import { NextResponse } from 'next/server';
import {
  buildLeagueGameContext,
  fetchLeagueTaipeiSlate,
  filterLeaguePrestartGames,
  withLeagueProviderTimeout,
} from '../../../../lib/league-provider.js';
import { persistMlbAdvancedSnapshotBestEffort } from '../../../../lib/mlb-advanced-snapshot-store-v2.js';
import { taipeiBoardDate } from '../../../../lib/official-schedule-v1.js';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function authorized(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  return Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const boardDate = taipeiBoardDate(new Date());
  const slate = filterLeaguePrestartGames('MLB', await fetchLeagueTaipeiSlate('MLB', boardDate));
  const results = [];
  for (let index = 0; index < slate.length; index += 2) {
    const batch = slate.slice(index, index + 2);
    const rows = await Promise.all(batch.map(async game => {
      try {
        const context = await withLeagueProviderTimeout('MLB', buildLeagueGameContext('MLB', game), 75000);
        const stored = await persistMlbAdvancedSnapshotBestEffort(game, context);
        return { gamePk: game.gamePk, ...stored };
      } catch (error) {
        return { gamePk: game.gamePk, stored: false, reason: String(error?.message || error).slice(0, 240) };
      }
    }));
    results.push(...rows);
  }
  return NextResponse.json({
    ok: true,
    boardDate,
    scheduled: slate.length,
    stored: results.filter(row => row.stored).length,
    results,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
