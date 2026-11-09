import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareSoccerScoringInputs } from '../lib/soccer/scoring-input-preparation.js';
import { acceptedSoccerRuntimeBundles, acceptedSoccerArtifactRegistrations } from '../lib/soccer/scoring-bundle-registry.js';
import { soccerScoringBundleHash as hash } from '../lib/soccer/scoring-bundle.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerScenarioResearch } from '../lib/soccer/scenario-research.js';
import { soccerResearchArtifacts } from '../lib/soccer/research-frozen.js';
import { soccerHalfTimeArtifacts } from '../lib/soccer/half-time-frozen.js';
import { predictScoreModel } from '../lib/soccer/score-model.js';
import { predictHalfTimeDistribution } from '../lib/soccer/half-time-model.js';
import { analyzeSoccerConditionalQuote } from '../lib/soccer/conditional-analysis.js';
import { fixtureScoringBundle, fixtureScoringBundleModule, fixtureScoringFactory } from './helpers/soccer-scoring-bundle-fixture.mjs';
import { fixtureCapture, sha, iso, observed } from './helpers/soccer-forward-fixture.mjs';

const receipt = at => ({ revision: sha('preparation-reader'), observationId: sha('preparation-observation'),
  observedAt: at, firstFetchedAt: at, receivedAt: at, persistedAt: at, sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/' });
const markets = ['FT', 'HT'].flatMap(period => ['HANDICAP', 'TOTAL'].map(kind => ({ unit: 'GOALS', kind, period,
  line: '1.5', lineSide: kind === 'HANDICAP' ? 'home' : null, homeWater: .9, awayWater: .9, overWater: .9, underWater: .9,
  rawRows: ['1.5 0.9', '0.9'], periodEvidence: { period, status: 'EXPLICIT', sectionTitle: '英格蘭超級聯賽',
    tableHeaders: [period === 'FT' ? '全場' : '上半場'], marketHeader: period === 'FT' ? '全場' : '上半場' } })));
function quotesFor(game, now) {
  return buildSoccerMarketDirections({ game, reader: receipt(iso(now)), now,
    matchedGames: [{ officialGameId: game.id, league: game.league.toUpperCase(), boardDate: game.date, prestart: true, matchStatus: 'MATCHED',
      markets: markets.map(market => ({ ...market, periodEvidence: { ...market.periodEvidence,
        sectionTitle: game.league === 'epl' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽' } })) }] }).flatMap(row => row.quotes);
}
function inputsFor({ game, quote, distribution, now }) {
  const source = { provider: 'EXPLICIT_SYNTHETIC_ENGINEERING_TEST_NOT_EMPIRICAL_APPROVAL', url: 'https://fixture.invalid/scoring-evidence',
    contentHash: sha('preparation-test-source'), sourcePublishedAt: iso(now - 3), fetchedAt: iso(now - 2), availableAt: iso(now - 1) };
  const scenarios = [{ id: 'synthetic-scenario', weight: 1, league: game.league, gameId: game.id, period: quote.period,
    modelVersion: distribution.modelVersion, trainingHash: distribution.trainingHash, distribution, sources: [source] }];
  const body = { version: 'SOCCER-EXPLICIT-SCENARIO-RETURNS-v1', league: game.league, period: quote.period,
    modelVersion: distribution.modelVersion, trainingHash: distribution.trainingHash, aggregation: 'WEIGHTED_Q10_AND_EMPIRICAL_ERROR',
    quantile: .10, createdAt: iso(now), trainedThrough: iso(now - 1000), scenariosHash: hash(scenarios),
    modelError: { value: .02, unit: 'NET_PROFIT_PER_1_STAKE', validationArtifactHash: sha('preparation-test-validation'), validationSamples: 20, source } };
  const uncertainty = { ...body, artifactHash: hash(body) };
  const acceptance = Object.fromEntries(['model', 'calibration', 'uncertainty'].map(kind => [kind, { status: 'VERIFIED', league: game.league,
    period: quote.period, modelVersion: distribution.modelVersion, trainingHash: distribution.trainingHash,
    artifactHash: kind === 'uncertainty' ? uncertainty.artifactHash : sha(`preparation-test-${kind}`), source }]));
  return { scenarios, uncertainty, acceptance };
}
async function withSyntheticRegistry(entries) {
  const trusted = await fixtureScoringBundleModule(entries), moduleUrl = new URL('../lib/soccer/scoring-input-preparation.js', import.meta.url);
  let code = fs.readFileSync(moduleUrl, 'utf8').replace("from './scoring-bundle.js'", `from '${trusted.url}'`);
  code = code.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\2/g,
    (_match, prefix, separator, specifier) => `${prefix}${separator}${new URL(specifier, moduleUrl).href}${separator}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).prepareSoccerScoringInputs;
}
const registryHash = hash({ acceptedSoccerRuntimeBundles, acceptedSoccerArtifactRegistrations });

// Exercise the actual frozen source models and all original FT/HT directions.
const now = Date.parse('2026-11-01T08:00:00Z'), payload = JSON.parse(fs.readFileSync('scripts/fixtures/soccer/epl-summary.json'));
payload.header.competitions[0].date = '2026-11-02T12:00:00Z'; payload.header.date = payload.header.competitions[0].date;
const source = { provider: 'ESPN', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=401878769',
  fetchedAt: iso(now), contentHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
const game = normalizeSoccerSchedule({ leagues: [payload.header.league], events: [{ ...payload.header, date: payload.header.date,
  status: payload.header.competitions[0].status }] }, 'epl', source).games[0];
const evidence = normalizeSoccerPrematch(payload, game, source, now), research = buildSoccerScenarioResearch({ game, now });
const ft = { ...predictScoreModel(soccerResearchArtifacts().leagues.epl.liveModel, { league: game.league, startTime: game.startTime,
  homeId: game.home.sourceId, awayId: game.away.sourceId, neutralSite: game.neutralSite }), league: game.league, gameId: game.id };
const ht = { ...predictHalfTimeDistribution(ft, soccerHalfTimeArtifacts().leagues.epl.liveModel, { league: game.league, startTime: game.startTime }),
  league: game.league, gameId: game.id };
const quotes = quotesFor(game, now);
assert.equal(quotes.length, 8);
const beforeHash = hash({ research, evidence, ft, ht, quotes });
for (const quote of quotes) {
  const distribution = quote.period === 'FT' ? ft : ht, context = { quote, game, distribution, evidence, scenarioResearch: research, now };
  const prepared = prepareSoccerScoringInputs(context), candidate = prepared.preparation.research;
  assert.equal(prepared.preparation.status, 'RESEARCH_INPUTS_PREPARED', JSON.stringify(prepared.preparation.blockers));
  assert.equal(prepared.preparation.runtimeAuthorityResolved, false);
  assert.equal(prepared.inputBundle.status, 'MISSING');
  assert.equal(prepared.runtimeInputs.scenarios.length, 16);
  assert.equal(prepared.runtimeInputs.uncertainty, null); assert.equal(prepared.runtimeInputs.acceptance, null);
  assert.equal(candidate.rows.length, 16); assert.equal(candidate.rowsHash, hash(candidate.rows));
  assert.equal(candidate.scenariosHash, hash(prepared.runtimeInputs.scenarios));
  assert.equal(candidate.baselineDistributionHash, hash(distribution));
  assert.equal(candidate.modelError, null); assert.equal(candidate.errorStatus, 'TOTAL_MODEL_ERROR_NOT_VALIDATED');
  assert.equal(candidate.validationEvidence.calibration.developmentGames, 17);
  assert.equal(candidate.validationEvidence.calibration.baselineModelBound, true);
  assert.equal(candidate.validationEvidence.calibration.currentProspectiveValidation, 'NOT_QUERIED_STATIC_ARTIFACT_IS_NOT_CURRENT_DB_EVIDENCE');
  assert.equal(candidate.validationEvidence.totalModelError.validationArtifactHash, null);
  assert.equal(candidate.validationEvidence.totalModelError.scenarioArtifactHash, candidate.artifactHash);
  assert.ok(prepared.preparation.blockers.includes('SOCCER_INPUT_TOTAL_MODEL_ERROR_VALIDATION_REQUIRED'));
  for (const key of ['W', 'R', 'S']) assert.equal(candidate[key], null);
  assert.equal(candidate.formalEligible, false); assert.equal(candidate.executable, false);
  // Existing payoff implementation is the independent oracle; no substitute price, midpoint or renormalization.
  assert.deepEqual(candidate.baseline.netReturnBounds, analyzeSoccerConditionalQuote({ quote, game, distribution, now }).netReturnBounds);
  for (const [index, row] of candidate.rows.entries()) {
    const oracle = analyzeSoccerConditionalQuote({ quote, game, distribution: research.periods[quote.period].scenarios[index].distribution, now });
    assert.equal(row.expectedNetReturn, oracle.exactNetReturn); assert.deepEqual(row.netReturnBounds, oracle.netReturnBounds);
    assert.equal(row.weight, 1 / 16);
  }
}
assert.equal(hash({ research, evidence, ft, ht, quotes }), beforeHash, 'preparation must not mutate source, model or quote inputs');

const uclPayload = JSON.parse(fs.readFileSync('scripts/fixtures/soccer/ucl-summary.json'));
uclPayload.header.competitions[0].date = '2026-11-02T12:00:00Z'; uclPayload.header.date = uclPayload.header.competitions[0].date;
const uclSource = { ...source, url: `https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/summary?event=${uclPayload.header.id}`,
  contentHash: createHash('sha256').update(JSON.stringify(uclPayload)).digest('hex') };
const uclGame = normalizeSoccerSchedule({ leagues: [uclPayload.header.league], events: [{ ...uclPayload.header, date: uclPayload.header.date,
  status: uclPayload.header.competitions[0].status }] }, 'ucl', uclSource).games[0];
const uclEvidence = normalizeSoccerPrematch(uclPayload, uclGame, uclSource, now), uclResearch = buildSoccerScenarioResearch({ game: uclGame, now });
const uclFT = { ...predictScoreModel(soccerResearchArtifacts().leagues.ucl.liveModel, { league: uclGame.league, startTime: uclGame.startTime,
  homeId: uclGame.home.sourceId, awayId: uclGame.away.sourceId, neutralSite: uclGame.neutralSite }), league: uclGame.league, gameId: uclGame.id };
const uclHT = { ...predictHalfTimeDistribution(uclFT, soccerHalfTimeArtifacts().leagues.ucl.liveModel, { league: uclGame.league, startTime: uclGame.startTime }),
  league: uclGame.league, gameId: uclGame.id };
for (const quote of quotesFor(uclGame, now)) {
  const prepared = prepareSoccerScoringInputs({ quote, game: uclGame, distribution: quote.period === 'FT' ? uclFT : uclHT,
    evidence: uclEvidence, scenarioResearch: uclResearch, now });
  assert.equal(prepared.preparation.status, 'RESEARCH_INPUTS_PREPARED');
  assert.equal(prepared.preparation.research.validationEvidence.calibration.developmentGames, 18);
  assert.equal(prepared.preparation.research.validationEvidence.calibration.baselineModelBound, true);
  assert.equal(prepared.runtimeInputs.scenarios.length, 16);
  assert.ok(prepared.runtimeInputs.scenarios.every(s => s.league === 'ucl' && s.gameId === uclGame.id && s.period === quote.period));
  assert.equal(prepared.runtimeInputs.acceptance, null); assert.equal(prepared.runtimeInputs.uncertainty, null);
}

const researchContext = { quote: quotes[0], game, distribution: ft, evidence, scenarioResearch: research, now };
function reject(change, reason) {
  const context = structuredClone(researchContext); change(context);
  const result = prepareSoccerScoringInputs(context);
  assert.equal(result.preparation.status, 'INPUTS_UNAVAILABLE', reason);
  assert.deepEqual(result.runtimeInputs, { scenarios: null, uncertainty: null, acceptance: null });
}
reject(x => { x.game.league = 'ucl'; }, 'cross-league game');
reject(x => { x.distribution.period = 'REGULATION_HT'; }, 'cross-period distribution');
reject(x => { x.distribution.gameId = 'soccer:epl:other'; }, 'another game distribution');
reject(x => { x.distribution.trainingHash = sha('another-training'); }, 'different training baseline');
reject(x => { x.distribution.cells[0].probability += .001; }, 'same artifact label cannot authorize changed distribution');
reject(x => { x.evidence.source.fetchedAt = iso(now + 1); }, 'future evidence');
reject(x => { x.evidence.game.home.sourceId = 'other'; }, 'evidence team identity');
reject(x => { x.now += 180001; }, 'stale source/quote');
reject(x => { x.now = Date.parse(game.startTime) + 1; }, 'after kickoff');
reject(x => { x.scenarioResearch.periods.FT.scenarios[0].league = 'ucl'; }, 'cross-league scenario');
reject(x => { x.scenarioResearch.periods.FT.scenarios[0].period = 'HT'; }, 'cross-period scenario');
reject(x => { x.scenarioResearch.periods.FT.scenarios[0].weight = .1; }, 'mutated weights');
reject(x => { x.scenarioResearch.periods.FT.scenarios.pop(); }, 'missing scenario');
reject(x => { x.scenarioResearch.createdAt = iso(now + 1); }, 'future source artifact');
// WeakMap reuse cannot hide a mutation of a previously verified research object.
const mutableResearch = structuredClone(research);
assert.equal(prepareSoccerScoringInputs({ ...researchContext, scenarioResearch: mutableResearch }).preparation.status, 'RESEARCH_INPUTS_PREPARED');
mutableResearch.periods.FT.scenarios[0].distribution.cells[0].probability += .001;
assert.equal(prepareSoccerScoringInputs({ ...researchContext, scenarioResearch: mutableResearch }).preparation.status, 'INPUTS_UNAVAILABLE');
for (const fake of [{ modelError: { value: .01, source: 'REALIZED_RETURN_RESIDUAL' } },
  { version: 'MODEL_FAMILY_CONFIDENCE_ONLY', confidence: .99, modelError: { value: .01 } }]) {
  const result = prepareSoccerScoringInputs({ ...researchContext, uncertainty: fake, acceptance: { model: { status: 'VERIFIED' } },
    registeredScoringBundles: [{ inputs: fake }], bundle: { status: 'AVAILABLE', inputs: fake } });
  assert.equal(result.runtimeInputs.uncertainty, null); assert.equal(result.runtimeInputs.acceptance, null);
  assert.equal(result.preparation.research.modelError, null);
  assert.equal(result.inputBundle.code, 'SOCCER_SCORING_BUNDLE_MISSING');
}

// Synthetic registry replacement tests engineering capability only, never empirical acceptance.
const capture = fixtureCapture(), trustedGame = capture.snapshot.evidence.game, trustedNow = observed;
const trustedContext = { game: trustedGame, now: trustedNow, quote: quotesFor(trustedGame, trustedNow)[0],
  distribution: { ...capture.snapshot.prediction, league: trustedGame.league, gameId: trustedGame.id }, evidence: { ...capture.snapshot.evidence, ok: true } };
const inputs = inputsFor(trustedContext), registered = fixtureScoringBundle(trustedContext, inputs);
const trustedPrepare = await withSyntheticRegistry([registered]);
const trustedResult = trustedPrepare(trustedContext);
assert.equal(trustedResult.preparation.status, 'TRUSTED_RUNTIME_INPUTS_AVAILABLE');
assert.equal(trustedResult.preparation.runtimeAuthorityResolved, true);
assert.equal(trustedResult.inputBundle.status, 'AVAILABLE'); assert.deepEqual(trustedResult.runtimeInputs, inputs);
assert.equal(trustedResult.preparation.research, null, 'registered authority wins without requiring a research substitute');
trustedResult.runtimeInputs.uncertainty.modelError.value = 99;
assert.deepEqual(trustedPrepare(trustedContext).runtimeInputs, inputs, 'resolved inputs are detached');
const reviewedFactoryPrepare = await withSyntheticRegistry([fixtureScoringFactory(trustedContext, inputs)]);
assert.equal(reviewedFactoryPrepare(trustedContext).preparation.status, 'TRUSTED_RUNTIME_INPUTS_AVAILABLE');
const changedQuoteContext = { ...trustedContext, quote: quotesFor(trustedGame, trustedNow).find(q => q.key !== trustedContext.quote.key && q.period === 'FT') };
assert.equal(reviewedFactoryPrepare(changedQuoteContext).preparation.status, 'TRUSTED_RUNTIME_INPUTS_AVAILABLE', 'reviewed factory binds a second original quote through the same real resolver');
const changedModel = { ...trustedContext, distribution: { ...trustedContext.distribution, homeRate: 10 } };
assert.notEqual(trustedPrepare(changedModel).preparation.status, 'TRUSTED_RUNTIME_INPUTS_AVAILABLE');
for (const mutate of [x => { delete x.uncertainty.modelError; }, x => { x.uncertainty.modelError.unit = 'REALIZED_RETURN_NOISE'; },
  x => { x.uncertainty.modelError.validationSamples = 0; }, x => { x.scenarios[0].sources[0].availableAt = iso(trustedNow + 1); }]) {
  const invalid = structuredClone(inputs); mutate(invalid);
  const prepared = (await withSyntheticRegistry([fixtureScoringBundle(trustedContext, invalid)]))(trustedContext);
  assert.notEqual(prepared.preparation.status, 'TRUSTED_RUNTIME_INPUTS_AVAILABLE', 'existing resolver acceptance requirements stay unchanged');
  assert.equal(prepared.runtimeInputs.uncertainty, null); assert.equal(prepared.runtimeInputs.acceptance, null);
}
assert.equal(prepareSoccerScoringInputs({ ...trustedContext, ...inputs, registeredScoringBundles: [registered] }).preparation.runtimeAuthorityResolved, false);
assert.equal(hash({ acceptedSoccerRuntimeBundles, acceptedSoccerArtifactRegistrations }), registryHash);
assert.equal(acceptedSoccerRuntimeBundles.length, 0); assert.equal(acceptedSoccerArtifactRegistrations.length, 0);
console.log('PASS bound soccer scoring preparation: real frozen source reconstruction, 16 scenario payoffs for all eight FT/HT sides, scope/hash/cutoff isolation, unchanged total-error and acceptance requirements, server bundle/factory priority, detached inputs, no caller registry authority; synthetic trusted fixtures are engineering-only');

// The existing dedicated loader supplies synthetic schedule authority ONLY in
// this isolated engineering process. Production identity tests run without it.
const { register } = await import('node:module');
register('./soccer-synthetic-identity-loader.mjs', import.meta.url);
const { buildSoccerAnalysis } = await import('../lib/soccer/analysis.js');
for (const [analysisGame, originalEvidence] of [[game, evidence], [uclGame, uclEvidence]]) {
  const analysisEvidence = structuredClone(originalEvidence);
  analysisEvidence.scheduleSource = { ...analysisEvidence.source,
    url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${analysisGame.league === 'epl' ? 'eng.1' : 'uefa.champions'}/scoreboard?dates=20261102`,
    contentHash: sha(`synthetic-schedule-${analysisGame.league}`) };
  const reader = { ...receipt(iso(now)), league: analysisGame.league.toUpperCase(), games: [{ league: analysisGame.league.toUpperCase(),
    boardDate: analysisGame.date, boardTime: '20:00', homeKey: globalThis.Tai888SoccerTeams.key(analysisGame.home.name),
    awayKey: globalThis.Tai888SoccerTeams.key(analysisGame.away.name), markets }] };
  const schedule = { ok: true, league: { id: analysisGame.league }, date: analysisGame.date, until: analysisGame.date,
    games: [analysisGame], coverage: { complete: true, identityComplete: true } };
  const analysis = buildSoccerAnalysis({ evidence: analysisEvidence, reader, schedule, now }), boundQuotes = analysis.directions.flatMap(d => d.quotes);
  assert.equal(boundQuotes.length, 8); assert.equal(analysis.scoringInputReadiness.trustedBundleQuoteCount, 0);
  for (const quote of boundQuotes) {
    const prepared = quote.scoring.inputPreparation;
    assert.equal(prepared.status, 'RESEARCH_INPUTS_PREPARED'); assert.equal(prepared.sourceQuoteKey, quote.key);
    assert.equal(prepared.research.rows.length, 16); assert.equal(prepared.gameId, analysisGame.id);
    assert.equal(quote.scoring.inputBundle.code, 'SOCCER_SCORING_BUNDLE_MISSING');
    for (const field of ['W', 'R', 'S']) assert.equal(quote.scoring[field], null);
    assert.equal(quote.scoring.formalScoringEnabled, false); assert.equal(quote.scoring.calculationInputs, null);
    assert.equal(quote.conditionalAnalysis.status, 'CONDITIONAL_RESEARCH');
    assert.equal(quote.scenarioScore.status, 'PARAMETER_SENSITIVITY_ONLY');
    assert.deepEqual(prepared.research.baseline.netReturnBounds, quote.conditionalAnalysis.netReturnBounds);
    assert.equal(quote.scenarioScore.scenarioCount, prepared.research.count);
  }
}
console.log('PASS real EPL/UCL analysis integration with explicitly synthetic schedule authority: original quotes feed source-recomputed preparation, unchanged conditional/scenario arithmetic and missing registry still prevent formal W/R/S');
