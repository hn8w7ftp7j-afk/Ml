import { NextResponse } from 'next/server';
import { fetchTeamStats, fetchWeather } from '../../../lib/mlb';
import { analyzeMarkets } from '../../../lib/analysis';

export async function POST(req) {
  try {
    const { game, markets } = await req.json();
    if (!game?.awayTeamId || !game?.homeTeamId || !Array.isArray(markets) || !markets.length) return NextResponse.json({ ok:false, error:'缺少 game 或 markets' }, { status:400 });
    const season = new Date().getFullYear();
    const [awayStats, homeStats, weather] = await Promise.all([fetchTeamStats(game.awayTeamId, season), fetchTeamStats(game.homeTeamId, season), fetchWeather(game.venueId)]);
    const analysis = analyzeMarkets({ game, markets, awayStats, homeStats, weather });
    return NextResponse.json({ ok:true, game, analysis });
  } catch (error) {
    return NextResponse.json({ ok:false, error:String(error?.message || error) }, { status:500 });
  }
}
