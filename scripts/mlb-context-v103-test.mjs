import assert from 'node:assert/strict';
import {
  buildBullpenV13,
  expectedStarterInningsV13,
  parseOfficialLineupV13,
  projectLineupV13,
} from '../lib/mlb-context-v13.js';
import { personPitchingStatForTeamV11 } from '../lib/mlb-context-v11.js';

function batter(id, order, ops, position = 'OF') {
  return {
    person: { id, fullName: `Batter ${id}` },
    battingOrder: order,
    position: { abbreviation: position },
    seasonStats: { batting: { plateAppearances: 300, ops, obp: ops - 0.4, slg: 0.4 } },
  };
}

function pitcher(id, name, position = 'RP') {
  return {
    person: { id, fullName: name },
    position: { abbreviation: position },
    seasonStats: { pitching: { inningsPitched: '45.2', gamesPitched: 48, gamesStarted: 0, era: 3.4, whip: 1.18, strikeOuts: 52, baseOnBalls: 14, homeRuns: 5, saves: id === 20 ? 18 : 0, holds: id === 21 ? 14 : 0 } },
    stats: { pitching: { numberOfPitches: 18, inningsPitched: '1.0' } },
  };
}

function feed({ gamePk, date, teamId = 1, opponentId = 2, lineup = [], pitchers = [] }) {
  const players = Object.fromEntries([...lineup, ...pitchers].map(row => [`ID${row.person.id}`, row]));
  return {
    gamePk,
    gameData: {
      datetime: { dateTime: date },
      teams: { away: { id: teamId }, home: { id: opponentId } },
      players: players,
    },
    liveData: { boxscore: { teams: { away: { players, pitchers: pitchers.map(row => row.person.id) }, home: { players: {}, pitchers: [] } } } },
  };
}

const lineup = Array.from({ length: 9 }, (_, index) => batter(100 + index, (index + 1) * 100, 0.68 + index * 0.01, index === 7 ? 'C' : 'OF'));
const officialFeed = feed({ gamePk: 1, date: '2026-08-20T18:00:00Z', lineup });
const official = parseOfficialLineupV13(officialFeed, 1, 0.72);
assert.equal(official.official, true);
assert.equal(official.status, 'CONFIRMED');
assert.equal(official.players.length, 9);
assert.equal(official.catcher, 'Batter 107');

const projected = projectLineupV13([
  officialFeed,
  feed({ gamePk: 2, date: '2026-08-19T18:00:00Z', lineup: [...lineup].reverse().map((row, index) => ({ ...row, battingOrder: (index + 1) * 100 })) }),
], 1, 0.72);
assert.equal(projected.projected, true);
assert.equal(projected.players.length, 9);
assert.equal(projected.sampleGames, 2);

const starter = expectedStarterInningsV13({ inningsPitched: 102, gamesStarted: 20, gamesPitched: 21 }, { probableId: 10, scheduledInnings: 9 });
assert.ok(Math.abs(starter.expectedInnings - 5.1) < 1e-12);
assert.equal(starter.expectedInningsStatus, 'CONFIRMED');
const opener = expectedStarterInningsV13({ inningsPitched: 12, gamesStarted: 8, gamesPitched: 30 }, { probableId: 11, scheduledInnings: 9 });
assert.equal(opener.role, 'OPENER_OR_BULK_RISK');
assert.equal(opener.expectedInnings, 1.5);
const reliefOnlyProbable = expectedStarterInningsV13({ inningsPitched: 9.2, gamesStarted: 0, gamesPitched: 2 }, { probableId: 12, scheduledInnings: 9 });
assert.equal(reliefOnlyProbable.role, 'OPENER_OR_BULK_RISK');
assert.equal(reliefOnlyProbable.expectedInnings, 3.0, 'zero-start probable must not silently receive a normal 5.2-inning starter workload');

const transferredPitcher = { stats: [{ splits: [
  { team: { id: 134 }, stat: { inningsPitched: '6.1', era: '8.53' } },
  { team: { id: 145 }, stat: { inningsPitched: '9.2', era: '2.79' } },
  { stat: { inningsPitched: '16.0', era: '5.06' } },
] }] };
assert.equal(personPitchingStatForTeamV11(transferredPitcher, 145).era, '2.79', 'a transferred probable must use the split for the team in this game');
assert.equal(personPitchingStatForTeamV11(transferredPitcher, 999), null, 'another club split must never be substituted for the current team');

const starterPlayer = pitcher(10, 'Starter', 'SP');
const relievers = [pitcher(20, 'Closer'), pitcher(21, 'Setup'), pitcher(22, 'Reliever')];
const rotationStarter = {
  ...pitcher(30, 'Rotation Starter', 'SP'),
  seasonStats: { pitching: { inningsPitched: '118.0', gamesPitched: 22, gamesStarted: 22, era: 3.6, whip: 1.2, strikeOuts: 110, baseOnBalls: 32, homeRuns: 12 } },
};
const recentFeed = feed({ gamePk: 3, date: '2026-08-20T18:00:00Z', pitchers: [starterPlayer, ...relievers] });
const bullpen = buildBullpenV13({
  roster: [...relievers, rotationStarter].map(row => ({ id: row.person.id, name: row.person.fullName, position: row.position.abbreviation, ...row.seasonStats.pitching })),
  recentFeeds: [recentFeed],
  teamId: 1,
  gameDate: '2026-08-21T18:00:00Z',
  probableStarterId: 10,
  league: { era: 4.2, whip: 1.30, kPer9: 8.7, bbPer9: 3.2, hrPer9: 1.15 },
  rosterComplete: false,
});
assert.equal(bullpen.pureRelief, true);
assert.equal(bullpen.relievers.some(row => row.id === 10), false, 'starter must never enter relief-only bullpen');
assert.equal(bullpen.relievers.some(row => row.id === 30), false, 'rotation starters must not contaminate the relief-only bullpen');
assert.equal(bullpen.usageAvailable, true);
assert.equal(bullpen.rosterCount, 3);
assert.ok(bullpen.fatigueIndex > 0);
assert.ok(bullpen.highLeverageAvailability < 1);

console.log(JSON.stringify({ ok: true, officialPlayers: official.players.length, projectedPlayers: projected.players.length, bullpenRoster: bullpen.rosterCount }, null, 2));
