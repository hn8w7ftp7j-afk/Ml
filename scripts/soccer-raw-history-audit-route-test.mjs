import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NextResponse } from 'next/server.js';
import * as audit from '../lib/soccer/raw-seen-history-audit.js';
import { createSessionToken, requireApiAuth, validateSameOrigin, originErrorResponse,
  rateLimitResponse } from '../lib/security.js';

// Actual route/session/origin/query boundaries; only the source-audit read is
// replaced. No production session, remote request or database write occurs.
const envKeys = ['APP_PASSWORD', 'SESSION_SECRET'];
const beforeEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, { APP_PASSWORD: 'isolated-raw-audit-route-password',
  SESSION_SECRET: 'isolated-raw-audit-route-secret-abcdefghijklmnopqrstuvwxyz' });
const token = await createSessionToken(), expired = await createSessionToken(-1);
const schema = 'soccer-raw-history-audit-v1';
const flags = { archiveOnly: true, currentBoardUpdated: false, historicalAvailabilityVerified: false,
  executable: false, formalEligible: false, calibrationEligible: false, coverageComplete: false,
  closingCoverage: 'NOT_VERIFIED', indexCoverage: 'NOT_VERIFIED' };
let calls = [], rates = [], blocked = false, sourceError = null;
let report = { ok: true, schema, status: 'BOUNDED_SAMPLE', until: '2026-11-09T08:00:00.000Z',
  filters: { league: null, limit: 2 }, ...flags,
  samples: [{ league: 'EPL', captureId: 'a'.repeat(64), captureBatchId: 'b'.repeat(64),
    sourceObservedAt: '2026-11-08T17:17:33.766Z', attemptReason: 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT',
    status: 'VERIFIED_SOURCE', classification: 'FLAT_TEXT_ONLY', fragmentCount: 1,
    headers: [{ values: [], tables: 1 }], rowWidths: [{ cells: 1, rows: 137 }],
    rowCount: 137, cellCount: 137,
    sectionScopeSummary: { basis: 'SOURCE_SECTION_LABELS_NOT_OFFICIAL_IDENTITY', matchingStandardTables: 1,
      matchingStandardRows: 137, excludedTables: 0, excludedRows: 0, unknownTables: 0, unknownRows: 0 },
    replay: { status: 'SOURCE_UNINDEXED', reason: 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT', gameCount: null, marketCount: null },
    fragmentManifest: [{ captureId: 'a'.repeat(64), evidenceHash: 'c'.repeat(64), partIndex: 0, partCount: 1,
      receivedAt: '2026-11-08T17:17:37.513000Z', persistedAt: '2026-11-08T17:17:37.524000Z' }],
    siblings: [], ...flags }],
  budget: { sourceBytesRead: 8000, maxSourceBytes: 10485760, timeBudgetMs: 25000,
    budgetKind: 'SOFT_DEADLINE', hardDeadlineEnforced: false } };
const source = readFileSync(new URL('../app/api/soccer/raw-seen-history-audit/route.js', import.meta.url), 'utf8');
const importPattern = /^import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"];?\s*$/gm;
const imports = [...source.matchAll(importPattern)].flatMap(match => match[1].split(',').map(name => name.trim()).filter(Boolean));
const services = { ...audit, NextResponse, requireApiAuth, validateSameOrigin, originErrorResponse, rateLimitResponse,
  checkRateLimit: (_request, options) => { rates.push(options); return { allowed: !blocked, retryAfter: 9 }; },
  readRawSeenHistoryAudit: async (...args) => { calls.push(args); if (sourceError) throw sourceError; return structuredClone(report); } };
for (const name of imports) assert.ok(Object.hasOwn(services, name), `unmocked route dependency ${name}`);
const body = source.replace(importPattern, '').replace(/^export /gm, '');
const { GET } = new Function(...imports, `${body}; return { GET };`)(...imports.map(name => services[name]));
assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH|DELETE)\b/, 'audit route is read-only');
const request = (query = '', options = {}) => {
  const headers = new Headers(options.headers || {});
  if (options.cookie !== false) headers.set('cookie', `mlb_session=${options.cookie || token}`);
  return new Request(`https://fixture.invalid/api/soccer/raw-seen-history-audit${query}`, { headers });
};
const rejectedBeforeRead = async (request, status) => {
  const before = calls.length, response = await GET(request);
  assert.equal(response.status, status); assert.equal(calls.length, before, 'request rejected before source access');
  return response;
};
const privateResponse = response => {
  assert.match(response.headers.get('cache-control') || '', /private.*no-store|no-store.*private/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
};
const assertFlags = value => { assert.equal(value.schema, schema); for (const [key, expected] of Object.entries(flags)) assert.equal(value[key], expected, key); };
try {
  for (const cookie of [false, expired, 'expired.invalid']) await rejectedBeforeRead(request('', { cookie }), 401);
  delete process.env.SESSION_SECRET;
  await rejectedBeforeRead(request(), 503);
  process.env.SESSION_SECRET = 'isolated-raw-audit-route-secret-abcdefghijklmnopqrstuvwxyz';
  for (const headers of [{ origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'malformed origin' }])
    await rejectedBeforeRead(request('', { headers }), 403);
  for (const query of ['?league=NBA', '?league=epl', '?league=', '?league=EPL&league=UCL', '?limit=', '?limit=0',
    '?limit=5', '?limit=-1', '?limit=1.5', '?limit=04', '?limit=2&limit=2', '?captureId=' + 'a'.repeat(64),
    '?unknown=', '?limit=4&maxSourceBytes=99999999', '?league=%27%20OR%201%3D1--'])
    await rejectedBeforeRead(request(query), 400);
  blocked = true;
  let response = await rejectedBeforeRead(request('?league=EPL&limit=4'), 429);
  assert.equal(response.headers.get('retry-after'), '9');
  blocked = false; calls = []; rates = [];
  response = await GET(request()); assert.equal(response.status, 200); privateResponse(response);
  let value = await response.json(); assert.deepEqual(value, report); assertFlags(value);
  assert.deepEqual(value.samples[0].sectionScopeSummary, report.samples[0].sectionScopeSummary,
    'route preserves bounded source-label diagnostics without promoting official identity');
  assert.equal(calls.length, 1); assert.equal(calls[0][0].league ?? null, null); assert.equal(calls[0][0].limit, 2);
  assert.equal(rates[0].limit, 30); assert.equal(rates[0].windowMs, 600000);
  for (const league of ['EPL', 'UCL']) {
    calls = [];
    response = await GET(request(`?league=${league}&limit=4`, { headers: { origin: 'https://fixture.invalid', 'sec-fetch-site': 'same-origin' } }));
    assert.equal(response.status, 200); assert.equal(calls[0][0].league, league); assert.equal(calls[0][0].limit, 4);
    value = await response.json(); assertFlags(value);
  }
  report = { ...report, samples: [{ ...report.samples[0], status: 'UNKNOWN', classification: 'UNKNOWN',
    sectionScopeSummary: null,
    replay: { status: 'UNKNOWN', reason: 'RAW_HISTORY_AUDIT_SOURCE_BYTES_BUDGET', gameCount: null, marketCount: null } }] };
  response = await GET(request()); assert.equal(response.status, 200); privateResponse(response);
  value = await response.json(); assert.deepEqual(value, report); assertFlags(value);
  assert.equal(value.samples[0].sectionScopeSummary, null);
  assert.equal(value.samples[0].replay.gameCount, null, 'bounded unknown sibling never invents a zero-game result');
  report = { ...report, ok: false, status: 'UNKNOWN', reason: 'RAW_HISTORY_AUDIT_STORAGE_NOT_INITIALIZED', samples: [] };
  response = await GET(request()); assert.equal(response.status, 503); privateResponse(response);
  value = await response.json(); assert.deepEqual(value, report); assertFlags(value);
  assert.equal(value.status, 'UNKNOWN', 'missing schema remains unknown rather than an empty-source pass');
  assert.notEqual(value.coverageComplete, true);
  sourceError = new Error('postgres://secret-password@private-database.internal/credential');
  response = await GET(request()); assert.equal(response.status, 503); privateResponse(response);
  value = await response.json(); assertFlags(value); assert.equal(value.ok, false); assert.equal(value.status, 'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(value), /secret-password|private-database|credential/);
  console.log('PASS bounded raw-history audit GET route: real session/origin, strict league/limit, distinct read rate, bounded service handoff, private no-store, unknown schema and sanitized errors; isolated NOT Production');
} finally {
  for (const key of envKeys) beforeEnv[key] === undefined ? delete process.env[key] : process.env[key] = beforeEnv[key];
}
