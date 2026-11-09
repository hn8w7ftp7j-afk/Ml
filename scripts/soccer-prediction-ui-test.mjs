import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { deterministicScore, SCORE_FORMULA_VERSION } from '../lib/deterministic-score.js';
import { soccerQuoteScorePresentation } from '../lib/soccer/score-presentation.js';
import { soccerScoringReadiness, soccerQuoteScoringBlockers } from '../lib/soccer/scoring-readiness.js';
import { buildSoccerRanking, SOCCER_RANK_MARKETS } from '../lib/soccer/ranking.js';
import { soccerHighScoreCandidates, summarizeSoccerHighScoreBets } from '../lib/soccer/league-bet-status.js';
import { soccerQuoteIdentity } from '../lib/soccer/candidate-qualification.js';
import { soccerTeamLabel } from '../lib/soccer/team-labels.js';
import { candidateFixture } from './helpers/soccer-candidate-fixture.mjs';

// Explicit synthetic client fixtures. The package command uses the existing
// test-only identity loader; the unmocked identity regressions remain separate.
const now = Date.parse('2026-11-10T00:00:00Z'), at = new Date(now).toISOString();
const producerOnly = process.argv[2] === '--producer';
const contractPath = producerOnly ? process.argv[3] : process.argv[2];
assert.ok(!producerOnly || typeof contractPath === 'string' && contractPath.length > 0, 'Producer mode requires its actual service/DB output file');
const sha = character => character.repeat(64);
function fixture(league = 'epl', W = .0435, R = .024) {
  const game = { id: `soccer:${league}:123`, sourceId: '123', league, date: '2026-11-10', status: 'scheduled',
    startTime: new Date(now + 3600000).toISOString(), home: { name: '合成主隊', sourceId: '359' }, away: { name: '合成客隊', sourceId: '364' } };
  const score = deterministicScore({ weightedEV: W, robustEV: R, actualWater: true, qaPassed: true, executable: false }).score;
  const result = candidateFixture({ gameId: game.id, league, date: game.date, observedAt: at, persisted: true,
    publishedCurrent: true, analysisStatus: 'COMPLETED', evidence: { game }, formalScoringEnabled: true,
    qualification: { eligible: true }, directions: [{ period: 'FT', direction: 'TOTAL_OVER', eligible: true, score, W, R,
      qaFlag: 'WARN', quotes: [{ key: 'synthetic-price', period: 'FT', unit: 'GOALS', kind: 'TOTAL', side: 'over', line: '2.5',
        lineSide: null, water: .95, fresh: true, prestart: true, provenance: { gameId: game.id, observedAt: at } }] }] }, now);
  result.formalScoringEnabled = false; result.qualification.eligible = false;
  result.predictionContext = { version: 'SOCCER-AVAILABLE-DATA-PREDICTION-v1', mode: 'PREDICTION', contextualGoalEffectApplied: false };
  const direction = result.directions[0], quote = direction.quotes[0];
  direction.score = direction.W = direction.R = null; direction.eligible = false; quote.eligible = false;
  quote.scoring = { formalScoringEnabled: false, executable: false, stages: [] };
  quote.predictionScore = { version: 'SOCCER-MODEL-PREDICTION-SCORE-v1', mode: 'PREDICTION', status: 'PREDICTION_SCORE_AVAILABLE',
    score, S: score, W, R, R_model: R, eligiblePrediction: score >= 7.2 && W > 0 && R > 0,
    accepted: false, formalEligible: false, formalScoringEnabled: false, executable: false, totalModelError: null, modelErrorMargin: null, modelValidation: 'UNVERIFIED',
    RInterpretation: 'MODEL_PARAMETER_Q10_STRESS_NOT_TOTAL_ERROR_ADJUSTED_R', scoreFormulaVersion: SCORE_FORMULA_VERSION,
    gameId: game.id, league, period: 'FT', sourceQuoteKey: quote.key,
    quote: { period: 'FT', kind: 'TOTAL', direction: 'OVER', sourceLine: quote.line, lineSide: null, water: quote.water, unit: 'GOALS' },
    provenance: { quoteHash: quote.key, distributionHash: sha('a'), scenarioArtifactHash: sha('b'), protocolHash: sha('c'),
      calculatedAt: at, validUntil: result.validUntil } };
  quote.predictionQualification = { version: 'SOCCER-CURRENT-PREDICTION-v1', status: 'CURRENT_PREDICTION',
    eligible: quote.predictionScore.eligiblePrediction, sourceQuoteKey: quote.key, quoteIdentity: soccerQuoteIdentity(quote),
    gameId: game.id, league, date: game.date, period: 'FT', direction: direction.direction,
    analysisRevision: result.revision, analysisRunId: result.analysisRunId,
    qualificationVersion: result.qualificationVersion, quoteGeneration: result.quoteGeneration,
    score, S: score, W, R_model: R, distributionHash: sha('a'), scenarioArtifactHash: sha('b'),
    checkedAt: at, validUntil: result.validUntil, formalEligible: false, executable: false };
  return { game: result.evidence.game, result, now };
}
const show = ({ game, result, now: clock }) => soccerQuoteScorePresentation({ result, direction: result.directions[0],
  quote: result.directions[0].quotes[0], displayGame: game, now: clock });
const rank = ({ game, result, now: clock }) => buildSoccerRanking([game], { [game.id]: { status: 'done', data: result } }, { now: clock });
if (!producerOnly) for (const league of ['epl', 'ucl']) {
  const value = fixture(league), before = JSON.stringify(value), presentation = show(value);
  assert.equal(presentation.scoreKind, 'PREDICTION'); assert.equal(presentation.status, 'PREDICTION_QUALIFIED');
  assert.equal(presentation.score, 8); assert.equal(presentation.eligiblePrediction, true); assert.equal(presentation.eligible, false);
  assert.equal(rank(value).entries.length, 1); assert.equal(rank(value).order.length, 1);
  assert.equal(rank(value).entries[0].prediction, true); assert.equal(rank(value).entries[0].formalEligible, false);
  const readiness = soccerScoringReadiness(value.result, now, value.game);
  assert.equal(readiness.predictionQuoteCount, 1); assert.equal(readiness.predictionQualifiedQuoteCount, 1);
  assert.equal(readiness.qualifiedQuoteCount, 0, 'prediction does not become a formally qualified quote');
  const reminder = soccerHighScoreCandidates([value.game], { [value.game.id]: { status: 'done', data: value.result } },
    { league, date: value.game.date, now });
  assert.equal(reminder.candidates.length, 1);
  assert.equal(summarizeSoccerHighScoreBets(reminder.candidates, { league, date: value.game.date,
    ledgerReady: true, analysisReady: true }).unbet, 1);
  assert.equal(JSON.stringify(value), before, 'display, readiness and both rankings preserve the immutable data');
  const low = fixture(league, .001, -.0001);
  assert.equal(show(low).status, 'BELOW_THRESHOLD'); assert.ok(show(low).score != null); assert.equal(rank(low).entries.length, 0);
  assert.equal(show({ ...value, now: now + 180000 }).status, 'HISTORICAL'); assert.equal(rank({ ...value, now: now + 180000 }).entries.length, 0);
  assert.equal(show({ ...value, game: { ...value.game, home: value.game.away, away: value.game.home } }).status, 'CONTEXT_CHANGED');
  for (const mutate of [
    q => { q.water = 1.1; }, q => { q.line = '3.5'; }, q => { q.period = 'HT'; },
    q => { q.predictionScore.S = 9; q.predictionScore.score = 9; },
    q => { q.predictionScore.totalModelError = 0; }, q => { q.predictionScore.modelValidation = 'PASS'; },
    q => { q.predictionScore.accepted = true; }, q => { q.predictionScore.formalScoringEnabled = true; }, q => { q.predictionScore.modelErrorMargin = 0; },
    q => { q.predictionScore.provenance.distributionHash = 'invalid'; },
  ]) {
    const changed = structuredClone(value); mutate(changed.result.directions[0].quotes[0]);
    assert.equal(show(changed).score, null); assert.equal(rank(changed).entries.length, 0);
  }
  const changedHead = structuredClone(value); changedHead.result.currentResearch.quoteGeneration = '999';
  assert.equal(show(changedHead).eligiblePrediction, false); assert.equal(rank(changedHead).entries.length, 0);
  const injected = structuredClone(value); delete injected.result.directions[0].quotes[0].predictionScore;
  Object.assign(injected.result.directions[0], { score: 10, W: 10, R: 10, eligible: true });
  assert.equal(show(injected).score, null); assert.equal(rank(injected).entries.length, 0);
}

const marketSource = fs.readFileSync('app/soccer/market-panel.js', 'utf8').replace(/^import .*?;\n/gm, '').replace(/export function/g, 'function');
const marketCode = await transform(marketSource, { filename: 'prediction-market.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } } });
const marketContext = vm.createContext({ React, Date, soccerQuoteScorePresentation, soccerScoringReadiness, soccerQuoteScoringBlockers, SoccerRecordButton: () => null });
vm.runInContext(marketCode.code, marketContext);
const rankingSource = fs.readFileSync('app/soccer/workspace.js', 'utf8').replace(/^import .*?;\n/gm, '').replace(/export default function|export function/g, 'function');
const rankingCode = await transform(rankingSource, { filename: 'prediction-ranking.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } } });
let stateIndex = 0;
const rankingContext = vm.createContext({ React, Date, buildSoccerRanking, SOCCER_RANK_MARKETS, soccerTeamLabel,
  useState: initial => [stateIndex++ === 0 ? 'ranking' : initial, () => {}], SoccerRecordButton: () => null });
vm.runInContext(rankingCode.code, rankingContext);
const analysisSource = fs.readFileSync('app/soccer/analysis-panel.js', 'utf8').replace(/^import .*?;\n/gm, '').replace(/export default function|export function/g, 'function');
const analysisCode = await transform(analysisSource, { filename: 'prediction-analysis.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } } });
const analysisContext = vm.createContext({ React, Date, buildSoccerRanking, createContext: () => ({}) });
vm.runInContext(analysisCode.code, analysisContext);
if (!producerOnly) for (const league of ['epl', 'ucl']) {
  const value = fixture(league);
  const card = renderToStaticMarkup(marketContext.SoccerMarketDirections({ directions: value.result.directions,
    result: value.result, game: value.game, now }));
  assert.match(card, /預測 S/); assert.match(card, /模型情境 R/); assert.match(card, /預測通過排名門檻/);
  assert.match(card, /完整模型誤差未驗證/); assert.match(card, /10 分制/); assert.match(card, /尚未量化套入本次進球率/);
  stateIndex = 0;
  const table = renderToStaticMarkup(rankingContext.SoccerRanking({ games: [value.game],
    states: { [value.game.id]: { status: 'done', data: value.result } }, run: () => {}, now }));
  assert.match(table, /soccerRankRow/); assert.match(table, /預測 S/); assert.match(table, /模型情境 R/);
  assert.doesNotMatch(table, /通過正式資格核對/);
}

if (contractPath) {
  const payload = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  assert.ok(Array.isArray(payload.cases) && payload.cases.length >= 2, 'Actual service/DB producer cases are required');
  const leagues = new Set();
  for (const item of payload.cases) {
    const { game, result, now: clock } = item; leagues.add(game.league);
    assert.equal(result.formalScoringEnabled, false);
    const displays = (result.directions || []).flatMap(direction => (direction.quotes || []).map(quote =>
      soccerQuoteScorePresentation({ result, direction, quote, displayGame: game, now: clock })));
    assert.equal(displays.some(value => value.scoreKind === 'PREDICTION' && value.score != null), item.expectPredictionScore);
    const actual = buildSoccerRanking([game], { [game.id]: { status: 'done', data: result } }, { now: clock });
    assert.equal(actual.entries.length > 0, item.expectRanked);
    const counts = analysisContext.soccerAnalysisCounts([game], { [game.id]: { status: 'done', data: result } }, clock);
    assert.equal(counts.candidates, item.expectRanked ? 1 : 0, 'toolbar counts the same distinct current games as ranking');
    assert.ok(actual.entries.every(value => value.prediction && value.formalEligible === false));
    const html = renderToStaticMarkup(marketContext.SoccerMarketDirections({ directions: result.directions, result, game, now: clock }));
    if (item.expectPredictionScore) { assert.match(html, /預測 S/); assert.match(html, /模型情境 R/); }
    stateIndex = 0;
    const table = renderToStaticMarkup(rankingContext.SoccerRanking({ games: [game],
      states: { [game.id]: { status: 'done', data: result } }, run: () => {}, now: clock }));
    assert.equal((table.match(/class="soccerRankRow"/g) || []).length, actual.entries.length);
    if (item.expectRanked) { assert.match(table, /預測 S/); assert.match(table, /模型情境 R/); }
  }
  assert.deepEqual([...leagues].sort(), ['epl', 'ucl']);
}
console.log('PASS prediction UI: fixed S, exact quote/head identity, current and historical labels, locked thresholds, both ranking views, high-score reminders, explicit unverified context and optional real-service DTO → JSX');
