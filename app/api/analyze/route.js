import { NextResponse } from 'next/server';
import { buildGameContext } from '../../../lib/mlb.js';
import { analyzeMarkets, MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';
import { finalizeDeterministicAnalysis, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer.js';
import { SCORE_FORMULA_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION } from '../../../lib/taiwan-settlement-v9.js';
import { buildSnapshotFingerprints, DATA_VERSION } from '../../../lib/snapshot-v9.js';
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
export const maxDuration = 90;
export const dynamic = 'force-dynamic';

const responseCache = globalThis.__MLB_V9_ANALYSIS_CACHE__ || new Map();
globalThis.__MLB_V9_ANALYSIS_CACHE__ = responseCache;

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

function gameAlreadyStarted(game) {
  const text = `${game?.statusCode || ''} ${game?.statusEnglish || ''} ${game?.status || ''}`.toLowerCase();
  return /in progress|game over|final|completed|live/.test(text) || ['I', 'F', 'O'].includes(String(game?.statusCode || '').toUpperCase());
}

function cleanVerification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sources = (Array.isArray(value.sources) ? value.sources : []).slice(0, 4).map(source => ({
    provider: cleanText(source?.provider, 80),
    independentGroup: cleanText(source?.independentGroup, 80),
    observedAt: cleanText(source?.observedAt, 40),
    contractKey: cleanText(source?.contractKey, 160),
  })).filter(source => source.provider && source.independentGroup && source.observedAt && source.contractKey);
  const groups = new Set(sources.map(source => source.independentGroup));
  return {
    sources,
    verified: value.verified === true && sources.length >= 2 && groups.size >= 2,
    policyStatus: cleanText(value.policyStatus, 80) || 'MANUAL_EVIDENCE_ONLY',
  };
}

function sanitizeMarketRows(rows, maximum = 16) {
  return (Array.isArray(rows) ? rows : []).slice(0, maximum).map(row => ({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '',
    pick: cleanText(row?.pick, 120),
    water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated),
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    lineAsOf: cleanText(row?.lineAsOf, 40),
    executable: row?.executable !== false,
    marketVerification: cleanVerification(row?.marketVerification),
  })).filter(row => row.market);
}

function cacheSet(key, value) {
  responseCache.set(key, value);
  while (responseCache.size > 100) responseCache.delete(responseCache.keys().next().value);
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'analyze-v9-deterministic', limit: 60, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);

    const body = await readJsonBody(request, 350000);
    const game = sanitizeGame(body.game);
    if (!game || !Array.isArray(body.markets)) {
      return NextResponse.json({ ok: false, error: '缺少或無效的賽事／盤口資料' }, { status: 400 });
    }
    if (gameAlreadyStarted(game)) {
      return NextResponse.json({ ok: false, error: '比賽已開打或結束｜賽前模型停止評分' }, { status: 409 });
    }

    const markets = sanitizeMarketRows(body.markets, 12);
    const previousMarkets = sanitizeMarketRows(body.previousMarkets, 24);
    const errors = [];
    for (const name of MARKET_ORDER) {
      const pair = markets.filter(row => row.market === name);
      if (!marketIsOpen(pair)) continue;
      errors.push(...validateMarketPair(name, pair).map(error => `${name}：${error}`));
    }
    if (errors.length) {
      return NextResponse.json({ ok: false, error: `⛔ QA未通過｜不評分｜不下注：${[...new Set(errors)].join('、')}` }, { status: 400 });
    }
    const activeMarkets = markets.filter(row => row.pick);
    if (!activeMarkets.length) return NextResponse.json({ ok: false, error: '目前沒有任何已開盤市場可分析' }, { status: 400 });

    const settings = {
      rebateRate: Math.max(0, Math.min(0.1, Number(body.settings?.rebateRate) || 0.015)),
      candidateThreshold: 7.2,
      strongestThreshold: 8.5,
      simulationsPerScenario: Math.max(500, Math.min(4000, Math.round(Number(body.settings?.simulationsPerScenario) || 1800))),
      expertMode: 'off',
    };

    const context = await Promise.race([
      buildGameContext(game),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MLB資料取得逾時，請稍後重試')), 30000)),
    ]);
    const preliminary = analyzeMarkets({ context, markets: activeMarkets, previousMarkets, settings });
    const analysis = finalizeDeterministicAnalysis({ analysis: preliminary, game, settings });
    const versions = {
      modelVersion: MODEL_VERSION,
      rulesVersion: RULES_VERSION,
      dataVersion: DATA_VERSION,
      scoreFormulaVersion: SCORE_FORMULA_VERSION,
      settlementRuleVersion: SETTLEMENT_RULE_VERSION,
      uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
    };
    const fingerprints = buildSnapshotFingerprints({ context, markets: activeMarkets, versions });
    const cached = responseCache.get(fingerprints.inputHash);
    if (cached) return NextResponse.json(cached, { headers: { 'Cache-Control': 'no-store', 'X-Analysis-Cache': 'HIT' } });

    const analysisAsOf = new Date().toISOString();
    const lineAsOf = activeMarkets.map(row => row.lineAsOf).filter(Boolean).sort().at(-1) || analysisAsOf;
    const finalized = {
      ...analysis,
      ...fingerprints,
      analysisType: 'FULL',
      dataVersion: DATA_VERSION,
      dataAsOf: context.fetchedAt || analysisAsOf,
      lineAsOf,
      analysisAsOf,
      snapshotId: fingerprints.inputHash,
    };
    const payload = {
      ok: true,
      game,
      context,
      analysis: finalized,
      repriceSnapshot: {
        frozenContext: context,
        coreFingerprint: fingerprints.coreFingerprint,
        priceFingerprint: fingerprints.priceFingerprint,
        inputHash: fingerprints.inputHash,
        distributionId: finalized.distributionId,
        dataAsOf: finalized.dataAsOf,
        simulationsPerScenario: finalized.scenarioSummary?.simulationsPerScenario,
        versions,
      },
      openMarkets: [...new Set(activeMarkets.map(row => row.market))],
    };
    cacheSet(fingerprints.inputHash, payload);
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store', 'X-Analysis-Cache': 'MISS' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, {
      status: Number(error?.status) || 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
