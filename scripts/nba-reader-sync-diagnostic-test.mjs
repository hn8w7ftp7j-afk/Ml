import assert from 'node:assert/strict';
import { nbaReaderSyncFailure } from '../lib/nba/reader-sync-diagnostic.js';
const observedAt = '2026-10-28T20:43:44.653Z', now = Date.parse('2026-10-28T22:30:00Z');
const report = (at, code = 'conflicting-duplicate-tabs', league = 'NBA') => ({ received_at: at,
  payload: { leagues: { [league]: { state: 'error', errorCode: code } } } });
const failure = report('2026-10-28T21:14:45.875Z');
const found = nbaReaderSyncFailure([failure], { observedAt, now });
assert.equal(found.code, 'conflicting-duplicate-tabs');
assert.match(found.message, /不同 NBA 分頁/);
assert.equal(nbaReaderSyncFailure([failure], { observedAt: '2026-10-28T21:16:00Z', now }), null, 'new quote supersedes previous failure');
for (const row of [report(observedAt), report('2026-10-27T20:00:00Z'), report('2026-10-29T00:00:00Z'), report('2026-10-28T21:14:00Z', 'unknown'), report('2026-10-28T21:14:00Z', 'conflicting-duplicate-tabs', 'EPL')])
  assert.equal(nbaReaderSyncFailure([row], { observedAt, now }), null);
assert.equal(nbaReaderSyncFailure([failure, { received_at: '2026-10-28T21:15:36Z', payload: { leagues: { NBA: { state: 'synced' } } } }], { observedAt, now }).code,
  found.code, 'a synced diagnostic does not prove a newer server quote; report remains historical');
assert.equal(nbaReaderSyncFailure(null, { observedAt, now }), null);
assert.equal(nbaReaderSyncFailure([failure], { now }), null);
console.log('NBA Reader diagnostics PASS: timestamp scope, league isolation, supersession and historical-only evidence');
