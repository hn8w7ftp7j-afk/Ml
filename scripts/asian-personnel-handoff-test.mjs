import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAsianGameContext, parseNpbMonthHtml } from '../lib/asian-baseball.js';
import { parseNpbGameDetailHtml, parseKboGameListPayload, projectedLineup,
  parseCpblGameDetailPayload, projectCpblRotationStarter, starterSnapshot } from '../lib/asian-production-features-v1.js';

const fixture = name => fs.readFileSync(new URL(`../fixtures/personnel-integrity/${name}`, import.meta.url), 'utf8');
const calendar = parseNpbMonthHtml(fixture('npb-calendar-2026-09.html'), 2026, 9);
const npbGame = calendar.find(row => row.providerGameId === 's2026090101406');
assert.deepEqual([npbGame.awayCode, npbGame.homeCode, npbGame.awayScore, npbGame.homeScore], ['HAN', 'YAK', 6, 2]);
const npbDetail = parseNpbGameDetailHtml(fixture('npb-s2026090101406-en.html'));
assert.deepEqual([npbDetail.away.teamCode, npbDetail.home.teamCode], ['HAN', 'YAK']);
const line = projectedLineup([{ game: npbGame, detail: npbDetail }], npbGame.awayTeamId, 'NPB');
assert.equal(line.lineupComplete, true);
assert.equal(line.battingOrderComplete, true);
assert.equal(line.battingOrderStatus, 'HISTORICAL_ORDER_PROJECTED');
assert.equal(line.official, false);
assert.equal(line.players[8].name, 'Takahashi');
assert.deepEqual(line.players.map(row => row.order), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.equal(line.players.some(row => row.name === 'Sakamoto'), false, 'pinch hitter is not an initial slot');
for (const modified of [npbDetail.away.lineup.slice(0, 8), npbDetail.away.lineup.map(({ order, ...row }) => row)]) {
  const projected = projectedLineup([{ game: npbGame, detail: { away: { lineup: modified } } }], npbGame.awayTeamId, 'NPB');
  assert.equal(projected.battingOrderComplete, false);
  assert.equal(projected.battingOrderStatus, 'INCOMPLETE_OR_UNVERIFIED_ORDER');
  assert.ok(projected.incompleteReasons.includes('BATTING_ORDER_NOT_FULLY_VERIFIED'));
  if (modified.length === 8) {
    assert.equal(projected.lineupComplete, false);
    assert.ok(projected.incompleteReasons.includes('NINE_STARTING_SLOTS_NOT_AVAILABLE'));
  }
}

const kbo = JSON.parse(fixture('kbo-daily-20260918.json'));
const actual = kbo.game[0];
assert.equal(parseKboGameListPayload(kbo, actual.G_ID, actual.AWAY_ID, actual.HOME_ID), actual);
// Derived doubleheader regression: official payload shape, distinct synthetic
// same-day G_ID suffixes and starters, second game requested after first row.
const first = { ...actual, G_ID: '20990918WOOB1', HEADER_NO: 1, T_PIT_P_ID: 111 };
const second = { ...actual, G_ID: '20990918WOOB2', HEADER_NO: 2, T_PIT_P_ID: 222 };
for (const game of [[first, second], [second, first]]) {
  const payload = { game };
  assert.equal(parseKboGameListPayload(payload, second.G_ID, 'KIW', 'DOO'), second);
  assert.equal(parseKboGameListPayload(payload, '', 'KIW', 'DOO'), null, 'ambiguous team match cannot choose a game');
  assert.equal(parseKboGameListPayload(payload, '20990918WOOB3', 'KIW', 'DOO'), null, 'missing explicit ID cannot downgrade to other game');
  assert.equal(parseKboGameListPayload(payload, second.G_ID, 'KIA', 'DOO'), null, 'exact ID with wrong teams must reject');
}
assert.equal(parseKboGameListPayload({ game: [first] }, '', 'KIW', 'DOO'), first);
assert.equal(parseKboGameListPayload({ game: [first, first] }, first.G_ID, 'KIW', 'DOO'), null);

// Two real individual ability rows are placed in a synthetic same-team history
// to test handoff independently of roster assignment. This does not assert that
// these opposing pitchers actually shared a club or activate a new distribution.
const cpbl = parseCpblGameDetailPayload(JSON.parse(fixture('cpbl-2026-A-317.json')));
const realPitchers = [cpbl.away.pitchers.find(p => p.starter), cpbl.home.pitchers.find(p => p.starter)];
assert.ok(realPitchers.every(p => p?.id && p.inningsPitched > 0 && p.battersFaced > 0));
const historyDetails = realPitchers.map((pitcher, index) => ({
  game: { gamePk: 100 + index, gameDate: `2026-09-${index ? '02' : '03'}T10:00:00Z`, awayTeamId: 701, homeTeamId: 702 },
  detail: { away: { pitchers: [pitcher] }, home: { pitchers: [] } },
}));
const projected = projectCpblRotationStarter(historyDetails, 701, '2026-09-08T10:00:00Z');
assert.equal(projected.candidates.length, 2);
assert.ok(Math.abs(projected.candidates.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-12);
for (const candidate of projected.candidates) {
  const own = realPitchers.find(row => row.id === candidate.id);
  assert.equal(candidate.inningsPitched, own.inningsPitched);
  assert.equal(candidate.expectedInnings, own.inningsPitched);
  assert.equal(candidate.era, own.earnedRuns * 9 / own.inningsPitched);
}
const game = { league: 'CPBL', leagueId: 'CPBL', gamePk: 999701, providerGameId: '2099-A-999',
  gameDate: '2099-09-08T10:00:00Z', officialDate: '2099-09-08', taipeiDate: '2099-09-08',
  awayCode: 'CTB', homeCode: 'UNI', awayTeamId: 701, homeTeamId: 702,
  statusCode: 'S', gameNumber: 1, scheduledInnings: 9,
  awayProbableId: projected.id, awayProbable: projected.name, probableSource: projected.source };
const starter = starterSnapshot({ leagueId: 'CPBL', game, side: 'away', identity: projected,
  stats: { era: 4, whip: 1.2, battersFaced: 100, inningsPitched: 24 }, referenceEra: 4,
  recentStarts: [{ inningsPitched: 6 }] });
const features = { asOf: '2099-09-08T08:00:00Z', away: { starter }, home: {}, rules: {} };
const history = Array.from({ length: 12 }, (_, index) => ({ ...game,
  providerGameId: `2099-A-${index + 1}`, gamePk: 200 + index, statusCode: 'F',
  gameDate: `2099-08-${String(index + 1).padStart(2, '0')}T10:00:00Z`,
  officialDate: `2099-08-${String(index + 1).padStart(2, '0')}`, awayScore: 3, homeScore: 4 }));
const contextFor = featureSnapshot => buildAsianGameContext('CPBL', game, { historyGames: history, featureSnapshot });
const context = await contextFor(features);
assert.equal(context.away.starter.confirmed, false);
assert.equal(context.away.starter.identityConfirmed, false);
assert.equal(context.away.starter.projected, true);
assert.equal(context.away.starter.candidateMixtureReady, true);
assert.equal(context.away.starter.projectionMode, 'OFFICIAL_PRIOR_START_ROTATION_MIXTURE');
assert.equal(context.away.starter.uncertaintyExpanded, false);
assert.equal(context.away.starter.probabilityScope, 'CONDITIONAL_ON_OBSERVED_CANDIDATE_SET');
assert.equal(context.away.starter.candidateSetComplete, false);
assert.equal(context.away.starter.candidateNormalization.applied, true);
assert.equal(context.away.starter.candidateNormalization.sourcePrimary.qualityFactor, starter.qualityFactor);
assert.equal(context.away.starter.candidateNormalization.output.qualityFactor, context.away.starter.qualityFactor);
assert.equal(context.away.starter.candidateNormalization.output.expectedInnings, context.away.starter.expectedInnings);
for (const candidate of context.away.starter.candidates) {
  assert.ok(candidate.qualityFactor > 0);
  const expected = projected.candidates.find(row => row.id === candidate.id);
  assert.equal(candidate.era, expected.era);
  assert.equal(candidate.expectedInnings, expected.expectedInnings);
  assert.equal(candidate.probability, expected.probability);
}
const weighted = context.away.starter.candidates.reduce((sum, row) => sum + row.probability * row.qualityFactor, 0);
assert.ok(Math.abs(context.away.starter.qualityFactor - Math.max(.82, Math.min(1.22, weighted))) < 1e-12);
const incomplete = structuredClone(features);
incomplete.away.starter.candidates[1].era = null;
const partial = await contextFor(incomplete);
assert.equal(partial.away.starter.candidateMixtureReady, false);
assert.equal(partial.away.starter.candidates.length, 2, 'unknown ability does not erase candidate mass');
assert.equal(partial.away.starter.candidates[1].qualityFactor, null);
assert.equal(partial.away.starter.candidates[1].probability, projected.candidates[1].probability);
assert.equal(partial.away.starter.qualityFactor, starter.qualityFactor, 'incomplete mixture retains measured primary ability instead of inventing candidate ability');
assert.equal(partial.away.starter.candidateAbilityStatus, 'INCOMPLETE_CANDIDATE_ABILITIES_NOT_AGGREGATED');
assert.equal(partial.away.starter.candidateNormalization.applied, false);
assert.equal(partial.away.starter.candidateNormalization.missingAbilitiesReplaced, false);
const missingInnings = structuredClone(features);
missingInnings.away.starter.candidates[1].expectedInnings = null;
assert.equal((await contextFor(missingInnings)).away.starter.candidateMixtureReady, false);
const unverifiedIdentity = structuredClone(features);
unverifiedIdentity.away.starter.playerIdentityVerified = false;
unverifiedIdentity.away.starter.identityConfirmed = false;
delete unverifiedIdentity.away.starter.candidates;
const rejectedPrimary = (await contextFor(unverifiedIdentity)).away.starter;
assert.equal(rejectedPrimary.performanceAvailable, false, 'rejected primary stats cannot relabel neutral inputs as observed performance');
assert.equal(rejectedPrimary.projectionMode, 'LEAGUE_NEUTRAL_ROTATION_SCENARIO');
assert.equal(rejectedPrimary.candidateNormalization.sourcePrimary.qualityFactor, starter.qualityFactor);
assert.equal(rejectedPrimary.candidateNormalization.applied, false);
console.log('Asian personnel handoff: official fixtures, exact KBO ID, lineup completeness and candidate abilities PASS');
export { context, features, starter, partial };
