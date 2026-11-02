import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeStatsBombMatchXg, fitMatchXgResearch, predictMatchXgResearch, matchXgResearchForGame, matchXgHash, MATCH_XG_VERSION } from '../lib/soccer/match-xg.js';

// These intentionally invented records test schema/math only. Actual provider
// documents and shot values are not redistributed with the repository.
const now = Date.parse('2027-01-01T00:00:00Z'), pin = '1'.repeat(40);
const source = (data, part) => { const text = JSON.stringify(data); return { text, source: { provider: 'STATSBOMB_OPEN_DATA',
  url: `https://raw.githubusercontent.com/statsbomb/open-data/${pin}/data/${part}`, fetchedAt: '2026-11-02T00:00:00Z',
  contentHash: createHash('sha256').update(text).digest('hex') } }; };
const game = { match_id: 1, match_date: '2015-12-01', competition: { competition_id: 2 }, season: { season_id: 27, season_name: 'SYNTHETIC_UNIT_TEST_ONLY' },
  home_team: { home_team_id: 10, home_team_name: 'Synthetic Home' }, away_team: { away_team_id: 20, away_team_name: 'Synthetic Away' }, match_status: 'available' };
const shot = (id, period, team, xg, penalty = false, extra = {}) => ({ id, period, minute: period === 1 ? 46 : 70, team: { id: team },
  type: { id: 16, name: 'Shot' }, location: [100, 35], play_pattern: { name: 'Regular Play' }, shot: { statsbomb_xg: xg,
    type: { id: penalty ? 88 : 87, name: penalty ? 'Penalty' : 'Open Play' }, body_part: { name: 'Head' }, outcome: { name: 'Saved' } }, ...extra });
const events = [shot('shot-1', 1, 10, .25), shot('shot-2', 1, 20, .8, true), shot('shot-3', 2, 10, .1),
  shot('extra-time', 3, 20, .9), shot('shootout', 5, 10, .9, true), { id: 'half-end-1', period: 1, type: { id: 34, name: 'Half End' } },
  { id: 'half-end-2', period: 2, type: { id: 34, name: 'Half End' } }, { id: 'own-goal', period: 2, type: { id: 25, name: 'Own Goal Against' } }];
const normalize = (g = game, e = events, mutate = value => value) => normalizeStatsBombMatchXg(mutate({ matchId: g.match_id,
  matchesDocument: source([g], 'matches/2/27.json'), eventsDocument: source(e, `events/${g.match_id}.json`), now }));
const actual = normalize(); assert.equal(actual.ok, true);
assert.equal(actual.shots.length, 3, 'ET and shootout shots must not enter regulation xG');
assert.equal(actual.periods.FT.home.xg, .35); assert.equal(actual.periods.HT.home.xg, .25, 'provider period controls HT, including minute46');
assert.equal(actual.periods.FT.away.xg, .8); assert.equal(actual.periods.FT.away.npxg, 0); assert.equal(actual.periods.FT.away.penaltyXg, .8);
assert.equal(actual.periods.FT.home.headedXg, .35); assert.equal(actual.periods.FT.home.shotGoals, 0, 'own goals are not shots or xG');
const outside = normalize(game, events.map(row => row.id === 'shot-1' ? { ...row, location: [120.2, 1] } : row));
assert.equal(outside.ok, true, 'actual provider corner coordinates may lie slightly outside nominal pitch; do not discard valid provider xG');
assert.equal(outside.shots.find(row => row.id === 'shot-1').locationInNominalPitch, false);
assert.equal(outside.periods.FT.home.npxg, .35);
assert.equal(actual.historicalAvailabilityVerified, false); assert.equal(actual.formalEligible, false);
for (const mutate of [
  value => { value.eventsDocument.text += ' '; },
  value => { value.eventsDocument.source.url = value.eventsDocument.source.url.replace(pin, '2'.repeat(40)); },
  value => { value.eventsDocument.source.url = value.eventsDocument.source.url.replace('/events/1.json', '/events/2.json'); },
  value => { value.eventsDocument.source.url = value.eventsDocument.source.url.replace(pin, 'master'); },
  value => { value.eventsDocument.source.fetchedAt = '2028-01-01T00:00:00Z'; },
  value => { value.eventsDocument.source.fetchedAt = '2026-11-02T00:00:00'; },
]) assert.equal(normalize(game, events, value => { mutate(value); return value; }).ok, false);
for (const e of [
  [...events, events[0]], events.filter(row => row.id !== 'half-end-2'),
  events.map(row => row.id === 'shot-1' ? shot('shot-1', 1, 30, .25) : row),
  events.map(row => row.id === 'shot-1' ? shot('shot-1', 1, 10, 1.2) : row),
  events.map(row => row.id === 'shot-2' ? { ...row, shot: { ...row.shot, type: { id: 88, name: 'Open Play' } } } : row),
  events.map(row => row.id === 'shot-1' ? { ...row, shot: { ...row.shot, statsbomb_xg: undefined } } : row),
]) assert.equal(normalize(game, e).ok, false);
assert.equal(normalize({ ...game, match_date: '2015-02-30' }).ok, false);
const observations = Array.from({ length: 30 }, (_, i) => {
  const matchDate = i < 10 ? `2015-12-${String(i + 1).padStart(2, '0')}` : i < 20 ? `2016-02-${String(i - 9).padStart(2, '0')}` : `2016-04-${String(i - 19).padStart(2, '0')}`;
  return normalize({ ...game, match_id: i + 1, match_date: matchDate }, events.map(row => ({ ...row, id: `${row.id}-${i}` })));
});
const corrupt = structuredClone(observations); corrupt[0].periods.FT.home.npxg = -1; delete corrupt[0].contentHash; corrupt[0].contentHash = matchXgHash(corrupt[0]);
assert.throws(() => fitMatchXgResearch(corrupt), /OBSERVATION_INVALID/);
const report = fitMatchXgResearch(observations);
assert.equal(report.training.games, 10); assert.equal(report.calibration.games, 10); assert.equal(report.test.games, 10);
assert.equal(report.model.trainingMatches, 10); assert.equal(report.accepted, false); assert.equal(report.R, null);
const changed = structuredClone(observations);
for (const row of changed.filter(row => row.matchDate >= '2016-03-01')) { row.periods.FT.home.npxg += 10; row.periods.FT.home.xg += 10; delete row.contentHash; row.contentHash = matchXgHash(row); }
const alternative = fitMatchXgResearch(changed);
assert.deepEqual(alternative.model, report.model, 'holdout outcomes never change fitted parameters');
assert.notEqual(alternative.test.candidate.mse, report.test.candidate.mse);
const empty = fitMatchXgResearch(observations, { trainingBefore: '2017-01-01', testBegins: '2017-03-01' });
for (const key of ['calibration', 'test']) { assert.equal(empty[key].games, 0); assert.equal(empty[key].candidate.mae, null); assert.equal(empty[key].candidate.mse, null); }
assert.throws(() => predictMatchXgResearch(report.model, { homeProviderId: '10', awayProviderId: '20', matchDate: '2015-12-01' }), /SCOPE/);
const cold = predictMatchXgResearch(report.model, { homeProviderId: '99', awayProviderId: '20', matchDate: '2016-04-01' });
assert.deepEqual(cold.coldStartTeams, ['99']); assert.equal(cold.formalEligible, false);
const prior4 = fitMatchXgResearch(observations, { priorGames: 4 });
assert.equal(prior4.protocol.priorGames, 4); assert.equal(prior4.protocol.parameterSelection, 'EXPLICIT_PRIOR_GAMES_NO_HOLDOUT_TUNING');
const aggregate = { ...report }; delete aggregate.model; delete aggregate.contentHash; aggregate.contentHash = matchXgHash(aggregate);
const artifact = { version: MATCH_XG_VERSION, provider: 'STATSBOMB_OPEN_DATA', createdAt: '2026-11-02T00:00:00Z', reports: { epl: { FT: aggregate } } };
artifact.contentHash = matchXgHash(artifact);
const live = matchXgResearchForGame({ id: 'soccer:epl:900', league: 'epl' }, artifact, { now });
assert.equal(live.status, 'UNKNOWN'); assert.equal(live.ok, false); assert.equal(live.researchAvailable, true); assert.equal(live.formalEligible, false);
assert.equal(matchXgResearchForGame({ league: 'ucl' }, artifact, { now }).researchAvailable, false);
assert.equal(matchXgResearchForGame({ league: 'epl' }, artifact, { now: Date.parse('2026-11-01T00:00:00Z') }).reason, 'MATCH_XG_ARTIFACT_UNAVAILABLE_AT_CUTOFF');
assert.equal(matchXgResearchForGame({ league: 'epl' }, { ...artifact, createdAt: '2025-01-01T00:00:00Z' }, { now }).researchAvailable, false);
if (fs.existsSync('lib/soccer/match-xg-frozen.js')) {
  const { soccerMatchXgArtifacts } = await import('../lib/soccer/match-xg-frozen.js');
  const shipped = soccerMatchXgArtifacts(); assert.equal(shipped.collection.availableIndexGames, 380);
  assert.equal(shipped.reports.epl.FT.model, undefined, 'provider/team statistics and fitted coefficients are not publicly redistributed');
  assert.equal(shipped.reports.epl.FT.test.games > 0, true); assert.equal(shipped.formalEligible, false);
  assert.equal(matchXgResearchForGame({ league: 'epl' }, shipped, { now }).researchAvailable, true);
}
console.log('PASS match xG: explicit synthetic extraction/penalty/period/ET/source/time/conflict tests, whole-date chronological fit and no test leakage, cold starts, empty-split null metrics, no current-season/UCL/acceptance fabrication; public artifact contains aggregate analysis only');
