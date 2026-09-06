import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';

register('./next-route-test-loader.mjs', import.meta.url);

// This process must never connect to an inherited database or runtime cache.
// Authentication uses local test-only secrets; no Production credentials load.
delete process.env.DATABASE_URL;
delete process.env.DATABASE_V2_URL;
process.env.VERCEL = '0';
process.env.APP_PASSWORD = 'nhl-api-integration-only-password';
process.env.SESSION_SECRET = 'nhl-api-integration-only-session-secret';
process.env.READER_PAIR_SECRET = 'nhl-api-integration-only-reader-secret';

const { createSessionToken } = await import('../lib/security.js');
const { createReaderToken } = await import('../lib/reader-auth-v2.js');
const { nhlPersistenceConfigured } = await import('../lib/nhl/store.js');
const { NHL_READER_INTERFACE_VERSION, validateNhlCapture } = await import('../lib/nhl/reader.js');
const { NHL_HISTORICAL_SAMPLES } = await import('../lib/nhl/historical-samples.js');
const { GET: getNhl } = await import('../app/api/nhl/route.js');
const { GET: getReader, POST: postReader, OPTIONS: readerOptions } = await import('../app/api/nhl/reader/route.js');

assert.equal(nhlPersistenceConfigured(), false, 'Integration tests may not write any database');
const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/nhl/${name}`, import.meta.url), 'utf8'));
const landing = fixture('landing-2023020001.json');
const boxscore = fixture('boxscore-2023020001.json');
const roster = fixture('roster-TOR-20232024.json');
const statistics = fixture('club-stats-TOR-20232024-2.json');
const session = await createSessionToken(600);
const expiredSession = await createSessionToken(-1);
const readerDevice = 'nhl-integration-device-001';
const readerToken = await createReaderToken({ deviceId: readerDevice });
const readerOrigin = `chrome-extension://${'a'.repeat(32)}`;
const originalFetch = globalThis.fetch;
const requests = [];
let passed = 0;

function installFetch(responder) {
  requests.length = 0;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    // An unexpected database, MLB, or third-party request fails immediately.
    assert.ok(/^https:\/\/(?:api-web\.nhle\.com|api\.nhle\.com)\//.test(target), `Unexpected network destination: ${target}`);
    requests.push(target);
    return responder(target, options);
  };
}
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
function getRequest(query = '', { authenticated = true, token = session, ip = '203.0.113.201' } = {}) {
  return new Request(`https://app.test/api/nhl${query ? `?${query}` : ''}`, {
    headers: { ...(authenticated ? { cookie: `mlb_session=${encodeURIComponent(token)}` } : {}), 'x-forwarded-for': ip },
  });
}
function readerRequest(payload, { token = readerToken, origin = readerOrigin, body, extraHeaders = {} } = {}) {
  return new Request('https://app.test/api/nhl/reader', {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin, 'x-forwarded-for': '203.0.113.202',
      'x-device-id': readerDevice, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body === undefined ? JSON.stringify(payload) : body,
  });
}
async function checked(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('Cache-Control'), 'no-store', 'Authenticated data/errors must not enter shared browser caches');
  return response.json();
}
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}

try {
  await test('NHL data and Reader status require the existing authenticated session', async () => {
    installFetch(() => { throw new Error('Authentication must fail before fetching sources'); });
    for (const handler of [getNhl, getReader]) {
      assert.equal((await checked(await handler(getRequest('', { authenticated: false })), 401)).ok, false);
      assert.equal((await checked(await handler(getRequest('', { token: 'forged-session' })), 401)).ok, false);
      assert.equal((await checked(await handler(getRequest('', { token: expiredSession })), 401)).ok, false);
    }
    const status = await checked(await getNhl(getRequest()), 200);
    assert.equal(status.league, 'NHL');
    assert.equal(status.realBetExecutionEnabled, false);
    assert.equal(status.reader.verifiedMarketCount, 0);
    assert.equal(status.reader.status, 'WAITING_REAL_DATA');
    assert.equal(status.persistenceConfigured, false);
    assert.equal(requests.length, 0);
  });

  await test('invalid dates, actions, IDs and team arguments return 400 before source access', async () => {
    installFetch(() => { throw new Error('Invalid requests must not call an upstream'); });
    for (const query of [
      'action=schedule', 'action=schedule&date=2026-02-30', 'action=schedule&date=2026-13-01',
      'action=schedule&date=2026/09/06', 'action=unknown', 'action=game', 'action=game&gameId=123',
      'action=game&gameId=202302000a', 'action=game&gameId=../../MLB', 'action=versions&gameId=bad',
      'action=player&playerId=0', 'action=player&playerId=847840a', 'action=team&team=TOR&teamId=-1&season=20232024',
      ...['game', 'context', 'versions'].flatMap(action => ['0000000000', '2026990001', '2023020000', '2023040001']
        .map(gameId => `action=${action}&gameId=${gameId}`)),
    ]) {
      const body = await checked(await getNhl(getRequest(query)), 400);
      assert.equal(body.ok, false, query);
      assert.equal(body.league, 'NHL');
      assert.ok(body.error, query);
    }
    assert.equal(requests.length, 0);
  });

  await test('official schedule preserves Taipei date, NHL identities and league-isolated cache', async () => {
    installFetch(url => {
      assert.equal(url, 'https://api-web.nhle.com/v1/schedule/2023-10-10');
      return jsonResponse({ gameWeek: [{ date: '2023-10-10', games: [landing] }] });
    });
    const first = await checked(await getNhl(getRequest('action=schedule&date=2023-10-11')), 200);
    assert.equal(first.league, 'NHL');
    assert.equal(first.games.length, 1);
    assert.equal(first.games[0].gameId, '2023020001');
    assert.equal(first.games[0].taipeiDate, '2023-10-11');
    assert.equal(first.games[0].officialDate, '2023-10-10');
    assert.equal(first.games[0].awayTeamId, landing.awayTeam.id);
    const cached = await checked(await getNhl(getRequest('action=schedule&date=2023-10-11&league=MLB')), 200);
    assert.equal(cached.league, 'NHL', 'A query override cannot reinterpret a dedicated NHL response as MLB');
    assert.ok(cached.games.every(game => game.league === 'NHL' && game.leagueId === 'NHL'));
    assert.equal(cached.cache.hit, true);
    assert.equal(requests.length, 1);
    installFetch(() => jsonResponse({ gameWeek: [] }));
    const empty = await checked(await getNhl(getRequest('action=schedule&date=2023-10-12')), 200);
    assert.deepEqual(empty.games, [], 'A distinct empty date may not inherit the previous date board');
  });

  await test('403, 429, bad payload and conflicting identity remain explicit HTTP failures', async () => {
    for (const [date, upstreamStatus, code] of [
      ['2099-08-18', 403, 'NHL_SOURCE_FORBIDDEN'], ['2099-08-19', 429, 'NHL_SOURCE_RATE_LIMITED'],
    ]) {
      installFetch(() => jsonResponse({ error: 'provider denial' }, upstreamStatus));
      const body = await checked(await getNhl(getRequest(`action=schedule&date=${date}`)), 503);
      assert.equal(body.ok, false);
      assert.equal(body.code, code);
      assert.equal(body.upstreamStatus, upstreamStatus);
      assert.equal(requests.length, 1, 'Provider denials must not trigger an immediate retry loop');
    }
    installFetch(() => jsonResponse([]));
    const invalidSchema = await checked(await getNhl(getRequest('action=schedule&date=2099-08-20')), 503);
    assert.equal(invalidSchema.code, 'NHL_SOURCE_FORMAT_CHANGED');
    installFetch(() => jsonResponse({ games: [landing, { ...landing, awayTeam: landing.homeTeam }] }));
    const invalidIdentity = await checked(await getNhl(getRequest('action=schedule&date=2099-08-21')), 422);
    assert.equal(invalidIdentity.ok, false);
    assert.ok(invalidIdentity.issues.includes('NHL_TEAM_IDENTITY_INVALID'));
  });

  await test('malformed roster identities surface HTTP 422 rather than a successful partial team', async () => {
    const invalidRoster = structuredClone(roster);
    delete invalidRoster.forwards[0].id;
    installFetch(url => {
      if (url.includes('/club-schedule-season/')) return jsonResponse({ games: [] });
      if (url.includes('/roster/')) return jsonResponse(invalidRoster);
      if (url.includes('/club-stats/')) return jsonResponse(statistics);
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    const body = await checked(await getNhl(getRequest('action=team&team=TOR&teamId=10&season=20232024')), 422);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'NHL_ROSTER_IDENTITY_INVALID');
    assert.ok(body.issues.includes('NHL_ROSTER_IDENTITY_INVALID'));
  });

  await test('live official landing and boxscore retain missing optional data without inventing confirmation', async () => {
    installFetch(url => {
      if (url.endsWith('/2023020001/landing')) return jsonResponse(landing);
      if (url.endsWith('/2023020001/boxscore')) return jsonResponse(boxscore);
      if (url.endsWith('/2023020001/play-by-play')) return jsonResponse({ error: 'fixture unavailable' }, 404);
      if (url.endsWith('/2023020001/right-rail')) return jsonResponse(fixture('right-rail-2023020001.json'));
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    const body = await checked(await getNhl(getRequest('action=game&gameId=2023020001')), 200);
    assert.equal(body.acquisition, 'OFFICIAL_LIVE_FETCH');
    assert.equal(body.game.gameId, '2023020001');
    assert.deepEqual(body.game.regulation, { awayGoals: 3, homeGoals: 5 });
    assert.equal(body.game.source.url, 'https://api-web.nhle.com/v1/gamecenter/2023020001/landing');
    assert.ok(/^[a-f0-9]{64}$/.test(body.game.source.contentHash));
    assert.ok(body.issues.includes('NHL_SOURCE_HTTP_ERROR'), 'Optional source failure must remain visible');
    assert.equal(body.game.goalie.away, null);
    assert.equal(body.game.advanced.xGF, null);
    assert.ok(body.game.playerStatistics.away.goalies.every(row => row.pregameConfirmed === false));
    assert.equal(body.observation.persisted, false, 'Successful read does not imply durable persistence');
    assert.equal(body.game.officialReport.ok, true);
    assert.equal(body.game.officialReport.away.powerPlayOpportunities, 4);
    assert.equal(body.game.officialReport.home.penaltyKillPercent, 0.75);
    assert.equal(body.game.officialReport.away.scratches.length, 3);
    assert.equal(body.game.officialReport.pregamePointInTimeVerified, false);
    assert.equal(requests.length, 4);
    assert.equal(requests.filter(url => url.endsWith('/right-rail')).length, 1);
  });

  await test('an unavailable official update falls back transparently to a matching archived real game', async () => {
    const archived = NHL_HISTORICAL_SAMPLES.find(game => game.gameId === '2023020002');
    installFetch(() => jsonResponse({ error: 'forbidden' }, 403));
    const body = await checked(await getNhl(getRequest(`action=game&gameId=${archived.gameId}`)), 200);
    assert.equal(body.acquisition, 'ARCHIVED_OFFICIAL_HISTORICAL_SAMPLE');
    assert.equal(body.game.gameId, archived.gameId);
    assert.equal(body.game.source.fetchedAt, archived.source.fetchedAt, 'Archive lookup cannot refresh the original acquisition time');
    assert.equal(body.game.source.contentHash, archived.source.contentHash);
    assert.equal(body.game.historical, true);
    assert.ok(body.warning);
    assert.ok(body.issues.includes('NHL_SOURCE_FORBIDDEN'));
    assert.equal(body.observation.persisted, false);
    assert.equal(requests.length, 1);
  });

  await test('unknown game failures and mismatched official results never borrow another archived game', async () => {
    installFetch(() => jsonResponse({ error: 'not found' }, 404));
    const unavailable = await checked(await getNhl(getRequest('action=game&gameId=2099020001')), 503);
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.game, undefined);
    assert.equal(unavailable.upstreamStatus, 404);
    installFetch(url => url.endsWith('/landing') ? jsonResponse(landing) : jsonResponse({}, 404));
    const mismatch = await checked(await getNhl(getRequest('action=game&gameId=2099020002')), 422);
    assert.equal(mismatch.ok, false);
    assert.ok(mismatch.issues.includes('NHL_IDENTITY_MISMATCH_gameId'));
    assert.equal(mismatch.game, undefined);
    const archivedId = NHL_HISTORICAL_SAMPLES.find(game => !['2023020001', '2023020002'].includes(game.gameId)).gameId;
    installFetch(url => url.endsWith('/landing') ? jsonResponse(landing) : jsonResponse({}, 404));
    const knownMismatch = await checked(await getNhl(getRequest(`action=game&gameId=${archivedId}`)), 422);
    assert.equal(knownMismatch.ok, false, 'An existing archive cannot hide current official identity BLOCK');
    assert.ok(knownMismatch.issues.includes('NHL_IDENTITY_MISMATCH_gameId'));
    assert.equal(knownMismatch.game, undefined);
  });

  await test('roster uses verified official team ID and keeps player statistics distinct from team xG', async () => {
    const torGame = NHL_HISTORICAL_SAMPLES.find(game => game.awayAbbrev === 'TOR' || game.homeAbbrev === 'TOR');
    const tor = torGame.awayAbbrev === 'TOR' ? torGame.away : torGame.home;
    installFetch(url => {
      if (url.includes('/club-schedule-season/')) return jsonResponse({ error: 'unavailable' }, 403);
      if (url.includes('/roster/TOR/20232024')) return jsonResponse(roster);
      if (url.includes('/club-stats/TOR/20232024/2')) return jsonResponse(statistics);
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    const body = await checked(await getNhl(getRequest(`action=team&team=TOR&teamId=${tor.teamId}&season=20232024`)), 200);
    assert.equal(body.identityBasis, 'ARCHIVED_OFFICIAL_GAME_TEAM');
    assert.ok(body.roster.players.length > 20);
    assert.ok(body.roster.players.every(player => player.leagueId === 'NHL' && player.teamId === tor.teamId));
    assert.equal(body.statistics.teamTotals, null);
    assert.equal(body.statistics.xGF, null);
    const mismatch = await checked(await getNhl(getRequest('action=team&team=TOR&teamId=999999&season=20232024')), 422);
    assert.equal(mismatch.code, 'NHL_TEAM_IDENTITY_UNVERIFIED');
  });

  await test('player identity and unavailable durable versions report errors without database access', async () => {
    installFetch(() => jsonResponse({ playerId: 8478403 }));
    const mismatch = await checked(await getNhl(getRequest('action=player&playerId=8478402')), 503);
    assert.equal(mismatch.code, 'NHL_PLAYER_IDENTITY_MISMATCH');
    installFetch(() => { throw new Error('Missing database must fail before any network request'); });
    const versions = await checked(await getNhl(getRequest('action=versions&gameId=2023020001')), 503);
    assert.equal(versions.code, 'NHL_DATABASE_UNAVAILABLE');
    assert.equal(requests.length, 0);
  });

  await test('schedule context reports unavailable official coverage without fabricating rest or travel', async () => {
    installFetch(url => {
      if (url.endsWith('/2023020001/landing')) return jsonResponse(landing);
      if (url.includes('/club-schedule-season/')) return jsonResponse({ error: 'provider denial' }, 403);
      throw new Error(`Unexpected context fixture request: ${url}`);
    });
    const body = await checked(await getNhl(getRequest('action=context&gameId=2023020001')), 503);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'NHL_SOURCE_FORBIDDEN');
    assert.equal(body.upstreamStatus, 403);
    assert.equal(body.away, undefined);
    assert.equal(body.home, undefined);
    assert.equal(requests.length, 3, 'Context needs both independently identified club schedules');
  });

  await test('20 real historical samples expose only retrospective score evidence and zero strict PIT folds', async () => {
    installFetch(() => { throw new Error('Published research corpus must not refetch or fabricate live data'); });
    const body = await checked(await getNhl(getRequest('action=research')), 200);
    assert.equal(body.league, 'NHL');
    assert.equal(body.games.length, NHL_HISTORICAL_SAMPLES.length);
    assert.ok(body.games.length >= 20);
    assert.equal(body.completePeriodGames, body.games.length);
    assert.equal(body.validation.engineeringCorpusOnly, true);
    assert.equal(body.validation.fullSeasonCoverage, false);
    assert.equal(body.validation.productionModelCalibrated, false);
    assert.equal(body.validation.historicalTai888PayoffVerified, false);
    assert.equal(body.validation.strictPointInTime.folds, 0);
    assert.equal(body.validation.retrospective.pointInTimeVerified, false);
    assert.ok(body.validation.retrospective.folds > 0);
    assert.equal(body.validation.retrospective.status, 'RETROSPECTIVE_SCORE_BACKTEST_ONLY');
    const byId = new Map(body.games.map(game => [game.gameId, game]));
    assert.equal(new Set(body.validation.folds.map(fold => fold.gameId)).size, body.validation.folds.length);
    for (const fold of body.validation.folds) {
      assert.ok(!fold.trainingGameIds.includes(fold.gameId));
      for (const id of fold.trainingGameIds) {
        assert.ok(Date.parse(byId.get(id).startTimeUTC) + 48 * 3600_000 <= Date.parse(fold.asOf), 'Embargo must hold for every reported training game');
      }
    }
    assert.ok(body.games.every(game => game.gameType === 2 && game.source.provider === 'NHL' && /^https:\/\/api-web\.nhle\.com\//.test(game.source.url)));
    const repeated = await checked(await getNhl(getRequest('action=research')), 200);
    assert.equal(repeated.cache.hit, true);
    assert.deepEqual(repeated.validation, body.validation);
    assert.equal(requests.length, 0);
  });

  await test('Reader origin, token, payload league, date and request-size failures preserve HTTP status', async () => {
    installFetch(() => { throw new Error('Reader validation must not access official or database endpoints'); });
    const preflightAllowed = await readerOptions(new Request('https://app.test/api/nhl/reader', { method: 'OPTIONS', headers: { origin: readerOrigin } }));
    assert.equal(preflightAllowed.status, 204);
    assert.equal(preflightAllowed.headers.get('Access-Control-Allow-Origin'), readerOrigin);
    const preflightDenied = await readerOptions(new Request('https://app.test/api/nhl/reader', { method: 'OPTIONS', headers: { origin: 'https://evil.invalid' } }));
    assert.equal(preflightDenied.status, 403);
    assert.equal((await checked(await postReader(readerRequest({}, { origin: 'https://evil.invalid' })), 403)).ok, false);
    assert.equal((await checked(await postReader(readerRequest({}, { token: '' })), 401)).ok, false);
    assert.equal((await checked(await postReader(readerRequest({}, { token: 'forged-reader-token' })), 401)).ok, false);
    const mismatchedDevice = await checked(await postReader(readerRequest({}, { extraHeaders: { 'x-device-id': 'different-device' } })), 403);
    assert.equal(mismatchedDevice.ok, false);
    const missingDeviceRequest = readerRequest({});
    missingDeviceRequest.headers.delete('x-device-id');
    assert.equal((await checked(await postReader(missingDeviceRequest), 403)).ok, false);
    const wrongLeague = await checked(await postReader(readerRequest({ league: 'MLB' })), 422);
    assert.equal(wrongLeague.league, 'NHL');
    assert.ok(wrongLeague.errors.includes('NHL_READER_IDENTITY_INVALID'));
    const badJson = await checked(await postReader(readerRequest(null, { body: '{broken' })), 400);
    assert.equal(badJson.ok, false);
    const tooLarge = await checked(await postReader(readerRequest(null, { body: 'x'.repeat(128_001) })), 413);
    assert.equal(tooLarge.ok, false);
    assert.equal(requests.length, 0);
  });

  await test('Reader discovery cannot enable an unverified contract or claim a failed database save succeeded', async () => {
    installFetch(() => { throw new Error('No database or third-party access is allowed'); });
    const status = await checked(await getReader(getRequest()), 200);
    assert.deepEqual(status.verifiedMarkets, []);
    assert.equal(status.executable, false);
    // Labelled artificial raw capture checks the API boundary only. These rows
    // are not real Tai888 evidence, a verified manifest, or an executable price.
    const capture = {
      league: 'NHL', provider: 'TAI888_READER', interfaceVersion: NHL_READER_INTERFACE_VERSION,
      boardDate: '2026-09-06', observedAt: new Date().toISOString(), readerVersion: 'integration-test',
      pageUrl: 'https://www1.tai888.in/', pageLeagueLabel: 'NHL integration fixture',
      rawRows: [{ sourceRowId: 'synthetic-boundary-row', eventLabel: 'test fixture', marketLabel: 'unverified fixture', lineText: 'test only' }],
      executable: true, marketVerification: 'VERIFIED', verifiedMarkets: ['forged-market'],
    };
    const normalized = validateNhlCapture(capture);
    assert.equal(normalized.ok, true);
    assert.equal(normalized.payload.executable, false);
    assert.equal(normalized.payload.marketVerification, 'WAITING_REAL_TAI888_NHL_EVIDENCE');
    assert.equal(normalized.payload.verifiedMarkets, undefined);
    const invalidDate = await checked(await postReader(readerRequest({ ...capture, boardDate: '2026-02-30' })), 422);
    assert.ok(invalidDate.errors.includes('NHL_READER_DATE_INVALID'));
    const unsaved = await checked(await postReader(readerRequest(capture)), 503);
    assert.equal(unsaved.ok, false);
    assert.equal(unsaved.code, 'NHL_DATABASE_UNAVAILABLE');
    assert.notEqual(unsaved.executable, true);
    assert.notEqual(unsaved.persisted, true);
    assert.equal(requests.length, 0);
  });
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`NHL API integration: ${passed} groups passed; real official fixtures, no live network or database writes.`);
