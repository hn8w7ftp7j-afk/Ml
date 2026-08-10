import { NextResponse } from 'next/server';
import { appPasswordConfigured } from '../../../lib/security.js';
import { MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';
import { VISION_VERSION } from '../../../lib/vision.js';
import { BATCH_VERSION } from '../../../lib/batch.js';
import { FINAL_ENGINE_VERSION, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer.js';
import { SCORE_FORMULA_VERSION, SCORE_POLICY_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION } from '../../../lib/taiwan-settlement-v9.js';
import { DATA_VERSION, REPRICE_VERSION } from '../../../lib/snapshot-v9.js';
import { REFERENCE_LINES_VERSION, referenceProviderStatus } from '../../../lib/reference-lines.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const referenceLines = referenceProviderStatus();
  return NextResponse.json({
    ok: true,
    version: '9.2.0',
    modelVersion: MODEL_VERSION,
    rulesVersion: RULES_VERSION,
    dataVersion: DATA_VERSION,
    visionVersion: VISION_VERSION,
    batchVersion: BATCH_VERSION,
    finalEngineVersion: FINAL_ENGINE_VERSION,
    scoreFormulaVersion: SCORE_FORMULA_VERSION,
    scorePolicyVersion: SCORE_POLICY_VERSION,
    settlementRuleVersion: SETTLEMENT_RULE_VERSION,
    uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
    repriceVersion: REPRICE_VERSION,
    referenceLinesVersion: REFERENCE_LINES_VERSION,
    referenceLinesConfigured: referenceLines.configured,
    referenceLinesProvider: referenceLines.primary,
    deterministicScoring: true,
    gptScoringEnabled: false,
    aiGatewayConfiguredForVision: Boolean(process.env.AI_GATEWAY_API_KEY),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    authConfigured: appPasswordConfigured(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    time: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
