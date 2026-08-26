import { NextResponse } from 'next/server';
import { APP_VERSION } from '../../../lib/app-version.js';
import { appPasswordConfigured, requestIsAuthenticated, sessionSecretConfigured, siteAuthConfigured } from '../../../lib/security.js';
import { MARKET_INTEGRITY_VERSION, marketIntegrityConfigured, SNAPSHOT_INTEGRITY_VERSION } from '../../../lib/market-integrity-v1.js';
import { OFFICIAL_SCHEDULE_VERSION } from '../../../lib/official-schedule-v1.js';
import {
  MODEL_EV_FORMULA_VERSION,
  MODEL_VERSION,
  ROBUST_EV_VERSION,
  RULES_VERSION,
} from '../../../lib/analysis-v11.js';
import { EV_CALIBRATION_V103_VERSION } from '../../../lib/ev-calibration-v103.js';
import { MLB_CONTEXT_V13_VERSION } from '../../../lib/mlb-context-v13.js';
import { BATCH_VERSION } from '../../../lib/batch.js';
import {
  FINAL_ENGINE_VERSION,
  FORMAL_SCORING_ENABLED,
  SCORE_RELEASE_STATUS,
  UNCERTAINTY_SET_VERSION,
} from '../../../lib/deterministic-finalizer-v10.js';
import { SCORE_FORMULA_VERSION, SCORE_POLICY_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION } from '../../../lib/taiwan-settlement-v9.js';
import { BET_PRICE_COMPARISON_VERSION } from '../../../lib/bet-price-comparison.js';
import { BET_STATS_VERSION } from '../../../lib/bet-stats.js';
import { BET_SETTLEMENT_SERVICE_VERSION } from '../../../lib/bet-settlement-service.js';
import { DATA_VERSION, REPRICE_VERSION } from '../../../lib/snapshot-v9.js';
import { ANALYSIS_CACHE_VERSION } from '../../../lib/analysis-cache-v9.js';
import { GAME_DISTRIBUTION_CACHE_VERSION } from '../../../lib/game-distribution-cache-v1.js';
import { readerPairingConfigured } from '../../../lib/reader-auth-v2.js';
import { loadReaderSnapshot, readerSnapshotStatus, READER_STORE_VERSION } from '../../../lib/reader-store-v2.js';
import { LEAGUE_REGISTRY_VERSION, publicLeagueRegistry } from '../../../lib/leagues.js';
import { REFERENCE_LINES_VERSION, referenceProviderStatus } from '../../../lib/reference-lines.js';
import { ANALYSIS_REFRESH_POLICY_V109_VERSION } from '../../../lib/analysis-refresh-policy-v109.js';
import { CONTINUOUS_CALIBRATION_V109_VERSION } from '../../../lib/pit-continuous-calibration-v109.js';
import { MLB_PRODUCTION_PIT_REPLAY_V109_VERSION } from '../../../lib/mlb-production-pit-replay-v109.js';
import { MLB_ADVANCED_PROMOTION_GATE_V109_VERSION } from '../../../lib/mlb-advanced-promotion-gate-v109.js';
import {
  analysisPitDatabaseConfigured,
  analysisPitProductionPersistenceRequired,
} from '../../../lib/analysis-pit-snapshot-store-v1.js';
import { DIRECTION_SLOT_CONTRACT_VERSION } from '../../../lib/direction-slots-v1.js';
import {
  ANALYSIS_DIRECTION_HISTORY_VERSION,
  ANALYSIS_DIRECTION_SETTLEMENT_VERSION,
  analysisDirectionHistoryDatabaseConfigured,
} from '../../../lib/analysis-direction-history-v1.js';
import { ASIAN_LEAGUE_READINESS_VERSION } from '../../../lib/asian-league-readiness.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const version = APP_VERSION;
  if (!(await requestIsAuthenticated(request))) {
    return NextResponse.json({ ok: true, alive: true, version }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const databaseConfigured = analysisPitDatabaseConfigured();
  const authConfigured = siteAuthConfigured();
  const pairingConfigured = readerPairingConfigured();
  const integrityConfigured = marketIntegrityConfigured();
  const productionPitRequired = analysisPitProductionPersistenceRequired();
  const directionHistoryDatabaseConfigured = analysisDirectionHistoryDatabaseConfigured();
  const cronSecretConfigured = Boolean(String(process.env.CRON_SECRET || '').trim());
  const readinessReasons = [
    ...(!databaseConfigured ? ['PIT資料庫未設定'] : []),
    ...(!authConfigured ? ['網站驗證未完整設定'] : []),
    ...(!pairingConfigured ? ['Reader配對密鑰未設定'] : []),
    ...(!integrityConfigured ? ['市場簽章密鑰未設定'] : []),
    ...(!cronSecretConfigured ? ['自動結算CRON_SECRET未設定'] : []),
  ];
  const ready = readinessReasons.length === 0;
  const readerSnapshot = await loadReaderSnapshot('MLB');
  const readerStatus = readerSnapshotStatus(readerSnapshot, Date.now(), 'MLB');
  const referenceStatus = referenceProviderStatus();
  return NextResponse.json({
    ok: ready,
    alive: true,
    ready,
    readinessBasis: 'CONFIGURATION_ONLY_PERSISTENCE_CONFIRMED_PER_ANALYSIS',
    readinessReasons,
    version,
    leagueRegistryVersion: LEAGUE_REGISTRY_VERSION,
    leagues: publicLeagueRegistry(),
    modelVersion: MODEL_VERSION,
    modelEvFormulaVersion: MODEL_EV_FORMULA_VERSION,
    robustEvVersion: ROBUST_EV_VERSION,
    mlbContextVersion: MLB_CONTEXT_V13_VERSION,
    rulesVersion: RULES_VERSION,
    evCalibrationVersion: EV_CALIBRATION_V103_VERSION,
    dataVersion: DATA_VERSION,
    visionImportEnabled: false,
    batchVersion: BATCH_VERSION,
    finalEngineVersion: FINAL_ENGINE_VERSION,
    scoreFormulaVersion: SCORE_FORMULA_VERSION,
    scorePolicyVersion: SCORE_POLICY_VERSION,
    settlementRuleVersion: SETTLEMENT_RULE_VERSION,
    betPriceComparisonVersion: BET_PRICE_COMPARISON_VERSION,
    betStatsVersion: BET_STATS_VERSION,
    betSettlementServiceVersion: BET_SETTLEMENT_SERVICE_VERSION,
    uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
    repriceVersion: REPRICE_VERSION,
    analysisCacheVersion: ANALYSIS_CACHE_VERSION,
    gameDistributionCacheVersion: GAME_DISTRIBUTION_CACHE_VERSION,
    directionSlotContractVersion: DIRECTION_SLOT_CONTRACT_VERSION,
    analysisDirectionHistoryVersion: ANALYSIS_DIRECTION_HISTORY_VERSION,
    analysisDirectionSettlementVersion: ANALYSIS_DIRECTION_SETTLEMENT_VERSION,
    asianLeagueReadinessVersion: ASIAN_LEAGUE_READINESS_VERSION,
    referenceLinesEnabled: false,
    referenceConsensusReady: false,
    externalMarketAuditEnabled: false,
    anyReferenceProviderConfigured: referenceStatus.anyConfigured,
    referenceLinesVersion: REFERENCE_LINES_VERSION,
    referenceProviders: referenceStatus.providers,
    referenceConsensusPolicy: 'DISABLED_ANALYSIS_MODEL_ONLY',
    creditLinesProvider: 'TAI888_READER_AUTO',
    readerPairingConfigured: pairingConfigured,
    readerStoreVersion: READER_STORE_VERSION,
    readerAvailable: readerStatus.available,
    readerFresh: readerStatus.fresh,
    readerAgeSeconds: readerStatus.ageSeconds,
    readerRawGameCount: readerSnapshot?.rawGameCount || 0,
    readerMatchedGameCount: readerSnapshot?.matchedGameCount || 0,
    readerUnopenedGameCount: readerSnapshot?.unopenedGameCount || 0,
    readerScheduleGameCount: readerSnapshot?.scheduleGameCount || 0,
    readerPayloadHash: readerSnapshot?.payloadHash || null,
    deterministicScoring: true,
    formalScoringEnabled: FORMAL_SCORING_ENABLED,
    scoreReleaseStatus: SCORE_RELEASE_STATUS,
    gptScoringEnabled: false,
    actualBetLedgerEnabled: true,
    currentPriceComparisonEnabled: true,
    automaticSettlementEnabled: true,
    continuousCalibrationVersion: CONTINUOUS_CALIBRATION_V109_VERSION,
    productionPitReplayVersion: MLB_PRODUCTION_PIT_REPLAY_V109_VERSION,
    coreRefreshPolicyVersion: ANALYSIS_REFRESH_POLICY_V109_VERSION,
    advancedPromotionGateVersion: MLB_ADVANCED_PROMOTION_GATE_V109_VERSION,
    databaseConfigured,
    directionHistoryDatabaseConfigured,
    cronSecretConfigured,
    analysisDirectionAutomaticSettlementEnabled: directionHistoryDatabaseConfigured && cronSecretConfigured,
    productionPitRequired,
    authConfigured,
    appPasswordConfigured: appPasswordConfigured(),
    sessionSecretConfigured: sessionSecretConfigured(),
    marketIntegrityConfigured: integrityConfigured,
    marketIntegrityVersion: MARKET_INTEGRITY_VERSION,
    snapshotIntegrityVersion: SNAPSHOT_INTEGRITY_VERSION,
    officialScheduleVersion: OFFICIAL_SCHEDULE_VERSION,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    time: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
