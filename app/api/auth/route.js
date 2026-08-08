import { NextResponse } from 'next/server';
import { appPasswordConfigured, checkRateLimit, createSessionToken, passwordMatches, rateLimitResponse, readJsonBody, requestIsAuthenticated, validateSameOrigin, originErrorResponse } from '../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  return NextResponse.json({ ok: true, configured: appPasswordConfigured(), authenticated: await requestIsAuthenticated(request) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  try {
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'auth', limit: 12, windowMs: 15 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 8192);
    if (body.action === 'logout') {
      const response = NextResponse.json({ ok: true });
      response.cookies.set('mlb_session', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0 });
      return response;
    }
    if (!appPasswordConfigured()) return NextResponse.json({ ok: false, error: '尚未設定 APP_PASSWORD' }, { status: 503 });
    const password = String(body.password || '').slice(0, 256);
    if (!(await passwordMatches(password))) return NextResponse.json({ ok: false, error: '密碼錯誤' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const maxAge = 60 * 60 * 24 * 30;
    const response = NextResponse.json({ ok: true });
    response.cookies.set('mlb_session', await createSessionToken(maxAge), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge });
    return response;
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: Number(error?.status) || 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
