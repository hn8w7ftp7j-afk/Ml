import assert from 'node:assert/strict';
import { createSessionToken } from '../lib/security.js';
import { GET, POST } from '../app/api/soccer/calibration-shadow/route.js';

process.env.APP_PASSWORD = 'test-only-shadow-password';
process.env.SESSION_SECRET = 'test-only-shadow-site-secret';
for (const key of ['DATABASE_V2_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING']) delete process.env[key];
const siteToken = await createSessionToken(), origin = 'https://mlb-positive-ev.vercel.app';
const request = (method, { suffix = '', authenticated = true, requestOrigin = origin, body } = {}) => new Request(`${origin}/api/soccer/calibration-shadow${suffix}`, {
  method, headers: { origin: requestOrigin, ...(authenticated ? { Cookie: `mlb_session=${siteToken}` } : {}),
    ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
  ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
});
assert.equal((await GET(request('GET', { suffix: '?league=epl', authenticated: false }))).status, 401);
assert.equal((await POST(request('POST', { body: { league: 'epl', action: 'evaluate' }, authenticated: false }))).status, 401);
assert.equal((await POST(request('POST', { body: { league: 'epl', action: 'evaluate' }, requestOrigin: 'https://attacker.invalid' }))).status, 403);
for (const suffix of ['?league=nba', '?league=epl&league=ucl', '?league=epl&candidateHash=forged'])
  assert.equal((await GET(request('GET', { suffix }))).status, 400);
assert.equal((await POST(request('POST', { body: { league: 'epl', action: 'evaluate', result: { home: 3, away: 0 } } }))).status, 400,
  'a signed-in caller still cannot supply a prediction, result, source URL or candidate approval');
assert.equal((await POST(request('POST', { body: '{bad json' }))).status, 400);
const unavailableRead = await GET(request('GET', { suffix: '?league=epl' }));
assert.equal(unavailableRead.status, 503); assert.equal(unavailableRead.headers.get('cache-control'), 'no-store');
const missing = await unavailableRead.json(); assert.equal(missing.ok, false); assert.match(missing.error, /未知/);
assert.equal(missing.report, undefined, 'database failure must not appear as a genuine zero-game report');
const unavailableWrite = await POST(request('POST', { body: { league: 'ucl', action: 'evaluate' } }));
assert.equal(unavailableWrite.status, 503); assert.equal((await unavailableWrite.json()).ok, false);
assert.equal((await POST(request('POST', { body: JSON.stringify({ league: 'epl', action: 'evaluate', padding: 'x'.repeat(1100) }) }))).status, 413);
console.log('PASS calibration shadow routes: login, same-origin, fixed league scope, caller result rejection, body limits, no-store and explicit unknown on database failure');
