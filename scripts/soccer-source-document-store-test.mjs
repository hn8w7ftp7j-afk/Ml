import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

const fixture = await soccerSqlFixture(), { db } = fixture;
const keys = ['DATABASE_URL', 'DATABASE_V2_URL'], oldEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.DATABASE_URL = 'postgres://fixture.invalid/soccer-source-document'; delete process.env.DATABASE_V2_URL;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = value => new Date(value).toISOString();
const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/soccer/epl-summary.json', import.meta.url)));
const now = Date.now(), fetched = now - 1000;
function evidenceFor({ payload = structuredClone(raw), kickoff = now + 3600000, fetchedAt = iso(fetched), source: supplied = {} } = {}) {
  payload.header.date = iso(kickoff); payload.header.competitions[0].date = payload.header.date;
  payload.header.competitions[0].status = { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } };
  const source = { provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${payload.header.id}`,
    requestedAt: iso(Date.parse(fetchedAt) - 5), fetchedAt, contentHash: hash(payload), ...supplied };
  const competition = payload.header.competitions[0];
  const game = normalizeSoccerSchedule({ leagues: [payload.header.league], events: [{ ...payload.header, date: competition.date, status: competition.status }] }, 'epl', source).games[0];
  const evidence = normalizeSoccerPrematch(payload, game, source, Math.max(now, Date.parse(fetchedAt)));
  assert.equal(evidence.ok, true);
  return { evidence, payload, source };
}
try {
  const { archiveSoccerSourceDocument, loadSoccerSourceDocument, SOCCER_SOURCE_DOCUMENT_MAX_BYTES } = await import('../lib/soccer/source-document-store.js');
  const first = evidenceFor(), serialized = JSON.stringify(first.evidence);
  assert.equal(serialized.includes('lastFiveGames'), false, 'the private document never serializes into normalized evidence');
  const receipt = await archiveSoccerSourceDocument(first.evidence);
  assert.equal(receipt.status, 'ARCHIVED'); assert.equal(receipt.persisted, true); assert.equal(receipt.prematchReceipt, true);
  assert.equal(receipt.representation, 'NORMALIZED_JSON_DOCUMENT');
  assert.equal(receipt.normalizedDocumentHashRecomputed, true); assert.equal(receipt.rawSourceHashRecomputed, false);
  assert.equal(receipt.sourcePublishedAt, null); assert.equal(receipt.historicalAvailabilityVerified, false);
  assert.equal(receipt.independentlyConfirmed, false); assert.equal(receipt.formalEligible, false);
  assert.ok(Date.parse(receipt.recordedAt) >= now, 'receipt time comes from the real database clock, not the old source fetch');
  assert.equal(receipt.fetchedAt, iso(fetched)); assert.ok(JSON.stringify(receipt).length < 2000);
  assert.equal(Object.hasOwn(receipt, 'document'), false); assert.equal(Object.hasOwn(receipt, 'document_text'), false);
  const loaded = await loadSoccerSourceDocument(receipt.receiptId);
  assert.deepEqual(loaded.document, first.payload); assert.equal(hash(loaded.document), receipt.contentHash);
  assert.deepEqual(loaded.receipt, receipt);
  const { buildSoccerAnalysis } = await import('../lib/soccer/analysis.js');
  const withoutArchive = buildSoccerAnalysis({ evidence: first.evidence, now });
  first.evidence.sourceDocumentArchive = receipt;
  const withArchive = buildSoccerAnalysis({ evidence: first.evidence, now });
  for (const field of ['prediction', 'halfTimePrediction', 'personnelPrediction', 'scenarioResearch'])
    assert.deepEqual(withArchive[field], withoutArchive[field], `archiving cannot alter ${field}`);
  assert.equal(withArchive.formalScoringEnabled, false); assert.equal(withArchive.executable, false);
  assert.deepEqual(await archiveSoccerSourceDocument(first.evidence), receipt, 'retry never replaces the first receipt clock');
  const second = evidenceFor({ fetchedAt: iso(fetched + 100) });
  const secondReceipt = await archiveSoccerSourceDocument(second.evidence);
  assert.notEqual(secondReceipt.receiptId, receipt.receiptId);
  assert.equal(secondReceipt.contentHash, receipt.contentHash);
  assert.equal(secondReceipt.documentRecordedAt, receipt.documentRecordedAt);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_source_documents_v1')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_source_document_observations_v1')).rows[0].n, 2);
  for (const table of ['documents', 'document_observations']) {
    await assert.rejects(() => db.query(`UPDATE sports_soccer_source_${table}_v1 SET content_hash=content_hash`), /SOCCER_IMMUTABLE_HISTORY/);
    await assert.rejects(() => db.query(`DELETE FROM sports_soccer_source_${table}_v1`), /SOCCER_IMMUTABLE_HISTORY/);
  }
  for (const forged of [structuredClone(first.evidence), JSON.parse(JSON.stringify(first.evidence)), { ...first.evidence }]) {
    const rejected = await archiveSoccerSourceDocument(forged);
    assert.equal(rejected.persisted, false); assert.equal(rejected.reason, 'SOURCE_DOCUMENT_PRIVATE_PROOF_MISSING');
  }
  for (const mutate of [e => { e.source.contentHash = 'f'.repeat(64); }, e => { e.source.url += '&event=9'; },
    e => { e.game.id = 'soccer:epl:9'; }, e => { e.game.startTime = iso(now + 7200000); },
    e => { e.source.fetchedAt = iso(now - 9000); }, e => { e.sourceEvidence.contentHashVerified = false; }]) {
    const value = evidenceFor(); mutate(value.evidence);
    assert.equal((await archiveSoccerSourceDocument(value.evidence)).reason, 'SOURCE_DOCUMENT_BINDING_CHANGED');
  }
  const mutatedRaw = evidenceFor(), originalRaw = structuredClone(mutatedRaw.payload);
  mutatedRaw.payload.postNormalizationMutation = 'must not alter private original serialization';
  assert.deepEqual((await loadSoccerSourceDocument((await archiveSoccerSourceDocument(mutatedRaw.evidence)).receiptId)).document, originalRaw);
  for (const source of [{ contentHash: 'wrong' }, { url: 'https://evil.invalid/summary?event=401878769' },
    { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/summary?event=401878769' },
    { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=9' }]) {
    const value = evidenceFor({ source });
    assert.equal((await archiveSoccerSourceDocument(value.evidence)).persisted, false);
  }
  const oversized = structuredClone(raw); oversized.testPadding = 'x'.repeat(SOCCER_SOURCE_DOCUMENT_MAX_BYTES);
  assert.equal((await archiveSoccerSourceDocument(evidenceFor({ payload: oversized }).evidence)).reason, 'SOURCE_DOCUMENT_BYTE_BUDGET');
  const past = evidenceFor({ kickoff: now - 1000, fetchedAt: iso(now - 3000) });
  assert.equal(past.evidence.phase, 'POSTSTART_AUDIT');
  const late = await archiveSoccerSourceDocument(past.evidence);
  assert.equal(late.status, 'ARCHIVED'); assert.equal(late.prematchReceipt, false, 'old fetch time cannot backdate the database receipt');
  assert.equal(late.timingStatus, 'AFTER_KICKOFF_DATABASE_RECEIPT');
  const futureSource = evidenceFor({ fetchedAt: iso(Date.now() + 3600000), kickoff: now + 7200000 });
  const futureReceipt = await archiveSoccerSourceDocument(futureSource.evidence);
  assert.equal(futureReceipt.prematchReceipt, false, 'a caller-supplied normalizer clock cannot move the real database clock');
  assert.equal(futureReceipt.timingStatus, 'QUARANTINED_SOURCE_TIME_AFTER_DATABASE_RECEIPT');
  const tamperedQuery = async (sql, params) => (await db.query(sql, params)).rows.map(row => ({ ...row, document_text: '{}', document_bytes: 2 }));
  await assert.rejects(() => loadSoccerSourceDocument(receipt.receiptId, { query: tamperedQuery }), /READBACK_FAILED/);
  console.log('PASS source document PostgreSQL archive: exact normalized JSON hash/readback, body dedup, per-fetch immutable DB clock, bounded private proof, scope/tamper/clone rejection, compact receipts, no historical or formal promotion');

  // Exercise the shipped service, including storage loss. Override only the
  // unrelated research/journal dependencies; the real normalizer and store run.
  const { analyzeSoccerGame } = await import('../lib/soccer/analysis-service.js');
  let builtReceipt, savedBody;
  const makeDeps = value => ({
    ensureSoccerForwardProtocol: async () => { throw Error('unrelated forward capture disabled'); },
    beginSoccerAnalysisRun: async () => ({ runId: 'source-archive-fixture', requestSeq: '1', quoteGeneration: '0', startedAt: iso(now) }),
    fetchSoccerSchedule: async () => ({ ok: true, games: [value.evidence.game] }), recordSoccerCohort: async () => {},
    fetchSoccerPrematch: async () => value.evidence,
    fetchSoccerWorkload: async () => ({ ok: false, status: 'INCOMPLETE', teams: {}, sources: [] }),
    loadSoccerReaderSnapshot: async () => null, listSoccerAnalysis: async () => [],
    buildSoccerAnalysis: ({ evidence }) => { builtReceipt = evidence.sourceDocumentArchive; return { evidence, status: 'RESEARCH_ONLY', analysisStatus: 'COMPLETED', qaFlag: 'WARN', selectionResult: 'RESEARCH_SHADOW', formalScoringEnabled: false, executable: false }; },
    saveSoccerAnalysis: async value => { savedBody = value; return { persisted: true, revision: 'f'.repeat(64) }; },
    finishSoccerAnalysisRun: async () => ({ publishedCurrent: false }), getSoccerCurrentResearchStatus: async () => null,
  });
  const serviceValue = evidenceFor(), request = { league: 'epl', date: serviceValue.evidence.game.date, eventId: serviceValue.evidence.game.sourceId };
  let result = await analyzeSoccerGame(request, makeDeps(serviceValue));
  assert.equal(result.status, 200); assert.equal(builtReceipt.status, 'ARCHIVED');
  assert.equal(savedBody.evidence.sourceDocumentArchive.receiptId, builtReceipt.receiptId);
  assert.equal(JSON.stringify(savedBody).includes('lastFiveGames'), false);
  const unavailableValue = evidenceFor();
  result = await analyzeSoccerGame(request, { ...makeDeps(unavailableValue), archiveSoccerSourceDocument: async () => { throw Error('private connection detail'); } });
  assert.equal(result.status, 200); assert.equal(builtReceipt.reason, 'SOURCE_DOCUMENT_STORAGE_UNAVAILABLE');
  assert.equal(builtReceipt.persisted, false); assert.equal(builtReceipt.prematchReceipt, false);
  assert.equal(JSON.stringify(result).includes('private connection detail'), false);
  result = await analyzeSoccerGame(request, makeDeps({ evidence: structuredClone(evidenceFor().evidence) }));
  assert.equal(result.status, 200); assert.equal(builtReceipt.reason, 'SOURCE_DOCUMENT_PRIVATE_PROOF_MISSING');
  console.log('PASS source document service: archive precedes build/save, compact receipt persists, missing private proof and storage failure remain explicit while research continues');
} finally {
  for (const key of keys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
  await fixture.close();
}
