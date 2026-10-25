import assert from 'node:assert/strict';
import { evaluateSoccerMarketReturnCapture, summarizeSoccerMarketReturnObservations, buildSoccerMarketReturnReport, canonicalSoccerMarketReturnCaptures } from '../lib/soccer/market-return-validation.js';
import { evaluateSoccerForwardCapture, canonicalSoccerForwardCaptures } from '../lib/soccer/forward-validation.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { predictHalfTimeDistribution, HALF_TIME_MODEL_VERSION, HALF_TIME_PROTOCOL_VERSION } from '../lib/soccer/half-time-model.js';
import { fixtureCapture, resultFor, changed, protocol, sha, iso, active, observed, start, after } from './helpers/soccer-forward-fixture.mjs';

// Synthetic test inputs verify arithmetic and boundaries, never register source
// terms or claim that production already has empirical football error evidence.
function fixture({ league = 'epl', period = 'FT', line = '2.5', readerDelay = 0, water = .95 } = {}) {
  return changed(fixtureCapture({ league, period: period === 'FT' ? 'REGULATION_FT' : 'REGULATION_HT' }), capture => {
    const snapshot = capture.snapshot, game = snapshot.evidence.game;
    game.home.name = '主隊甲'; game.away.name = '客隊乙';
    if (period === 'HT') snapshot.halfTimePrediction = predictHalfTimeDistribution(snapshot.prediction, {
      version: HALF_TIME_MODEL_VERSION, protocolVersion: HALF_TIME_PROTOCOL_VERSION, league, period: 'REGULATION_HT',
      cutoff: '2026-01-01T00:00:00Z', trainedThrough: '2025-12-30T00:00:00Z', trainingHash: sha('synthetic-half-training'), shares: { home: .45, away: .43 },
    });
    const readerAt = observed + readerDelay;
    const reader = { revision: sha(['original-reader', readerDelay]), observationId: sha(['original-reader-observation', readerDelay]), observedAt: iso(readerAt),
      firstFetchedAt: iso(readerAt), receivedAt: iso(readerAt), persistedAt: iso(readerAt), sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/' };
    const markets = (Array.isArray(line) ? line : [line]).map(line => ({ period, kind: 'TOTAL', unit: 'GOALS', line, overWater: water, underWater: .9, rawRows: [`大 ${line} ${water}`, '小 .9'],
      periodEvidence: { sectionTitle: league === 'epl' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽', tableHeaders: [period === 'FT' ? '全場' : '上半場'],
        marketHeader: period === 'FT' ? '全場大小' : '上半場大小', period, status: 'EXPLICIT' } }));
    if (readerDelay) { snapshot.analysisCutoff = iso(readerAt); snapshot.observedAt = iso(readerAt); capture.capturedAt = iso(readerAt + 1); }
    snapshot.directions = buildSoccerMarketDirections({ game, reader, now: readerAt,
      matchedGames: [{ officialGameId: game.id, league: league.toUpperCase(), boardDate: game.date, prestart: true, matchStatus: 'MATCHED', markets }] });
  });
}
const trustedSyntheticContract = record => ({ provider: 'TAI888', version: 'SYNTHETIC_TEST_ONLY_NOT_PRODUCTION_TERMS',
  status: 'SOURCE_TERMS_VERIFIED', evidenceRef: 'synthetic://test-only', verifiedAt: iso(after - 1),
  league: record.league, period: record.period, kind: record.kind, line: record.line, type: 'CREDIT_BOUNDARY',
  scope: record.period === 'HT' ? 'REGULATION_HT_WITH_STOPPAGE' : 'REGULATION_FT_WITH_STOPPAGE_NO_EXTRA_TIME_OR_PENALTIES',
  normalFinalOnly: true, abnormalStatusPolicy: 'MANUAL_REVIEW', bindingEvidenceRef: 'synthetic://account-binding-test-only',
  effectiveFrom: iso(active - 1000), effectiveUntil: iso(after + 1000),
  rebate: { rate: .01, basis: 'SETTLED_PRINCIPAL', appliesTo: { FULL_WIN: true, PARTIAL_WIN: true, PUSH: false, PARTIAL_LOSS: true, FULL_LOSS: true } },
});
const run = (capture, patch = {}) => evaluateSoccerMarketReturnCapture({ capture, protocol, result: resultFor(capture), now: after, ...patch });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

for (const league of ['epl', 'ucl']) for (const period of ['FT', 'HT']) {
  const capture = fixture({ league, period }), before = JSON.stringify(capture);
  const blocked = run(capture);
  assert.equal(blocked.status, 'PENDING'); assert.equal(blocked.quoteObservations, 2); assert.equal(blocked.observedQuoteReturns, 0);
  assert.ok(blocked.observations.every(row => row.reason === 'SOCCER_SOURCE_CONTRACT_UNVERIFIED'));
  assert.ok(blocked.observations.every(row => row.actualScore && row.resultHash && row.realizedNetReturn === null), 'real result survives while source terms wait');
  const evidence = run(capture, { resolveContract: trustedSyntheticContract });
  assert.equal(evidence.status, 'OBSERVED', JSON.stringify(evidence)); assert.equal(evidence.observedQuoteReturns, 2);
  for (const row of evidence.observations) {
    assert.equal(row.originalQuote.provenance.observedAt, iso(observed)); assert.equal(row.contractVerifiedAfterPrediction, true);
    assert.equal(row.formalEligible, false); assert.equal(row.calibrationEligible, false); assert.equal(row.promotionEligible, false);
    assert.equal(row.strictHistoricalPit, false); assert.equal(row.executable, false);
    assert.equal(row.predictionError, row.realizedNetReturn - row.predictedNetReturn);
    close(row.realizedNetReturn, (period === 'FT') === (row.originalQuote.side === 'over') ? row.originalQuote.water + .01 : -.99);
  }
  assert.equal(JSON.stringify(capture), before, 'result-time evaluation cannot refresh or edit original Reader/snapshot evidence');
  const summary = summarizeSoccerMarketReturnObservations([blocked, evidence, evidence]);
  assert.equal(summary.quoteObservations, 2); assert.equal(summary.observedQuoteReturns, 2); assert.equal(summary.uniqueObservedGames, 1);
  assert.equal(summary.empiricalErrorMargin, null); assert.equal(summary.W, null); assert.equal(summary.R, null); assert.equal(summary.S, null);
}

const capture = fixture(), good = run(capture, { resolveContract: trustedSyntheticContract });
for (const [line, overProfit, underProfit] of [['3+20', .192, -.198], ['3-20', -.198, .182], ['3+50', .48, -.495], ['3-50', -.495, .455], ['3平', 0, 0]]) {
  const boundary = run(fixture({ line }), { resolveContract: trustedSyntheticContract });
  assert.equal(boundary.status, 'OBSERVED');
  close(boundary.observations.find(row => row.originalQuote.side === 'over').realizedNetReturn, overProfit);
  close(boundary.observations.find(row => row.originalQuote.side === 'under').realizedNetReturn, underProfit);
}
assert.equal(run(capture, { resolveContract: trustedSyntheticContract, now: after + 1 }).evidenceHash, good.evidenceHash, 'check time alone preserves archive deduplication');
assert.notEqual(run(capture).evidenceHash, good.evidenceHash, 'new verified return evidence cannot collide with a prior pending check');
const tampered = structuredClone(capture); tampered.snapshot.directions[2].quotes[0].water = .8;
assert.equal(run(tampered).reason, 'FORWARD_ORIGINAL_REVISION_MISMATCH');
assert.equal(run({ ...capture, capturedAt: iso(start) }).reason, 'FORWARD_FIRST_CAPTURE_NOT_PREGAME');
const invalidQuote = changed(capture, value => { value.snapshot.directions.find(row => row.quotes.length).quotes[0].line = '3.5'; });
assert.ok(run(invalidQuote).observations.some(row => row.reason === 'SOCCER_SCORE_READER_QUOTE_HASH_MISMATCH'));
const wrongDirection = changed(capture, value => { value.snapshot.directions.find(row => row.quotes.length).direction = 'HANDICAP_HOME'; });
assert.ok(run(wrongDirection).observations.some(row => row.reason === 'MARKET_RETURN_DIRECTION_MISMATCH'));
const stale = changed(capture, value => { value.snapshot.analysisCutoff = iso(observed + 180000); value.snapshot.observedAt = iso(observed + 180000); value.capturedAt = iso(observed + 180001); });
assert.ok(run(stale).observations.some(row => row.reason === 'SOCCER_SCORE_READER_TIME_INVALID'));
const noQuotes = changed(capture, value => { value.snapshot.directions = []; });
assert.equal(run(noQuotes).status, 'NO_ORIGINAL_QUOTES');
const unknownPeriod = changed(noQuotes, value => { value.snapshot.unassignedQuotes = [{ key: sha('unassigned-original'), period: 'UNKNOWN' }]; });
assert.equal(run(unknownPeriod).unassignedGameQuoteCount, 1); assert.equal(run(unknownPeriod).reason, 'MARKET_RETURN_PERIOD_UNVERIFIED');
const missingQuotes = changed(capture, value => { delete value.snapshot.directions; });
assert.equal(run(missingQuotes).reason, 'MARKET_RETURN_ORIGINAL_QUOTES_UNAVAILABLE');
assert.ok(run(capture, { result: { ...resultFor(capture), league: 'ucl' } }).observations.every(row => row.reason === 'FORWARD_RESULT_SCOPE_MISMATCH'));
assert.ok(run(capture, { resolveContract: record => ({ ...trustedSyntheticContract(record), effectiveFrom: iso(after) }) }).observations.every(row => row.reason === 'SOCCER_SOURCE_CONTRACT_UNVERIFIED'));
assert.ok(run(capture, { resolveContract: record => ({ ...trustedSyntheticContract(record), verifiedAt: iso(after + 1) }) }).observations.every(row => row.reason === 'SOCCER_SOURCE_CONTRACT_UNVERIFIED'));
assert.ok(run(capture, { resolveContract: () => { throw Error('unavailable'); } }).observations.every(row => row.reason === 'MARKET_RETURN_CONTRACT_LOOKUP_FAILED'));

const correctedResult = { ...resultFor(capture), fullTime: { home: 0, away: 0, period: 'REGULATION_FT' }, resultHash: sha('synthetic-corrected-result') };
const corrected = run(capture, { result: correctedResult, resolveContract: trustedSyntheticContract });
const quarantined = summarizeSoccerMarketReturnObservations([good, corrected]);
assert.equal(quarantined.observedQuoteReturns, 0); assert.equal(quarantined.conflictingQuoteReturns, 2);
const changedTerms = run(capture, { resolveContract: record => ({ ...trustedSyntheticContract(record), version: 'different-synthetic-terms' }) });
assert.equal(summarizeSoccerMarketReturnObservations([good, changedTerms]).conflictingQuoteReturns, 2);
const refreshed = run(capture, { result: { ...resultFor(capture), resultHash: sha('refreshed-source-same-score') }, resolveContract: trustedSyntheticContract });
assert.equal(summarizeSoccerMarketReturnObservations([good, refreshed]).conflictingQuoteReturns, 0);
const missingHt = fixture({ period: 'HT' });
assert.ok(run(missingHt, { result: { ...resultFor(missingHt), halfTime: null, halfTimeMissingReason: 'NO_HT_PROOF' } }).observations.every(row => row.reason === 'NO_HT_PROOF'));
const evaluated = { ...evaluateSoccerForwardCapture(capture, protocol, resultFor(capture), after), marketReturnValidation: good };
const reportInput = { captures: [capture], protocol, evaluations: [evaluated] };
assert.equal(buildSoccerMarketReturnReport(reportInput, after).observedQuoteReturns, 2);
assert.equal(buildSoccerMarketReturnReport({ ...reportInput, incompleteResultCaptureIds: [capture.captureId] }, after).observedQuoteReturns, 0);
assert.equal(buildSoccerMarketReturnReport({ ...reportInput, incompleteResultCaptureIds: [capture.captureId] }, after).pendingQuoteReturns, 2);
const legacyCorrection = evaluateSoccerForwardCapture(capture, protocol, correctedResult, after);
const conflictReport = buildSoccerMarketReturnReport({ ...reportInput, evaluations: [evaluated, legacyCorrection] }, after);
assert.equal(conflictReport.observedQuoteReturns, 0, 'a legacy correction without new return fields still quarantines the capture');
assert.equal(conflictReport.quarantinedPredictionPeriods, 1);
const unavailableResult = { ok: false, reason: 'NO_RESULT_YET' };
const pendingCheck = { ...evaluateSoccerForwardCapture(capture, protocol, unavailableResult, after),
  marketReturnValidation: run(capture, { result: unavailableResult }) };
const pendingReport = buildSoccerMarketReturnReport({ ...reportInput, evaluations: [pendingCheck] }, after);
assert.equal(pendingReport.pendingQuoteReturns, 2); assert.equal(pendingReport.periodsWithReturnEvidence, 1);
assert.equal(buildSoccerMarketReturnReport({ ...reportInput, evaluations: [] }, after).periodsWithoutReturnEvidence, 1);
// The first valid scoreline analysis can have no Reader prices. A subsequent
// real pregame DB snapshot must supply the return cohort, even after the first
// goal forecast was already evaluated. A heartbeat cannot double its 12 quotes.
const earliest = noQuotes;
const priceLines = ['0.5', '1.5', '2.5', '3.5', '4.5', '5.5'];
const later = changed(fixture({ line: priceLines }), value => {
  value.captureSequence = '2'; value.captureId = sha('later-priced-db-capture');
  value.snapshot.analysisCutoff = iso(observed + 10); value.snapshot.observedAt = iso(observed + 10); value.capturedAt = iso(observed + 20);
});
const heartbeat = changed(fixture({ line: priceLines, readerDelay: 60000 }), value => {
  value.captureSequence = '3'; value.captureId = sha('heartbeat-db-capture');
});
assert.notEqual(later.snapshot.directions.find(row => row.quotes.length).quotes[0].key, heartbeat.snapshot.directions.find(row => row.quotes.length).quotes[0].key, 'real Reader heartbeat regenerates original provenance/quote hashes');
const marketSelection = canonicalSoccerMarketReturnCaptures([heartbeat, later, earliest], protocol, after);
assert.deepEqual(marketSelection.chosen.map(row => row.captureId), [later.captureId]);
assert.equal(marketSelection.observations.length, 12); assert.equal(marketSelection.duplicateQuoteObservations, 12);
assert.equal(canonicalSoccerForwardCaptures([heartbeat, later, earliest], protocol, after).chosen[0].captureId, earliest.captureId, 'goal admission stays unchanged');
const laterObserved = run(later, { resolveContract: trustedSyntheticContract });
const heartbeatObserved = run(heartbeat, { resolveContract: trustedSyntheticContract });
const laterEvidence = { captures: [earliest, later, heartbeat], protocol, evaluations: [
  { ...evaluateSoccerForwardCapture(later, protocol, resultFor(later), after), marketReturnValidation: laterObserved },
  { ...evaluateSoccerForwardCapture(heartbeat, protocol, resultFor(heartbeat), after), marketReturnValidation: heartbeatObserved },
] };
const laterReport = buildSoccerMarketReturnReport(laterEvidence, after);
assert.equal(laterReport.observedQuoteReturns, 12); assert.equal(laterReport.laterDuplicateQuoteObservationsNotSelected, 12);
assert.equal(laterReport.unpricedPredictionPeriods, 1); assert.equal(laterReport.uniqueObservedGames, 1);
const incompleteHeartbeatHistory = buildSoccerMarketReturnReport({ ...laterEvidence,
  evaluations: [laterEvidence.evaluations[0]], incompleteResultCaptureIds: [heartbeat.captureId] }, after);
assert.equal(incompleteHeartbeatHistory.observedQuoteReturns, 0, 'an omitted later duplicate-capture correction history cannot restore earlier selected return evidence');
assert.equal(incompleteHeartbeatHistory.pendingQuoteReturns, 12);
assert.equal(incompleteHeartbeatHistory.predictionPeriodsWithIncompleteGameResultHistory, 1);
const earliestCorrection = evaluateSoccerForwardCapture(earliest, protocol, { ...resultFor(earliest), fullTime: { home: 0, away: 0, period: 'REGULATION_FT' }, resultHash: sha('legacy-unpriced-correction') }, after);
const crossCaptureCorrection = buildSoccerMarketReturnReport({ ...laterEvidence, evaluations: [...laterEvidence.evaluations, earliestCorrection] }, after);
assert.equal(crossCaptureCorrection.observedQuoteReturns, 0, 'a real-game result correction from an unpriced legacy forecast also quarantines later priced samples');
assert.equal(crossCaptureCorrection.conflictingQuoteReturns, 12);
const newPrice = changed(fixture({ line: priceLines, readerDelay: 120000, water: .96 }), value => {
  value.captureSequence = '4'; value.captureId = sha('changed-economic-price-db-capture');
});
assert.equal(canonicalSoccerMarketReturnCaptures([earliest, later, heartbeat, newPrice], protocol, after).observations.length, 18, 'six new over prices count; unchanged under prices do not');
const { runSoccerForwardValidation } = await import('../lib/soccer/forward-validation-service.js');
const archived = [], earliestEvaluation = evaluateSoccerForwardCapture(earliest, protocol, resultFor(earliest), after);
const runner = await runSoccerForwardValidation({ league: later.league, date: later.date }, {
  now: () => after, query: async () => [], loadEvidence: async () => ({ ...laterEvidence, evaluations: [earliestEvaluation],
    checks: [{ captureId: earliest.captureId, checkedAt: iso(after) }] }),
  fetchResult: async () => resultFor(later), archive: async (saved, evaluation) => { archived.push({ saved, evaluation }); },
});
assert.equal(archived.length, 1); assert.equal(archived[0].saved.captureId, later.captureId);
assert.equal(archived[0].evaluation.marketReturnValidation.quoteObservations, 12);
assert.equal(runner.checkedGameModelPeriods, 0); assert.equal(runner.marketReturnCheckedPredictionPeriods, 1);
assert.equal(runner.marketReturnPendingQuoteReturns, 12, 'production empty terms retain real prices and final result without inventing realized returns');
console.log('PASS soccer saved quote return evidence: immutable original Reader/model/cutoff, EPL/UCL FT/HT, source-term and account-time binding, 1% settled-principal arithmetic, result corrections/term conflicts quarantined, checks deduplicated, all quote denominators retained, no fabricated empirical R or scoring approval');
