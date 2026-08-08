import { NextResponse } from 'next/server';
import { appPasswordConfigured, requestIsAuthenticated } from './lib/security.js';

const PUBLIC_PATHS = new Set(['/login', '/api/auth', '/api/health']);

export async function middleware(request) {
  if (!appPasswordConfigured()) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith('/_next/') || pathname === '/favicon.ico') return NextResponse.next();
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
