import assert from 'node:assert/strict';
import { assessCoreSnapshotFreshnessV109, coreRefreshTtlMsV109 } from '../lib/analysis-refresh-policy-v109.js';

const now = Date.parse('2026-08-23T10:00:00.000Z');
const context = ({ startMinutes = 120, ageMinutes = 5, official = true } = {}) => ({
  fetchedAt: new Date(now - ageMinutes * 60_000).toISOString(),
  game: { gameDate: new Date(now + startMinutes * 60_000).toISOString() },
  away: { lineup: { official }, bullpen: { status: 'CONFIRMED' } },
  home: { lineup: { official }, bullpen: { status: 'CONFIRMED' } },
  umpire: { status: 'CONFIRMED' },
  weather: { roofConfirmed: true },
});

assert.equal(coreRefreshTtlMsV109(context(), now), 10 * 60_000);
assert.equal(assessCoreSnapshotFreshnessV109(context(), now).fresh, true);
assert.equal(assessCoreSnapshotFreshnessV109(context({ ageMinutes: 11 }), now).fresh, false);
assert.match(assessCoreSnapshotFreshnessV109(context({ ageMinutes: 11 }), now).reasons.join('|'), /TTL_EXPIRED/);
assert.equal(coreRefreshTtlMsV109(context({ startMinutes: 15 }), now), 2 * 60_000);
assert.equal(coreRefreshTtlMsV109(context({ startMinutes: 15, official: false }), now), 60_000);
assert.match(assessCoreSnapshotFreshnessV109(context({ startMinutes: 45, official: false }), now).advisories.join('|'), /LINEUP_RECHECK/);

console.log('Event-aware core refresh policy v10.9 PASS');
