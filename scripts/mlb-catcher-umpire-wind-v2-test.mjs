import assert from 'node:assert/strict';
import { buildCatcherUmpireZoneV2 } from '../lib/mlb-catcher-umpire-zone-v2.js';
import { buildParkWindOrientationV2 } from '../lib/mlb-park-wind-orientation-v2.js';

const zone = buildCatcherUmpireZoneV2({
  gameStart: '2026-08-24T00:00:00Z', observedAt: '2026-08-23T00:00:00Z',
  catcherFraming: { catcherId: 1, pitches: 2000, framingRuns: 10, regressedValue: { framingRuns: 6 } },
  umpire: { id: 2, status: 'CONFIRMED', takenPitches: 2500, catcherNeutralRunsPerGame: 0.08 },
});
assert.equal(zone.status, 'CONFIRMED');
assert.equal(zone.rawValue.absChallengeEra, true);
assert.equal(zone.appliedValue.runsPerGame, 0);
assert.match(zone.overlapRule, /CATCHER_NEUTRAL/);

const wind = buildParkWindOrientationV2({ venueId: 1, gameStart: '2026-08-24T00:00:00Z', observedAt: '2026-08-23T00:00:00Z', weather: { windDirection: 220, windSpeed: 12, temperature: 82 } });
assert.equal(wind.status, 'PROJECTED');
assert.equal(wind.appliedValue.runDelta, 0);
assert.equal(wind.validatedRunsPerMphAlignment, null);
console.log('Joint catcher/umpire ABS and park wind inputs PASS');

