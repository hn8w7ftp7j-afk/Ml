import { NextResponse } from 'next/server';
import { compactAnalysisContext, compactRepriceSnapshot } from '../../../lib/analysis-transport-v1.js';
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
import { buildSnapshotFingerprints, DATA_VERSION, sha256 } from '../../../lib/snapshot-v9.js';
import {
  analysisCacheKey,
  analysisCachePayloadMatches,
  analysisContractSignature,
} from '../../../lib/analysis-cache-v9.js';
import { getOrBuildGameDistribution } from '../../../lib/game-distribution-cache-v1.js';
import { MARKET_ORDER } from '../../../lib/markets.js';
import {
  assessEightDirectionMarketCoverage,
  attachEightDirectionContract,
} from '../../../lib/direction-slots-v1.js';
import { applyMarketFreshness } from '../../../lib/market-freshness-v1.js';
import {
  ANALYSIS_IDEMPOTENCY_CACHE_TTL_MS,
  ANALYSIS_RESPONSE_CACHE_TTL_MS,
  assessAnalysisCacheEntryV110,
} from '../../../lib/analysis-response-cache-policy-v110.js';
import { applyIndependentMarketVerification } from '../../../lib/market-verification-v2.js';
import { persistMlbAdvancedSnapshotBestEffort } from '../../../lib/mlb-advanced-snapshot-store-v2.js';
import {
  analysisPitDatabaseConfigured,
  analysisPitProductionPersistenceRequired,
  analysisPitSnapshotId,
  persistAnalysisPitSnapshotForResponse,
} from '../../../lib/analysis-pit-snapshot-store-v1.js';
import { enforceUnconfirmedPitShadowSafety } from '../../../lib/pit-persistence-safety-v110.js';
import {
  attestIncomingMarketRows,
  normalizeSignedReaderProvenance,
  signRepriceSnapshot,
  verifyReaderProvenance,
} from '../../../lib/market-integrity-v1.js';
import {
  assertLeagueGamePrestart,
  buildLeagueGameContext,
  getLeagueProvider,
  leagueAnalysisContract,
  resolveLeagueGame,
  withLeagueProviderTimeout,
} from '../../../lib/league-provider.js';
import { leagueCanAnalyze, leagueConfig, requestedLeagueId } from '../../../lib/leagues.js';
import { extractAsianStarterEvidence } from '../../../lib/asian-production-features-v1.js';
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

// V11 namespace invalidates every pre-PIT/fail-closed response.
const responseCache = globalThis.__BASEBALL_V1110_ANALYSIS_CACHE__ || new Map();
globalThis.__BASEBALL_V1110_ANALYSIS_CACHE__ = responseCache;
const requestResultCache = globalThis.__BASEBALL_V1110_ANALYSIS_REQUEST_RESULT_CACHE__ || new Map();
globalThis.__BASEBALL_V1110_ANALYSIS_REQUEST_RESULT_CACHE__ = requestResultCache;

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

async function prepareMarketRows(league, game, rows, maximum) {
  const attested = await attestIncomingMarketRows(league, game, sanitizeMarketRows(rows, maximum));
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
      throw requestError('空盤分析必須附帶伺服器簽署的 Reader provenance', 400, 'READER_PROVENANCE_REQUIRED');
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

function cacheSet(key, signature, value) {
  responseCache.set(key, { signature, payload: value, cachedAt: Date.now() });
  while (responseCache.size > 100) responseCache.delete(responseCache.keys().next().value);
}

function requestCacheSet(key, bodyHash, payload) {
  if (!key) return;
  requestResultCache.set(key, { bodyHash, payload, cachedAt: Date.now() });
  while (requestResultCache.size > 100) requestResultCache.delete(requestResultCache.keys().next().value);
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'analyze-v9-3-3-deterministic', limit: 60, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 500000);
    const requestKeyRaw = String(request.headers.get('idempotency-key') || '').trim();
    const requestKey = /^[a-zA-Z0-9-]{16,100}$/.test(requestKeyRaw) ? requestKeyRaw : '';
    const requestBodyHash = sha256(body);
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
        error: `${config.label}尚無法可信建立獨立比分分布，已依 fail-closed 停止模型EV：${config.statusLabel}`,
        analysisReadiness: config.analysisReadiness || null,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    const requestedGame = sanitizeGame(body.game);
    if (!requestedGame || !Array.isArray(body.markets)) return NextResponse.json({ ok: false, error: '缺少或無效的賽事／盤口資料' }, { status: 400 });
    if (analysisPitProductionPersistenceRequired() && !analysisPitDatabaseConfigured()) {
      return NextResponse.json({
        ok: false,
        code: 'PIT_PERSISTENCE_REQUIRED',
        error: 'Production缺少DATABASE_URL，永久PIT不可用，已停止分析',
        pitPersistence: {
          status: 'FAILED', confirmed: false, required: true,
          reason: 'DATABASE_NOT_CONFIGURED', snapshotId: null,
        },
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const priorRequest = requestKey ? requestResultCache.get(requestKey) : null;
    const priorFreshness = assessAnalysisCacheEntryV110(priorRequest, {
      league,
      gamePk: requestedGame.gamePk,
      maxAgeMs: ANALYSIS_IDEMPOTENCY_CACHE_TTL_MS,
    });
    const priorPitConfirmed = priorRequest?.payload?.pitPersistence?.confirmed === true;
    if (priorRequest?.bodyHash === requestBodyHash
      && priorFreshness.fresh
      && (priorPitConfirmed || !analysisPitDatabaseConfigured())) {
      assertLeagueGamePrestart(league, priorRequest.payload.game);
      const pitPersistence = priorPitConfirmed ? priorRequest.payload.pitPersistence : {
        status: 'UNAVAILABLE',
        confirmed: false,
        required: false,
        reason: 'DATABASE_NOT_CONFIGURED',
        snapshotId: priorRequest.payload?.analysis?.pitSnapshotId || null,
      };
      const safePayload = enforceAnalysisModeSafety(
        { ...priorRequest.payload, pitPersistence },
        priorRequest.payload.context || {},
      );
      assertLeagueGamePrestart(league, priorRequest.payload.game);
      return NextResponse.json(safePayload, { headers: {
        'Cache-Control': 'no-store',
        'X-Analysis-Request-Resume': 'HIT',
      } });
    }
    if (priorRequest) requestResultCache.delete(requestKey);
    const { game } = await resolveLeagueGame(league, requestedGame);
    assertLeagueGamePrestart(league, game);

    const suppliedMarkets = await prepareMarketRows(league, game, body.markets, MAX_SUPPLIED_MARKET_ROWS);
    const readerProvenance = await verifiedReaderProvenance(league, game, body.readerProvenance, suppliedMarkets);
    const verificationMarkets = await prepareMarketRows(league, game, body.verificationMarkets, MAX_VERIFICATION_MARKET_ROWS);
    const markets = applyIndependentMarketVerification(suppliedMarkets, verificationMarkets);
    const previousMarkets = await prepareMarketRows(league, game, body.previousMarkets, MAX_PREVIOUS_MARKET_ROWS);
    const marketCoverage = assessEightDirectionMarketCoverage(markets, game);
    const activeMarkets = marketCoverage.validRows;

    const settings = {
      rebateRate: TAIWAN_CREDIT_REBATE_RATE,
      candidateThreshold: 7.2,
      strongestThreshold: 8.5,
      expertMode: 'off',
    };
    const starterEvidence = league === 'MLB' ? null : extractAsianStarterEvidence(suppliedMarkets, game);
    const context = await withLeagueProviderTimeout(
      league,
      buildLeagueGameContext(league, game, { starterEvidence }),
      league === 'MLB' ? 30000 : 75000,
    );
    if (league === 'MLB') await persistMlbAdvancedSnapshotBestEffort(game, context);
    if (!context?.coreModelable || context?.dataGateV10?.passedForShadowScore !== true) {
      const blocking = Array.isArray(context?.dataGateV10?.blocking) ? context.dataGateV10.blocking : [];
      const gateLabels = {
        probableOrProjectedStarters: '先發投手或可信輪值預估',
        officialOrProjectedLineups: '正式打線或可信打線預估',
        bullpenUsageProjection: '牛棚使用量與疲勞預估',
        officialScheduleIdentityOrRecentLeagueResults: '官方賽程識別或近期完賽賽果',
      };
      const detail = blocking.length ? blocking.map(name => gateLabels[name] || name).join('、') : '核心資料Gate未通過';
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
      markets,
      versions,
      calculationSettings: settings,
      auxiliaryInput: { previousMarkets, contractRule: readerProvenance },
    });
    const signature = analysisContractSignature(league, game, markets);
    const cacheKey = analysisCacheKey(league, game.gamePk, fingerprints.inputHash);
    const cached = responseCache.get(cacheKey);
    const cacheFreshness = assessAnalysisCacheEntryV110(cached, {
      league,
      gamePk: game.gamePk,
      maxAgeMs: ANALYSIS_RESPONSE_CACHE_TTL_MS,
    });
    if (cacheFreshness.fresh && analysisCachePayloadMatches(cached, { league, game, fingerprints, signature })) {
      assertLeagueGamePrestart(league, game);
      const safePayload = enforceAnalysisModeSafety(cached.payload, cached.payload.context || frozenContext);
      const cachedPitConfirmed = safePayload?.pitPersistence?.confirmed === true;
      if (cachedPitConfirmed || !analysisPitDatabaseConfigured()) {
        if (!cachedPitConfirmed) safePayload.pitPersistence = {
          status: 'UNAVAILABLE',
          confirmed: false,
          required: false,
          reason: 'DATABASE_NOT_CONFIGURED',
          snapshotId: safePayload?.analysis?.pitSnapshotId || null,
        };
        requestCacheSet(requestKey, requestBodyHash, safePayload);
        assertLeagueGamePrestart(league, game);
        return NextResponse.json(safePayload, { headers: {
          'Cache-Control': 'no-store',
          'X-Analysis-Cache': 'HIT',
          'X-Distribution-Cache': 'RESPONSE-HIT',
          'X-Reprice-Snapshot': 'COMPACT-REBUILDABLE',
        } });
      }

      // A response may have been cached while Neon was unavailable. Rebuild the
      // exact signed distribution and retry the missing immutable PIT write
      // before the cached analysis is allowed to leave the API again.
      const cachedFrozenContext = safePayload?.repriceSnapshot?.frozenContext || frozenContext;
      const retryDistribution = getOrBuildGameDistribution({
        league,
        gamePk: game.gamePk,
        coreFingerprint: fingerprints.coreFingerprint,
        modelVersion: versions.modelVersion,
        rulesVersion: versions.rulesVersion,
        build: () => buildDistributionSnapshot({ context: cachedFrozenContext }),
      }).snapshot;
      if (retryDistribution?.distributionId === safePayload?.analysis?.distributionId
        && retryDistribution?.distributionHash === safePayload?.analysis?.distributionHash) {
        assertLeagueGamePrestart(league, game);
        const pitPersistence = await persistAnalysisPitSnapshotForResponse({
          league,
          game,
          frozenContext: cachedFrozenContext,
          analysis: safePayload.analysis,
          distributionSnapshot: retryDistribution,
          repriceSnapshot: safePayload.repriceSnapshot,
          versions,
          markets,
          previousMarkets,
          readerSnapshot: readerProvenance,
        }, { requiredWhenConfigured: true });
        safePayload.pitPersistence = pitPersistence;
        assertLeagueGamePrestart(league, game);
        cacheSet(cacheKey, signature, safePayload);
        if (pitPersistence.required && !pitPersistence.confirmed) {
          assertLeagueGamePrestart(league, game);
          return NextResponse.json(
            enforceUnconfirmedPitShadowSafety(safePayload, pitPersistence),
            { headers: {
              'Cache-Control': 'no-store',
              'X-Analysis-Cache': 'HIT-PIT-DEGRADED',
              'X-Distribution-Cache': 'RESPONSE-HIT',
              'X-PIT-Persistence': 'UNCONFIRMED-SHADOW-ONLY',
            } },
          );
        }
        requestCacheSet(requestKey, requestBodyHash, safePayload);
        assertLeagueGamePrestart(league, game);
        return NextResponse.json(safePayload, { headers: {
          'Cache-Control': 'no-store',
          'X-Analysis-Cache': 'HIT-PIT-RETRIED',
          'X-Distribution-Cache': 'RESPONSE-HIT',
          'X-Reprice-Snapshot': 'COMPACT-REBUILDABLE',
        } });
      }
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
    assertLeagueGamePrestart(league, game);
    const deterministicCore = enforceAnalysisModeSafety(
      finalizeDeterministicAnalysis({ analysis: preliminary, game, settings }),
      frozenContext,
    );
    const deterministic = attachEightDirectionContract(deterministicCore, marketCoverage, game, readerProvenance);
    const distributionSnapshot = deterministic.distributionSnapshot;
    const { distributionSnapshot: omitted, ...analysisWithoutDistribution } = deterministic;
    const analysisAsOf = new Date().toISOString();
    const lineAsOf = markets.map(row => row.lineAsOf).filter(Boolean).sort().at(-1)
      || readerProvenance?.lineAsOf
      || analysisAsOf;
    const pitSnapshotId = analysisPitSnapshotId({
      league,
      gamePk: game.gamePk,
      analysisType: 'FULL',
      inputHash: fingerprints.inputHash,
    });
    const finalized = {
      ...analysisWithoutDistribution, ...fingerprints, contractSignature: signature,
      analysisType: 'FULL', dataVersion: DATA_VERSION,
      dataAsOf: frozenContext.fetchedAt || analysisAsOf, lineAsOf, analysisAsOf, snapshotId: fingerprints.inputHash,
      pitSnapshotId,
    };
    // The full frozen distribution can approach one megabyte for an Asian game.
    // Sending four of them to a phone at once made Safari terminate otherwise
    // successful 200 responses. Keep the signed inputs and distribution hash;
    // /api/reprice deterministically rebuilds and verifies the same distribution.
    const unsignedRepriceSnapshot = compactRepriceSnapshot({
      frozenContext, coreFingerprint: fingerprints.coreFingerprint, priceFingerprint: fingerprints.priceFingerprint,
      inputHash: fingerprints.inputHash, contractSignature: signature,
      analysisType: 'FULL', pitSnapshotId,
      calculationSettings: fingerprints.calculationPayload,
      auxiliaryInput: fingerprints.auxiliaryPayload,
      distributionId: finalized.distributionId, distributionHash: finalized.distributionHash,
      dataAsOf: finalized.dataAsOf, simulationsPerScenario: finalized.scenarioSummary?.simulationsPerScenario, versions,
    });
    const repriceSnapshot = await signRepriceSnapshot(
      league,
      game,
      enforceAnalysisModeSafety(unsignedRepriceSnapshot, frozenContext),
    );
    const provider = getLeagueProvider(league);
    const payload = {
      ok: true, league, game, context: compactAnalysisContext(frozenContext), analysis: finalized, repriceSnapshot,
      analysisMode: provider.analysisMode, betEligible: provider.betEligible,
      openMarkets: [...new Set(activeMarkets.map(row => row.market))],
      blockedMarkets: marketCoverage.blockedMarkets,
      unopenedMarkets: marketCoverage.unopenedMarkets,
    };
    const safePayload = enforceAnalysisModeSafety(payload, frozenContext);
    assertLeagueGamePrestart(league, game);
    const pitPersistence = await persistAnalysisPitSnapshotForResponse({
      league,
      game,
      frozenContext,
      analysis: finalized,
      distributionSnapshot,
      repriceSnapshot,
      versions,
      markets,
      previousMarkets,
      readerSnapshot: readerProvenance,
    }, { requiredWhenConfigured: true });
    safePayload.pitPersistence = pitPersistence;
    assertLeagueGamePrestart(league, game);
    cacheSet(cacheKey, signature, safePayload);
    if (pitPersistence.required && !pitPersistence.confirmed) {
      assertLeagueGamePrestart(league, game);
      return NextResponse.json(
        enforceUnconfirmedPitShadowSafety(safePayload, pitPersistence),
        { headers: {
          'Cache-Control': 'no-store',
          'X-Analysis-Cache': 'MISS-PIT-DEGRADED',
          'X-Distribution-Cache': cachedDistribution.cacheStatus,
          'X-PIT-Persistence': 'UNCONFIRMED-SHADOW-ONLY',
        } },
      );
    }
    requestCacheSet(requestKey, requestBodyHash, safePayload);
    assertLeagueGamePrestart(league, game);
    return NextResponse.json(safePayload, { headers: {
      'Cache-Control': 'no-store',
      'X-Analysis-Cache': 'MISS',
      'X-Distribution-Cache': cachedDistribution.cacheStatus,
      'X-Reprice-Snapshot': 'COMPACT-REBUILDABLE',
    } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      ...(error?.code ? { code: String(error.code) } : {}),
      error: String(error?.message || error),
    }, { status: Number(error?.status) || 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
