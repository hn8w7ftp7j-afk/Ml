import assert from 'node:assert/strict';
import fs from 'node:fs';

const store = fs.readFileSync(new URL('../lib/cloud-bet-store.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../database/0006_cloud_bet_position_uniqueness.sql', import.meta.url), 'utf8');

assert.match(store, /database\.transaction\(transaction => \[/, 'ensureSchema uniqueness migration must be transactional');
const transactionStart = store.indexOf('database.transaction(transaction => [');
const lockIndex = store.indexOf('LOCK TABLE baseball_private_bets_v2 IN SHARE ROW EXCLUSIVE MODE', transactionStart);
const quarantineIndex = store.indexOf('baseball_private_bets_v2_position_quarantine', lockIndex);
const rankIndex = store.indexOf('ORDER BY placed_at ASC, updated_at ASC, id ASC', quarantineIndex);
const uniqueIndex = store.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_baseball_private_bets_v2_position_key_v110', rankIndex);
assert.ok(
  transactionStart >= 0
    && lockIndex > transactionStart
    && quarantineIndex > lockIndex
    && rankIndex > quarantineIndex
    && uniqueIndex > rankIndex,
  'lock, exact-row quarantine, deterministic survivor selection and unique-index creation must stay in one ordered transaction',
);
assert.match(store, /TO_JSONB\(ranked\) - 'duplicate_rank' - 'canonical_bet_id'/, 'quarantine must retain the original row');
assert.match(store, /EXCLUDED_DUPLICATE_POSITION_QUARANTINE/, 'duplicate history must fail closed for calibration');
assert.match(store, /ON CONFLICT \(position_key\) WHERE status <> 'CANCELLED' DO NOTHING/, 'new tickets must atomically suppress an active duplicate while permitting rebet after cancellation');
assert.match(store, /ON CONFLICT DO NOTHING/, 'legacy merges must atomically respect both id and position uniqueness');
assert.doesNotMatch(
  store,
  /SELECT id FROM baseball_private_bets_v2 WHERE (?:id = [^\n]+ OR )?position_key =/,
  'TOCTOU select-then-insert duplicate checks are forbidden',
);

assert.match(migration, /^\s*--[\s\S]*?begin;/i);
assert.match(migration, /lock table baseball_private_bets_v2 in share row exclusive mode/i);
assert.match(migration, /create table if not exists baseball_private_bets_v2_position_quarantine/i);
assert.match(migration, /row_number\(\) over[\s\S]*order by placed_at asc, updated_at asc, id asc/i);
assert.match(migration, /duplicate-quarantine-v110/i);
assert.match(migration, /create unique index if not exists uq_baseball_private_bets_v2_position_key_v110/i);
assert.match(migration, /commit;/i);
assert.doesNotMatch(migration, /\b(?:delete|truncate|drop)\b/i, 'migration must never discard ledger material');

console.log('Atomic cloud-bet position uniqueness, deterministic duplicate quarantine and no-data-loss migration PASS');
