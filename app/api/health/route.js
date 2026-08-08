import { NextResponse } from 'next/server';
import { appPasswordConfigured } from '../../../lib/security.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    version: '4.0.0',
    modelVersion: '保守校準模型-2026-08-v2',
    aiGatewayConfigured: Boolean(process.env.AI_GATEWAY_API_KEY),
    authConfigured: appPasswordConfigured(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    time: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
