import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { withFeatureSourceTime } from '../lib/feature-source-time.js';
import { selectPitReplayEngine } from '../lib/pit-replay-engines.js';
import { validateProductionPitSnapshotV109 } from '../lib/mlb-production-pit-replay-v109.js';
const row = { featureName: 'test', asOf: '2020-01-01', status: 'MISSING', value: null };
assert.equal(withFeatureSourceTime(row).fetchedAt, null);
assert.equal(withFeatureSourceTime(row, [{ fetchedAt: '2020-01-01' }]).fetchedAt, null);
const receipts = [{ fetchedAt: '2026-01-01T00:00:00Z' }, { fetchedAt: '2026-01-01T01:00:00Z' }];
assert.equal(withFeatureSourceTime(row, receipts).fetchedAt, receipts[1].fetchedAt);
assert.equal(withFeatureSourceTime(row, receipts).status, 'MISSING');
assert.equal(withFeatureSourceTime(row, [...receipts, {}]).fetchedAt, null);
const invalid = validateProductionPitSnapshotV109({ snapshotAsOf: '2026-01-01T02:00:00Z', context: {
  featureProvenance: [{ featureName: 'test', fetchedAt: receipts[0].fetchedAt, sourceProvider: 'test',
    sourceReceipts: [{ fetchedAt: '2026-01-02T00:00:00Z' }] }],
} });
assert.ok(invalid.errors.includes('FEATURE_FROM_FUTURE:test'));
const root = new URL('../lib/archives/mlb-v1100/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root)));
for (const [path, hash] of Object.entries(manifest.files)) {
  assert.equal(createHash('sha256').update(fs.readFileSync(new URL(path, root))).digest('hex'), hash, path);
}
const original = selectPitReplayEngine('BASEBALL-STATE-AWARE-LINKED-SCORE-DISTRIBUTION-2026-08-v11.0.0');
assert.equal(original.revision, manifest.revision);
assert.equal(original.archived, true);
assert.equal(selectPitReplayEngine('unknown'), null);
console.log('Source times: no backfill, cached receipt preservation, future dependency rejection; pinned original engine content hashes verified');
