import assert from 'node:assert/strict';
import { GET } from '../app/api/analysis-snapshots/route.js';
import { createSessionToken } from '../lib/security.js';

process.env.APP_PASSWORD = 'local-snapshot-test';
process.env.SESSION_SECRET = 'local-snapshot-test-secret-abcdefghijklmnopqrstuvwxyz';
delete process.env.DATABASE_URL;
delete process.env.DATABASE_V2_URL;
const token = await createSessionToken();
const request = (query, auth = true) => new Request(`http://localhost/api/analysis-snapshots?${new URLSearchParams(query)}`, {
  headers: auth ? { cookie: `mlb_session=${token}` } : {},
});
assert.equal((await GET(request({ league: 'MLB', gamePk: '123' }, false))).status, 401);
for (const query of [{ league: 'NBA', gamePk: '123' }, { league: 'MLB', gamePk: 'null' }, { league: 'MLB', gamePk: '123', before: 'x' }]) {
  const response = await GET(request(query)); assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'no-store');
}
const unavailable = await GET(request({ league: 'MLB', gamePk: '123' }));
assert.equal(unavailable.status, 503); assert.ok(unavailable.headers.get('retry-after'));
assert.doesNotMatch(JSON.stringify(await unavailable.json()), /postgres:\/\/|stack|local-snapshot-test/);
let response;
for (let i = 0; i < 20; i++) response = await GET(request({ league: 'MLB', gamePk: '123' }));
assert.equal(response.status, 429);
console.log('snapshot diagnostic API: auth, scope, no-store, unavailable DB and rate limiting passed');
