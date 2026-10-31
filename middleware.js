import { NextResponse } from 'next/server';
import { renewAuthenticatedSession, requestIsAuthenticated, siteAuthConfigured } from './lib/security.js';

const PUBLIC_PATHS = new Set(['/login', '/api/auth', '/api/health', '/api/reader/pair', '/api/reader/ingest', '/api/reader/capture', '/api/reader/status', '/api/nhl/reader', '/api/nba/reader', '/api/cron/mlb-advanced-snapshots', '/api/cron/analysis-direction-settlements', '/api/cron/bet-settlements']);
const PUBLIC_PWA_PATHS = new Set(['/manifest.webmanifest', '/sw.js']);
// Paired extension POST still requires its Reader token and allowed origin.
PUBLIC_PATHS.add('/api/soccer/reader');
// Extension POST has its own device token; GET still requires site login.
PUBLIC_PATHS.add('/api/reader/diagnostics');
// Archive POST authenticates the paired device; its read endpoint requires site login.
PUBLIC_PATHS.add('/api/reader/archive');
PUBLIC_PATHS.add('/api/reader/seen-captures');
// Native cron has no browser session. Its route requires CRON_SECRET; only
// this exact maintenance endpoint skips the unrelated session middleware.
PUBLIC_PATHS.add('/api/cron/nba-maintenance');
// Calibration cron authenticates with its own CRON_SECRET, without a browser session.
PUBLIC_PATHS.add('/api/cron/soccer-calibration');

export async function middleware(request) {
  const { pathname, search } = request.nextUrl;
  if (pathname === '/login' && await requestIsAuthenticated(request)) {
    const next = request.nextUrl.searchParams.get('next') || '/';
    let target = next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')
      ? new URL(next, request.url) : new URL('/', request.url);
    if (target.origin !== new URL(request.url).origin) target = new URL('/', request.url);
    if (target.pathname === '/login') target.pathname = '/';
    return renewAuthenticatedSession(request, NextResponse.redirect(target));
  }
  if (PUBLIC_PATHS.has(pathname)
    || PUBLIC_PWA_PATHS.has(pathname)
    || pathname.startsWith('/icons/')
    || pathname.startsWith('/_next/')
    || pathname === '/favicon.ico') return NextResponse.next();
  if (!siteAuthConfigured()) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ ok: false, error: '網站驗證尚未完整設定' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    return new NextResponse('網站驗證尚未完整設定', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (await requestIsAuthenticated(request)) return renewAuthenticatedSession(request, NextResponse.next());
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, error: '尚未登入或登入已過期' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const login = new URL('/login', request.url);
  login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|\\.well-known/workflow/).*)'],
};
