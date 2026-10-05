import assert from 'node:assert/strict';
import { analyzeNbaPreseason } from '../lib/nba/preseason-model.js';
import { preseasonTraining } from '../lib/nba/preseason-training.js';
import { preseasonMarket, buildPreseasonTraining } from '../lib/nba/preseason-core.js';
import { nbaResultQuoteCurrent, validPreseasonResult, mergeNbaAnalysisResults } from '../lib/nba/analysis-job-display.js';
import { loadNbaAnalysis } from '../lib/nba/analysis-service.js';
const date = '2026-10-06', now = Date.parse('2026-10-05T18:00:00Z'), observedAt = new Date(now).toISOString();
const team = id => ({ id: `nba:espn:team:${id}`, sourceId: String(id), league: 'NBA' });
const game = { league: 'NBA', leagueId: 'NBA', seasonType: 'preseason', season: { year: 2027 }, taipeiDate: date, id: 'nba:espn:game:401999001', sourceId: '401999001', gamePk: 401999001, home: team(1), away: team(29), startTime: '2026-10-05T23:00:00Z', completed: false, timeConfirmed: true, status: 'scheduled' };
const quotes = { fullTotal: { line: '232.5', overWater: .94, underWater: .94 }, fullRunline: { line: '3平', lineSide: 'away', homeWater: .95, awayWater: .95 }, firstHalfTotal: { line: '115+50', overWater: .94, underWater: .96 }, firstHalfRunline: { line: '1-90', lineSide: 'home', homeWater: .95, awayWater: .95 } };
const result = analyzeNbaPreseason(game, quotes);
assert.equal(result.status, 'ready'); assert.equal(result.executable, false); assert.equal(result.promotionEligible, false); assert.equal(result.probabilityEstimate, null);
assert.equal(result.preseasonAnalysis.trainingSamples, 198); assert.equal(result.preseasonAnalysis.distributionSamples, 168); assert.equal(validPreseasonResult(result, date), true);
for (const key of Object.keys(quotes)) {
 const market = result.marketAnalyses[key]; assert.equal(market.status, 'ready'); assert.deepEqual(market.quote, quotes[key]); assert.equal(market.validatedBettingWinRate, null);
 const sides = Object.values(market.sides); assert.ok(Math.abs(sides[0].winProbability - sides[1].lossProbability) < 1e-10); assert.ok(Math.abs(sides[0].winProbability + sides[1].winProbability + sides[0].pushProbability - 1) < 1e-10);
}
// Hand settlement catches wrong favorite-side mapping and partial-credit EV.
const fixed = Array.from({ length: 50 }, (_, i) => ({ date: '2026-10-01', gameId: String(i), errors: { fullMargin: 0, fullTotal: 0, halfMargin: 0, halfTotal: 0 } }));
const away = preseasonMarket('fullRunline', { line: '3+50', lineSide: 'away', awayWater: .95, homeWater: .95 }, { fullMargin: -3 }, fixed, date);
assert.equal(away.sides.away.winProbability, 1); assert.ok(Math.abs(away.sides.away.expectedNet - 48.25) < 1e-8); assert.ok(Math.abs(away.sides.home.expectedNet + 49.25) < 1e-8);
const half = preseasonMarket('firstHalfTotal', quotes.firstHalfTotal, { halfTotal: 115 }, fixed, date); assert.equal(half.sides.over.winProbability, 1); assert.ok(Math.abs(half.sides.over.expectedNet - 47.75) < 1e-8);
assert.equal(preseasonMarket('fullRunline', { ...quotes.fullRunline, lineSide: 'bad' }, {}, fixed, date).status, 'blocked');
const rebuild = buildPreseasonTraining(preseasonTraining.history.slice().reverse()); assert.deepEqual(rebuild.observations, preseasonTraining.observations);
const future = { ...preseasonTraining.features[0], gameId: 'nba:espn:game:999991', date, year: 2027, actual: { fullTotal: 999, fullMargin: 999, halfTotal: 999, halfMargin: 999 } };
assert.deepEqual(analyzeNbaPreseason(game, quotes, { trainingData: { ...preseasonTraining, features: [...preseasonTraining.features, future], observations: [...preseasonTraining.observations, { ...future, errors: future.actual }] } }), result);
const bad = structuredClone(preseasonTraining); bad.observations[0].trainedThrough = bad.observations[0].date; assert.equal(analyzeNbaPreseason(game, quotes, { trainingData: bad }).status, 'blocked');
assert.equal(analyzeNbaPreseason(game, quotes, { trainingData: { ...preseasonTraining, observations: [] } }).status, 'insufficient');
assert.equal(analyzeNbaPreseason({ ...game, seasonType: 'regular' }, quotes).status, 'blocked');
const row = { league: 'NBA', captureKey: 'fixture', boardDate: date, boardTime: '07:00', home: game.home, away: game.away, marketStatus: 'open', ...quotes };
const snapshot = { league: 'NBA', boardDate: date, observedAt, pageActivityAt: observedAt, games: [row] };
const schedule = { league: 'NBA', status: 'ready', qa: { status: 'WARNING' }, sources: [{ status: 'ready', hash: 'fixture', fetchedAt: observedAt }], data: { games: [game] } };
const query = { date, id: game.sourceId, observedAt };
const payload = await loadNbaAnalysis(query, { now, loadSchedule: async () => schedule, loadReader: async () => snapshot });
assert.equal(payload.status, 'ready'); assert.equal(payload.modelVersion, result.modelVersion); assert.equal(payload.scope, 'NBA_preseason_full_and_half_markets');
const task = { nbaQuery: query, game };
const display = mergeNbaAnalysisResults({ league: 'NBA', date, results: [{ ok: true, task, payload }] }, [{ game, quote: row, observedAt, pageActivityAt: observedAt, canAnalyze: true }], date)[0];
assert.equal(nbaResultQuoteCurrent(display, now), true);
assert.equal(nbaResultQuoteCurrent({ ...display, observedAt: new Date(now + 1000).toISOString() }, now + 1000), true);
assert.equal(nbaResultQuoteCurrent({ ...display, quote: { ...row, fullRunline: { ...quotes.fullRunline, awayWater: .90 } } }, now), false);
assert.equal(nbaResultQuoteCurrent(display, now + 180001), false);
for (const key of ['fullRunline', 'firstHalfTotal']) {
 const only = { ...snapshot, games: [{ ...row, fullTotal: null, fullRunline: null, firstHalfTotal: null, firstHalfRunline: null, [key]: quotes[key] }] };
 const response = await loadNbaAnalysis(query, { now, loadSchedule: async () => schedule, loadReader: async () => only }); assert.equal(response.status, 'ready'); assert.equal(response.marketAnalyses[key].status, 'ready');
}
const broken = structuredClone(payload); broken.marketAnalyses.fullTotal.sides.over.winProbability = 1.2; assert.equal(validPreseasonResult(broken, date), false);
console.log('NBA preseason: verified 198 games/168 strictly-earlier residuals, four market contracts, favorite mapping, partial payouts, no future leakage, only-spread/half service, browser merge/freshness PASS');
