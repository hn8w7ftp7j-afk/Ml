import assert from 'node:assert/strict';
import { deriveNhlStatistics, goalieRevision, validateNhlPersonnel, nhlScheduleContext } from '../lib/nhl/context.js';
import { cachedNhlData } from '../lib/nhl/cache.js';
import { validateNhlCapture, NHL_READER_INTERFACE_VERSION } from '../lib/nhl/reader.js';
import { validateNhlObservation } from '../lib/nhl/store.js';

const game = { league: 'NHL', gameId: '2023020001', awayTeamId: 1, homeTeamId: 2, startTimeUTC: '2023-10-11T00:00:00Z', northAmericaDate: '2023-10-10' };
const values = deriveNhlStatistics({ scope: '5V5', xGF: 4, xGA: 6, saves: 27, shotsOnGoalAgainst: 30, goals: 3, shotsOnGoal: 25, powerPlayGoals: 1, powerPlayOpportunities: 4, powerPlayGoalsAgainst: 2, timesShorthanded: 5 });
assert.equal(values.xGFPercent.value, 0.4); assert.equal(values.savePercent.value, 0.9); assert.equal(values.shootingPercent.value, 0.12);
assert.equal(values.penaltyKillPercent.value, 0.6); assert.equal(values.highDangerXG.value, null);
assert.equal(deriveNhlStatistics({ saves: null, shotsOnGoalAgainst: 30 }).savePercent.value, null);
assert.equal(deriveNhlStatistics({ saves: 0, shotsOnGoalAgainst: 30 }).savePercent.value, 0);
assert.equal(deriveNhlStatistics({ xGF: 0, xGA: 0 }).xGFPercent.value, null);

const now = Date.parse('2023-10-10T23:55:00Z');
const evidence = { side: 'away', teamId: 1, playerId: 8470001, status: 'PROJECTED', sourcePublishedAt: '2023-10-10T23:50:00Z', observedAt: '2023-10-10T23:51:00Z', sourceUrl: 'https://www.nhl.com/news/test-evidence' };
const first = goalieRevision(null, evidence, game, { now }); assert.equal(first.ok, true); assert.equal(first.current.fresh, true);
const changed = goalieRevision(first.current, { ...evidence, playerId: 8470002, status: 'CONFIRMED', confirmationExplicit: true, sourcePublishedAt: '2023-10-10T23:52:00Z', observedAt: '2023-10-10T23:53:00Z' }, game, { now });
assert.equal(changed.playerChanged, true); assert.equal(changed.current.previousRevision, first.current.revision);
assert.equal(changed.current.confirmationExplicit, true);
assert.equal(goalieRevision(changed.current, evidence, game, { now }).ok, false);
assert.equal(goalieRevision(null, { ...evidence, teamId: 2 }, game, { now }).ok, false);
assert.equal(goalieRevision(null, { ...evidence, sourcePublishedAt: '2023-10-11T02:00:00Z' }, game, { now }).ok, false);
assert.equal(goalieRevision(null, evidence, game, { now: now + 3600000 }).current.fresh, false);
assert.equal(validateNhlPersonnel({ players: [{ playerId: 1, teamId: 99 }] }, game).status, 'BLOCK');
const prior = { ...game, gameId: '2023020000', status: 'FINAL', startTimeUTC: '2023-10-10T00:00:00Z', northAmericaDate: '2023-10-09' };
const coverage = { complete: true, from: '2023-10-01', to: '2023-10-10' };
const context = nhlScheduleContext(game, [prior, { ...game, gameId: '2023020002', startTimeUTC: '2023-10-12T00:00:00Z', northAmericaDate: '2023-10-11' }], { scheduleCoverage: coverage });
assert.equal(context.away.backToBack, true); assert.equal(context.away.restDays, 0); assert.equal(context.away.gamesIn7Days, 2); assert.equal(context.away.travelKm, null);

let calls = 0;
const loader = async () => { calls++; return { league: 'NHL', games: [{ gameId: game.gameId }] }; };
const [cached1, cached2] = await Promise.all([cachedNhlData('test-context-20231010', loader), cachedNhlData('test-context-20231010', loader)]);
assert.equal(calls, 1); assert.deepEqual(cached1.games, cached2.games);
await assert.rejects(() => cachedNhlData('bad-league', async () => ({ league: 'MLB' })), /LEAGUE_CONFLICT/);
await assert.rejects(() => cachedNhlData('../baseball', loader), /INVALID_NHL_CACHE_KEY/);
let failCount = 0; const failure = async () => { failCount++; throw new Error('provider down'); };
await assert.rejects(() => cachedNhlData('retry-failure', failure));
await assert.rejects(() => cachedNhlData('retry-failure', failure)); assert.equal(failCount, 2);

const capture = { league: 'NHL', provider: 'TAI888_READER', interfaceVersion: NHL_READER_INTERFACE_VERSION, boardDate: '2023-10-11', observedAt: new Date(now).toISOString(), pageUrl: 'https://www1.tai888.in/', readerVersion: 'test-interface', pageLeagueLabel: 'NHL', rawRows: [] };
const accepted = validateNhlCapture(capture, { now }); assert.equal(accepted.ok, true); assert.equal(accepted.payload.executable, false); assert.equal(accepted.status, 'WAITING_REAL_DATA');
for (const invalid of [{ league: 'MLB' }, { pageUrl: 'https://attacker.example/' }, { boardDate: '2023-02-30' }, { observedAt: '2023-10-09T00:00:00Z' }, { rawRows: [{ sourceRowId: '1', eventLabel: '<script>', marketLabel: 'test', lineText: 'test' }] }]) assert.equal(validateNhlCapture({ ...capture, ...invalid }, { now }).ok, false);

// Cross-review regression cases: corrupted input cannot turn into a successful
// confirmation, a cross-league cache hit, or a claim of complete historical data.
const impossible = deriveNhlStatistics({ saves: 31, shotsOnGoalAgainst: 30, xGF: -1, xGA: 2, timesShorthanded: 1, powerPlayGoalsAgainst: 2 });
assert.equal(impossible.savePercent.value, null); assert.equal(impossible.penaltyKillPercent.value, null);
assert.equal(impossible.xGF.value, null); assert.equal(impossible.qa.status, 'BLOCK');
assert.equal(impossible.qa.invalidInputs.saves, 31);
assert.equal(validateNhlPersonnel({ players: [null] }, game, { asOf: 'invalid' }).ok, false);
const personnel = { players: [{ ...evidence, position: 'G' }], goalies: { away: { ...evidence, status: 'CONFIRMED', confirmationExplicit: true } } };
assert.equal(validateNhlPersonnel(personnel, game, { asOf: new Date(now).toISOString() }).ok, true);
assert.equal(validateNhlPersonnel(personnel, game, { asOf: 'invalid' }).ok, false);
assert.equal(validateNhlPersonnel({ ...personnel, players: [{ ...personnel.players[0], playerId: -1 }] }, game, { asOf: new Date(now).toISOString() }).ok, false);
assert.equal(goalieRevision(null, { ...evidence, status: 'CONFIRMED' }, game, { now }).ok, false);
assert.equal(goalieRevision({ ...first.current, gameId: '2023020099' }, evidence, game, { now }).ok, false);
assert.equal(goalieRevision(null, { ...evidence, gameId: '2023020099' }, game, { now }).ok, false);
assert.equal(goalieRevision(null, { ...evidence, observedAt: '2023-10-10T23:51:00' }, game, { now }).ok, false);
assert.equal(goalieRevision(null, evidence, game, { now: NaN }).ok, false);
const sparse = nhlScheduleContext(game, [prior]);
assert.equal(sparse.away.restDays, null); assert.equal(sparse.away.gamesIn7Days, null);
assert.equal(sparse.away.observedRestDays, 0); assert.equal(sparse.qa.status, 'WARNING');
const duplicate = nhlScheduleContext(game, [prior, prior, { ...prior, gameId: '2023020099', status: 'CANCELED' }], { scheduleCoverage: coverage });
assert.equal(duplicate.away.gamesIn7Days, 2);
assert.equal(nhlScheduleContext(game, [prior, { ...prior, homeTeamId: 3 }], { scheduleCoverage: coverage }).qa.status, 'BLOCK');
assert.equal(nhlScheduleContext(game, null).qa.status, 'BLOCK');
assert.equal(nhlScheduleContext(game, [prior], { asOf: 'invalid' }).qa.status, 'BLOCK');

// A future target must account for the already scheduled preceding game. The
// October 9 fixture changes projected rest from four days to a back-to-back.
const futureTarget = { ...game, gameId: '2026020100', startTimeUTC: '2026-10-11T00:00:00Z', northAmericaDate: '2026-10-10' };
const futureCoverage = { complete: true, from: '2026-10-01', to: '2026-10-10' };
const completedOctober5 = { ...futureTarget, gameId: '2026020001', homeTeamId: 3, status: 'OFF', gameScheduleState: 'OK',
  startTimeUTC: '2026-10-06T00:00:00Z', northAmericaDate: '2026-10-05' };
const scheduledOctober9 = { ...completedOctober5, gameId: '2026020090', status: 'FUT',
  startTimeUTC: '2026-10-10T00:00:00Z', northAmericaDate: '2026-10-09' };
const homeCompletedOctober8 = { ...completedOctober5, gameId: '2026020080', awayTeamId: 2,
  startTimeUTC: '2026-10-09T00:00:00Z', northAmericaDate: '2026-10-08' };
const projectedRows = [completedOctober5, scheduledOctober9, homeCompletedOctober8];
const completedOnly = nhlScheduleContext(futureTarget, projectedRows, { scheduleCoverage: futureCoverage });
assert.equal(completedOnly.away.restDays, 4); assert.equal(completedOnly.away.backToBack, false);
assert.equal(completedOnly.away.gamesIn7Days, 2); assert.equal(completedOnly.away.estimated, false);
const projected = nhlScheduleContext(futureTarget, projectedRows, { scheduleCoverage: futureCoverage, includeScheduled: true });
assert.equal(projected.away.restDays, 0); assert.equal(projected.away.backToBack, true);
assert.equal(projected.away.gamesIn7Days, 3); assert.equal(projected.away.estimated, true);
assert.deepEqual(projected.away.estimatedFields, ['restDays', 'backToBack', 'gamesIn7Days']);
assert.equal(projected.away.precedingGameId, scheduledOctober9.gameId);
assert.equal(projected.away.observedRestDays, 4); assert.equal(projected.away.observedGamesIn7Days, 2);
assert.equal(projected.home.restDays, 1); assert.equal(projected.home.estimated, false);
assert.equal(projected.estimated, true); assert.equal(projected.qa.status, 'WARNING');
assert.ok(projected.qa.warnings.includes('PROJECTED_SCHEDULE_CONTAINS_UNPLAYED_GAMES'));
// An explicit earlier asOf can use a known future schedule, but cannot count a
// later target or a game after the target as a preceding fixture.
const ahead = { ...scheduledOctober9, gameId: '2026020110', startTimeUTC: '2026-10-12T00:00:00Z', northAmericaDate: '2026-10-11' };
const earlierAsOf = nhlScheduleContext(futureTarget, [completedOctober5, scheduledOctober9, ahead], {
  scheduleCoverage: futureCoverage, includeScheduled: true, asOf: '2026-10-08T00:00:00Z',
});
assert.equal(earlierAsOf.away.restDays, 0); assert.equal(earlierAsOf.away.gamesIn7Days, 3);
const pre = nhlScheduleContext(futureTarget, [completedOctober5, { ...scheduledOctober9, status: 'PRE' }], { scheduleCoverage: futureCoverage, includeScheduled: true });
assert.equal(pre.away.backToBack, true); assert.equal(pre.away.estimated, true);
for (const patch of [{ status: 'CANCELED' }, { status: 'PPD' }, { status: 'SUSP' },
  { gameScheduleState: 'PPD' }, { gameScheduleState: 'SUSP' }, { gameScheduleState: 'CANCELED' },
  { gameScheduleState: 'UNKNOWN' }, { gameScheduleState: undefined }]) {
  const omitted = nhlScheduleContext(futureTarget, [completedOctober5, { ...scheduledOctober9, ...patch }], {
    scheduleCoverage: futureCoverage, includeScheduled: true,
  });
  assert.equal(omitted.away.restDays, 4, JSON.stringify(patch));
  assert.equal(omitted.away.gamesIn7Days, 2); assert.equal(omitted.away.estimated, false);
}
const duplicateScheduled = nhlScheduleContext(futureTarget, [completedOctober5, scheduledOctober9, scheduledOctober9], {
  scheduleCoverage: futureCoverage, includeScheduled: true,
});
assert.equal(duplicateScheduled.away.gamesIn7Days, 3);
for (const rows of [[{ ...scheduledOctober9, status: 'OFF' }, scheduledOctober9], [scheduledOctober9, { ...scheduledOctober9, status: 'OFF' }]]) {
  const completedWins = nhlScheduleContext(futureTarget, [completedOctober5, ...rows], { scheduleCoverage: futureCoverage, includeScheduled: true });
  assert.equal(completedWins.away.estimated, false); assert.equal(completedWins.away.gamesIn7Days, 3);
}
const coverageMissing = nhlScheduleContext(futureTarget, [completedOctober5, scheduledOctober9], { includeScheduled: true });
assert.equal(coverageMissing.away.restDays, null); assert.equal(coverageMissing.away.gamesIn7Days, null);
assert.equal(coverageMissing.away.estimated, true);
assert.ok(coverageMissing.qa.warnings.includes('PROJECTED_SCHEDULE_CONTAINS_UNPLAYED_GAMES'));
assert.equal(nhlScheduleContext(futureTarget, projectedRows, { includeScheduled: 'true' }).qa.status, 'BLOCK');

let runtimeFallbackCalls = 0;
const pollutedRuntime = { get: async () => ({ league: 'NHL', expiresAt: now + 10000, value: { league: 'NBA', games: ['wrong'] } }), set: async () => {} };
const fresh = await cachedNhlData('cross-review-runtime', async () => { runtimeFallbackCalls++; return { league: 'NHL', games: ['correct'] }; }, { runtime: pollutedRuntime, now, ttlMs: 1000 });
assert.equal(runtimeFallbackCalls, 1); assert.deepEqual(fresh.games, ['correct']); assert.equal(fresh.cache.expiresAt, now + 1000);
fresh.games[0] = 'mutated';
const retained = await cachedNhlData('cross-review-runtime', loader, { now: now + 500 });
assert.deepEqual(retained.games, ['correct']);
let expiryCalls = 0;
await cachedNhlData('cross-review-runtime', async () => { expiryCalls++; return { league: 'NHL', games: [] }; }, { now: now + 1001, runtime: null });
assert.equal(expiryCalls, 1);
const concurrent = await Promise.all([cachedNhlData('cross-review-clone', loader), cachedNhlData('cross-review-clone', loader)]);
concurrent[0].games[0].gameId = 'changed'; assert.equal(concurrent[1].games[0].gameId, game.gameId);
await assert.rejects(() => cachedNhlData('cross-review-bad-ttl', loader, { ttlMs: Infinity }), /INVALID_NHL_CACHE_OPTIONS/);
for (const invalid of [{ rawRows: undefined }, { rawRows: {} }, { observedAt: '2023-10-10T23:55:00' },
  { pageUrl: 'http://www1.tai888.in/' }, { pageUrl: 'https://user:pass@www1.tai888.in/' },
  { rawRows: [{ sourceRowId: 'r1', eventLabel: 'A B', marketLabel: 'raw', lineText: 'raw', settlementRuleText: '<script>' }] }]) {
  assert.equal(validateNhlCapture({ ...capture, ...invalid }, { now }).ok, false);
}
assert.equal(validateNhlCapture(capture, { now: NaN }).ok, false);
assert.equal(validateNhlObservation('READER', capture.boardDate, accepted.payload, { now }).ok, true);
assert.equal(validateNhlObservation('READER', '2023-10-12', accepted.payload, { now }).ok, false);
const gamePayload = { league: 'NHL', observedAt: new Date(now).toISOString(), game: { ...game, leagueId: 'NHL', season: 20232024, gameType: 2,
  source: { url: 'https://api-web.nhle.com/v1/gamecenter/2023020001/landing', contentHash: 'test-source' } } };
assert.equal(validateNhlObservation('GAME', game.gameId, gamePayload, { now }).ok, true);
assert.equal(validateNhlObservation('GAME', '2023020099', gamePayload, { now }).ok, false);
assert.equal(validateNhlObservation('GAME', game.gameId, { ...gamePayload, game: { ...gamePayload.game, league: 'NBA' } }, { now }).ok, false);
assert.equal(validateNhlObservation('GAME', game.gameId, { ...gamePayload, observedAt: '2023-10-10T23:55:00' }, { now }).ok, false);
console.log('NHL context: data absence, goalie chronology/identity, rest, cache isolation and non-executable Reader interface PASS');
