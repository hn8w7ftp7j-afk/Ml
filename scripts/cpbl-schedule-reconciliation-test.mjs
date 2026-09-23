import assert from 'node:assert/strict';
import { buildAsianGameContext, parseCpblSchedulePayload, uniqueGames } from '../lib/asian-baseball.js';

const rawGame = (id, date, state, awayScore = 0, homeScore = 0) => ({
  GameId: `2026-A-${id}`, KindCode: 'A', PreExeDate: `${date}T18:35:00`,
  GameStatus: state, GameSno: id, InningSeq: state === 'FINISHED' ? 9 : 1,
  Visiting: { Team: { Code: 'AJL011' }, Score: awayScore },
  Home: { Team: { Code: 'AAA011' }, Score: homeScore }, Field: { Abbe: '天母' },
});
const parse = rows => parseCpblSchedulePayload({ Data: { Games: rows } });

// Minimal fixtures reproduce the actual August/September 2026 calendar bug:
// the same official IDs remained POSTPONED in August after moving to September.
const septemberRaw = [
  rawGame(280, '2026-09-14', 'FINISHED', 2, 1),
  rawGame(282, '2026-09-15', 'FINISHED', 3, 0),
  rawGame(287, '2026-09-22', 'FINISHED', 13, 1),
  rawGame(254, '2026-09-30', 'SCHEDULED'),
  rawGame(255, '2026-09-30', 'SCHEDULED'),
];
const augustRaw = [
  rawGame(280, '2026-08-22', 'POSTPONED'),
  rawGame(282, '2026-08-22', 'POSTPONED'),
  rawGame(287, '2026-08-25', 'POSTPONED'),
  rawGame(254, '2026-08-09', 'POSTPONED'),
  rawGame(255, '2026-08-09', 'POSTPONED'),
];
const september = parse(septemberRaw);
const august = parse(augustRaw);
const source = [...september, ...august];
const original = structuredClone(source);
const reconciled = uniqueGames(source);
assert.equal(reconciled.length, 5);
assert.deepEqual(reconciled, uniqueGames([...source].reverse()), 'calendar request/input ordering cannot decide the retained game');
assert.deepEqual(source, original, 'the raw normalized source observations remain immutable');
for (const expected of september) {
  const game = reconciled.find(row => row.gamePk === expected.gamePk);
  assert.equal(game.statusCode, expected.statusCode);
  assert.equal(game.gameDate, expected.gameDate);
  assert.equal(game.awayScore, expected.awayScore);
  assert.equal(game.homeScore, expected.homeScore);
  assert.equal(game.scheduleReconciliation.observations.length, 2);
  assert.ok(game.scheduleReconciliation.observations.some(row => row.statusCode === 'D'));
}
assert.deepEqual(parse([...septemberRaw, ...augustRaw]), reconciled, 'single-response and cross-month reconciliation follow one contract');
assert.deepEqual(uniqueGames([...reconciled, ...august]), reconciled, 'repeated reconciliation retains the same source alternatives');

const final = september[0];
const checkConflict = (other, code) => {
  for (const pair of [[final, other], [other, final]]) {
    assert.throws(() => uniqueGames(pair), error => error.code === code && error.gamePk === final.gamePk && error.scheduleObservations.length === 2);
  }
};
checkConflict({ ...final, awayScore: 9 }, 'CPBL_SCHEDULE_FINAL_CONFLICT');
checkConflict({ ...final, gameDate: '2026-09-15T10:35:00.000Z', officialDate: '2026-09-15' }, 'CPBL_SCHEDULE_FINAL_CONFLICT');
checkConflict({ ...final, innings: 10 }, 'CPBL_SCHEDULE_FINAL_CONFLICT');
checkConflict({ ...final, homeTeamId: 999 }, 'CPBL_SCHEDULE_IDENTITY_CONFLICT');
checkConflict({ ...final, providerGameId: '2026-A-999' }, 'CPBL_SCHEDULE_IDENTITY_CONFLICT');
assert.equal(uniqueGames([final, structuredClone(final)]).length, 1);
const missingScore = { ...final, awayScore: null, homeScore: null };
assert.equal(uniqueGames([final, missingScore])[0].awayScore, 2, 'a missing final score does not erase a known score');
assert.equal(uniqueGames([missingScore, final])[0].homeScore, 1);
const zeroFinal = { ...final, awayScore: 0, homeScore: 0 };
assert.equal(uniqueGames([missingScore, zeroFinal])[0].awayScore, 0, 'genuine final zeroes remain observed data');

const scheduled = september.find(row => row.statusCode === 'S');
const postponedSameTime = { ...scheduled, statusCode: 'D', statusEnglish: 'POSTPONED' };
assert.equal(uniqueGames([scheduled, postponedSameTime])[0].statusCode, 'D', 'same-date explicit postponement supersedes the scheduled placeholder');
assert.equal(uniqueGames([postponedSameTime, scheduled])[0].statusCode, 'D');
const liveSameTime = { ...scheduled, statusCode: 'I', statusEnglish: 'IN PROGRESS' };
assert.equal(uniqueGames([scheduled, liveSameTime])[0].statusCode, 'I');
assert.throws(() => uniqueGames([postponedSameTime, liveSameTime]), error => error.code === 'CPBL_SCHEDULE_STATE_CONFLICT');
assert.throws(() => uniqueGames([liveSameTime, postponedSameTime]), error => error.code === 'CPBL_SCHEDULE_STATE_CONFLICT');
assert.equal(uniqueGames([final, { ...final, league: 'NPB', leagueId: 'NPB' }]).length, 2, 'league namespace isolates coincident numeric game IDs');

// Full context boundary: fetch current, prior, and preceding month in production
// order, then verify all three recovered finals enter the actual history input.
// Future schedules and postponed placeholder zeroes must stay out of the baseline.
const target = parse([rawGame(400, '2026-09-23', 'SCHEDULED')])[0];
const requests = [];
const context = await buildAsianGameContext('CPBL', target, {
  productionFeatures: false,
  fetchImpl: async input => {
    const url = new URL(input);
    assert.equal(url.pathname, '/api/proxy/v1/games/schedule');
    const month = Number(url.searchParams.get('month'));
    requests.push(month);
    return Response.json({ Data: { Games: month === 9 ? septemberRaw : month === 8 ? augustRaw : [] } });
  },
});
assert.deepEqual(requests, [9, 8, 7]);
const history = context.sourceEvidence.features.find(row => row.featureName === 'history').parsedInput;
assert.equal(history.length, 3);
assert.ok(history.every(row => row.statusCode === 'F' && row.officialDate.startsWith('2026-09-')));
assert.equal(context.away.seasonHitting.gamesPlayed, 3);
assert.equal(context.home.seasonHitting.gamesPlayed, 3);
assert.equal(context.away.seasonHitting.runsPerGame, 6);
assert.ok(history.every(row => row.scheduleReconciliation.observations.length === 2));
const replayContext = await buildAsianGameContext('CPBL', target, { historyGames: source, productionFeatures: false });
assert.equal(replayContext.away.seasonHitting.gamesPlayed, 3, 'supplied historical replay rows use the same CPBL reconciliation');
const earlierTarget = parse([rawGame(399, '2026-09-10', 'SCHEDULED')])[0];
const earlierContext = await buildAsianGameContext('CPBL', earlierTarget, { historyGames: source, productionFeatures: false });
assert.equal(earlierContext.sourceEvidence.features.find(row => row.featureName === 'history').parsedInput.length, 0,
  'recovered September finals cannot be backdated to their August postponements or leak through an earlier cutoff');
await assert.rejects(buildAsianGameContext('CPBL', target, {
  historyGames: [final, { ...final, awayScore: 99 }], productionFeatures: false,
}), error => error.code === 'CPBL_SCHEDULE_FINAL_CONFLICT');

console.log(JSON.stringify({ ok: true, cases: [
  'three_cross_month_finals_recovered', 'two_future_reschedules_preserved',
  'permutation_invariance', 'source_alternatives_retained', 'idempotence',
  'conflicting_finals_rejected', 'team_and_provider_identity_guard', 'zero_vs_missing',
  'same_date_explicit_state', 'cross_league_namespace', 'production_month_fetch_to_history',
  'history_replay_reconciliation', 'rescheduled_finals_respect_temporal_cutoff',
] }));
