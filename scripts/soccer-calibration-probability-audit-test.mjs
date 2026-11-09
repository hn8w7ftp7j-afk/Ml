import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerCalibrationShadowFixture } from './helpers/soccer-calibration-shadow-fixture.mjs';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerProbabilityAudit } from '../lib/soccer/probability-audit.js';
import { mergeSoccerProbabilityAudits } from '../lib/soccer/probability-audit-aggregation.js';
import { evaluateSoccerCalibrationProspectiveValidation, soccerCalibrationHash } from '../lib/soccer/calibration-research.js';
import { retainSoccerProviderDocument } from '../lib/soccer/provider-document.js';

const scope = { league: 'epl', period: 'REGULATION_FT', fold: 'CALIBRATION_PROSPECTIVE_FROZEN', modelHash: 'a'.repeat(64) };
const observation = (eventId, p, actualOutcome) => ({ ...scope, eventId, status: 'EVALUATED', probabilities: { home: p, draw: 0, away: 1 - p },
  actualOutcome, retainedMass: 1, tailMass: 0, exactScoreLogProbability: -Infinity, exactScoreLogProbabilityState: 'ZERO_MODEL_PROBABILITY' });
const audit = rows => buildSoccerProbabilityAudit(rows, { ...scope, includeGameIdentities: true });
const a = audit([observation('1', .4, 'home')]), b = audit([observation('2', .4, 'away')]);
const combined = mergeSoccerProbabilityAudits(a, b, scope), direct = audit([observation('1', .4, 'home'), observation('2', .4, 'away')]);
assert.deepEqual(combined.classes.home.bins, direct.classes.home.bins);
assert.ok(Math.abs(combined.classes.home.ECE_L1 - .1) < 1e-12);
assert.ok(Math.abs(combined.classes.home.REL_L2 - .01) < 1e-12);
assert.ok(Math.abs(combined.classes.home.MCE_Linf - .1) < 1e-12);
assert.notEqual(combined.classes.home.ECE_L1, (a.classes.home.ECE_L1 + b.classes.home.ECE_L1) / 2);
assert.equal(combined.exactScoreEvidence.zeroModelProbability, 2, 'infinite exact-score loss does not discard valid probability calibration bins');
const zero = mergeSoccerProbabilityAudits(null, audit([]), scope);
for (const key of ['home', 'draw', 'away']) for (const metric of ['ECE_L1', 'REL_L2', 'MCE_Linf']) assert.equal(zero.classes[key][metric], null);
assert.throws(() => mergeSoccerProbabilityAudits(a, a, scope), /AGGREGATION_INVALID/);
const invalidMass = structuredClone(a);
for (const key of ['home', 'draw', 'away']) {
  const value = invalidMass.classes[key];
  value.bins = value.bins.map(bin => ({ ...bin, count: bin.index === 8 ? 1 : 0, sumPredicted: bin.index === 8 ? .8 : 0,
    sumObserved: bin.index === 8 ? value.positiveCount : 0, meanPredicted: bin.index === 8 ? .8 : null,
    observedFrequency: bin.index === 8 ? value.positiveCount : null }));
  value.ECE_L1 = Math.abs(.8 - value.positiveCount); value.REL_L2 = (.8 - value.positiveCount) ** 2;
}
assert.throws(() => mergeSoccerProbabilityAudits(null, invalidMass, scope), /AGGREGATION_INVALID/, 'three self-consistent class bins cannot claim total probability mass 2.4');
const invalidTail = structuredClone(a); invalidTail.probabilityMass.maxTailMass = 1e-5;
assert.throws(() => mergeSoccerProbabilityAudits(null, invalidTail, scope), /AGGREGATION_INVALID/);
for (const mutate of [x => { x.league = 'ucl'; }, x => { x.period = 'REGULATION_HT'; }, x => { x.modelHash = 'b'.repeat(64); },
  x => { x.fold = 'DEVELOPMENT'; }, x => { x.memberGameKeys[0] = 'ucl:1'; }, x => { x.sampleGameKeys[0] = 'epl:999'; },
  x => { x.classes.home.bins[4].lower = .3; }, x => { x.classes.home.bins[4].sumPredicted = .9; },
  x => { delete x.memberGameKeys; }]) {
  const invalid = structuredClone(a); mutate(invalid); assert.throws(() => mergeSoccerProbabilityAudits(null, invalid, scope), /AGGREGATION_INVALID/);
}

// Actual PostgreSQL analysis/source/freeze/capture/check receipts. Old reports
// intentionally have no identity arrays; source replay must reconstruct them
// without rewriting stored bytes or trusting a stored report's self-assertions.
const fixture = await soccerSqlFixture(), { db } = fixture, old = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_V2_URL: process.env.DATABASE_V2_URL };
process.env.DATABASE_URL = 'postgres://fixture.invalid/calibration-audit'; delete process.env.DATABASE_V2_URL;
const iso = value => new Date(value).toISOString(), hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const { analyzeSoccerGame } = await import('../lib/soccer/analysis-service.js');
  const { loadSoccerCalibrationShadowValidationEvidence } = await import('../lib/soccer/calibration-shadow-store.js');
  const { archiveSoccerCalibrationShadowEvaluation } = await import('../lib/soccer/calibration-shadow-evaluation-store.js');
  const { readSoccerCalibrationShadowReport } = await import('../lib/soccer/calibration-shadow-validation.js');
  const empty = await readSoccerCalibrationShadowReport('epl');
  assert.equal(empty.captureGames, 0); assert.equal(empty.validation.before.FT.scoreLogLoss, null);
  assert.equal(empty.validation.before.FT.probabilityAudit, null);
  assert.equal(empty.validation.probabilityAuditScope, null, 'an unfrozen collection cannot publish a frozen model mapping');
  const f = soccerCalibrationShadowFixture(2), kickoff = Date.now() + 5000, captureIds = [];
  for (let index = 0; index < 2; index++) {
    const raw = structuredClone(f.source.summaries[0].data), eventId = String(994500001 + index), c = raw.header.competitions[0];
    raw.header.id = eventId; raw.header.uid = `s:600~l:700~e:${eventId}`; raw.header.date = c.date = iso(kickoff);
    c.id = eventId; c.uid = `${raw.header.uid}~c:${eventId}`; c.status = { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } };
    const source = { provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${eventId}`,
      requestedAt: iso(Date.now() - 1000), fetchedAt: iso(Date.now() - 500), contentHash: hash(raw) };
    const game = normalizeSoccerSchedule({ leagues: [raw.header.league], events: [{ ...raw.header, date: c.date, status: c.status }] }, 'epl', source).games[0];
    const evidence = normalizeSoccerPrematch(raw, game, source, Date.now());
    const saved = await analyzeSoccerGame({ league: 'epl', date: game.date, eventId }, {
      fetchSoccerSchedule: async () => ({ ok: true, games: [game] }), fetchSoccerPrematch: async () => evidence,
      fetchSoccerWorkload: async () => ({ ok: false }), fetchSoccerTeamXg: async () => ({ ok: false }), loadSoccerReaderSnapshot: async () => null,
      enrichSoccerPrematchInputs: async value => value, ensureSoccerForwardProtocol: async () => { throw Error('UNRELATED_TEST_SOURCE'); },
    });
    assert.equal(saved.payload.calibrationShadowCapture.persisted, true, JSON.stringify(saved.payload.calibrationShadowCapture));
    captureIds.push(saved.payload.calibrationShadowCapture.capture.captureId);
  }
  const remaining = kickoff - Date.now() + 5; if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  const context = await loadSoccerCalibrationShadowValidationEvidence('epl', { captureIds });
  for (const record of context.records) {
    const resultDocuments = f.resultDocuments(record);
    for (const doc of [resultDocuments.scoreboard, ...resultDocuments.summaries]) doc.source.requestedAt = doc.source.fetchedAt = iso(Date.now());
    resultDocuments.scoreboard = retainSoccerProviderDocument(resultDocuments.scoreboard);
    resultDocuments.summaries = resultDocuments.summaries.map(retainSoccerProviderDocument);
    const report = evaluateSoccerCalibrationProspectiveValidation({ ...context, records: [{ ...record, resultDocuments }], now: Date.now(), requestedScopeComplete: true });
    assert.equal(report.untouchedVerifiedGames, 1);
    for (const arm of ['before', 'after']) for (const period of ['FT', 'HT']) {
      delete report[arm][period].probabilityAudit.memberGameKeys; delete report[arm][period].probabilityAudit.sampleGameKeys;
    }
    if (record === context.records[1]) {
      report.before.FT.probabilityAudit.memberGameKeys = ['ucl:999'];
      report.before.FT.probabilityAudit.sampleGameKeys = ['ucl:999'];
    }
    delete report.contentHash; report.contentHash = soccerCalibrationHash(report);
    await archiveSoccerCalibrationShadowEvaluation({ league: 'epl', captureId: record.captureReceipt.captureId,
      resultDocuments, status: 'EVALUATED', report });
  }
  const before = (await db.query('SELECT check_id,payload,payload_hash FROM sports_soccer_calibration_checks_v1 ORDER BY check_id')).rows;
  assert.ok(before.some(row => !Object.hasOwn(row.payload.report.before.FT.probabilityAudit, 'memberGameKeys')),
    'a genuinely old report shape with no identity arrays is persisted with its own original seal');
  assert.ok(before.some(row => row.payload.report.before.FT.probabilityAudit.memberGameKeys?.[0] === 'ucl:999'),
    'a persisted diagnostic report cannot supply trusted identities, even with a valid payload hash');
  const whole = await readSoccerCalibrationShadowReport('epl'); assert.equal(whole.untouchedValidatedGames, 2, JSON.stringify(whole.validation.checkReasons));
  const binding = whole.validation.probabilityAuditScope;
  assert.equal(binding.candidateHash, whole.freeze.candidateHash); assert.equal(binding.planHash, whole.freeze.planHash);
  assert.equal(binding.modelHashes.before.FT, whole.freeze.modelHash);
  assert.notEqual(binding.modelHashes.before.HT, whole.freeze.halfTimeModelHash, 'joint HT model identity differs from its conditional component identity');
  await assert.rejects(() => readSoccerCalibrationShadowReport('epl', { baseReport: async () => ({ ...whole,
    freeze: { ...whole.freeze, candidateHash: '0'.repeat(64) } }) }), /CALIBRATION_AUDIT_SCOPE_BINDING_INVALID/);
  const paged = { before: {}, after: {} }; let cursor = '0', revision = null, read = 0;
  do {
    const page = await readSoccerCalibrationShadowReport('epl', {}, { afterSequence: cursor, revision });
    assert.equal(page.validationPage.complete, true); read += page.validationCoverage.readCaptures;
    assert.deepEqual(page.validation.probabilityAuditScope, binding);
    for (const arm of ['before', 'after']) for (const period of ['FT', 'HT']) {
      const value = page.validation[arm][period].probabilityAudit;
      paged[arm][period] = mergeSoccerProbabilityAudits(paged[arm][period], value,
        { league: 'epl', period: `REGULATION_${period}`, fold: 'CALIBRATION_PROSPECTIVE_FROZEN', modelHash: binding.modelHashes[arm][period] });
    }
    cursor = page.validationPage.nextSequence; revision = page.validationPage.revision;
  } while (cursor !== null);
  assert.equal(read, 2);
  for (const arm of ['before', 'after']) for (const period of ['FT', 'HT']) {
    const total = whole.validation[arm][period].probabilityAudit;
    assert.deepEqual(paged[arm][period], total);
    assert.equal(total.cohort.sample, 2); assert.equal(total.memberGameKeys.length, 2);
    assert.ok(total.memberGameKeys.every(key => key.startsWith('epl:99450000')));
    assert.equal(total.formalEnabled, false);
  }
  assert.deepEqual((await db.query('SELECT check_id,payload,payload_hash FROM sports_soccer_calibration_checks_v1 ORDER BY check_id')).rows, before,
    'old immutable no-identity reports and their exact hashes remain unchanged after trusted source replay');
  assert.equal(whole.accepted, false); assert.equal(whole.S, null);
  console.log('PASS prospective calibration probability audits: exact sufficient-statistic bins/ECE/REL/MCE, empty and Infinity semantics, scope/duplicate rejection; real PostgreSQL old check replay rebuilds trusted identities and before/after FT/HT one-read vs paged audit equality without changing stored hashes or acceptance');
} finally {
  for (const key of Object.keys(old)) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
  await fixture.close();
}
