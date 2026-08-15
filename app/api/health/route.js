import { NextResponse } from 'next/server';
import { appPasswordConfigured, sessionSecretConfigured, siteAuthConfigured } from '../../../lib/security.js';
import { MARKET_INTEGRITY_VERSION, marketIntegrityConfigured, SNAPSHOT_INTEGRITY_VERSION } from '../../../lib/market-integrity-v1.js';
import { OFFICIAL_SCHEDULE_VERSION } from '../../../lib/official-schedule-v1.js';
import { MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';
import { BATCH_VERSION } from '../../../lib/batch.js';
import { FINAL_ENGINE_VERSION, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer.js';
import { SCORE_FORMULA_VERSION, SCORE_POLICY_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION } from '../../../lib/taiwan-settlement-v9.js';
import { DATA_VERSION, REPRICE_VERSION } from '../../../lib/snapshot-v9.js';
import { ANALYSIS_CACHE_VERSION } from '../../../lib/analysis-cache-v9.js';
import { readerPairingConfigured } from '../../../lib/reader-auth-v2.js';
import { loadReaderSnapshot, readerSnapshotStatus, READER_STORE_VERSION } from '../../../lib/reader-store-v2.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const readerSnapshot = await loadReaderSnapshot();
  const readerStatus = readerSnapshotStatus(readerSnapshot);
  return NextResponse.json({
    ok: true,
    version: '9.4.3',
    modelVersion: MODEL_VERSION,
    rulesVersion: RULES_VERSION,
    dataVersion: DATA_VERSION,
    visionImportEnabled: false,
    batchVersion: BATCH_VERSION,
    finalEngineVersion: FINAL_ENGINE_VERSION,
    scoreFormulaVersion: SCORE_FORMULA_VERSION,
    scorePolicyVersion: SCORE_POLICY_VERSION,
    settlementRuleVersion: SETTLEMENT_RULE_VERSION,
    uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
    repriceVersion: REPRICE_VERSION,
    analysisCacheVersion: ANALYSIS_CACHE_VERSION,
    referenceLinesEnabled: false,
    creditLinesProvider: 'TAI888_READER_AUTO',
    readerPairingConfigured: readerPairingConfigured(),
    readerStoreVersion: READER_STORE_VERSION,
    readerAvailable: readerStatus.available,
    readerFresh: readerStatus.fresh,
    readerAgeSeconds: readerStatus.ageSeconds,
    readerMatchedGameCount: readerSnapshot?.matchedGameCount || 0,
    readerPayloadHash: readerSnapshot?.payloadHash || null,
    deterministicScoring: true,
    gptScoringEnabled: false,
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    authConfigured: siteAuthConfigured(),
    appPasswordConfigured: appPasswordConfigured(),
    sessionSecretConfigured: sessionSecretConfigured(),
    marketIntegrityConfigured: marketIntegrityConfigured(),
    marketIntegrityVersion: MARKET_INTEGRITY_VERSION,
    snapshotIntegrityVersion: SNAPSHOT_INTEGRITY_VERSION,
    officialScheduleVersion: OFFICIAL_SCHEDULE_VERSION,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    time: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
