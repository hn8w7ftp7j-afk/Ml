import assert from 'node:assert/strict';
import { evaluateMlbLineupEligibilityV1 } from '../lib/mlb-lineup-eligibility-v1.js';
import { buildGameContextV13, hydrateLineupBattingV13, mergePartialOfficialV13, parseOfficialLineupV13, projectLineupV13 } from '../lib/mlb-context-v13.js';
import { sha256 } from '../lib/snapshot-v9.js';

const scope = { teamId: 1, officialDate: '2026-09-23', firstPitch: '2026-09-23T23:00:00Z', cutoffAt: '2026-09-23T20:00:00Z' };
const stat = { plateAppearances: 300, ops: 0.72, obp: 0.32, slg: 0.4 };
const batter = (id, battingOrder, withStats = true) => ({
  person: { id, fullName: `Player ${id}` }, battingOrder,
  position: { abbreviation: 'OF' }, ...(withStats ? { seasonStats: { batting: stat } } : {}),
});
const rosterRow = (id, code = 'A') => ({ person: { id, fullName: `Player ${id}` }, status: { code } });
const rosterResponse = (ids, rosterType = 'active', overrides = {}) => ({
  ok: true, statusCode: 200, sourceRecord: `https://statsapi.mlb.com/api/v1/teams/1/roster?rosterType=${rosterType}&date=${scope.officialDate}`,
  rawPayloadHash: 'a'.repeat(64), fetchedAt: '2026-09-23T19:59:00Z',
  data: { roster: ids.map(id => typeof id === 'object' ? id : rosterRow(id)) }, ...overrides,
});
const feed = (away, home = [], gamePk = 901, gameDate = '2026-09-22T23:00:00Z') => ({
  gamePk, gameData: { datetime: { dateTime: gameDate, officialDate: gameDate.slice(0, 10) }, teams: { away: { id: 1 }, home: { id: 2 } }, players: {} },
  liveData: { boxscore: { teams: {
    away: { players: Object.fromEntries(away.map(row => [`ID${row.person.id}`, row])), pitchers: [] },
    home: { players: Object.fromEntries(home.map(row => [`ID${row.person.id}`, row])), pitchers: [] },
  } } },
});
const hitters = (base = 100, withStats = true) => Array.from({ length: 9 }, (_, i) => batter(base + i, (i + 1) * 100, withStats));
const olderHitters = (base = 100, withStats = true) => [...hitters(base, withStats).slice(0, 8), batter(base + 9, 900, withStats)];
const history = [feed(hitters()), feed(olderHitters())];
const legalActive = rosterResponse(Array.from({ length: 9 }, (_, i) => 101 + i));
const ids = lineup => lineup.players.map(row => row.id);
const unchanged = projectLineupV13(history, 1, 0.72);
assert.ok(ids(unchanged).includes(100) && !ids(unchanged).includes(109));
const filtered = projectLineupV13(history, 1, 0.72, { ...scope, activeRosterResponse: legalActive });
assert.ok(!ids(filtered).includes(100) && ids(filtered).includes(109), 'filter all candidates before top nine so the eligible tenth candidate can fill the vacated place');
assert.equal(filtered.players.length, 9);
assert.equal(filtered.rosterEligibility.activeRosterStatus, 'VERIFIED_COMPLETE');
assert.deepEqual(filtered.rosterEligibility.excluded, [{ id: 100, reason: 'ABSENT_FROM_VERIFIED_GAME_DAY_ACTIVE_ROSTER' }]);
assert.equal(filtered.rosterEligibility.sourceReceipts[0].accepted, true);
assert.equal(filtered.identityStatus, 'PROJECTED');
assert.equal(filtered.offensiveIndex, 1);

for (const bad of [
  undefined,
  { ...legalActive, ok: false, statusCode: 503 },
  { ...legalActive, rawPayloadHash: null },
  { ...legalActive, sourceRecord: legalActive.sourceRecord.replace('/teams/1/', '/teams/2/') },
  { ...legalActive, sourceRecord: legalActive.sourceRecord.replace('2026-09-23', '2026-09-22') },
  { ...legalActive, sourceRecord: legalActive.sourceRecord.replace('rosterType=active', 'rosterType=40Man') },
  { ...legalActive, sourceRecord: legalActive.sourceRecord.replace('statsapi.mlb.com', 'example.com') },
  { ...legalActive, fetchedAt: '2026-09-23T20:00:01Z' },
  { ...legalActive, fetchedAt: '2026-09-23T19:59:00' },
  { ...legalActive, data: { teamId: 2, roster: legalActive.data.roster } },
  { ...legalActive, data: { roster: [...legalActive.data.roster, rosterRow(101)] } },
  { ...legalActive, data: { roster: [...legalActive.data.roster, rosterRow(-5)] } },
  rosterResponse([]), rosterResponse([101, 102, 103]),
]) {
  const result = projectLineupV13(history, 1, 0.72, { ...scope, activeRosterResponse: bad });
  assert.deepEqual(ids(result), ids(unchanged), 'missing, invalid, stale-scope or partial evidence cannot imply omitted hitters are ineligible');
  assert.equal(result.rosterEligibility.excluded.length, 0);
}
const late = projectLineupV13(history, 1, 0.72, { ...scope, cutoffAt: scope.firstPitch, activeRosterResponse: legalActive });
assert.deepEqual(ids(late), ids(unchanged), 'a roster read after first pitch cannot rewrite a pregame forecast');

const explicitIl = rosterResponse([rosterRow(100, 'D10'), rosterRow(500, 'A')], '40Man');
const injured = projectLineupV13(history, 1, 0.72, { ...scope, injuredRosterResponse: explicitIl });
assert.ok(!ids(injured).includes(100) && ids(injured).includes(109));
assert.equal(injured.rosterEligibility.excluded[0].reason, 'EXPLICIT_GAME_DAY_INJURED_LIST_MEMBERSHIP');
const noStatus = rosterResponse([{ person: { id: 100 } }], '40Man');
assert.deepEqual(ids(projectLineupV13(history, 1, 0.72, { ...scope, injuredRosterResponse: noStatus })), ids(unchanged), 'unknown status is not injury');
const contradictory = evaluateMlbLineupEligibilityV1({ ...scope, candidateIds: [100], activeRosterResponse: rosterResponse([100, ...Array.from({ length: 8 }, (_, i) => 101 + i)]), injuredRosterResponse: explicitIl });
assert.deepEqual(contradictory.membershipConflicts, [100]);
assert.deepEqual(contradictory.eligiblePlayerIds, [100], 'conflicting official roster observations stay unknown, not an invented injury conclusion');

const onlyFiveKnown = rosterResponse([105, 106, 107, 108, 109, 500, 501, 502, 503]);
const short = projectLineupV13(history, 1, 0.72, { ...scope, activeRosterResponse: onlyFiveKnown });
assert.equal(short.players.length, 5);
assert.equal(short.missingCoreCount, 4);
assert.equal(short.identityStatus, 'MISSING');
assert.equal(short.available, false, 'do not invent recent starts for unrelated roster names to fill nine slots');

const official = parseOfficialLineupV13(feed([batter(100, 400)]), 1, 0.72);
const merged = mergePartialOfficialV13(filtered, official, 0.72);
assert.equal(merged.players.find(row => row.id === 100).battingOrder, 400);
assert.deepEqual(merged.rosterEligibility.officialOverridePlayerIds, [100]);
assert.equal(new Set(merged.players.map(row => row.battingOrder)).size, 9);
const fullOfficial = parseOfficialLineupV13(feed(hitters()), 1, 0.72);
assert.equal(mergePartialOfficialV13(filtered, fullOfficial, 0.72), fullOfficial, 'a current complete official lineup has precedence over earlier roster evidence');
const names = projectLineupV13([feed(hitters(100, false)), feed(olderHitters(100, false))], 1, 0.72, { ...scope, activeRosterResponse: legalActive });
const hydrated = await hydrateLineupBattingV13(names, 1, 0.72, '2026-09-22', { fetchImpl: async () => Response.json({ stats: [{ splits: [{ stat }] }] }) });
assert.deepEqual(hydrated.rosterEligibility, names.rosterEligibility);
assert.deepEqual(ids(hydrated), ids(names));

// Integration exercises the real context construction, receipt validation,
// current lineup merge, candidate replacement, and side-specific source chain.
const firstPitch = new Date(Date.now() + 4 * 3600000).toISOString();
const officialDate = firstPitch.slice(0, 10);
const recentDate = new Date(Date.parse(firstPitch) - 86400000).toISOString();
const oldDate = new Date(Date.parse(firstPitch) - 2 * 86400000).toISOString();
const current = feed([batter(100, 400)], [], 900, firstPitch);
const feeds = new Map([[900, current], [901, feed(hitters(), hitters(200), 901, recentDate)], [902, feed(olderHitters(), olderHitters(200), 902, oldDate)]]);
const calls = [];
const contextGame = { gamePk: 900, leagueId: 'MLB', gameDate: firstPitch, officialDate,
  awayTeamId: 1, homeTeamId: 2, awayProbableId: 10, homeProbableId: 11, scheduledInnings: 9 };
const fixtureFetch = async input => {
    const url = new URL(input); calls.push(url);
    if (url.pathname.includes('/feed/live')) return Response.json(feeds.get(Number(url.pathname.split('/')[4])));
    if (url.pathname.endsWith('/roster')) {
      const team = Number(url.pathname.split('/')[4]);
      const base = team === 1 ? 100 : 200;
      return Response.json({ roster: url.searchParams.get('rosterType') === 'active'
        ? Array.from({ length: 9 }, (_, i) => rosterRow(base + i + 1)) : [rosterRow(base, 'D10')] });
    }
    if (url.pathname.endsWith('/schedule')) return Response.json({ dates: [{ games: [901, 902].map(id => ({
      gamePk: id, gameDate: id === 901 ? recentDate : oldDate, status: { abstractGameState: 'Final' },
      teams: { away: { team: { id: 1 }, score: 2 }, home: { team: { id: 2 }, score: 1 } },
    })) }] });
    if (url.searchParams.get('group') === 'hitting') return Response.json({ stats: [{ splits: [{ stat: { ...stat, gamesPlayed: 20, runs: 80 } }] }] });
    return Response.json({ stats: [{ splits: [] }] });
};
const context = await buildGameContextV13(contextGame, { fetchImpl: fixtureFetch });
assert.equal(context.away.lineup.players.find(row => row.id === 100).battingOrder, 400);
assert.deepEqual(context.away.lineup.rosterEligibility.officialOverridePlayerIds, [100]);
assert.ok(!ids(context.home.lineup).includes(200) && ids(context.home.lineup).includes(209));
assert.equal(context.home.lineup.rosterEligibility.activeRosterStatus, 'VERIFIED_COMPLETE');
const activeCalls = calls.filter(url => url.pathname.endsWith('/roster') && url.searchParams.get('rosterType') === 'active');
assert.equal(activeCalls.length, 2, 'eligibility and bullpen must share each already fetched active response');
for (const [side, team] of [['away', 1], ['home', 2]]) {
  const lineup = context[side].lineup;
  const ownRosterReceipts = lineup.sourceReceipts.filter(row => row.purpose === 'PROJECTED_LINEUP_CANDIDATE_ELIGIBILITY');
  assert.equal(ownRosterReceipts.length, 2);
  assert.ok(ownRosterReceipts.every(row => row.accepted && row.sourceRecord.includes(`/teams/${team}/roster`)));
  const provenance = context.featureProvenance.find(row => row.featureName === `${side}Lineup`);
  assert.ok(provenance.dependencyReceipts.some(row => row.sourceRecord.includes(`/teams/${team}/roster`) && row.rawPayloadHash));
  assert.ok(!provenance.dependencyReceipts.some(row => row.sourceRecord.includes(`/teams/${team === 1 ? 2 : 1}/roster`)), 'the opposing roster cannot become this lineup evidence');
  const decidingReceipts = lineup.sourceReceipts.filter(row => row.purpose !== 'PROJECTED_LINEUP_CANDIDATE_ELIGIBILITY' || row.accepted === true);
  assert.equal(provenance.rawPayloadHash, sha256(decidingReceipts.map(row => row.rawPayloadHash)), 'aggregate fingerprint binds accepted own-team roster decisions as well as the actual lineup feeds');
  assert.notEqual(provenance.rawPayloadHash, sha256(decidingReceipts.filter(row => row.purpose !== 'PROJECTED_LINEUP_CANDIDATE_ELIGIBILITY').map(row => row.rawPayloadHash)), 'roster deciding payloads cannot be omitted from the aggregate fingerprint');
}
feeds.set(900, feed(hitters(), [], 900, firstPitch));
const officialContext = await buildGameContextV13(contextGame, { fetchImpl: input => fixtureFetch(input) });
assert.equal(officialContext.away.lineup.official, true);
const officialProvenance = officialContext.featureProvenance.find(row => row.featureName === 'awayLineup');
assert.equal(officialProvenance.rawPayloadHash, sha256([officialContext.away.lineup.sourceReceipts[0].rawPayloadHash]), 'a complete current official lineup does not acquire historical or roster identity dependencies');
assert.ok(officialProvenance.dependencyReceipts.every(row => !row.sourceRecord.includes('/roster') && !/\/(901|902)\/feed\/live$/.test(row.sourceRecord)));
console.log(JSON.stringify({ ok: true, cases: [
  'filter_before_top_nine', 'source_team_date_receipt_guards', 'missing_partial_roster_no_absence_inference',
  'strict_pregame_cutoff', 'explicit_il_only', 'conflicting_membership_unknown', 'unfilled_slots_unknown',
  'official_current_lineup_precedence', 'hydration_preserves_diagnostics', 'context_roster_reuse_and_source_chain',
  'deciding_roster_payload_fingerprint', 'official_lineup_dependency_scope',
] }));
