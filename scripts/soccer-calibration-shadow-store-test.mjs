import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { soccerCalibrationHash, predictSoccerCalibrationResearch } from '../lib/soccer/calibration-research.js';
import { soccerCalibrationShadowArtifacts } from '../lib/soccer/calibration-frozen.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

const fixture = await soccerSqlFixture(), { db } = fixture;
const previous = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_V2_URL: process.env.DATABASE_V2_URL };
process.env.DATABASE_URL = 'postgres://fixture.invalid/calibration-shadow'; delete process.env.DATABASE_V2_URL;
const { analyzeSoccerGame, loadSoccerCurrentAnalysis } = await import('../lib/soccer/analysis-service.js');
const { buildSoccerAnalysis, soccerAnalysisHash } = await import('../lib/soccer/analysis.js');
const { captureSoccerCalibrationShadow, freezeSoccerCalibrationShadowCandidate, ensureSoccerCalibrationShadowStore,
  getSoccerCalibrationShadowReport, loadSoccerCalibrationShadowValidationEvidence, listSoccerCalibrationShadowCaptureIds } =
  await import('../lib/soccer/calibration-shadow-store.js');
const iso = value => new Date(value).toISOString(), clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
let serial = 991000000;
function fresh(league = 'epl', { eventId = String(++serial), kickoff = Date.now() + 3600000 } = {}) {
  const raw = JSON.parse(fs.readFileSync(new URL(`./fixtures/soccer/${league}-summary.json`, import.meta.url)));
  raw.header.id = eventId; raw.header.uid = raw.header.uid.replace(/~e:\d+/, `~e:${eventId}`);
  const competition = raw.header.competitions[0]; competition.id = eventId;
  competition.uid = competition.uid.replace(/~e:\d+/, `~e:${eventId}`).replace(/~c:\d+/, `~c:${eventId}`);
  raw.header.date = iso(kickoff); competition.date = raw.header.date;
  competition.status = { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } };
  const now = Date.now(), source = { provider: 'ESPN',
    url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${league === 'epl' ? 'eng.1' : 'uefa.champions'}/summary?event=${eventId}`,
    requestedAt: iso(now - 25), fetchedAt: iso(now - 20), contentHash: hash(raw) };
  const normalized = normalizeSoccerSchedule({ leagues: [raw.header.league], events: [raw.header] }, league, source);
  assert.equal(normalized.ok, true);
  const evidence = normalizeSoccerPrematch(raw, normalized.games[0], source, now);
  assert.equal(evidence.ok, true);
  return evidence;
}
const deps = evidence => ({
  ensureSoccerForwardProtocol: async () => { throw Error('unrelated forward collection omitted'); },
  fetchSoccerSchedule: async () => ({ ok: true, games: [evidence.game] }), fetchSoccerPrematch: async () => evidence,
  fetchSoccerWorkload: async () => ({ ok: false, status: 'INCOMPLETE', teams: {}, sources: [] }),
  fetchSoccerTeamXg: async () => ({ ok: false, reason: 'UNRELATED_TEST_SOURCE' }), loadSoccerReaderSnapshot: async () => null,
});
async function run(evidence, overrides = {}) {
  const game = evidence.game;
  return analyzeSoccerGame({ league: game.league, date: game.date, eventId: game.sourceId }, { ...deps(evidence), ...overrides });
}
async function original(revision) {
  return (await db.query('SELECT payload FROM sports_soccer_analysis_v1 WHERE analysis_hash=$1', [revision])).rows[0]?.payload;
}
try {
  const empty = await getSoccerCalibrationShadowReport('epl');
  assert.equal(empty.status, 'AWAITING_FIRST_ANALYSIS'); assert.equal(empty.freeze, null); assert.equal(empty.captureGames, 0);
  assert.equal(empty.validationStatus, 'NOT_EVALUATED');

  // An earlier package registry hash is provenance only. The exact EPL payload
  // stays frozen when another league/package metadata changes on redeployment.
  const a = soccerCalibrationShadowArtifacts('epl');
  const body = { version: 'SOCCER-CALIBRATION-SHADOW-v1', league: 'epl', candidate: a.candidate, plan: a.plan, model: a.model, halfTimeModel: a.halfTimeModel };
  const artifactHash = soccerCalibrationHash(body), freezeId = soccerCalibrationHash(['SOCCER-CALIBRATION-SHADOW-v1', 'epl', a.candidate.contentHash, a.plan.contentHash, artifactHash]);
  await ensureSoccerCalibrationShadowStore();
  await db.query(`INSERT INTO sports_soccer_calibration_freezes_v1
    (freeze_id,league,candidate_hash,plan_hash,model_hash,half_time_model_hash,registry_hash,artifact_hash,artifacts)
    VALUES($1,'epl',$2,$3,$4,$5,$6,$7,$8::jsonb)`, [freezeId, a.candidate.contentHash, a.plan.contentHash,
    a.candidate.modelHash, a.candidate.halfTimeModelHash, 'f'.repeat(64), artifactHash, JSON.stringify(body)]);
  const preexisting = await freezeSoccerCalibrationShadowCandidate('epl');
  assert.equal(preexisting.freezeId, freezeId); assert.equal(preexisting.registryHash, 'f'.repeat(64));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_calibration_freezes_v1 WHERE league=\'epl\'')).rows[0].n, 1);

  const captured = []; let fractionalSameSecondClockCases = 0;
  for (const league of ['epl', 'ucl']) {
    const evidence = fresh(league), baseline = clone(buildSoccerAnalysis({ evidence, now: Date.now() }).prediction);
    let databaseClock;
    const transport = globalThis.__SOCCER_TEST_SQL;
    globalThis.__SOCCER_TEST_SQL = async (...args) => {
      const result = await transport(...args);
      for (const rows of result) for (const row of rows) if (row.database_now !== undefined) databaseClock = row.database_now;
      return result;
    };
    let result;
    try { result = await run(evidence); } finally { globalThis.__SOCCER_TEST_SQL = transport; }
    assert.equal(result.status, 200, JSON.stringify(result.payload));
    const receipt = result.payload.calibrationShadowCapture;
    assert.equal(receipt.status, 'SHADOW_PREDICTION_SAVED', JSON.stringify(receipt));
    assert.equal(receipt.persisted, true); assert.equal(receipt.fullTimeCaptured, true); assert.equal(receipt.halfTimeCaptured, true);
    assert.ok(databaseClock instanceof Date, 'exercise real PostgreSQL Date timestamp transport, including fractional milliseconds');
    assert.ok(new Date(databaseClock).getTime() >= Date.parse(result.payload.analysisCutoff));
    if (Date.parse(databaseClock) < Date.parse(result.payload.analysisCutoff)) fractionalSameSecondClockCases++;
    assert.ok(Date.parse(receipt.capture.capturedAt) > Date.parse(receipt.freeze.frozenAt));
    assert.ok(Date.parse(receipt.capture.capturedAt) < Date.parse(evidence.game.startTime));
    assert.ok(Date.parse(receipt.capture.sourceRecordedAt) <= Date.parse(receipt.capture.originalAnalysisCutoff));
    assert.deepEqual(result.payload.prediction, baseline, 'shadow prediction cannot replace the baseline');
    assert.equal(result.payload.formalScoringEnabled, false); assert.equal(result.payload.executable, false);
    const saved = await original(result.payload.revision);
    assert.equal(Object.hasOwn(saved, 'calibrationShadowCapture'), false, 'capture metadata never changes an already hashed analysis');
    assert.equal(saved.analysisHash, result.payload.analysisHash, 'capture leaves the original immutable analysis hash unchanged');
    assert.equal(soccerAnalysisHash(canonical(saved)), result.payload.revision, 'JSONB readback retains the exact canonical storage revision');
    const current = await loadSoccerCurrentAnalysis(league, evidence.game.date, evidence.game.sourceId);
    assert.ok(current.currentVersion); assert.deepEqual(current.currentVersion.prediction, baseline);

    const retry = await Promise.all(Array.from({ length: 3 }, () => captureSoccerCalibrationShadow({ league, gameId: evidence.game.id,
      now: 0, candidateHash: '0'.repeat(64), fullTime: { fake: true }, persisted: true }, result.payload.revision)));
    assert.ok(retry.every(value => value.persisted));
    assert.ok(retry.every(value => value.capture.captureId === receipt.capture.captureId));
    const report = await getSoccerCalibrationShadowReport(league);
    assert.equal(report.captureGames, 1); assert.equal(report.fullTimeCaptures, 1); assert.equal(report.halfTimeCaptures, 1);
    assert.equal(report.untouchedValidatedGames, 0); assert.equal(report.validationStatus, 'NOT_EVALUATED');
    const read = await loadSoccerCalibrationShadowValidationEvidence(league);
    assert.equal(read.records.length, 1);
    const record = read.records[0], expected = predictSoccerCalibrationResearch({ ...read, game: record.prediction.game, now: Date.parse(record.prediction.capturedAt) });
    assert.equal(soccerCalibrationHash(record.prediction.fullTime), soccerCalibrationHash(expected.fullTime));
    assert.equal(soccerCalibrationHash(record.prediction.halfTime), soccerCalibrationHash(expected.halfTime));
    assert.equal(read.verifyFreezeReceipt({ receipt: read.freezeReceipt, candidateHash: read.candidate.contentHash, planHash: read.plan.contentHash }), true);
    assert.equal(read.verifyCaptureReceipt({ receipt: record.captureReceipt, predictionHash: soccerCalibrationHash(record.prediction), capturedAt: record.prediction.capturedAt }), true);
    const correctCandidateHash = read.candidate.contentHash, correctPlanHash = read.plan.contentHash;
    read.candidate.contentHash = '1'.repeat(64); read.plan.contentHash = '2'.repeat(64);
    assert.equal(read.verifyFreezeReceipt({ receipt: read.freezeReceipt, candidateHash: correctCandidateHash, planHash: correctPlanHash }), true,
      'returned artifact mutation cannot change trusted adapter expectations');
    assert.equal(read.verifyFreezeReceipt({ receipt: read.freezeReceipt, candidateHash: read.candidate.contentHash, planHash: read.plan.contentHash }), false);
    const modified = clone(record.captureReceipt); modified.capturedAt = iso(0);
    assert.equal(read.verifyCaptureReceipt({ receipt: modified, predictionHash: soccerCalibrationHash(record.prediction), capturedAt: iso(0) }), false);
    const ids = await listSoccerCalibrationShadowCaptureIds(league, { limit: 1 });
    assert.deepEqual(ids.captureIds, [receipt.capture.captureId]); assert.equal(ids.completeWithinRequestedScope, true);
    const filtered = await loadSoccerCalibrationShadowValidationEvidence(league, { captureIds: [receipt.capture.captureId] });
    assert.equal(filtered.records.length, 1);
    captured.push({ league, evidence, result, receipt });
  }
  const extra = await run(fresh('epl'), { captureSoccerCalibrationShadow: async () => ({ status: 'NOT_CAPTURED', persisted: false,
    reason: 'CONCURRENT_FIRST_CAPTURE_FIXTURE', formalEligible: false, executable: false }) });
  const firstCaptureRace = await Promise.all(Array.from({ length: 3 }, () => captureSoccerCalibrationShadow(extra.payload, extra.payload.revision)));
  assert.ok(firstCaptureRace.every(value => value.persisted));
  assert.equal(new Set(firstCaptureRace.map(value => value.capture.captureId)).size, 1, 'concurrent first captures create one real-game prediction');
  const firstPage = await listSoccerCalibrationShadowCaptureIds('epl', { limit: 1 });
  assert.equal(firstPage.completeWithinRequestedScope, false); assert.ok(firstPage.nextSequence);
  const secondPage = await listSoccerCalibrationShadowCaptureIds('epl', { limit: 1, afterSequence: firstPage.nextSequence });
  assert.equal(secondPage.completeWithinRequestedScope, true); assert.equal(secondPage.nextSequence, null);
  assert.equal(new Set([...firstPage.captureIds, ...secondPage.captureIds]).size, 2, 'sequence continuation neither skips nor duplicates a real game');
  assert.equal((await loadSoccerCalibrationShadowValidationEvidence('epl', { captureIds: secondPage.captureIds })).records.length, 1);
  assert.ok(fractionalSameSecondClockCases > 0, 'at least one actual same-second Date receipt would have been rejected by the old Date.parse(Date) truncation');
  for (const table of ['freezes', 'captures']) {
    await assert.rejects(() => db.query(`UPDATE sports_soccer_calibration_${table}_v1 SET league=league`), /SOCCER_IMMUTABLE_HISTORY/);
    await assert.rejects(() => db.query(`DELETE FROM sports_soccer_calibration_${table}_v1`), /SOCCER_IMMUTABLE_HISTORY/);
  }
  const actualTransport = globalThis.__SOCCER_TEST_SQL;
  for (const mutate of [
    row => { row.source_content_hash = '0'.repeat(64); },
    row => { row.source_receipt_id = '0'.repeat(64); },
    row => { row.original_analysis_cutoff = new Date(0); },
    row => { row.source_recorded_at = new Date(new Date(row.source_recorded_at).getTime() - 1); },
    row => { row.capture_id = '0'.repeat(64); },
  ]) {
    globalThis.__SOCCER_TEST_SQL = async (queries, transaction) => {
      const result = await actualTransport(queries, transaction);
      if (queries.some(value => /SELECT c\.\*.*source_time_bound/s.test(value.query)))
        for (const rows of result) for (const row of rows) if (row.capture_id) mutate(row);
      return result;
    };
    try { await assert.rejects(() => loadSoccerCalibrationShadowValidationEvidence('epl'), /READBACK_FAILED/); }
    finally { globalThis.__SOCCER_TEST_SQL = actualTransport; }
  }
  for (const corruptedCount of [[], [{ games: -1 }], [{ games: 1, first_at: null, last_at: null }]]) {
    globalThis.__SOCCER_TEST_SQL = async (queries, transaction) => {
      const result = await actualTransport(queries, transaction);
      if (queries.some(value => /SELECT count\(\*\)::int AS games/.test(value.query))) return [corruptedCount];
      return result;
    };
    try { await assert.rejects(() => getSoccerCalibrationShadowReport('epl'), /COUNT_READBACK_FAILED/); }
    finally { globalThis.__SOCCER_TEST_SQL = actualTransport; }
  }
  const used = fresh('epl', { eventId: '401878769' });
  const usedResult = await run(used);
  assert.equal(usedResult.payload.calibrationShadowCapture.reason, 'CALIBRATION_SHADOW_GAME_ALREADY_USED');

  const forgedTime = fresh('epl');
  const forged = await run(forgedTime, { buildSoccerAnalysis: args => ({ ...buildSoccerAnalysis(args),
    analysisCutoff: iso(Date.parse(args.evidence.sourceDocumentArchive.recordedAt) - 1) }) });
  assert.equal(forged.status, 200);
  assert.equal(forged.payload.calibrationShadowCapture.reason, 'CALIBRATION_SHADOW_SOURCE_RECEIPT_INVALID', 'saved fake cutoff cannot predate the actual source DB receipt');
  const copiedReceipt = fresh('epl');
  const wrongSource = await run(copiedReceipt, { archiveSoccerSourceDocument: async () => clone(captured[0].evidence.sourceDocumentArchive) });
  assert.equal(wrongSource.status, 200);
  assert.equal(wrongSource.payload.calibrationShadowCapture.reason, 'CALIBRATION_SHADOW_SOURCE_RECEIPT_INVALID', 'another event receipt cannot authorize a prediction');
  const corruptedSource = fresh('ucl'); corruptedSource.teams.home.lineup.status = 'VERIFIED';
  const changedSource = await run(corruptedSource);
  assert.equal(changedSource.payload.calibrationShadowCapture.reason, 'CALIBRATION_SHADOW_SOURCE_RECOMPUTE_FAILED');
  const wrongVenueScope = fresh('epl'); wrongVenueScope.game.neutralSite = !wrongVenueScope.game.neutralSite;
  const changedVenue = await run(wrongVenueScope);
  assert.equal(changedVenue.payload.calibrationShadowCapture.reason, 'CALIBRATION_SHADOW_SOURCE_RECOMPUTE_FAILED',
    'a changed neutral-site input must match the actual retained source game before capture');

  const late = fresh('epl', { kickoff: Date.now() + 250 });
  const lateResult = await run(late, { captureSoccerCalibrationShadow: async (snapshot, revision) => {
    const remaining = Date.parse(snapshot.evidence.game.startTime) - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining + 5));
    return captureSoccerCalibrationShadow({ ...snapshot, analysisCutoff: iso(0), now: 0, prestart: true }, revision);
  } });
  assert.equal(lateResult.status, 200);
  assert.equal(lateResult.payload.calibrationShadowCapture.reason, 'CALIBRATION_SHADOW_ORIGINAL_ANALYSIS_INVALID', 'true DB clock after kickoff cannot be made pregame by supplied fake time');
  assert.equal((await getSoccerCalibrationShadowReport('epl')).captureGames, 2);
  assert.equal((await getSoccerCalibrationShadowReport('ucl')).captureGames, 1);
  console.log('PASS shadow calibration PostgreSQL: actual analysis save hook, true freeze/capture clocks and fractional Date transport, FT/HT atomic first-game capture, immutable exact models and original/source readback, per-league registry continuity, concurrent dedup, fixed trusted receipt adapters, late/fake cutoff/source/scope rejection; baseline and formal W/R/S unchanged');
} finally {
  for (const key of Object.keys(previous)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  await fixture.close();
}
