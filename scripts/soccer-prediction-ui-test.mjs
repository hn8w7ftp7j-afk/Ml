import { OpenedSoccerDetails } from './helpers/soccer-opened-details-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { deterministicScore, SCORE_FORMULA_VERSION } from '../lib/deterministic-score.js';
import { soccerQuoteScorePresentation, soccerMarketScorePresentations } from '../lib/soccer/score-presentation.js';
import { soccerScoringReadiness, soccerQuoteScoringBlockers } from '../lib/soccer/scoring-readiness.js';
import { buildSoccerRanking, SOCCER_RANK_MARKETS } from '../lib/soccer/ranking.js';
import { soccerHighScoreCandidates, summarizeSoccerHighScoreBets } from '../lib/soccer/league-bet-status.js';
import { soccerQuoteIdentity } from '../lib/soccer/candidate-qualification.js';
import { soccerTeamLabel } from '../lib/soccer/team-labels.js';
import { soccerMatchCard } from '../lib/soccer/match-card-transport.js';
import { candidateFixture } from './helpers/soccer-candidate-fixture.mjs';

// Explicit synthetic client fixtures. The package command uses the existing
// test-only identity loader; the unmocked identity regressions remain separate.
const now = Date.parse('2026-11-10T00:00:00Z'), at = new Date(now).toISOString();
const producerOnly = process.argv[2] === '--producer';
const contractPath = producerOnly ? process.argv[3] : process.argv[2];
assert.ok(!producerOnly || typeof contractPath === 'string' && contractPath.length > 0, 'Producer mode requires its actual service/DB output file');
const sha = character => character.repeat(64);
function fixture(league = 'epl', W = .0435, R = .024, key = 'synthetic-price') {
  const game = { id: `soccer:${league}:123`, sourceId: '123', league, date: '2026-11-10', status: 'scheduled',
    startTime: new Date(now + 3600000).toISOString(), home: { name: '合成主隊', sourceId: '359' }, away: { name: '合成客隊', sourceId: '364' } };
  const score = deterministicScore({ weightedEV: W, robustEV: R, actualWater: true, qaPassed: true, executable: false }).score;
  const result = candidateFixture({ gameId: game.id, league, date: game.date, observedAt: at, persisted: true,
    publishedCurrent: true, analysisStatus: 'COMPLETED', evidence: { game }, formalScoringEnabled: true,
    qualification: { eligible: true }, directions: [{ period: 'FT', direction: 'TOTAL_OVER', eligible: true, score, W, R,
      qaFlag: 'WARN', quotes: [{ key, period: 'FT', unit: 'GOALS', kind: 'TOTAL', side: 'over', line: '2.5',
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
function marketFixture(league, period, direction, key, W = .0435, R = .024) {
  const value = fixture(league, W, R, key), d = value.result.directions[0], q = d.quotes[0];
  const kind = direction.startsWith('TOTAL') ? 'TOTAL' : 'HANDICAP';
  const side = { TOTAL_OVER: 'over', TOTAL_UNDER: 'under', HANDICAP_HOME: 'home', HANDICAP_AWAY: 'away' }[direction];
  Object.assign(d, { period, direction });
  Object.assign(q, { period, kind, side, lineSide: kind === 'HANDICAP' ? 'away' : null });
  Object.assign(q.predictionScore, { period });
  Object.assign(q.predictionScore.quote, { period, kind, direction: side.toUpperCase(), lineSide: q.lineSide });
  Object.assign(q.predictionQualification, { period, direction, quoteIdentity: soccerQuoteIdentity(q) });
  return value;
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
  const alternatives = fixture(league, .4386, .3665, 'first');
  const second = fixture(league, .528, .4363, 'second');
  const highest = fixture(league, .6941, .5666, 'highest');
  const invalid = fixture(league, .9, -.01, 'ineligible');
  alternatives.result.directions[0].quotes.push(second.result.directions[0].quotes[0],
    highest.result.directions[0].quotes[0], invalid.result.directions[0].quotes[0]);
  const savedAlternatives = JSON.stringify(alternatives);
  const selected = rank(alternatives);
  assert.equal(selected.entries.length, 1, 'one eligible quote per game and market');
  assert.equal(selected.entries[0].W, .6941, 'highest eligible EV wins');
  assert.equal(selected.order[0].stableKey, selected.entries[0].stableKey, 'order view uses same winner');
  assert.equal(JSON.stringify(alternatives), savedAlternatives, 'all raw alternatives remain intact');
  alternatives.result.directions[0].quotes.reverse();
  assert.equal(rank(alternatives).entries[0].stableKey, selected.entries[0].stableKey, 'input order cannot change winner');
  // A higher eligible EV must win even when its stress score is lower.
  const highEV = fixture(league, .7, .001, 'lower-score-higher-ev');
  assert.ok(highEV.result.directions[0].quotes[0].predictionScore.score < selected.entries[0].score);
  alternatives.result.directions[0].quotes.push(highEV.result.directions[0].quotes[0]);
  assert.equal(rank(alternatives).entries[0].W, .7);
  highEV.result.directions[0].quotes[0].provenance.observedAt = new Date(now - 180000).toISOString();
  assert.equal(rank(alternatives).entries[0].W, .6941, 'expired highest EV cannot displace a current eligible quote');
  const tied = fixture(league, .5, .1, 'tie-low-r');
  const tieA = fixture(league, .5, .2, 'tie-a'), tieB = fixture(league, .5, .2, 'tie-b');
  tied.result.directions[0].quotes.push(tieA.result.directions[0].quotes[0], tieB.result.directions[0].quotes[0]);
  const tieWinner = rank(tied).entries[0];
  assert.equal(tieWinner.R, .2, 'equal W uses R only as a tie breaker');
  tied.result.directions[0].quotes.reverse();
  assert.equal(rank(tied).entries[0].stableKey, tieWinner.stableKey, 'equal W/R uses stable identity, not source order');
  const scoped = marketFixture(league, 'FT', 'HANDICAP_HOME', 'ft-handicap');
  for (const [period, direction] of [['FT', 'TOTAL_OVER'], ['HT', 'HANDICAP_HOME'], ['HT', 'TOTAL_OVER']]) {
    scoped.result.directions.push(marketFixture(league, period, direction, `${period}-${direction}`).result.directions[0]);
  }
  const opposite = marketFixture(league, 'FT', 'HANDICAP_AWAY', 'ft-handicap-away', .1, .04);
  scoped.result.directions.push(opposite.result.directions[0]);
  const scopeRank = rank(scoped);
  assert.deepEqual(scopeRank.entries.map(e => e.marketKey).sort(), ['FT:HANDICAP', 'FT:TOTAL', 'HT:HANDICAP', 'HT:TOTAL']);
  assert.equal(scopeRank.entries.find(e => e.marketKey === 'FT:HANDICAP').quote.side, 'away', 'opposite directions share one market winner');
  const filtered = buildSoccerRanking([scoped.game], { [scoped.game.id]: { status: 'done', data: scoped.result } }, { now, market: 'HT:HANDICAP' });
  assert.equal(filtered.entries.length, 1); assert.equal(filtered.entries[0].marketKey, 'HT:HANDICAP');
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

if (!producerOnly) {
  const epl = fixture('epl', .08, .05, 'epl-price'), ucl = fixture('ucl', .1, .05, 'ucl-price');
  const both = buildSoccerRanking([epl.game, ucl.game], {
    [epl.game.id]: { status: 'done', data: epl.result }, [ucl.game.id]: { status: 'done', data: ucl.result },
  }, { now });
  assert.deepEqual(both.entries.map(e => e.game.league).sort(), ['epl', 'ucl'], 'matching source IDs in different leagues remain separate');
}

const marketSource = fs.readFileSync('app/soccer/market-panel.js', 'utf8').replace(/^import .*?;\n/gm, '').replace(/export function/g, 'function');
const marketCode = await transform(marketSource, { filename: 'prediction-market.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } } });
const marketContext = vm.createContext({ SoccerDeferredDetails:OpenedSoccerDetails, React, Date, soccerQuoteScorePresentation,soccerMarketScorePresentations, soccerScoringReadiness, soccerQuoteScoringBlockers, SoccerRecordButtonGroup:({children})=>children,SoccerRecordButton: () => null });
vm.runInContext(marketCode.code, marketContext);
if (!producerOnly) for (const league of ['epl', 'ucl']) {
  const { game, result } = fixture(league);
  const quote = result.directions[0].quotes[0], priorAt = new Date(now - 240000).toISOString();
  const archive = { status: 'HISTORICAL_PREDICTION', league, date: game.date, gameId: game.id, startTime: game.startTime,
    homeId: game.home.sourceId, awayId: game.away.sourceId, neutralSite: false, revision: sha('f'), observedAt: priorAt,
    eligible: false, executable: false, quotes: [{ key: sha('7'), kind: 'TOTAL', side: 'over', line: '3.5', lineSide: null,
      period: 'FT', label: '大 3.5', water: .78, S: 8.1, W: .04, R: .02, observedAt: priorAt, calculatedAt: priorAt }] };
  const props = { historicalPrediction: archive, game, result, directions: result.directions, now };
  const render = value => renderToStaticMarkup(marketContext.SoccerMarketDirections(value));
  assert.doesNotMatch(render(props), /歷史賽前預測/, 'a current scored result has no fallback table');
  quote.predictionScore = { status: 'PREDICTION_SCORE_UNAVAILABLE', reason: 'SOCCER_SCORE_READER_TIME_INVALID' };
  quote.provenance.observedAt = priorAt;
  const markup = render(props);
  assert.match(markup, /歷史賽前預測/);
  assert.match(markup, /全場 大 3.5/); assert.match(markup, /8.1<\/td>/); assert.match(markup, /\+4.00%/);
  assert.match(markup, /分析時這筆原盤已滿 3 分鐘/);
  assert.doesNotMatch(markup, /無法評分：正式評分所需|無法評分：此版本尚未保存/);
  assert.doesNotMatch(markup.match(/<section[^>]+aria-label="歷史賽前預測"[^>]*>[\s\S]*?<\/section>/)[0], /<button/);
  assert.equal(rank({game,result,now}).entries.length, 0);
  for (const bad of [{gameId: 'soccer:epl:999'}, {date: '2026-11-11'}, {neutralSite: true}, {awayId: game.home.sourceId},
    {revision: result.revision}, {eligible: true}, {quotes: [{...archive.quotes[0], calculatedAt: at}]}]) {
    assert.doesNotMatch(render({...props, historicalPrediction: {...archive,...bad}}), /歷史賽前預測/);
  }
}
const rankingSource = fs.readFileSync('app/soccer/workspace.js', 'utf8').replace(/^import .*?;\n/gm, '').replace(/export default function|export function/g, 'function');
const rankingCode = await transform(rankingSource, { filename: 'prediction-ranking.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } } });
let stateIndex = 0, rankingView = 'ranking';
const rankingContext = vm.createContext({ React, Date, buildSoccerRanking, SOCCER_RANK_MARKETS, soccerTeamLabel,
  useState: initial => [stateIndex++ === 0 ? rankingView : initial, () => {}],
  SoccerRecordButtonGroup:({children})=>children,SoccerRecordButton: () => React.createElement('button', null, '紀錄實際下注') });
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
  const three = fixture(league, .4386, .3665, 'render-first');
  three.result.directions[0].quotes.push(fixture(league, .528, .4363, 'render-second').result.directions[0].quotes[0],
    fixture(league, .6941, .5666, 'render-highest').result.directions[0].quotes[0]);
  const winnerKey = rank(three).entries[0].stableKey;
  for (const view of ['ranking', 'order']) {
    rankingView = view; stateIndex = 0;
    const compact = renderToStaticMarkup(rankingContext.SoccerRanking({ games: [three.game],
      states: { [three.game.id]: { status: 'done', data: three.result } }, run: () => {}, now }));
    assert.equal((compact.match(/class="soccerRankRow"/g) || []).length, 1, `${view} renders only the winning alternative`);
    assert.ok(compact.includes(`data-soccer-rank-key="${winnerKey}"`));
    assert.match(compact, /W 69.41%/);
  }
  rankingView = 'ranking';

}

// An expired original price may be reviewed, but must never flow into the
// current list, current count, reminder or record controls.
if (!producerOnly) for (const league of ['epl', 'ucl']) {
  const value = fixture(league, .08, .05, 'original-over');
  const { game, result } = value;
  result.status = 'RESEARCH_ONLY';
  const original = result.directions[0].quotes[0];
  original.label = '大 2.5';
  const lower = fixture(league, .04, .02, 'other-over').result.directions[0].quotes[0];
  lower.label = '大 2.5';
  result.directions[0].quotes.push(lower);
  const later = now + 180001;
  const history = (state, options = {}) => buildSoccerRanking([game], { [game.id]: state },
    { includePrevious: true, now: later, ...options });
  const saved = { status: 'done', data: result };
  const previous = history(saved);
  assert.equal(previous.entries.length, 0);
  assert.equal(previous.order.length, 0);
  assert.equal(previous.previousEntries.length, 1, 'retain only the highest eligible W in each expired market');
  assert.equal(previous.previousEntries[0].quote.key, original.key);
  assert.equal(previous.previousEntries[0].score, original.predictionScore.S);
  assert.equal(previous.previousOrder[0].quote.key, original.key);
  assert.equal(soccerHighScoreCandidates([game], { [game.id]: saved }, { league, date: game.date, now: later }).candidates.length, 0);
  assert.equal(history(saved, { market: 'HT:TOTAL' }).previousEntries.length, 0);
  const pending = history({ status: 'loading', data: { ...result, publishedCurrent: false } }, { now });
  assert.equal(pending.entries.length, 0);
  assert.equal(pending.previousEntries[0]?.quote.key, original.key, 'a recheck retains the verified original price in read-only history');
  assert.equal(history(saved, { now: Date.parse(game.startTime) }).previousEntries.length, 0);
  assert.equal(history({ ...saved, data: { ...result, persisted: false } }).previousEntries.length, 0);

  // Head retrieval carries compact immutable history separately after a later
  // attempt loses usable prices. Old findings are visible again after reload.
  const priorAt = new Date(now - 240000).toISOString();
  const archivedQuote = { key: sha('7'), kind: 'TOTAL', side: 'over', line: '3.5', lineSide: null,
    period: 'FT', label: '大 3.5', water: .78, S: original.predictionScore.S,
    W: original.predictionScore.W, R: original.predictionScore.R_model, observedAt: priorAt, calculatedAt: priorAt };
  const archive = { status: 'HISTORICAL_PREDICTION', league, date: game.date, gameId: game.id, startTime: game.startTime,
    homeId: game.home.sourceId, awayId: game.away.sourceId, neutralSite: false, revision: sha('f'), observedAt: priorAt,
    eligible: false, executable: false, quotes: [archivedQuote] };
  const missing = structuredClone(result);
  missing.directions[0].quotes = [];
  const restored = { status: 'done', data: missing, historicalPrediction: archive };
  assert.equal(history(restored, { now }).previousEntries[0]?.quote.key, archivedQuote.key);
  const liveHalf = marketFixture(league, 'HT', 'HANDICAP_HOME', 'mixed-half').result;
  liveHalf.status = 'RESEARCH_ONLY';
  const mixed = history({ ...restored, data: liveHalf }, { now });
  assert.deepEqual(mixed.entries.map(entry => entry.marketKey), ['HT:HANDICAP']);
  assert.deepEqual(mixed.previousEntries.map(entry => entry.marketKey), ['FT:TOTAL']);
  assert.equal(history({ ...restored, historicalPrediction: { ...archive,
    quotes: [{ ...archivedQuote, calculatedAt: at }] } }, { now }).previousEntries.length, 0);
  for (const mismatch of [{ league: 'other' }, { gameId: 'soccer:epl:999' }, { awayId: game.home.sourceId },
    { revision: result.revision }, { startTime: new Date(now + 10000).toISOString() }, { date: '2026-11-11' }]) {
    assert.equal(history({ ...restored, historicalPrediction: { ...archive, ...mismatch } }, { now }).previousEntries.length, 0);
  }
  assert.equal(history({ ...saved, historicalPrediction: archive }, { now }).previousEntries.length, 0,
    'a live market cannot reappear in the historical list');
  const low = fixture(league, .001, -.0001).result;
  low.status = 'RESEARCH_ONLY';
  assert.equal(history({ ...saved, data: low, historicalPrediction: archive }, { now }).previousEntries.length, 0,
    'a freshly priced below-threshold market supersedes an older high score');
  for (const view of ['ranking', 'order']) {
    rankingView = view; stateIndex = 0;
    const html = renderToStaticMarkup(rankingContext.SoccerRanking({ games: [game],
      states: { [game.id]: restored }, run: () => {}, onShowResults: () => {}, now }));
    const heading = html.indexOf('上次分析｜盤口待更新');
    assert.ok(heading >= 0, 'the historical section is visible in both sort orders');
    const section = html.slice(heading, html.indexOf('</section>', heading));
    assert.match(section, /3\.5/); assert.match(section, /0\.78/); assert.match(section, /8\.00%/);
    assert.match(section, /5\.00%/); assert.match(section, /原盤時間/);
    assert.doesNotMatch(section, /<button|紀錄實際下注|重新分析/);
    assert.match(html, /目前 0 個候選方向｜上次達標 1 個方向/);
    assert.doesNotMatch(html, /class="emptySmall"|查看全部分析分數/);
  }
  rankingView = 'ranking';
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
    const batched = soccerMarketScorePresentations({ result, displayGame:game, now:clock });
    assert.deepEqual(result.directions.flatMap(direction => direction.quotes.map(quote => batched.get(direction).get(quote))), displays);
    if (item.expectRanked) {
      const changed = structuredClone(result), direction = changed.directions.find(d => d.quotes.length), quote = direction.quotes[0];
      const read = time => soccerMarketScorePresentations({ result:changed, displayGame:game, now:time }).get(direction).get(quote);
      assert.equal(read(clock).status, soccerQuoteScorePresentation({result:changed, direction, quote, displayGame:game, now:clock}).status);
      assert.equal(read(Date.parse(game.startTime)).status, 'HISTORICAL');
      changed.readerIdentityEvidence.contentHash = '0'.repeat(64);
      assert.equal(read(clock).status, 'IDENTITY_UNVERIFIED', 'a new pass must verify the receipt again even for the same result object');
    }
    assert.equal(displays.some(value => value.scoreKind === 'PREDICTION' && value.score != null), item.expectPredictionScore);
    const actual = buildSoccerRanking([game], { [game.id]: { status: 'done', data: result } }, { now: clock });
    assert.equal(actual.entries.length > 0, item.expectRanked);
    const counts = analysisContext.soccerAnalysisCounts([game], { [game.id]: { status: 'done', data: result } }, clock);
    assert.equal(counts.candidates, item.expectRanked ? 1 : 0, 'toolbar counts the same distinct current games as ranking');
    assert.ok(actual.entries.every(value => value.prediction && value.formalEligible === false));
    const html = renderToStaticMarkup(marketContext.SoccerMarketDirections({ directions: result.directions, result, game, now: clock }));
    const original = JSON.stringify(result);
    const card = soccerMatchCard(result);
    assert.equal(JSON.stringify(result), original, 'full stored result remains intact');
    assert.equal(card.revision, result.revision);
    assert.equal(renderToStaticMarkup(marketContext.SoccerMarketDirections({ directions:card.directions, result:card, game, now:clock })), html);
    for (const [i, direction] of result.directions.entries()) for (const [j, quote] of (direction.quotes || []).entries()) {
      const transported = card.directions[i].quotes[j];
      for (const [before, after] of [[quote.payoff, transported.payoff], [quote.scoring?.conditionalPayoff, transported.scoring?.conditionalPayoff]]) {
        if (Array.isArray(before?.rows)) {
          const { rows, ...fields } = before;
          assert.deepEqual(after, { ...fields, scorelineRowCount:rows.length });
        }
      }
    }
    if (item.expectPredictionScore) { assert.match(html, /預測 S/); assert.match(html, /模型情境 R/); }
    stateIndex = 0;
    const table = renderToStaticMarkup(rankingContext.SoccerRanking({ games: [game],
      states: { [game.id]: { status: 'done', data: result } }, run: () => {}, now: clock }));
    stateIndex = 0;
    assert.equal(renderToStaticMarkup(rankingContext.SoccerRanking({games:[game],
      states:{[game.id]:{status:'done',data:card}},run:()=>{},now:clock})), table);
    assert.equal((table.match(/data-soccer-rank-key=/g) || []).length, actual.entries.length);
    const historicalRows = (table.match(/data-soccer-history-key=/g) || []).length;
    if (item.name === `${game.league}-historical`) assert.ok(historicalRows > 0, 'saved qualifying predictions remain available for review');
    else assert.equal(historicalRows, 0, 'current and purely below-threshold prices have no superseded rows');
    if (item.expectRanked) { assert.match(table, /預測 S/); assert.match(table, /模型情境 R/); }
  }
  assert.deepEqual([...leagues].sort(), ['epl', 'ucl']);
}
console.log('PASS prediction UI: fixed S, exact quote/head identity, current and historical labels, locked thresholds, both ranking views, high-score reminders, explicit unverified context and optional real-service DTO → JSX');
