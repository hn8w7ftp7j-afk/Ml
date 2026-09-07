import assert from 'node:assert/strict';
import { POST } from '../app/api/external-audit/route.js';
import { createSessionToken } from '../lib/security.js';
// Local test credentials only; no production session or upstream network.
process.env.APP_PASSWORD = 'local-test-password';
process.env.SESSION_SECRET = 'local-test-secret-abcdefghijklmnopqrstuvwxyz0123456789';
delete process.env.ODDSPAPI_API_KEY;
delete process.env.ODDS_API_NET_KEY;
const token = await createSessionToken();
const request = (body, extra = {}, auth = true) => new Request('http://localhost/api/external-audit', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { cookie: `mlb_session=${token}` } : {}), ...extra }, body: JSON.stringify(body),
});
assert.equal((await POST(request({}, {}, false))).status, 401);
assert.equal((await POST(request({}, { origin: 'https://foreign.example' }))).status, 403);
assert.equal((await POST(request({ league: '__proto__', date: '2026-09-07' }))).status, 400);
assert.equal((await POST(request({ league: 'NPB', date: '2026-02-30' }))).status, 400);
for (const league of ['CPBL', 'NPB', 'KBO']) {
  const response = await POST(request({ league, date: '2026-09-07' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.status, 'NOT_CONFIGURED');
  assert.equal(body.verified, false);
}
let last;
for (let i = 0; i < 13; i++) last = await POST(request({ league: 'NPB', date: '2026-09-07' }));
assert.equal(last.status, 429);
console.log('external-audit route: authentication, origin, input validation, missing settings and rate limit passed');
