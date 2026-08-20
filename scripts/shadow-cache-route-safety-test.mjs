import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./next-route-test-loader.mjs', import.meta.url);
process.env.APP_PASSWORD = 'shadow-cache-route-password';
process.env.SESSION_SECRET = 'shadow-cache-route-session-secret-with-entropy';
process.env.MARKET_INTEGRITY_SECRET = 'shadow-cache-route-market-secret-with-entropy';

const { createSessionToken } = await import('../lib/security.js');
const { fetchLeagueTaipeiSlate } = await import('../lib/league-provider.js');
const token = await createSessionToken(600);
const originalFetch = globalThis.fetch;

const npbHtml = `<div class="unit"><a class="link_box" href="/bis/eng/2099/games/s20990818001.html">
  <div class="team_name">DeNA</div><div class="score_text score_left">&nbsp;</div>
  <div class="round">Tokyo Dome<br>17:45</div>
  <div class="score_text score_right">&nbsp;</div><div class="team_name">Yomiuri</div>
</a></div>`;

function manualMarkets(game) {
  const row = (market, pick, water) => ({
    market, pick, water, waterEstimated: false, waterMissing: false, confidence: 1,
    sourceType: 'USER_MANUAL_ENTRY', sourceLabel: '使用者手動輸入盤口', provider: 'USER_MANUAL_ENTRY',
    authorizationStatus: 'USER_CONFIRMED_MANUAL', executable: true, lineAsOf: new Date().toISOString(),
  });
  return [
    row('全場讓分', `${game.away}讓1平`, 0.95), row('全場讓分', `${game.home}受讓1平`, 0.95),
    row('全場大小', '大8平', 0.94), row('全場大小', '小8平', 0.94),
    row('上半讓分', `${game.home}讓0.5`, 0.93), row('上半讓分', `${game.away}受讓0.5`, 0.93),
    row('上半大小', '大4平', 0.92), row('上半大小', '小4平', 0.92),
  ];
}

let requestNumber = 0;
function analyzeRequest(game, markets) {
  requestNumber += 1;
  return new Request('https://example.test/api/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://example.test',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: `mlb_session=${encodeURIComponent(token)}`,
      'X-Forwarded-For': `198.51.100.${requestNumber}`,
    },
    body: JSON.stringify({
      league: 'NPB', game, markets, previousMarkets: [], verificationMarkets: [],
      settings: { rebateRate: 0.015, simulationsPerScenario: 500 },
    }),
  });
}

function assertLockedContext(value) {
  assert.equal(value.analysisMode, 'EXPERIMENTAL_SHADOW');
  assert.equal(value.executable, false);
  assert.equal(value.betEligible, false);
}

function assertLockedResult(row) {
  assertLockedContext(row);
  assert.equal(row.scoreType, 'SHADOW_DIAGNOSTIC');
  assert.equal(row.tag, 'SHADOW｜影子評分｜不可下注');
  assert.equal(row.unitSuggestion, null);
  assert.equal(row.portfolioUnit, null);
}

function assertLockedPayload(body) {
  assertLockedContext(body);
  assert.deepEqual(body.portfolio, []);
  assert.equal(body.tag, 'SHADOW｜影子評分｜不可下注');
  assertLockedContext(body.context);
  assertLockedContext(body.analysis);
  assert.deepEqual(body.analysis.portfolio, []);
  body.analysis.results.forEach(assertLockedResult);
  assertLockedContext(body.repriceSnapshot);
  assert.deepEqual(body.repriceSnapshot.portfolio, []);
  assertLockedContext(body.repriceSnapshot.frozenContext);
}

try {
  globalThis.fetch = async () => new Response(npbHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
  const [game] = await fetchLeagueTaipeiSlate('NPB', '2099-08-18');
  assert.ok(game?.gamePk);
  const markets = manualMarkets(game);
  const analyzeRoute = await import('../app/api/analyze/route.js');

  const firstResponse = await analyzeRoute.POST(analyzeRequest(game, markets));
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200, first.error);
  assert.equal(firstResponse.headers.get('X-Analysis-Cache'), 'MISS');
  assertLockedPayload(first);

  const secondResponse = await analyzeRoute.POST(analyzeRequest(game, markets));
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 200, second.error);
  assert.equal(secondResponse.headers.get('X-Analysis-Cache'), 'HIT');
  assertLockedPayload(second);

  const cache = globalThis.__BASEBALL_V1042_ANALYSIS_CACHE__;
  assert.ok(cache instanceof Map, 'V10.4 must use a fresh analysis-cache namespace');
  assert.equal(cache.size, 1);
  const [key, entry] = [...cache.entries()][0];
  cache.set(key, {
    ...entry,
    payload: {
      ...entry.payload,
      analysisMode: 'FORMAL', executable: true, betEligible: true,
      tag: '主推', portfolio: [{ pick: 'unsafe-cache-bypass' }],
      context: { ...entry.payload.context, analysisMode: 'FORMAL', executable: true, betEligible: true },
      repriceSnapshot: {
        ...entry.payload.repriceSnapshot,
        analysisMode: 'FORMAL', executable: true, betEligible: true,
        portfolio: [{ pick: 'unsafe-cache-bypass' }],
        frozenContext: { ...entry.payload.repriceSnapshot.frozenContext, analysisMode: 'FORMAL', executable: true, betEligible: true },
      },
    },
  });

  const poisonedResponse = await analyzeRoute.POST(analyzeRequest(game, markets));
  const recovered = await poisonedResponse.json();
  assert.equal(poisonedResponse.status, 200, recovered.error);
  assert.equal(poisonedResponse.headers.get('X-Analysis-Cache'), 'MISS', 'unsafe cache entry must be deleted and recomputed');
  assert.equal(JSON.stringify(recovered).includes('unsafe-cache-bypass'), false);
  assertLockedPayload(recovered);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Shadow analyze cache route: safe HIT and poisoned top/context/reprice/frozen portfolio entry fail-closed to MISS');
