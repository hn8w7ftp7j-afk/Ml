import assert from 'node:assert/strict';
import { register } from 'node:module';
// Only the route boundary is isolated here. The companion service test executes
// the real normalizer, source adapter, stores and queries against PostgreSQL.
const fake = 'data:text/javascript,' + encodeURIComponent('export async function readSoccerOfficialMarketCoverage(input){return globalThis.__coverageRoute(input);}');
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,n){if(s.endsWith('/lib/soccer/official-market-coverage.js')&&c.parentURL.includes('/app/api/soccer/market-coverage/'))return {url:${JSON.stringify(fake)},shortCircuit:true};return n(s,c);}`), import.meta.url);
register('./next-route-test-loader.mjs', import.meta.url);
process.env.APP_PASSWORD = 'coverage-route-fixture'; process.env.SESSION_SECRET = 'coverage-route-session';
globalThis.fetch = async () => { throw Error('unexpected network'); };
const { GET, POST } = await import('../app/api/soccer/market-coverage/route.js');
const { createSessionToken } = await import('../lib/security.js');
const cookie = `mlb_session=${await createSessionToken()}`, calls = [];
globalThis.__coverageRoute = async input => { calls.push(input); return { ok: true, report: { league: input.league, date: input.date, formalEligible: false, executable: false } }; };
let ip = 0;
const request = (query = '?league=epl&date=2026-11-10', headers = {}) => new Request(`http://localhost/api/soccer/market-coverage${query}`, { headers: { cookie, 'x-forwarded-for': `coverage-route-${++ip}`, ...headers } });
assert.equal(POST, undefined, 'coverage cannot start a write operation');
assert.equal((await GET(request(undefined, { cookie: '' }))).status, 401);
assert.equal((await GET(request(undefined, { origin: 'https://foreign.example' }))).status, 403);
assert.equal((await GET(request(undefined, { 'sec-fetch-site': 'cross-site' }))).status, 403);
for (const query of ['?league=epl&league=ucl&date=2026-11-10', '?league=epl&date=2026-11-10&raw=true', '?league=epl&date=2026-11-10&cursor=a&cursor=b']) assert.equal((await GET(request(query))).status, 400);
assert.equal(calls.length, 0, 'auth, origin and structural query errors do not access provider or storage');
const success = await GET(request('?league=ucl&date=2026-11-10&cursor=opaque-signed-token'));
assert.equal(success.status, 200); assert.equal(success.headers.get('cache-control'), 'private, no-store'); assert.equal(success.headers.get('x-content-type-options'), 'nosniff');
assert.deepEqual(calls.at(-1), { league: 'ucl', date: '2026-11-10', cursor: 'opaque-signed-token' });
for (const status of [400, 409, 503]) {
  globalThis.__coverageRoute = async () => { throw Object.assign(Error('postgres://private-password@source-private-host'), { status }); };
  const response = await GET(request()), body = await response.json(); assert.equal(response.status, status); assert.equal(body.ok, false);
  assert.equal(body.formalEligible, false); assert.equal(body.executable, false); assert.doesNotMatch(JSON.stringify(body), /private-password|source-private-host|totalReceipts|officialGameCount/);
  if (status === 409) assert.equal(body.code, 'SOCCER_MARKET_COVERAGE_SCOPE_CHANGED');
}
console.log('PASS coverage route boundary: authenticated same-origin GET only, strict duplicate/extra query rejection before reads, exact service scope, private no-store and safe 400/409/503 unknowns');
