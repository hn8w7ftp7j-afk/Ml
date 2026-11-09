import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildConditionalReturnResearchBridge, CONDITIONAL_RETURN_FEATURE_DESCRIPTOR } from './bridge.mjs';
import { estimateConditionalReturnError, VERSION, conditionalReturnResearchHash } from './estimator.mjs';
import { buildSoccerMarketDirections } from '../../../lib/soccer/market-directions.js';
import { evaluateSoccerMarketReturnCapture } from '../../../lib/soccer/market-return-validation.js';
import { evaluateSoccerForwardCapture, soccerForwardHash } from '../../../lib/soccer/forward-validation.js';
import { fixtureCapture, changed, resultFor, protocol, active, after, iso } from '../../../scripts/helpers/soccer-forward-fixture.mjs';
import { predictHalfTimeDistribution, HALF_TIME_MODEL_VERSION, HALF_TIME_PROTOCOL_VERSION } from '../../../lib/soccer/half-time-model.js';
import { scoreDistribution } from '../../../lib/soccer/score-model.js';

// Synthetic source/identity/contract fixtures only. The documented test command
// explicitly enables the repository's existing test-only schedule authority.
// No fixture, receipt, observation or result is persisted to Production.
const DAY = 86400000;
const resolveContract = record => ({ provider: 'TAI888', version: 'SYNTHETIC_TEST_ONLY',
  status: 'SOURCE_TERMS_VERIFIED', evidenceRef: 'synthetic://test-only', verifiedAt: iso(active - 2000),
  league: record.league, period: record.period, kind: record.kind, line: record.line, quoteKey: record.quoteKey,
  type: 'CREDIT_BOUNDARY', scope: record.period === 'HT' ? 'REGULATION_HT_WITH_STOPPAGE'
    : 'REGULATION_FT_WITH_STOPPAGE_NO_EXTRA_TIME_OR_PENALTIES', normalFinalOnly: true,
  abnormalStatusPolicy: 'MANUAL_REVIEW', bindingEvidenceRef: 'synthetic://account-binding',
  effectiveFrom: iso(active - 10000), effectiveUntil: iso(active + 100 * DAY),
  rebate: { rate: .01, basis: 'SETTLED_PRINCIPAL', appliesTo: {
    FULL_WIN: true, PARTIAL_WIN: true, PUSH: false, PARTIAL_LOSS: true, FULL_LOSS: true } } });

function priced(day, { line = '2.5', league = 'epl', period = 'FT', kind = 'TOTAL', lineSide = null,
  canonicalHt = false, sequence = day + 1, id = String(1000 + day) } = {}) {
  return changed(fixtureCapture({ league, id, sequence, period: period === 'FT' ? 'REGULATION_FT' : 'REGULATION_HT' }), value => {
    const p = value.snapshot, game = p.evidence.game, shift = time => iso(Date.parse(time) + day * DAY);
    for (const key of ['runStartedAt', 'observedAt', 'analysisCutoff']) p[key] = shift(p[key]);
    value.capturedAt = shift(value.capturedAt); game.startTime = shift(game.startTime);
    game.date = game.startTime.slice(0, 10); p.date = game.date; value.date = game.date;
    game.home.name = 'Synthetic home'; game.away.name = 'Synthetic away';
    if (canonicalHt) p.halfTimePrediction = predictHalfTimeDistribution(p.prediction, {
      version: HALF_TIME_MODEL_VERSION, protocolVersion: HALF_TIME_PROTOCOL_VERSION,
      league, period: 'REGULATION_HT', cutoff: '2026-01-01T00:00:00.000Z',
      shares: { home: .45, away: .43 }, trainingHash: soccerForwardHash('HT:synthetic-training'),
      trainedThrough: '2025-12-30T00:00:00.000Z' });
    for (const source of [p.evidence.source, p.evidence.scheduleSource, p.inputVersions.scheduleSourceVersion, game.source])
      source.fetchedAt = shift(source.fetchedAt);
    p.inputVersions.evidenceFetchedAt = p.evidence.source.fetchedAt;
    const reader = { revision: soccerForwardHash(['reader', day, sequence]), observationId: soccerForwardHash(['reader-observation', day, sequence]),
      observedAt: p.analysisCutoff, firstFetchedAt: p.analysisCutoff, receivedAt: p.analysisCutoff, persistedAt: p.analysisCutoff,
      sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/' };
    const market = { period, kind, lineSide, unit: 'GOALS', line,
      overWater: .95, underWater: .9, homeWater: .95, awayWater: .9,
      rawRows: [`大${line} 0.95`, '小0.9'], periodEvidence: { period, status: 'EXPLICIT',
        sectionTitle: league === 'epl' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽',
        tableHeaders: [period === 'FT' ? '全場' : '上半場'], marketHeader: period === 'FT' ? '全場大小' : '上半場大小' } };
    p.directions = buildSoccerMarketDirections({ reader, game, now: Date.parse(p.analysisCutoff), matchedGames: [{
      officialGameId: game.id, league: league.toUpperCase(), boardDate: game.date, matchStatus: 'MATCHED', prestart: true, markets: [market] }] });
  });
}
const quote = capture => capture.snapshot.directions.find(value => ['TOTAL_OVER', 'HANDICAP_HOME'].includes(value.direction) && value.quotes.length).quotes[0];
function observations(captures) {
  const evaluations = [], checks = [];
  for (const [index, capture] of captures.entries()) {
    const at = Date.parse(capture.snapshot.evidence.game.startTime) + (after - (active + 3600000));
    const result = resultFor(capture);
    result.observedAt = iso(at); result.sources.forEach((source, sourceIndex) => { source.fetchedAt = iso(at - (sourceIndex ? 0 : 60000)); });
    result.fullTime = { home: index % 2 ? 0 : 2, away: index % 2 ? 0 : 1, period: 'REGULATION_FT' };
    result.halfTime = { home: Math.min(1, result.fullTime.home), away: 0, period: 'REGULATION_HT', verified: true };
    result.resultHash = soccerForwardHash(['synthetic-result', capture.gameId, result.fullTime]);
    const evaluation = evaluateSoccerForwardCapture(capture, protocol, result, at);
    evaluation.marketReturnValidation = evaluateSoccerMarketReturnCapture({ capture, protocol, result, now: at, resolveContract });
    evaluations.push(evaluation); checks.push({ captureId: capture.captureId, checkedAt: iso(at), resultEvidence: result,
      marketReturnEvidenceHash: evaluation.marketReturnValidation.evidenceHash });
  }
  return { protocol, captures, evaluations, checks, truncated: false,
    readCoverage: { status: 'COMPLETE_WITHIN_REQUESTED_SCOPE' }, incompleteResultCaptureIds: [] };
}
const captures = [priced(0), priced(1)], targetCapture = priced(3), target = { capture: targetCapture, quoteKey: quote(targetCapture).key };
const evidence = observations(captures), now = active + 6 * DAY;
if (process.argv.includes('--real-policy')) {
  const result = buildConditionalReturnResearchBridge({ evidence, target, now }, { resolveContract });
  assert.equal(result.status, 'NOT_COMPUTABLE');
  assert.equal(result.excludedReasons.BRIDGE_TARGET_ORIGINAL_CAPTURE_OR_IDENTITY_UNAVAILABLE, 1);
  console.log('Real identity policy rejects synthetic claims: PASS');
} else {
  assert.ok(evidence.evaluations.every(value => value.status === 'EVALUATED'));
  const original = JSON.stringify(evidence), build = input => buildConditionalReturnResearchBridge({ evidence, target, now, ...input }, { resolveContract });
  const result = build();
  assert.equal(result.status, 'REPLAYED_RESEARCH_ROWS');
  assert.equal(result.distinctGames, 2); assert.equal(result.rows.length, 2);
  assert.equal(result.target.period, 'FT'); assert.equal(result.target.side, 'over');
  assert.deepEqual(result.target.features, { homeRate: 1.7, awayRate: 1.1, rho: -.05, lineMagnitude: 2.5, lineBoundary: 0, water: .95 });
  assert.deepEqual(result.featureDescriptor, CONDITIONAL_RETURN_FEATURE_DESCRIPTOR);
  assert.ok(result.rows.every(row => row.side === 'over' && row.weight === null && row.weightDeclaredAt === null && row.blockId === null));
  assert.ok(result.rows.every(row => row.payoffSupport.lower <= -.99 && row.payoffSupport.upper >= .96));
  assert.ok(result.rows.every(row => row.tailError === 0 && row.numericalTailError === null), 'resolved tails do not certify floating-point integration');
  assert.ok(result.rows.every(row => Date.parse(row.outcomeFirstSourceFetchedAt) < Date.parse(row.resultAvailableAt)),
    'the first endpoint can reveal the result before the later crosscheck');
  assert.ok(result.rows.every(row => row.featureSource.analysisRevision === row.analysisRevision
    && row.featureSource.quoteKey === row.quoteKey && row.featureSource.contractHash === row.contractHash));
  assert.equal(result.accepted, false); assert.equal(result.formalEligible, false); assert.equal(result.R, null); assert.equal(result.S, null);
  assert.equal(result.strictHistoricalPit, false); assert.equal(result.rawSourceHashRecomputed, false);
  assert.equal(result.requestedScopeComplete, true);
  assert.ok(result.excludedReasons.BRIDGE_SCOPE_MISMATCH >= 2, 'opposite sides remain separate');
  assert.deepEqual(build(), result); assert.equal(JSON.stringify(evidence), original);
  // Actual producer -> consumer contract, without inventing a Production
  // registration, assumption proof, numerical certificate or independent game.
  const study = { version: VERSION, registeredAt: iso(active - 3000), calibrationFrom: iso(active),
    calibrationBefore: iso(active + 3 * DAY), modelTrainedThrough: '2025-12-30T00:00:00.000Z', alpha: .1,
    scope: Object.fromEntries(['league', 'period', 'variant', 'modelHash', 'settlementRuleFamilyHash', 'kind', 'side', 'lineSide']
      .map(key => [key, result.target[key]])), featureDescriptor: result.featureDescriptor,
    weightNormalization: 'NORMALIZE_DECLARED_WEIGHTS', selectionPolicy: 'DECLARED_WITHOUT_OUTCOMES',
    dependencyPolicy: 'DECLARED_BLOCKS_NOT_AUTOMATICALLY_VERIFIED' };
  assert.equal(conditionalReturnResearchHash(study.featureDescriptor), result.target.featureDescriptorHash);
  const consumed = estimateConditionalReturnError({ protocol: study, target: result.target,
    observations: result.rows.map(row => ({ ...row, weight: 1, weightDeclaredAt: iso(active - 1000),
      blockId: 'WHOLE_SYNTHETIC_COHORT_NOT_PROVEN_INDEPENDENT' })), now });
  assert.equal(consumed.status, 'COMPONENTS_ONLY_MISSING_ASSUMPTIONS', JSON.stringify(consumed));
  assert.equal(consumed.realGames, 2); assert.equal(consumed.declaredDependencyBlocks, 1);
  assert.ok(consumed.reasons.includes('NUMERICAL_OR_TAIL_BOUND_UNKNOWN'));
  assert.ok(consumed.reasons.includes('OMITTED_CONTEXT_BOUND_UNKNOWN'));
  assert.equal(consumed.conditionalTotalBound, null); assert.equal(consumed.formalMargin, null);
  assert.equal(consumed.R, null); assert.equal(consumed.S, null);

  const fakeDerived = build({ evidence: { ...evidence, observations: [{ realizedNetReturn: 999, accepted: true }],
    features: { homeRate: 999 }, rows: [{ accepted: true }], rawSourceHashRecomputed: true } });
  assert.deepEqual(fakeDerived, result, 'caller-computed returns, features and provenance flags are ignored');
  const duplicate = build({ evidence: { ...evidence, captures: [...captures, captures[0]],
    evaluations: [...evidence.evaluations, evidence.evaluations[0]], checks: [...evidence.checks, evidence.checks[0]] } });
  assert.equal(duplicate.rows.length, 2); assert.equal(duplicate.distinctGames, 2, 'duplicate receipts cannot create more independent games');
  const tampered = structuredClone(evidence);
  tampered.evaluations[0].marketReturnValidation.observations[0].realizedNetReturn = 999;
  const isolated = build({ evidence: tampered });
  assert.equal(isolated.distinctGames, 1); assert.equal(isolated.originalDatasetDiagnostics.quarantinedGames, 1);
  const noResults = build({ evidence: { ...evidence, checks: [] } });
  assert.equal(noResults.rows.length, 0);
  const notComplete = build({ evidence: { ...evidence, truncated: true } });
  assert.equal(notComplete.requestedScopeComplete, false, 'complete selected games do not repair an incomplete requested range');
  const withFuture = build({ evidence: observations([...captures, priced(4)]) });
  assert.equal(withFuture.rows.length, 2); assert.ok(withFuture.excludedReasons.BRIDGE_RESULT_NOT_KNOWN_BEFORE_TARGET);
  const targetHistory = build({ evidence: observations([...captures, targetCapture]) });
  assert.equal(targetHistory.rows.length, 2); assert.ok(targetHistory.excludedReasons.BRIDGE_TARGET_GAME_EXCLUDED);
  const lateContract = buildConditionalReturnResearchBridge({ evidence, target, now }, {
    resolveContract: record => ({ ...resolveContract(record), verifiedAt: iso(now) }) });
  assert.equal(lateContract.status, 'NOT_COMPUTABLE'); assert.equal(lateContract.excludedReasons.BRIDGE_TERMS_NOT_BOUND_AT_CUTOFF, 1);
  const defaultAuthority = buildConditionalReturnResearchBridge({ evidence, target, now });
  assert.equal(defaultAuthority.rows.length, 0, 'synthetic contract resolver is never a default runtime approval');
  const creditTarget = priced(3, { line: '3-80' });
  const credit = build({ target: { capture: creditTarget, quoteKey: quote(creditTarget).key } });
  assert.equal(credit.target.features.lineMagnitude, 3); assert.equal(credit.target.features.lineBoundary, -.8);
  assert.equal(credit.target.numericalTailError, null);
  const homeGiving = priced(3, { kind: 'HANDICAP', line: '1', lineSide: 'home' });
  const homeReceiving = priced(3, { kind: 'HANDICAP', line: '1', lineSide: 'away' });
  const giving = build({ target: { capture: homeGiving, quoteKey: quote(homeGiving).key } });
  const receiving = build({ target: { capture: homeReceiving, quoteKey: quote(homeReceiving).key } });
  assert.equal(giving.target.lineSide, 'home'); assert.equal(receiving.target.lineSide, 'away');
  assert.deepEqual(giving.target.features, receiving.target.features);
  assert.notEqual(giving.target.quoteIdentity, receiving.target.quoteIdentity,
    'opposite giving-team orientation is retained in categorical scope, never a zero-distance interchangeable price');
  assert.equal(giving.target.predictedNetReturn, null, 'unresolved handicap tail does not acquire a midpoint point protocol');
  assert.equal(giving.target.forecast.type, 'INTERVAL'); assert.equal(giving.target.forecast.point, null);
  assert.ok(giving.target.forecast.lower < giving.target.forecast.upper);
  const ht = priced(3, { period: 'HT' });
  const halfTime = build({ target: { capture: ht, quoteKey: quote(ht).key } });
  assert.equal(halfTime.target.period, 'HT'); assert.equal(halfTime.rows.length, 0);
  assert.notEqual(halfTime.target.modelHash, result.target.modelHash);
  assert.ok(halfTime.excludedReasons.BRIDGE_SCOPE_MISMATCH, 'FT and HT never share a research cohort');
  const changedModel = changed(targetCapture, value => {
    value.snapshot.prediction.trainingHash = soccerForwardHash('synthetic-second-model');
    value.snapshot.inputVersions.modelTrainingHash = value.snapshot.prediction.trainingHash;
  });
  const model = build({ target: { capture: changedModel, quoteKey: quote(changedModel).key } });
  assert.equal(model.rows.length, 0); assert.ok(model.excludedReasons.BRIDGE_SCOPE_MISMATCH);
  const ucl = priced(2, { league: 'ucl' });
  const mixedLeague = build({ evidence: { ...evidence, ...observations([...captures, ucl]) } });
  assert.equal(mixedLeague.rows.length, 2); assert.ok(mixedLeague.excludedReasons.BRIDGE_SCOPE_MISMATCH);
  const unsupported = changed(targetCapture, value => { value.snapshot.prediction.distributionFamily = 'CALLER_UNSUPPORTED'; });
  assert.equal(build({ target: { capture: unsupported, quoteKey: quote(unsupported).key } }).status, 'NOT_COMPUTABLE');

  // Every direction of both leagues goes through original capture/result
  // admission, exact contract/payoff replay and the shipped research consumer.
  // Each invocation is one hypothetical target, NOT simultaneous 8-way coverage.
  let directionCases = 0;
  for (const league of ['epl', 'ucl']) for (const period of ['FT', 'HT']) for (const kind of ['TOTAL', 'HANDICAP']) {
    const options = { league, period, kind, line: kind === 'HANDICAP' ? '1-80' : '2.5',
      lineSide: kind === 'HANDICAP' ? 'home' : null, canonicalHt: period === 'HT' };
    const history = observations([priced(0, options), priced(1, options)]), next = priced(3, options);
    for (const side of kind === 'TOTAL' ? ['over', 'under'] : ['home', 'away']) {
      const originalQuote = next.snapshot.directions.flatMap(value => value.quotes).find(value => value.side === side);
      const replay = buildConditionalReturnResearchBridge({ evidence: history,
        target: { capture: next, quoteKey: originalQuote.key }, now }, { resolveContract });
      assert.equal(replay.rows.length, 2, `${league}/${period}/${kind}/${side}: ${JSON.stringify(replay)}`);
      assert.equal(replay.target.forecast.type, kind === 'HANDICAP' ? 'INTERVAL' : 'POINT');
      assert.equal(replay.target.forecast.modelHash, replay.target.modelHash);
      if (kind === 'HANDICAP') {
        assert.equal(replay.target.predictedNetReturn, null);
        assert.equal(replay.target.forecast.point, null);
        assert.ok(replay.rows.every(row => row.status === 'OBSERVED_BOUNDED' && row.predictedNetReturn === null
          && row.forecast.type === 'INTERVAL' && row.forecastCertificate.arithmeticRoundingIncluded === true));
        if (league === 'epl' && period === 'FT' && side === 'home') {
          const forged = structuredClone(history);
          for (const [index, evaluation] of forged.evaluations.entries()) {
            const check = evaluation.marketReturnValidation;
            check.observations.forEach(row => { if (row.certifiedDifferenceReturn) {
              row.certifiedDifferenceReturn.predictedReturnBounds = { lower: 998, upper: 999 };
              row.certifiedDifferenceReturn.status = 'CERTIFIED_NUMERICAL_MODEL_LAW_INTERVAL';
            } });
            const { evidenceHash, checkedAt, ...body } = check;
            check.evidenceHash = soccerForwardHash({ ...body,
              observations: check.observations.map(({ checkedAt, ...row }) => row) });
            forged.checks[index].marketReturnEvidenceHash = check.evidenceHash;
          }
          const rebuilt = buildConditionalReturnResearchBridge({ evidence: forged,
            target: { capture: next, quoteKey: originalQuote.key }, now }, { resolveContract });
          assert.deepEqual(rebuilt.rows.map(row => row.forecast), replay.rows.map(row => row.forecast),
            'even a resealed derived legacy certificate is ignored; original model/contract arithmetic is rerun');
          const noncanonical = changed(next, value => {
            value.snapshot.prediction.cells[0].probability += 1e-14;
            value.snapshot.prediction.cells[1].probability -= 1e-14;
            value.snapshot.certifiedDifferenceReturn = { status: 'CERTIFIED_NUMERICAL_MODEL_LAW_INTERVAL',
              predictedReturnBounds: { lower: 998, upper: 999 } };
          });
          const unknown = buildConditionalReturnResearchBridge({ evidence: history,
            target: { capture: noncanonical, quoteKey: quote(noncanonical).key }, now }, { resolveContract });
          assert.equal(unknown.target.forecast, null, 'noncanonical PMF does not borrow an attached certificate label');
          assert.equal(unknown.target.numericalTailError, null);
        }
      }
      const scoped = { ...study, scope: Object.fromEntries(Object.keys(study.scope).map(key => [key, replay.target[key]])) };
      const estimated = estimateConditionalReturnError({ protocol: scoped, target: replay.target,
        observations: replay.rows.map(row => ({ ...row, weight: 1, weightDeclaredAt: iso(active - 1000),
          blockId: 'WHOLE_SYNTHETIC_COHORT_NOT_PROVEN_INDEPENDENT' })), now });
      assert.equal(estimated.status, 'COMPONENTS_ONLY_MISSING_ASSUMPTIONS', JSON.stringify(estimated));
      assert.equal(estimated.conditionalTotalBound, null); assert.equal(estimated.formalMargin, null);
      assert.equal(estimated.R, null); assert.equal(estimated.S, null);
      assert.ok(estimated.reasons.includes('NUMERICAL_OR_TAIL_BOUND_UNKNOWN'));
      directionCases++;
    }
  }
  assert.equal(directionCases, 16);
  // Tiny canonical rates can make the legacy retained mass round to one.
  // Its scalar receipt must not conflict with the separately certified
  // infinite-series interval selected by this research protocol.
  const lowRate = capture => changed(capture, value => {
    value.snapshot.prediction = { ...value.snapshot.prediction, ...scoreDistribution(1e-18, 1e-18, 0) };
  });
  const lowOptions = { kind: 'HANDICAP', line: '0', lineSide: 'home' };
  const lowHistory = observations([lowRate(priced(0, lowOptions)), lowRate(priced(1, lowOptions))]);
  const lowTarget = lowRate(priced(3, lowOptions));
  assert.equal(lowTarget.snapshot.prediction.tailMass, 0, 'regression actually reaches the rounded-zero legacy tail');
  const low = buildConditionalReturnResearchBridge({ evidence: lowHistory,
    target: { capture: lowTarget, quoteKey: quote(lowTarget).key }, now }, { resolveContract });
  assert.equal(low.rows.length, 2);
  assert.equal(low.target.forecast.type, 'INTERVAL'); assert.equal(low.target.predictedNetReturn, null);
  assert.equal(typeof low.target.legacyOriginalPredictedNetReturn, 'number');
  assert.ok(low.rows.every(row => row.forecast.type === 'INTERVAL' && row.predictedNetReturn === null
    && typeof row.legacyOriginalPredictedNetReturn === 'number' && row.predictionError === null));
  const lowStudy = { ...study, scope: Object.fromEntries(Object.keys(study.scope).map(key => [key, low.target[key]])) };
  const lowEstimate = estimateConditionalReturnError({ protocol: lowStudy, target: low.target,
    observations: low.rows.map(row => ({ ...row, weight: 1, weightDeclaredAt: iso(active - 1000),
      blockId: 'WHOLE_SYNTHETIC_COHORT_NOT_PROVEN_INDEPENDENT' })), now });
  assert.equal(lowEstimate.status, 'COMPONENTS_ONLY_MISSING_ASSUMPTIONS', JSON.stringify(lowEstimate));
  assert.equal(lowEstimate.formalMargin, null); assert.equal(lowEstimate.R, null); assert.equal(lowEstimate.S, null);

  const real = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--real-policy'], { encoding: 'utf8' });
  assert.equal(real.status, 0, real.stdout + real.stderr);
  console.log('Conditional-return original-evidence bridge: PASS, both leagues x 8 point/interval directions (synthetic research fixtures only)');
}
