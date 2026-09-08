import assert from 'node:assert/strict';
import { evidenceJSON, settlementEvidence } from '../lib/analysis-evidence-export-v2.js';
import { buildAnalysisDataAudit } from '../lib/analysis-data-audit-v1.js';
import { sourceStatusLabel, lineupCoverageDisplay } from '../lib/mlb-diagnostic-display-v1.js';
import { standardFipEvidence } from '../lib/mlb-run-model-v103.js';

for (const leagueId of ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL']) {
  const analysis = { leagueId, calculationSettings: { rebateRate: .015 }, results: [{ market: 'test', modelEV: .132079, fullWinProbability: .5354999981234567, equivalentWinProbability: .6382879835054284 }] };
  const before = structuredClone(analysis);
  const saved = JSON.parse(evidenceJSON(settlementEvidence(analysis)));
  assert.equal(saved.directions[0].modelEventProbabilities.fullWinProbability, analysis.results[0].fullWinProbability);
  assert.equal(saved.directions[0].modelEventProbabilities.partialWinProbability, null);
  assert.equal(saved.directions[0].equivalentSettlementShares.win, analysis.results[0].equivalentWinProbability);
  assert.deepEqual(analysis, before);
}
assert.equal(JSON.parse(evidenceJSON({ zero: 0, missing: null, bad: NaN })).bad.evidenceError, 'NON_FINITE_NUMBER');
for (const bad of [Infinity, -Infinity]) assert.equal(JSON.parse(evidenceJSON(bad)).suppliedValue, String(bad));
const context = { leagueId: 'MLB', away: { starter: { source: 'MLB_PERSON_PIT_SEASON_IP_PER_START', available: true, inningsPitched: 22 + 2 / 3, gamesStarted: 0, gamesPitched: 12, era: 5.9, expectedInnings: 3, expectedInningsStatus: 'PROJECTED', expectedInningsCalculation: { branch: 'ROLE_OR_MISSING_FALLBACK', fallback: 3 } }, lineup: { players: [{ id: 12, ops: 0, plateAppearances: 18, reliability: .3, modelMetricUsed: true }] } }, home: { starter: { expectedInnings: 4.5, expectedInningsStatus: 'CONFIRMED' } } };
const before = structuredClone(context);
const audit = buildAnalysisDataAudit(context);
const starter = audit.rows.find(row => row.key === 'away.starter');
assert.equal(starter.statusReason, 'INDIVIDUAL_PITCHING_REPORTED_NO_STARTER_SAMPLE');
assert.equal(starter.roleEvidence.starterSampleStatus, 'NO_STARTER_SAMPLE');
assert.equal(starter.roleEvidence.inningsFallback, 3);
assert.equal(starter.usedInMean, null);
assert.equal(audit.rows.find(row => row.key === 'away.lineup').modelBattingInputs[0].metrics.ops, 0);
assert.deepEqual(context, before);
assert.match(sourceStatusLabel('starterExpectedInnings', 'PROJECTED', audit), /客局數歷史輸入：PROJECTED.*主局數歷史輸入：CONFIRMED/);
assert.match(lineupCoverageDisplay({}), /未知\/未知/);
assert.equal(buildAnalysisDataAudit({ leagueId: 'NBA' }).rows.find(row => row.category === 'lineup').coverage.expectedCount, null);
assert.equal(buildAnalysisDataAudit({ leagueId: 'NBA', away: { lineup: { expectedCount: 5 } } }).rows.find(row => row.key === 'away.lineup').coverage.expectedCount, 5);
const explanation = { calculation: { components: { advanced: { away: { components: { framing: { state: { status: 'MISSING', usable: false } } } } } } } };
assert.match(sourceStatusLabel('catcherFraming', 'CONFIRMED', audit, explanation), /摘要原值：CONFIRMED.*客計算輸入：MISSING.*主計算輸入：UNKNOWN/);
const trace = standardFipEvidence({ kPer9: 7, bbPer9: 4, hrPer9: 2, fip: 5.52 }, { era: 4.2, kPer9: 8.6, bbPer9: 3.2, hrPer9: 1.15 });
assert.equal(trace.hbpUsed, false);
assert.equal(trace.reportedFip, 5.52);
assert.equal(trace.value, Math.max(2, Math.min(7.5, (13 * 2 + 3 * 4 - 2 * 7) / 9 + trace.constant)));
assert.equal(standardFipEvidence({ kPer9: 100 }).actualRates.k9, 16);
console.log('PASS evidence v2: DOM-free, six-league export, exact numeric roundtrip, unknown/zero, role and source boundaries');
