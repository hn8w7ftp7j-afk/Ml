import { NextResponse } from 'next/server';
import { buildGameContext } from '../../../lib/mlb.js';
import { analyzeMarkets } from '../../../lib/analysis.js';
import { MARKET_ORDER, validateMarketPair, marketIsOpen } from '../../../lib/markets.js';
import { checkRateLimit, cleanText, originErrorResponse, positiveInteger, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin } from '../../../lib/security.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function sanitizeGame(game) {
  const safe = {
    gamePk: positiveInteger(game?.gamePk),
    gameDate: cleanText(game?.gameDate, 40),
    status: cleanText(game?.status, 60),
    statusEnglish: cleanText(game?.statusEnglish, 60),
    away: cleanText(game?.away, 80),
    home: cleanText(game?.home, 80),
    awayEnglish: cleanText(game?.awayEnglish, 80),
    homeEnglish: cleanText(game?.homeEnglish, 80),
    venue: cleanText(game?.venue, 100),
    venueEnglish: cleanText(game?.venueEnglish, 100),
    awayTeamId: positiveInteger(game?.awayTeamId),
    homeTeamId: positiveInteger(game?.homeTeamId),
    venueId: positiveInteger(game?.venueId),
    awayProbableId: positiveInteger(game?.awayProbableId),
    homeProbableId: positiveInteger(game?.homeProbableId),
    awayProbable: cleanText(game?.awayProbable, 80),
    homeProbable: cleanText(game?.homeProbable, 80),
  };
  return safe.gamePk && safe.awayTeamId && safe.homeTeamId && safe.away && safe.home ? safe : null;
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'analyze', limit: 40, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 196608);
    const game = sanitizeGame(body.game);
    if (!game || !Array.isArray(body.markets)) return NextResponse.json({ ok: false, error: '缺少或無效的賽事／盤口資料' }, { status: 400 });
    const markets = body.markets.slice(0, 8).map(row => ({
      market: MARKET_ORDER.includes(row?.market) ? row.market : '',
      pick: cleanText(row?.pick, 120),
      water: Number(row?.water),
      confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    })).filter(row => row.market);
    const errors = [];
    for (const name of MARKET_ORDER) {
      const rows = markets.filter(row => row.market === name);
      const pair = rows.map(row => ({ pick: row.pick, water: row.water }));
      if (!marketIsOpen(pair)) continue;
      errors.push(...validateMarketPair(name, pair).map(error => `${name}：${error}`));
    }
    if (errors.length) return NextResponse.json({ ok: false, error: `已開盤市場資料未完整：${[...new Set(errors)].join('、')}` }, { status: 400 });
    const activeMarkets = markets.filter(row => row.pick);
    if (!activeMarkets.length) return NextResponse.json({ ok: false, error: '目前沒有任何已開盤市場可分析' }, { status: 400 });
    const settings = {
      rebateRate: Math.max(0, Math.min(0.1, Number(body.settings?.rebateRate) || 0.015)),
      candidateThreshold: Math.max(1, Math.min(9.6, Number(body.settings?.candidateThreshold) || 7.2)),
      strongestThreshold: Math.max(1, Math.min(9.6, Number(body.settings?.strongestThreshold) || 8.5)),
    };
    const context = await Promise.race([
      buildGameContext(game),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MLB 資料取得逾時，請稍後重試')), 45000)),
    ]);
    const analysis = analyzeMarkets({ context, markets: activeMarkets, settings });
    return NextResponse.json({ ok: true, game, context, analysis, openMarkets: [...new Set(activeMarkets.map(row => row.market))] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: Number(error?.status) || 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
