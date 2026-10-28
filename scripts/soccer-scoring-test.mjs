import * as soccerReadiness from '../lib/soccer/scoring-readiness.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { adaptSoccerReaderQuote, evaluateSoccerScenarioReturns, scoreSoccerQuote, soccerScoringHash,
  SOCCER_SCENARIO_ARITHMETIC_VERSION } from '../lib/soccer/soccer-scoring.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { scoreDistribution } from '../lib/soccer/score-model.js';
import { predictHalfTimeDistribution, HALF_TIME_MODEL_VERSION, HALF_TIME_PROTOCOL_VERSION } from '../lib/soccer/half-time-model.js';
import { deterministicScore, SCORE_FORMULA_VERSION } from '../lib/deterministic-score.js';
import { publishSoccerAnalysisCandidates } from '../lib/soccer/candidate-publication.js';
import { soccerCandidatePayloadValid } from '../lib/soccer/candidate-qualification.js';
import { buildSoccerRanking } from '../lib/soccer/ranking.js';
import { soccerQuoteScorePresentation } from '../lib/soccer/score-presentation.js';
import { fixtureScoringBundle, fixtureScoringBundleModule, fixtureScoringFactory } from './helpers/soccer-scoring-bundle-fixture.mjs';

const now = Date.parse('2026-10-20T00:00:00Z'), at = new Date(now).toISOString();
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const source = { provider: 'REPRODUCIBLE_SYNTHETIC_TEST_NOT_EMPIRICAL_VALIDATION', url: 'https://fixture.invalid/validation',
  contentHash: 'a'.repeat(64), sourcePublishedAt: '2026-10-19T00:00:00Z', fetchedAt: '2026-10-19T00:00:01Z', availableAt: '2026-10-19T00:00:02Z' };
function fixture(league = 'epl', period = 'FT', line = '2.5', kind = 'TOTAL', water = .95) {
  const game = { id: `soccer:${league}:123`, sourceId: '123', league, date: '2026-10-20', startTime: '2026-10-20T12:00:00Z',
    status: 'scheduled', home: { sourceId: '359', name: 'Arsenal' }, away: { sourceId: '364', name: 'Liverpool' } };
  const reader = { revision: 'b'.repeat(64), observationId: 'c'.repeat(64), observedAt: at, firstFetchedAt: at,
    receivedAt: at, persistedAt: at, sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/' };
  const market = { kind, unit: 'GOALS', period, line, overWater: water, underWater: .9, homeWater: water, awayWater: .9, lineSide: kind === 'HANDICAP' ? 'home' : null,
    rawRows: [`大 ${line} ${water}`, '小 0.9'], periodEvidence: { sectionTitle: league === 'epl' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽',
      tableHeaders: [period === 'FT' ? '全場' : '上半場'], marketHeader: `${period === 'FT' ? '全場' : '上半場'}${kind === 'TOTAL' ? '大小' : '讓球'}`, period, status: 'EXPLICIT' } };
  const directions = buildSoccerMarketDirections({ game, reader, now, matchedGames: [{ officialGameId: game.id, league: league.toUpperCase(),
    boardDate: game.date, prestart: true, matchStatus: 'MATCHED', markets: [market] }] });
  const quote = directions.find(direction => direction.period === period && direction.direction === (kind === 'TOTAL' ? 'TOTAL_OVER' : 'HANDICAP_HOME')).quotes[0];
  const grid = (over = .53, tailMass = 0) => ({ league, gameId: game.id, period: period === 'FT' ? 'REGULATION_FT' : 'REGULATION_HT',
    modelVersion: 'SYNTHETIC_FOOTBALL_MODEL_NOT_APPROVED', trainingHash: 'd'.repeat(64),
    cells: [{ home: 2, away: 1, probability: over }, { home: 1, away: 0, probability: 1 - over - tailMass }], retainedMass: 1 - tailMass, tailMass });
  const contract = { type: 'CREDIT_BOUNDARY', period, rebate: { rate: .01, basis: 'TOTAL_PRINCIPAL' },
    provenance: { status: 'ASSUMPTION', note: 'Synthetic arithmetic only; no provider approval' } };
  const scenarios = [.54, .52].map((over, index) => ({ id: `football-${index}`, weight: .5, league, gameId: game.id, period,
    modelVersion: 'SYNTHETIC_FOOTBALL_MODEL_NOT_APPROVED', trainingHash: 'd'.repeat(64), sources: [source], distribution: grid(over) }));
  const uncertaintyBody = { version: SOCCER_SCENARIO_ARITHMETIC_VERSION, league, period,
    modelVersion: 'SYNTHETIC_FOOTBALL_MODEL_NOT_APPROVED', trainingHash: 'd'.repeat(64), aggregation: 'WEIGHTED_Q10_AND_EMPIRICAL_ERROR', quantile: .10,
    createdAt: at, trainedThrough: '2026-10-18T00:00:00Z', scenariosHash: soccerScoringHash(scenarios),
    modelError: { value: .01, unit: 'NET_PROFIT_PER_1_STAKE', validationArtifactHash: 'e'.repeat(64), validationSamples: 100, source } };
  const uncertainty = { ...uncertaintyBody, artifactHash: soccerScoringHash(uncertaintyBody) };
  return { game, quote, distribution: grid(), contract, scenarios, uncertainty, now, grid };
}
function reseal(input) {
  const { grid: ignoredGrid, ...data } = input, copy = structuredClone(data);
  copy.uncertainty.scenariosHash = soccerScoringHash(copy.scenarios);
  const { artifactHash: ignored, ...body } = copy.uncertainty;
  copy.uncertainty.artifactHash = soccerScoringHash(body);
  return copy;
}

// Exercise the shipped raw Reader adapter, not a copied quote builder.
for (const league of ['epl', 'ucl']) for (const period of ['FT', 'HT']) {
  const input = fixture(league, period), adapted = adaptSoccerReaderQuote(input);
  assert.equal(adapted.ok, true, JSON.stringify(adapted));
  assert.deepEqual(adapted.quote, { period, kind: 'TOTAL', direction: 'OVER', sourceLine: '2.5', lineSide: null, water: .95, waterFormat: 'PROFIT_PER_UNIT' });
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverse(value[key])])) : value;
  assert.equal(adaptSoccerReaderQuote({ ...input, quote: reverse(input.quote) }).ok, true, 'JSONB order does not change source quote identity');
  const computed = scoreSoccerQuote(input);
  assert.equal(computed.status, 'RESEARCH_FIXED_SCORE'); assert.equal(computed.availableThrough, 'FIXED_S_DIAGNOSTIC');
  close(computed.conditionalPayoff.netEV, .0435); close(computed.conditionalPayoff.profitProbabilities.profitable, .53);
  close(computed.conditionalPayoff.profitProbabilities.losing, .47); close(computed.scenarioReturns.conditionalWeightedReturn, .0435);
  close(computed.scenarioReturns.q10, .024); close(computed.scenarioReturns.conditionalRobustReturn, .024);
  const original = deterministicScore({ weightedEV: .0435, robustEV: .024, actualWater: true, qaPassed: true, executable: false });
  assert.equal(computed.fixedScoreDiagnostic.score, original.score); assert.equal(computed.scoreFormulaVersion, SCORE_FORMULA_VERSION);
  assert.equal(computed.W, null); assert.equal(computed.R, null); assert.equal(computed.score, null); assert.equal(computed.eligible, false);
  assert.equal(computed.formalScoringEnabled, false); assert.equal(computed.executable, false);
  assert.equal(computed.provenance.contractRegistered, false); assert.equal(computed.provenance.registeredAcceptanceCount, 0);
  assert.ok(computed.reasons.includes('SOCCER_SCORE_MODEL_ACCEPTANCE_NOT_REGISTERED'));
  assert.equal(computed.stages.find(stage => stage.stage === 'FORMAL_ACCEPTANCE').status, 'BLOCKED');
  assert.equal(computed.stages.at(-1).stage, 'CURRENT_PUBLICATION'); assert.equal(computed.stages.at(-1).status, 'PENDING');
  assert.equal(computed.calculationEligible, false); assert.equal(computed.eligibilityAuthority, 'ATOMIC_CURRENT_PUBLICATION_REQUIRED');
}
console.log('PASS exact Reader quote → scoped per-score payoff → football scenario weighted/q10/explicit-margin → unchanged fixed S; EPL/UCL and HT/FT stay research-only without registered evidence');

const input = fixture(), before = JSON.stringify(input);
for (const patch of [{ water: 1.9 }, { line: '3.5' }, { side: 'under' }, { period: 'HT' }, { unit: 'CORNERS' }, { key: 'f'.repeat(64) },
  { fresh: false }, { prestart: false }, { sourceQuoteKey: undefined }, { provenance: { ...input.quote.provenance, gameId: 'soccer:ucl:123' } },
  { provenance: { ...input.quote.provenance, readerObservationId: null } }, { provenance: { ...input.quote.provenance, persistedAt: null } },
  { provenance: { ...input.quote.provenance, receivedAt: '2026-10-20T00:00:01Z' } }, { provenance: { ...input.quote.provenance, sourceHost: 'evil.invalid' } },
  { provenance: { ...input.quote.provenance, periodEvidence: { ...input.quote.provenance.periodEvidence, marketHeader: '上半場大小' } } }])
  assert.equal(adaptSoccerReaderQuote({ ...input, quote: { ...input.quote, ...patch } }).ok, false, JSON.stringify(patch));
assert.equal(adaptSoccerReaderQuote({ ...input, now: now + 180000 }).ok, false, 'exact freshness expiry rejects current qualification');
assert.equal(adaptSoccerReaderQuote({ ...input, game: { ...input.game, status: 'live' } }).ok, false);
assert.equal(adaptSoccerReaderQuote({ ...input, game: { ...input.game, date: '2026-02-30' } }).ok, false);
assert.equal(adaptSoccerReaderQuote({ ...input, game: { ...input.game, away: input.game.home } }).ok, false);
assert.equal(scoreSoccerQuote({ ...input, contract: null }).status, 'NOT_CALCULABLE');
for (const patch of [{ league: 'ucl' }, { kind: 'HANDICAP' }, { line: '3.5' }])
  assert.equal(scoreSoccerQuote({ ...input, contract: { ...input.contract, ...patch } }).conditionalPayoff.code, 'SOCCER_SCORE_CONTRACT_SCOPE_MISMATCH');
assert.equal(scoreSoccerQuote({ ...input, scenarios: null }).status, 'CONDITIONAL_PAYOFF_ONLY');
assert.equal(scoreSoccerQuote({ ...input, scenarios: null }).fixedScoreDiagnostic, null);
console.log('PASS source field tampering, game/period/direction isolation, receipt/availability/hash guards, missing contract and explicit stage progress');

// No scalar R, default margin or arbitrary VERIFIED flag can complete the workflow.
const mathQuote = adaptSoccerReaderQuote(input).quote;
const scenarioRun = patch => evaluateSoccerScenarioReturns({ ...input, ...patch, quote: mathQuote });
assert.equal(scenarioRun({}).ok, true, 'the control fixture reaches scenario arithmetic before rejection cases are changed');
for (const patch of [{ modelError: undefined }, { modelError: { ...input.uncertainty.modelError, value: -.01 } },
  { modelError: { ...input.uncertainty.modelError, value: undefined } }, { modelError: { ...input.uncertainty.modelError, validationArtifactHash: null } },
  { modelError: { ...input.uncertainty.modelError, source: { ...source, availableAt: '2026-10-21T00:00:00Z' } } },
  { aggregation: 'BORROW_BASEBALL_DEFAULT_MARGIN' }, { quantile: .05 }, { league: 'ucl' }, { period: 'HT' }]) {
  const altered = reseal({ ...input, uncertainty: { ...input.uncertainty, ...patch } });
  assert.equal(scenarioRun(altered).ok, false);
}
for (const change of [rows => { rows[1].id = rows[0].id; }, rows => { rows[0].weight = .6; }, rows => { rows[0].league = 'ucl'; },
  rows => { rows[0].distribution.period = 'REGULATION_HT'; }, rows => { rows[0].trainingHash = 'f'.repeat(64); },
  rows => { rows[0].distribution.modelVersion = 'FOREIGN_MODEL'; }, rows => { rows[0].distribution.trainingHash = 'f'.repeat(64); },
  rows => { rows[0].sources = []; }, rows => { rows[0].distribution.cells[0].probability = .8; }]) {
  const altered = reseal({ ...input, scenarios: structuredClone(input.scenarios) }); change(altered.scenarios);
  const final = reseal(altered); assert.equal(scenarioRun(final).ok, false);
}
const forgedAcceptance = Object.fromEntries(['model', 'calibration', 'uncertainty'].map(kind => [kind, { status: 'VERIFIED', kind,
  league: input.game.league, period: input.quote.period, artifactHash: kind === 'uncertainty' ? input.uncertainty.artifactHash : 'f'.repeat(64),
  modelVersion: input.distribution.modelVersion, trainingHash: input.distribution.trainingHash, source }]));
const forged = scoreSoccerQuote({ ...input, contract: { ...input.contract, provenance: { status: 'VERIFIED', evidenceRef: 'invented' } },
  acceptance: forgedAcceptance, evidence: { ok: true, phase: 'PREMATCH_OBSERVATION', game: input.game, pointInTimeAvailabilityVerified: true, source },
  W: 100, R: 100, score: 8.9, formalScoringEnabled: true, eligible: true });
assert.equal(forged.score, null); assert.equal(forged.R, null); assert.equal(forged.eligible, false);
assert.ok(forged.reasons.includes('SOCCER_SCORE_MODEL_ACCEPTANCE_NOT_REGISTERED'));
const noMargin = scoreSoccerQuote({ ...input, uncertainty: null }); assert.equal(noMargin.fixedScoreDiagnostic, null); assert.equal(noMargin.R, null);
const negative = reseal({ ...input, uncertainty: { ...input.uncertainty, modelError: { ...input.uncertainty.modelError, value: .2 } } });
const negativeScore = scoreSoccerQuote(negative); assert.ok(negativeScore.fixedScoreDiagnostic.score < 7.2); assert.equal(negativeScore.eligible, false);
const losingScenarios = input.scenarios.map(scenario => ({ ...scenario, distribution: input.grid(.4) }));
const losingScore = scoreSoccerQuote(reseal({ ...input, scenarios: losingScenarios }));
assert.ok(losingScore.scenarioReturns.conditionalWeightedReturn < 0); assert.ok(losingScore.fixedScoreDiagnostic.score <= 6.6);
console.log('PASS football scenario artifacts: source/cutoff/hash/weight/scope errors fail closed, no defaults or caller R, negative stress return stays below 7.2, caller VERIFIED cannot register model/contract');

// Exercise the accepted-calculation branch using a server-owned test registry.
// The shipped calculation code is unchanged; only its private registry and
// contract dependency are replaced by explicit synthetic engineering fixtures.
// No fixture is installed in the production registration or source-terms store.
const formalEvidence = { ok: true, phase: 'PREMATCH_OBSERVATION', game: input.game, source,
  pointInTimeAvailabilityVerified: true, teams: {}, xg: { status: 'VERIFIED', source }, travel: { status: 'VERIFIED', source },
  weather: { status: 'VERIFIED', source }, referee: { status: 'VERIFIED', source } };
for (const [side, offset] of [['home', 100], ['away', 200]]) formalEvidence.teams[side] = {
  sourceId: input.game[side].sourceId, lineup: { status: 'VERIFIED', source, starters: Array.from({ length: 11 }, (_, i) => ({ id: String(offset + i) })) },
  injuries: { status: 'VERIFIED', source }, suspensions: { status: 'VERIFIED', source }, minutes: { status: 'VERIFIED', source, modelEffectApplied: true } };
const registrations = Object.entries(forgedAcceptance).map(([kind, manifest]) => ({ kind, league: 'epl', period: 'FT', manifestHash: soccerScoringHash(manifest) }));
const moduleUrl = new URL('../lib/soccer/soccer-scoring.js', import.meta.url);
let registeredCode = fs.readFileSync(moduleUrl, 'utf8').replace("import { acceptedSoccerArtifactRegistrations as acceptedArtifacts } from './scoring-bundle-registry.js';", `const acceptedArtifacts = Object.freeze(${JSON.stringify(registrations)});`);
registeredCode = registeredCode.replace("import { soccerVerifiedSettlementContract } from './settlement-contract.js';", `const soccerVerifiedSettlementContract = () => (${JSON.stringify(input.contract)});`);
registeredCode = registeredCode.replace("from 'decimal.js'", `from ${JSON.stringify(import.meta.resolve('decimal.js'))}`);
registeredCode = registeredCode.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\2/g, (_match, prefix, separator, specifier) => `${prefix}${separator}${new URL(specifier, moduleUrl).href}${separator}`);
const { scoreSoccerQuote: registeredCalculation } = await import(`data:text/javascript;base64,${Buffer.from(registeredCode).toString('base64')}`);
const acceptedInputs = { ...input, evidence: formalEvidence, acceptance: forgedAcceptance, publishedCurrent: true, persisted: true };
const acceptedCalculation = registeredCalculation(acceptedInputs);
assert.equal(acceptedCalculation.status, 'FORMAL_CALCULATED_AWAITING_PUBLICATION');
assert.equal(acceptedCalculation.calculationEligible, true); assert.ok(acceptedCalculation.score >= 7.2);
assert.equal(acceptedCalculation.eligible, false); assert.equal(acceptedCalculation.executable, false);
assert.equal(acceptedCalculation.eligibilityAuthority, 'ATOMIC_CURRENT_PUBLICATION_REQUIRED');
assert.equal(acceptedCalculation.stages.at(-1).status, 'PENDING');
assert.ok(acceptedCalculation.reasons.includes('SOCCER_SCORE_ATOMIC_CURRENT_PUBLICATION_REQUIRED'));
assert.equal(scoreSoccerQuote(acceptedInputs).calculationEligible, false, 'test registration cannot leak into the real production module');
assert.equal(registeredCalculation({ ...acceptedInputs, evidence: { ...formalEvidence, weather: null } }).calculationEligible, false);
console.log('PASS actual accepted-calculation branch: registered arithmetic may qualify for publication but cannot authorize a current candidate, even with caller persisted/publishedCurrent flags; missing evidence revokes calculation eligibility');

// Reuse the actual accepted scorer test module in the publication wrapper. Only
// private test registrations differ; production still ships empty registrations.
const scorerTestUrl = `data:text/javascript;base64,${Buffer.from(registeredCode).toString('base64')}`;
const bundleContext={quote:input.quote,game:input.game,distribution:input.distribution,evidence:formalEvidence,now};
const trustedBundle=fixtureScoringBundle(bundleContext,acceptedCalculation.calculationInputs);
const bundleFixture=await fixtureScoringBundleModule([trustedBundle]);
const bundleResolution=bundleFixture.module.resolveSoccerScoringBundle(bundleContext);
assert.equal(bundleResolution.status,'AVAILABLE','only the isolated test registry contains this synthetic runtime bundle');
const publisherUrl = new URL('../lib/soccer/candidate-publication.js', import.meta.url);
let publisherCode = fs.readFileSync(publisherUrl, 'utf8').replace("'./soccer-scoring.js'", JSON.stringify(scorerTestUrl));
publisherCode=publisherCode.replace("'./scoring-bundle.js'",JSON.stringify(bundleFixture.url));
publisherCode = publisherCode.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\2/g, (_m, prefix, separator, specifier) => `${prefix}${separator}${new URL(specifier, publisherUrl).href}${separator}`);
const { publishSoccerAnalysisCandidates: testPublish } = await import(`data:text/javascript;base64,${Buffer.from(publisherCode).toString('base64')}`);
const currentReceipt = { analysisRunId: 'synthetic-run-123', qualificationVersion: '1', quoteGeneration: '1', revision: 'f'.repeat(64),
  checkedAt: at, validUntil: new Date(now + 180000).toISOString(), publishedCurrent: true, reason: 'ACTIVE',
  analysisStatus: 'COMPLETED', selectionResult: 'RESEARCH_SHADOW', executable: false };
const snapshot = { gameId: input.game.id, league: input.game.league, date: input.game.date, observedAt: at,
  analysisRunId: currentReceipt.analysisRunId, qualificationVersion: '1', quoteGeneration: '1', revision: currentReceipt.revision,
  validUntil: currentReceipt.validUntil, persisted: true, publishedCurrent: true, analysisStatus: 'COMPLETED', qaFlag: 'WARN',
  selectionResult: 'RESEARCH_SHADOW', executable: false, formalScoringEnabled: false, evidence: formalEvidence, prediction: input.distribution,
  directions: [{ period: 'FT', direction: 'TOTAL_OVER', score: null, W: null, R: null, eligible: false, executable: false,
    qaFlag: 'WARN', quotes: [{ ...input.quote, scoring: {...acceptedCalculation,inputBundle:bundleResolution.receipt} }] }] };
const untouchedSnapshot = JSON.stringify(snapshot);
const published = testPublish(snapshot, { currentStatus: currentReceipt, now });
assert.equal(published.formalScoringEnabled, true); assert.equal(published.directions[0].quotes[0].eligible, true);
assert.equal(soccerCandidatePayloadValid(published, now), true);
const presentation=soccerQuoteScorePresentation({result:published,direction:published.directions[0],quote:published.directions[0].quotes[0],now});
assert.equal(presentation.score,acceptedCalculation.score);assert.equal(presentation.status,'QUALIFIED');
const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{transform}=await import('next/dist/build/swc/index.js'),{default:vm}=await import('node:vm');
const marketSource=fs.readFileSync(new URL('../app/soccer/market-panel.js',import.meta.url),'utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const marketCode=await transform(marketSource,{filename:'soccer-actual-score.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const marketContext=vm.createContext({...soccerReadiness,React,soccerQuoteScorePresentation,SoccerRecordButton:()=>null});vm.runInContext(marketCode.code,marketContext);
const scoredMarkup=renderToStaticMarkup(marketContext.SoccerMarketDirections({directions:published.directions,result:published,game:input.game,now}));
assert.ok(scoredMarkup.includes(`<strong>${acceptedCalculation.score.toFixed(1)}</strong>`));
assert.match(scoredMarkup,/W \+4.35%｜R \+2.40%/);assert.match(scoredMarkup,/通過排名門檻/);
assert.match(scoredMarkup,/目前符合排名 1 筆/);
const historicalMarkup=renderToStaticMarkup(marketContext.SoccerMarketDirections({directions:published.directions,result:published,game:input.game,now:now+180000}));
assert.match(historicalMarkup,/目前符合排名 0 筆/);assert.match(historicalMarkup,/歷史分數 1 筆/);
assert.match(historicalMarkup,/只登記你已自行完成的下注，不代表通過排名/);
const changedMarkup=renderToStaticMarkup(marketContext.SoccerMarketDirections({directions:published.directions,result:published,game:{...input.game,away:{...input.game.away,sourceId:'999'}},now}));
assert.match(changedMarkup,/賽事資料已更新・待重新評分/);assert.doesNotMatch(changedMarkup,/通過排名門檻/);
assert.equal(buildSoccerRanking([input.game], { [input.game.id]: { status: 'done', data: published } }, { now }).entries.length, 1);
assert.equal(JSON.stringify(snapshot), untouchedSnapshot, 'publishing cannot mutate the immutable saved snapshot');
assert.equal(publishSoccerAnalysisCandidates(snapshot, { currentStatus: currentReceipt, now }).formalScoringEnabled, false,
  'shipped empty registries must reject synthetic accepted flags');
for (const patch of [{ publishedCurrent: false }, { revision: 'a'.repeat(64) }, { analysisRunId: 'another-run-123' },
  { qualificationVersion: '2' }, { quoteGeneration: '2' }, { checkedAt: new Date(now + 1).toISOString() },
  { validUntil: at }, { reason: 'QUOTE_CHANGED' }]) {
  assert.equal(testPublish(snapshot, { currentStatus: { ...currentReceipt, ...patch }, now }).formalScoringEnabled, false, JSON.stringify(patch));
}
for (const alter of [s => { s.directions[0].quotes[0].water = 1.2; }, s => { s.directions[0].quotes[0].scoring.W += .01; },
  s => { s.prediction.cells[0].probability -= .01; }, s => { s.evidence.weather = null; },
  s => { s.directions[0].quotes[0].scoring.calculationInputs.acceptance.model.status = 'ASSUMPTION'; }]) {
  const changed = structuredClone(snapshot); alter(changed);
  assert.equal(testPublish(changed, { currentStatus: currentReceipt, now }).formalScoringEnabled, false);
}
console.log('PASS real scorer → server revalidation → exact-quote current projection → ranking; receipt races, modified price/model/manifest and revoked registries fail closed');

// Revalidate low calculations too: the threshold only controls ranking. Losing
// current authority must not leave either a high or low score looking current.
async function publisherForBundles(bundles) {
  const registered=await fixtureScoringBundleModule(bundles);
  let code=fs.readFileSync(publisherUrl,'utf8').replace("'./soccer-scoring.js'",JSON.stringify(scorerTestUrl))
    .replace("'./scoring-bundle.js'",JSON.stringify(registered.url));
  code=code.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\2/g,(_m,prefix,separator,specifier)=>`${prefix}${separator}${new URL(specifier,publisherUrl).href}${separator}`);
  return {publish:(await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).publishSoccerAnalysisCandidates,
    resolve:registered.module.resolveSoccerScoringBundle};
}
const lowQuote=fixture('epl','FT','2.5','TOTAL',.5).quote;
const lowCalculation=registeredCalculation({...acceptedInputs,quote:lowQuote});
assert.equal(lowCalculation.formalScoringEnabled,true);assert.equal(lowCalculation.calculationEligible,false);
assert.ok(lowCalculation.score<7.2);
const lowContext={...bundleContext,quote:lowQuote},lowBundle=fixtureScoringBundle(lowContext,lowCalculation.calculationInputs);
const bothPublisher=await publisherForBundles([trustedBundle,lowBundle]);
const lowSnapshot=structuredClone(snapshot);
lowSnapshot.directions[0].quotes=[{...lowQuote,scoring:{...lowCalculation,inputBundle:bothPublisher.resolve(lowContext).receipt}}];
const displayPublished=(result,time=now)=>soccerQuoteScorePresentation({result,direction:result.directions[0],quote:result.directions[0].quotes[0],now:time});
for(const original of [snapshot,lowSnapshot]) {
  const savedOriginal=JSON.stringify(original),fresh=bothPublisher.publish(original,{currentStatus:currentReceipt,now});
  const quote=fresh.directions[0].quotes[0];
  assert.equal(quote.calculationValidity.status,'CURRENT_VERIFIED');
  assert.equal(displayPublished(fresh).status,original===snapshot?'QUALIFIED':'BELOW_THRESHOLD');
  const revoked=publishSoccerAnalysisCandidates(original,{currentStatus:currentReceipt,now});
  assert.equal(revoked.directions[0].quotes[0].calculationValidity.status,'HISTORICAL_ONLY');
  assert.equal(displayPublished(revoked).status,'HISTORICAL');
  assert.equal(displayPublished(revoked).score,original.directions[0].quotes[0].scoring.score);
  assert.equal(buildSoccerRanking([input.game],{[input.game.id]:{status:'done',data:revoked}},{now}).entries.length,0);
  assert.equal(JSON.stringify(original),savedOriginal,'read-time revocation keeps the original saved calculation unchanged');
  const currentQuote=original.directions[0].quotes[0],context={...bundleContext,quote:currentQuote};
  const shortBundle=fixtureScoringBundle(context,currentQuote.scoring.calculationInputs,{expiresAt:new Date(now+1000).toISOString()});
  const shortPublisher=await publisherForBundles([shortBundle]);
  const shortSnapshot=structuredClone(original);
  shortSnapshot.directions[0].quotes[0].scoring.inputBundle=shortPublisher.resolve(context).receipt;
  const shortFresh=shortPublisher.publish(shortSnapshot,{currentStatus:currentReceipt,now});
  assert.equal(shortFresh.directions[0].quotes[0].calculationValidity.status,'CURRENT_VERIFIED');
  if(original===snapshot)assert.equal(shortFresh.directions[0].quotes[0].qualification.validUntil,new Date(now+1000).toISOString(),'candidate lifetime cannot outlast its trusted bundle');
  assert.equal(displayPublished(shortFresh,now+1001).status,'HISTORICAL','UI respects authority expiry before the ordinary quote/analysis expiry');
  assert.equal(buildSoccerRanking([input.game],{[input.game.id]:{status:'done',data:shortFresh}},{now:now+1001}).entries.length,0,'loaded candidate leaves ranking at authority expiry without waiting for a server refresh');
  const expired=shortPublisher.publish(shortSnapshot,{currentStatus:{...currentReceipt,checkedAt:new Date(now+1001).toISOString()},now:now+1001});
  assert.equal(expired.directions[0].quotes[0].calculationValidity.status,'HISTORICAL_ONLY');
  assert.equal(displayPublished(expired,now+1001).status,'HISTORICAL');
}
console.log('PASS current low/high calculations: threshold-independent trusted replay, revoked and expired authority remains historical only, original S retained without current ranking');

// A reviewed server factory materializes game/price-specific manifests without
// a new per-game static artifact registration. This registry exists only inside
// the isolated test module; Production approvals remain entirely empty.
const factoryFixture=await fixtureScoringBundleModule([fixtureScoringFactory(bundleContext,acceptedCalculation.calculationInputs)]);
const factoryResolved=factoryFixture.module.resolveSoccerScoringBundle(bundleContext);
let factoryScorerCode=fs.readFileSync(moduleUrl,'utf8').replace("'./scoring-bundle.js'",JSON.stringify(factoryFixture.url));
factoryScorerCode=factoryScorerCode.replace("import { soccerVerifiedSettlementContract } from './settlement-contract.js';",`const soccerVerifiedSettlementContract=()=>(${JSON.stringify(input.contract)});`);
factoryScorerCode=factoryScorerCode.replace("from 'decimal.js'",`from ${JSON.stringify(import.meta.resolve('decimal.js'))}`);
factoryScorerCode=factoryScorerCode.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\2/g,(_m,prefix,separator,specifier)=>`${prefix}${separator}${new URL(specifier,moduleUrl).href}${separator}`);
const factoryScorerUrl=`data:text/javascript;base64,${Buffer.from(factoryScorerCode).toString('base64')}`;
const factoryScorer=await import(factoryScorerUrl),factoryScored=factoryScorer.scoreSoccerQuote({...acceptedInputs,...factoryResolved.inputs});
assert.equal(factoryScored.formalScoringEnabled,true,JSON.stringify(factoryScored.reasons));
assert.equal(factoryScored.calculationEligible,true);assert.ok(Number.isFinite(factoryScored.R));
assert.equal(factoryScored.provenance.registeredAcceptanceCount,0,'factory authority is contextual; no static per-game manifest was installed');
const factorySnapshot=structuredClone(snapshot);factorySnapshot.directions[0].quotes[0].scoring={...factoryScored,inputBundle:factoryResolved.receipt};
let factoryPublisherCode=fs.readFileSync(publisherUrl,'utf8').replace("'./soccer-scoring.js'",JSON.stringify(factoryScorerUrl)).replace("'./scoring-bundle.js'",JSON.stringify(factoryFixture.url));
factoryPublisherCode=factoryPublisherCode.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\2/g,(_m,prefix,separator,specifier)=>`${prefix}${separator}${new URL(specifier,publisherUrl).href}${separator}`);
const factoryPublisher=await import(`data:text/javascript;base64,${Buffer.from(factoryPublisherCode).toString('base64')}`);
assert.equal(factoryPublisher.publishSoccerAnalysisCandidates(factorySnapshot,{currentStatus:currentReceipt,now}).formalScoringEnabled,true);
assert.equal(publishSoccerAnalysisCandidates(factorySnapshot,{currentStatus:currentReceipt,now}).formalScoringEnabled,false,'an isolated synthetic factory must never authorize Production publication');
const changedFactoryInputs=structuredClone(factoryResolved.inputs);changedFactoryInputs.uncertainty.modelError.value=0;
assert.equal(factoryScorer.scoreSoccerQuote({...acceptedInputs,...changedFactoryInputs}).formalScoringEnabled,false,'caller-supplied errors/manifests must match the exact current reviewed factory output');
console.log('PASS reviewed server factory → exact contextual manifests → unchanged formal scorer → saved bundle replay → current publication; no per-game registry writes or Production approval from synthetic fixtures');

// Omitted numerical mass is an EV interval, never a stress scenario or an R.
const truncated = { ...input, distribution: input.grid(.52, .02), scenarios: null };
const tail = scoreSoccerQuote(truncated);
assert.equal(tail.conditionalPayoff.netEV, null); assert.equal(tail.R, null); assert.equal(tail.fixedScoreDiagnostic, null);
close(tail.conditionalPayoff.profitProbabilities.bounds.profitable.upper, .54);
for (const total of [0, 1, 2, 3, 4, 20]) {
  const exact = { ...input, distribution: { ...input.distribution, cells: [{ home: total, away: 0, probability: 1 }], retainedMass: 1, tailMass: 0 }, scenarios: null };
  const omitted = tail.conditionalPayoff.retainedEV.net + .02 * scoreSoccerQuote(exact).conditionalPayoff.netEV;
  assert.ok(omitted >= tail.conditionalPayoff.evBounds.net.lower - 1e-12 && omitted <= tail.conditionalPayoff.evBounds.net.upper + 1e-12);
}
const uncertainTail = structuredClone(input.scenarios); uncertainTail[0].distribution = input.grid(.52, .02);
const tailScenarios = scoreSoccerQuote(reseal({ ...input, scenarios: uncertainTail }));
assert.equal(tailScenarios.scenarioReturns.code, 'SOCCER_SCORE_SCENARIO_TAIL_UNRESOLVED');
assert.equal(tailScenarios.scenarioReturns.conditionalWeightedReturn, null); assert.equal(tailScenarios.R, null);
const poisson = scoreSoccerQuote({ ...input, distribution: scoreDistribution(1.5, 1.1), scenarios: null });
assert.ok(poisson.conditionalPayoff.tailMass > 0);
assert.equal(poisson.conditionalPayoff.unresolvedTailMass, 0);
assert.ok(Number.isFinite(poisson.conditionalPayoff.netEV));
assert.equal(poisson.fixedScoreDiagnostic, null, 'resolving numerical tails does not provide uncertainty inputs');
console.log('PASS arbitrary omitted tails stay bounded; proven Poisson total tails resolve by settlement without renormalization or a fabricated R');

// Exercise real infinite-support Poisson distributions through the scenario
// arithmetic, including the rebate wrapper which must account for the tail.
for (const [winRebate, lossRebate] of [[true, false], [false, true], [true, true], [false, false]]) {
  const contract = { ...input.contract, rebate: { rate: .01, basis: 'TOTAL_PRINCIPAL', appliesTo: {
    FULL_WIN: winRebate, PARTIAL_WIN: false, PUSH: false, PARTIAL_LOSS: false, FULL_LOSS: lossRebate } } };
  const scenarios = input.scenarios.map((scenario, index) => ({ ...scenario,
    distribution: { ...scenario.distribution, ...scoreDistribution(1.8 + .2 * index, 1.4, 0, 1e-7) } }));
  const actual = scoreSoccerQuote(reseal({ ...input, contract, scenarios, distribution: scenarios[0].distribution }));
  assert.equal(actual.scenarioReturns.ok, true);
  const expected = scenarios.map(scenario => {
    const d = scenario.distribution, lambda = d.homeRate + d.awayRate;
    const under = Math.exp(-lambda) * (1 + lambda + lambda * lambda / 2), over = 1 - under;
    return .95 * over - under + .01 * ((winRebate ? over : 0) + (lossRebate ? under : 0));
  });
  for (const [index, row] of actual.scenarioReturns.scenarioRows.entries()) {
    close(row.expectedNet, expected[index]);
    assert.ok(row.tailMass > 1e-12); assert.equal(row.unresolvedTailMass, 0);
    close(row.payoff.tailSettlement.rebatePerUnit, winRebate ? .01 : 0);
    close(row.payoff.tailSettlement.contribution.rebate, row.tailMass * (winRebate ? .01 : 0));
    close(row.payoff.profitProbabilities.profitable + row.payoff.profitProbabilities.losing + row.payoff.profitProbabilities.breakeven, 1);
    close(row.payoff.profitProbabilities.bounds.profitable.lower, row.payoff.profitProbabilities.bounds.profitable.upper);
    close(row.evBounds.lower, row.expectedNet); close(row.evBounds.upper, row.expectedNet);
  }
  close(actual.scenarioReturns.conditionalWeightedReturn, (expected[0] + expected[1]) / 2);
  assert.ok(Number.isFinite(actual.scenarioReturns.conditionalRobustReturn));
  assert.ok(Number.isFinite(actual.fixedScoreDiagnostic.score));
  assert.equal(actual.W, null); assert.equal(actual.R, null); assert.equal(actual.score, null);
  assert.equal(actual.formalScoringEnabled, false); assert.equal(actual.eligible, false);
}
console.log('PASS real Poisson total tails → state-specific rebate → weighted/scenario arithmetic; absent registrations still forbid formal S/W/R');

// Source terms may explicitly grant no rebate on pushes or partial outcomes.
const lineInput = fixture('epl', 'FT', '2平');
const perState = { type: 'CREDIT_BOUNDARY', period: 'FT', rebate: { rate: .01, basis: 'TOTAL_PRINCIPAL',
  appliesTo: { FULL_WIN: true, PARTIAL_WIN: false, PUSH: false, PARTIAL_LOSS: false, FULL_LOSS: true } } };
const withPush = { ...lineInput, distribution: { ...lineInput.distribution, cells: [{ home: 1, away: 1, probability: 1 }], retainedMass: 1, tailMass: 0 },
  contract: perState, scenarios: null };
const push = scoreSoccerQuote(withPush); close(push.conditionalPayoff.netEV, 0); close(push.conditionalPayoff.profitProbabilities.breakeven, 1);
const ordinary = scoreSoccerQuote({ ...withPush, contract: lineInput.contract }); close(ordinary.conditionalPayoff.netEV, .01);
close(ordinary.conditionalPayoff.profitProbabilities.profitable, 1); assert.equal(ordinary.eligible, false, 'a rebate-bearing push is still not a validated candidate');
const underallocated = scoreSoccerQuote({ ...withPush, distribution: { ...withPush.distribution, cells: [{ home: 1, away: 1, probability: .98 }], retainedMass: .98, tailMass: .02 } });
close(underallocated.conditionalPayoff.evBounds.rebate.lower, 0); close(underallocated.conditionalPayoff.evBounds.rebate.upper, .0002);
for (const [line, expected, outcome] of [['2+50', .475, 'PARTIAL_WIN'], ['2-50', -.5, 'PARTIAL_LOSS']]) {
  const partialInput = fixture('epl', 'FT', line), partial = scoreSoccerQuote({ ...partialInput, contract: perState, scenarios: null,
    distribution: { ...partialInput.distribution, cells: [{ home: 1, away: 1, probability: 1 }], retainedMass: 1, tailMass: 0 } });
  close(partial.conditionalPayoff.netEV, expected); close(partial.conditionalPayoff.probabilities[outcome], 1);
  assert.equal(partial.conditionalPayoff.rows[0].rebatePerUnit, 0);
}
assert.equal(JSON.stringify(input), before, 'all inputs remain immutable');
for (const malformed of [{}, { quote: {} }, { now: NaN }, { game: input.game }]) assert.doesNotThrow(() => scoreSoccerQuote(malformed));
console.log('PASS explicit per-settlement rebate applicability, push profitability distinct from win probability, traceable numerical ranges, immutable inputs and safe missing data');

for(const league of ['epl','ucl'])for(const period of ['FT','HT']){
  for(const [line,total,win,loss,expected] of [
    ['2.5',3,1,0,.01],['2.5',2,0,1,.01],['2+50',2,.5,0,.005],
    ['2-50',2,0,.5,.005],['2+20',2,.2,0,.002],['2-20',2,0,.2,.002],['2平',2,0,0,0],
  ]){
    const f=fixture(league,period,line),contract={...f.contract,rebate:{rate:.01,basis:'SETTLED_PRINCIPAL',
      appliesTo:{FULL_WIN:true,PARTIAL_WIN:true,PUSH:false,PARTIAL_LOSS:true,FULL_LOSS:true}}};
    const result=scoreSoccerQuote({...f,contract,scenarios:null,distribution:{...f.distribution,
      cells:[{home:total,away:0,probability:1}],retainedMass:1,tailMass:0}});
    assert.equal(result.conditionalPayoff.ok,true);
    const row=result.conditionalPayoff.rows[0];
    close(row.winFraction,win);close(row.lossFraction,loss);close(row.rebatePerUnit,expected);
    close(result.conditionalPayoff.netEV,win*.95-loss+expected);
    close(result.conditionalPayoff.evBounds.rebate.lower,expected);
    close(result.conditionalPayoff.evBounds.rebate.upper,expected);
    assert.equal(result.score,null,'confirmed rebate arithmetic cannot invent model error or formal score');
  }
}
console.log('PASS EPL/UCL FT/HT original quote → fractional rebate → exact net EV; full/half/20% wins and losses plus zero-push remain non-promoted');

// Bound propagation reaches real infinite-support FT/HT handicap generators.
// Source/model/contract fixtures remain synthetic and unregistered; generated
// PMFs and payoff engine are the production implementations.
for (const league of ['epl', 'ucl']) for (const period of ['FT', 'HT']) {
  const f = fixture(league, period, '1.5', 'HANDICAP');
  f.contract.labelMapping = { home: f.game.home.name, away: f.game.away.name };
  const htModel = { version: HALF_TIME_MODEL_VERSION, protocolVersion: HALF_TIME_PROTOCOL_VERSION, league,
    period: 'REGULATION_HT', cutoff: '2026-10-18T00:00:00Z', trainedThrough: '2026-10-17T00:00:00Z',
    trainingHash: 'd'.repeat(64), shares: { home: .45, away: .40 } };
  const modelVersion = period === 'HT' ? HALF_TIME_MODEL_VERSION : f.uncertainty.modelVersion;
  const scenarios = f.scenarios.map((scenario, index) => {
    const ft = { ...scoreDistribution(1.5 + .3 * index, 1.1, 0, 1e-7), league };
    const generated = period === 'HT' ? predictHalfTimeDistribution(ft, htModel, { league, startTime: f.game.startTime }) : ft;
    return { ...scenario, modelVersion, distribution: { ...scenario.distribution, ...generated, modelVersion } };
  });
  const current = reseal({ ...f, scenarios, distribution: scenarios[0].distribution, uncertainty: { ...f.uncertainty, modelVersion } });
  const scored = scoreSoccerQuote(current), bounded = scored.scenarioReturns;
  assert.ok(bounded, JSON.stringify({league,period,stages:scored.stages,payoff:scored.conditionalPayoff?.code}));
  assert.equal(bounded.status, 'CONDITIONAL_PROTOCOL_BOUNDS');
  assert.equal(bounded.boundsComputed, true);
  assert.equal(bounded.ok, false, 'point-return/formal admission remains closed');
  assert.equal(bounded.conditionalWeightedReturn, null); assert.equal(bounded.conditionalRobustReturn, null);
  assert.equal(bounded.fixedScoreDiagnostic, null); assert.equal(scored.fixedScoreDiagnostic, null);
  for (const field of ['W', 'R', 'score']) assert.equal(scored[field], null);
  assert.equal(scored.formalScoringEnabled, false); assert.equal(scored.calculationEligible, false);
  assert.equal(scored.eligible, false);
  assert.ok(bounded.scenarioRows.every(row => row.expectedNet === null && row.unresolvedTailMass > 0));
  assert.ok(bounded.scenarioRows.every(row => row.evBounds.lower < row.evBounds.upper));
  for (const bound of Object.values(bounded.conditionalReturnBounds)) {
    assert.ok(Number.isFinite(bound.lower) && Number.isFinite(bound.upper) && bound.lower < bound.upper);
  }
  assert.match(bounded.boundInterpretation, /NOT_A_MODEL_CONFIDENCE_INTERVAL_OR_FORMAL_R/);
}

// Different endpoint orderings must be sorted independently for q10 bounds.
const crossing = input.scenarios.map((scenario, index) => ({ ...scenario,
  distribution: input.grid(index === 0 ? .52 : .55, index === 0 ? .20 : .05) }));
const crossed = scoreSoccerQuote(reseal({ ...input, scenarios: crossing })).scenarioReturns;
const [first, second] = crossed.scenarioRows;
assert.ok(first.evBounds.lower < second.evBounds.lower);
assert.ok(first.evBounds.upper > second.evBounds.upper);
assert.equal(crossed.conditionalReturnBounds.q10.lower, first.evBounds.lower);
assert.equal(crossed.conditionalReturnBounds.q10.upper, second.evBounds.upper);
const ranges = crossed.conditionalReturnBounds;
for (let mask = 0; mask < 4; mask++) {
  const values = crossed.scenarioRows.map((row, i) => ({ weight: row.weight, value: row.evBounds[mask & (1 << i) ? 'upper' : 'lower'] }));
  const w = values.reduce((sum, row) => sum + row.weight * row.value, 0);
  const q10 = Math.min(...values.map(row => row.value)); // two equally weighted scenarios
  const e = input.uncertainty.modelError.value, adjusted = w - e, r = Math.min(w, q10, adjusted);
  for (const [key, value] of Object.entries({ weighted: w, q10, errorAdjusted: adjusted, robust: r }))
    assert.ok(ranges[key].lower <= value && value <= ranges[key].upper, `${key} endpoint completion outside enclosure`);
}
assert.equal(crossed.conditionalWeightedReturn, null); assert.equal(crossed.conditionalRobustReturn, null);
assert.equal(crossed.fixedScoreDiagnostic, null);
console.log('PASS real EPL/UCL FT/HT handicap Poisson tails and crossing scenario orders propagate outward weighted/q10/robust bounds; no point W/R/S, tail renormalization or formal admission');

// Binary64 summation admits tiny positive weights beyond the visible unit-sum
// precision. They still shift the exact 10% quantile boundary: .1 is then
// strictly less than .1 * (.1 + .9 + tiny), so the second scenario is selected.
for (const tinyWeight of [1e-100, Number.MIN_VALUE]) {
  const weights = [.1, .9, tinyWeight];
  const scenarios = weights.map((weight, index) => ({ ...input.scenarios[0], id: `tiny-weight-${index}`, weight,
    distribution: input.grid(.50 + .05 * index, .01) }));
  const result = scoreSoccerQuote(reseal({ ...input, scenarios })).scenarioReturns;
  assert.equal(result.boundsComputed, true);
  assert.ok(result.scenarioRows[0].evBounds.upper < result.scenarioRows[1].evBounds.lower);
  assert.equal(result.conditionalReturnBounds.q10.lower, result.scenarioRows[1].evBounds.lower, `lost positive weight ${tinyWeight}`);
  assert.equal(result.conditionalReturnBounds.q10.upper, result.scenarioRows[1].evBounds.upper, `lost positive weight ${tinyWeight}`);
  assert.equal(result.conditionalWeightedReturn, null); assert.equal(result.fixedScoreDiagnostic, null);
}
console.log('PASS 10% quantile boundary retains positive weights at 1e-100 and Number.MIN_VALUE; no inward bound from decimal precision loss');

// Point-identified returns must use the same CDF boundary as interval returns.
// The near-boundary case is less than 1e-12 below 10%, so adding that tolerance
// would incorrectly select the losing scenario and alter the unchanged S input.
for (const [weights, selected] of [
  [[.1, .9], 0],
  [[.0999999999995, .9000000000005], 1],
  [[.1, .9, 1e-100], 1],
  [[.1, .9, Number.MIN_VALUE], 1],
]) {
  const scenarios = weights.map((weight, index) => ({ ...input.scenarios[0], id: `point-boundary-${index}`, weight,
    distribution: input.grid(.50 + .05 * index) }));
  for (const ordered of [scenarios, [...scenarios].reverse(), [...scenarios.slice(1), scenarios[0]]]) {
    const scored = scoreSoccerQuote(reseal({ ...input, scenarios: ordered })), result = scored.scenarioReturns;
    assert.equal(result.ok, true);
    const expectedQ10 = result.scenarioRows.find(row => row.id === `point-boundary-${selected}`).expectedNet;
    assert.equal(result.q10, expectedQ10, `wrong point quantile for ${JSON.stringify(weights)}`);
    const expectedRobust = Math.min(result.conditionalWeightedReturn, expectedQ10,
      result.conditionalWeightedReturn - input.uncertainty.modelError.value);
    assert.equal(result.conditionalRobustReturn, expectedRobust);
    assert.deepEqual(result.fixedScoreDiagnostic, deterministicScore({ weightedEV: result.conditionalWeightedReturn,
      robustEV: expectedRobust, actualWater: true, qaPassed: true, executable: false }));
    assert.equal(scored.score, null); assert.equal(scored.W, null); assert.equal(scored.R, null);
    assert.equal(scored.formalScoringEnabled, false); assert.equal(scored.calculationEligible, false);
  }
}

// A separate integer-ratio oracle checks all endpoint completions with crossing
// orders. No Decimal arithmetic or floating CDF accumulation is reused here.
for (const [tinyWeight, exponent, tinyUnits] of [[1e-100, 100, 1n], [Number.MIN_VALUE, 324, 5n]]) {
  const unit = 10n ** BigInt(exponent), units = [unit / 10n, 9n * unit / 10n, tinyUnits];
  const total = units.reduce((sum, weight) => sum + weight, 0n), weights = [.1, .9, tinyWeight];
  const over = [.52, .55, .80], omitted = [.20, .05, .01];
  const scenarios = weights.map((weight, index) => ({ ...input.scenarios[0], id: `crossing-boundary-${index}`, weight,
    distribution: input.grid(over[index], omitted[index]) }));
  const result = scoreSoccerQuote(reseal({ ...input, scenarios })).scenarioReturns;
  assert.equal(result.boundsComputed, true);
  assert.ok(result.scenarioRows[0].evBounds.lower < result.scenarioRows[1].evBounds.lower);
  assert.ok(result.scenarioRows[0].evBounds.upper > result.scenarioRows[1].evBounds.upper);
  const integerQ10 = values => {
    let cumulative = 0n;
    for (const index of [0, 1, 2].sort((a, b) => values[a] - values[b])) {
      cumulative += units[index];
      if (10n * cumulative >= total) return values[index];
    }
    assert.fail('positive integer weights must reach their own quantile');
  };
  for (const endpoint of ['lower', 'upper'])
    assert.equal(result.conditionalReturnBounds.q10[endpoint],
      integerQ10(result.scenarioRows.map(row => row.evBounds[endpoint])));
  for (let mask = 0; mask < 8; mask++) {
    const completion = scenarios.map((scenario, index) => ({ ...scenario,
      distribution: input.grid(over[index] + (mask & (1 << index) ? omitted[index] : 0)) }));
    const exact = scoreSoccerQuote(reseal({ ...input, scenarios: completion })).scenarioReturns;
    assert.equal(exact.ok, true);
    assert.equal(exact.q10, integerQ10(exact.scenarioRows.map(row => row.expectedNet)),
      `point/bounded quantile conventions disagree for ${tinyWeight}, mask ${mask}`);
    // Per-score payoff operation order can differ by binary64 roundoff; the
    // chosen scenario must still lie in the independently propagated interval.
    assert.ok(result.conditionalReturnBounds.q10.lower <= exact.q10 + 1e-12);
    assert.ok(exact.q10 <= result.conditionalReturnBounds.q10.upper + 1e-12);
  }
  assert.equal(result.fixedScoreDiagnostic, null); assert.equal(result.conditionalRobustReturn, null);
}

const highReturn = scoreSoccerQuote(reseal({ ...input,
  scenarios: input.scenarios.map(scenario => ({ ...scenario, distribution: input.grid(1) })) }));
assert.equal(highReturn.fixedScoreDiagnostic.score, 8.9);
assert.ok(highReturn.fixedScoreDiagnostic.caps.includes('GENERAL_SINGLE_BET_MAX_8_9'));
assert.equal(highReturn.scoreFormulaVersion, SCORE_FORMULA_VERSION);
assert.equal(highReturn.score, null); assert.equal(highReturn.formalScoringEnabled, false);
console.log('PASS point and interval q10 share the exact >=10% CDF boundary, including near-threshold/subnormal weights, input permutations and crossing completions; fixed S/caps and formal gates unchanged');
