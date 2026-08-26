import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CLOUD_LEDGER_FAILURE_BACKOFF_MS,
  CLOUD_LEDGER_MAX_BACKOFF_MS,
  CLOUD_LEDGER_VISIBLE_REFRESH_MS,
  cloudLedgerAutomaticRefreshAllowed,
  cloudLedgerRetryDelay,
} from '../lib/cloud-ledger-sync-policy.js';
import { listCloudBets, listCloudBetsByIds } from '../lib/cloud-bet-store.js';
import { classifyDatabaseError, databaseFailureLog, isDatabaseError, markDatabaseError } from '../lib/database-error.js';

const quota = classifyDatabaseError(new Error('Server error (HTTP status 402): Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.'));
assert.equal(quota.code, 'DATABASE_TRANSFER_QUOTA_EXCEEDED');
assert.equal(quota.status, 503);
assert.equal(quota.retryAfterSeconds, 6 * 60 * 60);
assert.doesNotMatch(quota.publicMessage, /Server error|HTTP status/i);
assert.equal(isDatabaseError(new Error('Server error (HTTP status 402): data transfer quota exceeded')), true);
assert.equal(isDatabaseError(new Error('下注紀錄格式不正確')), false);
const timedOutFetch = new TypeError('fetch failed', { cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }) });
assert.equal(isDatabaseError(timedOutFetch), false, 'unscoped provider fetch failures must not be mislabeled as database failures');
const markedTimeout = markDatabaseError(timedOutFetch, 'TEST_NEON_READ');
assert.equal(isDatabaseError(markedTimeout), true, 'database-boundary network failures must be treated as database failures');
assert.equal(classifyDatabaseError(markedTimeout).code, 'DATABASE_UNAVAILABLE');

const missing = classifyDatabaseError(new Error('DATABASE_URL is not configured'));
assert.equal(missing.code, 'DATABASE_NOT_CONFIGURED');

const schema = classifyDatabaseError(new Error('relation "baseball_private_bets_v2" does not exist'));
assert.equal(schema.code, 'DATABASE_SCHEMA_UNAVAILABLE');

const redacted = databaseFailureLog(new Error('connect postgres://user:pass@example.invalid/db password=hunter2 token=abc'));
assert.doesNotMatch(JSON.stringify(redacted), /pass@example|hunter2|token=abc/);
assert.match(redacted.diagnostic, /REDACTED/);

assert.equal(CLOUD_LEDGER_VISIBLE_REFRESH_MS, 10 * 60 * 1000);
assert.equal(CLOUD_LEDGER_FAILURE_BACKOFF_MS, 5 * 60 * 1000);
assert.equal(CLOUD_LEDGER_MAX_BACKOFF_MS, 24 * 60 * 60 * 1000);
assert.equal(cloudLedgerRetryDelay({ retryAfterMs: 6 * 60 * 60 * 1000 }), 6 * 60 * 60 * 1000);
assert.equal(cloudLedgerAutomaticRefreshAllowed({ storageReady: true, tab: 'bets', visibilityState: 'visible', now: 100, retryAt: 99 }), true);
assert.equal(cloudLedgerAutomaticRefreshAllowed({ storageReady: true, tab: 'bets', visibilityState: 'hidden', now: 100, retryAt: 0 }), false);
assert.equal(cloudLedgerAutomaticRefreshAllowed({ storageReady: true, tab: 'board', visibilityState: 'visible', now: 100, retryAt: 0 }), false);
assert.equal(cloudLedgerAutomaticRefreshAllowed({ storageReady: true, tab: 'bets', visibilityState: 'visible', now: 100, retryAt: 101 }), false);
assert.equal(cloudLedgerAutomaticRefreshAllowed({ storageReady: true, tab: 'bets', visibilityState: 'visible', busy: true, now: 100, retryAt: 0 }), false);

const originalDatabaseUrl = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;
await assert.rejects(() => listCloudBets(), /DATABASE_URL/, 'missing durable database must never return an empty Runtime Cache ledger');
await assert.rejects(() => listCloudBetsByIds(['bet-1']), /DATABASE_URL/, 'targeted price lookups must use the same durable fail-closed database');
if (originalDatabaseUrl == null) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = originalDatabaseUrl;

const route = fs.readFileSync(new URL('../app/api/bets/route.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const store = fs.readFileSync(new URL('../lib/cloud-bet-store.js', import.meta.url), 'utf8');

assert.match(route, /DATABASE_TRANSFER_QUOTA_EXCEEDED|classifyDatabaseError/);
assert.match(route, /Retry-After/);
assert.match(route, /BET_LEDGER_READ_FAILED/);
assert.doesNotMatch(route, /catch\s*\{\s*return NextResponse\.json\(\{ ok: false, error: '雲端下注紀錄讀取失敗'/);

assert.match(page, /cloudLedgerAutomaticRefreshAllowed/);
assert.match(page, /visibilityState: document\.visibilityState/);
assert.match(page, /cloudLedgerRetryDelay\(cause\)/);
assert.match(page, /BET_PRICE_REFRESH_INTERVAL_MS = 5 \* 60 \* 1000/);
assert.match(page, /不代表資料庫內沒有紀錄/);
assert.doesNotMatch(page, /window\.setInterval\(syncCloudBets, 15000\)/);
assert.doesNotMatch(store, /readCachedBets|runtimeCache|LEGACY_CACHE_KEY|CACHE_KEY/);
assert.match(store, /export async function listCloudBetsByIds/);
assert.match(store, /WHERE id = ANY\(\$\{ids\}::text\[\]\)/, 'price comparison must query only requested ledger rows');

const migrationCheck = store.indexOf("TO_REGCLASS('public.uq_baseball_private_bets_v2_position_key_v110')");
const migrationTransaction = store.indexOf('await database.transaction', migrationCheck);
assert.ok(migrationCheck >= 0 && migrationTransaction > migrationCheck, 'expensive duplicate scan must be guarded by the migration-state probe');
assert.match(store.slice(migrationCheck, migrationTransaction), /unique_ready !== true|unique_ready/);

console.log('Database quota classification, safe observability, visible-tab backoff and guarded schema migration PASS');
