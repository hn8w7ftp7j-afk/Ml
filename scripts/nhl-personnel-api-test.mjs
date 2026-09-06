import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';

register('./next-route-test-loader.mjs', import.meta.url);

// Local transport integration only. No inherited database, credentials, runtime
// cache or real HTTP request may be used by this process.
delete process.env.DATABASE_URL;
delete process.env.DATABASE_V2_URL;
process.env.VERCEL = '0';
process.env.APP_PASSWORD = 'nhl-personnel-api-local-test-password';
process.env.SESSION_SECRET = 'nhl-personnel-api-local-test-session-secret';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let clock = originalNow();
Date.now = () => clock;

const { createSessionToken } = await import('../lib/security.js');
const { nhlPersistenceConfigured, validateNhlObservation } = await import('../lib/nhl/store.js');
const { makeNhlPersonnelObservation } = await import('../lib/nhl/personnel-observation.js');
const { fetchNhlJson } = await import('../lib/nhl/data.js');
const { GET } = await import('../app/api/nhl/route.js');
const facts = JSON.parse(fs.readFileSync(new URL('./fixtures/nhl/personnel-official-20260614-facts.json', import.meta.url), 'utf8'));
const session = await createSessionToken(3600);
const expiredSession = await createSessionToken(-1);
const requests = [];
let groups = 0;

assert.equal(nhlPersistenceConfigured(), false, 'Integration tests must not connect to any database');

const esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// This deliberately synthetic HTML envelope uses the real factual lineup
// extract. It is not the original page, a historical PIT snapshot, or proof of
// today's availability. Production never imports this test file.
function mockArticle(data = facts, { modifiedAt = data.sourceUpdatedAt, sourceUrl = data.sourceUrl } = {}) {
  const team = side => `<p>${data[side].heading} projected lineup</p>${[...data[side].lines, ...data[side].pairs].map(row => `<p>${esc(row.join(' -- '))}</p>`).join('')}${data[side].goalies.map(name => `<p>${esc(name)}</p>`).join('')}<p>Scratched: ${esc(data[side].scratched.join(', ') || 'None')}</p><p>Injured: ${esc(data[side].injured.map(row => `${row[0]} (${row[1]})`).join(', ') || 'None')}</p>`;
  return `<html><head><link rel="canonical" href="${sourceUrl}"><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', datePublished: data.sourcePublishedAt, dateModified: modifiedAt })}</script></head><body><article class="nhl-c-article"><div class="oc-c-markdown-stories"><h2>(1M) HURRICANES at (1P) GOLDEN KNIGHTS</h2>${team('away')}${team('home')}<p>Status report</p></div></article></body></html>`;
}

// Game IDs, team IDs and dates come from the official extract. PRE is an
// explicitly synthetic transport scenario so this test neither invents final
// period scoring nor borrows final boxscore participants as pregame starters.
function mockLanding() {
  return { id: Number(facts.game.gameId), season: facts.game.season, gameType: facts.game.gameType,
    startTimeUTC: facts.game.startTimeUTC, gameDate: facts.game.officialDate, gameState: 'PRE', gameScheduleState: 'OK',
    awayTeam: { id: 12, abbrev: 'CAR', placeName: { default: 'Carolina' }, commonName: { default: 'Hurricanes' } },
    homeTeam: { id: 54, abbrev: 'VGK', placeName: { default: 'Vegas' }, commonName: { default: 'Golden Knights' } } };
}

function rawPlayer([id, name, position]) {
  const words = name.split(' ');
  return { id, playerId: id, firstName: { default: words.shift() }, lastName: { default: words.join(' ') }, positionCode: position };
}
function mockRoster(side) {
  const result = { forwards: [], defensemen: [], goalies: [] };
  for (const row of facts[side].rosterPlayers) result[row[2] === 'G' ? 'goalies' : row[2] === 'D' ? 'defensemen' : 'forwards'].push(rawPlayer(row));
  return result;
}
function mockClubStats(side) {
  const result = { season: facts.game.season, gameType: facts.game.gameType, skaters: [], goalies: [] };
  for (const row of facts[side].additionalClubPlayers) result[row[2] === 'G' ? 'goalies' : 'skaters'].push(rawPlayer(row));
  return result;
}
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function installFetch({ html = mockArticle(), articleStatus = 200, landing = mockLanding(), transformRoster, transformStats } = {}) {
  requests.length = 0;
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    assert.ok(url.startsWith('https://api-web.nhle.com/') || url === facts.sourceUrl, `Unexpected network destination: ${url}`);
    requests.push({ url, method: options?.method || 'GET', redirect: options?.redirect });
    if (url === `https://api-web.nhle.com/v1/gamecenter/${facts.game.gameId}/landing`) return json(landing);
    if (url === facts.sourceUrl) return new Response(articleStatus === 200 ? html : 'local upstream failure fixture', { status: articleStatus, headers: { 'Content-Type': 'text/html' } });
    for (const side of ['away', 'home']) {
      if (url === facts[side].rosterSource.url) return json(transformRoster ? transformRoster(mockRoster(side), side) : mockRoster(side));
      if (url === facts[side].clubSource.url) return json(transformStats ? transformStats(mockClubStats(side), side) : mockClubStats(side));
    }
    throw new Error(`Unmapped local source fixture: ${url}`);
  };
}
function request(query, { token = session, authenticated = true } = {}) {
  return new Request(`https://app.test/api/nhl?${query}`, { headers: { 'x-forwarded-for': '203.0.113.219', ...(authenticated ? { cookie: `mlb_session=${encodeURIComponent(token)}` } : {}) } });
}
async function body(query, status = 200, options = {}) {
  const response = await GET(request(query, options));
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return value;
}
async function test(name, run) {
  // Moving a local clock, not sleeping, ensures each isolated scenario actually
  // hits its new mocked provider instead of being satisfied by a prior cache.
  clock += 61_000;
  await run();
  groups++;
  console.log(`PASS ${name}`);
}
const personnelQuery = `action=personnel&gameId=${facts.game.gameId}`;

try {
  await test('personnel and version routes require existing authentication', async () => {
    installFetch();
    for (const action of ['personnel', 'personnel-versions']) for (const options of [{ authenticated: false }, { token: 'forged' }, { token: expiredSession }]) {
      assert.equal((await body(`action=${action}&gameId=${facts.game.gameId}`, 401, options)).ok, false);
    }
    assert.equal(requests.length, 0);
  });

  await test('invalid or duplicate game identity fails before fetching sources', async () => {
    installFetch();
    for (const action of ['personnel', 'personnel-versions']) for (const suffix of ['', '&gameId=bad', '&gameId=2025030000', '&gameId=2025990416', '&gameId=2025030416&gameId=2025030415', '&gameId=../../MLB']) {
      const result = await body(`action=${action}${suffix}`, 400);
      assert.equal(result.code, 'NHL_INVALID_GAME_ID'); assert.equal(result.league, 'NHL');
    }
    assert.equal(requests.length, 0);
  });

  await test('actual handler exposes verified factual lineups and quarantines unresolved names', async () => {
    installFetch();
    const result = await body(personnelQuery);
    const value = result.personnel;
    assert.equal(result.league, 'NHL'); assert.equal(result.gameId, facts.game.gameId);
    assert.equal(value.league, 'NHL'); assert.equal(value.matched, true); assert.equal(value.ok, true);
    assert.equal(value.status, 'PARTIAL'); assert.equal(value.qa.status, 'BLOCK');
    assert.equal(value.teams.away.lineCombinations.length + value.teams.home.lineCombinations.length, 8);
    assert.equal(value.teams.away.defensivePairings.length + value.teams.home.defensivePairings.length, 6);
    assert.equal(value.goalies.away.playerId, 8483548); assert.equal(value.goalies.home.playerId, 8479394);
    assert.equal(value.goalies.away.status, 'PROJECTED'); assert.equal(value.goalies.home.status, 'PROJECTED');
    assert.equal(value.goalies.away.confirmationExplicit, false); assert.equal(value.goalies.home.confirmationExplicit, false);
    assert.equal(value.teams.home.injuries[0].playerId, 8476448);
    assert.equal(value.teams.home.unresolvedAvailability.length, 3);
    assert.ok(value.teams.home.unresolvedAvailability.some(row => row.name === 'Kaeden Korczak'));
    assert.ok(!value.players.some(row => row.name === 'Kaeden Korczak'));
    assert.equal(value.source.sourcePublishedAt, '2026-06-14T15:45:00.000Z');
    assert.equal(value.source.availableAt, '2026-06-14T15:54:51.163Z');
    assert.equal(value.pointInTimeEligible, false); assert.equal(value.freshness.fresh, false);
    assert.equal(result.observation.persisted, false); assert.equal(result.observation.revision, undefined);
    assert.match(result.observation.reason, /資料庫尚未設定/);
    assert.equal(result.change, null); assert.equal(result.cache.hit, false);
    assert.equal(requests.length, 6); assert.ok(requests.every(row => row.method === 'GET'));
    assert.equal(requests.find(row => row.url === facts.sourceUrl).redirect, 'manual');
    const wrapper = makeNhlPersonnelObservation(facts.game, value, { now: clock });
    assert.equal(validateNhlObservation('PERSONNEL', facts.game.gameId, wrapper, { now: clock }).ok, true);
  });

  await test('cache returns independent NHL views without pretending durable persistence', async () => {
    installFetch();
    const first = await body(personnelQuery);
    first.personnel.teams.away.lineCombinations.length = 0;
    first.personnel.players[0].teamId = 999;
    const second = await body(`${personnelQuery}&league=MLB&sourceUrl=https://attacker.example/news/fake`);
    assert.equal(second.cache.hit, true); assert.equal(requests.length, 6);
    assert.equal(second.personnel.teams.away.lineCombinations.length, 4);
    assert.equal(second.personnel.players[0].teamId, 12);
    assert.equal(second.observation.persisted, false);
    assert.equal(second.personnel.league, 'NHL'); assert.equal(second.league, 'NHL');
  });

  await test('source date mismatch is explicit no-match and skips all roster calls', async () => {
    installFetch({ html: mockArticle(facts, { modifiedAt: '2026-06-15T15:54:51.163Z' }) });
    const result = await body(personnelQuery);
    assert.equal(result.personnel.status, 'NO_MATCHING_GAME'); assert.equal(result.personnel.matched, false);
    assert.equal(result.personnel.ok, true); assert.deepEqual(result.personnel.players, []);
    assert.deepEqual(result.personnel.teams, {}); assert.equal(result.personnel.goalies.away.status, 'UNKNOWN');
    assert.equal(result.personnel.observedMatchups[0].officialDate, '2026-06-15');
    assert.equal(result.observation.persisted, false); assert.match(result.observation.reason, /沒有本場相符/);
    assert.equal(requests.length, 2); assert.equal(requests.filter(row => row.url.includes('/roster/')).length, 0);
  });

  for (const [status, code] of [[403, 'NHL_PERSONNEL_FORBIDDEN'], [429, 'NHL_PERSONNEL_RATE_LIMITED']]) {
    await test(`upstream ${status} stays HTTP 503 with negative caching and retained-data error contract`, async () => {
      installFetch({ articleStatus: status });
      const first = await body(personnelQuery, 503);
      const second = await body(personnelQuery, 503);
      assert.equal(first.ok, false); assert.equal(first.code, code); assert.equal(first.upstreamStatus, status);
      assert.equal(second.code, code); assert.match(first.error, /保留之前資料/);
      assert.equal(first.personnel, undefined); assert.equal(first.observation, undefined);
      assert.equal(requests.length, 2, 'Second request uses negative source cache without pretending successful empty data');
      assert.equal(requests.filter(row => row.url === facts.sourceUrl).length, 1);
    });
  }

  await test('an identity mismatch is 422 and cannot inherit previously cached personnel', async () => {
    const landing = mockLanding(); landing.id = 2025030415;
    installFetch({ landing });
    const result = await body(personnelQuery, 422);
    assert.equal(result.ok, false); assert.ok(result.issues.includes('NHL_IDENTITY_MISMATCH_gameId'));
    assert.equal(result.personnel, undefined); assert.equal(requests.length, 1);
  });

  await test('ambiguous player names quarantine only their team and preserve other verified team', async () => {
    installFetch({ transformRoster: (roster, side) => {
      if (side === 'away') roster.forwards.push({ ...roster.forwards[0], id: 9999999, playerId: 9999999 });
      return roster;
    } });
    const result = await body(personnelQuery);
    assert.equal(result.personnel.qa.status, 'BLOCK');
    assert.equal(result.personnel.teams.away.lineupStatus, 'BLOCK');
    assert.deepEqual(result.personnel.teams.away.lineCombinations, []);
    assert.equal(result.personnel.goalies.away.status, 'UNKNOWN');
    assert.equal(result.personnel.teams.home.lineCombinations.length, 4);
    assert.equal(result.personnel.goalies.home.playerId, 8479394);
    assert.equal(result.observation.persisted, false);
  });

  await test('foreign league hints are discarded and cannot enter nested personnel or snapshots', async () => {
    installFetch({ transformRoster: roster => {
      for (const row of [...roster.forwards, ...roster.defensemen, ...roster.goalies]) { row.league = 'MLB'; row.leagueId = 'NBA'; }
      return roster;
    }, transformStats: stats => {
      for (const row of [...stats.skaters, ...stats.goalies]) { row.league = 'KBO'; row.leagueId = 'CPBL'; }
      return stats;
    } });
    const result = await body(`${personnelQuery}&league=NBA`);
    for (const foreign of ['MLB', 'NBA', 'NPB', 'KBO', 'CPBL']) {
      assert.ok(!JSON.stringify(result.personnel).includes(`"league":"${foreign}"`));
      assert.ok(!JSON.stringify(result.personnel).includes(`"leagueId":"${foreign}"`));
    }
    const good = makeNhlPersonnelObservation(facts.game, result.personnel, { now: clock });
    const corrupted = structuredClone(good); corrupted.personnel.league = 'NBA';
    assert.equal(validateNhlObservation('PERSONNEL', facts.game.gameId, corrupted, { now: clock }).ok, false);
    const wrongTeam = structuredClone(good); wrongTeam.personnel.teams.home.lineCombinations[0][0].teamId = 10;
    assert.equal(validateNhlObservation('PERSONNEL', facts.game.gameId, wrongTeam, { now: clock }).ok, false);
  });

  await test('personnel versions without configured persistence fail 503, not successful empty history', async () => {
    installFetch();
    const result = await body(`action=personnel-versions&gameId=${facts.game.gameId}`, 503);
    assert.equal(result.ok, false); assert.equal(result.code, 'NHL_DATABASE_UNAVAILABLE');
    assert.equal(result.versions, undefined); assert.equal(requests.length, 0);
  });

  await test('source completion time crosses puck drop without falsely retaining pregame acquisition', async () => {
    let sourceClock = Date.parse('2026-06-14T23:59:59Z');
    const result = await fetchNhlJson(`https://api-web.nhle.com/v1/gamecenter/${facts.game.gameId}/landing`, {
      retry: false, now: () => sourceClock,
      fetchImpl: async () => ({ ok: true, headers: new Headers(), json: async () => { sourceClock += 2000; return mockLanding(); } }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.source.requestedAt, '2026-06-14T23:59:59.000Z');
    assert.equal(result.source.fetchedAt, '2026-06-15T00:00:01.000Z');
    assert.ok(Date.parse(result.source.fetchedAt) > Date.parse(facts.game.startTimeUTC));
  });

  console.log(JSON.stringify({ ok: true, testGroups: groups, handler: 'GET /api/nhl personnel + personnel-versions', liveNetwork: false,
    databaseConfigured: false, fixtureKind: 'FACTUAL_EXTRACT_IN_SYNTHETIC_TRANSPORT_ENVELOPE', projectedGoalies: 2, strictHistoricalPit: false }));
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}
