import assert from 'node:assert/strict';
import { captureAsianSource, auditAsianSourceEvidence } from '../lib/asian-source-evidence-v1.js';
import { featureObservedAtsFromContextV109 } from '../lib/calibration-ledger-v109.js';
const cutoff = '2026-09-08T08:00:00.000Z';
const first = captureAsianSource({ url: 'https://example.invalid/fixture', method: 'GET', raw: '{"runs":3}', representation: 'HTTP_RESPONSE_TEXT', fetchedAt: '2026-09-08T07:00:00.000Z', httpStatus: 200 });
const second = captureAsianSource({ url: first.event.url, method: 'GET', raw: '{"runs":3}', representation: 'HTTP_RESPONSE_TEXT', fetchedAt: '2026-09-08T09:00:00.000Z', httpStatus: 200 });
assert.equal(first.content.contentHash, second.content.contentHash);
assert.notEqual(first.event.id, second.event.id);
const context = { leagueId: 'NPB', inputCutoffAt: cutoff, sourceEvidence: { events: [first.event, second.event], contents: { [first.content.contentHash]: first.content }, features: [{ feature: 'history', complete: true, sourceEventIds: [first.event.id] }] } };
const before = JSON.stringify(context);
const history = value => auditAsianSourceEvidence(value).rows.find(row => row.featureName === 'history');
assert.equal(history(context).status, 'VERIFIED', 'unbound audit re-fetch is not an input');
assert.equal(auditAsianSourceEvidence(context).status, 'PENDING', 'missing necessary fields cannot pass');
assert.equal(JSON.stringify(context), before);
const late = structuredClone(context); late.sourceEvidence.features[0].sourceEventIds = [second.event.id];
assert.equal(history(late).status, 'FAILED');
const lateMissing = structuredClone(late); lateMissing.sourceEvidence.contents = {};
assert.equal(history(lateMissing).status, 'FAILED', 'missing content must not hide a known late bound acquisition');
const dependent = structuredClone(context);
dependent.sourceEvidence.features.push(
  { featureName: 'gameIdentity', complete: true, derivationVersion: 'test', requiredFeatures: ['rules'] },
  { featureName: 'rules', complete: true, sourceEventIds: [second.event.id] },
);
assert.equal(auditAsianSourceEvidence(dependent).rows.find(row => row.featureName === 'gameIdentity').status, 'FAILED', 'late transitive dependencies propagate independent of row order');
dependent.sourceEvidence.features[2] = { featureName: 'rules', complete: true, derivationVersion: 'test', requiredFeatures: ['gameIdentity'] };
assert.equal(auditAsianSourceEvidence(dependent).rows.find(row => row.featureName === 'gameIdentity').status, 'PENDING', 'cyclic dependencies cannot verify themselves');
const missing = structuredClone(context); missing.sourceEvidence.contents = {};
assert.equal(history(missing).status, 'PENDING');
const broken = structuredClone(context); broken.sourceEvidence.contents[first.content.contentHash].data = 'broken';
assert.equal(history(broken).status, 'FAILED');
assert.equal(auditAsianSourceEvidence({}).status, 'PENDING');
assert.deepEqual(featureObservedAtsFromContextV109({ leagueId: 'NPB', fetchedAt: cutoff, featureProvenance: [{ feature: 'lineup', asOf: cutoff }] }), {}, 'no fabricated individual timestamps');
assert.deepEqual(featureObservedAtsFromContextV109({ leagueId: 'NPB', featureProvenance: [{ feature: 'lineup', fetchedAt: cutoff }] }), { lineup: cutoff });
assert.equal(auditAsianSourceEvidence({ ...context, game: { gameDate: '2026-09-08T06:00:00Z' } }).pregameCutoffStatus, 'FAILED');
console.log('Asian source evidence: acquisition identity, content deduplication, cutoff, pending, corruption, legacy alias and immutability checks passed');
