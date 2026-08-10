import { NextResponse } from 'next/server';
import { analyzeMarkets, MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';
import { finalizeDeterministicAnalysis, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer.js';
import { SCORE_FORMULA_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION } from '../../../lib/taiwan-settlement-v9.js';
import { buildSnapshotFingerprints, DATA_VERSION, REPRICE_VERSION } from '../../../lib/snapshot-v9.js';
import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';
import {
  checkRateLimit,
  cleanText,
  originErrorResponse,
  rateLimitResponse,
  readJsonBody,
  requireApiAuth,
  validateSameOrigin,
} from '../../../lib/security.js';

export const runtime = 'nodejs';
export const maxDuration = 90;
export const dynamic = 'force-dynamic';

function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function sanitizeMarkets(rows, maximum = 16) {
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

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'reprice-v9', limit: 90, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);

    const body = await readJsonBody(request, 1_500_000);
    const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : null;
    const context = snapshot?.frozenContext;
    if (!context?.game?.gamePk || !snapshot?.coreFingerprint || !snapshot?.distributionId) {
      return NextResponse.json({ ok: false, error: '缺少可重現的凍結資料快照，不能快速重算' }, { status: 400 });
    }

    const markets = sanitizeMarkets(body.markets, 12);
    const previousMarkets = sanitizeMarkets(body.previousMarkets, 24);
    const errors = [];
    for (const name of MARKET_ORDER) {
      const pair = markets.filter(row => row.market === name);
      if (!marketIsOpen(pair)) continue;
      errors.push(...validateMarketPair(name, pair).map(error => `${name}：${error}`));
    }
    if (errors.length) {
      return NextResponse.json({ ok: false, error: `盤口快速重算QA未通過：${[...new Set(errors)].join('、')}` }, { status: 400 });
    }
    if (!markets.some(row => row.pick)) {
      return NextResponse.json({ ok: false, error: '沒有可重算的實際盤口' }, { status: 400 });
    }

    const settings = {
      rebateRate: Math.max(0, Math.min(0.1, Number(body.settings?.rebateRate) || 0.015)),
      candidateThreshold: 7.2,
      strongestThreshold: 8.5,
      simulationsPerScenario: Math.max(500, Math.min(4000, Math.round(Number(snapshot.simulationsPerScenario) || Number(body.settings?.simulationsPerScenario) || 1800))),
      expertMode: 'off',
    };

    const preliminary = analyzeMarkets({ context, markets, previousMarkets, settings });
    if (preliminary.distributionId !== snapshot.distributionId) {
      return NextResponse.json({ ok: false, error: '凍結比分分布驗算失敗：distributionId改變，已停止快速重算' }, { status: 409 });
    }
    const analysis = finalizeDeterministicAnalysis({ analysis: preliminary, game: context.game, settings });
    const versions = {
      modelVersion: MODEL_VERSION,
      rulesVersion: RULES_VERSION,
      dataVersion: DATA_VERSION,
      scoreFormulaVersion: SCORE_FORMULA_VERSION,
      settlementRuleVersion: SETTLEMENT_RULE_VERSION,
      uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
      repriceVersion: REPRICE_VERSION,
    };
    const fingerprints = buildSnapshotFingerprints({ context, markets, versions });
    if (fingerprints.coreFingerprint !== snapshot.coreFingerprint) {
      return NextResponse.json({ ok: false, error: '核心資料指紋已改變，必須改做完整重算' }, { status: 409 });
    }

    const analysisAsOf = new Date().toISOString();
    const finalized = {
      ...analysis,
      ...fingerprints,
      analysisType: 'PRICE_ONLY_REPRICE',
      repriceVersion: REPRICE_VERSION,
      parentInputHash: snapshot.inputHash || null,
      parentDistributionId: snapshot.distributionId,
      distributionReused: true,
      dataAsOf: snapshot.dataAsOf || context.fetchedAt || null,
      lineAsOf: markets.map(row => row.lineAsOf).filter(Boolean).sort().at(-1) || analysisAsOf,
      analysisAsOf,
      snapshotId: fingerprints.inputHash,
    };

    return NextResponse.json({
      ok: true,
      game: context.game,
      context,
      analysis: finalized,
      openMarkets: [...new Set(markets.map(row => row.market))],
      reprice: {
        distributionReused: true,
        distributionId: snapshot.distributionId,
        coreFingerprint: snapshot.coreFingerprint,
        previousInputHash: snapshot.inputHash || null,
        newInputHash: fingerprints.inputHash,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, {
      status: Number(error?.status) || 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
