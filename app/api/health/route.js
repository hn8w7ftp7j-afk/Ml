import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    version: '3.0.0',
    aiGatewayConfigured: Boolean(process.env.AI_GATEWAY_API_KEY),
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    environment: process.env.VERCEL_ENV || null,
    time: new Date().toISOString(),
  });
}
