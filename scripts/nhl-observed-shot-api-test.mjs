import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { register } from 'node:module';

register('./next-route-test-loader.mjs', import.meta.url);
delete process.env.DATABASE_URL;
delete process.env.DATABASE_V2_URL;
process.env.VERCEL = '0';
process.env.APP_PASSWORD = 'nhl-observed-api-local-test-only';
process.env.SESSION_SECRET = 'nhl-observed-api-local-session-test-only';

const { createSessionToken } = await import('../lib/security.js');
const { nhlPersistenceConfigured } = await import('../lib/nhl/store.js');
const { scoreNhlObservedGameResearch } = await import('../lib/nhl/shot-research.js');
const { nhlFrozenShotResearchArtifacts } = await import('../lib/nhl/shot-research-frozen.js');
const { GET } = await import('../app/api/nhl/route.js');
assert.equal(nhlPersistenceConfigured(), false);
const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/nhl/${name}`, import.meta.url), 'utf8'));
const landing = fixture('landing-2023020001.json');
const pbp = fixture('pbp-2023020001.json');
const artifacts = nhlFrozenShotResearchArtifacts();
const session = await createSessionToken(600);
const expired = await createSessionToken(-1);
const previousFetch = globalThis.fetch;
let calls = []; let groups = 0;
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function mock(responder) {
  calls = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    // No real network, database, wagering, Reader or optional detail requests.
    assert.match(target, /^https:\/\/api-web\.nhle\.com\/v1\/gamecenter\/\d{10}\/(?:landing|play-by-play)$/);
    calls.push(target);
    return responder(target, options);
  };
}
function request(query, { authenticated = true, token = session } = {}) {
  return new Request(`https://test.invalid/api/nhl?action=observed-shot-research${query ? `&${query}` : ''}`, {
    headers: { 'x-forwarded-for': '203.0.113.219', ...(authenticated ? { cookie: `mlb_session=${encodeURIComponent(token)}` } : {}) },
  });
}
async function checked(query, status, options) {
  const result = await GET(request(query, options));
  assert.equal(result.status, status, query);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  const body = await result.json();
  if (status !== 401) assert.equal(body.league, 'NHL');
  return body;
}
async function test(name, run) { await run(); groups++; console.log(`PASS ${name}`); }
// These explicitly synthetic 2026 games exercise post-training request logic.
// They reuse a real game's event geometry solely as counterexample fixtures;
// they are never persisted, published, or represented as actual 2026 results.
function syntheticGame(gameId) {
  const patch = { id: Number(gameId), season: 20262027, gameType: 2,
    startTimeUTC: '2026-09-06T00:00:00Z', gameDate: '2026-09-05', syntheticTestScenario: true };
  return { landing: { ...structuredClone(landing), ...patch }, pbp: { ...structuredClone(pbp), ...patch } };
}
function installGame(value) {
  mock(url => response(url.endsWith('/landing') ? value.landing : value.pbp));
}

try {
  await test('observed-shot research uses existing authentication before any source access', async () => {
    mock(() => { throw new Error('Unauthenticated request must not reach a source'); });
    for (const options of [{ authenticated: false }, { token: 'forged-token' }, { token: expired }]) {
      assert.equal((await checked('gameId=2023020001', 401, options)).ok, false);
    }
    assert.equal(calls.length, 0);
  });
  await test('exactly one valid NHL game ID is required before upstream reads', async () => {
    mock(() => { throw new Error('Invalid identity must not fetch'); });
    for (const query of ['', 'gameId=', 'gameId=2023020000', 'gameId=2023040001', 'gameId=0000000000',
      'gameId=2023020001&gameId=2023020002', 'gameId=2023020001&gameId=2023020001', 'gameId=../../NBA', 'gameId=2023020001.0']) {
      const body = await checked(query, 400);
      assert.equal(body.ok, false); assert.equal(body.code, 'NHL_INVALID_GAME_ID');
    }
    assert.equal(calls.length, 0);
  });
  await test('real training-period fixture cannot receive in-sample frozen-model xG', async () => {
    installGame({ landing, pbp });
    const body = await checked('gameId=2023020001', 200);
    assert.equal(body.ok, true); assert.equal(body.gameId, '2023020001');
    assert.equal(body.research.leagueId, 'NHL'); assert.equal(body.research.league, 'NHL');
    assert.equal(body.research.game.gameId, '2023020001');
    assert.equal(body.research.status, 'NO_ELIGIBLE_FROZEN_MODEL');
    for (const result of Object.values(body.research.strengths)) {
      assert.equal(result.ok, false); assert.equal(result.status, 'HISTORICAL_GAME_REQUIRES_HELD_OUT_ARTIFACT');
      assert.equal(result.teamResearch, null); assert.equal(result.expectedGoalsConditionalOnObservedShots, undefined);
    }
    assert.equal(body.research.pregameModel, false); assert.equal(body.research.productionCalibrated, false);
    assert.deepEqual(calls.map(url => url.split('/').at(-1)), ['landing', 'play-by-play']);
  });
  await test('explicit synthetic post-training game serves observed shots without fitting or optional baseball-style details', async () => {
    const gameId = '2026020910'; installGame(syntheticGame(gameId));
    const body = await checked(`gameId=${gameId}`, 200);
    assert.equal(body.gameId, gameId); assert.equal(body.research.game.gameId, gameId);
    assert.equal(body.research.status, 'OBSERVED_SHOT_RESEARCH');
    assert.equal(body.research.artifactHash, artifacts.contentHash);
    assert.equal(body.research.scope, 'RETROSPECTIVE_CONDITIONAL_ON_OBSERVED_UNBLOCKED_SHOTS');
    assert.equal(body.research.productionCalibrated, false); assert.equal(body.research.pointInTimeVerified, false);
    const result = body.research.strengths['5V5'];
    assert.equal(result.ok, true); assert.ok(result.testedShots > 0); assert.equal(result.teamResearch.length, 2);
    const [away, home] = result.teamResearch;
    assert.equal(away.researchXGF, home.researchXGA); assert.equal(home.researchXGF, away.researchXGA);
    assert.equal(away.pregameForecast, false); assert.equal(home.pregameForecast, false);
    assert.ok(Math.abs(away.researchXGFShare + home.researchXGFShare - 1) < 1e-12);
    assert.deepEqual(calls.map(url => url.split('/').at(-1)), ['landing', 'play-by-play']);
    const count = calls.length;
    const again = await checked(`gameId=${gameId}&league=NBA`, 200);
    assert.equal(again.cache.hit, true); assert.equal(calls.length, count);
    assert.equal(again.league, 'NHL'); assert.equal(again.research.game.leagueId, 'NHL');
    assert.equal(again.research.game.gameId, gameId, 'Foreign query cannot reinterpret a dedicated NHL cache');
  });
  await test('concurrent requests coalesce independently for the exact NHL game', async () => {
    const gameId = '2026020911'; installGame(syntheticGame(gameId));
    const [a, b] = await Promise.all([checked(`gameId=${gameId}`, 200), checked(`gameId=${gameId}`, 200)]);
    assert.equal(calls.length, 2); assert.equal(a.gameId, gameId); assert.equal(b.gameId, gameId);
    a.research.strengths['5V5'].teamResearch[0].researchXGF = -999;
    assert.ok(b.research.strengths['5V5'].teamResearch[0].researchXGF >= 0, 'Responses are isolated copies');
  });
  await test('landing/PBP game and team conflicts block the API before displaying research', async () => {
    for (const [gameId, mutate] of [
      ['2026020912', value => { value.pbp.id = 2026020913; }],
      ['2026020914', value => { value.pbp.awayTeam.id = 99; }],
      ['2026020915', value => { value.landing.id = 2026020916; }],
    ]) {
      const value = syntheticGame(gameId); mutate(value); installGame(value);
      const body = await checked(`gameId=${gameId}`, 422);
      assert.equal(body.ok, false); assert.equal(body.research, undefined);
      assert.ok(body.issues.length > 0);
    }
  });
  await test('empty or incomplete completed-event payloads surface QA BLOCK rather than partial xG success', async () => {
    for (const [gameId, expected, mutate] of [
      ['2026020917', 'NHL_SHOT_FINAL_EVENTS_MISSING', value => { value.pbp.plays = []; value.pbp.rosterSpots = []; }],
      ['2026020918', 'NHL_SHOT_FINAL_EVENT_TOTALS_MISMATCH', value => { const index = value.pbp.plays.findIndex(row => row.typeDescKey === 'goal'); value.pbp.plays.splice(index, 1); }],
    ]) {
      const value = syntheticGame(gameId); mutate(value); installGame(value);
      const body = await checked(`gameId=${gameId}`, 422);
      assert.equal(body.code, expected); assert.equal(body.research, undefined);
    }
  });
  await test('403/429 and malformed JSON fail visibly with no retry or empty-success fallback', async () => {
    for (const [gameId, status, code] of [['2026020919', 403, 'NHL_SOURCE_FORBIDDEN'], ['2026020920', 429, 'NHL_SOURCE_RATE_LIMITED']]) {
      const value = syntheticGame(gameId);
      mock(url => response(url.endsWith('/landing') ? value.landing : { error: 'explicit upstream failure fixture' }, url.endsWith('/landing') ? 200 : status));
      const body = await checked(`gameId=${gameId}`, 503);
      assert.equal(body.ok, false); assert.equal(body.code, code); assert.equal(body.research, undefined);
      assert.equal(calls.length, 2);
    }
    const gameId = '2026020921'; const value = syntheticGame(gameId);
    mock(url => url.endsWith('/landing') ? response(value.landing) : new Response('not JSON', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    assert.equal((await checked(`gameId=${gameId}`, 503)).ok, false); assert.equal(calls.length, 2);
  });
  await test('server-computed raw source hash is bound to the exact PBP; frozen artifact mutation fails closed', async () => {
    // Direct research boundary: HTTP callers cannot supply a source hash. The
    // API computes its own hash; these are explicit corruption counterexamples.
    const source = { provider: 'NHL', url: 'https://api-web.nhle.com/v1/gamecenter/2023020001/play-by-play',
      fetchedAt: '2026-09-06T00:00:00Z', contentHash: digest(pbp) };
    const wrongHash = scoreNhlObservedGameResearch(artifacts, pbp, { source: { ...source, contentHash: '0'.repeat(64) } });
    assert.equal(wrongHash.ok, false); assert.equal(wrongHash.code, 'NHL_SHOT_SOURCE_UNVERIFIED');
    const badArtifact = structuredClone(artifacts); badArtifact.models['5V5'].coefficients[0] += 1;
    assert.equal(scoreNhlObservedGameResearch(badArtifact, pbp, { source }).code, 'NHL_SHOT_FROZEN_ARTIFACT_INVALID');
    const apiSource = (await checked('gameId=2023020001', 200)).research.source;
    assert.equal(apiSource.contentHash, digest(pbp)); assert.equal(apiSource.url, source.url);
  });
} finally { globalThis.fetch = previousFetch; }

console.log(`NHL observed-shot API: ${groups} groups PASS; local official fixtures and explicitly synthetic request scenarios, no network/DB/Production validation.`);
