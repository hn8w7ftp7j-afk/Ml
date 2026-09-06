// Synthetic contract fixtures only; no request is sent to a live provider.
import assert from 'node:assert/strict';
import { GET } from '../app/api/nba/route.js';
import { createSessionToken } from '../lib/security.js';
import { nbaRequestKey, nbaScreenNeedsRefresh, readNbaScreen, requestNbaScreen, saveNbaScreen, validNbaScreen } from '../lib/nba/client-cache.js';
import { NBA_MODULE_VERSION } from '../lib/nba/config.js';

const originalFetch = globalThis.fetch;
const previousPassword = process.env.APP_PASSWORD;
const previousSecret = process.env.SESSION_SECRET;
process.env.APP_PASSWORD = 'nba-local-integration-fixture';
process.env.SESSION_SECRET = 'nba-local-integration-fixture-secret-not-production';
const cookie = `mlb_session=${await createSessionToken()}`;
let checks = 0;
const test = async (name, action) => { await action(); checks += 1; console.log(`PASS ${name}`); };
const request = (query, auth = true) => new Request(`http://localhost/api/nba?${query}`, { headers: auth ? { cookie } : {} });
const source = { provider: 'ESPN', fetchedAt: new Date().toISOString(), status: 'ready' };
const screen = (data, status = 'ready') => ({ league: 'NBA', moduleVersion: NBA_MODULE_VERSION, status, data, sources: [source], qa: { status: 'WARNING', issues: [] } });
const team = { id: '5', uid: 's:40~l:46~t:5', abbreviation: 'CLE', displayName: 'Cleveland Cavaliers' };
const league = { id: '46', uid: 's:40~l:46', abbreviation: 'NBA', teams: [{ team }] };

try {
  await test('API requires the existing session before fetching providers', async () => {
    let calls = 0; globalThis.fetch = async () => { calls += 1; throw new Error('must not fetch'); };
    assert.equal((await GET(request('view=teams', false))).status, 401);
    assert.equal(calls, 0);
  });
  await test('invalid date, league, ID kind, year and view reject before any source call', async () => {
    let calls = 0; globalThis.fetch = async () => { calls += 1; throw new Error('must not fetch'); };
    for (const query of ['view=schedule&date=2026-02-30', 'view=game&id=nba:espn:team:5', 'view=team&id=nba:espn:player:5', 'view=teams&league=MLB', 'view=history&id=5', 'view=history&id=5&season=', 'view=unknown', 'view=game&id=https://example.com', 'view=history&id=5&season=2026&seasonType=unknown']) {
      assert.equal((await GET(request(query))).status, 400, query);
    }
    assert.equal(calls, 0);
  });
  await test('API normalizes a valid provider payload and exposes no wagering fields', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ sports: [{ id: '40', leagues: [league] }] }), { headers: { 'Content-Type': 'application/json' } });
    const response = await GET(request('view=teams'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.moduleVersion, NBA_MODULE_VERSION);
    assert.equal(body.data.teams[0].id, 'nba:espn:team:5');
    assert.equal(body.sources[0].provider, 'ESPN');
    assert.equal(body.sources[0].publishedAt, null);
    for (const key of ['odds', 'bets', 'weightedEV', 'robustEV', 'rankings', 'recommendation']) assert.equal(Object.hasOwn(body.data, key), false);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
  await test('client keys isolate views, dates, seasons, types and namespaces', () => {
    assert.equal(nbaRequestKey({ date: '2026-04-13', view: 'schedule' }), nbaRequestKey({ view: 'schedule', date: '2026-04-13' }));
    assert.notEqual(nbaRequestKey({ view: 'history', id: '5', season: 2026, seasonType: 'regular' }), nbaRequestKey({ view: 'history', id: '5', season: 2026, seasonType: 'preseason' }));
    assert.equal(validNbaScreen({ key: 'a', version: NBA_MODULE_VERSION, savedAt: Date.now(), result: { league: 'MLB', data: {} } }, 'a'), false);
    assert.equal(validNbaScreen({ key: 'a', version: NBA_MODULE_VERSION, savedAt: Date.now() + 5000, result: screen({}) }, 'a'), false);
  });
  await test('failed and partial refreshes cannot erase successful cached data', () => {
    const key = nbaRequestKey({ view: 'history', id: '5', season: 2025, seasonType: 'regular' });
    const good = screen({ games: [{ id: 'preserved-test-game' }] });
    saveNbaScreen(key, good);
    saveNbaScreen(key, screen({ games: [] }, 'unavailable'));
    assert.deepEqual(readNbaScreen(key), good);
    saveNbaScreen(key, screen({ games: [] }, 'partial'));
    assert.deepEqual(readNbaScreen(key), good);
    saveNbaScreen(key, { ...screen({ games: [] }), qa: { status: 'BLOCK' } });
    assert.deepEqual(readNbaScreen(key), good);
    const empty = screen({ games: [] }, 'empty');
    saveNbaScreen(key, empty);
    assert.deepEqual(readNbaScreen(key), empty, 'verified empty response is meaningful data');
  });
  await test('source age rather than render time controls revalidation', () => {
    const now = Date.now();
    const old = { ...screen({}), updatedAt: new Date(now).toISOString(), sources: [{ fetchedAt: new Date(now - 60001).toISOString() }] };
    assert.equal(nbaScreenNeedsRefresh('view=schedule', old, now), true);
    assert.equal(nbaScreenNeedsRefresh('view=teams', old, now), false);
    assert.equal(nbaScreenNeedsRefresh('view=schedule', { sources: [] }, now), true);
  });
  await test('concurrent reads deduplicate and out-of-order responses stay in their own cache', async () => {
    const resolvers = new Map(); let calls = 0;
    globalThis.fetch = url => { calls += 1; return new Promise(resolve => resolvers.set(url, resolve)); };
    const a = nbaRequestKey({ view: 'schedule', date: '2026-04-01' });
    const b = nbaRequestKey({ view: 'schedule', date: '2026-04-02' });
    const aFirst = requestNbaScreen(a); const aSecond = requestNbaScreen(a); const bFirst = requestNbaScreen(b);
    assert.equal(calls, 2);
    resolvers.get(`/api/nba?${b}`)(new Response(JSON.stringify(screen({ date: '2026-04-02' }))));
    assert.equal((await bFirst).data.date, '2026-04-02');
    resolvers.get(`/api/nba?${a}`)(new Response(JSON.stringify(screen({ date: '2026-04-01' }))));
    await Promise.all([aFirst, aSecond]);
    assert.equal(readNbaScreen(a).data.date, '2026-04-01');
    assert.equal(readNbaScreen(b).data.date, '2026-04-02');
  });
  await test('session expiry and unexpected league responses produce actionable errors', async () => {
    globalThis.fetch = async () => new Response('{"error":"expired"}', { status: 401 });
    await assert.rejects(requestNbaScreen('view=game&id=1'), /登入已過期/);
    globalThis.fetch = async () => new Response('{"league":"MLB","data":{}}');
    await assert.rejects(requestNbaScreen('view=game&id=2'), /資料識別不符/);
  });
  await test('invalid JSON and incompatible module versions never enter the cache', async () => {
    globalThis.fetch = async () => new Response('<html>upstream failure</html>', { status: 502 });
    await assert.rejects(requestNbaScreen('view=game&id=3'), /回應格式異常/);
    globalThis.fetch = async () => new Response(JSON.stringify({ ...screen({}), moduleVersion: 'incompatible' }));
    await assert.rejects(requestNbaScreen('view=game&id=4'), /資料版本已更新/);
    assert.equal(readNbaScreen('view=game&id=4'), null);
  });
  console.log(`NBA API/client integration: ${checks} checks passed.`);
} finally {
  globalThis.fetch = originalFetch;
  if (previousPassword === undefined) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = previousPassword;
  if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
}
