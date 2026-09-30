import assert from 'node:assert/strict';
import { personPitchingStatForTeamV11 } from '../lib/mlb-context-v11.js';
import { buildGameContextV13, parseOfficialLineupV13, starterOnlyGameLogV13, validateProbableStarterIdentityV13 } from '../lib/mlb-context-v13.js';

const game = { gamePk: 880010, leagueId: 'MLB', officialDate: '2099-09-22', gameDate: '2099-09-23T02:00:00Z',
  awayTeamId: 1, homeTeamId: 2, awayProbableId: 10, homeProbableId: 11, awayProbable: 'Starter A', homeProbable: 'Starter B', scheduledInnings: 9 };
const liveFeed = () => ({ gamePk: game.gamePk, gameData: {
  teams: { away: { id: 1 }, home: { id: 2 } }, datetime: { officialDate: game.officialDate },
  probablePitchers: { away: { id: 10, fullName: 'Starter A' }, home: { id: 11, fullName: 'Starter B' } },
  players: { ID10: { id: 10, pitchHand: { code: 'L' } }, ID11: { id: 11, pitchHand: { code: 'R' } } },
}, liveData: { boxscore: { teams: { away: { players: {} }, home: { players: {} } } } } });
const isConflict = error => error.code === 'MLB_STARTER_SOURCE_CONFLICT' && error.status === 409 && /先發投手資料不一致/.test(error.message);

validateProbableStarterIdentityV13(liveFeed(), game);
validateProbableStarterIdentityV13(null, game);
validateProbableStarterIdentityV13({ gameData: {} }, game);
validateProbableStarterIdentityV13(liveFeed(), { ...game, awayProbableId: null });
const nameOnly = liveFeed();
delete nameOnly.gameData.probablePitchers.away.id;
nameOnly.gameData.probablePitchers.away.fullName = 'A name alone does not identify another player';
validateProbableStarterIdentityV13(nameOnly, game);
const spellingChange = liveFeed();
spellingChange.gameData.probablePitchers.away.fullName = 'Official name variant';
validateProbableStarterIdentityV13(spellingChange, game);
for (const side of ['away', 'home']) {
  const changed = liveFeed(); changed.gameData.probablePitchers[side].id = 12;
  assert.throws(() => validateProbableStarterIdentityV13(changed, game), isConflict, `${side}: same spelling cannot override different IDs`);
}
const swapped = liveFeed();
swapped.gameData.probablePitchers = { away: { id: 11 }, home: { id: 10 } };
assert.throws(() => validateProbableStarterIdentityV13(swapped, game), isConflict);
assert.throws(() => validateProbableStarterIdentityV13(null, { ...game, homeProbableId: 10 }), isConflict);
for (const invalid of [true, {}, -1, 1.5, Infinity, 'not-a-player']) {
  assert.throws(() => validateProbableStarterIdentityV13(null, { ...game, awayProbableId: invalid }), isConflict);
  const feed = liveFeed(); feed.gameData.probablePitchers.away.id = invalid;
  assert.throws(() => validateProbableStarterIdentityV13(feed, game), isConflict);
}
const invalidRecord = liveFeed(); invalidRecord.gameData.players.ID10.id = 20;
assert.throws(() => validateProbableStarterIdentityV13(invalidRecord, game), isConflict);
const oppositeRoster = liveFeed(); oppositeRoster.liveData.boxscore.teams.home.players.ID10 = { person: { id: 10 } };
assert.throws(() => validateProbableStarterIdentityV13(oppositeRoster, game), isConflict);

const stat = { inningsPitched: '60.0', gamesStarted: 10, gamesPitched: 10, earnedRuns: 20, hits: 55, baseOnBalls: 10, strikeOuts: 60, homeRuns: 5 };
const row = { team: { id: 1 }, player: { id: 10 }, season: '2099', date: '2099-09-20', stat };
const payload = rows => ({ stats: [{ group: { displayName: 'pitching' }, splits: rows }] });
const select = value => personPitchingStatForTeamV11(value, 1, { playerId: 10, season: '2099' });
const startLog = value => starterOnlyGameLogV13(value, { teamId: 1, playerId: 10, endDate: '2099-09-21' });
assert.deepEqual(select(payload([row])), stat);
assert.equal(startLog(payload([row])).available, true);
for (const invalidRow of [
  { ...row, player: { id: 12 } }, { ...row, player: undefined, playerId: 12 },
  { ...row, team: { id: 2 } }, { ...row, season: '2098' },
  { ...row, group: { displayName: 'hitting' } }, { ...row, sport: { id: 2 } },
]) {
  assert.equal(select(payload([invalidRow])), null);
  assert.equal(startLog(payload([invalidRow])).available, false);
  assert.deepEqual(select(payload([invalidRow, row])), stat, 'a conflicting row cannot displace the matching identity');
  assert.equal(startLog(payload([invalidRow, row])).gamesStarted, 1);
}
const otherGroup = { stats: [{ group: { displayName: 'hitting' }, splits: [row] }] };
assert.equal(select(otherGroup), null);
assert.equal(startLog(otherGroup).available, false);
const requestScopedRow = { team: { id: 1 }, date: row.date, stat };
assert.deepEqual(select(payload([requestScopedRow])), stat, 'official endpoint-scoped responses can omit repeated person/season metadata');
assert.equal(startLog(payload([requestScopedRow])).available, true);
for (const date of [undefined, '', '2098-09-20', '2099-09-22']) assert.equal(startLog(payload([{ ...row, date }])).available, false, 'undated, previous-season and future games cannot contribute to a dated starter log');

// Exercise the actual context builder, not only the guard. A source conflict
// must reject the context before lineup/model assembly and remain a 409.
const contextFor = ({ feed = liveFeed(), feedStatus = 200, invalidStats = false, statsOverride = null } = {}) => buildGameContextV13(game, {
  timeoutMs: 100,
  fetchImpl: async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/feed/live')) return Response.json(feed || {}, { status: feedStatus });
    if (url.pathname.endsWith('/roster')) return Response.json({ roster: [] });
    if (url.pathname.endsWith('/schedule')) return Response.json({ dates: [] });
    if (url.pathname.includes('/people/') && url.searchParams.get('group') === 'pitching') {
      const requestedId = Number(url.pathname.split('/')[4]);
      const entry = { ...row, team: { id: requestedId === 10 ? 1 : 2 }, player: { id: invalidStats ? 999 : requestedId },
        stat: statsOverride || stat };
      return Response.json(payload([entry]));
    }
    return Response.json({ stats: [{ splits: [] }] });
  },
});
const valid = await contextFor();
assert.equal(valid.away.starter.id, 10);
assert.equal(valid.home.starter.id, 11);
assert.equal(valid.away.starter.throws, 'L');
assert.equal(valid.home.starter.throws, 'R');
assert.equal(valid.away.starter.individualPitcherStatsAvailable, true);
assert.ok(valid.away.starter.sourceReceipts.filter(receipt => receipt.sourceRecord.includes('/people/')).every(receipt => receipt.playerId === 10 && receipt.accepted === true));
const conflict = liveFeed(); conflict.gameData.probablePitchers.away.id = 12;
await assert.rejects(contextFor({ feed: conflict }), isConflict);
const missing = await contextFor({ feed: null, feedStatus: 503 });
assert.equal(missing.away.starter.id, 10, 'feed outage preserves the valid schedule-backed path');
assert.equal(missing.away.starter.throwsStatus, 'MISSING');
assert.equal(missing.away.starter.individualPitcherStatsAvailable, true);
const rejectedFeed = await contextFor({ feed: conflict, feedStatus: 503 });
assert.equal(rejectedFeed.away.starter.throwsStatus, 'MISSING', 'failed HTTP response cannot become official personnel evidence even if its body resembles a feed');
const wrongMetrics = await contextFor({ invalidStats: true });
assert.equal(wrongMetrics.away.starter.individualPitcherStatsAvailable, false, 'wrong-player aggregate and game-log metrics cannot reach the model');
assert.equal(wrongMetrics.home.starter.individualPitcherStatsAvailable, false);
assert.equal(wrongMetrics.away.starter.era, null);
assert.ok(wrongMetrics.away.starter.sourceReceipts.filter(receipt => receipt.sourceRecord.includes('/people/')).every(receipt => receipt.accepted === false));
const wrongElite = await contextFor({ invalidStats: true, statsOverride: { ...stat, earnedRuns: 0, hits: 0 } });
assert.equal(wrongMetrics.away.starter.expectedInnings, wrongElite.away.starter.expectedInnings, 'rejected identity cannot influence expected workload');
assert.equal(wrongElite.away.starter.era, null);

const hitters = Array.from({ length: 9 }, (_, i) => ({ person: { id: 100 + i, fullName: `Batter ${i}` },
  battingOrder: (i + 1) * 100, seasonStats: { batting: { ops: 0.72, plateAppearances: 300 } } }));
const withLineup = rows => {
  const feed = liveFeed();
  feed.liveData.boxscore.teams.away.players = Object.fromEntries(rows.map((row, i) => [`row${i}`, row]));
  return feed;
};
assert.equal(parseOfficialLineupV13(withLineup(hitters), 1, 0.72).official, true);
for (const invalid of [undefined, null, '', 0, -1, 1.5, Infinity, true, {}, 'not-an-id']) {
  const rows = structuredClone(hitters); rows[0].person.id = invalid;
  const parsed = parseOfficialLineupV13(withLineup(rows), 1, 0.72);
  assert.equal(parsed.official, false, `invalid lineup ID ${String(invalid)} must not confirm nine identities`);
  assert.equal(parsed.players.length, 8);
  assert.ok(parsed.players.every(player => Number.isSafeInteger(player.id) && player.id > 0));
}
const onlyNames = hitters.map(({ person, ...rest }) => ({ ...rest, person: { fullName: person.fullName } }));
assert.equal(parseOfficialLineupV13(withLineup(onlyNames), 1, 0.72).identityStatus, 'MISSING');
const repeated = structuredClone(hitters); repeated[1].person.id = repeated[0].person.id;
const rejectedRepeated = parseOfficialLineupV13(withLineup(repeated), 1, 0.72);
assert.equal(rejectedRepeated.official, false);
assert.equal(rejectedRepeated.players.length, 7, 'one person cannot occupy two different opening slots');
const keyMismatch = withLineup(hitters);
keyMismatch.liveData.boxscore.teams.away.players = Object.fromEntries(hitters.map(row => [`ID${row.person.id}`, row]));
keyMismatch.liveData.boxscore.teams.away.players.ID100 = { ...hitters[0], person: { id: 999, fullName: 'Wrong dictionary identity' } };
assert.equal(parseOfficialLineupV13(keyMismatch, 1, 0.72).players.length, 8);
const officialContext = await contextFor({ feed: withLineup(hitters) });
assert.equal(officialContext.away.lineup.identityStatus, 'CONFIRMED');
const invalidLineupContext = await contextFor({ feed: withLineup(onlyNames) });
assert.equal(invalidLineupContext.away.lineup.identityStatus, 'MISSING', 'real context builder must not re-promote name-only rows');

console.log('MLB starter source consistency: PASS (source conflicts, valid/missing feed, side isolation, scoped player/season/group stats, rejected metric receipts, lineup player IDs, real context path)');
