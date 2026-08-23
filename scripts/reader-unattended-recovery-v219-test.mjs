import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  BOARD_ACTIVITY_TTL_MS,
  RECOVERY_COOLDOWN_MS,
  RELOAD_SETTLE_MS,
  reserveRecoveryTabIds,
  staleAssessedTabIds,
  uniqueTabIds,
} from '../reader/recovery-policy.js';

assert.equal(BOARD_ACTIVITY_TTL_MS, 180_000, 'Reader and server must use the same 3-minute activity limit');
assert.equal(RECOVERY_COOLDOWN_MS, 90_000);
assert.equal(RELOAD_SETTLE_MS, 7_000);
assert.deepEqual(uniqueTabIds([4, 4, '4', -1, null, 9]), [4, 9]);

const assessed = [
  { candidate: { tabId: 11 }, issues: ['stale-market-activity'] },
  { candidate: { tabId: 12 }, issues: ['parser:missing-market'] },
  { candidate: { tabId: 11 }, issues: ['stale-market-activity', 'stale-observation'] },
];
assert.deepEqual(staleAssessedTabIds(assessed), [11], 'only the stale league tab may be refreshed');

const cooldowns = new Map();
assert.deepEqual(reserveRecoveryTabIds([11, 12], cooldowns, { now: 100_000 }), [11, 12]);
assert.deepEqual(reserveRecoveryTabIds([11, 12], cooldowns, { now: 150_000 }), [], '90-second cooldown must prevent a refresh loop');
assert.deepEqual(reserveRecoveryTabIds([11, 12], cooldowns, { now: 190_000 }), [11, 12]);
assert.deepEqual(reserveRecoveryTabIds([11], cooldowns, { now: 190_001, force: true }), [11], 'manual recovery may bypass cooldown');

const background = fs.readFileSync(new URL('../reader/background.js', import.meta.url), 'utf8');
const serverParser = fs.readFileSync(new URL('../lib/tai888-reader-parser-v2.js', import.meta.url), 'utf8');
const ingest = fs.readFileSync(new URL('../app/api/reader/ingest/route.js', import.meta.url), 'utf8');
assert.match(background, /softRecoverTabs/);
assert.match(background, /reloadTabs\(remaining\)/);
assert.match(background, /chrome\.tabs\.reload\(tabId/);
assert.match(background, /pendingReason = 'stale-reload'/);
assert.match(background, /state: 'reconnecting'/);
assert.match(serverParser, /PAGE_ACTIVITY_STALE/);
assert.match(ingest, /code: String\(error\?\.code \|\| ''\)/);

console.log('Reader 2.1.19 unattended stale/silent recovery and anti-refresh-loop PASS');
