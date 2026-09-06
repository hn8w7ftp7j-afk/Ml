import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { extractNhlShotResearch, fitNhlShotResearch, predictNhlShotResearch, chronologicalNhlShotValidation, compactNhlShotResearchEvidence,
  freezeNhlShotResearchArtifacts, scoreNhlObservedGameResearch, NHL_SHOT_RESEARCH_SCOPE } from '../lib/nhl/shot-research.js';
import { nhlShotResearchEvidence } from '../lib/nhl/shot-research-evidence.js';
import { nhlFrozenShotResearchArtifacts } from '../lib/nhl/shot-research-frozen.js';
import { readNhlShotCheckpoint } from '../lib/nhl/shot-research-archive.js';
import { fileURLToPath } from 'node:url';

const archiveDirectory = fileURLToPath(new URL('./fixtures/nhl/xg-research', import.meta.url));
const fixture = name => /^xg-research\/pbp-\d{10}\.json$/.test(name)
  ? readNhlShotCheckpoint(name.match(/\d{10}/)[0], { directory: archiveDirectory })
  : JSON.parse(fs.readFileSync(new URL(`./fixtures/nhl/${name}`, import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const manifest = fixture('observed-report-provenance.json');
const pbp = fixture('pbp-2023020001.json');
const first = manifest.files.find(row => row.file === 'pbp-2023020001.json');
const source = { provider: 'NHL', url: first.url, fetchedAt: first.fetchedAt, contentHash: first.contentHash };
const extract = (payload = pbp, options = {}) => extractNhlShotResearch(payload, { source: { ...source, contentHash: digest(payload) }, ...options });
const dataset = extract();
const ids = ['2023020002', '2023020003', '2023020030', '2023020069', '2023020204'];
const datasets = [dataset, ...ids.map(id => { const response = fixture(`xg-research/pbp-${id}.json`); return extractNhlShotResearch(response.data, { source: response.source, expectedGame: { gameId: id } }); })];
const asOf = '2023-11-10T00:00:00Z';
let checks = 0; const test = (name, run) => { run(); checks += 1; console.log(`PASS ${name}`); };
const clone = value => structuredClone(value);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('repaired provenance parses and verifies both actually re-fetched official JSON responses', () => {
  assert.equal(manifest.originalAcquisitionTimestampRecoverable, false);
  assert.equal(manifest.pregamePointInTime, false);
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(new URL(`./fixtures/nhl/${file.file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(digest(JSON.parse(bytes)), file.contentHash);
    assert.equal(file.officialPayloadReverified, true);
    assert.equal(file.sourcePublishedAt, null);
    assert.ok(Date.parse(file.fetchedAt) > Date.parse(pbp.startTimeUTC));
  }
});

test('actual official PBP isolates unblocked5v5/PP/PK/empty-net and penalty-shot observations', () => {
  assert.equal(dataset.ok, true); assert.equal(dataset.rows.length, 95);
  const counts = Object.fromEntries([...new Set(dataset.rows.map(row => row.strength))].map(strength => [strength, dataset.rows.filter(row => row.strength === strength).length]));
  assert.deepEqual(counts, { '5V5': 57, PK: 3, PP: 24, EXTRA_ATTACKER_OWN_EMPTY_NET: 10, OPPONENT_EMPTY_NET: 1 });
  assert.equal(dataset.exclusions.BLOCKED_ATTEMPT_NOT_MODEL_DENOMINATOR, 30);
  assert.equal(dataset.exclusions.PENALTY_SHOT_OR_NONSTANDARD, 1);
  assert.equal(dataset.highDangerDefinition, null); assert.equal(dataset.productionCalibrated, false);
  assert.equal(dataset.scope, NHL_SHOT_RESEARCH_SCOPE);
});

test('attack direction changes by period and side, not absolute x coordinate', () => {
  const firstShot = dataset.rows.find(row => row.eventId === 63);
  close(firstShot.features.distanceFeet, Math.hypot(89 - 58, -25));
  const awayPeriod2 = dataset.rows.find(row => row.eventId === 165);
  close(awayPeriod2.features.distanceFeet, Math.hypot(89 - 81, 1));
  const awayPeriod3 = dataset.rows.find(row => row.eventId === 740);
  close(awayPeriod3.features.distanceFeet, Math.hypot(89 - 81, 4));
  const ownZone = clone(pbp); ownZone.plays.find(row => row.eventId === 63).details.xCoord = -58;
  assert.ok(extract(ownZone).rows.find(row => row.eventId === 63).features.distanceFeet > 140);
});

test('goal label changes never alter the predictors; post-shot score/assists/SOG/reason are excluded', () => {
  const mutated = clone(pbp); const event = mutated.plays.find(row => row.eventId === 63);
  event.typeDescKey = 'goal'; event.typeCode = 505; event.details.scoringPlayerId = event.details.shootingPlayerId;
  event.details.homeScore = 99; event.details.homeSOG = 9999; event.details.assist1PlayerId = 123;
  event.details.reason = 'post-outcome-information';
  mutated.homeTeam.score += 1;
  const result = extract(mutated);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows.find(row => row.eventId === 63).features, dataset.rows.find(row => row.eventId === 63).features);
  assert.equal(result.rows.find(row => row.eventId === 63).label.goal, 1);
  for (const row of dataset.rows) assert.deepEqual(Object.keys(row.features).sort(), ['angleRadians', 'behindGoalLine', 'distanceFeet', 'shotType']);
});

test('empty or truncated completed PBP cannot become a valid training game', () => {
  const empty = clone(pbp); empty.plays = []; empty.rosterSpots = [];
  assert.equal(extract(empty).code, 'NHL_SHOT_FINAL_EVENTS_MISSING');
  const truncated = clone(pbp); truncated.plays.splice(truncated.plays.findIndex(row => row.typeDescKey === 'goal'), 1);
  assert.equal(extract(truncated).code, 'NHL_SHOT_FINAL_EVENT_TOTALS_MISMATCH');
  const missingSog = clone(pbp); missingSog.plays.splice(missingSog.plays.findIndex(row => row.typeDescKey === 'shot-on-goal'), 1);
  assert.equal(extract(missingSog).code, 'NHL_SHOT_FINAL_EVENT_TOTALS_MISMATCH');
});

test('source hash, game, team, shooter, goalie and roster conflicts fail closed', () => {
  assert.equal(extractNhlShotResearch(pbp, { source: { ...source, contentHash: '0'.repeat(64) } }).code, 'NHL_SHOT_SOURCE_UNVERIFIED');
  assert.equal(extract(pbp, { expectedGame: { gameId: '2023020002' } }).ok, false);
  for (const [field, value, code] of [['eventOwnerTeamId', 99, 'NHL_SHOT_TEAM_IDENTITY_INVALID'], ['shootingPlayerId', 8477424, 'NHL_SHOT_PLAYER_IDENTITY_INVALID'], ['goalieInNetId', 8477992, 'NHL_SHOT_GOALIE_IDENTITY_INVALID']]) {
    const mutated = clone(pbp); mutated.plays.find(row => row.eventId === 63).details[field] = value;
    const result = extract(mutated); assert.equal(result.code, code); assert.deepEqual(result.rows, []);
  }
  const duplicate = clone(pbp); duplicate.rosterSpots.push(clone(duplicate.rosterSpots[0]));
  assert.equal(extract(duplicate).code, 'NHL_SHOT_ROSTER_IDENTITY_CONFLICT');
});

test('goalies remain valid shooters; no skater-only identity assumption discards goalie shots', () => {
  const mutated = clone(pbp); mutated.plays.find(row => row.eventId === 63).details.shootingPlayerId = 8477992;
  assert.equal(extract(mutated).ok, true);
});

test('duplicate observations deduplicate; conflicting event revisions block the entire game', () => {
  const duplicate = clone(pbp); duplicate.plays.push(clone(duplicate.plays.find(row => row.eventId === 63)));
  assert.deepEqual(extract(duplicate).rows, dataset.rows);
  duplicate.plays.at(-1).details.xCoord += 1;
  assert.equal(extract(duplicate).code, 'NHL_SHOT_EVENT_REVISION_CONFLICT');
});

test('missing coordinates/direction are coverage warnings, not guessed distances or zero xG', () => {
  for (const field of ['xCoord', 'yCoord']) {
    const mutated = clone(pbp); mutated.plays.find(row => row.eventId === 63).details[field] = null;
    const result = extract(mutated); assert.equal(result.status, 'WARNING'); assert.equal(result.rows.length, dataset.rows.length - 1);
    assert.equal(result.exclusions.SHOT_COORDINATES_MISSING_OR_OUTSIDE_RINK, 1);
  }
  const mutated = clone(pbp); delete mutated.plays.find(row => row.eventId === 63).homeTeamDefendingSide;
  assert.equal(extract(mutated).exclusions.ATTACK_DIRECTION_UNVERIFIED, 1);
});

test('regular, OT, shootout and preseason identities remain isolated', () => {
  const so = datasets.find(row => row.game.gameId === '2023020030');
  assert.ok(so.exclusions.SHOOTOUT > 0);
  assert.ok(so.rows.every(row => row.periodType !== 'SO'));
  assert.ok(datasets.find(row => row.game.gameId === '2023020069').rows.some(row => row.periodType === 'OT'));
  const mutated = clone(pbp); mutated.gameType = 1; mutated.id = 2023010001;
  const preseason = extract(mutated, { source: { ...source, url: 'https://api-web.nhle.com/v1/gamecenter/2023010001/play-by-play', contentHash: digest(mutated) } });
  assert.equal(preseason.ok, true);
  assert.deepEqual(fitNhlShotResearch([...datasets, preseason], { asOf }).trainingGameIds, fitNhlShotResearch(datasets, { asOf }).trainingGameIds);
  assert.throws(() => fitNhlShotResearch(datasets, { asOf, gameType: 1 }), error => error.code === 'NHL_SHOT_FIT_OPTIONS_INVALID');
});

let model;
test('actual multi-game logistic fit converges with disclosed L2 and no probability cap', () => {
  assert.ok(datasets.every(row => row.ok));
  model = fitNhlShotResearch(datasets, { asOf });
  assert.equal(model.status, 'RESEARCH_FIT_CONVERGED');
  assert.equal(model.l2, 1); assert.equal(model.productionCalibrated, false); assert.equal(model.pregameModel, false);
  assert.ok(model.trainingShots > 300); assert.ok(model.coefficients.every(Number.isFinite));
  for (const row of dataset.rows.filter(row => row.strength === '5V5')) {
    const predicted = predictNhlShotResearch(model, row); assert.ok(predicted.probability > 0 && predicted.probability < 1);
    const noLabel = clone(row); delete noLabel.label;
    assert.deepEqual(predictNhlShotResearch(model, noLabel), predicted);
  }
  assert.equal(fitNhlShotResearch([dataset], { asOf }).status, 'INSUFFICIENT_TRAINING_VARIATION');
});

test('prediction boundary rejects invalid physical values and unseen categories without fallback probability', () => {
  const row = dataset.rows.find(value => value.strength === '5V5');
  for (const [key, value] of [['distanceFeet', -1], ['angleRadians', Math.PI + 1], ['behindGoalLine', 1], ['distanceFeet', NaN]]) {
    const mutated = clone(row); mutated.features[key] = value;
    assert.throws(() => predictNhlShotResearch(model, mutated), error => error.code === 'NHL_SHOT_PREDICTION_FEATURE_INVALID');
  }
  const poisoned = clone(row); poisoned.features.goal = 1;
  assert.throws(() => predictNhlShotResearch(model, poisoned), error => error.code === 'NHL_SHOT_PREDICTION_SCOPE_INVALID');
  const unseen = clone(row); unseen.features.shotType = 'unseen-shot';
  assert.equal(predictNhlShotResearch(model, unseen).probability, null);
});

test('dataset integrity checks cannot be bypassed by recomputing rowHash after a team/goalie mutation', () => {
  for (const [key, value] of [['teamId', 99], ['opponentId', 14], ['shooterId', 123], ['strength', 'MLB'], ['goalieId', 8477992]]) {
    const bad = clone(dataset); bad.rows[0][key] = value; bad.rowHash = digest(bad.rows);
    assert.throws(() => fitNhlShotResearch([bad], { asOf }), /NHL_SHOT_DATASET_/);
  }
  const badSource = clone(dataset); badSource.source.url = 'https://example.com/fake';
  assert.throws(() => fitNhlShotResearch([badSource], { asOf }), /NHL_SHOT_DATASET_INVALID/);
  assert.throws(() => fitNhlShotResearch([dataset, dataset], { asOf }), /NHL_SHOT_TRAINING_GAME_DUPLICATE/);
});

let report;
test('whole-game chronological OOS observes48h embargo and preserves heldout baseline comparisons', () => {
  report = chronologicalNhlShotValidation(datasets);
  assert.equal(report.foldCount, 3); assert.equal(report.evaluatedShots, 196);
  assert.equal(report.pointInTimeVerified, false); assert.equal(report.productionCalibrated, false);
  const byId = new Map(datasets.map(row => [row.game.gameId, row]));
  for (const fold of report.folds) {
    assert.ok(!fold.trainingGameIds.includes(fold.gameId));
    for (const gameId of fold.trainingGameIds) assert.ok(Date.parse(byId.get(gameId).game.startTimeUTC) + 48 * 3600_000 <= Date.parse(fold.asOf));
    const fitted = fitNhlShotResearch(fold.trainingGameIds.map(gameId => byId.get(gameId)), { asOf: fold.asOf });
    const tested = byId.get(fold.gameId).rows.filter(row => row.strength === '5V5').map(row => ({ ...predictNhlShotResearch(fitted, row), y: row.label.goal })).filter(row => row.ok);
    close(tested.reduce((sum, row) => sum + (row.probability - row.y) ** 2, 0) / tested.length, fold.brier);
    const [away, home] = fold.teamResearch;
    close(away.researchXGF, home.researchXGA); close(away.researchXGA, home.researchXGF);
    close(away.researchXGFShare + home.researchXGFShare, 1);
  }
  close(report.reliability.reduce((sum, bin) => sum + bin.count, 0), report.evaluatedShots);
  close(report.calibration.expectedCalibrationError, report.reliability.reduce((sum, bin) => sum + (bin.count ? bin.count * Math.abs(bin.meanProbability - bin.observedGoalRate) : 0), 0) / report.evaluatedShots);
  assert.equal(report.calibration.probabilitiesRemapped, false); assert.equal(report.calibration.productionCalibrationCertified, false);
  assert.equal(report.calibration.gameClusterBootstrap.replicates, 500);
  assert.ok(chronologicalNhlShotValidation(datasets, { strength: 'PP' }).brier > chronologicalNhlShotValidation(datasets, { strength: 'PP' }).baselineBrier);
  assert.equal(chronologicalNhlShotValidation(datasets, { strength: 'PK' }).foldCount, 0);
});

test('verified gzip text archives losslessly recover original source payloads without raw fixture files', () => {
  for (const gameId of ids) {
    const archived = readNhlShotCheckpoint(gameId, { directory: archiveDirectory, allowRaw: false });
    assert.deepEqual(archived, fixture(`xg-research/pbp-${gameId}.json`));
    assert.equal(extractNhlShotResearch(archived.data, { source: archived.source }).ok, true);
    archived.data.id = 0;
    assert.equal(String(readNhlShotCheckpoint(gameId, { directory: archiveDirectory, allowRaw: false }).data.id), gameId);
  }
  assert.throws(() => readNhlShotCheckpoint('../secret', { directory: archiveDirectory }), /NHL_SHOT_ARCHIVE_LOOKUP_INVALID/);
});

test('heldout-label counterexample cannot change training coefficients or its own predicted xG', () => {
  const target = datasets.find(row => row.game.gameId === report.folds[0].gameId);
  const before = fitNhlShotResearch(datasets, { asOf: target.game.startTimeUTC });
  const mutated = clone(target); mutated.rows.forEach(row => { row.label.goal = 1 - row.label.goal; }); mutated.rowHash = digest(mutated.rows);
  const after = fitNhlShotResearch(datasets.map(row => row === target ? mutated : row), { asOf: target.game.startTimeUTC });
  assert.deepEqual(before.coefficients, after.coefficients); assert.equal(before.modelHash, after.modelHash);
});

test('timezone-offset counterexample sorts real instants and cannot shorten the48h embargo', () => {
  // Deliberately mutated identities/times are counterexamples only, never added
  // to retained official source checkpoints or production research evidence.
  const times = ['2023-10-01T00:00:00Z', '2023-10-08T10:00:00Z', '2023-10-10T01:00:00-10:00', '2023-10-10T05:00:00Z'];
  const cases = times.map((startTimeUTC, index) => {
    const payload = clone(pbp); payload.id = 2023029001 + index; payload.startTimeUTC = startTimeUTC;
    return extract(payload, { source: { ...source, url: `https://api-web.nhle.com/v1/gamecenter/${payload.id}/play-by-play`, contentHash: digest(payload) } });
  });
  const checked = chronologicalNhlShotValidation(cases, { initialTrainingGames: 2, holdoutBlockGames: 2 });
  assert.equal(checked.foldCount, 0);
  assert.throws(() => fitNhlShotResearch(datasets, { asOf: '2026-02-30T00:00:00Z' }), /NHL_SHOT_FIT_OPTIONS_INVALID/);
});

test('frozen coefficients never train inside a request or score their own training-period games', () => {
  const artifacts = freezeNhlShotResearchArtifacts(datasets, { asOf, generatedAt: source.fetchedAt });
  const historical = scoreNhlObservedGameResearch(artifacts, pbp, { source });
  assert.equal(historical.status, 'NO_ELIGIBLE_FROZEN_MODEL');
  assert.equal(historical.strengths['5V5'].status, 'HISTORICAL_GAME_REQUIRES_HELD_OUT_ARTIFACT');
  // Mutated future-game identity is a unit counterexample, not a live source.
  const future = clone(pbp); future.id = 2024020001; future.season = 20242025; future.startTimeUTC = '2024-10-10T21:30:00Z';
  const futureSource = { ...source, url: 'https://api-web.nhle.com/v1/gamecenter/2024020001/play-by-play', contentHash: digest(future) };
  const scored = scoreNhlObservedGameResearch(artifacts, future, { source: futureSource });
  assert.equal(scored.status, 'OBSERVED_SHOT_RESEARCH'); assert.equal(scored.pregameModel, false); assert.equal(scored.productionCalibrated, false);
  const [away, home] = scored.strengths['5V5'].teamResearch;
  close(away.researchXGF, home.researchXGA); close(away.researchXGA, home.researchXGF);
  close(away.researchXGFShare + home.researchXGFShare, 1);
  assert.equal(scored.strengths.PP.teamResearch, null, 'PP must not be paired with opponent PP as if that were own PK');
  const altered = clone(artifacts); altered.models['5V5'].coefficients[0] += 1;
  assert.equal(scoreNhlObservedGameResearch(altered, future, { source: futureSource }).code, 'NHL_SHOT_FROZEN_ARTIFACT_INVALID');
  assert.deepEqual(nhlFrozenShotResearchArtifacts(), fixture('xg-research/frozen-artifacts.json'));
});

test('bundled production research evidence exactly matches reproducible actual-data report and clones defensively', () => {
  const bundled = nhlShotResearchEvidence(); const stored = fixture('xg-research/research-report.json');
  assert.deepEqual(bundled, compactNhlShotResearchEvidence(stored));
  const expanded = stored.coverage.map(row => {
    if (row.game.gameId === dataset.game.gameId) return dataset;
    const response = fixture(`xg-research/pbp-${row.game.gameId}.json`);
    return extractNhlShotResearch(response.data, { source: response.source, expectedGame: row.game });
  });
  assert.equal(expanded.length, stored.acquiredGames);
  for (const strength of ['5V5', 'PP', 'PK', 'OTHER_EVEN_STRENGTH']) {
    const configured = stored.reports[strength];
    const evaluated = chronologicalNhlShotValidation(expanded, { strength, initialTrainingGames: configured.initialTrainingGames, holdoutBlockGames: configured.holdoutBlockGames });
    assert.deepEqual(configured, evaluated);
    for (const fold of evaluated.folds) {
      assert.ok(Date.parse(fold.trainingCutoff) <= Date.parse(fold.asOf));
      assert.ok(Number.isFinite(fold.trainingGradientInfinityNorm) && fold.trainingGradientInfinityNorm < 1e-8,
        'Every published held-out fold must satisfy the original absolute gradient tolerance');
    }
    assert.equal(evaluated.skipped.filter(row => row.reason === 'FIT_NOT_CONVERGED').length, 0,
      'Retained official corpus reproduces the near-optimum cancellation regression without loosening convergence');
  }
  assert.equal(bundled.productionCalibrated, false); assert.equal(bundled.completeSeasonCoverage, false);
  if (!stored.completeRequestedCoverage) assert.ok(bundled.unavailableCheckpointCount > 0);
  if (bundled.acquisition.providerStopped) assert.ok(bundled.acquisition.failures.some(row => row.code === 'NHL_SOURCE_RATE_LIMITED'));
  assert.ok(bundled.coverage.length <= 10 && bundled.sources.length <= 10);
  assert.ok(Object.values(bundled.reports).every(value => value.folds.length <= 10));
  bundled.reports['5V5'].brier = 999;
  assert.notEqual(nhlShotResearchEvidence().reports['5V5'].brier, 999);
});

console.log(`NHL official shot research: ${checks} groups PASS; ${nhlShotResearchEvidence().acquiredGames} actual PBP games and all retained strength reports reproduced. Not pregame/PIT/production-calibration PASS.`);
