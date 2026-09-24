import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createExternalJsonTransport } from '../lib/external-json-transport.js';
import { createRequestTiming } from '../lib/request-timing.js';
import { referenceAttempt, referenceFailureCode } from '../lib/reference-acquisition-evidence.js';

let clock = 1000;
let calls = 0;
let status = 402;
let body = { message: 'Monthly usage limit reached' };
const logs = [];
const transport = createExternalJsonTransport({ now: () => clock, cooldownMs: 5000,
  log: row => logs.push(row), fetchImpl: async () => {
    calls += 1; clock += 7;
    return { ok: status < 400, status, text: async () => { clock += 3; return JSON.stringify(body); } };
  } });
const url = 'https://provider.example/data?apiKey=secret-one';
await assert.rejects(transport(url), e => e.code === 'QUOTA_EXHAUSTED' && e.httpStatus === 402);
assert.equal(calls, 1);
const firstDuration = logs.at(-1).durationMs;
await assert.rejects(transport(url), e => e.code === 'QUOTA_EXHAUSTED' && e.retryAfterSeconds === 5);
assert.equal(calls, 1, 'cooldown must skip the upstream request');
assert.equal(logs.at(-1).durationMs, 0);
assert.equal(firstDuration, 10);
status = 200; body = { ok: true, value: 42 };
assert.equal((await transport(url.replace('secret-one', 'secret-two'))).value, 42, 'rotated key can recover immediately');
assert.equal((await transport(url.replace('provider.example', 'other.example'))).value, 42, 'another origin remains available');
clock += 5000;
assert.equal((await transport(url)).value, 42, 'cooldown expires and upstream is retried');
const beforeSuccess = calls;
await transport(url); await transport(url);
assert.equal(calls, beforeSuccess + 2, 'success data is never cached by the transport');
status = 429; body = { error: 'Too many requests' };
const beforeRate = calls;
await assert.rejects(transport(url)); await assert.rejects(transport(url));
assert.equal(calls, beforeRate + 2, 'ordinary rate limiting is not treated as exhausted quota');
assert(!JSON.stringify(logs).includes('secret-one'));
assert(!JSON.stringify(logs).includes('apiKey'));
assert(!JSON.stringify(logs).includes('Monthly usage'));
const malformed = createExternalJsonTransport({ log() {}, fetchImpl: async () => ({ status: 502, ok: false, text: async () => '<html>error</html>' }) });
await assert.rejects(malformed(url), e => e.code === 'INVALID_JSON' && e.httpStatus === 502);
const stalled = createExternalJsonTransport({ log() {}, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
}) });
await assert.rejects(stalled(url, {}, 10), e => e.name === 'AbortError');
const bodyStalled = createExternalJsonTransport({ log() {}, fetchImpl: async (_url, { signal }) => ({ ok: true, status: 200,
  text: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) }) });
await assert.rejects(bodyStalled(url, {}, 10), e => e.name === 'AbortError');
const brokenLogger = createExternalJsonTransport({ log() { throw Error('logging down'); }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }) });
assert.equal((await brokenLogger(url)).ok, true);

// Run the actual route with isolated service boundaries: status/receipts/auth
// must survive both the initial failure and the fast cooldown response.
const routeSource = fs.readFileSync(new URL('../app/api/reference-lines/route.js', import.meta.url), 'utf8')
  .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/g, '')
  .replace(/export\s+/g, '');
const routeLogs = [];
let upstreamCalls = 0;
const routeTransport = createExternalJsonTransport({ log: row => routeLogs.push(row), fetchImpl: async () => {
  upstreamCalls += 1; return { status: 401, ok: false, text: async () => '{"message":"quota exhausted"}' };
} });
let authResponse = null;
const game = { gamePk: 1, away: 'A', home: 'B' };
const deps = {
  NextResponse: { json: (data, init) => Response.json(data, init) },
  fetchExternalJson: routeTransport,
  createRequestTiming: route => createRequestTiming(route, { log: row => routeLogs.push(row) }),
  ODDS_API_EVENT_MARKETS: [], REFERENCE_LINES_VERSION: 'test',
  requireApiAuth: async () => authResponse, validateSameOrigin: () => true,
  checkRateLimit: () => ({ allowed: true }), readJsonBody: async r => r.json(),
  requestedLeagueId: value => value, cleanText: value => String(value || ''), validDateString: () => true,
  fetchLeagueTaipeiSlate: async () => [game], validateLeagueScheduleSubset: () => [game],
  referenceProviderStatus: () => ({ configured: true, providers: [{ id: 'THE_ODDS_API_CONSENSUS', configured: true }] }),
  oddsApiWindow: () => ({ start: 'test-start', end: 'test-end' }),
  referenceAttempt, referenceFailureCode,
  signReferenceReceipt: async (_league, _game, evidence) => ({ payload: { evidence }, signature: 'test' }),
  recordReferenceSourceHealth: () => ({ reasons: ['QUOTA_EXHAUSTED'] }),
  console: { warn() {} },
};
const route = new Function(...Object.keys(deps), `${routeSource}\nreturn { POST };`)(...Object.values(deps));
const previousKey = process.env.THE_ODDS_API_KEY;
process.env.THE_ODDS_API_KEY = 'test-only-key';
try {
  for (let n = 0; n < 2; n++) {
    const response = await route.POST(new Request('https://site.example/api/reference-lines', { method: 'POST', body: JSON.stringify({ league: 'MLB', date: '2026-09-24', schedule: [game] }) }));
    assert.equal(response.status, 502);
    assert.match(response.headers.get('server-timing'), /^total;dur=/);
    const data = await response.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, 'QUOTA_EXHAUSTED');
    assert.match(data.error, /額度已用盡/);
    assert.deepEqual(data.games, []);
    assert.equal(data.receipts.length, 1, 'failure receipts remain available');
    assert(data.receipts[0].receipt.payload.evidence.attempts.some(x => x.reasonCode === 'QUOTA_EXHAUSTED'));
  }
  assert.equal(upstreamCalls, 1);
  authResponse = Response.json({ ok: false }, { status: 401 });
  assert.equal((await route.POST(new Request('https://site.example/api/reference-lines', { method: 'POST' }))).status, 401);
  assert.equal(upstreamCalls, 1, 'unauthenticated request never reaches upstream');
  assert(routeLogs.some(x => x.event === 'REQUEST_STAGE_TIMING' && x.stages.some(s => s.stage === 'provider_b' && s.outcome === 'failed')));
} finally {
  if (previousKey === undefined) delete process.env.THE_ODDS_API_KEY; else process.env.THE_ODDS_API_KEY = previousKey;
}
console.log('PASS external transport: quota cooldown, recovery, isolation, timeout, safe timings, real route errors/receipts/auth');
