import { NextResponse } from 'next/server';
import { buildGameContext } from '../../../lib/mlb.js';
import { analyzeMarkets } from '../../../lib/analysis.js';
import { applyExpertAssessment, buildExpertAssessment } from '../../../lib/expert.js';
import { applyFinalScoreAssessment, buildFinalScoreAssessment } from '../../../lib/final-scorer.js';
import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';
import {
  checkRateLimit,
  cleanText,
  originErrorResponse,
  positiveInteger,
  rateLimitResponse,
  readJsonBody,
  requireApiAuth,
  validateSameOrigin,
} from '../../../lib/security.js';

export const runtime = 'nodejs';
export const maxDuration = 150;
export const dynamic = 'force-dynamic';

function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeGame(game) {
  const safe = {
    gamePk: positiveInteger(game?.gamePk),
    gameDate: cleanText(game?.gameDate, 40),
    officialDate: cleanText(game?.officialDate, 20),
    status: cleanText(game?.status, 60),
    statusEnglish: cleanText(game?.statusEnglish, 60),
    statusCode: cleanText(game?.statusCode, 10),
    doubleHeader: cleanText(game?.doubleHeader, 10),
    gameNumber: positiveInteger(game?.gameNumber) || 1,
    scheduledInnings: positiveInteger(game?.scheduledInnings) || 9,
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

function sanitizeMarketRows(rows, maximum = 16) {
  return (Array.isArray(rows) ? rows : []).slice(0, maximum).map(row => ({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '',
    pick: cleanText(row?.pick, 120),
    water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated),
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
  })).filter(row => row.market);
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request);
    if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'analyze-v7-0-2', limit: 35, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);

    const body = await readJsonBody(request, 262144);
    const game = sanitizeGame(body.game);
    if (!game || !Array.isArray(body.markets)) {
      return NextResponse.json({ ok: false, error: '缺少或無效的賽事／盤口資料' }, { status: 400 });
    }

    const markets = sanitizeMarketRows(body.markets, 8);
    const previousMarkets = sanitizeMarketRows(body.previousMarkets, 16);
    const errors = [];
    for (const name of MARKET_ORDER) {
      const pair = markets.filter(row => row.market === name).map(row => ({ pick: row.pick, water: row.water }));
      if (!marketIsOpen(pair)) continue;
      errors.push(...validateMarketPair(name, pair).map(error => `${name}：${error}`));
    }
    if (errors.length) {
      return NextResponse.json({ ok: false, error: `已開盤市場資料未完整：${[...new Set(errors)].join('、')}` }, { status: 400 });
    }

    const activeMarkets = markets.filter(row => row.pick);
    if (!activeMarkets.length) {
      return NextResponse.json({ ok: false, error: '目前沒有任何已開盤市場可分析' }, { status: 400 });
    }

    const settings = {
      rebateRate: Math.max(0, Math.min(0.1, Number(body.settings?.rebateRate) || 0.015)),
      candidateThreshold: Math.max(1, Math.min(9.4, Number(body.settings?.candidateThreshold) || 7.2)),
      strongestThreshold: Math.max(1, Math.min(9.4, Number(body.settings?.strongestThreshold) || 8.5)),
      simulationsPerScenario: Math.max(500, Math.min(4000, Math.round(Number(body.settings?.simulationsPerScenario) || 1800))),
      expertMode: ['auto', 'off', 'required'].includes(body.settings?.expertMode) ? body.settings.expertMode : 'auto',
    };

    const context = await Promise.race([
      buildGameContext(game),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MLB 資料取得逾時，請稍後重試')), 30000)),
    ]);
    const expertAssessment = await buildExpertAssessment({
      context,
      markets: activeMarkets,
      mode: settings.expertMode,
      timeoutMs: 14000,
    });
    const enrichedContext = applyExpertAssessment(context, expertAssessment);
    const preliminaryAnalysis = analyzeMarkets({ context: enrichedContext, markets: activeMarkets, previousMarkets, settings });
    const finalScoreAssessment = await buildFinalScoreAssessment({
      context: enrichedContext,
      analysis: preliminaryAnalysis,
      settings,
      timeoutMs: 70000,
    });
    const analysis = applyFinalScoreAssessment({
      analysis: preliminaryAnalysis,
      assessment: finalScoreAssessment,
      settings,
    });

    return NextResponse.json({
      ok: true,
      game,
      context: enrichedContext,
      expertAssessment,
      finalScoreAssessment,
      analysis,
      openMarkets: [...new Set(activeMarkets.map(row => row.market))],
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const headers = { 'Cache-Control': 'no-store' };
    if (status === 429) headers['Retry-After'] = String(Math.max(15, Math.ceil(Number(error?.retryAfterMs || 30000) / 1000)));
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status, headers });
  }
}
