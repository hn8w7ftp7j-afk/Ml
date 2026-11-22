import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerPredictionLiveFixture } from './helpers/soccer-prediction-live-fixture.mjs';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerRanking } from '../lib/soccer/ranking.js';
import { canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { soccerReaderHash } from '../lib/soccer/reader.js';

// Real parser, current Reader observations, PostgreSQL leases/journal, model,
// immutable saves, publication and ranking. Only upstream provider reads use
// invented fixtures. No Production database or provider is contacted.
const fixture = await soccerSqlFixture();
const query = async (sql, values = []) => {
  try { return (await fixture.db.query(sql, values)).rows; }
  catch (error) { console.error('Fixture SQL failed:', error.message, sql.slice(0, 180)); throw error; }
};
const envKeys = ['DATABASE_URL', 'DATABASE_V2_URL'];
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
process.env.DATABASE_URL = 'postgres://fixture.invalid/soccer-current-refresh';
delete process.env.DATABASE_V2_URL;
try {
  const { enqueueSoccerReaderAnalysis, drainSoccerReaderAnalysis, soccerReaderAnalysisCandidates, soccerReaderEconomicPriceSet } = await import('../lib/soccer/reader-auto-analysis.js');
  const { claimSoccerReaderCurrentRefresh, beginSoccerReaderCurrentRefresh, finishSoccerReaderCurrentRefresh, soccerReaderRefreshDeadline } = await import('../lib/soccer/reader-current-refresh.js');
  const { saveSoccerReaderSnapshot, loadSoccerReaderSnapshot } = await import('../lib/soccer/reader-store.js');
  const { analyzeSoccerGame, loadSoccerCurrentAnalysis } = await import('../lib/soccer/analysis-service.js');
  const { beginSoccerAnalysisRun, finishSoccerAnalysisRun, getSoccerCurrentResearchStatus } = await import('../lib/soccer/journal.js');
  const f = await soccerPredictionLiveFixture({ now: Math.floor(Date.now() / 1000) * 1000 - 2123 });
  const scope = { league: f.league, date: f.date, gameId: f.game.id };
  const scopeValues = [f.league, f.date, f.game.id];
  const headWhere = 'league=$1 AND board_date=$2::date AND game_id=$3';
  const raw = JSON.parse(fs.readFileSync('scripts/fixtures/soccer/epl-summary.json', 'utf8'));
  raw.header.date = f.start;
  raw.header.competitions[0].date = f.start;
  raw.header.competitions[0].status = { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } };
  function currentEvidence() {
    const now = Math.floor(Date.now() / 1000) * 1000 - 877; // Actual past observation ending .123, retained by PostgreSQL Date values.
    return normalizeSoccerPrematch(raw, f.game, {
      provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${f.game.sourceId}`,
      requestedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(),
      contentHash: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
    }, now);
  }
  let analysisCalls = 0, sourceUnavailable = false, lastResponse = null;
  const deps = {
    query, league: f.league, date: f.date, schedule: async () => f.board,
    analyze: async (input, overrides) => {
      analysisCalls++;
      lastResponse = await analyzeSoccerGame(input, {
        ...overrides,
        fetchSoccerPrematch: async () => sourceUnavailable ? { ok: false, code: 'SYNTHETIC_PROVIDER_UNAVAILABLE' } : currentEvidence(),
        fetchSoccerWorkload: async () => ({ ok: false, status: 'INCOMPLETE', teams: {}, sources: [], modelEffectApplied: false, executable: false }),
        fetchSoccerTeamXg: async () => ({ ok: false, reason: 'SYNTHETIC_NO_MATCH_NPXG' }),
        enrichSoccerPrematchInputs: async evidence => evidence,
      });
      return lastResponse;
    },
  };
  const enqueue = () => enqueueSoccerReaderAnalysis(f.league, f.date, { query });
  const drain = overrides => drainSoccerReaderAnalysis({ ...deps, ...overrides });
  const readHead = async () => (await query(`SELECT * FROM sports_soccer_analysis_heads_v2 WHERE ${headWhere}`, scopeValues))[0];
  const runCount = async () => (await query(`SELECT count(*)::int AS n FROM sports_soccer_analysis_runs_v2 WHERE ${headWhere}`, scopeValues))[0].n;
  const due = () => query(`UPDATE sports_soccer_analysis_heads_v2 SET valid_until=clock_timestamp()+interval '10 seconds' WHERE ${headWhere}`, scopeValues);
  const releaseQueue = () => query("UPDATE sports_soccer_reader_analysis_queue_v1 SET retry_at=clock_timestamp()-interval '1 second',lease_until=NULL WHERE league=$1 AND board_date=$2::date", [f.league, f.date]);
  const releaseRefresh = () => query(`UPDATE sports_soccer_reader_current_refresh_v1 SET retry_at=clock_timestamp()-interval '1 second',lease_until=clock_timestamp()-interval '1 second' WHERE ${headWhere}`, scopeValues);
  let lastObservationAt = f.now;
  async function heartbeat() {
    const now = Math.floor(Date.now() / 1000) * 1000 - 877;
    assert.ok(now > lastObservationAt, 'test work must produce a genuinely later observation without future timestamps');
    const payload = structuredClone(f.readerPayload);
    payload.observedAt = new Date(now).toISOString();
    payload.pageActivityAt = payload.observedAt;
    lastObservationAt = now;
    return saveSoccerReaderSnapshot(payload);
  }
  async function candidate() {
    const reader = await loadSoccerReaderSnapshot(f.league, f.date);
    const candidates = soccerReaderAnalysisCandidates(reader, f.board, { league: f.league, date: f.date });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].identityStatus, 'VERIFIED_SCHEDULE_IDENTITY');
    return candidates[0];
  }

  await saveSoccerReaderSnapshot(f.readerPayload);
  await enqueue();
  const initial = await drain();
  assert.equal(initial.captured, 1, JSON.stringify({ initial, status: lastResponse?.status, error: lastResponse?.payload?.error,
    forwardCapture: lastResponse?.payload?.forwardCapture, calibrationShadowCapture: lastResponse?.payload?.calibrationShadowCapture }));
  assert.equal(analysisCalls, 1);
  assert.equal(lastResponse.payload.publishedCurrent, true);
  const first = lastResponse.payload;
  assert.ok(buildSoccerRanking([f.game], { [f.game.id]: { status: 'done', data: first } }).entries.length > 0);
  const originalCapture = await query('SELECT * FROM sports_soccer_reader_analysis_claims_v1 WHERE league=$1 AND board_date=$2::date AND game_id=$3', scopeValues);
  assert.equal(originalCapture.length, 1); assert.equal(originalCapture[0].state, 'CAPTURED');
  const originalSnapshot = (await query('SELECT payload FROM sports_soccer_analysis_v1 WHERE analysis_hash=$1', [first.revision]))[0].payload;
  const originalForward = await query(`SELECT * FROM sports_soccer_forward_captures_v1 WHERE ${headWhere} ORDER BY capture_id`, scopeValues);
  assert.ok(originalForward.length > 0);
  const fixedCaptureTables = ['sports_soccer_calibration_captures_v1', 'sports_soccer_minutes_forward_captures_v1'];
  const fixedCaptures = new Map();
  for (const table of fixedCaptureTables) if ((await query('SELECT to_regclass($1) AS name', [table]))[0].name) {
    fixedCaptures.set(table, await query(`SELECT * FROM ${table} WHERE ${headWhere} ORDER BY capture_id`, scopeValues));
  }
  const firstGeneration = (await readHead()).quote_generation;

  // A new receipt is not a new price and does not cause unnecessary analysis.
  await heartbeat();
  assert.equal((await candidate()).identity, originalCapture[0].identity);
  assert.equal((await claimSoccerReaderCurrentRefresh(await candidate(), { query })).reason, 'REFRESH_NOT_DUE');
  await enqueue();
  const early = await drain();
  assert.equal(early.refreshed, 0); assert.equal(analysisCalls, 1);
  assert.equal(String((await readHead()).quote_generation), String(firstGeneration));

  // Only the mutable head deadline is shortened to exercise the boundary now;
  // the immutable original analysis and observations keep their actual times.
  await due();
  await enqueue();
  const beforeRenewal = await runCount();
  const concurrent = await Promise.all([drain(), drain()]);
  assert.equal(concurrent.reduce((n, result) => n + result.refreshed, 0), 1, JSON.stringify(concurrent));
  assert.equal(await runCount(), beforeRenewal + 1, 'one same-price renewal creates one normal journal run');
  assert.equal(analysisCalls, 2);
  const renewed = lastResponse.payload;
  assert.equal(renewed.publishedCurrent, true);
  assert.notEqual(renewed.revision, first.revision);
  assert.notEqual(renewed.analysisRunId, first.analysisRunId);
  assert.ok(BigInt(renewed.qualificationVersion) > BigInt(first.qualificationVersion));
  assert.equal(renewed.quoteGeneration, first.quoteGeneration);
  assert.ok(Date.parse(renewed.evidence.source.fetchedAt) > Date.parse(first.evidence.source.fetchedAt));
  assert.ok(renewed.directions.flatMap(d => d.quotes).every(q => Date.parse(q.provenance.observedAt) > f.now));
  assert.equal(renewed.validUntil, new Date(Math.min(Date.parse(renewed.evidence.source.fetchedAt) + 180000, Date.parse(f.game.startTime))).toISOString());
  assert.ok(buildSoccerRanking([f.game], { [f.game.id]: { status: 'done', data: renewed } }).entries.length > 0, 'normal published refresh restores current high scores to ranking');
  assert.equal((await loadSoccerCurrentAnalysis(f.league, f.date, f.game.sourceId)).currentVersion.revision, renewed.revision);
  assert.deepEqual(await query('SELECT * FROM sports_soccer_reader_analysis_claims_v1 WHERE league=$1 AND board_date=$2::date AND game_id=$3', scopeValues), originalCapture, 'renewal never rewrites permanent economic-price capture');
  assert.deepEqual((await query('SELECT payload FROM sports_soccer_analysis_v1 WHERE analysis_hash=$1', [first.revision]))[0].payload, originalSnapshot, 'renewal never rewrites original model/source times');
  const refreshedForward = await query(`SELECT * FROM sports_soccer_forward_captures_v1 WHERE ${headWhere} ORDER BY capture_id`, scopeValues);
  assert.ok(refreshedForward.length > originalForward.length, 'new analysis has its own prospective forward audit receipts');
  assert.deepEqual(refreshedForward.filter(row => originalForward.some(old => old.capture_id === row.capture_id)), originalForward);
  for (const [table, rows] of fixedCaptures) assert.deepEqual(await query(`SELECT * FROM ${table} WHERE ${headWhere} ORDER BY capture_id`, scopeValues), rows, `${table} retains its original per-game capture`);

  // Even a due head cannot renew without a later actual original observation.
  await due();
  assert.equal((await claimSoccerReaderCurrentRefresh(await candidate(), { query })).reason, 'REFRESH_NEW_OBSERVATION_REQUIRED');
  await heartbeat();
  const liveCandidate = await candidate();
  const missingSourceTime = structuredClone(originalSnapshot);
  delete missingSourceTime.evidence.source.fetchedAt;
  assert.equal(soccerReaderRefreshDeadline(missingSourceTime, liveCandidate, first.validUntil), null);
  const noMatchingQuotes = structuredClone(liveCandidate);
  for (const quote of noMatchingQuotes.refreshQuotes) quote.provenance.sourceUrl = 'https://www.tai888.in/newapp/index.html';
  noMatchingQuotes.economicPrices = soccerReaderEconomicPriceSet(noMatchingQuotes.refreshQuotes,
    { league: f.league, gameId: f.game.id, snapshot: { inputVersions: { readerSourceObservations: noMatchingQuotes.sourceObservations } } });
  assert.ok(noMatchingQuotes.economicPrices.length > 0);
  const baseDeadline = Math.min(Date.parse(originalSnapshot.validUntil), Date.parse(originalSnapshot.observedAt) + 180000,
    Date.parse(originalSnapshot.evidence.source.fetchedAt) + 180000, Date.parse(f.game.startTime), Date.parse(first.validUntil));
  assert.equal(soccerReaderRefreshDeadline(originalSnapshot, noMatchingQuotes, first.validUntil), baseDeadline,
    'a different already-captured source scope can renew using the verified base analysis deadline');
  const mixedAvailability = structuredClone(originalSnapshot);
  mixedAvailability.directions.flatMap(direction => direction.quotes)[0].predictionScore = {
    status: 'UNAVAILABLE', reason: 'SYNTHETIC_QUOTE_NOT_CALCULATED', score: null, S: null, executable: false,
  };
  assert.ok(Number.isFinite(soccerReaderRefreshDeadline(mixedAvailability, liveCandidate, first.validUntil)),
    'an unavailable direction has no prediction validity and cannot poison the valid base/other quote deadlines');
  const incompleteAvailable = structuredClone(originalSnapshot);
  const missingValidity = incompleteAvailable.directions.flatMap(direction => direction.quotes).find(quote => quote.predictionScore?.status === 'PREDICTION_SCORE_AVAILABLE').predictionScore;
  delete missingValidity.provenance.validUntil; delete missingValidity.validUntil;
  assert.equal(soccerReaderRefreshDeadline(incompleteAvailable, liveCandidate, first.validUntil), null,
    'a claimed available prediction still requires its genuine validity timestamp');
  const missingCalculatedAt = structuredClone(originalSnapshot);
  const incompleteCalculation = missingCalculatedAt.directions.flatMap(direction => direction.quotes).find(quote => quote.predictionScore?.status === 'PREDICTION_SCORE_AVAILABLE').predictionScore;
  delete incompleteCalculation.provenance.calculatedAt; delete incompleteCalculation.calculatedAt;
  assert.equal(soccerReaderRefreshDeadline(missingCalculatedAt, liveCandidate, first.validUntil), null);
  const stale = structuredClone(liveCandidate);
  for (const quote of stale.refreshQuotes) quote.provenance.observedAt = new Date(Date.now() - 181000).toISOString();
  assert.equal((await claimSoccerReaderCurrentRefresh(stale, { query })).reason, 'REFRESH_QUOTE_STALE');
  const forged = structuredClone(liveCandidate);
  for (const quote of forged.refreshQuotes) quote.provenance.readerObservationId = 'f'.repeat(64);
  assert.equal((await claimSoccerReaderCurrentRefresh(forged, { query })).reason, 'REFRESH_OBSERVATION_UNVERIFIED');

  // A manual request after a refresh claim wins; the conditional begin must not
  // insert an orphan run or replace that head, and pending requests are skipped.
  await releaseRefresh();
  const held = await claimSoccerReaderCurrentRefresh(liveCandidate, { query });
  assert.ok(held.token);
  const unheaded = (await query(`INSERT INTO sports_soccer_analysis_runs_v2
    (run_id,league,game_id,board_date,started_at,quote_generation,requirements_version)
    VALUES('synthetic-unheaded-manual',$1,$3,$2::date,clock_timestamp(),$4::bigint,'2.2') RETURNING *`,
  [...scopeValues, held.quoteGeneration]))[0];
  const unheadedCount = await runCount();
  await assert.rejects(() => beginSoccerReaderCurrentRefresh(held, { query }), /SUPERSEDED/);
  assert.equal(await runCount(), unheadedCount, 'a manual INSERT awaiting its head UPDATE already blocks auto begin');
  assert.equal((await readHead()).requested_run_id, held.baseRunId);
  await finishSoccerAnalysisRun({ ...scope, runId: unheaded.run_id, requestSeq: String(unheaded.request_seq), quoteGeneration: String(unheaded.quote_generation) },
    { analysisStatus: 'FAILED', qaFlag: 'BLOCKED', reasons: ['SYNTHETIC_MANUAL_CANCELLED_BEFORE_HEAD_UPDATE'] });
  const manual = await beginSoccerAnalysisRun(scope);
  const beforeBlockedBegin = await runCount();
  await assert.rejects(() => beginSoccerReaderCurrentRefresh(held, { query }), /SUPERSEDED/);
  assert.equal(await runCount(), beforeBlockedBegin);
  assert.equal((await readHead()).requested_run_id, manual.runId);
  assert.equal((await claimSoccerReaderCurrentRefresh(liveCandidate, { query })).reason, 'REFRESH_ANALYSIS_PENDING');
  await finishSoccerReaderCurrentRefresh(held, null, { query });
  await finishSoccerAnalysisRun(manual, { analysisStatus: 'FAILED', qaFlag: 'BLOCKED', reasons: ['SYNTHETIC_MANUAL_FAILURE'] });

  // Provider failure is a real terminal failed/insufficient run; a heartbeat
  // cannot bypass the independent refresh backoff to hammer the provider.
  await releaseRefresh(); await releaseQueue(); await enqueue();
  sourceUnavailable = true;
  const failed = await drain();
  assert.equal(failed.refreshed, 0); assert.ok(failed.retryable > 0);
  assert.equal(lastResponse.payload.publishedCurrent, false);
  assert.equal((await getSoccerCurrentResearchStatus(f.league, f.date, f.game.id)).reason, 'ANALYSIS_NOT_COMPLETED');
  const afterFailureCount = await runCount(), afterFailureCalls = analysisCalls;
  const cooling = (await query(`SELECT last_reason,retry_at>clock_timestamp() AS cooling FROM sports_soccer_reader_current_refresh_v1 WHERE ${headWhere}`, scopeValues))[0];
  assert.equal(cooling.cooling, true); assert.equal(cooling.last_reason, 'REFRESH_NOT_PUBLISHED');
  await enqueue();
  const backedOff = await drain();
  assert.equal(backedOff.refreshed, 0); assert.equal(await runCount(), afterFailureCount); assert.equal(analysisCalls, afterFailureCalls);
  sourceUnavailable = false;
  await releaseRefresh(); await releaseQueue(); await enqueue();
  const recovered = await drain();
  assert.equal(recovered.refreshed, 1, JSON.stringify(recovered));
  assert.equal(lastResponse.payload.publishedCurrent, true);

  // Price adoption after claim prevents an old-generation conditional begin.
  await heartbeat(); await due(); await releaseRefresh();
  const beforeReprice = await candidate();
  const priceClaim = await claimSoccerReaderCurrentRefresh(beforeReprice, { query });
  assert.ok(priceClaim.token);
  const currentLease = (await query(`SELECT * FROM sports_soccer_reader_current_refresh_v1 WHERE ${headWhere}`, scopeValues))[0];
  assert.equal((await finishSoccerReaderCurrentRefresh(held, lastResponse, { query })).refreshed, false);
  assert.deepEqual((await query(`SELECT * FROM sports_soccer_reader_current_refresh_v1 WHERE ${headWhere}`, scopeValues))[0], currentLease, 'late old lease completion cannot overwrite the new owner');
  const changed = structuredClone(f.readerPayload);
  changed.observedAt = new Date(Date.now()).toISOString(); changed.pageActivityAt = changed.observedAt;
  for (const game of changed.games) for (const market of game.markets) if (market.kind === 'TOTAL') market.overWater += .01;
  changed.contentHash = soccerReaderHash(canonicalSoccerPayload(changed));
  await saveSoccerReaderSnapshot(changed);
  const beforeGenerationBegin = await runCount();
  await assert.rejects(() => beginSoccerReaderCurrentRefresh(priceClaim, { query }), /SUPERSEDED/);
  assert.equal(await runCount(), beforeGenerationBegin);
  assert.equal((await getSoccerCurrentResearchStatus(f.league, f.date, f.game.id)).reason, 'QUOTE_CHANGED');
  assert.equal((await finishSoccerReaderCurrentRefresh(priceClaim, lastResponse, { query })).refreshed, false, 'a successful older response cannot acknowledge a changed source generation');
  assert.deepEqual(await query('SELECT * FROM sports_soccer_reader_analysis_claims_v1 WHERE league=$1 AND board_date=$2::date AND game_id=$3', scopeValues), originalCapture);
  assert.equal((await query("SELECT count(*)::int n FROM sports_soccer_reader_current_refresh_v1 WHERE league='ucl'"))[0].n, 0);

  // Production counterexample: both app-entry URL scopes were already captured,
  // but the most recent completed analysis belonged to A while Reader returned
  // to B. No economic quote matches A; verified base deadlines must still allow
  // a normal new analysis for B instead of making permanent capture dedup final.
  const pathA = 'https://www.tai888.in/newapp/', pathB = 'https://www.tai888.in/newapp/index.html';
  async function savePath(pageUrl) {
    const payload = structuredClone(f.readerPayload);
    payload.pageUrl = pageUrl;
    payload.observedAt = new Date(Date.now()).toISOString(); payload.pageActivityAt = payload.observedAt;
    return saveSoccerReaderSnapshot(payload);
  }
  await savePath(pathB); await releaseQueue(); await releaseRefresh(); await enqueue();
  const firstB = await drain();
  assert.equal(firstB.captured, 1, JSON.stringify(firstB));
  assert.equal(firstB.refreshed, 0);
  const bCandidate = await candidate();
  assert.notEqual(bCandidate.identity, originalCapture[0].identity, 'the two app-entry paths remain distinct economic source identities');
  assert.ok(lastResponse.payload.directions.flatMap(direction => direction.quotes).every(quote => quote.provenance.sourceUrl === pathB));
  const bothCaptures = await query(`SELECT * FROM sports_soccer_reader_analysis_claims_v1 WHERE ${headWhere} ORDER BY identity`, scopeValues);
  assert.equal(bothCaptures.length, 2); assert.ok(bothCaptures.every(row => row.state === 'CAPTURED'));
  assert.deepEqual(bothCaptures.find(row => row.identity === originalCapture[0].identity), originalCapture[0]);
  const pathGeneration = String((await readHead()).quote_generation);

  const aReceipt = await savePath(pathA);
  assert.equal(aReceipt.quoteGeneration, pathGeneration, 'source path change alone must not invent a market-price generation');
  const manualA = await deps.analyze({ league: f.league, date: f.date, eventId: f.game.sourceId }, { fetchSoccerSchedule: async () => f.board });
  assert.equal(manualA.status, 200); assert.equal(manualA.payload.publishedCurrent, true);
  assert.ok(manualA.payload.directions.flatMap(direction => direction.quotes).every(quote => quote.provenance.sourceUrl === pathA));
  const headA = await readHead();
  assert.equal(headA.published_revision, manualA.payload.revision);
  await due();
  assert.ok(bCandidate.refreshQuotes.every(quote => Date.parse(quote.provenance.observedAt) <= Date.parse(manualA.payload.observedAt)));
  assert.equal((await claimSoccerReaderCurrentRefresh(bCandidate, { query })).reason, 'REFRESH_NEW_OBSERVATION_REQUIRED',
    'a different source scope is not fresh authority when its receipt predates the current analysis');
  const bReceipt = await savePath(pathB);
  assert.equal(bReceipt.quoteGeneration, pathGeneration);
  const returningB = await candidate();
  assert.equal(returningB.identity, bCandidate.identity, 'returning B uses its existing permanent capture');
  const aPrices = new Set(soccerReaderEconomicPriceSet(
    manualA.payload.directions.flatMap(direction => direction.quotes), { league: f.league, gameId: f.game.id, snapshot: manualA.payload }));
  assert.equal(returningB.economicPrices.filter(price => aPrices.has(price)).length, 0, 'reproduce the real no-matching-economic-quotes state');
  assert.ok(Number.isFinite(soccerReaderRefreshDeadline(manualA.payload, returningB, (await readHead()).valid_until)));
  await releaseQueue(); await releaseRefresh(); await enqueue();
  const pathRunCount = await runCount(), pathCalls = analysisCalls;
  const backToB = await drain();
  assert.equal(backToB.refreshed, 1, JSON.stringify(backToB)); assert.equal(backToB.captured, 0);
  assert.equal(analysisCalls, pathCalls + 1); assert.equal(await runCount(), pathRunCount + 1);
  const newB = lastResponse.payload;
  assert.equal(newB.publishedCurrent, true); assert.notEqual(newB.revision, manualA.payload.revision);
  assert.equal(newB.quoteGeneration, pathGeneration);
  assert.ok(newB.directions.flatMap(direction => direction.quotes).every(quote => quote.provenance.sourceUrl === pathB
    && quote.provenance.readerObservationId === bReceipt.observationId));
  assert.ok(buildSoccerRanking([f.game], { [f.game.id]: { status: 'done', data: newB } }).entries.length > 0);
  assert.deepEqual(await query(`SELECT * FROM sports_soccer_reader_analysis_claims_v1 WHERE ${headWhere} ORDER BY identity`, scopeValues), bothCaptures,
    'switching between already-captured app entries renews current analysis without modifying either original capture');
  await savePath(pathB);
  assert.equal((await claimSoccerReaderCurrentRefresh(await candidate(), { query })).reason, 'REFRESH_NOT_DUE');
  await enqueue();
  const stableB = await drain();
  assert.equal(stableB.refreshed, 0); assert.equal(analysisCalls, pathCalls + 1);
  assert.equal(stableB.refreshSkipped.REFRESH_NOT_DUE, 1, 'the next B heartbeat skips normally instead of creating a renewal loop');
  console.log('PASS real PostgreSQL Reader drain → same-price renewal → normal model/journal/publication/ranking; unchanged CAPTURED history, deadline/availability/freshness gates, concurrent lease, manual/generation CAS, failure recovery and previously-captured app-entry A→B→A→B renewal');
} finally {
  for (const key of envKeys) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
  await fixture.close();
}
