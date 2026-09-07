import assert from 'node:assert/strict';
import { assessCoreSnapshotFreshnessV109, coreRefreshTtlMsV109 } from '../lib/analysis-refresh-policy-v109.js';
import { ALLOWED_FUTURE_SKEW_MS } from '../lib/market-freshness-v1.js';
import { coreSnapshotReusable } from '../lib/client-analysis-state.js';

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

for (const skewMs of [ALLOWED_FUTURE_SKEW_MS + 1, 24 * 60 * 60_000]) {
  const future = { ...context(), fetchedAt: new Date(now + skewMs).toISOString() };
  const assessed = assessCoreSnapshotFreshnessV109(future, now);
  assert.equal(assessed.fresh, false, 'future-dated core cannot be reused merely because Reader prices did not change');
  assert.ok(assessed.reasons.includes('CORE_FETCH_TIME_IN_FUTURE'));
  assert.equal(assessed.ageMs, -skewMs, 'diagnostic age must retain the source clock discrepancy');
  assert.equal(coreSnapshotReusable({ customData: { context: future } }, now), false);
}
const atAllowedSkew = { ...context(), fetchedAt: new Date(now + ALLOWED_FUTURE_SKEW_MS).toISOString() };
assert.equal(assessCoreSnapshotFreshnessV109(atAllowedSkew, now).fresh, true, 'the existing 90-second clock-skew allowance remains supported');
assert.equal(assessCoreSnapshotFreshnessV109(context({ ageMinutes: 10 }), now).fresh, true, 'the existing TTL boundary remains unchanged');
for (const fetchedAt of [null, undefined, '', 'not-a-date']) {
  assert.ok(assessCoreSnapshotFreshnessV109({ ...context(), fetchedAt }, now).reasons.includes('CORE_FETCH_TIME_MISSING'));
}

console.log('Event-aware core refresh policy v10.9 PASS');
