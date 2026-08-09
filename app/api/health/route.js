import { NextResponse } from 'next/server';
import { appPasswordConfigured } from '../../../lib/security.js';
import { MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';
import { EXPERT_VERSION } from '../../../lib/expert.js';
import { VISION_VERSION } from '../../../lib/vision.js';
import { BATCH_VERSION } from '../../../lib/batch.js';
import { SCORE_CONTRACT_VERSION } from '../../../lib/markets.js';
import { FINAL_SCORE_VERSION, FINAL_SCORE_INSTRUCTION_VERSION } from '../../../lib/final-scorer.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    version: '8.4.2',
    modelVersion: MODEL_VERSION,
    rulesVersion: RULES_VERSION,
    expertVersion: EXPERT_VERSION,
    visionVersion: VISION_VERSION,
    batchVersion: BATCH_VERSION,
    scoreContractVersion: SCORE_CONTRACT_VERSION,
    finalScoreVersion: FINAL_SCORE_VERSION,
    finalScoreInstructionVersion: FINAL_SCORE_INSTRUCTION_VERSION,
    configuredScoringModel: process.env.AI_SCORING_MODEL || 'openai/gpt-5-mini',
    aiGatewayConfigured: Boolean(process.env.AI_GATEWAY_API_KEY),
    directOpenAIConfigured: Boolean(process.env.OPENAI_API_KEY),
    authConfigured: appPasswordConfigured(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    time: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
