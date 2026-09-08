import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { captureAsianSource } from '../lib/asian-source-evidence-v1.js';

// Exercise acknowledgement/fallback behavior without a live database or provider.
const source = (await readFile(new URL('../lib/asian-source-store-v1.js', import.meta.url), 'utf8'))
  .replace("import { neon } from '@neondatabase/serverless';", 'const neon = () => globalThis.__asianStoreTestSql;')
  .replace("import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';",
    'const durableDatabaseConfigured = () => true; const durableDatabaseUrl = () => "test-only";');
const contents = new Map();
const events = new Map();
let loseReadback = false;
const sql = (parts, ...values) => ({ query: parts.join('?'), values });
sql.transaction = async queries => queries.map(({ query, values }) => {
  const rows = JSON.parse(values[0]);
  if (query.includes('INSERT INTO')) {
    const store = query.includes('asian_source_contents') ? contents : events;
    for (const row of rows) {
      const key = row.id || row.contentHash;
      if (!store.has(key)) store.set(key, structuredClone(row));
    }
    return [];
  }
  const isContent = query.includes('asian_source_contents');
  const store = isContent ? contents : events;
  return loseReadback ? [] : rows.filter(key => store.has(key)).map(key => ({
    [isContent ? 'content_hash' : 'event_id']: key, payload: store.get(key),
  }));
});
globalThis.__asianStoreTestSql = sql;
const { externalizeAsianSourceEvidence } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const capture = captureAsianSource({ url: 'https://example.invalid/test', method: 'GET', raw: '{"n":1}',
  fetchedAt: '2026-09-08T00:00:00Z', representation: 'HTTP_RESPONSE_TEXT', httpStatus: 200 });
const context = { sourceEvidence: { events: [capture.event], contents: { [capture.content.contentHash]: capture.content } } };
const original = JSON.stringify(context);
const saved = await externalizeAsianSourceEvidence(context);
assert.equal(saved.sourceEvidence.storageReadback, 'VERIFIED');
assert.deepEqual(saved.sourceEvidence.contents, {});
assert.equal(JSON.stringify(context), original);
const cached = structuredClone(context);
cached.sourceEvidence.events[0].fromCache = true;
cached.sourceEvidence.events[0].observedAt = capture.event.fetchedAt;
assert.equal((await externalizeAsianSourceEvidence(cached)).sourceEvidence.storageReadback, 'VERIFIED');
assert.equal(events.size, 1, 'cache access reuses its original acquisition');
const conflicting = structuredClone(context);
conflicting.sourceEvidence.events[0].fetchedAt = '2026-09-09T00:00:00Z';
await assert.rejects(() => externalizeAsianSourceEvidence(conflicting), /READBACK_MISMATCH/);
assert.equal(events.get(capture.event.id).fetchedAt, capture.event.fetchedAt, 'conflicting receipt cannot overwrite original');
loseReadback = true;
await assert.rejects(() => externalizeAsianSourceEvidence(context), /READBACK_MISMATCH/);
assert.equal(JSON.stringify(context), original, 'failed acknowledgement preserves inline evidence');
delete globalThis.__asianStoreTestSql;
console.log('Asian source store acknowledgement, cache identity, conflict and missing-readback behavior PASS (mock database)');
