import assert from 'node:assert/strict';
import { GET } from '../app/api/pit-model-audit/route.js';
import { createSessionToken } from '../lib/security.js';
process.env.APP_PASSWORD = 'test-only';
process.env.SESSION_SECRET = 'test-only-abcdefghijklmnopqrstuvwxyz0123456789';
const token = await createSessionToken();
const request = (id, auth = true) => new Request('http://localhost/api/pit-model-audit?snapshotId=' + encodeURIComponent(id), { headers: auth ? { cookie: `mlb_session=${token}` } : {} });
assert.equal((await GET(request('', false))).status, 401);
for (const id of ['', 'MLB:1:FULL:bad', 'NBA:1:FULL:' + 'a'.repeat(64), 'NPB:9999999999999999:FULL:' + 'a'.repeat(64)]) {
  assert.equal((await GET(request(id))).status, 400);
}
for (const league of ['NPB', 'KBO', 'CPBL']) {
  const response = await GET(request(`${league}:2247585195061026:FULL:${'a'.repeat(64)}`));
  assert.equal(response.status, 409, 'valid Asian IDs reach the store; absent fixture remains unavailable, never PASS');
}
console.log('PIT audit route: authentication, safe integer, league isolation and Asian routing boundaries passed');
