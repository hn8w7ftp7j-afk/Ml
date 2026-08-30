import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const store = fs.readFileSync(new URL('../lib/cloud-bet-store.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../database/0008_cloud_bet_rebet_after_cancel.sql', import.meta.url), 'utf8');

assert.match(
  page,
  /const activeRecords = records\.filter\(bet => bet\.status !== 'CANCELLED'\)/,
  'cancelled audit rows must not keep the board action in a permanently placed state',
);
assert.match(
  page,
  /cancelled: records\.find\(bet => bet\.status === 'CANCELLED'\) \|\| null/,
  'the UI must retain cancelled history while selecting the active ticket independently',
);
assert.match(page, /text: cancelled \? '重新紀錄下注' : '紀錄實際下注'/, 'a cancelled position must expose a clear rebet action');
assert.match(page, /state\.latest[\s\S]*此方向已經記錄/, 'only a non-cancelled ticket may suppress a new record request');

assert.match(store, /CREATE UNIQUE INDEX IF NOT EXISTS uq_baseball_private_bets_v2_active_position_v1172[\s\S]*WHERE status <> 'CANCELLED'/);
assert.match(store, /DROP INDEX IF EXISTS uq_baseball_private_bets_v2_position_key_v110/);
assert.match(
  store,
  /ON CONFLICT \(position_key\) WHERE status <> 'CANCELLED' DO NOTHING/,
  'PostgreSQL must atomically allow cancelled history plus at most one active ticket',
);
assert.match(store, /SET status = 'CANCELLED'[\s\S]*WHERE id = \$\{id\}[\s\S]*AND status = 'OPEN'/, 'rebet support must not weaken atomic cancellation');

assert.match(migration, /^\s*--[\s\S]*?begin;/i);
assert.match(migration, /lock table baseball_private_bets_v2 in share row exclusive mode/i);
assert.match(migration, /create unique index if not exists uq_baseball_private_bets_v2_active_position_v1172[\s\S]*where status <> 'CANCELLED'/i);
assert.match(migration, /drop index if exists uq_baseball_private_bets_v2_position_key_v110/i);
assert.match(migration, /commit;/i);
assert.doesNotMatch(migration, /\b(?:delete|truncate|drop table)\b/i, 'the migration must preserve every cancelled ticket and its immutable evidence');

console.log('Cancel -> rebet lifecycle, immutable history, and one-active-ticket database invariant PASS');
