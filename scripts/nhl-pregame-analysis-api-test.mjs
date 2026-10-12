import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./next-route-test-loader.mjs', import.meta.url);
delete process.env.DATABASE_URL; delete process.env.DATABASE_V2_URL; process.env.VERCEL = '0';
process.env.APP_PASSWORD = 'nhl-pregame-api-test-only'; process.env.SESSION_SECRET = 'nhl-pregame-api-session-test-only';
const { createSessionToken } = await import('../lib/security.js');
const { GET, POST } = await import('../app/api/nhl/analysis/route.js');
const token = await createSessionToken(600);
const request = (method, body, authenticated = true, query = '') => new Request(`https://app.test/api/nhl/analysis${query}`, {
  method, headers: { ...(authenticated ? { cookie: `mlb_session=${token}` } : {}),
    'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.209' },
  ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Authentication, argument validation and empty date recovery must not reach an upstream');
try {
  for (const [method, handler] of [['GET', GET], ['POST', POST]]) {
    assert.equal((await handler(request(method, {}, false, '?date=2026-10-14'))).status, 401);
  }
  for (const query of ['', '?date=2026-02-30', '?date=2026-10-14&date=2026-10-15', '?date=2026-10-14&league=NBA']) {
    const response = await GET(request('GET', null, true, query));
    assert.equal(response.status, 400); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  for (const body of [{}, { league: 'NBA', date: '2026-10-14', gameId: '2026020100' },
    { date: '2026-10-14', gameId: '2026020100', features: { fake: 1 } },
    { date: '2026-10-14', gameId: '2026020100', force: 'true' },
    { date: '2026-10-14', gameId: '2026020000' }]) {
    const response = await POST(request('POST', body));
    assert.equal(response.status, 400); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await response.json()).league, 'NHL');
  }
  const recovered = await GET(request('GET', null, true, '?date=2026-10-14'));
  assert.equal(recovered.status, 200);
  const body = await recovered.json(); assert.equal(body.ok, true); assert.equal(body.league, 'NHL');
  assert.deepEqual(body.analyses, []); assert.equal(body.persistence.persisted, false);
  const start = new Date(Date.now() + 86_400_000); const seasonYear = start.getUTCMonth() >= 6 ? start.getUTCFullYear() : start.getUTCFullYear() - 1;
  const raw = { id: Number(`${seasonYear}020100`), season: Number(`${seasonYear}${seasonYear + 1}`), gameType: 2,
    startTimeUTC: start.toISOString(), gameState: 'FUT', gameScheduleState: 'OK',
    awayTeam: { id: 18, abbrev: 'NSH' }, homeTeam: { id: 14, abbrev: 'TBL' } };
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(start);
  globalThis.fetch = async url => {
    if (String(url).includes(`/gamecenter/${raw.id}/landing`)) return new Response(JSON.stringify(raw), {
      status: 200, headers: { 'Content-Type': 'application/json' } });
    // Missing optional source responses remain missing, without stopping a
    // truthful independent score-only result or claiming durable persistence.
    return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  };
  const analyzed = await POST(request('POST', { league: 'NHL', date, gameId: String(raw.id) }));
  assert.equal(analyzed.status, 200); assert.equal(analyzed.headers.get('Cache-Control'), 'no-store');
  const actual = (await analyzed.json()).analysis;
  assert.equal(actual.mode, 'PREGAME_SHADOW'); assert.equal(actual.gameId, String(raw.id));
  assert.equal(actual.taipeiDate, date); assert.ok(actual.model.expectedGoals.home > 0);
  assert.equal(actual.persistence.persisted, false); assert.equal(actual.readiness.formalRecommendations, false);
  assert.equal(actual.market.robustEV, null); assert.equal(actual.distributionArchive, undefined);
  assert.ok(actual.missingSources.length > 0);
  console.log('NHL pregame API: auth, argument isolation, real handler score analysis, missing sources, no-store and honest durable recovery PASS');
} finally { globalThis.fetch = originalFetch; }
