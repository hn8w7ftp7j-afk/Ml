import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createSessionToken } from '../lib/security.js';
import { signRepriceSnapshot, verifyMarketRow } from '../lib/market-integrity-v1.js';

register('./next-route-test-loader.mjs', import.meta.url);

const originalEnv = {
  APP_PASSWORD: process.env.APP_PASSWORD,
  SESSION_SECRET: process.env.SESSION_SECRET,
  MARKET_INTEGRITY_SECRET: process.env.MARKET_INTEGRITY_SECRET,
  TAI888_PASSWORD: process.env.TAI888_PASSWORD,
  JBOT_API_TOKEN: process.env.JBOT_API_TOKEN,
  READER_STORE_MEMORY_ONLY: process.env.READER_STORE_MEMORY_ONLY,
  READER_PAIR_SECRET: process.env.READER_PAIR_SECRET,
};
const originalFetch = globalThis.fetch;

function setOrDelete(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function statsGame({ gamePk = 880001, gameDate = '2099-08-11T23:00:00Z', gameNumber = 1 } = {}) {
  return {
    gamePk,
    gameDate,
    officialDate: gameDate.slice(0, 10),
    gameNumber,
    doubleHeader: gameNumber > 1 ? 'Y' : 'N',
    scheduledInnings: 9,
    status: { detailedState: 'Scheduled', statusCode: 'S' },
    teams: {
      away: { team: { id: 111, name: 'Boston Red Sox' } },
      home: { team: { id: 141, name: 'Toronto Blue Jays' } },
    },
    venue: { id: 13, name: 'Rogers Centre' },
  };
}

function clientGame({ gamePk = 880001, gameDate = '2099-08-11T23:00:00Z', gameNumber = 1 } = {}) {
  return {
    league: 'MLB',
    gamePk,
    gameDate,
    officialDate: gameDate.slice(0, 10),
    gameNumber,
    scheduledInnings: 9,
    status: '預定開打',
    statusEnglish: 'Scheduled',
    statusCode: 'S',
    away: '波士頓紅襪',
    home: '多倫多藍鳥',
    awayEnglish: 'Boston Red Sox',
    homeEnglish: 'Toronto Blue Jays',
    awayTeamId: 111,
    homeTeamId: 141,
    venue: '羅傑斯中心',
    venueEnglish: 'Rogers Centre',
    venueId: 13,
  };
}

function request(path, token, body) {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://example.test',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: `mlb_session=${encodeURIComponent(token)}`,
      'X-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify(body),
  });
}

function getRequest(path, token) {
  return new Request(`https://example.test${path}`, {
    headers: {
      Cookie: `mlb_session=${encodeURIComponent(token)}`,
      'X-Forwarded-For': `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
    },
  });
}

function readerRequest(path, body, { token = '', deviceId = 'route-reader-device-1234' } = {}) {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'X-Reader-Version': '2.0.3',
      'X-Device-Id': deviceId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Forwarded-For': `192.0.2.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify(body),
  });
}

function rawReaderGame({ boardTime, suffix = 0 } = {}) {
  return {
    awayCode: 'BOS', homeCode: 'TOR', boardDate: '2099-08-12', boardTime,
    fullRunline: { lineSide: 'away', line: `1+${50 + suffix}`, awayWater: 0.95, homeWater: 0.95 },
    fullTotal: { line: `8+${50 + suffix}`, overWater: 0.94, underWater: 0.94 },
    first5Runline: { lineSide: 'away', line: `0-${30 + suffix}`, awayWater: 0.94, homeWater: 0.94 },
    first5Total: { line: `4-${30 + suffix}`, overWater: 0.93, underWater: 0.93 },
  };
}

try {
  process.env.APP_PASSWORD = 'route-test-login-password';
  process.env.TAI888_PASSWORD = 'must-never-be-session-secret';
  delete process.env.SESSION_SECRET;
  delete process.env.MARKET_INTEGRITY_SECRET;

  const authRoute = await import('../app/api/auth/route.js');
  const authGet = await authRoute.GET(new Request('https://example.test/api/auth'));
  const authState = await authGet.json();
  assert.equal(authGet.status, 200);
  assert.equal(authState.configured, false);
  assert.equal(authState.authenticated, false);
  const authPost = await authRoute.POST(new Request('https://example.test/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.test', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ password: 'route-test-login-password' }),
  }));
  assert.equal(authPost.status, 503);

  process.env.SESSION_SECRET = 'route-test-session-secret-with-entropy';
  process.env.MARKET_INTEGRITY_SECRET = 'route-test-market-secret-with-entropy';
  process.env.JBOT_API_TOKEN = 'route-test-jbot-token';
  process.env.READER_STORE_MEMORY_ONLY = 'true';
  process.env.READER_PAIR_SECRET = 'route-test-reader-pair-secret';
  const token = await createSessionToken(300);
  let officialPayload = { dates: [{ games: [
    statsGame(),
    statsGame({ gamePk: 880002, gameDate: '2099-08-12T02:00:00Z', gameNumber: 2 }),
  ] }] };
  let officialStatus = 200;
  const officialFetchDates = [];
  globalThis.fetch = async url => {
    const target = String(url);
    // V10_POINT_IN_TIME_TEST_FIXTURES: deterministic official-data fixtures for the new data gate.
    const targetUrl = new URL(target);
    const targetPath = targetUrl.pathname;

    if (targetPath === '/api/v1/venues/13') {
      return new Response(JSON.stringify({ venues: [{
        id: 13,
        name: 'Rogers Centre',
        location: {
          defaultCoordinates: { latitude: 43.6414, longitude: -79.3894 },
          city: 'Toronto', stateAbbrev: 'ON', country: 'Canada',
        },
        fieldInfo: { roofType: 'Retractable' },
        timeZone: { id: 'America/Toronto' },
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (/^\/api\/v1\/teams\/(?:111|141)\/roster$/.test(targetPath)) {
      return new Response(JSON.stringify({ roster: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (targetPath === '/api/v1/teams/stats') {
      const group = targetUrl.searchParams.get('group') || 'hitting';
      const splits = Array.from({ length: 30 }, (_, index) => ({
        team: { id: index + 1, name: 'Test Team ' + (index + 1) },
        stat: group === 'pitching'
          ? {
            gamesPlayed: index < 18 ? 123 : 122,
            gamesPitched: index < 18 ? 123 : 122,
            inningsPitched: index % 2 ? '1098.2' : '1099.1',
            runs: 540 + index % 4,
            earnedRuns: 515 + index % 4,
            strikeOuts: 1080 + index,
            baseOnBalls: 365 + index % 5,
            homeRuns: 138 + index % 3,
            hits: 1040 + index,
          }
          : {
            gamesPlayed: index < 18 ? 123 : 122,
            plateAppearances: 4550,
            atBats: 4050,
            runs: 545 + index % 6,
            hits: 1010 + index,
            doubles: 200,
            triples: 20,
            homeRuns: 145 + index % 4,
            strikeOuts: 950,
            baseOnBalls: 390,
            avg: '.249',
            obp: '.322',
            slg: '.418',
          },
      }));
      return new Response(JSON.stringify({ stats: [{ group: { displayName: group }, splits }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (targetPath === '/api/v1/schedule' && targetUrl.searchParams.has('teamId')) {
      const teamId = Number(targetUrl.searchParams.get('teamId')) || 141;
      const games = [];
      for (let index = 0; index < 25; index += 1) {
        const day = String(index + 1).padStart(2, '0');
        games.push({
          gamePk: 910000 + index * 2,
          gameDate: '2099-06-' + day + 'T23:00:00Z',
          status: { abstractGameState: 'Final', codedGameState: 'F' },
          venue: { id: 13, name: 'Rogers Centre' },
          teams: {
            home: { team: { id: teamId, name: 'Toronto Blue Jays' }, score: 6 },
            away: { team: { id: 200 + index, name: 'Road Team ' + index }, score: 4 },
          },
        });
        games.push({
          gamePk: 910001 + index * 2,
          gameDate: '2099-07-' + day + 'T23:00:00Z',
          status: { abstractGameState: 'Final', codedGameState: 'F' },
          venue: { id: 500 + index, name: 'Road Park ' + index },
          teams: {
            home: { team: { id: 300 + index, name: 'Home Team ' + index }, score: 4 },
            away: { team: { id: teamId, name: 'Toronto Blue Jays' }, score: 5 },
          },
        });
      }
      return new Response(JSON.stringify({ dates: [{ games }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (/^https:\/\/(?:api|archive-api)\.open-meteo\.com\/v1\/(?:forecast|archive)/.test(target)) {
      return new Response(JSON.stringify({ hourly: {
        time: ['2099-08-11T22:00', '2099-08-11T23:00', '2099-08-12T00:00'],
        temperature_2m: [23, 24, 23],
        relative_humidity_2m: [55, 54, 56],
        precipitation_probability: [0, 0, 0],
        surface_pressure: [1008, 1007, 1008],
        wind_speed_10m: [8, 9, 8],
        wind_direction_10m: [180, 185, 190],
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (/^https:\/\/statsapi\.mlb\.com\/api\/v1\/schedule/.test(target)) {
      officialFetchDates.push(new URL(target).searchParams.get('date'));
      return new Response(JSON.stringify(officialPayload), {
        status: officialStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (/^https:\/\/statsapi\.mlb\.com\/api\/v1\/injuries/.test(target)) {
      return new Response(JSON.stringify({ injuries: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (/^https:\/\/statsapi\.mlb\.com\/api\/v1\/(?:stats|teams\/\d+\/stats)/.test(target)) {
      const group = new URL(target).searchParams.get('group') || 'hitting';
      const stat = group === 'pitching'
        ? { gamesPlayed: 100, gamesPitched: 100, inningsPitched: '900.0', runs: 430, earnedRuns: 410, strikeOuts: 900, baseOnBalls: 300, homeRuns: 120, hits: 850, era: '4.10', whip: '1.28' }
        : { gamesPlayed: 100, plateAppearances: 3800, atBats: 3400, runs: 450, hits: 850, doubles: 170, triples: 20, homeRuns: 130, strikeOuts: 800, baseOnBalls: 320, avg: '.250', obp: '.320', slg: '.420' };
      return new Response(JSON.stringify({
        stats: [{ group: { displayName: group }, splits: [{ stat }] }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (/^https:\/\/api\.sportsbot\.tech\/v2\/odds/.test(target)) {
      return new Response(JSON.stringify({
        status: 'OK',
        data: [
          {
            id: 'official-game-one', time: '2099-08-12T07:00', away: '波士頓紅襪', home: '多倫多藍鳥',
            odds: [{ total: { '8.5': { o: 1.9, u: 1.9, m: true } } }],
          },
          {
            id: 'official-game-two', time: '2099-08-12T10:00', away: '波士頓紅襪', home: '多倫多藍鳥',
            odds: [{ total: { '9.5': { o: 1.9, u: 1.9, m: true } } }],
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const mlbRoute = await import('../app/api/mlb/route.js');
  officialFetchDates.length = 0;
  const taipeiSlateResponse = await mlbRoute.GET(getRequest('/api/mlb?date=2099-08-12', token));
  const taipeiSlatePayload = await taipeiSlateResponse.json();
  assert.equal(taipeiSlateResponse.status, 200);
  assert.equal(taipeiSlatePayload.date, '2099-08-12');
  assert.deepEqual(taipeiSlatePayload.games.map(game => game.gamePk), [880001, 880002]);
  assert.equal(taipeiSlatePayload.games.every(game => game.taipeiDate === '2099-08-12'), true);
  assert.deepEqual([...new Set(officialFetchDates)].sort(), ['2099-08-11', '2099-08-12', '2099-08-13']);

  officialStatus = 503;
  const unavailableTaipeiSlate = await mlbRoute.GET(getRequest('/api/mlb?date=2099-08-12', token));
  assert.equal(unavailableTaipeiSlate.status, 502);
  assert.match((await unavailableTaipeiSlate.json()).error, /官方賽程/);
  officialStatus = 200;

  const readerObservedAt = new Date(Date.now() - 2_000).toISOString();
  const readerPayload = {
    version: 'TAI888-READER-DOM-v2.0.3',
    readerVersion: '2.0.3',
    sourceHost: 'www1.tai888.in',
    pageUrl: 'https://www1.tai888.in/newapp/#/BS',
    boardDate: '2099-08-12',
    observedAt: readerObservedAt,
    pageActivityAt: readerObservedAt,
    expectedGameCount: 2,
    detectedGameCount: 2,
    payloadHash: 'a'.repeat(64),
    games: [rawReaderGame({ boardTime: '07:00' }), rawReaderGame({ boardTime: '10:00', suffix: 1 })],
  };
  const pairRoute = await import('../app/api/reader/pair/route.js');
  const pairResponse = await pairRoute.POST(readerRequest('/api/reader/pair', {
    deviceId: 'route-reader-device-1234', deviceName: 'Route E2E Reader', password: process.env.READER_PAIR_SECRET,
  }));
  const pairPayload = await pairResponse.json();
  assert.equal(pairResponse.status, 200);
  assert.match(pairPayload.token, /^reader-v2\./);
  const ingestRoute = await import('../app/api/reader/ingest/route.js');
  const ingestResponse = await ingestRoute.POST(readerRequest('/api/reader/ingest', readerPayload, { token: pairPayload.token }));
  const ingestPayload = await ingestResponse.json();
  assert.equal(ingestResponse.status, 200, ingestPayload.error || 'Reader full-slate ingest must pass');
  assert.equal(ingestPayload.heartbeat, false);
  assert.equal(ingestPayload.matchedGameCount, 2);
  assert.notEqual(ingestPayload.payloadHash, readerPayload.payloadHash, 'server hash must replace spoofed client hash');
  const creditRoute = await import('../app/api/credit-lines/route.js');
  const signedCreditResponse = await creditRoute.POST(request('/api/credit-lines', token, {
    date: '2099-08-12',
    schedule: [clientGame()],
  }));
  const signedCreditPayload = await signedCreditResponse.json();
  assert.equal(signedCreditResponse.status, 200);
  assert.equal(signedCreditPayload.games.length, 1);
  assert.equal(signedCreditPayload.provider, 'TAI888_READER_AUTO');
  assert.equal(signedCreditPayload.pageActivityAt, readerObservedAt);
  assert.ok(await Promise.all(signedCreditPayload.games[0].markets.map(row => verifyMarketRow('MLB', signedCreditPayload.games[0].game, row))).then(results => results.every(Boolean)));

  const analyzeRoute = await import('../app/api/analyze/route.js');
  const fullAnalysisResponse = await analyzeRoute.POST(request('/api/analyze', token, {
    game: signedCreditPayload.games[0].game,
    markets: signedCreditPayload.games[0].markets,
    previousMarkets: [],
    verificationMarkets: [],
    settings: { rebateRate: 0.015, simulationsPerScenario: 500, candidateThreshold: 7.2, strongestThreshold: 8.5 },
  }));
  const fullAnalysisPayload = await fullAnalysisResponse.json();
  assert.equal(fullAnalysisResponse.status, 200, fullAnalysisPayload.error || 'signed Reader full analysis must pass');
  assert.equal(fullAnalysisPayload.analysis.analysisType, 'FULL');
  assert.ok(fullAnalysisPayload.repriceSnapshot?.distributionSnapshot?.distributionHash);

  const heartbeatObservedAt = new Date(Date.now() - 100).toISOString();
  const heartbeatPageActivityAt = new Date(Date.now() - 250).toISOString();
  const heartbeatResponse = await ingestRoute.POST(readerRequest('/api/reader/ingest', {
    ...readerPayload,
    observedAt: heartbeatObservedAt,
    pageActivityAt: heartbeatPageActivityAt,
    payloadHash: 'c'.repeat(64),
  }, { token: pairPayload.token }));
  const heartbeatPayload = await heartbeatResponse.json();
  assert.equal(heartbeatResponse.status, 200, heartbeatPayload.error || 'Reader heartbeat must pass');
  assert.equal(heartbeatPayload.heartbeat, true);
  assert.equal(heartbeatPayload.payloadHash, ingestPayload.payloadHash);
  assert.equal(heartbeatPayload.pageActivityAt, heartbeatPageActivityAt);

  const refreshedCreditResponse = await creditRoute.POST(request('/api/credit-lines', token, {
    date: '2099-08-12', schedule: [clientGame()],
  }));
  const refreshedCreditPayload = await refreshedCreditResponse.json();
  assert.equal(refreshedCreditResponse.status, 200);
  assert.equal(refreshedCreditPayload.payloadHash, signedCreditPayload.payloadHash);
  assert.equal(refreshedCreditPayload.pageActivityAt, heartbeatPageActivityAt);
  assert.ok(refreshedCreditPayload.games[0].markets.every(row => row.lineAsOf === heartbeatPageActivityAt));

  const repriceRoute = await import('../app/api/reprice/route.js');
  const heartbeatRepriceResponse = await repriceRoute.POST(request('/api/reprice', token, {
    snapshot: fullAnalysisPayload.repriceSnapshot,
    markets: refreshedCreditPayload.games[0].markets,
    previousMarkets: signedCreditPayload.games[0].markets,
    verificationMarkets: [],
    settings: { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5 },
  }));
  const heartbeatRepricePayload = await heartbeatRepriceResponse.json();
  assert.equal(heartbeatRepriceResponse.status, 200, heartbeatRepricePayload.error || 'same-hash heartbeat reprice must pass');
  assert.equal(heartbeatRepricePayload.analysis.analysisType, 'PRICE_ONLY_REPRICE');
  assert.equal(heartbeatRepricePayload.analysis.distributionHash, fullAnalysisPayload.analysis.distributionHash);
  assert.equal(heartbeatRepricePayload.analysis.lineAsOf, heartbeatPageActivityAt);

  const referenceRoute = await import('../app/api/reference-lines/route.js');
  const subsetResponse = await referenceRoute.POST(request('/api/reference-lines', token, {
    date: '2099-08-12',
    schedule: [clientGame()],
  }));
  const subsetPayload = await subsetResponse.json();
  assert.equal(subsetResponse.status, 200);
  assert.equal(subsetPayload.games.length, 1);
  assert.equal(subsetPayload.games[0].gamePk, 880001);
  assert.ok(subsetPayload.games[0].markets.every(row => row.providerEventId === 'official-game-one'));
  assert.ok(await Promise.all(subsetPayload.games[0].markets.map(row => verifyMarketRow('MLB', subsetPayload.games[0].game, row))).then(results => results.every(Boolean)));

  const mixedScheduleResponse = await referenceRoute.POST(request('/api/reference-lines', token, {
    date: '2099-08-12',
    schedule: [{ ...clientGame(), homeTeamId: 147 }],
  }));
  assert.equal(mixedScheduleResponse.status, 409);
  assert.match((await mixedScheduleResponse.json()).error, /官方場次識別不一致/);

  const forgedReaderResponse = await analyzeRoute.POST(request('/api/analyze', token, {
    game: clientGame(),
    markets: [{
      market: '全場大小', pick: '大8.5', water: 0.95, confidence: 1,
      sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO',
      sourceLabel: 'Tai888 Reader 自動信用盤', lineAsOf: '2099-08-11T22:59:00Z', executable: true,
    }],
  }));
  assert.equal(forgedReaderResponse.status, 409);
  assert.match((await forgedReaderResponse.json()).error, /缺少伺服器簽章/);

  officialStatus = 503;
  const unavailableSchedule = await analyzeRoute.POST(request('/api/analyze', token, {
    game: clientGame(),
    markets: [],
  }));
  assert.equal(unavailableSchedule.status, 502);
  assert.match((await unavailableSchedule.json()).error, /官方賽程/);

  officialStatus = 200;
  officialPayload = { dates: [{ games: [statsGame({ gamePk: 880002, gameDate: '2000-08-11T23:00:00Z' })] }] };
  const startedResponse = await analyzeRoute.POST(request('/api/analyze', token, {
    game: clientGame({ gamePk: 880002, gameDate: '2000-08-11T23:00:00Z' }),
    markets: [],
  }));
  assert.equal(startedResponse.status, 409);
  assert.match((await startedResponse.json()).error, /開打時間|已開始/);

  officialPayload = { dates: [{ games: [statsGame()] }] };
  const futureGame = clientGame();
  const signedSnapshot = await signRepriceSnapshot('MLB', futureGame, {
    frozenContext: { game: futureGame, fetchedAt: '2099-08-11T22:00:00Z' },
    coreFingerprint: 'core-fingerprint',
    distributionSnapshot: { distributionId: 'distribution-1', distributionHash: 'distribution-hash' },
    distributionId: 'distribution-1',
    distributionHash: 'distribution-hash',
    inputHash: 'input-1',
  });
  const tamperedSnapshotResponse = await repriceRoute.POST(request('/api/reprice', token, {
    snapshot: { ...signedSnapshot, coreFingerprint: 'attacker-controlled-core' },
    markets: [],
  }));
  assert.equal(tamperedSnapshotResponse.status, 409);
  assert.match((await tamperedSnapshotResponse.json()).error, /快照簽章無效|已被修改/);

  console.log(JSON.stringify({
    ok: true,
    authFailClosed: true,
    forgedReaderRejected: true,
    officialFailureIs502: true,
    taipeiScheduleContract: true,
    scheduleMixRejected: true,
    doubleheaderSubsetClosed: true,
    creditMarketsSigned: true,
    pairIngestAnalyzeHeartbeatReprice: true,
    referenceMarketsSigned: true,
    startedGameRejected: true,
    alteredSnapshotRejected: true,
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnv)) setOrDelete(name, value);
}
