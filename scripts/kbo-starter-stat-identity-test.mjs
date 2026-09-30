import assert from 'node:assert/strict';
import { buildAsianProductionFeatureSnapshot, parseKboStarterAnalysisPayload, starterSnapshot } from '../lib/asian-production-features-v1.js';
import { asianLeagueConfig, buildAsianGameContext } from '../lib/asian-baseball.js';

// Synthetic transport counterexamples exercise the real adapter and model
// handoff. They do not assert that an official historical game was affected.
const year = new Date(Date.now() + 9 * 3600000).getUTCFullYear();
const game = { league: 'KBO', leagueId: 'KBO', gamePk: 123, providerGameId: 'synthetic-kbo-stat-identity',
  officialDate: `${year}-09-30`, taipeiDate: `${year}-09-30`,
  gameDate: new Date(Date.now() + 3600000).toISOString(), statusCode: 'S', gameNumber: 1, scheduledInnings: 9,
  awayCode: 'DOO', homeCode: 'HAN', awayTeamId: 604, homeTeamId: 608 };
const meta = () => ({ G_ID: game.providerGameId, AWAY_ID: 'OB', HOME_ID: 'HH', SEASON_ID: year, SR_ID: 0,
  T_PIT_P_ID: '51264', B_PIT_P_ID: '76715', T_PIT_P_NM: '최승용', B_PIT_P_NM: '류현진' });
const row = (name, era, hand) => ({ row: [`<span class="name">${name}</span><span class="style">${hand}</span>`,
  String(era), '1', '20', '5', '', '1.2'].map(Text => ({ Text })) });
const rows = () => [row('최승용', 1, '좌투'), row('류현진', 9, '우투')];
const history = Array.from({ length: 12 }, (_, i) => ({ ...game, gamePk: 200 + i,
  providerGameId: `synthetic-prior-${i}`, gameDate: new Date(Date.now() - (20 + i) * 86400000).toISOString(),
  statusCode: 'F', awayScore: 3, homeScore: 4 }));

async function build({ analysisRows = rows(), gameMeta = meta() } = {}) {
  globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: options.body });
    let payload;
    if (url.endsWith('/GetKboGameList')) payload = { game: [gameMeta] };
    else if (url.endsWith('/GetPitcherRecordAnalysis')) payload = { rows: analysisRows };
    else if (url.endsWith('/GetTodayGames')) payload = {};
    else throw Error('Synthetic unavailable profile');
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const production = await buildAsianProductionFeatureSnapshot({ leagueId: 'KBO', game, history: [], fetchImpl });
  const context = await buildAsianGameContext('KBO', production.game, { historyGames: history,
    featureSnapshot: production.featureSnapshot });
  return { features: production.featureSnapshot, context, requests };
}

function assertRejected(result, side, reason) {
  const starter = result.features[side].starter;
  const modeled = result.context[side].starter;
  assert.equal(starter.id, side === 'away' ? '51264' : '76715');
  assert.equal(starter.confirmed, true, 'valid official assignment survives missing ability');
  assert.equal(starter.performanceAvailable, false);
  assert.equal(starter.performanceMissingReason, reason);
  assert.equal(starter.performanceIdentityEvidence.status, 'REJECTED');
  assert.equal(starter.qualityFactor, null);
  assert.equal(starter.throws, null, 'rejected response cannot supply throwing hand');
  assert.equal(starter.officialThrows, null);
  assert.deepEqual(starter.candidates, []);
  assert.equal(modeled.confirmed, true);
  assert.equal(modeled.performanceAvailable, false);
  assert.equal(modeled.qualityFactor, 1);
  assert.equal(modeled.expectedInnings, asianLeagueConfig('KBO').modelConfig.neutralStarterInnings);
  assert.equal(modeled.projectionMode, 'OFFICIAL_ASSIGNMENT_NEUTRAL_PERFORMANCE');
  assert.equal(modeled.performanceMissingReason, reason);
}

const valid = await build();
for (const [index, side] of ['away', 'home'].entries()) {
  const starter = valid.features[side].starter;
  const expected = starterSnapshot({ leagueId: 'KBO', game, side,
    identity: { id: starter.id, name: starter.name, source: starter.identitySource },
    stats: parseKboStarterAnalysisPayload({ rows: rows() })[index], referenceEra: 4.3 * .9 });
  assert.equal(starter.performanceAvailable, true);
  assert.equal(starter.qualityFactor, expected.qualityFactor, 'verified inputs keep the existing formula');
  assert.equal(starter.season.era, index ? 9 : 1);
  assert.equal(starter.throws, index ? 'R' : 'L');
  assert.equal(starter.performanceIdentityEvidence.status, 'REQUEST_SCOPE_AND_UNIQUE_NAME_VERIFIED');
  assert.equal(starter.performanceIdentityEvidence.responsePlayerId, null, 'request IDs are not fabricated response IDs');
  assert.ok(starter.performanceIdentityEvidence.requestBodyHash);
  assert.ok(valid.features.sourceEvidence.events.some(event => event.id === starter.performanceIdentityEvidence.sourceEventId));
}

const swapped = await build({ analysisRows: rows().reverse() });
for (const side of ['away', 'home']) assertRejected(swapped, side, 'KBO_STARTER_STATS_IDENTITY_MISMATCH');
assert.equal(swapped.requests.some(request => request.url.includes('Basic.aspx')), false,
  'identity mismatch is rejected before profile enrichment, not merely detected there');

const stale = await build({ analysisRows: [row('previous starter', 0, '우투'), rows()[1]] });
assertRejected(stale, 'away', 'KBO_STARTER_STATS_IDENTITY_MISMATCH');
assert.equal(stale.features.home.starter.performanceAvailable, true, 'one rejected side does not erase the valid side');
assert.equal(stale.features.home.starter.season.era, 9);
const blank = await build({ analysisRows: [row('', 0, '우투'), rows()[1]] });
assertRejected(blank, 'away', 'KBO_STARTER_STATS_IDENTITY_MISMATCH');

const duplicate = await build({ analysisRows: [rows()[0], rows()[0]] });
assertRejected(duplicate, 'away', 'KBO_STARTER_STATS_IDENTITY_AMBIGUOUS');
assertRejected(duplicate, 'home', 'KBO_STARTER_STATS_IDENTITY_MISMATCH');
const extra = await build({ analysisRows: [...rows(), rows()[0]] });
for (const side of ['away', 'home']) assertRejected(extra, side, 'KBO_STARTER_STATS_IDENTITY_AMBIGUOUS');
const namesake = await build({ gameMeta: { ...meta(), B_PIT_P_NM: '최승용' },
  analysisRows: [rows()[0], row('최승용', 9, '우투')] });
for (const side of ['away', 'home']) assertRejected(namesake, side, 'KBO_STARTER_STATS_IDENTITY_AMBIGUOUS');
const wrongSeason = await build({ gameMeta: { ...meta(), SEASON_ID: year - 1 } });
assert.equal(wrongSeason.features.pipelineError, 'KBO_OFFICIAL_GAME_SEASON_MISMATCH');
for (const side of ['away', 'home']) {
  assert.equal(wrongSeason.features[side].starter, null,
    'conflicting game-list season provides no independent official assignment to preserve');
  assert.notEqual(wrongSeason.context[side].starter.confirmed, true);
}
assert.equal(wrongSeason.requests.some(request => request.url.endsWith('/GetPitcherRecordAnalysis')), false);
const missing = await build({ analysisRows: [] });
for (const side of ['away', 'home']) assertRejected(missing, side, 'KBO_STARTER_STATS_UNAVAILABLE');
globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();
console.log('KBO starter stat identity: scoped valid input, swapped/stale/blank/ambiguous/season rejection, independent sides, neutral official-assignment handoff PASS');
