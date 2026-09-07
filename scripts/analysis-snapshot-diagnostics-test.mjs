import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAnalysisPitSnapshotRecord } from '../lib/analysis-pit-snapshot-store-v1.js';
import { parseSnapshotDiagnosticQuery, readSnapshotDiagnostics } from '../lib/analysis-snapshot-diagnostics-v1.js';

let cases = 0;
const check = async (name, fn) => { await fn(); cases++; };
const hash = char => char.repeat(64);
const game = { leagueId: 'MLB', league: 'MLB', gamePk: 123, officialDate: '2026-09-06', gameDate: '2026-09-06T10:00:00Z', gameNumber: 1, awayTeamId: 1, homeTeamId: 2, away: 'Away', home: 'Home' };
const context = { leagueId: 'MLB', game, fetchedAt: '2026-09-06T07:00:00Z', away: {}, home: {}, featureProvenance: [] };
const versions = { modelVersion: 'M1', rulesVersion: 'R1', dataVersion: 'D1', scoreFormulaVersion: 'S1', settlementRuleVersion: 'SET1', uncertaintySetVersion: 'U1' };
const distribution = { distributionId: 'dist1', distributionHash: hash('a'), gamePk: 123, scenarios: [{ id: 'central', weight: 1, cells: [{ awayRuns: 4, homeRuns: 4, probability: 1 }] }] };
const analysis = { leagueId: 'MLB', analysisType: 'FULL', inputHash: hash('b'), coreFingerprint: hash('c'), priceFingerprint: hash('d'), calculationFingerprint: hash('e'), auxiliaryFingerprint: hash('f'), distributionId: 'dist1', distributionHash: hash('a'),
  dataAsOf: context.fetchedAt, lineAsOf: context.fetchedAt, analysisAsOf: '2026-09-06T07:01:00Z', expectedRuns: { full: { away: 4, home: 4 } }, results: [] };
const make = (extra = {}) => buildAnalysisPitSnapshotRecord({ league: 'MLB', game, frozenContext: context, analysis, distributionSnapshot: distribution, versions, markets: [], ...extra });
const left = make(), right = make({ analysis: { ...analysis, inputHash: hash('1'), analysisAsOf: '2026-09-06T07:02:00Z', expectedRuns: { full: { away: 5, home: 4 } } }, versions: { ...versions, modelVersion: 'M2' } });
const parse = query => parseSnapshotDiagnosticQuery(new URLSearchParams(query));
const scope = { league: 'MLB', gamePk: '123' };
const query = parse({ ...scope, before: left.snapshotId, after: right.snapshotId });
const original = structuredClone([left, right]);
await check('query rejects missing, unknown, fractional, unsafe and mixed identity', () => {
  for (const bad of [{}, { gamePk: '123' }, { ...scope, league: '' }, { ...scope, league: 'NBA' }, { ...scope, league: '__proto__' }, { ...scope, gamePk: '' }, { ...scope, gamePk: '1.2' }, { ...scope, gamePk: '9e3' }, { ...scope, gamePk: '9007199254740992' }, { ...scope, before: left.snapshotId }, { ...scope, before: '', after: '' }, { ...scope, order: 'DROP TABLE' },
    { ...scope, before: left.snapshotId, after: right.snapshotId.replace('MLB:', 'NPB:') }, { ...scope, before: left.snapshotId, after: right.snapshotId.replace(':123:', ':124:') },
    { ...scope, before: left.snapshotId, after: right.snapshotId.replace(':FULL:', ':PRICE_ONLY_REPRICE:') }, { ...scope, before: left.snapshotId, after: left.snapshotId }]) assert.throws(() => parse(bad));
});
await check('metadata listing does not load payloads and retains the bounded-list marker', async () => {
  const report = await readSnapshotDiagnostics(parse(scope), { listSnapshots: async input => { assert.equal(input.gamePk, 123); return { snapshots: [{ snapshotId: left.snapshotId }], hasMore: true }; }, loadSnapshot: () => assert.fail('listing loaded payload') });
  assert.equal(report.status, 'SAVED_FULL_SNAPSHOT_METADATA'); assert.equal(report.hasMore, true); assert.equal(report.historicalValidationPassed, false);
});
await check('empty database evidence is not filled from current feeds', async () => {
  const report = await readSnapshotDiagnostics(parse(scope), { listSnapshots: async () => ({ snapshots: [], hasMore: false }) });
  assert.equal(report.status, 'NO_SAVED_FULL_SNAPSHOTS'); assert.equal(report.fetchedCurrentData, false);
});
await check('real encoded snapshots flow through comparison without modifying input', async () => {
  const calls = [];
  const report = await readSnapshotDiagnostics(query, { loadSnapshot: async input => { calls.push(input); return input.snapshotId === left.snapshotId ? left : right; }, listSnapshots: () => assert.fail('unexpected list') });
  assert.equal(calls.length, 2); assert.ok(calls.every(x => x.league === 'MLB' && x.gamePk === 123));
  assert.equal(report.status, 'SAME_SAVED_INPUTS_OUTPUT_COMPARISON'); assert.equal(report.comparison.changes[0].delta, 1);
  assert.equal(report.comparison.receipts.after.analysisAsOf, right.analysisAsOf); assert.equal(report.comparison.chronologicalOrder, true);
  assert.equal(report.historicalValidationPassed, false); assert.deepEqual([left, right], original);
});
await check('different bullpen context is explicitly not a controlled comparison', async () => {
  const changed = make({ frozenContext: { ...context, home: { bullpen: { qualityFactor: 1.2 } } }, analysis: { ...analysis, inputHash: hash('1') } });
  const report = await readSnapshotDiagnostics(query, { loadSnapshot: async ({ snapshotId }) => snapshotId === left.snapshotId ? left : changed });
  assert.equal(report.status, 'INPUTS_DIFFER_NOT_CONTROLLED_COMPARISON'); assert.deepEqual(report.comparison.changedContextSections, ['home']);
});
await check('different original market cannot be treated as matched input', async () => {
  const changed = make({ markets: [{ market: 'total', line: 9 }], analysis: { ...analysis, inputHash: hash('1') } });
  const report = await readSnapshotDiagnostics(query, { loadSnapshot: async ({ snapshotId }) => snapshotId === left.snapshotId ? left : changed });
  assert.equal(report.comparison.sameMarket, false); assert.equal(report.status, 'INPUTS_DIFFER_NOT_CONTROLLED_COMPARISON');
});
await check('missing and tampered payloads do not produce a comparison', async () => {
  const report = await readSnapshotDiagnostics(query, { loadSnapshot: async ({ snapshotId }) => snapshotId === left.snapshotId ? left : null });
  assert.equal(report.status, 'UNRECONSTRUCTABLE_MISSING_SNAPSHOT'); assert.deepEqual(report.missing, [right.snapshotId]);
  const tampered = structuredClone(right); tampered.frozenContextPayload.payloadHash = hash('0');
  const invalid = await readSnapshotDiagnostics(query, { loadSnapshot: async ({ snapshotId }) => snapshotId === left.snapshotId ? left : tampered });
  assert.equal(invalid.status, 'UNRECONSTRUCTABLE_MISSING_OR_INVALID_SNAPSHOT');
});
await check('database errors propagate instead of pretending records are missing', async () => {
  await assert.rejects(readSnapshotDiagnostics(query, { loadSnapshot: async () => { throw new Error('database offline'); } }), /database offline/);
});
await check('diagnostic store path has no schema or settlement writes and lists only bounded FULL rows', () => {
  const source = readFileSync(new URL('../lib/analysis-pit-snapshot-store-v1.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('export async function listAnalysisPitComparisonSnapshots'), source.indexOf('export async function persistAnalysisPitSnapshot('));
  assert.doesNotMatch(section, /ensureAnalysisPitSchema|INSERT INTO|UPDATE |DELETE FROM|CREATE TABLE|settleOpen/);
  assert.match(section, /external_game_id = \$\{gamePk\} AND analysis_type = 'FULL'/); assert.match(section, /LIMIT 21/); assert.match(section, /rows\.slice\(0, 20\)/);
  assert.match(section, /buildAnalysisPitReplayBundle\(record/);
});
console.log(JSON.stringify({ suite: 'analysis-snapshot-diagnostics', cases, ok: true }));
