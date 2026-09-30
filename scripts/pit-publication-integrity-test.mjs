import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertPitPersistenceIntegrity } from '../lib/pit-persistence-safety-v110.js';

assert.doesNotThrow(() => assertPitPersistenceIntegrity({ confirmed: false, reason: 'WRITE_FAILED' }));
assert.doesNotThrow(() => assertPitPersistenceIntegrity({ confirmed: true, reason: 'INSERTED' }));
assert.throws(() => assertPitPersistenceIntegrity({ confirmed: false, reason: 'PIT_FEATURE_TIME_INVALID' }), error => error.status === 422 && error.code === 'PIT_FEATURE_TIME_INVALID');
for (const route of ['analyze', 'reprice']) {
  const source = readFileSync(new URL(`../app/api/${route}/route.js`, import.meta.url), 'utf8');
  assert.match(source, /assertPitFeatureTimes\(/, 'route must validate feature times before publishing results');
  assert.match(source, /assertPitPersistenceIntegrity\(pitPersistence\)/, 'integrity failure must not be downgraded to a database outage');
}
console.log('PASS invalid PIT cannot be published as a successful degraded analysis');
