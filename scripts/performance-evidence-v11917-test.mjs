import assert from 'node:assert/strict';
import { qualityReceiptFromAudit, qualityGroupForBet } from '../lib/performance-evidence-v1.js';
import { buildScorePerformanceReport, filterScorePerformanceDetails } from '../lib/score-performance.js';
import { buildServerVerifiedCloudBet } from '../lib/cloud-bet-store.js';
import { buildAnalysisPitSnapshotRecord, buildAnalysisPitReplayBundle } from '../lib/analysis-pit-snapshot-store-v1.js';
import { compareFrozenAnalyses } from '../lib/frozen-analysis-comparison-v1.js';

let cases = 0;
const check = (label, fn) => { fn(); cases++; };
const audit = status => ({ schemaVersion: 'analysis-data-audit-v1', coverageScope: 'CORE_PERSONNEL', rows: ['away', 'home'].flatMap(side => ['starter', 'lineup', 'bullpen', 'splits', 'injuries'].map(category => ({ id: `${side}.${category}`, status: category === 'bullpen' ? status : 'observed' }))) });
const receipt = qualityReceiptFromAudit(audit('projected'));
check('quality scope is explicit and invalid audit remains unknown', () => {
  assert.equal(qualityGroupForBet({ dataQualityReceipt: receipt }), 'PROJECTED');
  assert.equal(qualityGroupForBet({}), 'UNKNOWN');
  assert.equal(qualityReceiptFromAudit({ ...audit('observed'), rows: [] }), null);
  assert.equal(qualityReceiptFromAudit({ ...audit('observed'), coverageScope: 'ALL' }), null);
});
const bet = (id, version, quality, status = 'SETTLED', league = 'MLB') => ({ id, league, gamePk: 100, market: '全場大小', placedAt: '2026-09-06T00:00:00Z', modelVersion: version, dataVersion: 'D1', dataQualityReceipt: quality,
  scoreStatus: 'SHADOW_DIAGNOSTIC_NOT_FORMAL', formulaDiagnosticScore: 8.1, stake: 100, status,
  settlement: { outcome: 'LOSS', winFraction: 0, lossFraction: 1, netProfit: -100, grossLoss: -100, grossWin: 0, rebate: 0 } });
const rows = [bet('1', 'M1', receipt), bet('2', 'M2', qualityReceiptFromAudit(audit('observed'))), bet('3', 'M2', null), bet('4', 'M1', receipt, 'CANCELLED'), bet('5', 'M1', receipt, 'OPEN'), bet('6', 'M1', receipt, 'SETTLED', 'NPB')];
const original = structuredClone(rows);
check('version, quality and league filters compose without mutating ledger', () => {
  const report = buildScorePerformanceReport(rows, { league: 'MLB', modelVersion: 'M1', dataQuality: 'PROJECTED' });
  assert.equal(report.performanceRecordCount, 2); assert.equal(report.attribution.versions[0].summary.netPnl, -100);
  assert.equal(report.attribution.versions[0].uniqueGames, 1); assert.equal(report.attribution.versions[0].summary.open, 1);
  assert.deepEqual(filterScorePerformanceDetails(rows, { league: 'MLB', modelVersion: 'M1', dataQuality: 'PROJECTED' }).map(row => row.id), ['1', '5']);
  assert.deepEqual(rows, original);
});
check('unknown historical evidence is not rebuilt from current values', () => {
  const report = buildScorePerformanceReport(rows, { dataQuality: 'UNKNOWN' });
  assert.equal(report.performanceRecordCount, 1); assert.equal(report.attribution.quality.find(row => row.key === 'UNKNOWN').summary.netPnl, -100);
  assert.equal(buildScorePerformanceReport(rows, { dataVersion: 'D2' }).performanceRecordCount, 0);
});
check('cross-league identical game IDs count as separate games', () => {
  assert.equal(buildScorePerformanceReport(rows).attribution.versions.find(row => row.modelVersion === 'M1').uniqueGames, 2);
});
check('client supplied evidence cannot override verified PIT evidence', () => {
  const value = buildServerVerifiedCloudBet({ league: 'MLB', date: '2026-09-06', stake: 100, modelVersion: 'FORGED', dataVersion: 'FORGED', dataQualityReceipt: qualityReceiptFromAudit(audit('observed')) },
    { pitVerified: true, officialGame: { gamePk: 100, away: 'Away', home: 'Home', gameDate: '2026-09-06T12:00:00Z' }, reader: { market: '全場大小', pick: '小9平', water: 0.95 }, pit: { modelVersion: 'M1', dataVersion: 'D1', dataQualityReceipt: receipt } },
    { id: 'server', placedAt: '2026-09-06T01:00:00Z' });
  assert.equal(value.dataVersion, 'D1'); assert.equal(value.modelVersion, 'M1'); assert.deepEqual(value.dataQualityReceipt, receipt);
});
const hash = value => value.repeat(64);
const game = { leagueId: 'MLB', league: 'MLB', gamePk: 123, officialDate: '2026-09-06', gameDate: '2026-09-06T10:00:00Z', gameNumber: 1, awayTeamId: 1, homeTeamId: 2, away: 'Away', home: 'Home' };
const context = { leagueId: 'MLB', game, fetchedAt: '2026-09-06T07:00:00Z', away: {}, home: {}, featureProvenance: [] };
const versions = { modelVersion: 'M1', rulesVersion: 'R1', dataVersion: 'D1', scoreFormulaVersion: 'S1', settlementRuleVersion: 'SET1', uncertaintySetVersion: 'U1' };
const distribution = { distributionId: 'dist1', distributionHash: hash('a'), gamePk: game.gamePk, scenarios: [{ id: 'central', weight: 1, cells: [{ awayRuns: 4, homeRuns: 4, probability: 1 }] }] };
const analysis = { leagueId: 'MLB', analysisType: 'FULL', inputHash: hash('b'), coreFingerprint: hash('c'), priceFingerprint: hash('d'), calculationFingerprint: hash('e'), auxiliaryFingerprint: hash('f'), distributionId: distribution.distributionId, distributionHash: distribution.distributionHash,
  dataAsOf: context.fetchedAt, lineAsOf: '2026-09-06T07:00:00Z', analysisAsOf: '2026-09-06T07:01:00Z', dataAudit: audit('projected'), expectedRuns: { full: { away: 4, home: 4 } }, results: [] };
const make = (changes = {}) => buildAnalysisPitSnapshotRecord({ league: 'MLB', game, frozenContext: context, analysis, distributionSnapshot: distribution, versions, markets: [], ...changes });
const before = make();
check('quality receipt survives immutable snapshot encode and replay', () => assert.deepEqual(buildAnalysisPitReplayBundle(before).marketAnalysis.dataQualityReceipt, receipt));
const after = make({ versions: { ...versions, modelVersion: 'M2' }, analysis: { ...analysis, inputHash: hash('1'), expectedRuns: { full: { away: 5, home: 4 } } } });
check('stored output comparison does not claim historical validation', () => {
  const report = compareFrozenAnalyses(before, after);
  assert.equal(report.status, 'SAME_SAVED_INPUTS_OUTPUT_COMPARISON'); assert.equal(report.changes[0].delta, 1);
  assert.equal(report.historicalValidationPassed, false); assert.equal(report.fetchedCurrentData, false);
});
check('changed source input cannot pass controlled comparison', () => {
  const other = make({ frozenContext: { ...context, away: { bullpen: { qualityFactor: 1.2 } } } });
  assert.equal(compareFrozenAnalyses(before, other).status, 'INPUTS_DIFFER_NOT_CONTROLLED_COMPARISON');
});
check('missing and tampered snapshots remain unreconstructable', () => {
  assert.equal(compareFrozenAnalyses(null, after).status, 'UNRECONSTRUCTABLE_MISSING_OR_INVALID_SNAPSHOT');
  const changed = structuredClone(before); changed.analysisAsOf = '2026-09-06T11:00:00Z';
  assert.equal(compareFrozenAnalyses(changed, after).status, 'UNRECONSTRUCTABLE_MISSING_OR_INVALID_SNAPSHOT');
});
console.log(JSON.stringify({ suite: 'performance-evidence-v11917', cases, ok: true }));
