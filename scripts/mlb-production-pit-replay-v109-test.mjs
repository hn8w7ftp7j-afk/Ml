import assert from 'node:assert/strict';
import { replayProductionPitSnapshotV109, validateProductionPitSnapshotV109 } from '../lib/mlb-production-pit-replay-v109.js';

const snapshotAsOf = '2026-08-23T18:00:00.000Z';
const team = {
  hitting: { games: 100, gamesPlayed: 100, runsPerGame: 4.5, ops: 0.73, status: 'CONFIRMED' },
  recentHitting: { games: 12, gamesPlayed: 12, runsPerGame: 4.4, status: 'CONFIRMED' },
  pitching: { inningsPitched: 900, era: 4.2, whip: 1.28, kPer9: 8.7, bbPer9: 3.1, hrPer9: 1.1, status: 'CONFIRMED' },
  recentPitching: { inningsPitched: 90, era: 4.1, whip: 1.27, kPer9: 8.8, bbPer9: 3.0, hrPer9: 1.0, status: 'CONFIRMED' },
  starter: { inningsPitched: 120, gamesStarted: 22, expectedInnings: 5.45, era: 3.8, whip: 1.2, kPer9: 9, bbPer9: 2.8, hrPer9: 1, status: 'CONFIRMED', throws: 'R', throwsStatus: 'CONFIRMED' },
  bullpen: { pureRelief: true, qualityFactor: 1, status: 'CONFIRMED' },
  lineup: { official: true, offensiveIndex: 1, players: [] },
  scoring: { games: 100, varianceRuns: 7 },
  advanced: {},
};
const context = {
  leagueId: 'MLB', analysisMode: 'EXPERIMENTAL_SHADOW', betEligible: false, executable: false,
  fetchedAt: snapshotAsOf,
  game: { leagueId: 'MLB', gamePk: 777001, gameDate: '2026-08-23T23:00:00.000Z', away: '洋基', home: '紅襪', scheduledInnings: 9 },
  league: { runsPerTeamGame: 4.4, ops: 0.72, era: 4.25, whip: 1.30, kPer9: 8.6, bbPer9: 3.2, hrPer9: 1.15 },
  away: structuredClone(team), home: structuredClone(team),
  park: { runFactor: 1, factorStatus: 'CONFIRMED' }, weather: { meanRunFactor: 1, status: 'CONFIRMED', roofConfirmed: true },
  sourceStatuses: { lineups: 'CONFIRMED' }, dataGateV10: { passedForShadowScore: true, modelErrorMarginEV: 0.008 },
  featureProvenance: [{ featureName: 'core', observedAt: snapshotAsOf }],
};
const input = {
  snapshotAsOf,
  context,
  markets: [
    { market: '全場大小', pick: '大8平', water: 0.95, lineAsOf: snapshotAsOf, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', executable: true },
    { market: '全場大小', pick: '小8平', water: 0.95, lineAsOf: snapshotAsOf, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', executable: true },
  ],
  actual: { awayRuns: 5, homeRuns: 4 },
};
assert.equal(validateProductionPitSnapshotV109(input).ok, true);
const result = replayProductionPitSnapshotV109(input);
assert.equal(result.ok, true);
assert.equal(result.results.length, 2);
assert.ok(result.results.every(row => Number.isFinite(row.rawWeightedEv)));
assert.ok(result.results.every(row => Number.isFinite(row.realizedNetReturn)));
const leaked = structuredClone(input);
leaked.context.featureProvenance[0].observedAt = '2026-08-24T00:00:00.000Z';
assert.match(validateProductionPitSnapshotV109(leaked).errors.join('|'), /FEATURE_FROM_FUTURE/);

console.log('Production-exact MLB PIT replay v10.9 PASS');
