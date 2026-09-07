import { selectPitReplayEngine } from '../lib/pit-replay-engines.js';
import assert from 'node:assert/strict';
import { auditSavedPitModel } from '../lib/saved-pit-model-audit.js';
import { buildDistributionSnapshot, evaluateMarketsFromDistribution, MODEL_VERSION, RULES_VERSION } from '../lib/analysis-v11.js';
import { DATA_VERSION } from '../lib/snapshot-v9.js';
const snapshotAsOf = '2026-08-23T18:00:00.000Z';
const team = {
  hitting: { games: 100, gamesPlayed: 100, runsPerGame: 4.5, ops: 0.73, status: 'CONFIRMED' },
  recentHitting: { games: 12, gamesPlayed: 12, runsPerGame: 4.4, status: 'CONFIRMED' },
  pitching: { inningsPitched: 900, era: 4.2, whip: 1.28, kPer9: 8.7, bbPer9: 3.1, hrPer9: 1.1, status: 'CONFIRMED' },
  recentPitching: { inningsPitched: 90, era: 4.1, whip: 1.27, kPer9: 8.8, bbPer9: 3.0, hrPer9: 1.0, status: 'CONFIRMED' },
  starter: { inningsPitched: 120, gamesStarted: 22, expectedInnings: 5.45, era: 3.8, whip: 1.2, kPer9: 9, bbPer9: 2.8, hrPer9: 1, status: 'CONFIRMED', throws: 'R', throwsStatus: 'CONFIRMED' },
  bullpen: { pureRelief: true, qualityFactor: 1, status: 'CONFIRMED' },
  lineup: { official: true, offensiveIndex: 1, players: [] },
  scoring: { games: 100, varianceRuns: 7 },
  advanced: {},
};
const context = {
  modelVersion: MODEL_VERSION,
  leagueId: 'MLB', analysisMode: 'EXPERIMENTAL_SHADOW', betEligible: false, executable: false,
  fetchedAt: snapshotAsOf,
  game: { leagueId: 'MLB', gamePk: 777001, gameDate: '2026-08-23T23:00:00.000Z', away: '洋基', home: '紅襪', scheduledInnings: 9 },
  league: { runsPerTeamGame: 4.4, ops: 0.72, era: 4.25, whip: 1.30, kPer9: 8.6, bbPer9: 3.2, hrPer9: 1.15 },
  away: structuredClone(team), home: structuredClone(team),
  park: { runFactor: 1, factorStatus: 'CONFIRMED' }, weather: { meanRunFactor: 1, status: 'CONFIRMED', roofConfirmed: true },
  sourceStatuses: { lineups: 'CONFIRMED' }, dataGateV10: { passedForShadowScore: true, modelErrorMarginEV: 0.008 },
  featureProvenance: [{ featureName: 'core', observedAt: snapshotAsOf, sourceProvider: 'ISOLATED_TEST_FIXTURE' }],
};
const input = {
  dataVersion: DATA_VERSION,
  snapshotAsOf,
  context,
  markets: [
    { market: '全場大小', pick: '大8平', water: 0.95, lineAsOf: snapshotAsOf, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', executable: true },
    { market: '全場大小', pick: '小8平', water: 0.95, lineAsOf: snapshotAsOf, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', executable: true },
  ],
  actual: { awayRuns: 5, homeRuns: 4 },
};

const distribution = buildDistributionSnapshot({ context });
const analysis = evaluateMarketsFromDistribution({ context, markets: input.markets, distributionSnapshot: distribution });
const bundle = {
  frozenContext: context, analysisAsOf: snapshotAsOf, dataAsOf: snapshotAsOf,
  versions: { modelVersion: MODEL_VERSION, dataVersion: DATA_VERSION, rulesVersion: RULES_VERSION },
  distributionHash: distribution.distributionHash,
  marketAnalysis: { ...analysis, suppliedMarkets: input.markets },
};
const before = JSON.stringify(bundle);
const audit = auditSavedPitModel(bundle);
assert.equal(audit.status, 'DISTRIBUTION_REPRODUCED');
assert.equal(audit.evMatchesUnderStatedSettings, true);
assert.equal(audit.predictiveAccuracyValidated, false);
assert.equal(JSON.stringify(bundle), before);
assert.equal(auditSavedPitModel({ ...bundle, distributionHash: 'bad' }).status, 'DISTRIBUTION_MISMATCH');
const old = structuredClone(bundle); old.versions.modelVersion = 'unavailable';
assert.equal(auditSavedPitModel(old).status, 'ORIGINAL_ENGINE_UNAVAILABLE');
const future = structuredClone(bundle);
future.frozenContext.featureProvenance[0].observedAt = '2099-01-01T00:00:00.000Z';
assert.equal(auditSavedPitModel(future).pregameEvidence.ok, false);
console.log('Saved PIT audit: frozen inputs preserved, distribution and EV compared, incompatible engine and future evidence rejected');

const originalEngine = selectPitReplayEngine('BASEBALL-STATE-AWARE-LINKED-SCORE-DISTRIBUTION-2026-08-v11.0.0');
const archivedContext = structuredClone(context);
archivedContext.modelVersion = originalEngine.modelVersion;
archivedContext.modelConfig = { engine: originalEngine.distributionEngine };
const archivedDistribution = originalEngine.build({ context: archivedContext });
const archivedAnalysis = originalEngine.evaluate({ context: archivedContext, markets: input.markets, distributionSnapshot: archivedDistribution });
const archivedAudit = auditSavedPitModel({ ...bundle, frozenContext: archivedContext,
  versions: { modelVersion: originalEngine.modelVersion, dataVersion: originalEngine.dataVersion, rulesVersion: originalEngine.rulesVersion },
  distributionHash: archivedDistribution.distributionHash,
  marketAnalysis: { ...archivedAnalysis, suppliedMarkets: input.markets },
});
assert.equal(archivedAudit.archivedEngineUsed, true);
assert.equal(archivedAudit.distributionMatches, true);
assert.equal(archivedAudit.evMatchesUnderStatedSettings, true);
assert.equal(archivedAudit.predictiveAccuracyValidated, false);
