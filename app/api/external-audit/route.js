import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit, rateLimitResponse, validateSameOrigin, originErrorResponse, readJsonBody } from '../../../lib/security.js';
import { inspectSource, SOURCES } from '../../../lib/external-audit.js';
import { inspectSxSource, SX_LEAGUES } from '../../../lib/sx-public-audit.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function POST(request) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'external-audit', limit: 12, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 2000);
    const sx = body?.provider === 'SX_PUBLIC';
    if ((body?.provider != null && !['SX_PUBLIC', 'CONFIGURED'].includes(body.provider)) || !Object.hasOwn(sx ? SX_LEAGUES : SOURCES, body?.league) || typeof body.date !== 'string' || (body.eventId != null && (typeof body.eventId !== 'string' || body.eventId.length > 160))) throw new Error('INVALID_INPUT');
    return NextResponse.json(await (sx ? inspectSxSource : inspectSource)({ league: body.league, date: body.date, eventId: body.eventId || '' }), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: '聯盟、日期或賽事參數錯誤' }, { status: 400 });
  }
}
