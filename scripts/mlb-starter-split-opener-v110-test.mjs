import assert from 'node:assert/strict';
import { personPitchingStatForTeamV11 } from '../lib/mlb-context-v11.js';
import { expectedStarterInningsV13 } from '../lib/mlb-context-v13.js';
import { estimateRunProfileV13 } from '../lib/joint-score-v13.js';

const transferred = { stats: [{ splits: [
  { stat: { inningsPitched: '60.0', era: '4.50' } },
  { team: { id: 134 }, stat: { inningsPitched: '15.0', gamesStarted: 3, era: '7.20' } },
  { team: { id: 145 }, stat: { inningsPitched: '45.0', gamesStarted: 8, era: '3.10' } },
] }] };
assert.equal(personPitchingStatForTeamV11(transferred, 145).era, '3.10', 'current-game team split must beat aggregate/first split');
assert.equal(personPitchingStatForTeamV11(transferred, 134).era, '7.20');
assert.equal(personPitchingStatForTeamV11(transferred, 147), null, 'a non-matching team split must fail neutral instead of borrowing another club');

const opener = expectedStarterInningsV13({ inningsPitched: 14, gamesStarted: 0, gamesPitched: 12 }, { probableId: 123, scheduledInnings: 9 });
assert.equal(opener.role, 'OPENER_OR_BULK_RISK');
assert.equal(opener.expectedInnings, 3);
assert.equal(opener.expectedInningsStatus, 'PROJECTED');
const oneStart = expectedStarterInningsV13({ inningsPitched: 2, gamesStarted: 1, gamesPitched: 8 }, { probableId: 124, scheduledInnings: 9 });
assert.equal(oneStart.role, 'OPENER_OR_BULK_RISK');
assert.equal(oneStart.expectedInnings, 2);
assert.equal(oneStart.expectedInningsStatus, 'PROJECTED');
const rejectedTeamProxy = expectedStarterInningsV13({
  projectedFromTeamPitching: true,
  inningsPitched: 1350,
  gamesStarted: 150,
  gamesPitched: 150,
  era: 2.50,
  fip: 2.60,
  whip: 1.05,
}, { probableId: 125, scheduledInnings: 9 });
assert.equal(rejectedTeamProxy.expectedInnings, 4.8, 'whole-team innings must never become a 7.2 inning probable starter');
assert.equal(rejectedTeamProxy.rawSeasonInningsPerStart, null);
assert.equal(rejectedTeamProxy.expectedInningsStatus, 'PROJECTED');
assert.equal(rejectedTeamProxy.source, 'TEAM_PITCHING_PROXY_REJECTED_NEUTRAL');
assert.equal(rejectedTeamProxy.individualPitcherStatsAvailable, false);

function team(expectedInnings) {
  return {
    hitting: { status: 'CONFIRMED', games: 120, runsPerGame: 4.5, ops: 0.725 },
    recentHitting: { status: 'PROJECTED', games: 12, runsPerGame: 4.5, ops: 0.725 },
    pitching: { status: 'CONFIRMED', inningsPitched: 1000, era: 4.2, fip: 4.2, whip: 1.30 },
    recentPitching: { status: 'PROJECTED', inningsPitched: 110, era: 4.2, fip: 4.2, whip: 1.30 },
    starter: { status: 'CONFIRMED', throwsStatus: 'CONFIRMED', throws: 'R', expectedInnings, inningsPitched: 80, gamesStarted: 15, gamesPitched: 16, era: 2.5, fip: 2.6, whip: 1.05 },
    lineup: { status: 'CONFIRMED', official: true, offensiveIndex: 1 },
    vsRight: { status: 'CONFIRMED', available: true, plateAppearances: 1600, ops: 0.725 },
    vsLeft: { status: 'CONFIRMED', available: true, plateAppearances: 700, ops: 0.725 },
    bullpen: { status: 'CONFIRMED', pureRelief: true, qualityFactor: 1.24 },
    injuriesAvailable: true,
    injuries: [],
    scoring: { games: 60, varianceRuns: 7 },
  };
}

function context(homeExpectedInnings) {
  return {
    game: { gamePk: 991101, gameDate: '2026-08-23T00:00:00.000Z' },
    league: { runsPerTeamGame: 4.5, ops: 0.725, era: 4.2, whip: 1.30, kPer9: 8.7, bbPer9: 3.2, hrPer9: 1.15 },
    away: team(5.5),
    home: team(homeExpectedInnings),
    park: { runFactor: 1, factorStatus: 'CONFIRMED' },
    weather: { meanRunFactor: 1, status: 'CONFIRMED' },
    sourceStatuses: { lineups: 'CONFIRMED' },
  };
}

const normalProfile = estimateRunProfileV13(context(5.5));
const openerProfile = estimateRunProfileV13(context(opener.expectedInnings));
assert.ok(openerProfile.first5.away > normalProfile.first5.away, 'opener workload must hand more F5 innings to the weak bullpen');
assert.ok(openerProfile.middle3.away > normalProfile.middle3.away, 'opener workload must hand innings 6-8 to the bullpen');

const missingBullpenContext = context(5.5);
missingBullpenContext.home.bullpen = { status: 'MISSING', pureRelief: false, qualityFactor: null };
missingBullpenContext.home.pitching = { status: 'CONFIRMED', inningsPitched: 1200, era: 1.50, fip: 1.60, whip: 0.80 };
missingBullpenContext.home.recentPitching = { status: 'PROJECTED', inningsPitched: 100, era: 1.20, fip: 1.30, whip: 0.70 };
const missingBullpenEliteTeamProxy = estimateRunProfileV13(missingBullpenContext);
missingBullpenContext.home.pitching = { status: 'CONFIRMED', inningsPitched: 1200, era: 8.50, fip: 8.40, whip: 2.20 };
missingBullpenContext.home.recentPitching = { status: 'PROJECTED', inningsPitched: 100, era: 8.80, fip: 8.70, whip: 2.30 };
const missingBullpenPoorTeamProxy = estimateRunProfileV13(missingBullpenContext);
assert.equal(missingBullpenEliteTeamProxy.components.homeBullpen, 1);
assert.equal(missingBullpenPoorTeamProxy.components.homeBullpen, 1);
assert.ok(Math.abs(missingBullpenEliteTeamProxy.first5.away - missingBullpenPoorTeamProxy.first5.away) < 1e-12, 'team pitching must not move F5 runs when pure-relief data is unavailable');
assert.ok(Math.abs(missingBullpenEliteTeamProxy.full.away - missingBullpenPoorTeamProxy.full.away) < 1e-12, 'team pitching must not move full-game runs when pure-relief data is unavailable');

const proxyQualityContext = context(rejectedTeamProxy.expectedInnings);
proxyQualityContext.home.starter = {
  ...proxyQualityContext.home.starter,
  ...rejectedTeamProxy,
  projectedFromTeamPitching: true,
  era: 1.20,
  fip: 1.30,
  whip: 0.70,
};
const eliteRejectedProxy = estimateRunProfileV13(proxyQualityContext);
proxyQualityContext.home.starter = { ...proxyQualityContext.home.starter, era: 8.80, fip: 8.70, whip: 2.30 };
const poorRejectedProxy = estimateRunProfileV13(proxyQualityContext);
assert.equal(eliteRejectedProxy.components.homeStarter, 1);
assert.equal(poorRejectedProxy.components.homeStarter, 1);
assert.ok(Math.abs(eliteRejectedProxy.first5.away - poorRejectedProxy.first5.away) < 1e-12, 'rejected team proxy ERA/FIP/WHIP must be audit-only');

console.log(JSON.stringify({
  ok: true,
  selectedCurrentTeamEra: personPitchingStatForTeamV11(transferred, 145).era,
  openerExpectedInnings: opener.expectedInnings,
  openerF5Delta: openerProfile.first5.away - normalProfile.first5.away,
}, null, 2));
