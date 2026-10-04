import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./next-route-test-loader.mjs', import.meta.url);
const { NextRequest } = await import('next/server');
const { middleware } = await import('../middleware.js');
const route = await import('../app/api/nba/reader/route.js');
process.env.APP_PASSWORD = 'nba-middleware-local-test';
process.env.SESSION_SECRET = 'nba-middleware-local-session-test-secret';
process.env.READER_PAIR_SECRET = 'nba-middleware-local-reader-test-secret';

const get = new NextRequest('https://example.test/api/nba/reader?date=2026-10-05');
assert.equal((await middleware(get)).headers.get('x-middleware-next'), '1', 'NBA Reader must reach route authentication');
assert.equal((await route.GET(get)).status, 401, 'GET still requires private site login');
const post = new NextRequest('https://example.test/api/nba/reader', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, body: '{}' });
assert.equal((await middleware(post)).headers.get('x-middleware-next'), '1', 'Extension POST has no site cookie and must reach Reader token guard');
assert.equal((await route.POST(post)).status, 401, 'Unpaired extension must still be rejected');
assert.equal((await middleware(new NextRequest('https://example.test/api/nba?view=schedule'))).status, 401, 'Other NBA private APIs remain guarded');
assert.equal((await middleware(new NextRequest('https://example.test/api/reader/ingest', { method: 'POST' }))).headers.get('x-middleware-next'), '1', 'Existing baseball intake remains reachable');
console.log('NBA Reader middleware integration: extension intake reachable, route token guard and private NBA GET isolation PASS');
