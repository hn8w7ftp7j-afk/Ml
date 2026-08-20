import assert from 'node:assert/strict';
import {
  FEATURE_STATUS,
  MLB_INNINGS_NORMALIZATION_VERSION,
  normalizePitchingBlockV10,
  parseBaseballInnings,
  parseInjuredListPayloadV10,
  parseLeagueBaselineV10,
  parseOfficialParkFactorV10,
  parseVenuePayloadV10,
} from '../lib/mlb-data-v10.js';

assert.equal(parseBaseballInnings('94.0'), 94);
assert.equal(parseBaseballInnings('94.1'), 94 + 1 / 3);
assert.equal(parseBaseballInnings('94.2'), 94 + 2 / 3);
assert.equal(parseBaseballInnings(5.1), 5 + 1 / 3);
assert.equal(parseBaseballInnings('0.2'), 2 / 3);
assert.equal(parseBaseballInnings('bad'), 0);

const teamSplits = Array.from({ length: 30 }, (_, index) => ({
  team: { id: index + 1 },
  stat: {
    gamesPlayed: index < 18 ? 123 : 122,
    runs: 540 + (index % 5),
  },
}));
const pitchingSplits = Array.from({ length: 30 }, (_, index) => ({
  team: { id: index + 1 },
  stat: {
    inningsPitched: '1100.1',
    earnedRuns: 520,
    hits: 1050,
    baseOnBalls: 380,
    strikeOuts: 1050,
    homeRuns: 140,
  },
}));
const baseline = parseLeagueBaselineV10(
  { stats: [{ splits: teamSplits }] },
  { stats: [{ splits: pitchingSplits }] },
  { season: 2026, asOf: '2026-08-19' },
);
assert.equal(baseline.available, true);
assert.equal(baseline.status, FEATURE_STATUS.CONFIRMED);
assert.equal(baseline.teamCount, 30);
assert.equal(baseline.totalTeamGames, 3678);
assert.ok(baseline.runsPerTeamGame > 4 && baseline.runsPerTeamGame < 5);
assert.ok(Number.isFinite(baseline.era));

const venue = parseVenuePayloadV10({ venues: [{
  id: 19,
  name: 'Coors Field',
  location: { defaultCoordinates: { latitude: 39.7559, longitude: -104.9942 }, city: 'Denver' },
  fieldInfo: { roofType: 'Open' },
  timeZone: { id: 'America/Denver' },
}] }, 19);
assert.equal(venue.available, true);
assert.equal(venue.id, 19);
assert.equal(venue.name, 'Coors Field');
assert.equal(venue.roof, 'open');
assert.equal(venue.status, FEATURE_STATUS.CONFIRMED);

const injuryMissing = parseInjuredListPayloadV10(null);
assert.equal(injuryMissing.available, false);
assert.equal(injuryMissing.status, FEATURE_STATUS.MISSING);
const injuryConfirmedEmpty = parseInjuredListPayloadV10({ roster: [] });
assert.equal(injuryConfirmedEmpty.available, true);
assert.equal(injuryConfirmedEmpty.status, FEATURE_STATUS.CONFIRMED);
const injuryRows = parseInjuredListPayloadV10({ roster: [{
  person: { id: 1, fullName: 'Pitcher A' },
  position: { abbreviation: 'SP' },
  status: { description: '15-Day IL' },
}] });
assert.equal(injuryRows.rows.length, 1);
assert.equal(injuryRows.rows[0].position, 'SP');

const scheduleGames = [];
for (let index = 0; index < 25; index += 1) {
  scheduleGames.push({
    status: { abstractGameState: 'Final' },
    venue: { id: 19 },
    teams: {
      home: { team: { id: 115 }, score: 6 },
      away: { team: { id: 100 + index }, score: 5 },
    },
  });
  scheduleGames.push({
    status: { abstractGameState: 'Final' },
    venue: { id: 1000 + index },
    teams: {
      home: { team: { id: 100 + index }, score: 4 },
      away: { team: { id: 115 }, score: 4 },
    },
  });
}
const park = parseOfficialParkFactorV10({ dates: [{ games: scheduleGames }] }, { homeTeamId: 115, venueId: 19 });
assert.equal(park.available, true);
assert.equal(park.status, FEATURE_STATUS.PROJECTED);
assert.equal(park.homeGames, 25);
assert.equal(park.roadGames, 25);
assert.ok(park.runFactor > 1 && park.runFactor < 1.15);

const normalized = normalizePitchingBlockV10({
  inningsPitched: '94.1',
  strikeOuts: 100,
  baseOnBalls: 30,
  homeRuns: 12,
  era: 3.8,
  fip: 3.8,
}, { era: 4.2, kPer9: 8.5, bbPer9: 3.2, hrPer9: 1.15 });
assert.equal(normalized.inningsNormalizationVersion, MLB_INNINGS_NORMALIZATION_VERSION);
assert.equal(normalized.inningsPitched, 94 + 1 / 3);
assert.equal(normalized.fipAvailable, false);
assert.equal(normalized.fipStatus, FEATURE_STATUS.PROJECTED);
assert.notEqual(normalized.fipSource, 'ERA_COPY');
assert.ok(Number.isFinite(normalized.kPer9));

console.log(JSON.stringify({
  ok: true,
  innings: normalized.inningsPitched,
  leagueRunsPerTeamGame: baseline.runsPerTeamGame,
  parkFactor: park.runFactor,
  venue: venue.name,
}, null, 2));
