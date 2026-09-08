import assert from 'node:assert/strict';
import { analysisSourceStatusDisplay } from '../lib/npb-identity-display.js';
import { analysisStarterDisplay } from '../lib/analysis-starter-display.js';
import { compactAnalysisContext } from '../lib/analysis-transport-v1.js';
// Reproduced shape from actual 2026-09-08 CHU–YOM provider acquisition:
// name and legacy identityConfirmed survived while IDs were null and a rotation
// forecast was used. This test fixture does not represent pregame capture.
const game = { leagueId: 'NPB', gamePk: 575837198996336, gameDate: '2026-09-08T09:00:00.000Z', awayTeamId: 506, homeTeamId: 501, awayProbable: '柳', homeProbable: '戸郷' };
const context = { leagueId: 'NPB', game, ...Object.fromEntries(['away', 'home'].map(side => [side, { starter: { name: game[`${side}Probable`], id: null, identityConfirmed: true, confirmed: false, status: 'PROJECTED', source: 'NPB_OFFICIAL_PRIOR_STARTS_ROTATION_FORECAST_PIT' }, upstreamReadiness: { starterIdentity: false } }])) };
const item = { game, customData: { context, analysis: { sourceStatuses: { starterIdentity: 'CONFIRMED', starters: 'PROJECTED_CANDIDATE_OR_NEUTRAL' }, results: [{ weightedEV: 0.1, robustEV: 0.02, score: 7.3 }] } } };
const before = structuredClone(item);
assert.equal(analysisSourceStatusDisplay(item).starterIdentity, 'PROJECTED_OR_UNVERIFIED');
assert.match(analysisStarterDisplay(item, 'away'), /輪值推估/);
const compact = { ...item, customData: { ...item.customData, context: compactAnalysisContext(context) } };
assert.deepEqual(analysisSourceStatusDisplay(compact), analysisSourceStatusDisplay(item));
assert.equal(analysisStarterDisplay(compact, 'home'), analysisStarterDisplay(item, 'home'));
assert.deepEqual(item, before, 'presentation cannot mutate frozen inputs, model results or snapshot evidence');
const verified = structuredClone(item);
for (const side of ['away', 'home']) verified.customData.context[side] = { upstreamReadiness: { starterIdentity: true }, starter: { name: game[`${side}Probable`], id: side === 'away' ? '123' : '456', teamId: game[`${side}TeamId`], identityConfirmed: true, confirmed: true } };
assert.equal(analysisSourceStatusDisplay(verified).starterIdentity, 'CONFIRMED');
assert.equal(analysisSourceStatusDisplay({ ...verified, customData: { ...verified.customData, context: compactAnalysisContext(verified.customData.context) } }).starterIdentity, 'CONFIRMED');
for (const mutate of [x => x.game.gamePk++, x => x.customData.context.game.gameDate = '', x => x.customData.context.home.starter.id = null, x => x.customData.context.home.starter.teamId = 999, x => x.customData.context.home.starter.identityMismatch = true, x => delete x.customData.context.home.upstreamReadiness, x => x.customData.context.leagueId = 'KBO']) {
  const bad = structuredClone(verified); bad.game = { ...bad.game }; mutate(bad); assert.notEqual(analysisSourceStatusDisplay(bad).starterIdentity, 'CONFIRMED');
}
const oldCompact = structuredClone(compact); delete oldCompact.customData.context.game.homeTeamId;
assert.notEqual(analysisSourceStatusDisplay(oldCompact).starterIdentity, 'CONFIRMED', 'old transport lacking team evidence cannot invent confirmation');
for (const league of ['MLB', 'KBO', 'CPBL']) {
  const other = structuredClone(item); other.game.leagueId = league;
  assert.equal(analysisSourceStatusDisplay(other), other.customData.analysis.sourceStatuses, `${league} status path is unchanged`);
}
console.log('NPB identity display: real missing-ID shape, projection, compact transport, frozen immutability and cross-league isolation PASS');
