import { NextResponse } from 'next/server';
import { repriceMarkets, MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';
import { finalizeDeterministicAnalysis, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer.js';
import { SCORE_FORMULA_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION } from '../../../lib/taiwan-settlement-v9.js';
import { buildSnapshotFingerprints, DATA_VERSION, REPRICE_VERSION } from '../../../lib/snapshot-v9.js';
import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';
import { checkRateLimit, cleanText, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin } from '../../../lib/security.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function cleanVerification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sources = (Array.isArray(value.sources) ? value.sources : []).slice(0, 4).map(source => ({
    provider: cleanText(source?.provider, 80), independentGroup: cleanText(source?.independentGroup, 80),
    observedAt: cleanText(source?.observedAt, 40), contractKey: cleanText(source?.contractKey, 160),
  })).filter(source => source.provider && source.independentGroup && source.observedAt && source.contractKey);
  return { sources, verified: value.verified === true && sources.length >= 2 && new Set(sources.map(source => source.independentGroup)).size >= 2 };
}
function sanitizeMarkets(rows, maximum = 16) {
  return (Array.isArray(rows) ? rows : []).slice(0, maximum).map(row => ({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '', pick: cleanText(row?.pick, 120), water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated), waterMissing: row?.waterMissing === true,
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    sourceLabel: cleanText(row?.sourceLabel, 120), provider: cleanText(row?.provider, 80),
    lineAsOf: cleanText(row?.lineAsOf, 40), executable: row?.executable !== false, marketVerification: cleanVerification(row?.marketVerification),
    rawDecimalOdds: optionalNumber(row?.rawDecimalOdds), providerEventId: cleanText(row?.providerEventId, 120),
  })).filter(row => row.market);
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'reprice-v9-3-3', limit: 120, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 8_000_000);
    const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : null;
    const context = snapshot?.frozenContext;
    const distributionSnapshot = snapshot?.distributionSnapshot;
    if (!context?.game?.gamePk || !snapshot?.coreFingerprint || !distributionSnapshot?.distributionHash) {
      return NextResponse.json({ ok: false, error: '缺少已保存的凍結比分分布，不能快速重算' }, { status: 400 });
    }
    if (distributionSnapshot.distributionId !== snapshot.distributionId || distributionSnapshot.distributionHash !== snapshot.distributionHash) {
      return NextResponse.json({ ok: false, error: '凍結比分分布識別不一致，已停止快速重算' }, { status: 409 });
    }
    const markets = sanitizeMarkets(body.markets, 12);
    const previousMarkets = sanitizeMarkets(body.previousMarkets, 24);
    const errors = [];
    for (const name of MARKET_ORDER) {
      const pair = markets.filter(row => row.market === name);
      if (!marketIsOpen(pair)) continue;
      errors.push(...validateMarketPair(name, pair).map(error => `${name}：${error}`));
    }
    if (errors.length) return NextResponse.json({ ok: false, error: `盤口快速重算QA未通過：${[...new Set(errors)].join('、')}` }, { status: 400 });
    if (!markets.some(row => row.pick)) return NextResponse.json({ ok: false, error: '沒有可重算的盤口' }, { status: 400 });

    const requestedRebateRate = Number(body.settings?.rebateRate);
    const settings = {
      rebateRate: Number.isFinite(requestedRebateRate) ? Math.max(0, Math.min(0.1, requestedRebateRate)) : 0.015,
      candidateThreshold: 7.2,
      strongestThreshold: 8.5,
      simulationsPerScenario: distributionSnapshot.simulationsPerScenario,
      expertMode: 'off',
    };
    const preliminary = repriceMarkets({ context, markets, previousMarkets, settings, distributionSnapshot });
    const deterministic = finalizeDeterministicAnalysis({ analysis: preliminary, game: context.game, settings });
    const { distributionSnapshot: omitted, ...analysisWithoutDistribution } = deterministic;
    const versions = { modelVersion: MODEL_VERSION, rulesVersion: RULES_VERSION, dataVersion: DATA_VERSION, scoreFormulaVersion: SCORE_FORMULA_VERSION, settlementRuleVersion: SETTLEMENT_RULE_VERSION, uncertaintySetVersion: UNCERTAINTY_SET_VERSION, repriceVersion: REPRICE_VERSION };
    const fingerprints = buildSnapshotFingerprints({
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
    const repriceSnapshot = {
      ...snapshot,
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
    return NextResponse.json({
      ok: true, game: context.game, context, analysis: finalized, repriceSnapshot,
      openMarkets: [...new Set(markets.map(row => row.market))],
      reprice: { distributionReused: true, noCoreDataFetch: true, noSimulation: true, noGpt: true, distributionId: snapshot.distributionId, distributionHash: snapshot.distributionHash, coreFingerprint: snapshot.coreFingerprint, previousInputHash: snapshot.inputHash || null, newInputHash: fingerprints.inputHash },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: Number(error?.status) || 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
