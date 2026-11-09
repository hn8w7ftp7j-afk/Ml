import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NextResponse } from 'next/server.js';
import * as maintenance from '../lib/soccer/raw-seen-history-maintenance.js';
import { createSessionToken, requireApiAuth, validateSameOrigin, originErrorResponse,
  rateLimitResponse, readJsonBody } from '../lib/security.js';

// Real site session/origin/body handling at an isolated maintenance boundary.
// This test has no production credentials, network calls, or database writes.
const envKeys = ['APP_PASSWORD', 'SESSION_SECRET'];
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, {
  APP_PASSWORD: 'local-history-maintenance-route-password',
  SESSION_SECRET: 'local-history-maintenance-route-secret-abcdefghijklmnopqrstuvwxyz',
});
const token = await createSessionToken(), expired = await createSessionToken(-1);
const schema = 'soccer-raw-history-maintenance-v1';
const flags = { archiveOnly: true, currentBoardUpdated: false, historicalAvailabilityVerified: false,
  executable: false, formalEligible: false, calibrationEligible: false, coverageComplete: false,
  closingCoverage: 'NOT_VERIFIED', indexCoverage: 'NOT_VERIFIED' };
const zero = { sourceFragments: 0, sourceBatches: 0, indexedBatches: 0, unindexedBatches: 0,
  stableAttemptBatches: 0, retryPendingBatches: 0, indexedGames: 0 };
const until = '2026-11-09T04:00:00.000Z';
let calls = [], rates = [], blocked = false, progressError = null, drainError = null;
const pendingCounts = { ...zero, sourceFragments: 3, sourceBatches: 2, indexedBatches: 1,
  unindexedBatches: 1, retryPendingBatches: 1, indexedGames: 9 };
let progress = { ok: true, schema, ...flags, status: 'PENDING', until,
  derivationVersion: 'SOCCER-RAW-CREDIT-TABLE-HISTORY-v2', countUnit: 'CANONICAL_SOURCE_BATCHES',
  dateBasis: 'SOURCE_OBSERVATION_TAIPEI_DATE', counts: pendingCounts,
  leagues: [{ league: 'EPL', counts: pendingCounts,
    days: [{ sourceDate: '2026-11-08', counts: pendingCounts }], reasons: [] },
  { league: 'UCL', counts: zero, days: [], reasons: [] }] };
let drained = { ok: true, schema, ...flags, status: 'WINDOW_EXHAUSTED', until,
  budgetKind: 'SOFT_DEADLINE', hardDeadlineEnforced: false, completeWithinWindow: false,
  maxBatches: 24, timeBudgetMs: 40000, processedBatches: 2, indexedBatches: 1,
  stableAttemptBatches: 1, retryableBatches: 0, results: [
    { league: 'EPL', mode: 'BUCKET_OLDEST', status: 'INDEXED', captureId: 'a'.repeat(64), indexedGames: 4 },
    { league: 'UCL', mode: 'BUCKET_NEWEST', status: 'SOURCE_UNINDEXED', captureId: 'b'.repeat(64), reason: 'RAW_SEEN_RECOVERY_INCOMPLETE' },
  ] };
const source = readFileSync(new URL('../app/api/soccer/raw-seen-history-maintenance/route.js', import.meta.url), 'utf8');
const imports = [...source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"];?\s*$/gm)]
  .flatMap(match => match[1].split(',').map(name => name.trim()).filter(Boolean));
const services = {
  ...maintenance,
  NextResponse, requireApiAuth, validateSameOrigin, originErrorResponse, rateLimitResponse, readJsonBody,
  checkRateLimit: (_request, options) => { rates.push(options); return { allowed: !blocked, retryAfter: 7 }; },
  getRawSeenHistoryProgress: async (...args) => { calls.push({ operation: 'progress', args }); if (progressError) throw progressError; return structuredClone(progress); },
  drainRawSeenHistoryIndex: async (...args) => { calls.push({ operation: 'drain', args }); if (drainError) throw drainError; return structuredClone(drained); },
};
for (const name of imports) assert.ok(Object.hasOwn(services, name), `unmocked route dependency ${name}`);
const body = source.replace(/^import\s*\{[^}]+\}\s*from\s*['"][^'"]+['"];?\s*$/gm, '').replace(/^export /gm, '');
const { GET, POST } = new Function(...imports, `${body}; return { GET, POST };`)(...imports.map(name => services[name]));
const request = (method = 'GET', value, options = {}) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.cookie !== false) headers.set('cookie', `mlb_session=${options.cookie || token}`);
  for (const [key, value] of Object.entries(options.headers || {})) headers.set(key, value);
  return new Request(`https://fixture.invalid/api/soccer/raw-seen-history-maintenance${options.query || ''}`, {
    method, headers, ...(method === 'POST' ? { body: options.rawBody ?? JSON.stringify(value) } : {}),
  });
};
const noStorage = async (run, status) => {
  const before = calls.length, response = await run();
  assert.equal(response.status, status); assert.equal(calls.length, before, 'rejection precedes the maintenance boundary');
  return response;
};
const assertFlags = value => {
  assert.equal(value.schema, schema);
  for (const [key, expected] of Object.entries(flags)) assert.equal(value[key], expected, key);
};
const assertPrivate = response => {
  assert.match(response.headers.get('cache-control') || '', /(?:private.*no-store|no-store.*private)/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
};
try {
  for (const cookie of [false, expired, 'expired.invalid']) {
    await noStorage(() => GET(request('GET', undefined, { cookie })), 401);
    await noStorage(() => POST(request('POST', { action: 'drain' }, { cookie })), 401);
  }
  delete process.env.SESSION_SECRET;
  await noStorage(() => GET(request()), 503);
  await noStorage(() => POST(request('POST', { action: 'drain' })), 503);
  process.env.SESSION_SECRET = 'local-history-maintenance-route-secret-abcdefghijklmnopqrstuvwxyz';

  for (const query of ['?league=EPL', '?maxBatches=64', '?unknown=', '?action=drain&action=drain']) {
    await noStorage(() => GET(request('GET', undefined, { query })), 400);
    await noStorage(() => POST(request('POST', { action: 'drain' }, { query })), 400);
  }
  for (const headers of [{ origin: 'https://other.invalid' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'not an origin' }]) {
    await noStorage(() => POST(request('POST', { action: 'drain' }, { headers })), 403);
  }
  for (const value of [null, [], 'drain', {}, { action: 'scan' }, { action: 'drain ' },
    { action: 'drain', maxBatches: 64 }, { action: 'drain', timeBudgetMs: 1 }, { action: 'drain', league: 'EPL' }]) {
    await noStorage(() => POST(request('POST', value)), 400);
  }
  await noStorage(() => POST(request('POST', null, { rawBody: '{broken' })), 400);
  await noStorage(() => POST(request('POST', null, { rawBody: '' })), 400);
  await noStorage(() => POST(request('POST', null, { rawBody: '{"action":"drain","__proto__":{"polluted":true}}' })), 400);
  assert.equal({}.polluted, undefined);
  await noStorage(() => POST(request('POST', { action: 'drain' }, { headers: { 'content-length': '4097' } })), 413);
  await noStorage(() => POST(request('POST', null, { rawBody: JSON.stringify({ action: '盤'.repeat(1500) }) })), 413);

  blocked = true;
  for (const run of [() => GET(request()), () => POST(request('POST', { action: 'drain' }))]) {
    const response = await noStorage(run, 429); assert.equal(response.headers.get('retry-after'), '7');
  }
  blocked = false;
  calls = []; rates = [];
  let response = await GET(request()); assert.equal(response.status, 200); assertPrivate(response);
  let result = await response.json(); assert.deepEqual(result, progress); assertFlags(result);
  assert.deepEqual(calls.map(call => call.operation), ['progress'], 'GET reads progress only and cannot trigger a drain');
  assert.equal(rates[0].limit, 60); assert.equal(rates[0].windowMs, 600000);
  const getRateId = rates[0].id;

  progress = { ...progress, status: 'NOT_INITIALIZED', counts: null,
    leagues: ['EPL', 'UCL'].map(league => ({ league, counts: null, days: [], reasons: [] })) };
  response = await GET(request()); assert.equal(response.status, 200); result = await response.json();
  assertFlags(result); assert.equal(result.counts, null);
  assert.ok(result.leagues.every(league => league.counts === null), 'missing progress storage stays unknown rather than zero');

  calls = []; rates = [];
  response = await POST(request('POST', { action: 'drain' }, { headers: { origin: 'https://fixture.invalid', 'sec-fetch-site': 'same-origin' } }));
  assert.equal(response.status, 200); assertPrivate(response); result = await response.json();
  assert.deepEqual(result, drained); assertFlags(result);
  assert.deepEqual(calls, [{ operation: 'drain', args: [{ maxBatches: 24, timeBudgetMs: 40000 }] }]);
  assert.equal(rates[0].limit, 12); assert.equal(rates[0].windowMs, 600000); assert.notEqual(rates[0].id, getRateId);

  drained = { ...drained, status: 'BUDGET_DEFERRED' };
  response = await POST(request('POST', { action: 'drain' })); assert.equal(response.status, 200);
  result = await response.json(); assert.deepEqual(result, drained); assertFlags(result);
  assert.equal(result.indexedBatches, 1, 'a soft time boundary preserves completed receipts');
  assert.equal(result.completeWithinWindow, false, 'stopping at a budget never claims source completeness');

  drained = { ...drained, ok: false, status: 'RETRYABLE', retryableBatches: 1,
    processedBatches: 3, results: [...drained.results,
      { league: 'EPL', mode: 'BACKLOG', status: 'RETRYABLE', captureId: 'c'.repeat(64), reason: 'RAW_HISTORY_INDEX_UNAVAILABLE' }] };
  response = await POST(request('POST', { action: 'drain' })); assert.equal(response.status, 503); assertPrivate(response);
  result = await response.json(); assertFlags(result); assert.deepEqual(result, drained);
  assert.equal(result.indexedBatches, 1, 'a retryable sibling does not erase already completed work');
  assert.equal(result.processedBatches, 3);

  const secretDetail = 'postgres://never-print-this-password@database.internal/private';
  progressError = new Error(secretDetail);
  response = await GET(request()); assert.equal(response.status, 503); assertPrivate(response); result = await response.json(); assertFlags(result);
  assert.equal(result.ok, false); assert.notDeepEqual(result.counts, zero); assert.doesNotMatch(JSON.stringify(result), /never-print|database\.internal/);
  progressError = null; drainError = new Error(secretDetail);
  response = await POST(request('POST', { action: 'drain' })); assert.equal(response.status, 503); assertPrivate(response); result = await response.json(); assertFlags(result);
  assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /never-print|database\.internal/);
  console.log('PASS maintenance owner route: real session/origin/body boundaries, distinct rate limits, readonly GET, unknown progress, bounded POST, preserved partial receipts, sanitized storage failures; isolated NOT Production');
} finally {
  for (const key of envKeys) previousEnv[key] === undefined ? delete process.env[key] : process.env[key] = previousEnv[key];
}
