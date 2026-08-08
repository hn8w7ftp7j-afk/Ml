import { NextResponse } from 'next/server';
import { appPasswordConfigured } from '../../../lib/security.js';
import { MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    version: '6.1.0',
    modelVersion: MODEL_VERSION,
    rulesVersion: RULES_VERSION,
    aiGatewayConfigured: Boolean(process.env.AI_GATEWAY_API_KEY),
    authConfigured: appPasswordConfigured(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    time: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
