import assert from 'node:assert/strict';
import {
  analysisPitRecordFromDatabaseRow,
  analysisPitRecordFromDatabaseRowForAudit,
  assertAnalysisPitFeatureTimeEvidence,
  buildAnalysisPitReplayBundle,
  buildAnalysisPitReplayBundleForAudit,
  buildAnalysisPitSnapshotRecord,
  buildAnalysisPitSnapshotRecordAsync,
  isAnalysisPitIntegrityError,
  persistAnalysisPitSnapshot,
  persistAnalysisPitSnapshotForResponse,
  replayIdentityHash,
  validateAnalysisPitSnapshotRecord,
  validateAnalysisPitSnapshotForAudit,
} from '../lib/analysis-pit-snapshot-store-v1.js';
import { assertPitFeatureTimes, inspectPitSnapshotTimes } from '../lib/pit-feature-time-evidence.js';
import { exportHistorySnapshot } from '../lib/pit-history-export.js';
import { auditSavedPitModel } from '../lib/saved-pit-model-audit.js';
import { auditSavedAsianPit } from '../lib/saved-asian-pit-audit.js';

const received = '2099-08-25T07:59:00.000Z';
const cutoff = '2099-08-25T08:00:00.000Z';
const analyzed = '2099-08-25T08:01:00.000Z';
const future = '2099-08-25T08:00:30.000Z';
const hash = value => value.repeat(64);
const versions = { modelVersion: 'fixture-model', rulesVersion: 'fixture-rules', dataVersion: 'fixture-data',
  scoreFormulaVersion: 'fixture-score', settlementRuleVersion: 'fixture-settlement', uncertaintySetVersion: 'fixture-uncertainty' };
const game = { leagueId: 'MLB', gamePk: 991122, gameDate: '2099-08-25T10:00:00.000Z',
  gameNumber: 1, awayTeamId: 101, homeTeamId: 102 };
const context = { leagueId: 'MLB', game, fetchedAt: cutoff, featureSnapshotAsOf: '2099-08-25T08:00:05.000Z',
  featureProvenance: [{ featureName: 'fixtureObservedInput', fetchedAt: received,
    dependencyReceipts: [{ fetchedAt: received }], asOf: '2099-08-26' }] };
const analysis = { leagueId: 'MLB', analysisType: 'FULL', inputHash: hash('a'), coreFingerprint: hash('b'),
  priceFingerprint: hash('c'), calculationFingerprint: hash('d'), auxiliaryFingerprint: hash('e'),
  distributionId: 'fixture-distribution', distributionHash: hash('f'), dataAsOf: cutoff, analysisAsOf: analyzed, lineAsOf: cutoff,
  results: [] };
const distributionSnapshot = { distributionId: analysis.distributionId, distributionHash: analysis.distributionHash,
  gamePk: game.gamePk, scenarios: [{ id: 'fixture', weight: 1, cells: [{ awayRuns: 1, homeRuns: 1, probability: 1 }] }] };
const input = { league: 'MLB', game, frozenContext: context, analysis, versions, distributionSnapshot };
const record = buildAnalysisPitSnapshotRecord(input);
const integrityError = error => error?.code === 'PIT_FEATURE_TIME_INVALID'
  && error.status === 409 && isAnalysisPitIntegrityError(error) && error.featureTimeErrors.length > 0;

assert.equal(assertAnalysisPitFeatureTimeEvidence(record).ok, true);
assert.equal(assertPitFeatureTimes(context, cutoff).ok, true);
for (const invalidCutoff of [undefined, null, '', '2099-08-25', 'bad']) {
  assert.throws(() => assertPitFeatureTimes(context, invalidCutoff),
    error => error.code === 'PIT_FEATURE_TIME_INVALID' && error.status === 422
      && error.featureTimeErrors.includes('FEATURE_CUTOFF_INVALID'));
}
assert.throws(() => assertPitFeatureTimes({ ...context, featureProvenance: [{ featureName: 'fixture', fetchedAt: future }] }, cutoff),
  error => error.code === 'PIT_FEATURE_TIME_INVALID' && error.status === 422);
assert.equal(inspectPitSnapshotTimes(null, cutoff, analyzed).ok, false);
assert.equal(inspectPitSnapshotTimes(context, cutoff, analyzed).ok, true,
  'feature assembly after receipt cutoff remains valid when it precedes analysis');
assert.equal(inspectPitSnapshotTimes(context, null, analyzed).ok, false);

for (const featureProvenance of [
  [],
  [{ featureName: 'fixture' }],
  [{ featureName: 'fixture', fetchedAt: future }],
  [{ featureName: 'fixture', fetchedAt: received, observedAt: future }],
  [{ featureName: 'fixture', fetchedAt: received, dependencyReceipts: [{ fetchedAt: future }] }],
  [{ featureName: 'fixture', fetchedAt: received, sourceReceipts: [{ fetchedAt: 'bad' }] }],
]) {
  const invalidInput = { ...input, frozenContext: { ...context, featureProvenance } };
  assert.throws(() => buildAnalysisPitSnapshotRecord(invalidInput), integrityError,
    'invalid frozen receipt evidence must fail at capture, not a later consumer');
  await assert.rejects(buildAnalysisPitSnapshotRecordAsync(invalidInput), integrityError,
    'async capture must reject before source evidence externalization');
}
for (const changed of [
  { fetchedAt: future },
  { fetchedAt: '2099-08-25' },
  { featureSnapshotAsOf: '2099-08-25T08:02:00.000Z' },
]) assert.throws(() => buildAnalysisPitSnapshotRecord({ ...input, frozenContext: { ...context, ...changed } }), integrityError);

for (const leagueId of ['MLB', 'NPB', 'KBO', 'CPBL']) {
  const leagueGame = { ...game, leagueId };
  const leagueContext = { ...context, leagueId, game: leagueGame,
    sourceEvidence: { events: [{ id: 'bound', fetchedAt: received }] },
    featureProvenance: [{ featureName: 'fixture', fetchedAt: received, sourceEventIds: ['bound'] }] };
  const valid = buildAnalysisPitSnapshotRecord({ ...input, league: leagueId, game: leagueGame,
    frozenContext: leagueContext, analysis: { ...analysis, leagueId } });
  assert.equal(assertAnalysisPitFeatureTimeEvidence(valid).ok, true);
  assert.throws(() => buildAnalysisPitSnapshotRecord({ ...input, league: leagueId, game: leagueGame,
    frozenContext: { ...leagueContext, sourceEvidence: { events: [{ id: 'bound', fetchedAt: future }] } },
    analysis: { ...analysis, leagueId } }), integrityError);
}

// Top-level cutoff metadata was historically absent from replayIdentityHash.
// Reproduce a hash-valid existing row with a stale cutoff without rewriting its
// frozen payload or receipt times. Neither exact-hash nor semantic retry may
// rescue this row now that normal read/reuse verifies the time invariant.
const invalidExisting = { ...record, dataAsOf: '2099-08-25T07:58:00.000Z' };
assert.equal(replayIdentityHash(invalidExisting), record.replayIdentityHash,
  'retain legacy hash compatibility while independently enforcing temporal integrity');
assert.throws(() => validateAnalysisPitSnapshotRecord(invalidExisting), integrityError);
assert.throws(() => buildAnalysisPitReplayBundle(invalidExisting), integrityError);
assert.throws(() => validateAnalysisPitSnapshotRecord(invalidExisting, { allowInvalidFeatureTimesForAudit: true }), integrityError,
  'audit option cannot bypass a normal current capture');
await assert.rejects(persistAnalysisPitSnapshot(invalidExisting), integrityError,
  'invalid existing rows cannot be persisted or reused even without database configuration');

const asRow = value => ({ snapshot_id: value.snapshotId, schema_version: value.schemaVersion, league_id: value.leagueId,
  game_identity: value.gameIdentity, game_start: value.gameStart, data_as_of: value.dataAsOf, analysis_as_of: value.analysisAsOf,
  line_as_of: value.lineAsOf, provider_timestamps: value.providerTimestamps, analysis_type: value.analysisType,
  input_hash: value.inputHash, core_fingerprint: value.coreFingerprint, price_fingerprint: value.priceFingerprint,
  calculation_fingerprint: value.calculationFingerprint, auxiliary_fingerprint: value.auxiliaryFingerprint,
  distribution_id: value.distributionId, distribution_hash: value.distributionHash, distribution_storage: value.distributionStorage,
  distribution_payload: value.distributionPayload, frozen_context_payload: value.frozenContextPayload,
  market_analysis_payload: value.marketAnalysisPayload, feature_contract: value.featureContract, scenario_contract: value.scenarioContract,
  calibration_contract: value.calibrationContract, rule_contract: value.ruleContract, quarantine_contract: value.quarantineContract,
  evidence_status: value.evidenceStatus, quarantine_status: value.quarantineStatus, calibration_eligibility: value.calibrationEligibility,
  versions: value.versions, replay_identity_hash: value.replayIdentityHash });
assert.throws(() => analysisPitRecordFromDatabaseRow(asRow(invalidExisting)), integrityError);
assert.equal(analysisPitRecordFromDatabaseRow(asRow(record)).snapshotId, record.snapshotId);
assert.equal(analysisPitRecordFromDatabaseRowForAudit(asRow(invalidExisting)).dataAsOf, invalidExisting.dataAsOf);
assert.equal(validateAnalysisPitSnapshotForAudit(invalidExisting).featureTimeAudit.ok, false);
const forensicReplay = buildAnalysisPitReplayBundleForAudit(invalidExisting);
assert.equal(forensicReplay.featureTimeAudit.ok, false);
assert.equal(forensicReplay.featureTimeAuditOnly, true);
assert.equal(forensicReplay.calibrationEligibility, 'EXCLUDED_FORENSIC_AUDIT');
assert.equal(forensicReplay.originalCalibrationEligibility, invalidExisting.calibrationEligibility);
assert.equal(forensicReplay.productionReuseAllowed, false);
assert.equal(forensicReplay.persistenceAllowed, false);
assert.deepEqual(forensicReplay.frozenContext, context);
assert.throws(() => validateAnalysisPitSnapshotRecord(invalidExisting), integrityError,
  'forensic read must not grant ordinary reuse eligibility');
const forensicAudit = auditSavedPitModel(forensicReplay);
assert.equal(forensicAudit.featureTimeAudit.ok, false);
assert.equal(forensicAudit.verificationLayers.featureTimes, 'FAIL');
assert.equal(forensicAudit.calibrationEligibility, 'EXCLUDED_FORENSIC_AUDIT');
assert.equal(forensicAudit.productionReuseAllowed, false);
assert.equal(forensicAudit.persistenceAllowed, false);
assert.equal(forensicAudit.predictiveAccuracyValidated, false);
const asianAudit = auditSavedAsianPit(forensicReplay);
assert.equal(asianAudit.featureTimeAudit.ok, false);
assert.equal(asianAudit.calibrationEligibility, 'EXCLUDED_FORENSIC_AUDIT');
assert.equal(asianAudit.productionReuseAllowed, false);

const originalInvalidExisting = JSON.stringify(invalidExisting);
const exported = await exportHistorySnapshot({ snapshotId: invalidExisting.snapshotId, league: 'MLB', gamePk: game.gamePk }, {
  readSnapshotRows: async (id, league) => {
    assert.equal(id, invalidExisting.snapshotId); assert.equal(league, 'MLB'); return [asRow(invalidExisting)];
  },
  hydrateContext: async value => value,
});
assert.equal(exported.integrityVerified, true);
assert.equal(exported.featureTimeAudit.ok, false);
assert.equal(exported.calibrationEligibility, 'EXCLUDED_FORENSIC_AUDIT');
assert.equal(exported.productionWrites, false);
assert.equal(exported.persistenceAllowed, false);
assert.deepEqual(exported.record.frozenContextPayload, invalidExisting.frozenContextPayload);
assert.equal(exported.record.replayIdentityHash, invalidExisting.replayIdentityHash);
assert.equal(exported.record.dataAsOf, invalidExisting.dataAsOf);
assert.equal(JSON.stringify(invalidExisting), originalInvalidExisting);
await assert.rejects(exportHistorySnapshot({ snapshotId: invalidExisting.snapshotId, league: 'MLB', gamePk: game.gamePk }, {
  readSnapshotRows: async () => [{ ...asRow(invalidExisting), frozen_context_payload: { ...invalidExisting.frozenContextPayload, payloadHash: hash('0') } }],
  hydrateContext: async value => value,
}), 'forensic export must still reject payload tampering');

const legacy = buildAnalysisPitSnapshotRecord({ ...input, frozenContext: { ...context, legacyContextUsed: true } });
const quarantinedInvalid = { ...legacy, dataAsOf: invalidExisting.dataAsOf };
const unchanged = JSON.stringify(quarantinedInvalid);
assert.throws(() => validateAnalysisPitSnapshotRecord(quarantinedInvalid), integrityError);
const readOnlyOptions = { allowInvalidFeatureTimesForAudit: true };
assert.equal(validateAnalysisPitSnapshotRecord(quarantinedInvalid, readOnlyOptions), quarantinedInvalid);
assert.equal(analysisPitRecordFromDatabaseRow(asRow(quarantinedInvalid), readOnlyOptions).dataAsOf, invalidExisting.dataAsOf);
const auditReplay = buildAnalysisPitReplayBundle(quarantinedInvalid, readOnlyOptions);
assert.equal(auditReplay.featureTimeAuditOnly, true);
assert.equal(auditReplay.featureTimeAudit.ok, false);
assert.equal(auditReplay.calibrationEligibility, 'EXCLUDED_UNVERIFIABLE_LEGACY');
assert.equal(JSON.stringify(quarantinedInvalid), unchanged, 'read-only audit never repairs or backdates immutable evidence');
await assert.rejects(persistAnalysisPitSnapshot(quarantinedInvalid), integrityError,
  'read-only audit allowance never grants persistence eligibility');

const originalEnv = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_V2_URL: process.env.DATABASE_V2_URL,
  VERCEL_ENV: process.env.VERCEL_ENV, VERCEL: process.env.VERCEL };
const originalFetch = globalThis.fetch;
try {
  delete process.env.DATABASE_URL; delete process.env.DATABASE_V2_URL;
  delete process.env.VERCEL_ENV; delete process.env.VERCEL;
  globalThis.fetch = async () => assert.fail('invalid capture must not trigger source-store or database I/O');
  for (const configured of [false, true]) {
    if (configured) process.env.DATABASE_URL = 'postgresql://fixture:fixture@invalid.example/fixture';
    const receipt = await persistAnalysisPitSnapshotForResponse({ ...input,
      frozenContext: { ...context, featureProvenance: [{ featureName: 'fixture', fetchedAt: future }] } });
    assert.equal(receipt.reason, 'PIT_FEATURE_TIME_INVALID');
    assert.equal(receipt.status, 'FAILED');
    assert.equal(receipt.confirmed, false);
    assert.equal(receipt.required, true, 'integrity protection is required independently of database availability');
    assert.equal(receipt.dataIntegrity, 'FAILED');
    assert.ok(receipt.featureTimeErrors.includes('FEATURE_FROM_FUTURE:fixture'));
  }
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key]; else process.env[key] = value;
  }
}
console.log('PIT snapshot time integrity: pre-write validation, invalid immutable reuse rejection and quarantined read-only audit PASS');
