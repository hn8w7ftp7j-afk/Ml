import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import {
  CLOUD_BET_COMPACT_FIELDS,
  cloudBetSchemaIsCurrent,
  listCloudBetsReadPage,
  normalizeCloudBetReadOptions,
  readCloudBetSchemaState,
  sanitizeCloudBet,
} from '../lib/cloud-bet-store.js';
import { markDatabaseError } from '../lib/database-error.js';
import { summarizeBetLedger } from '../lib/bet-stats.js';
import { buildScorePerformanceReport } from '../lib/score-performance.js';
import { qualityReceiptFromAudit } from '../lib/performance-evidence-v1.js';
import { createSessionToken } from '../lib/security.js';

const ready = Object.fromEntries([
  'columns_ready', 'league_index_ready', 'status_index_ready',
  'active_unique_ready', 'quarantine_ready', 'old_unique_removed',
].map(key => [key, true]));
assert.equal(cloudBetSchemaIsCurrent(ready), true);
for (const key of Object.keys(ready)) {
  assert.equal(cloudBetSchemaIsCurrent({ ...ready, [key]: false }), false, `${key} must fail closed`);
  assert.equal(cloudBetSchemaIsCurrent({ ...ready, [key]: 'true' }), false, `${key} must be a real DB boolean`);
}
assert.equal(cloudBetSchemaIsCurrent(null), false);
const renderSql = (strings, values) => strings.reduce((value, part, index) => `${value}${part}${index < values.length ? '?' : ''}`, '');
let catalogSql;
assert.deepEqual(await readCloudBetSchemaState(async (strings, ...values) => {
  catalogSql = renderSql(strings, values); return [ready];
}), ready);
assert.doesNotMatch(catalogSql, /\b(?:CREATE|INSERT|UPDATE|DELETE|DROP|LOCK)\b/i);
assert.match(catalogSql, /idx\.indisvalid AND idx\.indisready AND idx\.indisunique/);
assert.match(catalogSql, /PG_GET_EXPR\(idx\.indpred, idx\.indrelid\) = '\(status <> ''CANCELLED''::text\)'/);
assert.match(catalogSql, /PG_GET_INDEXDEF\(idx\.indexrelid, 1, TRUE\) = 'position_key'/);
assert.match(catalogSql, /PG_INDEX_COLUMN_HAS_PROPERTY\(idx\.indexrelid, 2, 'desc'\) IS TRUE/);
assert.match(catalogSql, /uq_baseball_private_bets_v2_position_key_v110.*IS NULL/);

// Exercise the actual private bootstrap without touching any real database.
const storeSource = fs.readFileSync(new URL('../lib/cloud-bet-store.js', import.meta.url), 'utf8');
const bootstrapSource = storeSource.slice(storeSource.indexOf('async function ensureSchema()'), storeSource.indexOf('\nfunction cleanText('));
const bootstrap = database => new Function('sql', 'cloudBetSchemaIsCurrent', 'readCloudBetSchemaState', 'markDatabaseError',
  `let schemaReady; ${bootstrapSource}; return ensureSchema;`)(() => database, cloudBetSchemaIsCurrent, readCloudBetSchemaState, markDatabaseError);
const migratedCalls = [];
const migratedDb = async (strings, ...values) => { migratedCalls.push(renderSql(strings, values)); return [ready]; };
const migratedEnsure = bootstrap(migratedDb);
await Promise.all([migratedEnsure(), migratedEnsure(), migratedEnsure()]);
assert.equal(migratedCalls.length, 1, 'concurrent cold reads share one durable schema check');
assert.doesNotMatch(migratedCalls.join('\n'), /\b(?:CREATE|INSERT|UPDATE|DELETE|DROP|LOCK)\b/i,
  'fully migrated databases must not run DDL or scan/migrate the legacy table on hot reads');

let migrationFinished = false;
const oldCalls = [];
const oldDb = async (strings, ...values) => {
  const text = renderSql(strings, values); oldCalls.push(text);
  if (text.includes('AS columns_ready')) return [migrationFinished ? ready : {}];
  if (text.includes('AS unique_ready')) return [{ unique_ready: true, active_unique_ready: false, quarantine_ready: true }];
  if (text.includes('AS ready')) return [{ ready: false }];
  return [];
};
oldDb.transaction = async makeStatements => { await Promise.all(makeStatements(oldDb)); migrationFinished = true; return []; };
await bootstrap(oldDb)();
assert.match(oldCalls.join('\n'), /CREATE TABLE IF NOT EXISTS baseball_private_bets/);
assert.match(oldCalls.join('\n'), /CREATE UNIQUE INDEX IF NOT EXISTS uq_baseball_private_bets_v2_active_position_v1172/);
assert.match(oldCalls.join('\n'), /DROP INDEX IF EXISTS uq_baseball_private_bets_v2_position_key_v110/);
assert.equal(oldCalls.filter(text => text.includes('AS columns_ready')).length, 2, 'a migrated schema must be independently verified');

const invalidDb = async (strings, ...values) => {
  const text = renderSql(strings, values);
  if (text.includes('AS unique_ready')) return [{ unique_ready: true, active_unique_ready: true, quarantine_ready: true }];
  if (text.includes('AS ready')) return [{ ready: true }];
  return [{}];
};
await assert.rejects(bootstrap(invalidDb)(), error => error.databaseOperation === true
  && error.operation === 'CLOUD_BET_SCHEMA_INVALID', 'an incorrectly defined existing index must not become a ready schema');

assert.deepEqual(normalizeCloudBetReadOptions({ compact: true }), { compact: true, date: null, league: null, limit: 250, cursor: null });
for (const value of [{ date: '2026-02-30' }, { date: 'not-a-date' }, { league: 'NFL' },
  { compact: true, limit: 501 }, { compact: true, limit: 0 }, { compact: true, limit: 1.1 }, { cursor: 'bad!' }]) {
  assert.throws(() => normalizeCloudBetReadOptions(value), error => error.status === 400);
}
const audit = { schemaVersion: 'test', coverageScope: 'CORE_PERSONNEL', rows: ['away', 'home'].flatMap(side =>
  ['starter', 'lineup', 'bullpen', 'splits', 'injuries'].map(category => ({ id: `${side}.${category}`, status: 'observed' }))) };
const bet = id => sanitizeCloudBet({ id, league: 'MLB', date: '2026-09-30', gamePk: 100,
  market: '上半大小', pick: '大4平', water: .95, stake: 100, placedAt: '2026-09-30T08:00:00.000Z',
  status: 'SETTLED', readerEvidenceStatus: 'SERVER_VERIFIED_CAPTURED_READER',
  pitEvidenceVerified: true, pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED',
  scoreStatus: 'SHADOW_DIAGNOSTIC_NOT_FORMAL', formulaDiagnosticScore: 8.1,
  modelVersion: 'M1', dataVersion: 'D1', dataQualityReceipt: qualityReceiptFromAudit(audit),
  resultSnapshot: { selectedPeriod: 'FIRST5', first5Complete: true, awayFirst5: 3, homeFirst5: 2 },
  settlement: { outcome: 'WIN', winFraction: 1, lossFraction: 0, grossWin: 95, grossLoss: 0, rebate: 1.5, netProfit: 96.5 },
  pitPrediction: { expensive: 'excluded' }, featureObservedAts: { large: 'excluded' } });
const fixtures = [bet('a'), bet('b')];
const compactFixtures = fixtures.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => CLOUD_BET_COMPACT_FIELDS.includes(key))));
assert.deepEqual(summarizeBetLedger(compactFixtures), summarizeBetLedger(fixtures), 'compact rows preserve complete settled/open/quarantine statistics');
assert.deepEqual(buildScorePerformanceReport(compactFixtures), buildScorePerformanceReport(fixtures), 'compact rows preserve score/version/quality attribution');
assert.equal(Object.hasOwn(compactFixtures[0], 'pitPrediction'), false);
assert.equal(Object.hasOwn(compactFixtures[0], 'featureObservedAts'), false);

let pageSql, pageValues;
const options = { compact: true, date: '2026-09-30', league: 'MLB', limit: 2 };
const page = await listCloudBetsReadPage(options, { database: async (strings, ...values) => {
  pageSql = renderSql(strings, values); pageValues = values;
  return [
    { total_records: '5002', id: 'a', cursor_placed_at: '2026-09-30T08:00:00.000123Z', payload: compactFixtures[0] },
    { total_records: '5002', id: 'b', cursor_placed_at: '2026-09-30T08:00:00.000122Z', payload: compactFixtures[1] },
    { total_records: '5002', id: 'c', cursor_placed_at: '2026-09-30T08:00:00.000121Z', payload: bet('c') },
  ];
} });
assert.deepEqual(page.bets.map(row => row.id), ['a', 'b']);
assert.equal(page.pagination.totalRecords, 5002, 'count includes all records beyond any historical 5,000-row cap');
assert.equal(page.pagination.hasMore, true);
assert.equal(page.pagination.invalidRecordsOnPage, 0);
assert.equal(normalizeCloudBetReadOptions({ ...options, cursor: page.pagination.nextCursor }).cursor.placedAt,
  '2026-09-30T08:00:00.000122Z', 'cursor preserves microseconds and stable tie ordering');
assert.throws(() => normalizeCloudBetReadOptions({ ...options, league: 'KBO', cursor: page.pagination.nextCursor }),
  error => error.code === 'BET_READ_CURSOR_INVALID', 'cursor cannot silently switch filter scopes');
assert.match(pageSql, /COUNT\(\*\)::text AS total_records/);
assert.match(pageSql, /\(placed_at, id\) < \(\?::timestamptz, \?::text\)/);
assert.match(pageSql, /ORDER BY placed_at DESC, id DESC[\s\S]*LIMIT \?/);
assert.match(pageSql, /FROM total LEFT JOIN selected ON TRUE/);
assert.ok(pageValues.includes(3), 'limit+1 determines whether more records exist without another payload page');
assert.doesNotMatch(pageSql, /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|LOCK|OFFSET)\b/i);
const empty = await listCloudBetsReadPage({ compact: true }, { database: async () => [{ total_records: '0', id: null, payload: null }] });
assert.deepEqual(empty.bets, []);
assert.equal(empty.pagination.totalRecords, 0);
assert.equal(empty.pagination.nextCursor, null);
const invalid = await listCloudBetsReadPage({ compact: true, limit: 1 }, { database: async () => [
  { total_records: '2', id: 'invalid', cursor_placed_at: '2026-09-30T08:00:00.000123Z', payload: {} },
  { total_records: '2', id: 'a', cursor_placed_at: '2026-09-30T08:00:00.000122Z', payload: fixtures[0] },
] });
assert.equal(invalid.pagination.invalidRecordsOnPage, 1);
assert.equal(invalid.pagination.hasMore, true);
assert.ok(invalid.pagination.nextCursor, 'even a fully invalid page must advance the cursor safely');
const untrusted = await listCloudBetsReadPage({ compact: true }, { database: async () => [
  { total_records: '1', id: 'untrusted', payload: { ...fixtures[0], id: 'untrusted', pitEvidenceVerified: false } },
] });
assert.equal(untrusted.bets[0].status, 'MANUAL_REVIEW');
assert.equal(untrusted.bets[0].settlement, null);
assert.equal(untrusted.bets[0].performanceEligibility, 'EXCLUDED_UNVERIFIABLE_LEGACY');
await assert.rejects(() => listCloudBetsReadPage({ compact: true }, { database: async () => [] }),
  error => error.databaseOperation === true && error.operation === 'CLOUD_BET_PAGE_OUTCOME_MISSING');

const routeSource = fs.readFileSync(new URL('../app/api/bets/route.js', import.meta.url), 'utf8');
const deadlineSource = routeSource.slice(routeSource.indexOf('async function withBetLedgerReadDeadline('), routeSource.indexOf('\nconst readTimingHeaders'));
const deadline = new Function(`${deadlineSource}; return withBetLedgerReadDeadline;`)();
assert.equal(await deadline(async () => 'read', 50), 'read');
await assert.rejects(() => deadline(() => new Promise(() => {}), 5), error => error.code === 'BET_LEDGER_READ_TIMEOUT');
await assert.rejects(() => deadline(async () => { throw new Error('upstream'); }, 50), /upstream/);
assert.match(routeSource, /BET_LEDGER_READ_TIMEOUT_MS = 12_000/);
assert.match(routeSource, /Server-Timing/);
assert.match(routeSource, /stats: null, calibration: null/);

// Real GET/auth/JSON behavior, with read-only fixture I/O. Compact responses
// must not accidentally run the expensive calibration/statistics functions.
const routeUrl = new URL('../app/api/bets/route.js', import.meta.url).href;
let statsCalls = 0, calibrationCalls = 0, pageCalls = 0;
globalThis.__cloudLedgerReadFixture = {
  cloudBetStats: () => { statsCalls += 1; return { full: true }; },
  buildCalibrationStatusFromBetsV109: () => { calibrationCalls += 1; return { full: true }; },
  listCloudBetsReadPage: async options => {
    pageCalls += 1;
    normalizeCloudBetReadOptions(options);
    return { ...page, view: options.compact ? 'compact' : 'full' };
  },
  listCloudBetsByIds: async () => [], cancelOpenCloudBet: async () => [], mergeCloudBets: async () => [],
  recoverPersistedCloudBet: async () => null, settleOpenCloudBets: async () => [], upsertCloudBet: async () => [],
};
register('data:text/javascript,' + encodeURIComponent(`
  const routeUrl = ${JSON.stringify(routeUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (context.parentURL === routeUrl && (specifier.endsWith('/lib/cloud-bet-store.js') || specifier.endsWith('/lib/calibration-ledger-v109.js'))) {
      return { url: 'test-cloud-ledger-read:' + (specifier.includes('cloud-bet-store') ? 'store' : 'calibration'), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
  export async function load(url, context, nextLoad) {
    if (!url.startsWith('test-cloud-ledger-read:')) return nextLoad(url, context);
    const names = url.endsWith(':store')
      ? ['cancelOpenCloudBet', 'cloudBetStats', 'listCloudBetsReadPage', 'listCloudBetsByIds', 'mergeCloudBets', 'recoverPersistedCloudBet', 'settleOpenCloudBets', 'upsertCloudBet']
      : ['buildCalibrationStatusFromBetsV109'];
    return { format: 'module', shortCircuit: true, source: names.map(name =>
      'export const ' + name + ' = (...args) => globalThis.__cloudLedgerReadFixture.' + name + '(...args);').join('\\n') };
  }
`), import.meta.url);
const priorPassword = process.env.APP_PASSWORD, priorSecret = process.env.SESSION_SECRET;
try {
  process.env.APP_PASSWORD = 'test-read-only';
  process.env.SESSION_SECRET = 'test-read-secret-abcdefghijklmnopqrstuvwxyz';
  const token = await createSessionToken();
  const { GET } = await import(routeUrl);
  const request = (query = '', authenticated = true) => new Request(`https://ledger-read.test/api/bets${query}`, {
    headers: authenticated ? { Cookie: `mlb_session=${encodeURIComponent(token)}` } : {},
  });
  assert.equal((await GET(request('?view=compact', false))).status, 401);
  assert.equal(pageCalls, 0, 'unauthorized reads must not touch the ledger');
  const compactResponse = await GET(request('?view=compact&limit=500'));
  assert.equal(compactResponse.status, 200);
  assert.match(compactResponse.headers.get('Server-Timing'), /^ledger;dur=\d+\.\d$/);
  assert.equal(compactResponse.headers.get('Cache-Control'), 'no-store');
  const compactBody = await compactResponse.json();
  assert.equal(compactBody.stats, null);
  assert.equal(compactBody.calibration, null);
  assert.equal(compactBody.statsScope, 'NOT_COMPUTED_COMPACT_READ');
  assert.equal(compactBody.pagination.totalRecords, 5002);
  assert.equal(statsCalls, 0);
  assert.equal(calibrationCalls, 0);
  const fullBody = await (await GET(request())).json();
  assert.equal(fullBody.statsScope, 'RETURNED_RECORDS_ONLY');
  assert.equal(statsCalls, 1);
  assert.equal(calibrationCalls, 1);
  assert.equal((await GET(request('?view=invalid'))).status, 400);
  assert.equal((await GET(request('?view=compact&date=2026-02-30'))).status, 400);
  globalThis.__cloudLedgerReadFixture.listCloudBetsReadPage = async () => {
    throw Object.assign(new Error('test deadline'), { code: 'BET_LEDGER_READ_TIMEOUT', databaseOperation: true });
  };
  const failure = await GET(request('?view=compact'));
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get('Retry-After'), '5');
  assert.match(failure.headers.get('Server-Timing'), /^ledger;dur=/);
  assert.equal((await failure.json()).code, 'BET_LEDGER_READ_TIMEOUT');
} finally {
  delete globalThis.__cloudLedgerReadFixture;
  if (priorPassword == null) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = priorPassword;
  if (priorSecret == null) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = priorSecret;
}
console.log('Cloud ledger catalog fast path, accurate compact keyset paging, fail-closed rows, statistics equivalence and read deadline PASS');
