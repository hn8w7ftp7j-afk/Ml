import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fitScoreModel, validateTrainingRows, soccerObservationWeights } from '../lib/soccer/score-model.js';
import { fitHalfTimeModel } from '../lib/soccer/half-time-model.js';
import { soccerResearchArtifacts } from '../lib/soccer/research-frozen.js';
import { soccerHalfTimeArtifacts } from '../lib/soccer/half-time-frozen.js';
import { soccerScenarioArtifacts } from '../lib/soccer/scenario-frozen.js';
import { buildSoccerScenarioResearch, soccerScenarioHash, validateSoccerScenarioArtifact } from '../lib/soccer/scenario-research.js';
import { soccerDate } from '../lib/soccer/contracts.js';

const load = file => JSON.parse(gunzipSync(fs.readFileSync(file)).toString());
const baseline = soccerResearchArtifacts(), htBaseline = soccerHalfTimeArtifacts(), artifact = soccerScenarioArtifacts();
assert.equal(validateSoccerScenarioArtifact(artifact), true);
assert.equal(artifact.formalEnabled, false); assert.equal(artifact.sourcePublicationVerified, false);
assert.equal(artifact.pointInTimeAvailabilityVerified, false);
assert.match(artifact.protocol.replicateWeights, /not source-observed scenario probabilities/);
assert.match(artifact.protocol.diagnosticPolicy, /not a new untouched OOS test/);
const fileDigests = {};
for (const league of ['epl', 'ucl']) {
  const config = artifact.leagues[league], original = load(`research/soccer/${league}-history.json.gz`);
  const enrichedHistory = load(`research/soccer/half-time-${league}-history.json.gz`), enrichedMap = new Map(enrichedHistory.rows.map(row => [row.eventId, row]));
  const rows = validateTrainingRows(original.rows.filter(row => Date.parse(row.startTime) + 86400000 < Date.parse(config.cutoff)), league, config.cutoff);
  const enriched = rows.map(row => enrichedMap.get(row.eventId) || row), immutable = JSON.stringify({ rows, enriched });
  assert.equal(rows.length, baseline.leagues[league].liveModel.trainingCount);
  const plain = fitScoreModel(rows, config.fitOptions), plainHT = fitHalfTimeModel(enriched, config.halfTimeFitOptions);
  assert.deepEqual(plain, baseline.leagues[league].liveModel, 'default FT output remains byte-for-byte reproducible');
  assert.deepEqual(plainHT, htBaseline.leagues[league].liveModel, 'default HT output remains byte-for-byte reproducible');
  const allOnes = Object.fromEntries(rows.map(row => [row.eventId, 1]));
  const { observationWeighting: ftReceipt, ...onesFT } = fitScoreModel(rows, { ...config.fitOptions, observationWeights: allOnes });
  const { observationWeighting: htReceipt, ...onesHT } = fitHalfTimeModel(enriched, { ...config.halfTimeFitOptions, observationWeights: allOnes });
  assert.deepEqual(onesFT, plain); assert.deepEqual(onesHT, plainHT); assert.deepEqual(ftReceipt, htReceipt);
  assert.equal(ftReceipt.count, rows.length);

  for (const replicate of config.replicates) {
    // Independent regeneration from the disclosed hash-word uniform transform.
    // Neither the original goals nor source receipts participate in the draw.
    const weights = Object.fromEntries(rows.map(row => {
      const digest = createHash('sha256').update(JSON.stringify([artifact.protocol.seed, league, replicate.index, row.eventId])).digest('hex');
      const uniform = (Number.parseInt(digest.slice(0, 8), 16) + .5) / 2 ** 32;
      return [row.eventId, -Math.log(uniform)];
    }));
    assert.deepEqual(soccerObservationWeights(rows, weights).receipt, replicate.observationWeighting);
    for (const period of ['FT', 'HT']) if (replicate[period].model) {
      assert.equal(soccerScenarioHash(replicate[period].model), replicate[period].modelHash);
      assert.deepEqual(replicate[period].model.observationWeighting, replicate.observationWeighting);
      assert.equal(replicate[period].model.trainingHash, period === 'FT' ? plain.trainingHash : plainHT.trainingHash);
    }
    if (replicate.index === 0) {
      const ft = fitScoreModel(rows, { ...config.fitOptions, observationWeights: weights });
      const ht = fitHalfTimeModel(enriched, { ...config.halfTimeFitOptions, observationWeights: weights });
      assert.deepEqual(ft, replicate.FT.model, 'actual retained weighted FT fit reproduces frozen coefficients');
      assert.deepEqual(ht, replicate.HT.model, 'actual retained weighted HT exposure fit reproduces frozen shares');
      assert.notEqual(ft.intercept, plain.intercept); assert.notDeepEqual(ht.shares, plainHT.shares);
    }
  }
  for (const [period, manifest] of Object.entries(config.sources)) {
    const digest = createHash('sha256').update(fs.readFileSync(manifest.file)).digest('hex');
    fileDigests[manifest.file] = digest; assert.equal(digest, manifest.fileSha256);
    assert.equal(manifest.sourcePublishedAt, null); assert.ok(manifest.missingPublicationTimeCount > 0);
    assert.equal(manifest.rowsHash, soccerScenarioHash(period === 'FT' ? rows : enriched));
    assert.equal(manifest.sourceRowsHash, soccerScenarioHash((period === 'FT' ? rows : enriched)
      .map(row => ({ eventId: row.eventId, source: period === 'FT' ? row.source : row.halfTime?.source ?? null }))));
  }
  assert.equal(JSON.stringify({ rows, enriched }), immutable, 'fitting must not alter original IDs, goals, sources or timestamps');
  const bad = { ...allOnes }; delete bad[rows[0].eventId];
  for (const weights of [bad, { ...allOnes, 999999999: 1 }, { ...allOnes, [rows[0].eventId]: 0 },
    { ...allOnes, [rows[0].eventId]: -1 }, { ...allOnes, [rows[0].eventId]: NaN }]) {
    assert.throws(() => fitScoreModel(rows, { ...config.fitOptions, observationWeights: weights }), /OBSERVATION_WEIGHTS/);
    assert.throws(() => fitHalfTimeModel(enriched, { ...config.halfTimeFitOptions, observationWeights: weights }), /OBSERVATION_WEIGHTS/);
  }
  for (const extreme of [Number.MIN_VALUE, Number.MAX_VALUE]) {
    const weights = Object.fromEntries(rows.map(row => [row.eventId, extreme]));
    assert.throws(() => fitScoreModel(rows, { ...config.fitOptions, observationWeights: weights }), /WEIGHT_NUMERICS/);
    assert.throws(() => fitHalfTimeModel(enriched, { ...config.halfTimeFitOptions, observationWeights: weights }), /WEIGHT_NUMERICS/);
  }
  console.log(`PASS ${league} actual retained default/weighted FT and HT fits, shared deterministic match draws, original hashes/denominators and unchanged source bytes`);
}

const now = Date.parse(artifact.createdAt) + 1000, startTime = new Date(now + 86400000).toISOString();
const gameFor = league => ({ id: `soccer:${league}:999001`, sourceId: '999001', league, date: soccerDate(startTime), startTime,
  status: 'scheduled', neutralSite: false, home: { sourceId: league === 'epl' ? '359' : '83' }, away: { sourceId: league === 'epl' ? '364' : '160' } });
for (const league of ['epl', 'ucl']) {
  const game = gameFor(league), result = buildSoccerScenarioResearch({ game, now });
  assert.equal(result.status, 'RESEARCH_ONLY'); assert.equal(result.formalEnabled, false);
  assert.equal(result.artifactHash, artifact.contentHash);
  assert.equal(result.trainingCutoff, baseline.leagues[league].liveModel.cutoff);
  for (const period of ['FT', 'HT']) {
    const p = result.periods[period]; assert.equal(p.count + p.failed, p.attempted);
    assert.ok(p.count > 0); assert.equal(p.attempted, artifact.protocol.replicatesPerLeague);
    assert.equal(p.successfulWeight + p.failedWeight, 1); assert.equal(p.weightsRenormalized, false);
    assert.equal(p.scenariosHash, soccerScenarioHash(p.scenarios));
    assert.ok(p.parameterRanges.homeRate.min < p.parameterRanges.homeRate.max);
    for (const scenario of p.scenarios) {
      assert.equal(scenario.league, league); assert.equal(scenario.gameId, game.id); assert.equal(scenario.period, period);
      assert.equal(scenario.distribution.gameId, game.id); assert.equal(scenario.distribution.league, league);
      assert.equal(scenario.distribution.period, period === 'FT' ? 'REGULATION_FT' : 'REGULATION_HT');
      assert.equal(scenario.trainingHash, period === 'FT' ? artifact.leagues[league].trainingHash : artifact.leagues[league].halfTimeTrainingHash);
      assert.equal(scenario.sourceEvidence.sourcePublishedAt, null); assert.equal(scenario.formalEnabled, false);
      assert.ok(Math.abs(scenario.distribution.retainedMass + scenario.distribution.tailMass - 1) < 1e-10);
    }
  }
  const htById = new Map(result.periods.HT.scenarios.map(scenario => [scenario.id, scenario]));
  for (const ft of result.periods.FT.scenarios) if (htById.has(ft.id)) {
    assert.equal(htById.get(ft.id).observationWeightsHash, ft.observationWeightsHash);
    assert.equal(htById.get(ft.id).fullTimeModelHash, ft.modelHash);
  }
  const alteredLabels = buildSoccerScenarioResearch({ game: { ...game, homeGoals: 30, awayGoals: 0, finalScore: '30-0' }, now });
  assert.equal(alteredLabels.periods.FT.scenariosHash, result.periods.FT.scenariosHash, 'runtime cannot refit on request labels');
  assert.equal(alteredLabels.periods.HT.scenariosHash, result.periods.HT.scenariosHash);
  const unknown = buildSoccerScenarioResearch({ game: { ...game, home: { sourceId: '99999999' } }, now });
  assert.equal(unknown.periods.FT.count, 0); assert.equal(unknown.periods.FT.failed, unknown.periods.FT.attempted);
  assert.equal(unknown.periods.FT.failedWeight, 1); assert.equal(unknown.periods.FT.successfulWeight, 0);
}
assert.equal(buildSoccerScenarioResearch({ game: gameFor('epl'), now: Date.parse(artifact.createdAt) - 1 }).reason,
  'SOCCER_SCENARIO_ARTIFACT_NOT_AVAILABLE_AT_CUTOFF');
assert.equal(buildSoccerScenarioResearch({ game: { ...gameFor('epl'), status: 'final' }, now }).reason, 'SOCCER_SCENARIO_NOT_PREMATCH');
assert.equal(buildSoccerScenarioResearch({ game: { ...gameFor('epl'), league: 'nba' }, now }).reason, 'SOCCER_SCENARIO_GAME_IDENTITY_INVALID');
for (const alter of [a => { a.leagues.epl.replicates[0].FT.model.intercept += .1; },
  a => { a.leagues.epl.sources.FT.sourceRowsHash = 'a'.repeat(64); },
  a => { a.protocol.seed++; }, a => { a.createdAt = new Date(now + 1000).toISOString(); }]) {
  const changed = structuredClone(artifact); alter(changed);
  assert.throws(() => validateSoccerScenarioArtifact(changed), /HASH_MISMATCH/);
  const { contentHash: _hash, ...body } = changed; changed.contentHash = soccerScenarioHash(body);
  assert.throws(() => validateSoccerScenarioArtifact(changed), /HASH_MISMATCH/, 'rehashing caller data cannot replace the trusted frozen artifact');
}
const mutable = soccerScenarioArtifacts(); mutable.leagues.epl.replicates.length = 0;
assert.equal(soccerScenarioArtifacts().leagues.epl.replicates.length, artifact.protocol.replicatesPerLeague);
console.log('PASS frozen-only runtime: true FT/HT scenario distributions, no request-label refit, exact league/game scope, unknown-team denominator, availability cutoff and tamper/rehash isolation');

// Isolated test artifact: exercise a failed fit without altering the production
// frozen source or dropping its original Monte Carlo denominator.
const failedArtifact = structuredClone(artifact);
failedArtifact.leagues.epl.replicates[0].FT = { status: 'FAILED', reason: 'TEST_FIT_FAILURE', model: null, modelHash: null };
failedArtifact.leagues.epl.fitted.FT--; failedArtifact.leagues.epl.fitted.HT--;
const { contentHash: _failedHash, ...failedBody } = failedArtifact; failedArtifact.contentHash = soccerScenarioHash(failedBody);
const moduleUrl = new URL('../lib/soccer/scenario-research.js', import.meta.url);
let moduleSource = fs.readFileSync(moduleUrl, 'utf8').replace("import { soccerScenarioArtifacts } from './scenario-frozen.js';",
  `const soccerScenarioArtifacts = () => structuredClone(${JSON.stringify(failedArtifact)});`);
moduleSource = moduleSource.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\2/g,
  (_match, prefix, separator, specifier) => `${prefix}${separator}${new URL(specifier, moduleUrl).href}${separator}`);
const isolated = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
const partial = isolated.buildSoccerScenarioResearch({ game: gameFor('epl'), now });
for (const period of ['FT', 'HT']) {
  const p = partial.periods[period]; assert.equal(p.count, 15); assert.equal(p.failed, 1); assert.equal(p.attempted, 16);
  assert.equal(p.successfulWeight, 15 / 16); assert.equal(p.failedWeight, 1 / 16);
  assert.equal(p.failedReplicates[0].reason, 'TEST_FIT_FAILURE'); assert.equal(p.weightsRenormalized, false);
  assert.ok(p.scenarios.every(scenario => scenario.weight === 1 / 16));
}
assert.match(execFileSync(process.execPath, ['scripts/soccer-scenario-build.mjs', '--check'], { encoding: 'utf8' }), /PASS retained source bytes/);
for (const [file, digest] of Object.entries(fileDigests))
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), digest);
console.log('PASS failed replicate retained in both FT/HT denominators with unchanged equal algorithmic weights; actual artifact/source checks pass without formal acceptance or confidence claims');
