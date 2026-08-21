import assert from 'node:assert/strict';
import {
  buildJointScoreSnapshotV13,
  estimateRunProfileV13,
  linkedPathMomentsForScenarioV13,
  scoreDistributionForScenario,
} from '../lib/joint-score-v13.js';

function team() {
  return {
    hitting: { status: 'CONFIRMED', games: 120, runsPerGame: 4.5, ops: 0.725 },
    recentHitting: { status: 'PROJECTED', games: 12, runsPerGame: 4.55, ops: 0.73 },
    pitching: { status: 'CONFIRMED', inningsPitched: 1000, era: 4.2, fip: 4.2, whip: 1.30 },
    recentPitching: { status: 'PROJECTED', inningsPitched: 110, era: 4.2, fip: 4.2, whip: 1.30 },
    starter: {
      status: 'CONFIRMED', throwsStatus: 'CONFIRMED', throws: 'R', expectedInnings: 5.5,
      inningsPitched: 120, gamesStarted: 21, gamesPitched: 21, era: 4.0, fip: 4.05, whip: 1.25,
    },
    lineup: { status: 'CONFIRMED', official: true, projected: false, offensiveIndex: 1 },
    vsLeft: { status: 'CONFIRMED', available: true, plateAppearances: 850, ops: 0.725 },
    vsRight: { status: 'CONFIRMED', available: true, plateAppearances: 1800, ops: 0.725 },
    bullpen: { status: 'CONFIRMED', pureRelief: true, qualityFactor: 1, fatigueIndex: 0.2, highLeverageAvailability: 0.9 },
    injuriesAvailable: true,
    injuries: [],
    scoring: { games: 60, meanRuns: 4.5, varianceRuns: 7 },
  };
}

function context() {
  return {
    game: { gamePk: 990103, away: 'A', home: 'H' },
    league: { runsPerTeamGame: 4.5, ops: 0.725, era: 4.2, whip: 1.30, kPer9: 8.7, bbPer9: 3.2, hrPer9: 1.15 },
    away: team(),
    home: team(),
    park: { runFactor: 1, factorStatus: 'CONFIRMED' },
    weather: { meanRunFactor: 1, status: 'CONFIRMED' },
    sourceStatuses: {},
  };
}

const neutral = context();
const neutralProfile = estimateRunProfileV13(neutral);

const strongerLineup = context();
strongerLineup.away.lineup.offensiveIndex = 1.10;
const strongerLineupProfile = estimateRunProfileV13(strongerLineup);
assert.ok(strongerLineupProfile.first5.away > neutralProfile.first5.away, 'official lineup strength must affect F5 mean');
assert.ok(strongerLineupProfile.ninth.away > neutralProfile.ninth.away, 'official lineup strength must affect late mean');

const platoonAdvantage = context();
platoonAdvantage.home.starter.throws = 'L';
platoonAdvantage.away.vsLeft.ops = 0.84;
platoonAdvantage.away.vsRight.ops = 0.64;
const platoonAdvantageProfile = estimateRunProfileV13(platoonAdvantage);
assert.ok(platoonAdvantageProfile.components.awayPlatoon > 1, 'opponent LHP must select vs-left split');
platoonAdvantage.home.starter.throws = 'R';
const platoonDisadvantageProfile = estimateRunProfileV13(platoonAdvantage);
assert.ok(platoonDisadvantageProfile.components.awayPlatoon < 1, 'opponent RHP must select vs-right split');
assert.ok(platoonAdvantageProfile.first5.away > platoonDisadvantageProfile.first5.away, 'handedness switch must change F5 mean in correct direction');

const longGoodStarter = context();
longGoodStarter.home.starter.era = 2.4;
longGoodStarter.home.starter.fip = 2.6;
longGoodStarter.home.starter.whip = 1.02;
longGoodStarter.home.starter.expectedInnings = 6.7;
longGoodStarter.home.bullpen.qualityFactor = 1.22;
const longGoodStarterProfile = estimateRunProfileV13(longGoodStarter);
const shortGoodStarter = structuredClone(longGoodStarter);
shortGoodStarter.home.starter.expectedInnings = 2.5;
const shortGoodStarterProfile = estimateRunProfileV13(shortGoodStarter);
assert.ok(longGoodStarterProfile.first5.away < shortGoodStarterProfile.first5.away, 'expected innings must control starter/bullpen F5 handoff');
assert.ok(longGoodStarterProfile.middle3.away < shortGoodStarterProfile.middle3.away, 'expected innings must control innings 6-8 handoff');

const eliteBullpen = context();
eliteBullpen.home.bullpen.qualityFactor = 0.82;
const weakBullpen = structuredClone(eliteBullpen);
weakBullpen.home.bullpen.qualityFactor = 1.24;
const eliteBullpenProfile = estimateRunProfileV13(eliteBullpen);
const weakBullpenProfile = estimateRunProfileV13(weakBullpen);
assert.ok(eliteBullpenProfile.ninth.away < weakBullpenProfile.ninth.away, 'relief-only quality must affect ninth-inning mean');

const snapshot = buildJointScoreSnapshotV13({ context: neutral, modelVersion: 'test-v103', rulesVersion: 'test-v103' });
assert.equal(snapshot.targetMarketCalibrationApplied, false);
assert.equal(snapshot.linkedSegmentPath, true);
assert.equal(snapshot.stateAwareBottomNinth, true);
assert.equal(snapshot.scenarios.length, 27);
const central = snapshot.scenarios.find(row => row.shocks.away === 0 && row.shocks.home === 0 && row.shocks.environment === 0);
const f5 = scoreDistributionForScenario(central, true);
const full = scoreDistributionForScenario(central, false);
assert.ok(Math.abs(f5.coverage - 1) < 1e-12);
assert.ok(Math.abs(full.coverage - 1) < 1e-12);
assert.equal(full.cells.some(cell => cell.awayRuns === cell.homeRuns), false, 'MLB final score distribution must not contain ties');
const linked = linkedPathMomentsForScenarioV13(central);
assert.ok(linked.f5FullTotalCorrelation > 0.25 && linked.f5FullTotalCorrelation < 1, 'F5/full total path must be positively linked');
assert.ok(linked.f5FullRunDifferentialCorrelation > 0.25 && linked.f5FullRunDifferentialCorrelation < 1, 'F5/full side path must be positively linked');

console.log(JSON.stringify({
  ok: true,
  lineupDeltaF5: strongerLineupProfile.first5.away - neutralProfile.first5.away,
  expectedInningsDeltaF5: shortGoodStarterProfile.first5.away - longGoodStarterProfile.first5.away,
  linked,
}, null, 2));
