import assert from 'node:assert/strict';
import fs from 'node:fs';
import { adaptSoccerReaderQuote, evaluateSoccerScenarioReturns, scoreSoccerQuote, soccerScoringHash,
  SOCCER_SCENARIO_ARITHMETIC_VERSION } from '../lib/soccer/soccer-scoring.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { scoreDistribution } from '../lib/soccer/score-model.js';
import { deterministicScore, SCORE_FORMULA_VERSION } from '../lib/deterministic-score.js';
import { publishSoccerAnalysisCandidates } from '../lib/soccer/candidate-publication.js';
import { soccerCandidatePayloadValid } from '../lib/soccer/candidate-qualification.js';
import { buildSoccerRanking } from '../lib/soccer/ranking.js';
import { soccerQuoteScorePresentation } from '../lib/soccer/score-presentation.js';

const now = Date.parse('2026-10-20T00:00:00Z'), at = new Date(now).toISOString();
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const source = { provider: 'REPRODUCIBLE_SYNTHETIC_TEST_NOT_EMPIRICAL_VALIDATION', url: 'https://fixture.invalid/validation',
  contentHash: 'a'.repeat(64), sourcePublishedAt: '2026-10-19T00:00:00Z', fetchedAt: '2026-10-19T00:00:01Z', availableAt: '2026-10-19T00:00:02Z' };
function fixture(league = 'epl', period = 'FT', line = '2.5') {
  const game = { id: `soccer:${league}:123`, sourceId: '123', league, date: '2026-10-20', startTime: '2026-10-20T12:00:00Z',
    status: 'scheduled', home: { sourceId: '359', name: 'Arsenal' }, away: { sourceId: '364', name: 'Liverpool' } };
  const reader = { revision: 'b'.repeat(64), observationId: 'c'.repeat(64), observedAt: at, firstFetchedAt: at,
    receivedAt: at, persistedAt: at, sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/' };
  const market = { kind: 'TOTAL', unit: 'GOALS', period, line, overWater: .95, underWater: .9,
    rawRows: [`大 ${line} 0.95`, '小 0.9'], periodEvidence: { sectionTitle: league === 'epl' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽',
      tableHeaders: [period === 'FT' ? '全場' : '上半場'], marketHeader: period === 'FT' ? '全場大小' : '上半場大小', period, status: 'EXPLICIT' } };
  const directions = buildSoccerMarketDirections({ game, reader, now, matchedGames: [{ officialGameId: game.id, league: league.toUpperCase(),
    boardDate: game.date, prestart: true, matchStatus: 'MATCHED', markets: [market] }] });
  const quote = directions.find(direction => direction.period === period && direction.direction === 'TOTAL_OVER').quotes[0];
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
let registeredCode = fs.readFileSync(moduleUrl, 'utf8').replace('const acceptedArtifacts = Object.freeze([]);', `const acceptedArtifacts = Object.freeze(${JSON.stringify(registrations)});`);
registeredCode = registeredCode.replace("import { soccerVerifiedSettlementContract } from './settlement-contract.js';", `const soccerVerifiedSettlementContract = () => (${JSON.stringify(input.contract)});`);
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
const publisherUrl = new URL('../lib/soccer/candidate-publication.js', import.meta.url);
let publisherCode = fs.readFileSync(publisherUrl, 'utf8').replace("'./soccer-scoring.js'", JSON.stringify(scorerTestUrl));
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
    qaFlag: 'WARN', quotes: [{ ...input.quote, scoring: acceptedCalculation }] }] };
const untouchedSnapshot = JSON.stringify(snapshot);
const published = testPublish(snapshot, { currentStatus: currentReceipt, now });
assert.equal(published.formalScoringEnabled, true); assert.equal(published.directions[0].quotes[0].eligible, true);
assert.equal(soccerCandidatePayloadValid(published, now), true);
const presentation=soccerQuoteScorePresentation({result:published,direction:published.directions[0],quote:published.directions[0].quotes[0],now});
assert.equal(presentation.score,acceptedCalculation.score);assert.equal(presentation.status,'QUALIFIED');
const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{transform}=await import('next/dist/build/swc/index.js'),{default:vm}=await import('node:vm');
const marketSource=fs.readFileSync(new URL('../app/soccer/market-panel.js',import.meta.url),'utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const marketCode=await transform(marketSource,{filename:'soccer-actual-score.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const marketContext=vm.createContext({React,soccerQuoteScorePresentation,SoccerRecordButton:()=>null});vm.runInContext(marketCode.code,marketContext);
const scoredMarkup=renderToStaticMarkup(marketContext.SoccerMarketDirections({directions:published.directions,result:published,game:input.game,now}));
assert.ok(scoredMarkup.includes(`<strong>${acceptedCalculation.score.toFixed(1)}</strong>`));
assert.match(scoredMarkup,/W \+4.35%｜R \+2.40%/);assert.match(scoredMarkup,/通過排名門檻/);
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
assert.ok(poisson.conditionalPayoff.tailMass > 0); assert.equal(poisson.conditionalPayoff.netEV, null);
console.log('PASS omitted-tail retained mass and exact-profit bounds, genuine Poisson nonzero tail, no retained EV renormalization or tail bound masquerading as R');

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
