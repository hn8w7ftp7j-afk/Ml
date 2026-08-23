import { NextResponse } from 'next/server';
import { compactRepriceSnapshot, resolveRepriceDistribution } from '../../../lib/analysis-transport-v1.js';
import { buildDistributionSnapshot, enforceAnalysisModeSafety, repriceMarkets, MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis-v11.js';
import { finalizeDeterministicAnalysis, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer-v10.js';
import { SCORE_FORMULA_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION, TAIWAN_CREDIT_REBATE_RATE } from '../../../lib/taiwan-settlement-v9.js';
import { buildSnapshotFingerprints, DATA_VERSION, REPRICE_VERSION } from '../../../lib/snapshot-v9.js';
import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';
import { applyMarketFreshness } from '../../../lib/market-freshness-v1.js';
import { applyIndependentMarketVerification } from '../../../lib/market-verification-v2.js';
import { attestIncomingMarketRows, signRepriceSnapshot, verifyRepriceSnapshot } from '../../../lib/market-integrity-v1.js';
import {
  assertLeagueGamePrestart,
  getLeagueProvider,
  leagueAnalysisContract,
  resolveLeagueGame,
} from '../../../lib/league-provider.js';
import { leagueCanAnalyze, leagueConfig, requestedLeagueId } from '../../../lib/leagues.js';
import { checkRateLimit, cleanText, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin } from '../../../lib/security.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function sanitizeMarkets(rows, maximum = 16) {
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

async function prepareMarkets(league, game, rows, maximum) {
  const attested = await attestIncomingMarketRows(league, game, sanitizeMarkets(rows, maximum));
  const now = Date.now();
  return attested.map(row => applyMarketFreshness(row, now));
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'reprice-v9-3-3', limit: 120, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 8_000_000);
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
        error: `${config.label}尚未完成正式賽程、Reader 與模型驗證，已停止快速重算`,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : null;
    const context = snapshot?.frozenContext;
    if (!context?.game?.gamePk || !snapshot?.coreFingerprint || !snapshot?.distributionHash || !snapshot?.distributionId) {
      return NextResponse.json({ ok: false, error: '缺少已保存的凍結比分分布識別，不能快速重算' }, { status: 400 });
    }
    const { game } = await resolveLeagueGame(league, context.game);
    assertLeagueGamePrestart(league, game);
    if (!(await verifyRepriceSnapshot(league, game, snapshot))) {
      return NextResponse.json({ ok: false, error: '凍結快照簽章無效或內容已被修改，必須完整重算' }, { status: 409 });
    }
    // New compact snapshots intentionally omit the large joint distribution.
    // Rebuilding from the signed frozen context is deterministic; the hash check
    // below guarantees that repricing cannot silently change the model output.
    const resolvedDistribution = resolveRepriceDistribution(snapshot, buildDistributionSnapshot);
    const distributionSnapshot = resolvedDistribution.distributionSnapshot;
    if (!resolvedDistribution.matches) {
      return NextResponse.json({ ok: false, error: '凍結比分分布識別不一致，已停止快速重算' }, { status: 409 });
    }
    const suppliedMarkets = await prepareMarkets(league, game, body.markets, 12);
    const verificationMarkets = await prepareMarkets(league, game, body.verificationMarkets, 120);
    const markets = applyIndependentMarketVerification(suppliedMarkets, verificationMarkets);
    const previousMarkets = await prepareMarkets(league, game, body.previousMarkets, 24);
    const errors = [];
    for (const name of MARKET_ORDER) {
      const pair = markets.filter(row => row.market === name);
      if (!marketIsOpen(pair)) continue;
      errors.push(...validateMarketPair(name, pair).map(error => `${name}：${error}`));
    }
    if (errors.length) return NextResponse.json({ ok: false, error: `盤口快速重算QA未通過：${[...new Set(errors)].join('、')}` }, { status: 400 });
    if (!markets.some(row => row.pick)) return NextResponse.json({ ok: false, error: '沒有可重算的盤口' }, { status: 400 });

    const settings = {
      rebateRate: TAIWAN_CREDIT_REBATE_RATE,
      candidateThreshold: 7.2,
      strongestThreshold: 8.5,
      expertMode: 'off',
    };
    const preliminary = repriceMarkets({ context, markets, previousMarkets, settings, distributionSnapshot });
    const deterministic = enforceAnalysisModeSafety(
      finalizeDeterministicAnalysis({ analysis: preliminary, game, settings }),
      context,
    );
    const { distributionSnapshot: omitted, ...analysisWithoutDistribution } = deterministic;
    const contract = leagueAnalysisContract(league);
    const versions = {
      modelVersion: context.modelVersion || contract.modelVersion || MODEL_VERSION,
      rulesVersion: context.rulesVersion || contract.rulesVersion || RULES_VERSION,
      dataVersion: DATA_VERSION, scoreFormulaVersion: SCORE_FORMULA_VERSION,
      settlementRuleVersion: SETTLEMENT_RULE_VERSION, uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
      repriceVersion: REPRICE_VERSION,
    };
    const fingerprints = buildSnapshotFingerprints({
      league,
      context,
      markets,
      versions,
      calculationSettings: settings,
      auxiliaryInput: { previousMarkets },
    });
    if (fingerprints.coreFingerprint !== snapshot.coreFingerprint) return NextResponse.json({ ok: false, error: '核心資料指紋已改變，必須完整重算' }, { status: 409 });
    if (analysisWithoutDistribution.distributionId !== snapshot.distributionId || analysisWithoutDistribution.distributionHash !== snapshot.distributionHash) {
      return NextResponse.json({ ok: false, error: '快速重算不得改變比分分布' }, { status: 409 });
    }
    const analysisAsOf = new Date().toISOString();
    const finalized = {
      ...analysisWithoutDistribution, ...fingerprints, analysisType: 'PRICE_ONLY_REPRICE', repriceVersion: REPRICE_VERSION,
      parentInputHash: snapshot.inputHash || null, parentDistributionId: snapshot.distributionId, distributionReused: true,
      dataAsOf: snapshot.dataAsOf || context.fetchedAt || null,
      lineAsOf: markets.map(row => row.lineAsOf).filter(Boolean).sort().at(-1) || analysisAsOf,
      analysisAsOf, snapshotId: fingerprints.inputHash,
    };
    const unsignedRepriceSnapshot = {
      ...compactRepriceSnapshot(snapshot),
      priceFingerprint: fingerprints.priceFingerprint,
      calculationFingerprint: fingerprints.calculationFingerprint,
      auxiliaryFingerprint: fingerprints.auxiliaryFingerprint,
      inputHash: fingerprints.inputHash,
      calculationSettings: fingerprints.calculationPayload,
      auxiliaryInput: fingerprints.auxiliaryPayload,
      distributionId: snapshot.distributionId,
      distributionHash: snapshot.distributionHash,
      versions,
    };
    const repriceSnapshot = await signRepriceSnapshot(
      league,
      game,
      enforceAnalysisModeSafety(unsignedRepriceSnapshot, context),
    );
    const provider = getLeagueProvider(league);
    const payload = {
      ok: true, league, game, context, analysis: finalized, repriceSnapshot,
      analysisMode: provider.analysisMode, betEligible: provider.betEligible,
      openMarkets: [...new Set(markets.map(row => row.market))],
      reprice: { distributionReused: true, distributionRebuiltFromSignedContext: resolvedDistribution.rebuilt, noCoreDataFetch: true, noSimulation: !resolvedDistribution.rebuilt, noGpt: true, distributionId: snapshot.distributionId, distributionHash: snapshot.distributionHash, coreFingerprint: snapshot.coreFingerprint, previousInputHash: snapshot.inputHash || null, newInputHash: fingerprints.inputHash },
    };
    return NextResponse.json(enforceAnalysisModeSafety(payload, context), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: Number(error?.status) || 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
