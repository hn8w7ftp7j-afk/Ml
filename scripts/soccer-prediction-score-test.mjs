import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calculateSoccerPredictionScore, validateSoccerPredictionScore,
  summarizeSoccerPredictionReturns, SOCCER_PREDICTION_SCORE_VERSION } from '../lib/soccer/prediction-score.js';
import { buildSoccerScenarioResearch } from '../lib/soccer/scenario-research.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { soccerResearchArtifacts } from '../lib/soccer/research-frozen.js';
import { soccerHalfTimeArtifacts } from '../lib/soccer/half-time-frozen.js';
import { predictScoreModel } from '../lib/soccer/score-model.js';
import { predictHalfTimeDistribution } from '../lib/soccer/half-time-model.js';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { soccerDate } from '../lib/soccer/contracts.js';
import { soccerScoringHash as hash } from '../lib/soccer/soccer-scoring.js';
import { deterministicScore, scoreBoundaryAudit, SCORE_FORMULA_VERSION } from '../lib/deterministic-score.js';

// Retained provider team IDs with an explicitly invented future fixture clock.
// No fixture is written to Production or represented as actual match accuracy.
const now = Date.parse('2026-11-10T00:00:00Z'), at = new Date(now).toISOString();
function fixture(league) {
  const payload = JSON.parse(fs.readFileSync(`scripts/fixtures/soccer/${league}-summary.json`));
  const competition = payload.header.competitions[0];
  const source = { provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${league === 'epl' ? 'eng.1' : 'uefa.champions'}/summary?event=${payload.header.id}`,
    fetchedAt: at, contentHash: hash(payload) };
  const original = normalizeSoccerSchedule({ leagues: [payload.header.league], events: [{ ...payload.header,
    date: competition.date, status: competition.status }] }, league, source).games[0];
  const startTime = new Date(now + 3600000).toISOString();
  const game = { ...original, status: 'scheduled', startTime, date: soccerDate(startTime) };
  const evidence = { ok: true, phase: 'PREMATCH_OBSERVATION', game, source };
  const ft = { ...predictScoreModel(soccerResearchArtifacts().leagues[league].liveModel, {
    league, startTime, homeId: game.home.sourceId, awayId: game.away.sourceId, neutralSite: game.neutralSite }), league, gameId: game.id };
  const ht = { ...predictHalfTimeDistribution(ft, soccerHalfTimeArtifacts().leagues[league].liveModel,
    { league, startTime }), league, gameId: game.id };
  const reader = { revision: hash(`prediction-${league}`), observationId: hash(`observation-${league}`), observedAt: at,
    firstFetchedAt: at, receivedAt: at, persistedAt: at, sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/' };
  const markets = ['FT', 'HT'].flatMap(period => ['HANDICAP', 'TOTAL'].map(kind => ({
    unit: 'GOALS', kind, period, line: kind === 'HANDICAP' ? '1+50' : '2.5', lineSide: kind === 'HANDICAP' ? 'home' : null,
    homeWater: .95, awayWater: .95, overWater: .95, underWater: .95, rawRows: ['original synthetic quote'],
    periodEvidence: { period, status: 'EXPLICIT', sectionTitle: league === 'epl' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽',
      tableHeaders: [period === 'FT' ? '全場' : '上半場'], marketHeader: period === 'FT' ? '全場' : '上半場' },
  })));
  const quotes = buildSoccerMarketDirections({ game, reader, now, distributions: { FT: ft, HT: ht },
    matchedGames: [{ officialGameId: game.id, league: league.toUpperCase(), boardDate: game.date,
      prestart: true, matchStatus: 'MATCHED', markets }] }).flatMap(row => row.quotes);
  assert.equal(quotes.length, 8);
  return { league, game, evidence, ft, ht, quotes, research: buildSoccerScenarioResearch({ game, now }) };
}
const protections = value => {
  assert.equal(value.formalEligible, false); assert.equal(value.formalScoringEnabled, false); assert.equal(value.executable, false);
  assert.equal(value.totalModelError, null); assert.equal(value.modelErrorMargin, null); assert.equal(value.modelValidation, 'UNVERIFIED');
};

const rows = [
  { id: 'low', weight: .1, lower: -.2, upper: -.2 },
  { id: 'high', weight: .9, lower: .1, upper: .1 },
];
const arithmetic = summarizeSoccerPredictionReturns({ rows });
assert.equal(arithmetic.ok, true); protections(arithmetic);
assert.equal(arithmetic.q10Bounds.lower, -.2, 'CDF exactly10% selects the first lower atom');
assert.ok(arithmetic.WBounds.lower <= .07 && arithmetic.WBounds.upper >= .07);
assert.equal(arithmetic.R, Math.min(arithmetic.W, -.2));
assert.equal(arithmetic.score, deterministicScore({ weightedEV: arithmetic.W, robustEV: arithmetic.R, executable: false }).score);
assert.equal(arithmetic.eligiblePrediction, false);
const nearBoundary = summarizeSoccerPredictionReturns({ rows: [
  { ...rows[0], weight: .0999999999999999 }, { ...rows[1], weight: .9000000000000001 },
] });
assert.equal(nearBoundary.q10Bounds.lower, .1, 'no binary64 epsilon changes the specified weightedCDF boundary');
const bounded = summarizeSoccerPredictionReturns({ rows: [{ id: 'all', weight: 1, lower: -.1, upper: .2 }] });
assert.equal(bounded.W, bounded.WBounds.lower); assert.equal(bounded.score, bounded.scoreBounds.lower);
assert.ok(bounded.scoreBounds.lower < bounded.scoreBounds.upper); assert.equal(bounded.eligiblePrediction, false);
assert.notEqual(bounded.W, .05, 'an unresolved payoff interval is never replaced by its midpoint');
const positive = summarizeSoccerPredictionReturns({ rows: [{ id: 'positive', weight: 1, lower: .03, upper: .03 }] });
assert.equal(positive.eligiblePrediction, true); assert.ok(positive.score >= 7.2);
assert.ok(scoreBoundaryAudit({ ...deterministicScore({ weightedEV: positive.W, robustEV: positive.R, executable: false }) },
  { weightedEV: positive.W, robustEV: positive.R }).ok);
for (const input of [
  { rows: rows.slice(0, 1), expectedCount: 2 }, { rows: [{ ...rows[0], weight: 0 }, rows[1]] },
  { rows: [{ ...rows[0], weight: -.1 }, rows[1]] }, { rows: [{ ...rows[0], weight: .2 }, rows[1]] },
  { rows: [{ ...rows[0], upper: -Infinity }, rows[1]] }, { rows: [rows[0], { ...rows[1], id: 'low' }] },
]) assert.equal(summarizeSoccerPredictionReturns(input).ok, false, JSON.stringify(input));

let directions = 0; let eplFixture;
for (const league of ['epl', 'ucl']) {
  const data = fixture(league); if (league === 'epl') eplFixture = data;
  const original = JSON.stringify(data);
  for (const quote of data.quotes) {
    const input = { quote, game: data.game, evidence: data.evidence,
      distribution: quote.period === 'FT' ? data.ft : data.ht, research: data.research, now };
    const predicted = calculateSoccerPredictionScore(input);
    assert.equal(predicted.status, 'PREDICTION_SCORE_AVAILABLE', JSON.stringify(predicted));
    protections(predicted); assert.equal(predicted.version, SOCCER_PREDICTION_SCORE_VERSION);
    assert.equal(predicted.scoreFormulaVersion, SCORE_FORMULA_VERSION);
    assert.equal(predicted.scenarioCount, 16); assert.equal(predicted.weightsRenormalized, false);
    assert.equal(predicted.W, predicted.WBounds.lower); assert.equal(predicted.R_model, predicted.R);
    assert.equal(predicted.R, Math.min(predicted.W, predicted.q10Bounds.lower));
    assert.equal(predicted.eligiblePrediction, predicted.score >= 7.2 && predicted.W > 0 && predicted.R > 0);
    assert.deepEqual(predicted.quote, { period: quote.period, kind: quote.kind, direction: quote.side.toUpperCase(),
      sourceLine: quote.line, lineSide: quote.lineSide ?? null, water: quote.water, unit: 'GOALS' });
    assert.ok(predicted.inputsUsed.some(row => row.kind === 'ORIGINAL_READER_QUOTE' && row.quoteKey === quote.key));
    assert.ok(predicted.inputsNotApplied.includes('MATCH_NPXG')); assert.ok(predicted.inputsNotApplied.includes('PERSONNEL_GOAL_EFFECT'));
    if (quote.kind === 'HANDICAP') assert.ok(predicted.scenarioRows.every(row => row.arithmetic === 'CERTIFIED_INFINITE_SCORE_DIFFERENCE_ENCLOSURE'));
    assert.equal(validateSoccerPredictionScore(predicted, input).ok, true);
    assert.equal(validateSoccerPredictionScore(predicted, { ...input, research: undefined }).ok, true);
    assert.equal(validateSoccerPredictionScore(predicted, { ...input, now: now + 180000 }).ok, false);
    const changed = { ...predicted, W: 999 };
    assert.equal(validateSoccerPredictionScore(changed, input).ok, false);
    const { contentHash, ...altered } = changed;
    assert.equal(validateSoccerPredictionScore({ ...altered, contentHash: hash(altered) }, input).ok, false,
      'rehashed inconsistent arithmetic is not valid');
    const rehashed = mutate => {
      const fake = structuredClone(predicted); mutate(fake); delete fake.contentHash;
      return { ...fake, contentHash: hash(fake) };
    };
    for (const mutate of [
      x => { x.provenance.ruleBindingHash = hash('different-rules'); },
      x => { x.inputsUsed.push({ kind: 'MATCH_NPXG', modelEffectApplied: true }); },
      x => { x.inputsNotApplied = []; },
      x => { x.provenance.scenarioArtifactHash = hash('other-artifact'); },
      x => { x.scenarioRows[0].distributionHash = hash('other-model'); },
      x => { x.scenarioRows[0] = null; },
      x => { x.accepted = true; },
    ]) assert.equal(validateSoccerPredictionScore(rehashed(mutate), input).ok, false);
    const fabricated = rehashed(x => {
      x.scenarioRows = x.scenarioRows.map(row => ({ ...row, lower: .5, upper: .5 }));
      const recalculated = summarizeSoccerPredictionReturns({ rows: x.scenarioRows, expectedCount: 16 });
      Object.assign(x, recalculated, { status: 'PREDICTION_SCORE_AVAILABLE', scenariosHash: hash(x.scenarioRows) });
    });
    assert.equal(validateSoccerPredictionScore(fabricated, input).ok, false,
      'source recomputation rejects all forged payoff returns even with consistent recomputed W/R/S and hashes');
    assert.equal(calculateSoccerPredictionScore(input).contentHash, predicted.contentHash,
      'returned mutable DTO cannot poison private recomputation cache');
    directions++;
  }
  assert.equal(JSON.stringify(data), original, 'forecast calculation must not mutate source, quotes, models or scenario weights');
}
assert.equal(directions, 16);

const base = { quote: eplFixture.quotes[0], game: eplFixture.game, evidence: eplFixture.evidence,
  distribution: eplFixture.quotes[0].period === 'FT' ? eplFixture.ft : eplFixture.ht, research: eplFixture.research, now };
const reject = mutate => { const input = structuredClone(base); mutate(input); assert.equal(calculateSoccerPredictionScore(input).ok, false); };
reject(x => { x.distribution.cells[0].probability += .01; });
reject(x => { x.distribution.trainingHash = hash('another-model'); });
reject(x => { x.research.periods[x.quote.period].scenarios[0].weight += .01; });
reject(x => { x.research.periods[x.quote.period].scenarios.pop(); });
reject(x => { x.research.periods[x.quote.period].scenarios[0].distribution.homeRate += 1; });
reject(x => { x.quote.water += .01; });
reject(x => { x.quote.lineSide = 'away'; });
reject(x => { x.quote.period = 'UNKNOWN'; });
reject(x => { x.game.status = 'in_progress'; });
reject(x => { x.now += 180001; });
reject(x => { x.evidence.phase = 'POSTMATCH_AUDIT'; });
reject(x => { x.evidence.source.fetchedAt = new Date(now + 1).toISOString(); });
reject(x => { x.evidence.game.home.sourceId = 'another-team'; });
const mutable = structuredClone(base);
assert.equal(calculateSoccerPredictionScore(mutable).ok, true);
mutable.research.periods[mutable.quote.period].scenarios[0].distribution.cells[0].probability += .01;
assert.equal(calculateSoccerPredictionScore(mutable).ok, false, 'WeakMap reuse cannot hide a mutated frozen scenario object');
console.log('PASS prediction-score: both leagues x8 source-bound fixed-formula forecasts, certified handicap intervals, q10 boundary, no zero total-error substitution, mutation/time/model/quote/league isolation and non-authoritative validation');
