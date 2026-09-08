import assert from 'node:assert/strict';
import './analysis-evidence-v2-test.mjs';
import { buildAnalysisDataAudit, ANALYSIS_DATA_AUDIT_V1_VERSION } from '../lib/analysis-data-audit-v1.js';

const find = (audit, id) => audit.rows.find(row => row.id === id);
const empty = buildAnalysisDataAudit();
assert.equal(empty.schemaVersion, ANALYSIS_DATA_AUDIT_V1_VERSION);
assert.equal(empty.rows.length, 10);
assert.equal(empty.coverageScope, 'CORE_PERSONNEL');
assert.deepEqual(empty.otherUsage, []);
assert.equal(empty.summary.missing, 10, 'empty context cannot imply observed or projected data');
assert.equal(empty.summary.usageUnverified, 10, 'missing usage evidence is unknown, not false');
assert.ok(empty.rows.every(row => row.usedInMean === null && row.usedInUncertainty === null));
assert.equal(empty.temporal.pitVerified, false);
assert.equal(empty.temporal.historicalReconstruction, false);

const context = {
  game: { gamePk: 123, league: 'MLB', gameDate: '2026-09-06T23:00:00Z', awayTeamId: 1, homeTeamId: 2, away: 'Away', home: 'Home' },
  fetchedAt: '2026-09-06T18:00:00Z',
  away: {
    starter: { id: 10, name: 'Zero ERA', available: true, individualPitcherStatsAvailable: true, era: 0, whip: 0, inningsPitched: 12, source: 'MLB_PERSON_GAME_LOG_STARTS_ONLY', observedAt: '2026-09-06T17:55:00Z' },
    lineup: { official: true, status: 'MISSING', identityStatus: 'CONFIRMED', metricsStatus: 'MISSING', metricCount: 0, metricCoverage: 0, modelMetricCoverage: 0, offensiveIndex: 1, source: 'MLB_LIVE_FEED', players: Array.from({ length: 9 }, (_, i) => ({ id: 100 + i, name: `Player ${i}` })) },
    bullpen: { pureRelief: true, status: 'CONFIRMED', qualityCoverage: 1, qualityFactor: 1, fatigueIndex: 0, rosterComplete: true, rosterCount: 6, usageAvailable: true, source: 'MLB_ACTIVE_ROSTER', observedAt: '2026-09-06T17:54:00Z', relievers: [{ id: 20, name: 'Reliever' }] },
    injuriesAvailable: false, injuries: [], injuryImpact: 0,
    vsLeft: { available: true, status: 'PROJECTED', ops: 0, plateAppearances: 20, sourceRecord: 'https://statsapi.mlb.com/splits', temporalContract: 'CURRENT_SEASON_AS_FETCHED_NOT_HISTORICAL_ARCHIVE' },
    vsRight: { available: false, ops: null, plateAppearances: 0 },
  },
  featureProvenance: [
    { featureName: 'awayLineup', sourceProvider: 'MLB_CURRENT_FEED', asOf: '2026-09-05', rawPayloadHash: 'a'.repeat(64) },
    { featureName: 'homeLineup', sourceProvider: 'HOME_ONLY_PROVIDER', observedAt: '2026-09-06T17:59:00Z' },
  ],
};
const profile = { dataUsage: [
  { key: 'away.starter', usedInMean: true, usedInUncertainty: true, reason: 'MEASURED_STARTER' },
  { key: 'away.lineup.offensiveIndex', usedInMean: true, usedInUncertainty: true, reason: 'NEUTRAL_MISSING_METRICS' },
  { key: 'away.bullpen.qualityFactor', usedInMean: true, usedInUncertainty: true, reason: 'QUALITY' },
  { key: 'away.bullpen.fatigueIndex', usedInMean: false, usedInUncertainty: false, reason: 'DIAGNOSTIC_ONLY' },
  { key: 'away.vsLeft', usedInMean: true, usedInUncertainty: true, reason: 'SELECTED_HAND' },
  { key: 'away.vsRight', usedInMean: false, usedInUncertainty: false, reason: 'NOT_SELECTED' },
  { key: 'away.injuries', usedInMean: false, usedInUncertainty: true, reason: 'UNCERTAINTY_ONLY' },
  { key: 'park.runFactor', usedInMean: true, usedInUncertainty: true, reason: 'PARK_MEAN_AND_SAMPLE', suppliedEvidence: 'preserve-original-field' },
  { key: 'weather.meanRunFactor', usedInMean: true, usedInUncertainty: false, reason: 'MEAN_ONLY' },
  { key: 'advanced.injuryRunValue', usedInMean: false, usedInUncertainty: false, reason: 'NOT_PROMOTED' },
  { key: 'rules.doubleheader', usedInMean: false, usedInUncertainty: false, reason: 'DIAGNOSTIC_ONLY' },
] };
const before = JSON.stringify({ context, profile });
const receipt = buildAnalysisDataAudit(context, profile);
assert.equal(JSON.stringify({ context, profile }), before, 'receipt is pure and does not modify engine inputs');
assert.deepEqual(buildAnalysisDataAudit(context, profile), receipt, 'receipt has no live clock dependency');
assert.equal(receipt.gameId, '123');
assert.equal(receipt.league, 'MLB');
assert.deepEqual(receipt.otherUsage, profile.dataUsage.slice(-4), 'ungrouped declarations preserve all original fields without invented source status');
assert.equal(receipt.summary.otherUsageCount, 4);
assert.equal(receipt.summary.label, '核心人員資料取得概況');
const representedKeys = new Set([...receipt.rows.flatMap(row => row.usage.map(item => item.key)), ...receipt.otherUsage.map(item => item.key)]);
assert.deepEqual([...representedKeys].sort(), profile.dataUsage.map(item => item.key).sort(), 'every declared model-use key is represented');
assert.ok(receipt.otherUsage.every(item => !Object.hasOwn(item, 'status')), 'unclassified extra declarations cannot imply acquisition completeness');
assert.equal(find(receipt, 'away.starter').status, 'observed');
assert.equal(find(receipt, 'away.starter').metrics.era, 0, 'observed zero remains a real zero');
assert.equal(find(receipt, 'away.lineup').status, 'missing', 'nine names and neutral 1 do not imply batting measurements');
assert.equal(find(receipt, 'away.lineup').coverage.identityCount, 9);
assert.equal(find(receipt, 'away.lineup').coverage.metricCount, 0);
assert.equal(find(receipt, 'away.lineup').usedInMean, true, 'report model use separately from data completeness');
assert.equal(find(receipt, 'away.lineup').observedAt, null, 'requested asOf and context fetchedAt must not invent source observation time');
assert.equal(find(receipt, 'away.lineup').asOf, '2026-09-05');
assert.ok(!find(receipt, 'away.lineup').source.includes('HOME_ONLY_PROVIDER'), 'source ownership is side-specific');
assert.equal(find(receipt, 'away.bullpen').status, 'observed');
assert.equal(find(receipt, 'away.bullpen').metrics.fatigueIndex, 0);
assert.equal(find(receipt, 'away.bullpen').usage[1].usedInMean, false, 'individual diagnostic fields remain disclosed');
assert.equal(find(receipt, 'away.splits').status, 'projected');
assert.equal(find(receipt, 'away.splits').metrics.vsLeft.ops, 0);
assert.equal(find(receipt, 'away.splits').metrics.vsRight.ops, null);
assert.equal(find(receipt, 'away.injuries').status, 'missing', 'empty unavailable injury list does not mean no injuries');
assert.equal(find(receipt, 'away.injuries').usedInMean, false);
assert.equal(find(receipt, 'away.injuries').usedInUncertainty, true);

const asian = buildAnalysisDataAudit({
  ...context, leagueId: 'KBO', away: {
    starter: { available: true, performanceAvailable: false, status: 'PROJECTED', projectionMode: 'LEAGUE_NEUTRAL_ROTATION_SCENARIO', qualityFactor: 1, source: 'KBO_LEAGUE_NEUTRAL_STARTER_SCENARIO' },
    lineup: { available: true, official: false, projected: true, status: 'PROJECTED_SCENARIO', offensiveIndex: 1, statsCoverage: 0, players: [{ officialPlayerId: 'k1', name: 'Prior hitter' }], offensiveIndexIsFallback: true, incompleteReasons: ['CURRENT_GAME_STARTING_LINEUP_NOT_CONFIRMED'], source: 'KBO_LATEST_OFFICIAL_STARTING_LINEUP_PROJECTED_PIT' },
    bullpen: { available: true, status: 'PROJECTED_NEUTRAL_RELIEF_SCENARIO', qualityFactor: 1, qualityScope: 'NEUTRAL_RELIEF_SCENARIO', modelUsage: 'NEUTRAL_QUALITY_ONLY_WORKLOAD_DIAGNOSTIC' },
    injuries: [], injuryImpact: 0,
  },
}, profile);
assert.equal(find(asian, 'away.starter').status, 'projected');
assert.equal(find(asian, 'away.lineup').status, 'projected');
assert.equal(find(asian, 'away.lineup').coverage.metricCount, 0);
assert.ok(find(asian, 'away.lineup').substitutions.includes('NEUTRAL_LINEUP_INDEX_MISSING_MEASURED_BATTING'));
assert.equal(find(asian, 'away.bullpen').status, 'projected');
assert.equal(find(asian, 'away.injuries').status, 'missing');
assert.equal(asian.temporal.pitVerified, false, 'a source name containing PIT is not PIT verification');

const stale = buildAnalysisDataAudit({ ...context, away: { ...context.away, starter: { ...context.away.starter, expiresAt: '2026-09-06T17:59:00Z' } } }, profile);
assert.equal(find(stale, 'away.starter').status, 'stale');
assert.equal(find(stale, 'away.starter').metrics.era, 0, 'stale receipt preserves original measurement');
for (const bad of [null, '', ' ', false, true, {}, [], [0]]) {
  const invalid = buildAnalysisDataAudit({ ...context, away: { starter: { available: true, source: 'OFFICIAL', era: bad, whip: bad, fip: bad } } });
  assert.equal(find(invalid, 'away.starter').status, 'missing');
  assert.equal(find(invalid, 'away.starter').metrics.era, null);
}
const noSample = buildAnalysisDataAudit({ ...context, away: { starter: { available: true, source: 'OFFICIAL', era: 0, inningsPitched: 0 } } });
assert.equal(find(noSample, 'away.starter').status, 'missing', 'availability flag and zero defaults without sample evidence are insufficient');
const cpblMeasured = buildAnalysisDataAudit({ ...context, leagueId: 'CPBL', away: { starter: {
  id: 'CPBL_PLAYER_1', assignmentStatus: 'OFFICIAL_CONFIRMED', performanceAvailable: true,
  performanceSource: 'CPBL_OFFICIAL_INDIVIDUAL_STARTER', performanceObservedAt: '2026-09-06T08:00:00Z',
  performanceMetric: 'WOBA_ALLOWED_RELATIVE_TO_OFFICIAL_PITCHER_SAMPLE', qualityFactor: 0.96,
  season: { era: null, whip: null, woba: 0.3, leagueWoba: 0.32, battersFaced: 400, inningsPitched: null, estimatedInningsPitched: 95 },
} } });
const cpblRow = find(cpblMeasured, 'away.starter');
assert.equal(cpblRow.status, 'observed', 'real CPBL wOBA evidence must not be hidden because ERA is unavailable');
assert.equal(cpblRow.metrics.woba, 0.3);
assert.equal(cpblRow.metrics.era, null);
assert.equal(cpblRow.metrics.inningsPitched, null);
assert.equal(cpblRow.metrics.estimatedInningsPitched, 95);
assert.equal(cpblRow.source, 'CPBL_OFFICIAL_INDIVIDUAL_STARTER');
assert.equal(cpblRow.observedAt, '2026-09-06T08:00:00.000Z');
const transportReceipts = buildAnalysisDataAudit({ ...context, away: { lineup: {
  ...context.away.lineup,
  sourceReceipts: [
    { source: 'MLB_GAME_LIVE_FEED', sourceRecord: 'https://statsapi.mlb.com/api/v1.1/game/123/feed/live', fetchedAt: '2026-09-06T12:01:00Z', rawPayloadHash: 'c'.repeat(64), purpose: 'CURRENT_LINEUP_IDENTITY', sourceGameId: 123, sourceGameDate: '2026-09-06' },
    { source: 'MLB_GAME_LIVE_FEED', sourceRecord: 'https://statsapi.mlb.com/api/v1.1/game/122/feed/live', fetchedAt: '2026-09-06T10:00:00Z', rawPayloadHash: 'd'.repeat(64), sourceGameId: 122, sourceGameDate: '2026-09-05' },
  ],
} } });
const transportRow = find(transportReceipts, 'away.lineup');
assert.equal(transportRow.observedAt, '2026-09-06T12:01:00.000Z', 'summary uses latest actual source clock, never context assembly time');
assert.equal(transportRow.sources.find(row => row.sourceGameId === '122').observedAt, '2026-09-06T10:00:00.000Z', 'older component acquisition remains independently visible');
assert.equal(transportRow.sources.find(row => row.sourceGameId === '123').purpose, 'CURRENT_LINEUP_IDENTITY');
assert.equal(receipt.summary.total, receipt.summary.observed + receipt.summary.projected + receipt.summary.missing + receipt.summary.stale);
console.log('analysis-data-audit-v1-test: PASS');
