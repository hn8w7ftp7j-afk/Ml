import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildMlbAdvancedSnapshotRecord,
  persistMlbAdvancedSnapshot,
} from '../lib/mlb-advanced-snapshot-store-v2.js';

const game = { gamePk: 778899, gameDate: '2026-08-24T02:00:00.000Z' };
const context = {
  fetchedAt: '2026-08-23T08:00:00.000Z',
  away: { advanced: { fielding: { status: 'PROJECTED', validationStatus: 'PENDING' } } },
  home: { advanced: { catcherFraming: { status: 'MISSING' } } },
  advancedEnvironment: { directionalWind: { status: 'MISSING' } },
  sourceStatuses: { defenseFRV: 'PROJECTED', lineups: 'CONFIRMED' },
  featureProvenance: [{ featureName: 'advancedSavantSnapshot', sourceProvider: 'BASEBALL_SAVANT_ADVANCED_CSV' }],
};
const record = buildMlbAdvancedSnapshotRecord(game, context);
assert.equal(record.gamePk, game.gamePk);
assert.equal(record.featurePayload.sourceStatuses.defenseFRV, 'PROJECTED');
assert.equal(record.featurePayload.sourceStatuses.lineups, undefined);
assert.match(record.sourcePayloadHash, /^[a-f0-9]{64}$/);
assert.match(record.snapshotId, /^778899:2026-08-23T08:00:00\.000Z:/);
assert.throws(() => buildMlbAdvancedSnapshotRecord(game, { ...context, fetchedAt: game.gameDate }), /不是賽前/);

const previous = process.env.DATABASE_URL;
const previousV2 = process.env.DATABASE_V2_URL;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_V2_URL;
assert.deepEqual(await persistMlbAdvancedSnapshot(game, context), { stored: false, reason: 'DATABASE_NOT_CONFIGURED' });
if (previous) process.env.DATABASE_URL = previous;
if (previousV2 == null) delete process.env.DATABASE_V2_URL;
else process.env.DATABASE_V2_URL = previousV2;

const migration = fs.readFileSync(new URL('../database/0004_mlb_advanced_feature_snapshots.sql', import.meta.url), 'utf8');
assert.match(migration, /check \(observed_at < game_start\)/i);
assert.match(migration, /before update or delete/i);
console.log('Immutable MLB advanced PIT snapshot storage PASS');
