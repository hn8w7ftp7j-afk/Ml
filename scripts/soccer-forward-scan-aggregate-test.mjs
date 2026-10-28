import assert from 'node:assert/strict';
import { mergeSoccerForwardGameReport, mergeSoccerForwardProbabilityAudits } from '../lib/soccer/forward-scan-aggregate.js';
import { buildSoccerForwardReport, evaluateSoccerForwardCapture } from '../lib/soccer/forward-validation.js';
import { buildSoccerMarketReturnReport } from '../lib/soccer/market-return-validation.js';
import { buildSoccerProbabilityAudit } from '../lib/soccer/probability-audit.js';
import { summarizeSoccerReturnErrorDatasets } from '../lib/soccer/return-error-model.js';
import { fixtureCapture, resultFor, protocol, after } from './helpers/soccer-forward-fixture.mjs';

const makeReport = (captures, evaluations = [], extra = {}) => {
  const evidence = { captures, evaluations, checks: [], protocol, now: after, ...extra };
  return { ...buildSoccerForwardReport(evidence), marketReturnValidation: buildSoccerMarketReturnReport(evidence, after) };
};
const close = (a, b, name) => {
  if (typeof a === 'number' && typeof b === 'number') assert.ok(Math.abs(a - b) <= 1e-13 * Math.max(1, Math.abs(a), Math.abs(b)), `${name}: ${a} != ${b}`);
  else if (a && b && typeof a === 'object' && typeof b === 'object') {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), name);
    for (const key of Object.keys(a)) close(a[key], b[key], `${name}.${key}`);
  } else assert.deepEqual(a, b, name);
};
const captures = [], evaluations = [], parts = [];
for (let i = 0; i < 12; i++) {
  const c = fixtureCapture({ id: String(100 + i), sequence: i + 1, league: i % 3 ? 'epl' : 'ucl', period: i % 2 ? 'REGULATION_FT' : 'REGULATION_HT' });
  const e = evaluateSoccerForwardCapture(c, protocol, resultFor(c), after);
  if (i === 2) { e.scoreLogLoss = null; e.exactScoreLogProbability = null; e.exactScoreLogProbabilityState = 'UNAVAILABLE'; }
  captures.push(c);
  if (i !== 7) evaluations.push(e);
  parts.push(makeReport([c], i === 7 ? [] : [e]));
}
const expected = makeReport(captures, evaluations), merged = parts.reduce(mergeSoccerForwardGameReport, null);
for (const key of ['capturedSnapshotPeriods', 'selectedGameModelPeriods', 'uniqueSelectedGames', 'evaluatedGameModelPeriods', 'excludedSnapshotPeriods', 'conflictingResultCaptures', 'complete', 'truncated']) assert.equal(merged[key], expected[key], key);
for (const group of expected.groups) {
  const actual = merged.groups.find(row => row.league === group.league && row.period === group.period && row.modelHash === group.modelHash);
  for (const key of ['capturedGames', 'evaluatedGames', 'pendingGames', 'receivedSnapshotPeriods', 'excludedSnapshotPeriods', 'laterReanalysesNotSelected']) assert.equal(actual[key], group[key], key);
  close(actual.properScores, group.properScores, 'properScores');
  close(actual.probabilityAudit, group.probabilityAudit, 'probabilityAudit');
}
const { readCoverage: _a, ...returns } = merged.marketReturnValidation;
const { readCoverage: _b, ...expectedReturns } = expected.marketReturnValidation;
close(returns, expectedReturns, 'returns');
assert.equal(merged.formalEligible, false); assert.equal(merged.marketReturnValidation.empiricalErrorMargin, null);
assert.equal(mergeSoccerForwardGameReport(merged, null).selectedGameModelPeriods, 12);

// Bin ECE/REL must be recalculated from pooled sufficient statistics, rather
// than averaging separately computed per-page errors that can cancel in a bin.
const record = (id, outcome, p) => ({ status: 'EVALUATED', eventId: id, league: 'epl', period: 'REGULATION_FT', modelHash: 'model', actualOutcome: outcome,
  probabilities: p, retainedMass: 1, tailMass: 0 });
const first = [record('a', 'home', { home: .51, draw: .25, away: .24 })];
const second = [record('b', 'draw', { home: .59, draw: .25, away: .16 }), record('c', 'away', { home: .55, draw: .25, away: .20 })];
const audit = mergeSoccerForwardProbabilityAudits(buildSoccerProbabilityAudit(first), buildSoccerProbabilityAudit(second));
close(audit, buildSoccerProbabilityAudit([...first, ...second]), 'pooledAudit');
assert.notEqual(audit.classes.home.ECE_L1, (buildSoccerProbabilityAudit(first).classes.home.ECE_L1 + buildSoccerProbabilityAudit(second).classes.home.ECE_L1) / 2);

const infinite = structuredClone(parts[1]);
infinite.groups[0].properScores.logLoss = null;
infinite.groups[0].properScores.logLossState = 'POSITIVE_INFINITY';
infinite.groups[0].properScores.infiniteLogLossCount = 1;
const withInfinity = mergeSoccerForwardGameReport(parts[5], infinite);
assert.equal(withInfinity.groups[0].properScores.logLoss, null);
assert.equal(withInfinity.groups[0].properScores.logLossState, 'POSITIVE_INFINITY');
assert.equal(withInfinity.groups[0].properScores.infiniteLogLossCount, 1);
const incomplete = makeReport([fixtureCapture({ id: '999' })], [], { truncated: true });
assert.equal(mergeSoccerForwardGameReport(mergeSoccerForwardGameReport(parts[0], incomplete), parts[1]).complete, false, 'an incomplete original/history remains incomplete across later complete contributions');

// Detail caps are presentation limits; metrics and all denominators cover every
// game and remain so after JSON roundtrips of the durable scan accumulator.
let many = null;
for (let i = 0; i < 110; i++) {
  const c = fixtureCapture({ id: String(1000 + i), sequence: i + 100 }), e = evaluateSoccerForwardCapture(c, protocol, resultFor(c), after);
  many = JSON.parse(JSON.stringify(mergeSoccerForwardGameReport(many, makeReport([c], [e]))));
}
assert.equal(many.uniqueSelectedGames, 110); assert.equal(many.groups[0].evaluatedGames, 110);
assert.equal(many.groups[0].observations.length, 100); assert.equal(many.groups[0].observationDetailCount, 110);
assert.equal(many.groups[0].observationDetailsTruncated, true); assert.equal(many.complete, true);
assert.equal(many.groups[0].probabilityAudit.cohort.used, 110);
const wrong = structuredClone(parts[1]); wrong.protocol.activatedAt = '2026-10-18T00:00:00Z';
assert.throws(() => mergeSoccerForwardGameReport(parts[0], wrong), /PROTOCOL_MISMATCH/);
assert.throws(() => mergeSoccerForwardGameReport(parts[0], { ...parts[1], formalEligible: true }), /PROMOTION_REJECTED/);
const unsafeReturn = structuredClone(parts[0]); unsafeReturn.marketReturnValidation.R = 0;
assert.throws(() => mergeSoccerForwardGameReport(null, unsafeReturn), /PROMOTION_REJECTED/);
const unsafeAudit = structuredClone(parts[0]); unsafeAudit.groups[0].probabilityAudit.formalEnabled = true;
assert.throws(() => mergeSoccerForwardGameReport(null, unsafeAudit), /PROMOTION_REJECTED/);
const errorCounts = { ...summarizeSoccerReturnErrorDatasets([]), selectedQuoteObservations: 6, checkedQuoteObservations: 4,
  uncheckedQuoteObservations: 2, observedQuoteReturns: 2, observedGames: 1, excludedReasons: { RETURN_ERROR_NOT_OBSERVED: 2 } };
const errorFirst = { ...parts[0], returnErrorResearch: errorCounts };
const errorNext = { ...parts[1], returnErrorResearch: { ...errorCounts, completeWithinRequestedScope: false } };
const errorMerged = mergeSoccerForwardGameReport(errorFirst, errorNext).returnErrorResearch;
assert.equal(errorMerged.selectedQuoteObservations, 12); assert.equal(errorMerged.observedGames, 2);
assert.equal(errorMerged.excludedReasons.RETURN_ERROR_NOT_OBSERVED, 4); assert.equal(errorMerged.completeWithinRequestedScope, false);
assert.equal(errorMerged.empiricalErrorMargin, null); assert.equal(errorMerged.accepted, false);
assert.throws(() => mergeSoccerForwardGameReport(null, { ...errorFirst, returnErrorResearch: { ...errorCounts, accepted: true } }), /PROMOTION_REJECTED/);
const wrongBins = structuredClone(buildSoccerProbabilityAudit(second)); wrongBins.binning.edges[1] = .11;
assert.throws(() => mergeSoccerForwardProbabilityAudits(buildSoccerProbabilityAudit(first), wrongBins), /BINNING_MISMATCH/);
console.log('PASS soccer durable scan aggregation: full-scope counters, disjoint game/model/period metrics, pooled bin recalibration, infinite log-loss, exact-score denominators, JSON continuation, no promotion, bounded display details.');
