import { NextResponse } from 'next/server';
import {
  buildDistributionSnapshot,
  enforceAnalysisModeSafety,
  evaluateMarketsFromDistribution,
  MODEL_VERSION,
  RULES_VERSION,
} from '../../../lib/analysis-v11.js';
import { finalizeDeterministicAnalysis, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer-v10.js';
import { SCORE_FORMULA_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION, TAIWAN_CREDIT_REBATE_RATE } from '../../../lib/taiwan-settlement-v9.js';
import { buildSnapshotFingerprints, DATA_VERSION } from '../../../lib/snapshot-v9.js';
import {
  analysisCacheKey,
  analysisCachePayloadMatches,
  analysisContractSignature,
} from '../../../lib/analysis-cache-v9.js';
import { getOrBuildGameDistribution } from '../../../lib/game-distribution-cache-v1.js';
import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';
import { applyMarketFreshness } from '../../../lib/market-freshness-v1.js';
import { applyIndependentMarketVerification } from '../../../lib/market-verification-v2.js';
import { attestIncomingMarketRows, signRepriceSnapshot } from '../../../lib/market-integrity-v1.js';
import {
  assertLeagueGamePrestart,
  buildLeagueGameContext,
  getLeagueProvider,
  leagueAnalysisContract,
  resolveLeagueGame,
  withLeagueProviderTimeout,
} from '../../../lib/league-provider.js';
import { leagueCanAnalyze, leagueConfig, requestedLeagueId } from '../../../lib/leagues.js';
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

// v10.4 namespace invalidates every pre-independent-consensus response.
const responseCache = globalThis.__BASEBALL_V1050_ANALYSIS_CACHE__ || new Map();
globalThis.__BASEBALL_V1050_ANALYSIS_CACHE__ = responseCache;

function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeGame(game) {
  const safe = {
    league: cleanText(game?.league || game?.leagueId, 10),
    leagueId: cleanText(game?.leagueId || game?.league, 10),
    gamePk: positiveInteger(game?.gamePk, Number.MAX_SAFE_INTEGER), gameDate: cleanText(game?.gameDate, 40), officialDate: cleanText(game?.officialDate, 20),
    status: cleanText(game?.status, 60), statusEnglish: cleanText(game?.statusEnglish, 60), statusCode: cleanText(game?.statusCode, 10),
    doubleHeader: cleanText(game?.doubleHeader, 10), gameNumber: positiveInteger(game?.gameNumber) || 1,
    scheduledInnings: positiveInteger(game?.scheduledInnings) || 9, away: cleanText(game?.away, 80), home: cleanText(game?.home, 80),
    awayEnglish: cleanText(game?.awayEnglish, 80), homeEnglish: cleanText(game?.homeEnglish, 80), venue: cleanText(game?.venue, 100),
    venueEnglish: cleanText(game?.venueEnglish, 100), awayTeamId: positiveInteger(game?.awayTeamId), homeTeamId: positiveInteger(game?.homeTeamId),
    venueId: positiveInteger(game?.venueId), awayProbableId: positiveInteger(game?.awayProbableId), homeProbableId: positiveInteger(game?.homeProbableId),
    awayProbable: cleanText(game?.awayProbable, 80), homeProbable: cleanText(game?.homeProbable, 80),
  };
  return safe.gamePk && safe.awayTeamId && safe.homeTeamId && safe.away && safe.home ? safe : null;
}

function sanitizeMarketRows(rows, maximum = 16) {
  return (Array.isArray(rows) ? rows : []).slice(0, maximum).map(row => ({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '', pick: cleanText(row?.pick, 120), water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated), waterMissing: row?.waterMissing === true,
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    sourceLabel: cleanText(row?.sourceLabel, 120), provider: cleanText(row?.provider, 80),
    lineAsOf: cleanText(row?.lineAsOf, 40), executable: row?.executable !== false, marketVerification: null,
    rawDecimalOdds: optionalNumber(row?.rawDecimalOdds), providerEventId: cleanText(row?.providerEventId, 120),
    referenceNoVigProbability: optionalNumber(row?.referenceNoVigProbability),
    referenceRobustProbability: optionalNumber(row?.referenceRobustProbability),
    referenceProbabilityMinimum: optionalNumber(row?.referenceProbabilityMinimum),
    referenceProbabilityMaximum: optionalNumber(row?.referenceProbabilityMaximum),
    referenceProbabilitySpread: optionalNumber(row?.referenceProbabilitySpread),
    referenceProbabilityMad: optionalNumber(row?.referenceProbabilityMad),
    referenceEvidenceEligible: row?.referenceEvidenceEligible === true,
    consensusBookCount: optionalNumber(row?.consensusBookCount),
    consensusBookKeys: (Array.isArray(row?.consensusBookKeys) ? row.consensusBookKeys : []).slice(0, 100).map(value => cleanText(value, 80)).filter(Boolean),
    consensusOldestObservedAt: cleanText(row?.consensusOldestObservedAt, 40),
    consensusNewestObservedAt: cleanText(row?.consensusNewestObservedAt, 40),
    consensusTimeSpanMs: optionalNumber(row?.consensusTimeSpanMs),
    consensusFreshnessMaxMs: optionalNumber(row?.consensusFreshnessMaxMs),
    consensusSnapshotId: cleanText(row?.consensusSnapshotId, 4000),
    ...(Array.isArray(row?.referenceBookProbabilities) ? {
      referenceBookProbabilities: row.referenceBookProbabilities.slice(0, 100).map(item => ({
        bookmakerKey: cleanText(item?.bookmakerKey, 80),
        observedAt: cleanText(item?.observedAt, 40),
        probability: optionalNumber(item?.probability),
      })).filter(item => item.bookmakerKey && item.observedAt && item.probability != null),
    } : {}),
    referenceSide: cleanText(row?.referenceSide, 40), rawText: cleanText(row?.rawText, 300),
    sourceTemplateVersion: cleanText(row?.sourceTemplateVersion, 80), authorizationStatus: cleanText(row?.authorizationStatus, 80),
    integrityOrigin: cleanText(row?.integrityOrigin, 80),
    marketSignatureVersion: cleanText(row?.marketSignatureVersion, 80), marketSignature: cleanText(row?.marketSignature, 160),
  })).filter(row => row.market);
}

async function prepareMarketRows(league, game, rows, maximum) {
  const attested = await attestIncomingMarketRows(league, game, sanitizeMarketRows(rows, maximum));
  const now = Date.now();
  return attested.map(row => applyMarketFreshness(row, now));
}

function cacheSet(key, signature, value) {
  responseCache.set(key, { signature, payload: value, cachedAt: Date.now() });
  while (responseCache.size > 100) responseCache.delete(responseCache.keys().next().value);
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'analyze-v9-3-3-deterministic', limit: 60, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 500000);
    const league = requestedLeagueId(body?.league);
    if (!league) {
      return NextResponse.json({ ok: false, code: 'UNKNOWN_LEAGUE', error: '不支援的聯盟' }, { status: 400 });
    }
    if (!leagueCanAnalyze(league)) {
      const config = leagueConfig(league);
      return NextResponse.json({
        ok: false,
        code: 'LEAGUE_NOT_READY',
        league,
        error: `${config.label}尚未完成正式賽程、Reader 與模型驗證，已停止分析`,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    const requestedGame = sanitizeGame(body.game);
    if (!requestedGame || !Array.isArray(body.markets)) return NextResponse.json({ ok: false, error: '缺少或無效的賽事／盤口資料' }, { status: 400 });
    const { game } = await resolveLeagueGame(league, requestedGame);
    assertLeagueGamePrestart(league, game);

    const suppliedMarkets = await prepareMarketRows(league, game, body.markets, 12);
    const verificationMarkets = await prepareMarketRows(league, game, body.verificationMarkets, 120);
    const markets = applyIndependentMarketVerification(suppliedMarkets, verificationMarkets);
    const previousMarkets = await prepareMarketRows(league, game, body.previousMarkets, 24);
    const errors = [];
    for (const name of MARKET_ORDER) {
      const pair = markets.filter(row => row.market === name);
      if (!marketIsOpen(pair)) continue;
      errors.push(...validateMarketPair(name, pair).map(error => `${name}：${error}`));
    }
    if (errors.length) return NextResponse.json({ ok: false, error: `⛔ QA未通過｜不評分｜不下注：${[...new Set(errors)].join('、')}` }, { status: 400 });
    const activeMarkets = markets.filter(row => row.pick);
    if (!activeMarkets.length) return NextResponse.json({ ok: false, error: '目前沒有任何已開盤市場可分析' }, { status: 400 });

    const settings = {
      rebateRate: TAIWAN_CREDIT_REBATE_RATE,
      candidateThreshold: 7.2,
      strongestThreshold: 8.5,
      expertMode: 'off',
    };
    const context = await withLeagueProviderTimeout(league, buildLeagueGameContext(league, game), 30000);
    if (!context?.coreModelable || context?.dataGateV10?.passedForShadowScore !== true) {
      const blocking = Array.isArray(context?.dataGateV10?.blocking) ? context.dataGateV10.blocking : [];
      const detail = blocking.length ? blocking.join('、') : '核心資料Gate未通過';
      console.error('[ANALYZE_CORE_BLOCK]', { league, gamePk: game?.gamePk, blocking, warnings: context?.warnings || [] });
      return NextResponse.json({
        ok: false,
        code: 'CORE_DATA_MISSING',
        error: `資料不足｜QA BLOCK｜不評分｜缺少：${detail}`,
        blocking,
        warnings: context?.warnings || [],
      }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
    }
    const contract = leagueAnalysisContract(league);
    const versions = {
      modelVersion: context.modelVersion || contract.modelVersion || MODEL_VERSION,
      rulesVersion: context.rulesVersion || contract.rulesVersion || RULES_VERSION,
      dataVersion: DATA_VERSION,
      scoreFormulaVersion: SCORE_FORMULA_VERSION, settlementRuleVersion: SETTLEMENT_RULE_VERSION, uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
    };

    const coreOnly = buildSnapshotFingerprints({ league, context, markets: [], versions });
    const frozenContext = { ...context, coreFingerprint: coreOnly.coreFingerprint };
    const fingerprints = buildSnapshotFingerprints({
      league,
      context: frozenContext,
      markets: activeMarkets,
      versions,
      calculationSettings: settings,
      auxiliaryInput: { previousMarkets },
    });
    const signature = analysisContractSignature(league, game, activeMarkets);
    const cacheKey = analysisCacheKey(league, game.gamePk, fingerprints.inputHash);
    const cached = responseCache.get(cacheKey);
    if (analysisCachePayloadMatches(cached, { league, game, fingerprints, signature })) {
      const safePayload = enforceAnalysisModeSafety(cached.payload, cached.payload.context || frozenContext);
      return NextResponse.json(safePayload, { headers: { 'Cache-Control': 'no-store', 'X-Analysis-Cache': 'HIT', 'X-Distribution-Cache': 'RESPONSE-HIT' } });
    }
    if (cached) responseCache.delete(cacheKey);

    const cachedDistribution = getOrBuildGameDistribution({
      league,
      gamePk: game.gamePk,
      coreFingerprint: fingerprints.coreFingerprint,
      modelVersion: versions.modelVersion,
      rulesVersion: versions.rulesVersion,
      build: () => buildDistributionSnapshot({ context: frozenContext }),
    });
    const preliminary = evaluateMarketsFromDistribution({
      context: frozenContext,
      markets: activeMarkets,
      previousMarkets,
      settings,
      distributionSnapshot: cachedDistribution.snapshot,
    });
    const deterministic = enforceAnalysisModeSafety(
      finalizeDeterministicAnalysis({ analysis: preliminary, game, settings }),
      frozenContext,
    );
    const distributionSnapshot = deterministic.distributionSnapshot;
    const { distributionSnapshot: omitted, ...analysisWithoutDistribution } = deterministic;
    const analysisAsOf = new Date().toISOString();
    const lineAsOf = activeMarkets.map(row => row.lineAsOf).filter(Boolean).sort().at(-1) || analysisAsOf;
    const finalized = {
      ...analysisWithoutDistribution, ...fingerprints, contractSignature: signature,
      analysisType: 'FULL', dataVersion: DATA_VERSION,
      dataAsOf: frozenContext.fetchedAt || analysisAsOf, lineAsOf, analysisAsOf, snapshotId: fingerprints.inputHash,
    };
    const unsignedRepriceSnapshot = {
      frozenContext, distributionSnapshot, coreFingerprint: fingerprints.coreFingerprint, priceFingerprint: fingerprints.priceFingerprint,
      inputHash: fingerprints.inputHash, contractSignature: signature,
      calculationSettings: fingerprints.calculationPayload,
      auxiliaryInput: fingerprints.auxiliaryPayload,
      distributionId: finalized.distributionId, distributionHash: finalized.distributionHash,
      dataAsOf: finalized.dataAsOf, simulationsPerScenario: finalized.scenarioSummary?.simulationsPerScenario, versions,
    };
    const repriceSnapshot = await signRepriceSnapshot(
      league,
      game,
      enforceAnalysisModeSafety(unsignedRepriceSnapshot, frozenContext),
    );
    const provider = getLeagueProvider(league);
    const payload = {
      ok: true, league, game, context: frozenContext, analysis: finalized, repriceSnapshot,
      analysisMode: provider.analysisMode, betEligible: provider.betEligible,
      openMarkets: [...new Set(activeMarkets.map(row => row.market))],
    };
    const safePayload = enforceAnalysisModeSafety(payload, frozenContext);
    cacheSet(cacheKey, signature, safePayload);
    return NextResponse.json(safePayload, { headers: { 'Cache-Control': 'no-store', 'X-Analysis-Cache': 'MISS', 'X-Distribution-Cache': cachedDistribution.cacheStatus } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: Number(error?.status) || 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
