import assert from 'node:assert/strict';
import { GET, POST } from '../app/api/nba/performance/route.js';
import { createSessionToken } from '../lib/security.js';
process.env.APP_PASSWORD = 'synthetic-nba-performance-test';
process.env.SESSION_SECRET = 'synthetic-nba-performance-test-secret';
const cookie = `mlb_session=${await createSessionToken()}`;
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error('No external/DB calls allowed for rejection paths'); };
const req = (method, query = '', body = {}, authenticated = true, origin = 'http://localhost') => new Request(`http://localhost/api/nba/performance${query}`, {
  method, headers: { ...(authenticated ? { cookie } : {}), origin },
  ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
});
assert.equal((await GET(req('GET', '', {}, false))).status, 401);
assert.equal((await POST(req('POST', '', { action: 'settle' }, false))).status, 401);
assert.equal((await POST(req('POST', '', { action: 'settle' }, true, 'https://other.example'))).status, 403);
for (const query of ['?date=2026-02-30', '?limit=501', '?limit=-1', '?cursor=bad', '?league=MLB', '?limit=1&limit=2']) {
  const rejected = await GET(req('GET', query));
  assert.equal(rejected.status, 400); assert.equal((await rejected.json()).ok, false);
}
assert.equal((await POST(req('POST', '', { action: 'erase' }))).status, 400);
assert.equal((await POST(req('POST', '', { action: 'settle', date: '2026-10-14' }))).status, 400);
assert.equal(calls, 0);
const unavailable = await GET(req('GET'));
assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).code, 'NBA_PERFORMANCE_UNAVAILABLE');
console.log('NBA performance API PASS: auth, origin, cursor/date/limit validation before DB and explicit unavailable response');
