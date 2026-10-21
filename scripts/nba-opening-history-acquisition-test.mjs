import assert from 'node:assert/strict';
import {
  nbaScoreboardDate, parseResearchTeamSchedule, researchScheduleOracle,
  validatedResearchScoreboard, researchArchiveCoverage,
} from '../lib/nba/opening-history-acquisition.js';
import { ESPN_NBA_TEAMS } from '../lib/nba/identity.js';

const year = 2020, sourceHash = 'a'.repeat(64);
const clone = value => structuredClone(value);
const competitor = (id, homeAway, values) => ({
  id: String(id), uid: `s:40~l:46~t:${id}`, homeAway,
  team: { id: String(id), uid: `s:40~l:46~t:${id}`, abbreviation: ESPN_NBA_TEAMS[id], displayName: `Team ${id}` },
  score: String(values.reduce((sum, value) => sum + value, 0)),
  linescores: values.map((value, index) => ({ period: index + 1, value })),
});
const games = Array.from({ length: 15 }, (_, index) => {
  const id = String(700001 + index), date = '2020-08-01T00:00:00Z';
  return {
    id, uid: `s:40~l:46~e:${id}`, date, season: { year, type: 2 },
    competitions: [{ id, uid: `s:40~l:46~e:${id}~c:${id}`, date, neutralSite: true,
      status: { type: { completed: true, name: 'STATUS_FINAL', state: 'post' } },
      competitors: [competitor(index * 2 + 1, 'home', [31, 22, 24, 23, 3]), competitor(index * 2 + 2, 'away', [28, 20, 30, 22, 0])],
    }],
  };
});
const scheduleGame = game => {
  const copy = clone(game);
  for (const side of copy.competitions[0].competitors) delete side.linescores;
  return copy;
};
const records = Array.from({ length: 30 }, (_, index) => ({
  year, team: index + 1,
  body: { team: { id: String(index + 1) }, requestedSeason: { year, type: 2 }, events: [scheduleGame(games[Math.floor(index / 2)])] },
}));
const board = { leagues: [{ id: '46', abbreviation: 'NBA', uid: 's:40~l:46' }], events: clone(games) };
const oracle = researchScheduleOracle(records, [year]);
assert.equal(oracle.expected.size, 15);
assert.deepEqual(oracle.days, ['2020-07-31'], 'COVID bubble dates come from source events, not guessed October-April bounds');
assert.equal(nbaScoreboardDate('2022-01-01T01:30:00Z'), '2021-12-31');
assert.equal(oracle.expected.get('nba:espn:game:700001').date, '2020-08-01', 'Taipei event date remains distinct from source-board day');

const history = validatedResearchScoreboard(board, oracle.expected, sourceHash);
assert.equal(history.length, 15);
assert.equal(history[0].homeScore, 103);
assert.equal(history[0].homeHalf, 53, 'half is actual first two quarters, not half of final score');
assert.equal(history[0].awayHalf, 48);
assert.equal(history[0].checkpointSha256, sourceHash);
const full = researchArchiveCoverage(oracle, history, [year]);
assert.equal(full.status, 'complete');
assert.deepEqual(full.missing, []);
assert.deepEqual(full.years[year], { expectedGames: 15, observedGames: 15, teamSchedulesChecked: 30, quarterCrosscheckedGames: 15, missingGames: 0, firstSourceGameDate: '2020-08-01', lastSourceGameDate: '2020-08-01' });
const partial = researchArchiveCoverage(oracle, history.slice(1), [year]);
assert.equal(partial.status, 'incomplete');
assert.equal(partial.years[year].missingGames, 1);
assert.deepEqual(partial.missing, ['nba:espn:game:700001']);
assert.throws(() => researchArchiveCoverage(oracle, [...history, history[0]], [year]), /Duplicate archive game/);
assert.throws(() => researchArchiveCoverage(oracle, [{ ...history[0], gameId: 'nba:espn:game:999999' }], [year]), /Unexpected archive game/);
for (const change of [
  { homeId: 'nba:espn:team:3' }, { year: 2022 }, { homeScore: 104 }, { neutralSite: false },
]) assert.throws(() => researchArchiveCoverage(oracle, [{ ...history[0], ...change }], [year]), /identity mismatch/);
for (const change of [
  { homeHalf: undefined }, { awayHalf: -1 }, { homeHalf: 1.5 }, { homeHalf: 104 }, { checkpointSha256: 'fake' },
]) assert.throws(() => researchArchiveCoverage(oracle, [{ ...history[0], ...change }], [year]), /Unverified archive quarters/);

const badSchedule = mutate => { const copy = clone(records[0].body); mutate(copy); return () => parseResearchTeamSchedule(copy, year, 1); };
assert.throws(badSchedule(value => value.team.id = '2'), /scope/);
assert.throws(badSchedule(value => value.requestedSeason.year = 2021), /scope/);
assert.throws(badSchedule(value => value.requestedSeason.type = 1), /scope/);
assert.throws(badSchedule(value => value.events = []), /Empty completed/);
assert.throws(badSchedule(value => value.events.push(clone(value.events[0]))), /Duplicate game/);
assert.throws(badSchedule(value => value.events[0].competitions[0].competitors[0].team.abbreviation = 'NHL'), /NBA/);
const postponed = clone(records[0].body);
const unfinished = clone(postponed.events[0]);
unfinished.id = '700999'; unfinished.uid = 's:40~l:46~e:700999';
unfinished.competitions[0].id = '700999'; unfinished.competitions[0].uid = 's:40~l:46~e:700999~c:700999';
unfinished.competitions[0].status.type = { completed: false, state: 'pre', name: 'STATUS_POSTPONED' };
postponed.events.push(unfinished);
const excluded = parseResearchTeamSchedule(postponed, year, 1);
assert.equal(excluded.rows.length, 1);
assert.equal(excluded.excluded.length, 1);
assert.match(excluded.excluded[0].reason, /not_completed/);
assert.throws(() => researchScheduleOracle(records.slice(1), [year]), /Incomplete 30-team/);
assert.throws(() => researchScheduleOracle([...records, records[0]], [year]), /Duplicate schedule source/);
const oneSided = clone(records); oneSided[1].body.events = [];
assert.throws(() => researchScheduleOracle(oneSided, [year]), /absent from both|Empty completed/);
const otherGame = scheduleGame(games[0]);
otherGame.id = '700998'; otherGame.uid = 's:40~l:46~e:700998';
otherGame.competitions[0].id = '700998'; otherGame.competitions[0].uid = 's:40~l:46~e:700998~c:700998';
otherGame.competitions[0].competitors = [competitor(2, 'home', [31, 22, 24, 23, 3]), competitor(3, 'away', [28, 20, 30, 22, 0])];
const missingOtherSide = clone(records);
missingOtherSide[1].body.events = [clone(otherGame)]; missingOtherSide[2].body.events.push(clone(otherGame));
assert.throws(() => researchScheduleOracle(missingOtherSide, [year]), /absent from both/, '30 nonempty schedules still require each game in both actual team schedules');
const conflict = clone(records); conflict[1].body.events[0].competitions[0].competitors[0].score = '104';
assert.throws(() => researchScheduleOracle(conflict, [year]), /Conflicting schedule result/);

const badBoard = mutate => { const copy = clone(board); mutate(copy); return () => validatedResearchScoreboard(copy, oracle.expected, sourceHash); };
assert.throws(badBoard(value => value.leagues[0].id = '90'), /league/);
assert.throws(badBoard(value => value.leagues.push(clone(value.leagues[0]))), /league/);
assert.throws(badBoard(value => value.events = Array.from({ length: 1000 }, () => clone(games[0]))), /truncation/);
assert.throws(badBoard(value => value.events.push(clone(value.events[0]))), /Duplicate scoreboard game/);
assert.throws(badBoard(value => value.events[0].uid = 's:70~l:90~e:700001'), /UID/);
assert.throws(badBoard(value => value.events[0].date = '2020-08-02T00:00:00Z'));
assert.throws(badBoard(value => value.events[0].competitions[0].neutralSite = false), /identity mismatch/);
assert.throws(badBoard(value => value.events[0].season.year = 2021), /identity mismatch/);
assert.throws(badBoard(value => value.events[0].competitions[0].competitors.reverse().forEach((side, index) => side.homeAway = index ? 'away' : 'home')), /identity mismatch/);
assert.throws(badBoard(value => delete value.events[0].competitions[0].competitors[0].linescores), /quarter/);
assert.throws(badBoard(value => value.events[0].competitions[0].competitors[0].linescores.pop()), /比分|checksum/);
assert.throws(badBoard(value => value.events[0].competitions[0].competitors[0].linescores[0].period = 2));
assert.throws(badBoard(value => value.events[0].competitions[0].competitors[0].linescores[0].value = 30.5));
assert.throws(badBoard(value => value.events[0].competitions[0].competitors[0].linescores[0].value = -1));
assert.throws(badBoard(value => value.events[0].competitions[0].competitors[0].linescores[0].value = 32));
assert.throws(() => validatedResearchScoreboard(board, oracle.expected, 'not-a-checksum'), /hash/);
console.log('NBA opening history acquisition tests passed (synthetic sources only; no holdout metrics).');
