import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openingBaseline } from '../lib/nba/opening-core.js';
import { openingTraining } from '../lib/nba/opening-training.js';
import {
  OPENING_RESEARCH_PROTOCOL as protocol, OPENING_RESEARCH_PROTOCOL_HASH, OPENING_RESEARCH_EXPECTED_PROTOCOL_HASH,
  OPENING_RESEARCH_VERSION, openingResearchCandidate, buildOpeningResearchObservations,
  buildOpeningResearchBaselineObservations, openingResearchProbability as probability,
  openingResearchReadiness, evaluateOpeningResearch,
} from '../lib/nba/opening-research.js';

assert.equal(OPENING_RESEARCH_PROTOCOL_HASH, OPENING_RESEARCH_EXPECTED_PROTOCOL_HASH);
assert.equal(OPENING_RESEARCH_PROTOCOL_HASH, createHash('sha256').update(JSON.stringify(protocol)).digest('hex'));
assert.equal(protocol.developmentYear, 2021);
assert.equal(protocol.independentHoldoutYear, 2022);
assert.deepEqual(protocol.viewedRegressionYears, [2023, 2024, 2025, 2026]);
assert.throws(() => { protocol.candidateDefinitions.fullTotal[0].priorWeight = 999; }, TypeError);
const candidate = target => openingResearchCandidate(target, protocol.candidateDefinitions[target][0]);
const full = candidate('fullTotal'), half = candidate('halfTotal');
assert.notEqual(full.candidateId, half.candidateId);
assert.throws(() => openingResearchCandidate('fullMargin', protocol.candidateDefinitions.fullTotal[0]));
assert.throws(() => openingResearchCandidate('fullTotal', { ...protocol.candidateDefinitions.fullTotal[0], priorWeight: 999 }));

// Purely synthetic constant scores exercise exact arithmetic/gates, not a claim
// about historical performance. Thirty teams give at least 100 early fixtures.
const history = [];
for (const year of [2018, 2019, 2020, 2021, 2022]) {
  for (let index = 0; index < 1200; index++) {
    const row = { gameId: `nba:espn:game:${year * 1000000 + index + 1}`,
      date: new Date(Date.UTC(year, 0, 1 + Math.floor(index / 4))).toISOString().slice(0, 10),
      year, seasonType: 'regular', homeId: `nba:espn:team:${index % 30 + 1}`,
      awayId: `nba:espn:team:${(index + 15) % 30 + 1}`, neutralSite: false,
      homeScore: 100, awayScore: 100, homeHalf: 50, awayHalf: 50 };
    row.checkpointSha256 = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    history.push(row);
  }
}
const before = JSON.stringify(history);
const canonicalBaseline = buildOpeningResearchBaselineObservations(history, 'fullTotal');
const openingResearchProbability = (row, rows, candidate, baseline = canonicalBaseline) => probability(row, rows, candidate, baseline);
const original = buildOpeningResearchObservations(history, full);
assert.equal(JSON.stringify(history), before, 'research must preserve the original archive');
assert.equal(original.observations.length, 3600);
assert.ok(original.observations.every(row => row.fitThrough < row.date && row.featureThrough < row.date
  && row.fitSeasonYears.every(year => year < row.year) && row.candidateId === full.candidateId));
assert.ok(original.observations.every(row => row.prediction === 200 && row.error === 0));
for (const row of [original.observations[0], original.observations[123], original.observations.at(-1)]) {
  const fixture = history.find(value => value.gameId === row.gameId);
  const actual = openingBaseline({ season: { year: fixture.year }, taipeiDate: fixture.date,
    home: { id: fixture.homeId }, away: { id: fixture.awayId } }, history, full.priorWeight);
  assert.equal(row.feature.baseline, actual.fullTotal, 'linear-time aggregates must match the established production baseline');
}
assert.throws(() => buildOpeningResearchObservations(history, { ...full, ridgePenalty: 1 }));
assert.throws(() => buildOpeningResearchObservations([{ ...history[0], league: 'NHL' }, ...history.slice(1)], full));
assert.throws(() => buildOpeningResearchObservations([history[0], ...history], full));

const target = original.observations.find(row => row.year === 2021);
const p = openingResearchProbability(target, original.observations, full);
assert.equal(p.p, 0, 'a genuine zero probability must not be clipped or replaced');
assert.equal(p.baselineP, 0);
assert.equal(p.y, 0);
assert.equal(p.calibrationSamples, 1200);
assert.equal(p.baselineCalibrationSamples, 2400, 'reference residuals must not require a fitted candidate model');
assert.ok(p.calibrationThrough < target.date);
assert.equal(p.calibrationCandidateId, full.candidateId);
assert.equal(openingResearchProbability(original.observations[0], original.observations, full), null,
  'without earlier candidate-version residuals, probability must remain missing');
const poison = original.observations.slice(0, 150).map(row => ({ ...row, error: 999999 }));
for (const patch of [{ candidateId: 'foreign' }, { modelVersion: 'legacy-unmatched-version' }, { target: 'halfTotal' },
  { date: target.date }, { date: '2020-12-01', year: 2021 }, { featureThrough: '2999-01-01' }, { fitThrough: '2999-01-01' }]) {
  const mixed = [...original.observations, ...poison.map(row => ({ ...row, ...patch }))];
  assert.deepEqual(openingResearchProbability(target, mixed, full), p, 'foreign/current/future evidence cannot alter calibration');
}
for (const patch of [{ target: 'halfTotal' }, { baselineVersion: 'foreign' }, { date: target.date },
  { year: 2021 }, { featureThrough: '2999-01-01' }]) {
  const mixed = [...canonicalBaseline, ...canonicalBaseline.slice(0, 100).map(row => ({ ...row, actual: 999999, ...patch }))];
  assert.deepEqual(openingResearchProbability(target, original.observations, full, mixed), p,
    'reference calibration excludes other targets/versions and current/future evidence');
}
assert.equal(openingResearchProbability(target, original.observations, full, []), null);
assert.throws(() => openingResearchProbability({ ...target, candidateId: half.candidateId }, original.observations, full));
assert.throws(() => openingResearchProbability({ ...target, prediction: NaN }, original.observations, full));
const changedOutcome = openingResearchProbability({ ...target, actual: 999 }, original.observations, full);
assert.equal(changedOutcome.p, p.p, 'the target outcome may score a forecast but cannot change its probability');
assert.equal(changedOutcome.y, 1);

const futureChanged = history.map(row => row.year >= 2022 ? { ...row, homeScore: 140, homeHalf: 65 } : { ...row });
const after = buildOpeningResearchObservations(futureChanged, full);
assert.deepEqual(after.observations.filter(row => row.year <= 2021), original.observations.filter(row => row.year <= 2021),
  'holdout/future labels cannot change development features, coefficients or predictions');
const targetDayChanged = history.map(row => row.date === target.date ? { ...row, homeScore: 140, homeHalf: 65 } : { ...row });
const sameDay = buildOpeningResearchObservations(targetDayChanged, full).observations.filter(row => row.date === target.date);
assert.ok(sameDay.every(row => row.prediction === 200), 'all results on the target date are unavailable to every same-day feature');
const halfChanged = history.map(row => ({ ...row, homeHalf: row.year === 2020 ? 55 : row.homeHalf }));
assert.deepEqual(buildOpeningResearchObservations(halfChanged, full), original, 'halftime data cannot contaminate full totals');
assert.notDeepEqual(buildOpeningResearchObservations(halfChanged, half).observations,
  buildOpeningResearchObservations(history, half).observations, 'halftime models must use their own observations');

// A varying early/late score environment catches the original comparator bug:
// phase-aware model residuals may differ, but all benchmark probabilities must
// use the same unfiltered canonical prior20 calibration evidence.
const variedHistory = history.map((row, index) => ({ ...row,
  homeScore: index % 1200 < 150 ? 70 : 120, awayScore: index % 1200 < 150 ? 75 : 115 }));
const variedBaseline = buildOpeningResearchBaselineObservations(variedHistory, 'fullTotal');
const variedCandidates = protocol.candidateDefinitions.fullTotal.map(definition => {
  const candidate = openingResearchCandidate('fullTotal', definition);
  return { candidate, rows: buildOpeningResearchObservations(variedHistory, candidate).observations };
});
for (const index of [1200, 1250, 1500, 2000]) {
  const compared = variedCandidates.map(({ candidate, rows }) => probability(rows[index], rows, candidate, variedBaseline));
  assert.ok(compared.every(Boolean));
  assert.ok(compared.every(value => value.baselineP === compared[0].baselineP
    && value.threshold === compared[0].threshold && value.baselineCalibrationSamples === compared[0].baselineCalibrationSamples),
  'all candidates must share exact reference probabilities, thresholds and calibration samples');
}

const validMetrics = { samples: 1000, earlySamples: 100, probabilitySamples: 1000,
  modelMAE: 10, baselineMAE: 11, earlyModelMAE: 9, earlyBaselineMAE: 10,
  modelBrier: .2, baselineBrier: .21, modelLogLoss: .6, baselineLogLoss: .61 };
assert.equal(openingResearchReadiness(validMetrics).readyForIndependentValidation, true);
for (const patch of [{ probabilitySamples: 0 }, { probabilitySamples: 999 }, { modelBrier: null }, { modelLogLoss: NaN },
  { earlyModelMAE: 11 }, { modelMAE: 12 }, { modelBrier: .22 }, { modelLogLoss: .62 }]) {
  assert.equal(openingResearchReadiness({ ...validMetrics, ...patch }).readyForIndependentValidation, false);
}

// Run the real comparison/selection/holdout pipeline. An apparent perfect
// synthetic metric result can never grant promotion or production execution.
const report = evaluateOpeningResearch(history, { archiveEvidence: {
  kind: 'NBA_OPENING_VERIFIED_REGULAR_ARCHIVE', synthetic: true, missing: [], sources: ['synthetic-only'],
  coverage: { years: Object.fromEntries([2021, 2022].map(year => [year, { expectedGames: 1200, observedGames: 1200,
    teamSchedulesChecked: 30, quarterCrosscheckedGames: 1200, missingGames: 0 }])) },
} });
assert.equal(report.promotion.status, 'BLOCKED');
assert.equal(report.promotion.executable, false);
assert.equal(report.promotion.promotionEligible, false);
assert.ok(report.sourceAudit.every(row => row.verified === false), 'synthetic data cannot masquerade as an audited historical reserve');
assert.deepEqual(report.sourceAudit.map(row => row.year), [2018, 2019, 2020, 2021, 2022],
  'training, feature, calibration, development and holdout years all require source audit');
for (const target of Object.values(report.targets)) {
  assert.equal(target.commonPointSamples, 1200);
  assert.equal(target.commonProbabilitySamples, 1200);
  assert.ok(target.selectedForIndependentValidation);
  assert.equal(target.independentHoldout.evaluatedCandidateId, target.selectedForIndependentValidation);
  assert.equal(target.independentHoldout.passed, true);
  assert.ok(Object.values(target.viewedRegression).every(row => row.role === 'VIEWED_REGRESSION_ONLY_NOT_NEW_OOS'));
}
const changedReport = evaluateOpeningResearch(futureChanged);
for (const target of ['fullTotal', 'halfTotal']) {
  assert.equal(changedReport.targets[target].selectedForIndependentValidation, report.targets[target].selectedForIndependentValidation,
    'new holdout labels cannot select a different candidate');
  assert.deepEqual(changedReport.targets[target].candidates, report.targets[target].candidates);
  assert.equal(changedReport.targets[target].independentHoldout.passed, false, 'a failed new reserve must remain failed');
}
const retained = evaluateOpeningResearch(openingTraining.history);
assert.equal(retained.promotion.status, 'BLOCKED');
assert.ok(Object.values(retained.targets).every(row => row.commonProbabilitySamples === 0 && row.selectedForIndependentValidation === null));
assert.equal(JSON.stringify(history), before);
const artifact = readFileSync(new URL('../lib/nba/opening-training.js', import.meta.url), 'utf8');
assert.ok(artifact.includes('Generated by scripts/prepare-nba-opening-training.mjs'));
assert.equal(openingTraining.acceptance.fullTotal.accepted, false, 'research must not alter the legacy production artifact');
console.log('PASS frozen NBA opening totals research: independent FT/HT candidates, exact prior-only baseline parity, same-day/future/holdout label exclusion, candidate-version calibration, probability sample gates, source audits, no automatic promotion and unchanged production artifact');
