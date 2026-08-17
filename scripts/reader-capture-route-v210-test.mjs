import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { createReaderToken } from '../lib/reader-auth-v2.js';
import { loadLeagueCapture } from '../lib/reader-capture-store-v3.js';
import { canonicalReaderPayload } from '../reader/parser.js';

register('./next-route-test-loader.mjs', import.meta.url);
process.env.READER_PAIR_SECRET = 'reader-capture-route-v210-secret';
process.env.READER_STORE_MEMORY_ONLY = 'true';

const deviceId = 'reader-capture-v210-device';
const token = await createReaderToken({ deviceId });
const now = Date.now();

function game(overrides = {}) {
  return {
    awayCode: 'G',
    homeCode: 'T',
    boardDate: '2026-08-18',
    boardTime: '18:00',
    marketStatus: 'open',
    fullRunline: { lineSide: 'away', line: '1平', awayWater: 0.95, homeWater: 0.95, privateRows: ['secret-row'] },
    fullTotal: { line: '8平', overWater: 0.94, underWater: 0.94 },
    first5Runline: { lineSide: 'home', line: '0.5', awayWater: 0.93, homeWater: 0.93 },
    first5Total: { line: '4平', overWater: 0.92, underWater: 0.92 },
    accountToken: 'must-not-survive',
    ...overrides,
  };
}

function payload(overrides = {}) {
  const value = {
    version: 'TAI888-READER-DOM-v2.1.0',
    readerVersion: '2.1.0 FOUR LEAGUE TABS',
    league: 'NPB',
    sourceHost: 'www1.tai888.in',
    pageUrl: 'https://www1.tai888.in/newapp/#/BS',
    pageTitle: 'private-title-must-not-survive',
    boardDate: '2026-08-18',
    observedAt: new Date(now - 2_000).toISOString(),
    pageActivityAt: new Date(now - 3_000).toISOString(),
    expectedGameCount: 1,
    detectedGameCount: 1,
    games: [game()],
    ...overrides,
  };
  value.payloadHash = createHash('sha256').update(canonicalReaderPayload(value)).digest('hex');
  return value;
}

let requestIndex = 1;
function request(body) {
  requestIndex += 1;
  return new Request('https://example.test/api/reader/capture', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Device-Id': deviceId,
      Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'X-Forwarded-For': `192.0.2.${requestIndex}`,
    },
    body: JSON.stringify(body),
  });
}

const route = await import('../app/api/reader/capture/route.js');
const goodBody = payload();
const goodResponse = await route.POST(request(goodBody));
const goodResult = await goodResponse.json();
assert.equal(goodResponse.status, 200, goodResult.error);
assert.equal(goodResult.captured, true);
assert.equal(goodResult.executable, false);
const stored = await loadLeagueCapture('NPB', '2026-08-18');
assert.equal(stored.league, 'NPB');
assert.equal(stored.games.length, 1);
assert.equal(stored.games[0].fullRunline.line, '1平');
for (const secret of ['secret-row', 'must-not-survive', 'private-title-must-not-survive']) {
  assert.equal(JSON.stringify(stored).includes(secret), false, `capture allow-list leaked ${secret}`);
}

const replayResponse = await route.POST(request(goodBody));
assert.equal(replayResponse.status, 409);
assert.match((await replayResponse.json()).error, /重播|倒退/);

async function rejected(overrides, expectedStatus, pattern) {
  const response = await route.POST(request(payload(overrides)));
  const result = await response.json();
  assert.equal(response.status, expectedStatus, result.error);
  assert.match(result.error, pattern);
}

await rejected({ sourceHost: 'tai888.in.evil.example', pageUrl: 'https://tai888.in.evil.example/newapp/#/BS' }, 400, /tai888|來源/i);
await rejected({ pageUrl: 'http://www1.tai888.in/newapp/#/BS' }, 400, /pageUrl|HTTPS/);
await rejected({ version: 'TAI888-READER-DOM-v9.9.9' }, 426, /版本/);
await rejected({ detectedGameCount: 2 }, 400, /detectedGameCount/);
await rejected({ observedAt: new Date(now - 11 * 60_000).toISOString(), pageActivityAt: new Date(now - 11 * 60_000).toISOString() }, 400, /時間|差距/);
await rejected({ observedAt: new Date(now + 2 * 60_000).toISOString(), pageActivityAt: new Date(now + 2 * 60_000).toISOString() }, 400, /時間|差距/);
await rejected({ games: [game({ fullRunline: { lineSide: 'away', line: 'DROP', awayWater: 0.95, homeWater: 0.95 } })] }, 400, /市場不完整/);
await rejected({ games: [game({ fullRunline: { lineSide: 'away', line: '9平', awayWater: 0.95, homeWater: 0.95 } })] }, 400, /配對不一致/);
await rejected({ games: [game({ marketStatus: 'locked' })] }, 400, /鎖盤場次不得夾帶/);

console.log('Reader capture v2.1.0 route: token/count/host/url/version/time/replay/line/pair/whitelist gates ok');
