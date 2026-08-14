import { NextResponse } from 'next/server';
import { requestIsAuthenticated, siteAuthConfigured } from './lib/security.js';

const PUBLIC_PATHS = new Set(['/login', '/api/auth', '/api/health', '/api/reader/pair', '/api/reader/ingest', '/api/reader/status']);

export async function middleware(request) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith('/_next/') || pathname === '/favicon.ico') return NextResponse.next();
  if (!siteAuthConfigured()) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ ok: false, error: '網站驗證尚未完整設定' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    return new NextResponse('網站驗證尚未完整設定', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (await requestIsAuthenticated(request)) return NextResponse.next();
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, error: '尚未登入或登入已過期' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const login = new URL('/login', request.url);
  login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
