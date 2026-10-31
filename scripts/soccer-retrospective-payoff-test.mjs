import assert from 'node:assert/strict';
import { buildSoccerRetrospectivePayoffReport, buildSoccerRetrospectivePayoffReportHydrated, SOCCER_RETROSPECTIVE_PAYOFF_VERSION } from '../lib/soccer/retrospective-payoff.js';
import { compactSoccerForwardCapture, evaluateSoccerForwardCapture } from '../lib/soccer/forward-validation.js';
import { evaluateSoccerMarketReturnCapture } from '../lib/soccer/market-return-validation.js';
import { soccerVerifiedSettlementContract } from '../lib/soccer/settlement-contract.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { predictHalfTimeDistribution, HALF_TIME_MODEL_VERSION, HALF_TIME_PROTOCOL_VERSION } from '../lib/soccer/half-time-model.js';
import { fixtureCapture, resultFor, changed, protocol, sha, iso, observed, start, after } from './helpers/soccer-forward-fixture.mjs';

const now = Date.parse('2026-11-01T00:00:00Z');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
function captureFor({ league = 'epl', period = 'FT', kind = 'TOTAL', line = '2.5', water = .95, delay = 0, sequence = 1 } = {}) {
  return changed(fixtureCapture({ league, period: period === 'FT' ? 'REGULATION_FT' : 'REGULATION_HT', sequence }), capture => {
    const snapshot = capture.snapshot, game = snapshot.evidence.game;
    if (period === 'HT') snapshot.halfTimePrediction = predictHalfTimeDistribution(snapshot.prediction, {
      version: HALF_TIME_MODEL_VERSION, protocolVersion: HALF_TIME_PROTOCOL_VERSION, league, period: 'REGULATION_HT',
      cutoff: '2026-01-01T00:00:00Z', trainedThrough: '2025-12-30T00:00:00Z', trainingHash: sha('synthetic-HT-replay-training'), shares: { home: .45, away: .43 },
    });
    const at = observed + delay;
    const reader = { revision: sha(['replay-reader', delay]), observationId: sha(['replay-observation', delay]), observedAt: iso(at),
      firstFetchedAt: iso(at), receivedAt: iso(at), persistedAt: iso(at), sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/' };
    const markets = [{ period, kind, unit: 'GOALS', line, ...(kind === 'HANDICAP' ? { lineSide: 'home', homeWater: water, awayWater: .9 } : { overWater: water, underWater: .9 }),
      rawRows: [`original ${line} ${water}`, 'opposite .9'], periodEvidence: { sectionTitle: league === 'epl' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽',
        tableHeaders: [period === 'FT' ? '全場' : '上半場'], marketHeader: period === 'FT' ? '全場大小' : '上半場大小', period, status: 'EXPLICIT' } }];
    if (delay) { snapshot.analysisCutoff = iso(at); snapshot.observedAt = iso(at); capture.capturedAt = iso(at + 1); }
    snapshot.directions = buildSoccerMarketDirections({ game, reader, now: at,
      matchedGames: [{ officialGameId: game.id, league: league.toUpperCase(), boardDate: game.date, prestart: true, matchStatus: 'MATCHED', markets }] });
  });
}
const evidenceFor = (captures, checks = captures.map(capture => ({ captureId: capture.captureId, checkedAt: iso(after), resultEvidence: resultFor(capture) }))) => ({ captures, protocol, checks });
const reportFor = (capture, options = {}) => buildSoccerRetrospectivePayoffReport(evidenceFor([capture]), { now, ...options });
function restricted(value) {
  for (const key of ['accountSettlementVerified', 'historicalContractVerified', 'verifiedAtOriginalCutoff', 'formalEligible', 'calibrationEligible', 'promotionEligible', 'executable']) assert.equal(value[key], false, key);
  for (const key of ['W', 'R', 'S', 'empiricalErrorMargin']) assert.equal(value[key], null, key);
}

for (const league of ['epl', 'ucl']) for (const period of ['FT', 'HT']) {
  const capture = captureFor({ league, period }), input = evidenceFor([capture]), before = JSON.stringify(input);
  const report = buildSoccerRetrospectivePayoffReport(input, { now });
  assert.equal(report.version, SOCCER_RETROSPECTIVE_PAYOFF_VERSION); assert.equal(report.status, 'RESEARCH_REPLAY_AVAILABLE');
  assert.equal(report.selectedQuoteObservations, 2); assert.equal(report.replayedQuoteObservations, 2);
  assert.equal(report.uniqueReplayedGames, 1); assert.equal(report.pendingQuoteObservations, 0); assert.equal(report.quarantinedQuoteObservations, 0);
  assert.equal(report.exactPredictedQuoteReturns, 2); assert.equal(report.boundedPredictedQuoteReturns, 0);
  assert.equal(report.ruleApplication.appliedAt, iso(now)); assert.ok(report.ruleApplication.confirmedAt > capture.snapshot.analysisCutoff);
  assert.equal(report.completeWithinRequestedScope, true); restricted(report); restricted(report.ruleApplication);
  for (const group of report.groups) {
    restricted(group); assert.equal(group.league, league); assert.equal(group.period, period); assert.equal(group.games, 1); assert.equal(group.quotes, 1);
    const expected = (period === 'FT') === (group.side === 'over') ? (group.side === 'over' ? .95 : .9) + .01 : -.99;
    close(group.hypotheticalRealizedNetReturnSum, expected);
    assert.ok(group.predictedNetReturnSum.lower <= group.predictedNetReturnSum.upper);
    assert.ok(group.retrospectiveErrorSum.lower <= expected - group.predictedNetReturnSum.upper);
    assert.ok(group.retrospectiveErrorSum.upper >= expected - group.predictedNetReturnSum.lower);
  }
  assert.equal(JSON.stringify(input), before, 'replay does not refresh original quote or alter immutable evidence');
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(capture.gameId)); assert.ok(!serialized.includes('tai888.in'));
  assert.doesNotMatch(serialized, /rawRows|accountDeviceHash|readerObservationId|sourceQuote|NaN|Infinity/);
  const later = reportFor(capture, { now: now + 1000 });
  assert.equal(later.ruleApplication.ruleHash, report.ruleApplication.ruleHash, 'application time is not rule identity');
  assert.notEqual(later.ruleApplication.appliedAt, report.ruleApplication.appliedAt);
  const formal = evaluateSoccerMarketReturnCapture({ capture, protocol, result: resultFor(capture), now });
  assert.equal(formal.observedQuoteReturns, 0, 'retrospective replay cannot populate the formal registered-contract dataset');
  assert.ok(formal.observations.every(row => row.reason === 'SOCCER_SOURCE_CONTRACT_UNVERIFIED'));
}

for (const league of ['epl', 'ucl']) for (const period of ['FT', 'HT']) for (const kind of ['TOTAL', 'HANDICAP']) {
  const boundary = kind === 'HANDICAP' ? 1 : period === 'FT' ? 3 : 1;
  for (const [suffix, first, second] of [['+20', .192, -.198], ['-20', -.198, .182], ['+50', .48, -.495], ['-50', -.495, .455], ['平', 0, 0]]) {
    const report = reportFor(captureFor({ league, period, kind, line: `${boundary}${suffix}` }));
    assert.equal(report.replayedQuoteObservations, 2);
    close(report.groups.find(group => group.side === (kind === 'TOTAL' ? 'over' : 'home')).hypotheticalRealizedNetReturnSum, first);
    close(report.groups.find(group => group.side === (kind === 'TOTAL' ? 'under' : 'away')).hypotheticalRealizedNetReturnSum, second);
  }
}

const capture = captureFor(), basic = evidenceFor([capture]);
const bounded = reportFor(captureFor({ kind: 'HANDICAP', line: '1+20' }));
assert.equal(bounded.boundedPredictedQuoteReturns, 2); assert.equal(bounded.exactPredictedQuoteReturns, 0);
assert.ok(bounded.groups.every(group => group.predictedNetReturnSum.lower < group.predictedNetReturnSum.upper),
  'unresolved handicap tail mass remains an interval and never becomes a midpoint');
const unpriced = changed(capture, value => { value.captureId = sha('unpriced'); value.captureSequence = '1'; value.snapshot.directions = []; });
const priced = changed(capture, value => { value.captureId = sha('priced'); value.captureSequence = '2'; });
const heartbeat = captureFor({ delay: 60000, sequence: 3 });
const duplicate = buildSoccerRetrospectivePayoffReport(evidenceFor([heartbeat, priced, unpriced]), { now });
assert.equal(duplicate.replayedQuoteObservations, 2); assert.equal(duplicate.duplicateEconomicQuoteObservations, 2); assert.equal(duplicate.unpricedPredictionPeriods, 1);
const noResult = buildSoccerRetrospectivePayoffReport(evidenceFor([capture], []), { now });
assert.equal(noResult.replayedQuoteObservations, 0); assert.equal(noResult.pendingQuoteObservations, 2);
assert.equal(noResult.excludedReasons.RETROSPECTIVE_ORIGINAL_RESULT_EVIDENCE_MISSING, 2);
const legacyEvaluation = evaluateSoccerForwardCapture(capture, protocol, resultFor(capture), now);
assert.equal(buildSoccerRetrospectivePayoffReport({ ...basic, checks: [], evaluations: [legacyEvaluation] }, { now }).replayedQuoteObservations, 0,
  'a legacy evaluated flag cannot substitute original result evidence');
const corrected = { ...resultFor(capture), fullTime: { home: 0, away: 0, period: 'REGULATION_FT' }, resultHash: sha('corrected') };
const correctionChecks = [...basic.checks, { captureId: capture.captureId, checkedAt: iso(after + 1), resultEvidence: corrected }];
const correction = buildSoccerRetrospectivePayoffReport({ ...basic, checks: correctionChecks }, { now });
assert.equal(correction.replayedQuoteObservations, 0); assert.equal(correction.quarantinedQuoteObservations, 2);
const unpricedCorrection = { ...evidenceFor([unpriced, priced]), checks: [
  { captureId: unpriced.captureId, checkedAt: iso(after), resultEvidence: { ...corrected, gameId: unpriced.gameId } },
  { captureId: priced.captureId, checkedAt: iso(after), resultEvidence: resultFor(priced) },
] };
assert.equal(buildSoccerRetrospectivePayoffReport(unpricedCorrection, { now }).quarantinedQuoteObservations, 2, 'unpriced original correction quarantines later priced capture');
for (const id of [unpriced.captureId, heartbeat.captureId]) {
  const report = buildSoccerRetrospectivePayoffReport({ ...evidenceFor([unpriced, priced, heartbeat]), incompleteResultCaptureIds: [id] }, { now });
  assert.equal(report.replayedQuoteObservations, 0); assert.equal(report.quarantinedQuoteObservations, 2); assert.equal(report.incompleteResultHistories, 1);
}
const wrongResult = buildSoccerRetrospectivePayoffReport(evidenceFor([capture], [{ ...basic.checks[0], resultEvidence: { ...resultFor(capture), league: 'ucl' } }]), { now });
assert.equal(wrongResult.replayedQuoteObservations, 0); assert.equal(wrongResult.pendingQuoteObservations, 2);
const missingHt = captureFor({ period: 'HT' });
assert.equal(buildSoccerRetrospectivePayoffReport(evidenceFor([missingHt], [{ captureId: missingHt.captureId, checkedAt: iso(after),
  resultEvidence: { ...resultFor(missingHt), halfTime: null, halfTimeMissingReason: 'NO_HT_SOURCE' } }]), { now }).pendingQuoteObservations, 2);
const futureCheck = buildSoccerRetrospectivePayoffReport(evidenceFor([capture], [{ ...basic.checks[0], checkedAt: iso(now + 1) }]), { now });
assert.equal(futureCheck.replayedQuoteObservations, 0);
const lateSource = buildSoccerRetrospectivePayoffReport(evidenceFor([capture], [{ ...basic.checks[0], resultEvidence: {
  ...resultFor(capture), sources: resultFor(capture).sources.map(source => ({ ...source, fetchedAt: iso(after + 1) })),
} }]), { now });
assert.equal(lateSource.replayedQuoteObservations, 0); assert.equal(lateSource.excludedReasons.RETROSPECTIVE_RESULT_RECEIPT_TIME_INVALID, 2);
const afterStart = { ...capture, capturedAt: iso(start) };
assert.equal(reportFor(afterStart).selectedQuoteObservations, 0);
const unknownPeriod = changed(capture, value => { value.snapshot.directions.forEach(direction => direction.period = 'UNKNOWN'); });
assert.equal(reportFor(unknownPeriod).replayedQuoteObservations, 0);
const tampered = structuredClone(capture); tampered.snapshot.prediction.cells[0].probability += .1;
assert.equal(reportFor(tampered).selectedQuoteObservations, 0);
const invalidQuote = changed(capture, value => { value.snapshot.directions.find(row => row.quotes.length).quotes[0].water = .81; });
assert.equal(reportFor(invalidQuote).invalidOriginalQuotes, 1);
const partial = buildSoccerRetrospectivePayoffReport({ ...basic, truncated: true, readCoverage: { status: 'PARTIAL_BOUNDED_READ' } }, { now });
assert.equal(partial.status, 'PARTIAL'); assert.equal(partial.completeWithinRequestedScope, false); assert.equal(partial.replayedQuoteObservations, 2);
const unconfirmed = reportFor(capture, { now: after });
assert.equal(unconfirmed.replayedQuoteObservations, 0); assert.equal(unconfirmed.excludedReasons.RETROSPECTIVE_CONFIRMED_RULE_UNAVAILABLE_AT_APPLICATION, 2);
const empty = buildSoccerRetrospectivePayoffReport({}, { now }); assert.equal(empty.status, 'MISSING_OBSERVATIONS'); restricted(empty);
assert.equal(soccerVerifiedSettlementContract({ league: 'epl', period: 'FT', kind: 'TOTAL', line: '2.5' }), null);

const compact = compactSoccerForwardCapture(capture, protocol, now), compactEvidence = { ...basic, captures: [compact] };
let active = 0, maximum = 0, calls = 0;
const hydrated = await buildSoccerRetrospectivePayoffReportHydrated(compactEvidence, { now, hydrateCapture: async id => {
  assert.equal(id, capture.captureId); active++; maximum = Math.max(maximum, active); calls++; await Promise.resolve(); active--; return capture;
} });
assert.deepEqual(hydrated, reportFor(capture)); assert.equal(calls, 1); assert.equal(maximum, 1);
for (const original of [null, { ...capture, gameId: 'soccer:ucl:999' }, tampered]) {
  const failed = await buildSoccerRetrospectivePayoffReportHydrated(compactEvidence, { now, hydrateCapture: async () => original });
  assert.equal(failed.replayedQuoteObservations, 0); assert.equal(failed.pendingQuoteObservations, 2);
}
const failed = await buildSoccerRetrospectivePayoffReportHydrated(compactEvidence, { now, hydrateCapture: async () => { throw Error('source unavailable'); } });
assert.equal(failed.replayedQuoteObservations, 0);
assert.equal(buildSoccerRetrospectivePayoffReport({ ...basic, captures: [structuredClone(compact)] }, { now }).selectedQuoteObservations, 0,
  'a serialized compact verified flag cannot replace immutable source validation');
await assert.rejects(() => buildSoccerRetrospectivePayoffReportHydrated(basic), /HYDRATOR_REQUIRED/);
console.log('PASS actual original forecast + Reader parser + official-result validator → retrospective credit-rule payoff replay: EPL/UCL FT/HT, full/half/20%/push, exact and bounded tails, economic-price dedup, correction/history quarantine, sequential private hydration, no source-contract or formal W/R/S promotion');
