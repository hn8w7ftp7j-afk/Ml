import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { soccerFormalEvidenceReadiness } from '../lib/soccer/formal-evidence-readiness.js';
import { soccerScoringReadiness } from '../lib/soccer/scoring-readiness.js';
import { scoreSoccerQuote } from '../lib/soccer/soccer-scoring.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

const fixture = await soccerSqlFixture();
const before = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_V2_URL: process.env.DATABASE_V2_URL };
process.env.DATABASE_URL = 'postgres://fixture.invalid/current-source-availability'; delete process.env.DATABASE_V2_URL;
const { archiveSoccerSourceDocument, soccerCurrentSourceAvailability, restoreSoccerCurrentSourceAvailability } = await import('../lib/soccer/source-document-store.js');
const { soccerJournalQuery, soccerJournalTransaction } = await import('../lib/soccer/journal.js');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = value => new Date(value).toISOString();
function fresh(league = 'epl') {
  const payload = JSON.parse(fs.readFileSync(new URL(`./fixtures/soccer/${league}-summary.json`, import.meta.url)));
  const now = Date.now(), kickoff = iso(now + 3600000);
  payload.header.date = kickoff; payload.header.competitions[0].date = kickoff;
  payload.header.competitions[0].status = { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } };
  const source = { provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${league === 'epl' ? 'eng.1' : 'uefa.champions'}/summary?event=${payload.header.id}`,
    requestedAt: iso(now - 1100), fetchedAt: iso(now - 1000), contentHash: hash(payload) };
  const game = normalizeSoccerSchedule({ leagues: [payload.header.league], events: [payload.header] }, league, source).games[0];
  return normalizeSoccerPrematch(payload, game, source, now);
}
const audit = (evidence, now = Date.now()) => soccerFormalEvidenceReadiness({ evidence, game: evidence.game, now,
  currentSourceAvailability: soccerCurrentSourceAvailability });
const root = value => value.checks.find(check => check.field === 'evidence');
try {
  for (const league of ['epl', 'ucl']) {
    const evidence = fresh(league);
    assert.equal(root(audit(evidence)).status, 'BLOCKED');
    evidence.sourceDocumentArchive = await archiveSoccerSourceDocument(evidence);
    const now = Date.now(), verified = audit(evidence, now), proof = root(verified).currentAvailability;
    assert.equal(root(verified).status, 'PASS');
    assert.equal(proof.scope, 'CURRENT_ANALYSIS_ONLY');
    assert.equal(proof.historicalAvailabilityVerified, false);
    assert.equal(evidence.source.sourcePublishedAt, null, 'database availability never fabricates publisher time');
    assert.equal(evidence.pointInTimeAvailabilityVerified, false, 'publisher availability flag remains distinct');
    assert.ok(verified.blockers.some(check => check.field === 'teams.home.lineup'), 'source availability cannot approve a provider-only XI');
    assert.ok(verified.blockers.some(check => check.field === 'teams.home.minutes.modelEffectApplied'));
    assert.equal(soccerCurrentSourceAvailability(evidence.source, { evidence, game: evidence.game, now: Date.parse(proof.recordedAt) - 1 }), null,
      'a later real receipt cannot backdate the analysis cutoff');
    const mutableReceipt = evidence.sourceDocumentArchive, originalReceipt = structuredClone(mutableReceipt);
    mutableReceipt.recordedAt = mutableReceipt.fetchedAt;
    mutableReceipt.fetchedAt = iso(Date.parse(originalReceipt.fetchedAt) + 170000);
    assert.equal(soccerCurrentSourceAvailability(evidence.source, { evidence, game: evidence.game, now: Date.parse(originalReceipt.recordedAt) - 1 }), null,
      'mutating the returned receipt cannot backdate the private database clock');
    assert.equal(soccerCurrentSourceAvailability(evidence.source, { evidence, game: evidence.game, now: Date.parse(originalReceipt.fetchedAt) + 180000 }), null,
      'mutating the returned receipt cannot extend the private freshness deadline');
    const copiedReceipt = structuredClone(evidence);
    assert.equal(await restoreSoccerCurrentSourceAvailability(copiedReceipt, Date.parse(originalReceipt.recordedAt) - 1), false,
      'copied mutated receipt cannot backdate the real database readback');
    Object.assign(mutableReceipt, originalReceipt);
    const scored = scoreSoccerQuote({ evidence, game: evidence.game, now });
    assert.equal(scored.stages.find(stage => stage.stage === 'FORMAL_ACCEPTANCE').reasons.includes('SOCCER_SCORE_PREMATCH_PIT_EVIDENCE_INCOMPLETE'), false,
      'the actual formal scorer consumes the current source verifier');
    assert.equal(scored.formalScoringEnabled, false); assert.equal(scored.W, null); assert.equal(scored.R, null); assert.equal(scored.score, null);

    const saved = { evidence, analysisCutoff: iso(now), directions: [] };
    saved.scoreReadiness = soccerScoringReadiness(saved, now, undefined, { currentSourceAvailability: soccerCurrentSourceAvailability });
    const serialized = JSON.parse(JSON.stringify(saved));
    assert.equal(root(audit(serialized.evidence, now)).status, 'BLOCKED', 'JSON carries no formal source authority');
    assert.deepEqual(soccerScoringReadiness(serialized, now + 180000).evidenceReadiness, saved.scoreReadiness.evidenceReadiness,
      'client display preserves the exact saved server audit, without authorizing a calculation');
    serialized.evidence.teams.home.lineup.status = 'VERIFIED';
    assert.equal(root(soccerScoringReadiness(serialized, now).evidenceReadiness).status, 'BLOCKED', 'changed inputs cannot borrow a saved audit');

    const clone = structuredClone(evidence);
    assert.equal(await restoreSoccerCurrentSourceAvailability(clone, Date.now()), true, 'default DB readback + exact normalizer restore current capability');
    assert.equal(root(audit(clone)).status, 'PASS');
    for (const change of [
      value => { value.sourceDocumentArchive.receiptId = '0'.repeat(64); },
      value => { value.source.contentHash = '0'.repeat(64); },
      value => { value.game.home.id = 'soccer:epl:team:999'; },
      value => { value.teams.home.lineup.status = 'VERIFIED'; },
      value => { value.referee = { status: 'VERIFIED', source: value.source }; },
      value => { value.source.sourcePublishedAt = iso(now - 2000); },
    ]) {
      const changed = structuredClone(evidence); change(changed);
      assert.equal(await restoreSoccerCurrentSourceAvailability(changed, Date.now()), false, 'changed source/scope/observation is rejected against retained JSON');
    }
    const unrelated = fresh(league === 'epl' ? 'ucl' : 'epl'); unrelated.sourceDocumentArchive = evidence.sourceDocumentArchive;
    assert.equal(await restoreSoccerCurrentSourceAvailability(unrelated, Date.now()), false, 'receipt cannot cross leagues/events');
    const injected = fresh(league);
    const customQuery = (...args) => soccerJournalQuery(...args);
    injected.sourceDocumentArchive = await archiveSoccerSourceDocument(injected, { query: customQuery });
    assert.equal(injected.sourceDocumentArchive.persisted, true);
    assert.equal(root(audit(injected)).status, 'BLOCKED', 'injected transport cannot mint formal availability even with plausible receipt');
    assert.equal(await restoreSoccerCurrentSourceAvailability(injected), true, 'a subsequent real default database readback can verify the actual stored body');
    const customTransaction = fresh(league);
    customTransaction.sourceDocumentArchive = await archiveSoccerSourceDocument(customTransaction, { transaction: (...args) => soccerJournalTransaction(...args) });
    assert.equal(root(audit(customTransaction)).status, 'BLOCKED', 'custom transaction cannot mint formal availability');

    const transport = globalThis.__SOCCER_TEST_SQL; let reads = 0;
    globalThis.__SOCCER_TEST_SQL = (...args) => { reads++; return transport(...args); };
    try {
      assert.equal(await restoreSoccerCurrentSourceAvailability(structuredClone(evidence), Date.parse(evidence.source.fetchedAt) + 180000), false);
      const started = structuredClone(evidence); started.game.status = 'live';
      assert.equal(await restoreSoccerCurrentSourceAvailability(started), false);
      const future = structuredClone(evidence); future.source.fetchedAt = iso(Date.now() + 1000);
      assert.equal(await restoreSoccerCurrentSourceAvailability(future), false);
      assert.equal(reads, 0, 'stale/poststart/future input stops before any source-document query');
    } finally { globalThis.__SOCCER_TEST_SQL = transport; }
    const mutation = fresh(league); mutation.sourceDocumentArchive = await archiveSoccerSourceDocument(mutation);
    mutation.source.contentHash = 'f'.repeat(64);
    assert.equal(root(audit(mutation)).status, 'BLOCKED', 'in-process mutation revokes the source capability');
    const forgedField = fresh(league);
    forgedField.weather = { status: 'VERIFIED', source: { ...forgedField.source,
      scope: { ...forgedField.source.scope, field: 'weather' } } };
    forgedField.sourceDocumentArchive = await archiveSoccerSourceDocument(forgedField);
    assert.equal(audit(forgedField).checks.find(check => check.field === 'weather').status, 'BLOCKED',
      'copying the document hash into a field absent from the original normalizer never grants authority');
    const forgedFieldClone = structuredClone(forgedField);
    assert.equal(await restoreSoccerCurrentSourceAvailability(forgedFieldClone), false,
      'default restore rejects an invented field claiming the retained document');
    assert.equal(audit(forgedFieldClone).checks.find(check => check.field === 'weather').status, 'BLOCKED',
      'default restore only rebinds fields actually reconstructed from the retained document');
    const changedObservation = fresh(league); changedObservation.teams.home.lineup.status = 'VERIFIED';
    changedObservation.sourceDocumentArchive = await archiveSoccerSourceDocument(changedObservation);
    assert.equal(soccerCurrentSourceAvailability(changedObservation.teams.home.lineup.source,
      { evidence: changedObservation, game: changedObservation.game, field: 'teams.home.lineup', now: Date.now() }), null,
      'changing a provider observation before archive cannot borrow its original field source capability');
    const lateForgery = fresh(league); lateForgery.sourceDocumentArchive = await archiveSoccerSourceDocument(lateForgery);
    lateForgery.weather = { status: 'VERIFIED', source: { ...lateForgery.source,
      scope: { ...lateForgery.source.scope, field: 'weather' } } };
    assert.equal(audit(lateForgery).checks.find(check => check.field === 'weather').status, 'BLOCKED',
      'adding a copied field after archive cannot expand the privately captured source scopes');
    const clonedScope = fresh(league); clonedScope.teams.home.lineup.source = { ...clonedScope.source,
      scope: { ...clonedScope.source.scope, field: 'teams.home.lineup' } };
    clonedScope.sourceDocumentArchive = await archiveSoccerSourceDocument(clonedScope);
    assert.equal(soccerCurrentSourceAvailability(clonedScope.teams.home.lineup.source,
      { evidence: clonedScope, game: clonedScope.game, field: 'teams.home.lineup', now: Date.now() }), null,
      'replacing a field with a cloned/relabelled document source before archive cannot gain that field capability');

    // PostgreSQL retains microseconds while Neon/JS Date can truncate them.
    // An observation made half a millisecond after a saved cutoff must remain
    // unavailable at that cutoff, including after real default DB restoration.
    const precisionEvidence = fresh(league), cutoff = Date.now() + 1000;
    const preciseReceiptTime = iso(cutoff).replace('Z', '500Z');
    await fixture.db.exec(`ALTER TABLE sports_soccer_source_documents_v1 ALTER COLUMN recorded_at
      SET DEFAULT '${preciseReceiptTime}'::timestamptz;
      ALTER TABLE sports_soccer_source_document_observations_v1 ALTER COLUMN recorded_at
      SET DEFAULT '${preciseReceiptTime}'::timestamptz`);
    try {
      precisionEvidence.sourceDocumentArchive = await archiveSoccerSourceDocument(precisionEvidence);
      assert.equal(precisionEvidence.sourceDocumentArchive.recordedAt, iso(cutoff));
      assert.equal(precisionEvidence.sourceDocumentArchive.recordedAtUpperBound, iso(cutoff + 1));
      assert.equal(root(audit(precisionEvidence, cutoff)).status, 'BLOCKED',
        'database receipt microseconds cannot be rounded back to the integer-millisecond analysis cutoff');
      assert.equal(await restoreSoccerCurrentSourceAvailability(structuredClone(precisionEvidence), cutoff), false,
        'default database restoration preserves the same submillisecond boundary');
      assert.equal(root(audit(precisionEvidence, cutoff + 1)).status, 'PASS');
    } finally {
      await fixture.db.exec(`ALTER TABLE sports_soccer_source_documents_v1 ALTER COLUMN recorded_at SET DEFAULT clock_timestamp();
        ALTER TABLE sports_soccer_source_document_observations_v1 ALTER COLUMN recorded_at SET DEFAULT clock_timestamp()`);
    }

    // Exercise both shipped read-time publication paths after the database has
    // JSON-round-tripped the snapshot. Override only external source reads.
    const { analyzeSoccerGame, loadSoccerCurrentAnalysis } = await import('../lib/soccer/analysis-service.js');
    const { listSoccerAnalysisBoard } = await import('../lib/soccer/analysis-store.js');
    const serviceEvidence = fresh(league), game = serviceEvidence.game;
    const service = await analyzeSoccerGame({ league, date: game.date, eventId: game.sourceId }, {
      ensureSoccerForwardProtocol: async () => { throw Error('unrelated forward capture disabled'); },
      fetchSoccerSchedule: async () => ({ ok: true, games: [game] }), fetchSoccerPrematch: async () => serviceEvidence,
      fetchSoccerWorkload: async () => ({ ok: false, status: 'INCOMPLETE', teams: {}, sources: [] }),
      fetchSoccerTeamXg: async () => ({ ok: false, reason: 'UNRELATED_TEST_SOURCE' }), loadSoccerReaderSnapshot: async () => null,
    });
    assert.equal(service.status, 200); assert.equal(service.payload.publishedCurrent, true);
    assert.equal(root(service.payload.scoreReadiness.evidenceReadiness).status, 'PASS');
    const current = await loadSoccerCurrentAnalysis(league, game.date, game.sourceId);
    assert.ok(current.currentVersion, 'actual journal current head remains available');
    assert.equal(root(audit(current.currentVersion.evidence)).status, 'PASS', 'single-game current read restores private authority from the actual stored body');
    const board = await listSoccerAnalysisBoard(league, game.date, game.date);
    const onBoard = board.find(value => value.gameId === game.id);
    assert.equal(onBoard.publishedCurrent, true);
    assert.equal(root(audit(onBoard.evidence)).status, 'PASS', 'board read restores private authority before current publication');
    assert.equal(onBoard.formalScoringEnabled, false);
  }
  console.log('PASS current source availability: real PostgreSQL receipt + normalized JSON readback, current-only source timing, no publisher-time fabrication, private capability/clone/input/transport/cutoff/league guards, restore after current read and saved display separation; model and formal score gates remain blocked');
} finally {
  for (const key of Object.keys(before)) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
  await fixture.close();
}
