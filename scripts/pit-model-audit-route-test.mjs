import assert from 'node:assert/strict';
import { GET } from '../app/api/pit-model-audit/route.js';
import { createSessionToken } from '../lib/security.js';
process.env.APP_PASSWORD = 'test-only';
process.env.SESSION_SECRET = 'test-only-abcdefghijklmnopqrstuvwxyz0123456789';
const token = await createSessionToken();
const request = (id, auth = true) => new Request('http://localhost/api/pit-model-audit?snapshotId=' + encodeURIComponent(id), { headers: auth ? { cookie: `mlb_session=${token}` } : {} });
assert.equal((await GET(request('', false))).status, 401);
for (const id of ['', 'MLB:1:FULL:bad', 'CPBL:1:FULL:' + 'a'.repeat(64)]) {
  assert.equal((await GET(request(id))).status, 400);
}
console.log('PIT audit route: authentication and snapshot identity boundary passed');
