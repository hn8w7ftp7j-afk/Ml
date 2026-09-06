import assert from 'node:assert/strict';
import { NHL_HISTORICAL_SAMPLES as corpus, NHL_HISTORICAL_SAMPLE_METADATA as metadata } from '../lib/nhl/historical-samples.js';
import { nhlHistoricalResearch } from '../lib/nhl/research.js';
import { fitNhlModel, predictNhlDistribution, walkForwardNhlModel } from '../lib/nhl/model.js';
import { normalizeNhlModelGame } from '../lib/nhl/model-qa.js';
import { validateNhlIdentity } from '../lib/nhl/identity.js';

// This is an offline validation of the checked-in, actually retrieved official
// corpus. Source fingerprints are checked for traceability and uniqueness; the
// original remote response bytes are not refetched/re-hashed by this test.
// No market quote, achieved return, historical injury report or goalie forecast
// is synthesized or claimed as verified by the historical score checks below.
const EMBARGO_MS = 48 * 3600_000;
const byId = new Map(corpus.map(game => [game.gameId, game]));
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-10, `${message}: ${actual} != ${expected}`);
let checks = 0;
const test = (name, fn) => { fn(); checks += 1; console.log(`PASS ${name}`); };

test('official source, response fingerprints and unique event identities cover every retained sample', () => {
  assert.ok(corpus.length >= 20, 'The verified 20-game baseline must not silently disappear.');
  assert.equal(metadata.totalGames, corpus.length);
  assert.equal(byId.size, corpus.length);
  const fingerprints = new Set();
  for (const game of corpus) {
    assert.equal(validateNhlIdentity(game).ok, true, `Official identity: ${game.gameId}`);
    assert.equal(game.league, 'NHL');
    assert.equal(game.officialGameId, game.gameId);
    assert.equal(game.source.provider, 'NHL');
    const source = new URL(game.source.url);
    assert.equal(source.protocol, 'https:');
    assert.equal(source.hostname, 'api-web.nhle.com');
    assert.equal(source.pathname, `/v1/gamecenter/${game.gameId}/landing`);
    assert.match(game.source.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(!fingerprints.has(game.source.contentHash), `Source fingerprint unexpectedly reused for ${game.gameId}`);
    fingerprints.add(game.source.contentHash);
    assert.ok(Date.parse(game.source.fetchedAt) > Date.parse(game.startTimeUTC));
    const normalized = normalizeNhlModelGame(game);
    assert.equal(normalized.synthetic, false);
    assert.equal(normalized.sourceKind, 'OFFICIAL_NHL_RECORD');
    assert.equal(normalized.path.sourceGameId, game.gameId);
  }
});

test('retained official periods independently reconcile REG, OT and SO final scores', () => {
  const outcomes = {};
  for (const game of corpus) {
    outcomes[game.outcomeType] = (outcomes[game.outcomeType] || 0) + 1;
    assert.equal(game.periods.length, 3);
    assert.equal(game.qa.canUseHistoricalPeriods, true);
    const regulation = { away: 0, home: 0 };
    for (const period of game.periods) {
      for (const side of ['away', 'home']) {
        const goals = period[`${side}Goals`];
        assert.ok(Number.isSafeInteger(goals) && goals >= 0, `Bad observed period: ${game.gameId}`);
        regulation[side] += goals;
      }
    }
    for (const side of ['away', 'home']) assert.equal(regulation[side], game.regulation[`${side}Goals`]);
    if (game.outcomeType === 'REG') {
      assert.notEqual(regulation.away, regulation.home);
      assert.equal(game.final.awayGoals, regulation.away);
      assert.equal(game.final.homeGoals, regulation.home);
    } else {
      assert.ok(['OT', 'SO'].includes(game.outcomeType));
      assert.equal(regulation.away, regulation.home);
      const increments = [game.final.awayGoals - regulation.away, game.final.homeGoals - regulation.home].sort();
      assert.deepEqual(increments, [0, 1], `OT/SO has exactly one official winner goal: ${game.gameId}`);
    }
  }
  assert.ok(outcomes.REG > 0 && outcomes.OT > 0 && outcomes.SO > 0);
  assert.deepEqual(outcomes, metadata.outcomes);
});

let report;
let retrospective;
test('research exposes limited coverage and missing real-world verification instead of a calibrated-model claim', () => {
  report = nhlHistoricalResearch();
  assert.equal(metadata.scope, 'LIMITED_RETROSPECTIVE_ENGINEERING_CORPUS');
  for (const field of ['completeSeasonCoverage', 'pregamePointInTimeSnapshots', 'calibrationValidated', 'productionModelReady']) assert.equal(metadata[field], false);
  assert.equal(report.games.length, corpus.length);
  assert.equal(report.completePeriodGames, corpus.length);
  assert.equal(report.validation.engineeringCorpusOnly, true);
  assert.equal(report.validation.fullSeasonCoverage, false);
  assert.equal(report.validation.productionModelCalibrated, false);
  assert.equal(report.validation.historicalTai888PayoffVerified, false);
  assert.ok(report.validation.featuresMissing.some(feature => /goalie/.test(feature)));
  assert.ok(report.validation.featuresMissing.some(feature => /xG/.test(feature)));
});

test('current retrospective retrieval timestamps cannot authorize any historical strict-PIT fold', () => {
  // This corpus explicitly has no archived publication time. If such evidence
  // is added later, update its declared coverage and this test together.
  const lastStart = Math.max(...corpus.map(game => Date.parse(game.startTimeUTC)));
  for (const game of corpus) {
    assert.equal(game.outcomeAvailableAt, null);
    assert.ok(Date.parse(game.source.fetchedAt) > lastStart);
  }
  const strict = walkForwardNhlModel(corpus, { gameType: 2, availabilityMode: 'STRICT_PIT', initialTrainingGames: 3 });
  assert.equal(strict.foldCount, 0);
  assert.equal(strict.status, 'NO_ELIGIBLE_FOLDS');
  assert.equal(strict.meanRegulationBrier, null);
  assert.equal(strict.meanRegulationSquaredError, null);
  assert.equal(report.validation.strictPointInTime.folds, 0);
  assert.equal(report.validation.strictPointInTime.status, 'NO_ELIGIBLE_FOLDS');
});

test('every real-data retrospective fold excludes its target and observes the full 48-hour embargo', () => {
  retrospective = walkForwardNhlModel(corpus, { gameType: 2, availabilityMode: 'RETROSPECTIVE_48H_EMBARGO', initialTrainingGames: 3 });
  assert.ok(retrospective.foldCount > 0);
  assert.equal(retrospective.foldCount, retrospective.folds.length);
  assert.equal(retrospective.pointInTimeVerified, false);
  assert.equal(retrospective.synthetic, false);
  assert.equal(retrospective.readyForFormal, false);
  assert.equal(retrospective.verifiedTai888PayoffBacktest, false);
  assert.equal(retrospective.historicalInjurySnapshotBacktest, false);
  assert.equal(new Set(retrospective.folds.map(fold => fold.targetGameId)).size, retrospective.foldCount);
  assert.equal(report.validation.retrospective.folds, retrospective.foldCount);
  assert.equal(report.validation.retrospective.pointInTimeVerified, false);
  for (const fold of retrospective.folds) {
    const cutoff = Date.parse(fold.asOf);
    assert.equal(cutoff, Date.parse(byId.get(fold.targetGameId).startTimeUTC));
    assert.ok(fold.trainingGameIds.length >= 3);
    assert.ok(!fold.trainingGameIds.includes(fold.targetGameId));
    for (const trainingId of fold.trainingGameIds) {
      const training = byId.get(trainingId);
      assert.ok(training, `Unknown training event: ${trainingId}`);
      assert.equal(training.gameType, 2);
      assert.ok(Date.parse(training.startTimeUTC) < cutoff);
      assert.ok(Date.parse(training.startTimeUTC) + EMBARGO_MS <= cutoff,
        `48-hour availability embargo failed: ${trainingId} -> ${fold.targetGameId}`);
    }
  }
});

test('reported held-out Brier values equal independent probability-mass calculations on actual score paths', () => {
  for (const fold of retrospective.folds) {
    const artifact = fitNhlModel(fold.trainingGameIds.map(id => byId.get(id)), {
      gameType: 2, trainingCutoff: fold.asOf, availabilityMode: 'RETROSPECTIVE_48H_EMBARGO',
    });
    const distribution = predictNhlDistribution(artifact, byId.get(fold.targetGameId), { asOf: fold.asOf, scenarioCount: 1 });
    const mass = new Map();
    for (const scenario of distribution.scenarios) {
      for (const path of scenario.paths) {
        assert.ok(![fold.targetGameId].includes(path.sourceGameId));
        const key = `${path.regulation.away}:${path.regulation.home}`;
        mass.set(key, (mass.get(key) || 0) + scenario.weight * path.probability);
      }
    }
    close([...mass.values()].reduce((sum, value) => sum + value, 0), 1, 'Probability mass');
    const observed = byId.get(fold.targetGameId).regulation;
    const observedKey = `${observed.awayGoals}:${observed.homeGoals}`;
    const brier = 1 - 2 * (mass.get(observedKey) || 0) + [...mass.values()].reduce((sum, probability) => sum + probability ** 2, 0);
    close(fold.regulationBrier, brier, `Brier: ${fold.targetGameId}`);
    assert.ok(brier >= 0 && brier <= 2 + 1e-10);
    assert.equal(artifact.calibrationEvidence.payoffCalibrationAvailable, false);
    assert.equal(distribution.readyForFormal, false);
  }
  close(report.validation.retrospective.regulationBrier,
    retrospective.folds.reduce((sum, fold) => sum + fold.regulationBrier, 0) / retrospective.foldCount, 'Report mean Brier');
});

test('explicit preseason counterexample cannot enter training built from the real regular-season corpus', () => {
  const trainingCutoff = new Date(Math.max(...corpus.map(game => Date.parse(game.startTimeUTC))) + EMBARGO_MS + 1).toISOString();
  const options = { gameType: 2, trainingCutoff, availabilityMode: 'RETROSPECTIVE_48H_EMBARGO' };
  const regular = fitNhlModel(corpus, options);
  // This single mutated copy tests isolation only; it is not added to the actual
  // corpus and must never be reported as a retrieved preseason game.
  const preseasonCounterexample = { ...structuredClone(corpus[0]), gameId: 'synthetic-preseason-isolation', gameType: 1,
    synthetic: true, sourceType: 'SYNTHETIC_FIXTURE', source: { provider: 'TEST', url: 'fixture://nhl-preseason-isolation', fetchedAt: corpus[0].source.fetchedAt } };
  const mixed = fitNhlModel([...corpus, preseasonCounterexample], options);
  assert.deepEqual(mixed.trainingGameIds, regular.trainingGameIds);
  assert.equal(mixed.trainingSourceHash, regular.trainingSourceHash);
  assert.equal(mixed.excludedPreseasonCount, 1);
  assert.equal(mixed.synthetic, false);
  assert.ok(mixed.observations.every(row => row.record.gameType === 2));
  assert.throws(() => fitNhlModel(corpus, { ...options, gameType: 1 }), error => error.code === 'NHL_PRESEASON_TRAINING_EXCLUDED');

  const poisoned = corpus.map((game, index) => index === 0 ? { ...structuredClone(game), synthetic: true, sourceType: 'SYNTHETIC_FIXTURE' } : game);
  assert.throws(() => fitNhlModel(poisoned, options), error => error.code === 'NHL_SYNTHETIC_TRAINING_NOT_AUTHORIZED');
  assert.throws(() => walkForwardNhlModel(poisoned, { availabilityMode: 'RETROSPECTIVE_48H_EMBARGO' }),
    error => error.code === 'NHL_SYNTHETIC_TRAINING_NOT_AUTHORIZED');
});

console.log(`NHL actual historical engineering corpus: ${checks} groups PASS; ${corpus.length} official samples, ${retrospective.foldCount} retrospective score folds, 0 strict-PIT folds. No Tai888 payoff/ROI or production-calibration claim.`);
