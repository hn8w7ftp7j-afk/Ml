import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAnalysisDataAudit } from '../lib/analysis-data-audit-v1.js';
import { asianLeagueConfig, buildAsianGameContext, parseNpbMonthHtml } from '../lib/asian-baseball.js';
import { buildAsianProductionFeatureSnapshot, officialStarterIdentitySnapshot, starterSnapshot } from '../lib/asian-production-features-v1.js';

const fixture = name => fs.readFileSync(new URL(`../fixtures/personnel-integrity/${name}`, import.meta.url), 'utf8');
const prior = parseNpbMonthHtml(fixture('npb-calendar-2026-09.html'), 2026, 9)
  .find(row => row.providerGameId === 's2026090101406');
assert.ok(prior);
const detail = fixture('npb-s2026090101406-en.html');
// A synthetic target with explicit announced identities tests precedence against
// real archived prior starters. It is not a historical forecasting accuracy claim.
const receipt = { url: 'https://npb.jp/announcement/starter/', fetchedAt: '2026-09-07T07:00:00Z', rawPayloadHash: 'synthetic-receipt' };
const game = { ...prior, gamePk: 999601, providerGameId: 'synthetic-official-starter-target',
  gameDate: '2026-09-07T09:00:00Z', officialDate: '2026-09-07', taipeiDate: '2026-09-07',
  statusCode: 'S', awayScore: null, homeScore: null,
  awayProbableId: '999991', homeProbableId: '999992',
  awayProbable: 'Official away announced', homeProbable: 'Official home announced',
  probableSource: 'NPB_OFFICIAL_PROBABLE_STARTER', identitySourceEvidence: receipt };
const fetchImpl = async url => new Response(String(url).endsWith('/s2026090101406.html') ? detail : '');
const known = (await buildAsianProductionFeatureSnapshot({ leagueId: 'NPB', game, history: [prior], fetchImpl })).featureSnapshot;
assert.equal(known.pipelineError, undefined);
for (const side of ['away', 'home']) {
  const starter = known[side].starter;
  assert.equal(starter.id, game[`${side}ProbableId`]);
  assert.equal(starter.name, game[`${side}Probable`]);
  assert.equal(starter.confirmed, true);
  assert.equal(starter.identityConfirmed, true);
  assert.equal(starter.projected, false);
  assert.equal(starter.assignmentStatus, 'OFFICIAL_CONFIRMED');
  assert.equal(starter.performanceAvailable, false);
  assert.equal(starter.performanceScope, 'UNAVAILABLE');
  assert.equal(starter.qualityFactor, null);
  assert.equal(starter.expectedInnings, null);
  assert.deepEqual(starter.candidates, []);
  assert.deepEqual(starter.scheduleIdentitySourceEvidence, receipt);
}
const unknownGame = { ...game, awayProbableId: null, homeProbableId: null,
  awayProbable: null, homeProbable: null, probableSource: null };
const unknown = (await buildAsianProductionFeatureSnapshot({ leagueId: 'NPB', game: unknownGame, history: [prior], fetchImpl })).featureSnapshot;
for (const side of ['away', 'home']) {
  assert.ok(unknown[side].starter.candidates.length > 0, 'unknown assignment still uses actual prior pitchers');
  assert.ok(unknown[side].starter.candidates.every(row => row.name && row.name !== game[`${side}Probable`]));
}

const identity = { id: game.awayProbableId, name: game.awayProbable, source: game.probableSource, sourceEvidence: receipt };
assert.deepEqual(officialStarterIdentitySnapshot({ game, side: 'away', identity }).sourceEvidence, receipt);
assert.equal(officialStarterIdentitySnapshot({ game, side: 'away', identity: { ...identity, id: null } }).id, null);
for (const id of [null, undefined, 0, '0', -1, 'invalid']) {
  assert.equal(officialStarterIdentitySnapshot({ game, side: 'away', identity: {
    ...identity, id, source: 'KBO_OFFICIAL_GAMECENTER_STARTER',
  } }), null, 'a missing or invalid KBO player ID is not a confirmed assignment');
}
for (const rejected of [null, { ...identity, projected: true }, { ...identity, officialAssignmentConfirmed: false },
  { ...identity, source: 'CPBL_OFFICIAL_ROTATION_PROJECTED_STARTER' }]) {
  assert.equal(officialStarterIdentitySnapshot({ game, side: 'away', identity: rejected }), null);
}

// Synthetic completed team history supplies the existing minimum team baseline;
// no source performance is added for either announced pitcher.
const history = Array.from({ length: 12 }, (_, index) => ({ ...prior,
  gamePk: 7000 + index, providerGameId: `synthetic-completed-${index}`,
  gameDate: `2026-08-${String(index + 1).padStart(2, '0')}T09:00:00Z`,
  officialDate: `2026-08-${String(index + 1).padStart(2, '0')}`, statusCode: 'F' }));
const context = await buildAsianGameContext('NPB', game, { historyGames: history, featureSnapshot: known });
for (const side of ['away', 'home']) {
  const row = buildAnalysisDataAudit(context).rows.find(item => item.key === `${side}.starter`);
  assert.equal(row.assignmentEvidence.status, 'OFFICIAL_REPORTED', 'NPB official probable-source name must not override explicit confirmed assignment');
  assert.equal(row.measurementEvidence.status, 'missing', 'confirmed assignment does not invent observed pitching ability');
}
const contradictory = structuredClone(context);
contradictory.away.starter.projected = true;
assert.equal(buildAnalysisDataAudit(contradictory).rows.find(row => row.key === 'away.starter').assignmentEvidence.status, 'PROJECTED');
for (const side of ['away', 'home']) {
  const starter = context[side].starter;
  assert.equal(starter.id, game[`${side}ProbableId`]);
  assert.equal(starter.name, game[`${side}Probable`]);
  assert.equal(starter.confirmed, true);
  assert.equal(starter.identityConfirmed, true);
  assert.equal(starter.projected, false);
  assert.equal(starter.performanceAvailable, false);
  assert.equal(starter.performanceProjected, true);
  assert.equal(starter.qualityFactor, 1);
  assert.equal(starter.expectedInnings, asianLeagueConfig('NPB').modelConfig.neutralStarterInnings);
  assert.equal(starter.projectionMode, 'OFFICIAL_ASSIGNMENT_NEUTRAL_PERFORMANCE');
  assert.deepEqual(starter.candidates, []);
  assert.deepEqual(starter.scheduleIdentitySourceEvidence, receipt);
}
assert.equal(context.sourceStatuses.starterAssignments, '客：官方當場先發／主：官方當場先發');
const staleMixture = structuredClone(known);
staleMixture.away.starter.candidates = unknown.away.starter.candidates;
assert.deepEqual((await buildAsianGameContext('NPB', game, { historyGames: history, featureSnapshot: staleMixture })).away.starter.candidates, []);
const projected = await buildAsianGameContext('NPB', unknownGame, { historyGames: history, featureSnapshot: unknown });
assert.equal(projected.away.starter.projected, true);
assert.equal(projected.away.starter.confirmed, false);
assert.ok(projected.away.starter.candidates.length > 0);

const measured = structuredClone(known);
for (const side of ['away', 'home']) {
  measured[side].starter = starterSnapshot({ leagueId: 'NPB', game, side,
    identity: { id: game[`${side}ProbableId`], name: game[`${side}Probable`], source: game.probableSource, sourceEvidence: receipt },
    stats: { era: 4, whip: 1.2, battersFaced: 100, inningsPitched: 24, appearances: 4, gamesStarted: 4 },
    referenceEra: 4, recentStarts: [{ inningsPitched: 6 }] });
}
const measuredContext = await buildAsianGameContext('NPB', game, { historyGames: history, featureSnapshot: measured });
for (const side of ['away', 'home']) {
  assert.equal(measuredContext[side].starter.confirmed, true);
  assert.equal(measuredContext[side].starter.performanceAvailable, true);
  assert.equal(measuredContext[side].starter.qualityFactor, measured[side].starter.qualityFactor);
  assert.equal(measuredContext[side].starter.expectedInnings, measured[side].starter.expectedInnings);
  assert.deepEqual(measuredContext[side].starter.sourceEvidence, receipt);
}
console.log('Asian official starter precedence: missing ability preserves official assignment, neutral performance, unknown rotation and measured ability PASS');
