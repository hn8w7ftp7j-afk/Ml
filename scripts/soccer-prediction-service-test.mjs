import assert from 'node:assert/strict';
import fs from 'node:fs';
import { soccerPredictionLiveFixture } from './helpers/soccer-prediction-live-fixture.mjs';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { publishSoccerAnalysisCandidates } from '../lib/soccer/candidate-publication.js';
import { soccerReaderIdentityVerified } from '../lib/soccer/reader-identity-proof.js';
import { soccerCandidatePayloadValid } from '../lib/soccer/candidate-qualification.js';
import { soccerAnalysisHash } from '../lib/soccer/analysis.js';

// Real parser/normalizer, scoped identity proof, immutable PostgreSQL save,
// publication and readback; invented games/quotes only, no Production mutation.
const fixtureDb = await soccerSqlFixture();
const keys = ['DATABASE_URL', 'DATABASE_V2_URL'], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const cases = [], timings = [];
try {
  process.env.DATABASE_URL = 'postgres://fixture.invalid/prediction-service'; delete process.env.DATABASE_V2_URL;
  const { analyzeSoccerGame, loadSoccerCurrentAnalysis } = await import('../lib/soccer/analysis-service.js');
  const { loadSoccerAnalysisRevision } = await import('../lib/soccer/analysis-store.js');
  const { saveSoccerReaderSnapshot } = await import('../lib/soccer/reader-store.js');
  for (const league of ['epl', 'ucl']) {
    const f = await soccerPredictionLiveFixture({ league });
    await saveSoccerReaderSnapshot(f.readerPayload);
    const query = { league, date: f.date, eventId: f.game.sourceId };
    const began = performance.now();
    const actual = await analyzeSoccerGame(query, {
      fetchSoccerSchedule: async () => f.board, fetchSoccerPrematch: async () => structuredClone(f.evidence),
      fetchSoccerWorkload: async () => ({ ok: false, status: 'INCOMPLETE', teams: {}, sources: [], modelEffectApplied: false, executable: false }),
      fetchSoccerTeamXg: async () => ({ ok: false, reason: 'SYNTHETIC_NO_MATCH_NPXG' }),
      enrichSoccerPrematchInputs: async evidence => evidence,
      ensureSoccerForwardProtocol: async () => { throw Error('Unrelated forward store not part of this test'); },
      ensureSoccerMinutesForwardProtocol: async () => { throw Error('Unrelated minute store not part of this test'); },
      captureSoccerCalibrationShadow: async () => ({ status: 'NOT_CAPTURED', persisted: false, formalEligible: false, executable: false }),
    });
    assert.equal(actual.status, 200, JSON.stringify(actual.payload));
    const result = actual.payload, now = Date.now(), quotes = result.directions.flatMap(direction => direction.quotes);
    assert.equal(result.analysisStatus, 'COMPLETED'); assert.equal(result.qaFlag, 'WARN');
    assert.equal(result.persisted, true); assert.equal(result.publishedCurrent, true);
    assert.equal(result.formalScoringEnabled, false); assert.equal(result.executable, false);
    assert.equal(result.qualification.eligible, false); assert.equal(soccerCandidatePayloadValid(result, now), true);
    assert.equal(soccerReaderIdentityVerified(result), true);
    assert.equal(result.predictionContext.mode, 'PREDICTION');
    assert.equal(result.predictionContext.contextualGoalEffectApplied, false);
    assert.ok(result.missing.length > 0, 'unknown observations stay missing and do not block forecasts');
    assert.equal(quotes.length, 8); assert.equal(result.predictionScoringSummary.scoredQuoteCount, 8);
    assert.equal(result.predictionScoringSummary.currentQuoteCount, 8);
    assert.ok(quotes.some(quote => quote.predictionQualification.eligible), 'favorable invented original price produces a computed candidate');
    for (const quote of quotes) {
      assert.equal(quote.predictionScore.status, 'PREDICTION_SCORE_AVAILABLE');
      assert.equal(quote.predictionScore.totalModelError, null);
      assert.equal(quote.predictionScore.formalEligible, false); assert.equal(quote.scoring.S, null);
      assert.equal(quote.eligible, false); assert.equal(quote.predictionQualification.status, 'CURRENT_PREDICTION');
      assert.equal(quote.predictionQualification.sourceQuoteKey, quote.key);
      assert.equal(quote.predictionQualification.analysisRevision, result.revision);
    }
    cases.push({ name: `${league}-current`, game: f.game, result, now, expectPredictionScore: true, expectRanked: true });
    const loaded = await loadSoccerCurrentAnalysis(league, f.date, f.game.sourceId);
    assert.equal(loaded.currentVersion.revision, result.revision);
    assert.equal(loaded.currentVersion.predictionScoringSummary.currentQuoteCount, 8);
    assert.equal(loaded.currentVersion.formalScoringEnabled, false);
    const saved = await loadSoccerAnalysisRevision(league, f.game.id, f.date, result.revision);
    assert.equal(saved.predictionContext.mode, 'PREDICTION');
    assert.equal(saved.directions.flatMap(direction => direction.quotes).filter(quote => quote.predictionScore?.status === 'PREDICTION_SCORE_AVAILABLE').length, 8);
    const savedBody = (await fixtureDb.db.query('SELECT payload FROM sports_soccer_analysis_v1 WHERE analysis_hash=$1', [result.revision])).rows[0].payload;
    assert.ok(savedBody.directions.every(direction => direction.quotes.every(quote => !quote.predictionQualification)),
      'current receipts are response-time projections, never frozen into original history');
    const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
    assert.equal(soccerAnalysisHash(canonical(savedBody)), result.revision);

    const lateNow = now + 180001;
    const historical = publishSoccerAnalysisCandidates(result, { currentStatus: result.currentResearch, now: lateNow });
    assert.equal(historical.predictionScoringSummary.currentQuoteCount, 0);
    assert.ok(historical.directions.every(direction => direction.quotes.every(quote => quote.predictionQualification.status === 'HISTORICAL_PREDICTION'
      && quote.predictionQualification.eligible === false && quote.predictionScore.score !== null)));
    cases.push({ name: `${league}-historical`, game: f.game, result: historical, now: lateNow, expectPredictionScore: true, expectRanked: false });
    const staleHead = publishSoccerAnalysisCandidates(result, { currentStatus: { ...result.currentResearch, quoteGeneration: '999' }, now });
    assert.equal(staleHead.predictionScoringSummary.currentQuoteCount, 0);
    const forged = structuredClone(result);
    forged.directions.find(direction => direction.quotes.length).quotes[0].predictionScore.score = 10;
    const rejected = publishSoccerAnalysisCandidates(forged, { currentStatus: result.currentResearch, now });
    assert.equal(rejected.directions.find(direction => direction.quotes.length).quotes[0].predictionQualification.status, 'UNAVAILABLE');
    const missingReceipt = publishSoccerAnalysisCandidates({ ...result, persisted: false }, { currentStatus: result.currentResearch, now });
    assert.equal(missingReceipt.predictionScoringSummary.qualifiedQuoteCount, 0);
    timings.push({ league, analyzeAndPersistMs: Math.round(performance.now() - began) });

    const lowFixture = await soccerPredictionLiveFixture({ league, now, totalLine: '2.5', water: .01 });
    await saveSoccerReaderSnapshot(lowFixture.readerPayload);
    const lowRun = await analyzeSoccerGame({ league, date: lowFixture.date, eventId: lowFixture.game.sourceId }, {
      fetchSoccerSchedule: async () => lowFixture.board, fetchSoccerPrematch: async () => structuredClone(lowFixture.evidence),
      fetchSoccerWorkload: async () => ({ ok: false, status: 'INCOMPLETE', teams: {}, sources: [], modelEffectApplied: false, executable: false }),
      fetchSoccerTeamXg: async () => ({ ok: false, reason: 'SYNTHETIC_NO_MATCH_NPXG' }),
      enrichSoccerPrematchInputs: async evidence => evidence,
      ensureSoccerForwardProtocol: async () => { throw Error('Unrelated forward store not part of this test'); },
      ensureSoccerMinutesForwardProtocol: async () => { throw Error('Unrelated minute store not part of this test'); },
      captureSoccerCalibrationShadow: async () => ({ status: 'NOT_CAPTURED', persisted: false, formalEligible: false, executable: false }),
    });
    assert.equal(lowRun.status, 200, JSON.stringify(lowRun.payload));
    const low = lowRun.payload;
    assert.equal(low.publishedCurrent, true);
    assert.equal(low.predictionScoringSummary.scoredQuoteCount, 8);
    assert.equal(low.predictionScoringSummary.qualifiedQuoteCount, 0);
    cases.push({ name: `${league}-low`, game: lowFixture.game, result: low, now: Date.now(), expectPredictionScore: true, expectRanked: false });
    const latest = await loadSoccerCurrentAnalysis(league, lowFixture.date, lowFixture.game.sourceId);
    assert.equal(latest.currentVersion.revision, low.revision);
    const superseded = publishSoccerAnalysisCandidates(result, { currentStatus: latest.currentVersion.currentResearch, now: Date.now() });
    assert.equal(superseded.predictionScoringSummary.currentQuoteCount, 0, 'a real newer DB head fences the prior prediction');
    assert.equal(superseded.predictionScoringSummary.qualifiedQuoteCount, 0);
    const wrongPrice = structuredClone(low);
    wrongPrice.directions.find(direction => direction.quotes.length).quotes[0].water += .1;
    const wrongProjection = publishSoccerAnalysisCandidates(wrongPrice, { currentStatus: low.currentResearch, now: Date.now() });
    assert.equal(wrongProjection.directions.find(direction => direction.quotes.length).quotes[0].predictionQualification.status, 'UNAVAILABLE');
    const { beginSoccerAnalysisRun, getSoccerCurrentResearchStatus } = await import('../lib/soccer/journal.js');
    const reprice = await soccerPredictionLiveFixture({ league, totalLine: '2.5', water: .02 });
    await saveSoccerReaderSnapshot(reprice.readerPayload);
    const changedSource = await getSoccerCurrentResearchStatus(league, lowFixture.date, lowFixture.game.id);
    assert.equal(changedSource.reason, 'QUOTE_CHANGED');
    const repriced = publishSoccerAnalysisCandidates(low, { currentStatus: changedSource, now: Date.now() });
    assert.equal(repriced.predictionScoringSummary.currentQuoteCount, 0, 'a real Reader reprice immediately fences the prior prediction');
    assert.equal((await loadSoccerCurrentAnalysis(league, lowFixture.date, lowFixture.game.sourceId)).currentVersion, null);
    await beginSoccerAnalysisRun({ league, date: lowFixture.date, gameId: lowFixture.game.id });
    const pendingStatus = await getSoccerCurrentResearchStatus(league, lowFixture.date, lowFixture.game.id);
    assert.equal(pendingStatus.reason, 'REANALYSIS_PENDING');
    const pending = publishSoccerAnalysisCandidates(low, { currentStatus: pendingStatus, now: Date.now() });
    assert.equal(pending.predictionScoringSummary.currentQuoteCount, 0);
    assert.equal((await loadSoccerCurrentAnalysis(league, lowFixture.date, lowFixture.game.sourceId)).currentVersion, null);
  }
  fs.writeFileSync('/tmp/soccer-prediction-ui-contract.json', JSON.stringify({ syntheticOnly: true, cases }));
  console.log(JSON.stringify({ ok: true, syntheticOnly: true, cases: cases.length, timings,
    checked: ['available-data forecasts', 'all 16 league/period/direction scores', 'real source identity', 'immutable PostgreSQL save and current readback',
      'favorable and low forecasts', 'source-generation/expiry fences', 'forged score rejection', 'no formal validation promotion'],
    uiContract: '/tmp/soccer-prediction-ui-contract.json' }));
} finally {
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  await fixtureDb.close();
}
