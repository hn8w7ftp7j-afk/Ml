import assert from 'node:assert/strict';
import { buildMlbAdvancedAdjustmentV2 } from '../lib/mlb-advanced-features-v2.js';
import { estimateRunProfileV13 } from '../lib/joint-score-v13.js';

const observedAt = '2026-08-22T12:00:00.000Z';
const gameDate = '2026-08-23T00:00:00.000Z';
const advanced = {
  fielding: { status: 'CONFIRMED', validationStatus: 'PASSED', observedAt, fieldingRunValue: 12, catcherFramingRuns: 3, includesCatcherFraming: true, innings: 900 },
  catcherFraming: { status: 'CONFIRMED', validationStatus: 'PASSED', observedAt, framingRuns: 5, pitches: 2200 },
  umpireZone: { status: 'PROJECTED', validationStatus: 'PASSED', observedAt, catcherNeutralRunsPerGame: -0.04, takenPitches: 1600 },
  injuryRunValue: { status: 'CONFIRMED', validationStatus: 'PASSED', observedAt, expectedAbsentShare: 1, replacementRunDeltaPerGame: 0.22, lineupCoverage: 1, regressedValue: { battingRunsPerGame: 0.18, fieldingRunsPerGame: 0.03, baserunningRunsPerGame: 0.01 } },
  pitchTypeMatchup: { status: 'CONFIRMED', validationStatus: 'PASSED', observedAt, centeredRunValuePer100: 0.15, expectedPitches: 95, samplePitches: 3000, lineupCoverage: 1 },
};
const context = {
  game: { gameDate }, league: { runsPerTeamGame: 4.5 },
  away: { advanced: structuredClone(advanced) }, home: { advanced: structuredClone(advanced) },
  advancedEnvironment: { directionalWind: { status: 'CONFIRMED', validationStatus: 'PASSED', observedAt, validatedRunsPerMphAlignment: 0.012, parkBaselineAlignedWindMph: 2, fieldBearingDegrees: 45, windFromDegrees: 225, windSpeedMph: 10, roofOpenProbability: 1 } },
};

const promotedPolicy = Object.fromEntries(['fielding', 'injury', 'pitchMatchup', 'catcherFraming', 'umpireZone', 'directionalWind'].map(name => [name, { promoted: true }]));

const result = buildMlbAdvancedAdjustmentV2(context, { promotionPolicy: promotedPolicy });
assert.equal(result.pointInTimeSafe, true);
assert.ok(result.away.components.fielding.runsPrevented > 0);
assert.equal(result.away.components.fielding.audit.framingRemoved, 3, 'FRV must remove framing before separate framing adjustment');
assert.ok(result.away.components.injury.runsLost > 0);
assert.equal(result.away.components.injury.audit.replacementDelta, 0.04, 'lineup-owned batting injury value must be excluded');
assert.equal(result.away.components.injury.audit.battingValueExcluded, true);
assert.ok(result.wind.runDelta > 0, 'wind blowing toward center field must increase runs');

const leaked = structuredClone(context);
leaked.away.advanced.fielding.observedAt = '2026-08-23T01:00:00.000Z';
const blocked = buildMlbAdvancedAdjustmentV2(leaked, { promotionPolicy: promotedPolicy });
assert.equal(blocked.pointInTimeSafe, false);
assert.equal(blocked.home.components.fielding.factor, 1, 'future fielding data must stay neutral');

const missing = buildMlbAdvancedAdjustmentV2({ game: { gameDate }, league: { runsPerTeamGame: 4.5 } });
assert.equal(missing.awayRunFactor, 1);
assert.equal(missing.homeRunFactor, 1);
assert.ok(missing.flags.length >= 11);

const productionNeutral = buildMlbAdvancedAdjustmentV2(context);
assert.equal(productionNeutral.awayRunFactor, 1, 'unpromoted production features must remain neutral even when payload says PASSED');
assert.ok(productionNeutral.flags.every(flag => flag.includes('OOS_VALIDATION_NOT_PROMOTED')));

const noWindCoefficient = structuredClone(context);
delete noWindCoefficient.advancedEnvironment.directionalWind.validatedRunsPerMphAlignment;
const neutralWind = buildMlbAdvancedAdjustmentV2(noWindCoefficient, { promotionPolicy: promotedPolicy });
assert.equal(neutralWind.wind.factor, 1, 'unvalidated wind coefficient must not move the mean');

const uncenteredWind = structuredClone(context);
delete uncenteredWind.advancedEnvironment.directionalWind.parkBaselineAlignedWindMph;
const blockedUncenteredWind = buildMlbAdvancedAdjustmentV2(uncenteredWind, { promotionPolicy: promotedPolicy });
assert.equal(blockedUncenteredWind.wind.factor, 1, 'raw wind must not duplicate the average wind embedded in park factor');
assert.equal(blockedUncenteredWind.wind.state.reason, 'WIND_NOT_CENTERED_AGAINST_PARK_BASELINE');

const pendingValidation = structuredClone(context);
pendingValidation.away.advanced.fielding.validationStatus = 'PENDING';
const pending = buildMlbAdvancedAdjustmentV2(pendingValidation, { promotionPolicy: promotedPolicy });
assert.equal(pending.home.components.fielding.factor, 1, 'feature without historical validation must remain neutral');
assert.ok(pending.flags.includes('HOME_FIELDING_HISTORICAL_VALIDATION_PENDING'));

const league = { runsPerTeamGame: 4.5, era: 4.2, whip: 1.30, ops: .720 };
const modelTeam = {
  hitting: { runsPerGame: 4.5, ops: .720, games: 100, status: 'CONFIRMED' },
  recentHitting: { runsPerGame: 4.5, ops: .720, games: 14, status: 'PROJECTED' },
  pitching: { era: 4.2, fip: 4.2, whip: 1.30, inningsPitched: 900, status: 'CONFIRMED' },
  recentPitching: { era: 4.2, fip: 4.2, whip: 1.30, inningsPitched: 100, status: 'PROJECTED' },
  starter: { era: 4.2, fip: 4.2, whip: 1.30, inningsPitched: 100, gamesStarted: 20, status: 'CONFIRMED', expectedInnings: 5 },
  bullpen: { qualityFactor: 1, pureRelief: true, status: 'CONFIRMED' },
  scoring: { games: 100, varianceRuns: 8 },
  lineup: { official: true, offensiveIndex: 1 },
  injuriesAvailable: true, injuries: [],
};
const baselineContext = { game: { gameDate }, league, away: structuredClone(modelTeam), home: structuredClone(modelTeam), park: { runFactor: 1, factorStatus: 'CONFIRMED' }, weather: { meanRunFactor: 1, status: 'CONFIRMED' }, sourceStatuses: { lineups: 'CONFIRMED' } };
const baselineProfile = estimateRunProfileV13(baselineContext);
const advancedContext = structuredClone(baselineContext);
advancedContext.away.advanced = structuredClone(advanced);
advancedContext.home.advanced = structuredClone(advanced);
advancedContext.advancedEnvironment = structuredClone(context.advancedEnvironment);
const advancedProfile = estimateRunProfileV13(advancedContext);
assert.equal(advancedProfile.full.away, baselineProfile.full.away, 'production joint-score mean must stay neutral until server policy promotes a family');
assert.equal(advancedProfile.components.advanced.version, result.version);

console.log('mlb-advanced-features-v2-test: PASS');
