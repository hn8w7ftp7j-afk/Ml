import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET, POST } from '../app/api/auth/route.js';
import { middleware } from '../middleware.js';
import { createSessionToken, SESSION_MAX_AGE_SECONDS, verifySessionToken } from '../lib/security.js';
process.env.APP_PASSWORD = 'test-only-password';
process.env.SESSION_SECRET = 'test-only-stable-signing-secret';
process.env.NODE_ENV = 'production';
const origin = 'https://example.com';
const post = body => new NextRequest(`${origin}/api/auth`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const login = await POST(post({ password: process.env.APP_PASSWORD }));
assert.equal(login.status, 200);
const cookie = login.cookies.get('mlb_session');
assert.equal(cookie.maxAge, SESSION_MAX_AGE_SECONDS);
assert.equal(cookie.httpOnly, true);
assert.equal(cookie.secure, true);
assert.equal(await verifySessionToken(cookie.value), true);
const request = (token, path = '/api/auth') => new NextRequest(`${origin}${path}`, { headers: { cookie: `mlb_session=${encodeURIComponent(token)}` } });
assert.equal((await (await GET(request(cookie.value))).json()).authenticated, true);
assert.equal((await GET(request(cookie.value))).cookies.get('mlb_session'), undefined);
const legacy = await createSessionToken(7 * 24 * 3600);
const renewed = await GET(request(legacy));
assert.equal(renewed.cookies.get('mlb_session').maxAge, SESSION_MAX_AGE_SECONDS);
assert.equal((await middleware(request(legacy, '/'))).cookies.get('mlb_session').maxAge, SESSION_MAX_AGE_SECONDS);
for (const path of ['/login', '/login?next=%2F%2Fevil.example', '/login?next=%2F%09%2Fevil.example', '/login?next=%2Flogin']) {
  assert.equal((await middleware(request(legacy, path))).headers.get('location'), `${origin}/`);
}
const now = Date.now;
try {
  Date.now = () => now() + 31 * 24 * 3600 * 1000;
  assert.ok((await GET(request(cookie.value))).cookies.get('mlb_session'));
  Date.now = () => now() + 401 * 24 * 3600 * 1000;
  const expired = await GET(request(cookie.value));
  assert.equal((await expired.json()).authenticated, false);
  assert.equal(expired.cookies.get('mlb_session'), undefined);
} finally { Date.now = now; }
const forged = await GET(request(`${legacy}x`));
assert.equal((await forged.json()).authenticated, false);
assert.equal(forged.cookies.get('mlb_session'), undefined);
assert.equal((await POST(post({ action: 'logout' }))).cookies.get('mlb_session').maxAge, 0);
assert.equal((await POST(post({ password: 'wrong' }))).status, 401);
console.log('Persistent login, legacy migration, renewal, expiry, tampering and logout passed');
