import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAnalysisDataAudit } from '../lib/analysis-data-audit-v1.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/personnel-receipt-audit.json', import.meta.url), 'utf8'));
const cpbl = fixture.cases.find(row => row.id.startsWith('cpbl_'));
const kbo = fixture.cases.find(row => row.id.startsWith('kbo_'));
const mlb = fixture.cases.find(row => row.id.startsWith('mlb_'));
const rowFor = (audit, key) => audit.rows.find(row => row.key === key);
const receipt = item => buildAnalysisDataAudit(item.context, item.profile);
const before = JSON.stringify(fixture);
const cpblAudit = receipt(cpbl), kboAudit = receipt(kbo);
const cpblBullpen = rowFor(cpblAudit, 'away.bullpen');
const cpblStarter = rowFor(cpblAudit, 'away.starter');
const kboBullpen = rowFor(kboAudit, 'away.bullpen');
assert.equal(cpblAudit.schemaVersion, 'analysis-data-audit-v3');
assert.equal(cpblAudit.rows.length, 10, 'new disclosures retain the existing ten-row core contract');
assert.ok(cpbl.sourceSnapshotId.startsWith('CPBL:') && /^[a-f0-9]{64}$/.test(cpbl.contextPayloadHash));
assert.equal(cpbl.context.away.starter.confirmed, true, 'real legacy assignment conflict remains in the fixture');
assert.equal(cpblStarter.status, 'projected');
assert.equal(cpblStarter.assignmentEvidence.status, 'PROJECTED', 'a saved projected assignment outranks the old confirmed flag');
assert.equal(cpblStarter.assignmentEvidence.identityConfirmed, true, 'preserve the old flag as evidence rather than rewriting history');
assert.equal(cpblStarter.measurementEvidence.status, 'observed', 'actual individual pitching data is not discarded by a projected assignment');
assert.equal(cpblStarter.metrics.woba, cpbl.context.away.starter.season.woba);
assert.deepEqual(cpblBullpen.identity.playerNames, cpbl.context.away.bullpen.players.map(player => player.name));
assert.ok(cpblBullpen.players.length > 0, 'real Asian .players must not vanish through the MLB .relievers path');
for (const [index, player] of cpbl.context.away.bullpen.players.entries()) {
  assert.equal(cpblBullpen.players[index].metricScope, player.metricScope);
  assert.deepEqual(cpblBullpen.players[index].usageGames, player.usageGames);
  assert.equal(cpblBullpen.players[index].usageComplete, player.usageComplete);
}
assert.equal(cpblBullpen.coverage.rosterComplete, null, 'unknown roster completeness is not a reported false');
assert.equal(cpblBullpen.coverage.rosterScope, 'HISTORICAL_RELIEF_SAMPLE_NOT_CURRENT_ROSTER');
assert.notEqual(cpblBullpen.assignmentEvidence.status, 'OFFICIAL_REPORTED');
assert.equal(kboBullpen.players.length, 0, 'named historical appearances are not an active reliever roster');
assert.equal(kboBullpen.identity.playerNames.length, 0);
assert.equal(kboBullpen.assignmentEvidence.status, 'MISSING');
assert.ok(kboBullpen.historicalUsage.playerNames.length > 0);
assert.equal(kboBullpen.historicalUsage.scope, 'HISTORICAL_RELIEF_APPEARANCES_ONLY');
assert.deepEqual(kboBullpen.historicalUsage.appearances, kbo.context.away.bullpen.usageAppearances);
assert.equal(kboBullpen.measurementEvidence.status, 'observed', 'historical innings remain measurements even when today’s roster is absent');

for (const [item, audit] of [[cpbl, cpblAudit], [kbo, kboAudit]]) {
  const declarations = [...audit.rows.flatMap(row => row.usage), ...audit.otherUsage];
  assert.deepEqual(declarations.map(row => row.key).sort(), item.profile.dataUsage.map(row => row.key).sort());
  for (const saved of item.profile.dataUsage) {
    const actual = declarations.find(row => row.key === saved.key);
    assert.equal(actual.usedInMean, saved.usedInMean);
    assert.equal(actual.usedInUncertainty, saved.usedInUncertainty);
  }
  const withoutUsage = buildAnalysisDataAudit(item.context);
  assert.ok(withoutUsage.rows.every(row => row.usedInMean === null && row.usedInUncertainty === null));
  assert.ok(withoutUsage.rows.every(row => row.sourceLineage.modelUsage === 'NOT_REPORTED'));
}
assert.deepEqual(receipt(cpbl), cpblAudit, 'no live time or random value may alter a saved receipt');
assert.equal(JSON.stringify(fixture), before, 'real contexts, evidence and saved usage are not mutated');

const emptyMlb = buildAnalysisDataAudit({ away: { bullpen: {
  relievers: [], players: [{ id: 4, name: 'Historical only' }], pitcherIds: [4],
} } });
assert.deepEqual(rowFor(emptyMlb, 'away.bullpen').players, [], 'explicit MLB empty roster takes precedence over historical players');
assert.deepEqual(rowFor(emptyMlb, 'away.bullpen').identity.playerNames, []);
assert.deepEqual(rowFor(emptyMlb, 'away.bullpen').identity.playerIds, [], 'explicit empty current roster must not import stale pitcher IDs');
const idsOnly = rowFor(buildAnalysisDataAudit({ away: { bullpen: { pitcherIds: ['4'] } } }), 'away.bullpen');
assert.deepEqual(idsOnly.identity.playerIds, ['4'], 'Asian IDs remain available without manufactured names');
assert.deepEqual(idsOnly.identity.playerNames, []);
for (const players of [[null], [{}]]) {
  assert.equal(rowFor(buildAnalysisDataAudit({ away: { lineup: { official: true, players } } }), 'away.lineup').assignmentEvidence.status, 'MISSING');
}

const flagsOnly = buildAnalysisDataAudit({ away: { starter: { id: 1, name: 'Known player', confirmed: true, identityConfirmed: true } } });
assert.equal(rowFor(flagsOnly, 'away.starter').assignmentEvidence.status, 'UNVERIFIED', 'legacy identity flags alone never prove assignment');
const officialWithoutMetrics = buildAnalysisDataAudit({ away: { lineup: {
  official: true, status: 'MISSING', identityStatus: 'CONFIRMED', metricsStatus: 'MISSING', metricCoverage: 0,
  players: [{ id: 1, name: 'Official batter', battingOrder: 9 }, { id: 2, name: 'No saved slot' }],
} } });
assert.equal(rowFor(officialWithoutMetrics, 'away.lineup').assignmentEvidence.status, 'OFFICIAL_REPORTED');
assert.equal(rowFor(officialWithoutMetrics, 'away.lineup').measurementEvidence.status, 'missing');
assert.deepEqual(rowFor(officialWithoutMetrics, 'away.lineup').modelBattingInputs.map(row => row.battingOrder), [9, null]);
const contradictoryLineup = buildAnalysisDataAudit({ away: { lineup: { official: true, rosterConfirmedToday: false, players: [{ id: 1 }] } } });
assert.equal(rowFor(contradictoryLineup, 'away.lineup').assignmentEvidence.status, 'UNVERIFIED', 'explicit unconfirmed today cannot become official assignment');
const newProjected = structuredClone(cpbl.context);
Object.assign(newProjected.away.starter, { projected: true, confirmed: false, identityConfirmed: false, playerIdentityVerified: true, assignmentStatus: 'ROSTER_VALIDATED_REPORTED_STARTER' });
assert.equal(rowFor(buildAnalysisDataAudit(newProjected), 'away.starter').assignmentEvidence.status, 'PROJECTED', 'PR263 identity contract remains compatible');

for (const umpire of [undefined, {}, { id: null, name: '', status: 'MISSING' }]) {
  const audit = buildAnalysisDataAudit({ weather: { available: true, status: 'CONFIRMED', temperature: 25 }, umpire });
  assert.equal(audit.supportingData.find(row => row.key === 'weather').status, 'CONFIRMED');
  const actual = audit.supportingData.find(row => row.key === 'umpire');
  assert.equal(actual.status, 'missing', 'weather success cannot conceal missing umpire identity');
  assert.equal(actual.identityStatus, 'MISSING');
  assert.equal(actual.meanEffectStatus, 'NOT_REPORTED');
}
const namedUmpire = buildAnalysisDataAudit({ umpire: { name: 'Saved umpire' } }, { dataUsage: [{ key: 'umpire.runFactor', usedInMean: false, usedInUncertainty: false }] })
  .supportingData.find(row => row.key === 'umpire');
assert.equal(namedUmpire.status, 'observed');
assert.equal(namedUmpire.identityStatus, 'REPORTED');
assert.equal(namedUmpire.meanEffectStatus, 'SAVED_USAGE_REPORTED');
assert.equal(namedUmpire.usage[0].usedInMean, false);
assert.equal(namedUmpire.meanEffectValidation, 'NOT_VERIFIED_BY_THIS_RECEIPT');
const projectedUmpire = buildAnalysisDataAudit({ umpire: { name: 'Projected name', status: 'PROJECTED', projected: true } })
  .supportingData.find(row => row.key === 'umpire');
assert.equal(projectedUmpire.status, 'projected');
assert.equal(projectedUmpire.identityStatus, 'PROJECTED');

const lineage = cpblStarter.sourceLineage;
assert.equal(lineage.references.status, 'REFERENCES_PRESENT');
assert.equal(lineage.parsedInputComparison.status, 'SHARED_FIELDS_MATCH');
assert.ok(lineage.parsedInputComparison.comparedFields.length > 0);
assert.equal(lineage.rawSourceNormalization, 'NOT_INDEPENDENTLY_VERIFIED');
assert.equal(lineage.references.hashValidation, 'RECORDED_HASH_FORMAT_ONLY_NOT_REHASHED');
assert.equal(lineage.pregameAvailability, 'NOT_VERIFIED_BY_THIS_RECEIPT');
assert.equal(lineage.modelExecution, 'NOT_REEXECUTED');
assert.equal(lineage.modelUsage, 'SAVED_DECLARATIONS_ONLY');
const dangling = structuredClone(cpbl.context);
const feature = dangling.sourceEvidence.features.find(row => row.featureName === 'away.starter');
const missingId = feature.sourceEventIds[0];
dangling.sourceEvidence.events = dangling.sourceEvidence.events.filter(row => row.id !== missingId);
const danglingLineage = rowFor(buildAnalysisDataAudit(dangling), 'away.starter').sourceLineage;
assert.equal(danglingLineage.references.status, 'INCOMPLETE');
assert.ok(danglingLineage.references.missingEventIds.includes(missingId));
const invalidHash = structuredClone(cpbl.context);
invalidHash.sourceEvidence.events.find(row => row.id === missingId).contentHash = 'not-a-hash';
assert.equal(rowFor(buildAnalysisDataAudit(invalidHash), 'away.starter').sourceLineage.references.status, 'INCOMPLETE');
const mismatch = structuredClone(cpbl.context);
const input = mismatch.sourceEvidence.features.find(row => row.featureName === 'away.starter').parsedInput;
input.id = 'wrong-player'; input.officialPlayerId = 'wrong-player'; input.teamId = -999; input.qualityFactor = 999;
input.season.woba += 0.1;
const conflict = rowFor(buildAnalysisDataAudit(mismatch), 'away.starter').sourceLineage.parsedInputComparison;
assert.equal(conflict.status, 'CONFLICT');
for (const field of ['.playerId', '.teamId', '.qualityFactor', '.season.woba']) assert.ok(conflict.mismatches.some(path => path.endsWith(field)));
const lineupMismatch = structuredClone(cpbl.context);
const lineupInput = lineupMismatch.sourceEvidence.features.find(row => row.featureName === 'away.lineup').parsedInput;
[lineupInput.players[0], lineupInput.players[1]] = [lineupInput.players[1], lineupInput.players[0]];
assert.equal(rowFor(buildAnalysisDataAudit(lineupMismatch), 'away.lineup').sourceLineage.parsedInputComparison.status, 'CONFLICT');
const slotMismatch = structuredClone(cpbl.context);
slotMismatch.sourceEvidence.features.find(row => row.featureName === 'away.lineup').parsedInput.players[0].order = 999;
assert.ok(rowFor(buildAnalysisDataAudit(slotMismatch), 'away.lineup').sourceLineage.parsedInputComparison.mismatches.some(path => path.endsWith('.battingOrder')));
const mlbAudit = receipt(mlb);
const baselineStarter = mlb.context.featureProvenance.find(row => row.featureName === 'awayStarter');
assert.notEqual(baselineStarter.value.era, mlb.context.away.starter.era, 'real MLB mixed-role source precedes starts-only transformation');
assert.equal(rowFor(mlbAudit, 'away.starter').sourceLineage.parsedInputComparison.status, 'SHARED_FIELDS_MATCH', 'expected transformation is not a source conflict');
assert.ok(rowFor(mlbAudit, 'away.starter').sourceLineage.parsedInputComparison.comparedFields.some(path => path.includes('starterExpectedInnings') && path.endsWith('expectedInnings')));
assert.equal(rowFor(mlbAudit, 'away.starter').sourceLineage.modelUsage, 'NOT_REPORTED');
assert.equal(rowFor(mlbAudit, 'away.bullpen').sourceLineage.parsedInputComparison.status, 'SHARED_FIELDS_MATCH');
const mlbMismatch = structuredClone(mlb.context);
mlbMismatch.featureProvenance.find(row => row.featureName === 'reliefOnlyBullpen').value.away.qualityFactor = 999;
const mlbConflict = rowFor(buildAnalysisDataAudit(mlbMismatch), 'away.bullpen').sourceLineage.parsedInputComparison;
assert.equal(mlbConflict.status, 'CONFLICT');
assert.ok(mlbConflict.mismatches.some(path => path.endsWith('.qualityFactor')), 'aggregate provenance must compare the matching side');
const absent = buildAnalysisDataAudit({ sourceTimeAudit: { status: 'VERIFIED' } });
assert.equal(rowFor(absent, 'away.starter').sourceLineage.parsedInputComparison.status, 'NOT_COMPARABLE', 'a timing claim cannot prove raw normalization or shared missing values');
assert.equal(rowFor(absent, 'away.starter').sourceLineage.rawSourceNormalization, 'NOT_INDEPENDENTLY_VERIFIED');

// The provider reports the primary pitcher's values before the documented
// candidate normalization. Check the complete saved transition, not equality
// between two different stages and not just a trusted metadata flag.
const transformedFixture = JSON.parse(readFileSync(new URL('./fixtures/personnel-candidate-transform.json', import.meta.url), 'utf8'));
const transformedContext = transformedFixture.context;
const transformationFor = context => rowFor(buildAnalysisDataAudit(context), 'away.starter').sourceLineage.parsedInputComparison;
const transformedBefore = JSON.stringify(transformedContext);
assert.equal(transformationFor(transformedContext).status, 'TRANSFORMED_FIELDS_MATCH');
assert.ok(transformationFor(transformedContext).comparedFields.some(path => path.endsWith('.candidateNormalization.sourcePrimary.qualityFactor')));
assert.ok(transformationFor(transformedContext).comparedFields.some(path => path.endsWith('.candidateNormalization.output.expectedInnings')));
assert.equal(JSON.stringify(transformedContext), transformedBefore);
const reorderedMetadata = structuredClone(transformedContext);
reorderedMetadata.away.starter.candidateNormalization.bounds = { expectedInnings: [2.5, 7.2], qualityFactor: [0.82, 1.22] };
assert.equal(transformationFor(reorderedMetadata).status, 'TRANSFORMED_FIELDS_MATCH', 'JSON object ordering is not integrity');
for (const [label, mutate] of [
  ['missing metadata', c => { delete c.away.starter.candidateNormalization; }],
  ['unknown contract', c => { c.away.starter.candidateNormalization.version = 'unknown'; }],
  ['forged source', c => { c.away.starter.candidateNormalization.sourcePrimary.qualityFactor += .1; }],
  ['forged weighted mean', c => { c.away.starter.candidateNormalization.weightedCandidateValues.expectedInnings += 1; }],
  ['forged output', c => { c.away.starter.candidateNormalization.output.expectedInnings += 1; }],
  ['context output changed', c => { c.away.starter.qualityFactor += .1; }],
  ['changed bounds', c => { c.away.starter.candidateNormalization.bounds.qualityFactor = [.5, 2]; }],
  ['candidate identity changed', c => { c.away.starter.candidates[0].id = 'wrong'; }],
  ['candidate weight changed', c => { c.away.starter.candidates[0].probability = .9; }],
  ['candidate ability missing', c => { c.away.starter.candidates[0].qualityFactor = null; }],
  ['candidate ability forged', c => { c.away.starter.candidates[0].qualityFactor = 1.7; }],
  ['source ability changed', c => { c.sourceEvidence.features[0].parsedInput.candidates[0].era += 1; }],
  ['unrelated source player changed', c => { c.sourceEvidence.features[0].parsedInput.id = 'wrong'; c.sourceEvidence.features[0].parsedInput.officialPlayerId = 'wrong'; }],
]) {
  const changed = structuredClone(transformedContext); mutate(changed);
  assert.equal(transformationFor(changed).status, 'CONFLICT', label);
}
const bounded = structuredClone(transformedContext);
for (const [index, candidate] of bounded.sourceEvidence.features[0].parsedInput.candidates.entries()) {
  Object.assign(candidate, { probability: index === 0 ? 1 : 3, qualityFactor: .4, expectedInnings: 1 });
  Object.assign(bounded.away.starter.candidates[index], { probability: index === 0 ? .25 : .75, qualityFactor: .4, qualityFactorMethod: 'SUPPLIED_INDIVIDUAL_QUALITY', expectedInnings: 1 });
}
Object.assign(bounded.away.starter, { qualityFactor: .82, expectedInnings: 2.5 });
Object.assign(bounded.away.starter.candidateNormalization, { weightedCandidateValues: { qualityFactor: .4, expectedInnings: 1 }, output: { qualityFactor: .82, expectedInnings: 2.5 } });
assert.equal(transformationFor(bounded).status, 'TRANSFORMED_FIELDS_MATCH', 'declared fixed bounds and non-unit source weight sum are validated');
console.log('personnel-receipt-v3: real CPBL/KBO, preserved usage, independent assignment/measurements/umpire, scoped lineage PASS');
