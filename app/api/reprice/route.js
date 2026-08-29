import { NextResponse } from 'next/server';
import { compactRepriceSnapshot, resolveRepriceDistribution } from '../../../lib/analysis-transport-v1.js';
import { buildDistributionSnapshot, enforceAnalysisModeSafety, repriceMarkets, MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis-v11.js';
import { finalizeDeterministicAnalysis, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer-v10.js';
import { SCORE_FORMULA_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION, TAIWAN_CREDIT_REBATE_RATE } from '../../../lib/taiwan-settlement-v9.js';
import { buildSnapshotFingerprints, DATA_VERSION, REPRICE_VERSION } from '../../../lib/snapshot-v9.js';
import { MARKET_ORDER } from '../../../lib/markets.js';
import {
  assessEightDirectionMarketCoverage,
  attachEightDirectionContract,
} from '../../../lib/direction-slots-v1.js';
import { applyMarketFreshness } from '../../../lib/market-freshness-v1.js';
import { applyIndependentMarketVerification } from '../../../lib/market-verification-v2.js';
import {
  attestIncomingMarketRows,
  normalizeSignedReaderProvenance,
  signRepriceSnapshot,
  verifyReaderProvenance,
  verifyRepriceSnapshot,
} from '../../../lib/market-integrity-v1.js';
import {
  assertLeagueGamePrestart,
  getLeagueProvider,
  leagueAnalysisContract,
} from '../../../lib/league-provider.js';
import { leagueCanAnalyze, leagueConfig, requestedLeagueId } from '../../../lib/leagues.js';
import { checkRateLimit, cleanText, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin } from '../../../lib/security.js';
import { assessCoreSnapshotFreshnessV109 } from '../../../lib/analysis-refresh-policy-v109.js';
import {
  ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
  analysisPitDatabaseConfigured,
  analysisPitProductionPersistenceRequired,
  analysisPitSnapshotId,
  persistAnalysisPitSnapshotForResponse,
} from '../../../lib/analysis-pit-snapshot-store-v1.js';
import { enforceUnconfirmedPitShadowSafety } from '../../../lib/pit-persistence-safety-v110.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MAX_SUPPLIED_MARKET_ROWS = 12;
const MAX_PREVIOUS_MARKET_ROWS = 24;
const MAX_VERIFICATION_MARKET_ROWS = 120;

function requestError(message, status = 400, code = 'INVALID_MARKET_REQUEST') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function boundedMarketRows(rows, maximum, label) {
  if (rows == null) return [];
  if (!Array.isArray(rows)) throw requestError(`${label}必須是陣列`);
  if (rows.length > maximum) {
    throw requestError(`${label}超過${maximum}筆，已拒絕而非靜默截斷`, 400, 'MARKET_ROW_LIMIT_EXCEEDED');
  }
  return rows;
}

function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function sanitizeMarkets(rows, maximum = 16) {
  return boundedMarketRows(rows, maximum, '盤口資料').map(row => ({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '', pick: cleanText(row?.pick, 120), water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated), waterMissing: row?.waterMissing === true,
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    sourceLabel: cleanText(row?.sourceLabel, 120), provider: cleanText(row?.provider, 80),
    lineAsOf: cleanText(row?.lineAsOf, 40), executable: row?.executable !== false, marketVerification: null,
    rawDecimalOdds: optionalNumber(row?.rawDecimalOdds), providerEventId: cleanText(row?.providerEventId, 120),
    readerGameMarketHash: cleanText(row?.readerGameMarketHash, 64),
    readerVersion: cleanText(row?.readerVersion, 100),
    readerPayloadHash: cleanText(row?.readerPayloadHash, 64),
    readerRawBoardHash: cleanText(row?.readerRawBoardHash, 64),
    readerBoardDate: cleanText(row?.readerBoardDate, 20),
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
    integrityError: cleanText(row?.integrityError, 300),
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

function deriveReaderProvenanceFromSignedRows(suppliedMarkets) {
  if (!suppliedMarkets.length) return null;
  const readerRows = suppliedMarkets.filter(row => row?.sourceType === 'ACTUAL_TW_CREDIT'
    && String(row?.provider || '').toUpperCase() === 'TAI888_READER_AUTO');
  if (!readerRows.length) return null;
  if (readerRows.length !== suppliedMarkets.length) {
    throw requestError('Reader簽章盤口不得與手動盤混用', 409, 'READER_PROVENANCE_MISMATCH');
  }
  const first = readerRows[0];
  const lineage = {
    provider: 'TAI888_READER_AUTO',
    sourceType: 'ACTUAL_TW_CREDIT',
    readerVersion: first.readerVersion,
    payloadHash: first.readerPayloadHash,
    rawBoardHash: first.readerRawBoardHash,
    boardDate: first.readerBoardDate,
    lineAsOf: first.lineAsOf,
    marketStatus: 'OPEN',
    readerGameMarketHash: first.readerGameMarketHash,
    authorizationStatus: 'SERVER_ATTESTED_SIGNED_MARKET_ROWS',
    integrityOrigin: 'SERVER_DERIVED_SIGNED_MARKET_ROWS',
    provenanceSignatureVersion: null,
    provenanceSignature: null,
  };
  const hash = /^[a-f0-9]{64}$/;
  const complete = Boolean(lineage.readerVersion)
    && hash.test(lineage.payloadHash || '')
    && hash.test(lineage.rawBoardHash || '')
    && hash.test(lineage.readerGameMarketHash || '')
    && /^\d{4}-\d{2}-\d{2}$/.test(lineage.boardDate || '')
    && Number.isFinite(Date.parse(lineage.lineAsOf || ''));
  const mismatch = !complete || readerRows.some(row => (
    row.readerVersion !== lineage.readerVersion
    || row.readerPayloadHash !== lineage.payloadHash
    || row.readerRawBoardHash !== lineage.rawBoardHash
    || row.readerBoardDate !== lineage.boardDate
    || row.readerGameMarketHash !== lineage.readerGameMarketHash
    || row.lineAsOf !== lineage.lineAsOf
  ));
  if (mismatch) {
    throw requestError('Reader簽章盤口的版本、盤日、時間或雜湊不一致', 409, 'READER_PROVENANCE_MISMATCH');
  }
  return lineage;
}

async function verifiedReaderProvenance(league, game, value, suppliedMarkets) {
  if (value == null) {
    if (!suppliedMarkets.length) {
      throw requestError('空盤快速重算必須附帶伺服器簽署的 Reader provenance', 400, 'READER_PROVENANCE_REQUIRED');
    }
    return deriveReaderProvenanceFromSignedRows(suppliedMarkets);
  }
  const normalized = normalizeSignedReaderProvenance(value);
  if (!normalized || !(await verifyReaderProvenance(league, game, normalized))) {
    throw requestError('Reader provenance 簽章無效或內容已被修改', 409, 'READER_PROVENANCE_REJECTED');
  }
  const readerRows = suppliedMarkets.filter(row => row?.sourceType === 'ACTUAL_TW_CREDIT'
    && String(row?.provider || '').toUpperCase() === 'TAI888_READER_AUTO');
  if (normalized.marketStatus === 'UNOPENED') {
    if (suppliedMarkets.length) throw requestError('UNOPENED Reader provenance 不得夾帶盤口資料', 409, 'READER_PROVENANCE_MISMATCH');
    return normalized;
  }
  if (!suppliedMarkets.length || readerRows.length !== suppliedMarkets.length) {
    throw requestError('OPEN Reader provenance 必須對應完整的伺服器簽章Reader盤口', 409, 'READER_PROVENANCE_MISMATCH');
  }
  const mismatch = readerRows.some(row => (
    row.readerVersion !== normalized.readerVersion
    || row.readerPayloadHash !== normalized.payloadHash
    || row.readerRawBoardHash !== normalized.rawBoardHash
    || row.readerBoardDate !== normalized.boardDate
    || row.readerGameMarketHash !== normalized.readerGameMarketHash
    || row.lineAsOf !== normalized.lineAsOf
  ));
  if (mismatch) throw requestError('Reader provenance 與簽章盤口版本或雜湊不一致', 409, 'READER_PROVENANCE_MISMATCH');
  return normalized;
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
        error: `${config.label}尚無法可信建立獨立比分分布，已依 fail-closed 停止快速重算：${config.statusLabel}`,
        analysisReadiness: config.analysisReadiness || null,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    if (analysisPitProductionPersistenceRequired() && !analysisPitDatabaseConfigured()) {
      return NextResponse.json({
        ok: false,
        code: 'PIT_PERSISTENCE_REQUIRED',
        error: 'Production缺少DATABASE_URL，永久PIT不可用，已停止快速重算',
        pitPersistence: {
          status: 'FAILED', confirmed: false, required: true,
          reason: 'DATABASE_NOT_CONFIGURED', snapshotId: null,
        },
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : null;
    const context = snapshot?.frozenContext;
    if (!context?.game?.gamePk || !snapshot?.inputHash || !snapshot?.coreFingerprint || !snapshot?.distributionHash || !snapshot?.distributionId) {
      return NextResponse.json({ ok: false, error: '缺少已保存的凍結比分分布識別，不能快速重算' }, { status: 400 });
    }
    const contextLeague = String(context?.leagueId || context?.game?.leagueId || context?.game?.league || '').trim().toUpperCase();
    if (contextLeague !== league) {
      return NextResponse.json({ ok: false, error: '凍結快照聯盟與快速重算聯盟不一致' }, { status: 409 });
    }
    // The signed frozen game identity is authoritative for a price-only reprice.
    // Do not fetch schedules, core baseball data or GPT here.
    const game = context.game;
    assertLeagueGamePrestart(league, game);
    if (!(await verifyRepriceSnapshot(league, game, snapshot))) {
      return NextResponse.json({ ok: false, error: '凍結快照簽章無效或內容已被修改，必須完整重算' }, { status: 409 });
    }
    const coreFreshness = assessCoreSnapshotFreshnessV109(context);
    if (!coreFreshness.fresh) {
      return NextResponse.json({
        ok: false,
        code: 'CORE_REFRESH_REQUIRED',
        error: '先發、打線、牛棚、捕手、屋頂或天氣快照已到重新檢查時間，必須完整重算',
        coreFreshness,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    // New compact snapshots intentionally omit the large joint distribution.
    // Rebuilding from the signed frozen context is deterministic; the hash check
    // below guarantees that repricing cannot silently change the model output.
    const resolvedDistribution = resolveRepriceDistribution(snapshot, buildDistributionSnapshot);
    const distributionSnapshot = resolvedDistribution.distributionSnapshot;
    if (!resolvedDistribution.matches) {
      return NextResponse.json({ ok: false, error: '凍結比分分布識別不一致，已停止快速重算' }, { status: 409 });
    }
    const suppliedMarkets = await prepareMarkets(league, game, body.markets, MAX_SUPPLIED_MARKET_ROWS);
    const readerProvenance = await verifiedReaderProvenance(league, game, body.readerProvenance, suppliedMarkets);
    const verificationMarkets = await prepareMarkets(league, game, body.verificationMarkets, MAX_VERIFICATION_MARKET_ROWS);
    const markets = applyIndependentMarketVerification(suppliedMarkets, verificationMarkets);
    const previousMarkets = await prepareMarkets(league, game, body.previousMarkets, MAX_PREVIOUS_MARKET_ROWS);
    const marketCoverage = assessEightDirectionMarketCoverage(markets, game);
    const activeMarkets = marketCoverage.validRows;

    const settings = {
      rebateRate: TAIWAN_CREDIT_REBATE_RATE,
      candidateThreshold: 7.2,
      strongestThreshold: 8.5,
      expertMode: 'off',
    };
    const preliminary = repriceMarkets({ context, markets: activeMarkets, previousMarkets, settings, distributionSnapshot });
    assertLeagueGamePrestart(league, game);
    const deterministicCore = enforceAnalysisModeSafety(
      finalizeDeterministicAnalysis({ analysis: preliminary, game, settings }),
      context,
    );
    const deterministic = attachEightDirectionContract(deterministicCore, marketCoverage, game, readerProvenance);
    const { distributionSnapshot: omitted, ...analysisWithoutDistribution } = deterministic;
    const contract = leagueAnalysisContract(league);
    const versions = {
      modelVersion: context.modelVersion || contract.modelVersion || MODEL_VERSION,
      rulesVersion: context.rulesVersion || contract.rulesVersion || RULES_VERSION,
      dataVersion: DATA_VERSION, scoreFormulaVersion: SCORE_FORMULA_VERSION,
      settlementRuleVersion: SETTLEMENT_RULE_VERSION, uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
      repriceVersion: REPRICE_VERSION,
      pitPayloadEncodingVersion: ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION,
    };
    const fingerprints = buildSnapshotFingerprints({
      league,
      context,
      markets,
      versions,
      calculationSettings: settings,
      auxiliaryInput: { previousMarkets, contractRule: readerProvenance },
    });
    if (fingerprints.inputHash === snapshot.inputHash) {
      assertLeagueGamePrestart(league, game);
      return NextResponse.json({
        ok: false,
        code: 'NO_OP_REPRICE',
        error: '盤口與計算輸入未改變，沿用原快照即可，不建立self-parent',
        pitSnapshotId: snapshot.pitSnapshotId || null,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    if (fingerprints.coreFingerprint !== snapshot.coreFingerprint) return NextResponse.json({ ok: false, error: '核心資料指紋已改變，必須完整重算' }, { status: 409 });
    if (analysisWithoutDistribution.distributionId !== snapshot.distributionId || analysisWithoutDistribution.distributionHash !== snapshot.distributionHash) {
      return NextResponse.json({ ok: false, error: '快速重算不得改變比分分布' }, { status: 409 });
    }
    const analysisAsOf = new Date().toISOString();
    const parentAnalysisType = ['FULL', 'PRICE_ONLY_REPRICE'].includes(String(snapshot.analysisType || '').toUpperCase())
      ? String(snapshot.analysisType).toUpperCase()
      : 'FULL';
    const parentPitSnapshotId = snapshot.pitSnapshotId || analysisPitSnapshotId({
      league,
      gamePk: game.gamePk,
      analysisType: parentAnalysisType,
      inputHash: snapshot.inputHash,
    });
    const pitSnapshotId = analysisPitSnapshotId({
      league,
      gamePk: game.gamePk,
      analysisType: 'PRICE_ONLY_REPRICE',
      inputHash: fingerprints.inputHash,
    });
    const finalized = {
      ...analysisWithoutDistribution, ...fingerprints, analysisType: 'PRICE_ONLY_REPRICE', repriceVersion: REPRICE_VERSION,
      parentInputHash: snapshot.inputHash || null, parentAnalysisType, parentPitSnapshotId,
      parentDistributionId: snapshot.distributionId, distributionReused: true,
      dataAsOf: snapshot.dataAsOf || context.fetchedAt || null,
      lineAsOf: markets.map(row => row.lineAsOf).filter(Boolean).sort().at(-1)
        || readerProvenance?.lineAsOf
        || analysisAsOf,
      analysisAsOf, snapshotId: fingerprints.inputHash, pitSnapshotId,
    };
    const unsignedRepriceSnapshot = {
      ...compactRepriceSnapshot(snapshot),
      priceFingerprint: fingerprints.priceFingerprint,
      calculationFingerprint: fingerprints.calculationFingerprint,
      auxiliaryFingerprint: fingerprints.auxiliaryFingerprint,
      inputHash: fingerprints.inputHash,
      analysisType: 'PRICE_ONLY_REPRICE',
      pitSnapshotId,
      parentAnalysisType,
      parentPitSnapshotId,
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
      openMarkets: [...new Set(activeMarkets.map(row => row.market))],
      blockedMarkets: marketCoverage.blockedMarkets,
      unopenedMarkets: marketCoverage.unopenedMarkets,
      reprice: { distributionReused: true, distributionRebuiltFromSignedContext: resolvedDistribution.rebuilt, noCoreDataFetch: true, noSimulation: !resolvedDistribution.rebuilt, noGpt: true, distributionId: snapshot.distributionId, distributionHash: snapshot.distributionHash, coreFingerprint: snapshot.coreFingerprint, previousInputHash: snapshot.inputHash || null, newInputHash: fingerprints.inputHash },
    };
    const safePayload = enforceAnalysisModeSafety(payload, context);
    assertLeagueGamePrestart(league, game);
    const pitPersistence = await persistAnalysisPitSnapshotForResponse({
      league,
      game,
      frozenContext: context,
      analysis: finalized,
      distributionSnapshot: null,
      repriceSnapshot,
      versions,
      markets,
      previousMarkets,
      readerSnapshot: readerProvenance,
    }, { requiredWhenConfigured: true });
    safePayload.pitPersistence = pitPersistence;
    assertLeagueGamePrestart(league, game);
    if (pitPersistence.required && !pitPersistence.confirmed) {
      assertLeagueGamePrestart(league, game);
      return NextResponse.json(
        enforceUnconfirmedPitShadowSafety(safePayload, pitPersistence),
        { headers: {
          'Cache-Control': 'no-store',
          'X-PIT-Persistence': 'UNCONFIRMED-SHADOW-ONLY',
        } },
      );
    }
    assertLeagueGamePrestart(league, game);
    return NextResponse.json(safePayload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      ...(error?.code ? { code: String(error.code) } : {}),
      error: String(error?.message || error),
    }, { status: Number(error?.status) || 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
