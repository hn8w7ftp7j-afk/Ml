import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fitScoreModel, validateTrainingRows, soccerObservationWeights } from '../lib/soccer/score-model.js';
import { fitHalfTimeModel } from '../lib/soccer/half-time-model.js';
import { soccerResearchArtifacts } from '../lib/soccer/research-frozen.js';
import { soccerHalfTimeArtifacts } from '../lib/soccer/half-time-frozen.js';

const root = 'research/soccer', protocolPath = `${root}/scenario-protocol.json`, artifactPath = `${root}/scenario-artifact.json`;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const fileHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const load = file => JSON.parse(gunzipSync(fs.readFileSync(file)).toString());
const protocol = JSON.parse(fs.readFileSync(protocolPath, 'utf8')), protocolHash = hash(protocol);
const baseline = soccerResearchArtifacts(), halfTime = soccerHalfTimeArtifacts();
const originalFiles = ['epl', 'ucl'].flatMap(league => [`${root}/${league}-history.json.gz`, `${root}/half-time-${league}-history.json.gz`]);
const beforeFiles = Object.fromEntries(originalFiles.map(file => [file, fileHash(file)]));
const drawWeights = (rows, league, replicateIndex) => Object.fromEntries(rows.map(row => {
  const word = createHash('sha256').update(JSON.stringify([protocol.seed, league, replicateIndex, row.eventId])).digest().readUInt32BE(0);
  return [row.eventId, -Math.log((word + .5) / 4294967296)];
}));
function sourceManifest(file, rows, half = false) {
  const observations = rows.map(row => ({ eventId: row.eventId, source: half ? row.halfTime?.source ?? null : row.source }));
  const unique = new Map(observations.filter(row => row.source).map(row => [hash(row.source), row.source]));
  return { file, fileSha256: beforeFiles[file], rowsHash: hash(rows), rowCount: rows.length,
    sourceRowsHash: hash(observations), originalSourceCount: unique.size,
    missingSourceCount: observations.filter(row => !row.source).length,
    missingPublicationTimeCount: observations.filter(row => !row.source?.sourcePublishedAt).length,
    sourcePublishedAt: null, publicationStatus: 'RETROSPECTIVE_PUBLICATION_TIME_UNVERIFIED',
    // Every original receipt remains in the committed gzip. Avoid duplicating
    // thousands of HT receipts inside every runtime scenario.
    sourceReceipts: half ? null : [...unique.values()],
    sourceReceiptLocation: `${file}#rows[].${half ? 'halfTime.source' : 'source'}` };
}
function inputs(league) {
  const ftFile = `${root}/${league}-history.json.gz`, htFile = `${root}/half-time-${league}-history.json.gz`;
  const ft = load(ftFile), ht = load(htFile), current = baseline.leagues[league], currentHT = halfTime.leagues[league];
  assert.equal(current.liveModel.cutoff, currentHT.liveModel.cutoff, 'FT_HT_CUTOFF_MISMATCH');
  const cutoff = current.liveModel.cutoff;
  const retained = validateTrainingRows(ft.rows.filter(row => Date.parse(row.startTime) + protocol.resultLagHours * 3600000 < Date.parse(cutoff)), league, cutoff);
  const byId = new Map(ht.rows.map(row => [row.eventId, row]));
  assert.equal(byId.size, ht.rows.length, 'HT_RETAINED_ID_CONFLICT');
  for (const row of ht.rows) {
    const original = ft.rows.find(value => value.eventId === row.eventId);
    assert.ok(original, 'HT_MATCH_NOT_IN_FT_POPULATION');
    assert.deepEqual({ ...row, halfTime: original.halfTime }, original, 'HT_ENRICHMENT_CHANGED_ORIGINAL_MATCH_OR_SOURCE');
  }
  const enriched = retained.map(row => byId.get(row.eventId) || row);
  const options = { league, cutoff, ...current.selected, maxIterations: protocol.maxIterations, tolerance: protocol.tolerance };
  const htOptions = { league, cutoff, ...currentHT.selected };
  const manifests = { FT: sourceManifest(ftFile, retained), HT: sourceManifest(htFile, enriched, true) };
  return { retained, enriched, current, currentHT, cutoff, options, htOptions, manifests,
    originalPopulation: { fullTimeReceived: ft.rows.length + ft.excluded.length, fullTimeRetained: ft.rows.length,
      fullTimeExcluded: ft.excluded.length, halfTimeReceived: ht.rows.length + ht.excluded.length,
      halfTimeRetained: ht.rows.length, halfTimeExcluded: ht.excluded.length,
      beforeCutoff: retained.length, afterCutoffExcluded: ft.rows.length - retained.length } };
}

if (process.argv.includes('--check')) {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')), { contentHash, ...body } = artifact;
  assert.equal(hash(body), contentHash, 'SCENARIO_ARTIFACT_HASH_MISMATCH');
  assert.equal(artifact.protocolHash, protocolHash, 'SCENARIO_PROTOCOL_CHANGED');
  for (const league of ['epl', 'ucl']) {
    const data = inputs(league), saved = artifact.leagues[league];
    assert.deepEqual(saved.sources, data.manifests, 'SCENARIO_ORIGINAL_SOURCE_MANIFEST_CHANGED');
    assert.equal(saved.baselineModelHash, hash(data.current.liveModel));
    assert.equal(saved.halfTimeBaselineModelHash, hash(data.currentHT.liveModel));
    assert.equal(saved.replicates.length, protocol.replicatesPerLeague);
    for (const replicate of saved.replicates) {
      const weights = drawWeights(data.retained, league, replicate.index);
      assert.deepEqual(replicate.observationWeighting, soccerObservationWeights(data.retained, weights).receipt);
      for (const period of ['FT', 'HT']) if (replicate[period].model)
        assert.equal(replicate[period].modelHash, hash(replicate[period].model));
    }
  }
  console.log('PASS retained source bytes/rows/original receipts, baseline identities, deterministic match draws and all saved replicate model hashes; no refit or statistical acceptance claim');
} else {
  const startedAt = new Date().toISOString(), leagues = {};
  for (const league of ['epl', 'ucl']) {
    const data = inputs(league), { retained, enriched, current, currentHT, options, htOptions } = data;
    // Reproduce both default outputs before adding any research multipliers.
    assert.deepEqual(fitScoreModel(retained, options), current.liveModel, 'DEFAULT_FT_MODEL_CHANGED');
    assert.deepEqual(fitHalfTimeModel(enriched, htOptions), currentHT.liveModel, 'DEFAULT_HT_MODEL_CHANGED');
    const replicates = [];
    for (let index = 0; index < protocol.replicatesPerLeague; index++) {
      const observationWeights = drawWeights(retained, league, index);
      const replicate = { id: `${league}-exp-likelihood-${String(index).padStart(2, '0')}`, index,
        weight: 1 / protocol.replicatesPerLeague,
        observationWeighting: soccerObservationWeights(retained, observationWeights).receipt };
      for (const period of ['FT', 'HT']) {
        try {
          const model = period === 'FT' ? fitScoreModel(retained, { ...options, observationWeights })
            : fitHalfTimeModel(enriched, { ...htOptions, observationWeights });
          const reference = period === 'FT' ? current.liveModel : currentHT.liveModel;
          assert.equal(model.trainingHash, reference.trainingHash, 'REWEIGHTING_CHANGED_ORIGINAL_TRAINING_ROWS');
          assert.deepEqual(model.observationWeighting, replicate.observationWeighting, 'FT_HT_MATCH_DRAWS_DIFFER');
          replicate[period] = { status: period === 'FT' && model.fit.converged !== true ? 'FAILED' : 'FITTED',
            reason: period === 'FT' && model.fit.converged !== true ? 'FIT_NOT_CONVERGED' : null, modelHash: hash(model), model };
        } catch (error) { replicate[period] = { status: 'FAILED', reason: error.message, modelHash: null, model: null }; }
      }
      replicates.push(replicate);
      console.log(JSON.stringify({ league, replicate: index + 1, attempted: protocol.replicatesPerLeague,
        FT: replicate.FT.status, HT: replicate.HT.status, iterations: replicate.FT.model?.fit.iterations,
        weightsHash: replicate.observationWeighting.weightsHash }));
    }
    leagues[league] = { cutoff: data.cutoff, baselineModelHash: hash(current.liveModel),
      halfTimeBaselineModelHash: hash(currentHT.liveModel), trainingHash: current.liveModel.trainingHash,
      halfTimeTrainingHash: currentHT.liveModel.trainingHash, sources: data.manifests,
      originalPopulation: data.originalPopulation, fitOptions: options, halfTimeFitOptions: htOptions,
      attempted: protocol.replicatesPerLeague, replicates,
      fitted: { FT: replicates.filter(rep => rep.FT.status === 'FITTED').length,
        HT: replicates.filter(rep => rep.HT.status === 'FITTED' && rep.FT.status === 'FITTED').length } };
  }
  const artifact = { version: 'SOCCER-SOURCE-TRAINED-SCENARIO-ARTIFACT-v1', createdAt: new Date().toISOString(),
    startedAt, protocol, protocolHash, baselineArtifactHash: baseline.contentHash,
    halfTimeBaselineArtifactHash: halfTime.contentHash, leagues, status: 'RESEARCH_ONLY',
    pointInTimeAvailabilityVerified: false, sourcePublicationVerified: false, formalEnabled: false, executable: false,
    limitations: ['Exponential likelihood reweighting assumes independent matches; schedule/team dependence and model misspecification are not covered',
      'Sixteen equally weighted replicates are a disclosed engineering approximation, not observed scenario probabilities or a verified q10 tail estimate',
      'Original history was backfilled; missing source publication timestamps remain unknown',
      'Fixed baseline cutoff and hyperparameters are reused; default baseline coefficients are unchanged',
      'The reused 2025 development diagnostic is not a new untouched OOS test',
      'No empirical net-return model-error artifact, calibration acceptance, settlement approval, confidence coverage or formal R follows from these scenarios'] };
  artifact.contentHash = hash(artifact);
  assert.deepEqual(Object.fromEntries(originalFiles.map(file => [file, fileHash(file)])), beforeFiles, 'ORIGINAL_HISTORY_FILES_CHANGED');
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  fs.writeFileSync('lib/soccer/scenario-frozen.js', '// Generated offline by scripts/soccer-scenario-build.mjs; research only, no runtime refit.\nconst data=' + JSON.stringify(artifact) + ';\nexport function soccerScenarioArtifacts(){return structuredClone(data);}\n');
  console.log(JSON.stringify({ saved: artifactPath, artifactHash: artifact.contentHash,
    fitted: Object.fromEntries(Object.entries(leagues).map(([league, data]) => [league, data.fitted])), formalEnabled: false }));
}
