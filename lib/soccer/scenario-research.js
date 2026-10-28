import { createHash } from 'node:crypto';
import { soccerScenarioArtifacts } from './scenario-frozen.js';
import { soccerResearchArtifacts } from './research-frozen.js';
import { soccerHalfTimeArtifacts } from './half-time-frozen.js';
import { predictScoreModel } from './score-model.js';
import { predictHalfTimeDistribution } from './half-time-model.js';
import { validSoccerDate, soccerDate } from './contracts.js';

export const SOCCER_SCENARIO_RESEARCH_VERSION = 'SOCCER-SOURCE-TRAINED-SCENARIO-RESEARCH-v1';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const soccerScenarioHash = value => createHash('sha256').update(canonical(value) ?? 'null').digest('hex');
const baseline = soccerResearchArtifacts(), halfTimeBaseline = soccerHalfTimeArtifacts();

export function validateSoccerScenarioArtifact(artifact) {
  const trusted = soccerScenarioArtifacts();
  const { contentHash, ...body } = artifact || {};
  if (artifact?.version !== 'SOCCER-SOURCE-TRAINED-SCENARIO-ARTIFACT-v1' || !sha(contentHash)
      || contentHash !== trusted.contentHash || soccerScenarioHash(body) !== contentHash)
    throw Error('SOCCER_SCENARIO_ARTIFACT_HASH_MISMATCH');
  if (soccerScenarioHash(artifact.protocol) !== artifact.protocolHash || artifact.protocol.formalEnabled !== false
      || artifact.protocol.pointInTimeAvailabilityVerified !== false || artifact.status !== 'RESEARCH_ONLY'
      || artifact.formalEnabled !== false || artifact.executable !== false
      || artifact.pointInTimeAvailabilityVerified !== false || artifact.sourcePublicationVerified !== false)
    throw Error('SOCCER_SCENARIO_PROTOCOL_INVALID');
  if (artifact.baselineArtifactHash !== baseline.contentHash || artifact.halfTimeBaselineArtifactHash !== halfTimeBaseline.contentHash)
    throw Error('SOCCER_SCENARIO_BASELINE_CHANGED');
  for (const league of ['epl', 'ucl']) {
    const data = artifact.leagues?.[league], ft = baseline.leagues[league].liveModel, ht = halfTimeBaseline.leagues[league].liveModel;
    if (!data || data.cutoff !== ft.cutoff || data.cutoff !== ht.cutoff || data.trainingHash !== ft.trainingHash
        || data.halfTimeTrainingHash !== ht.trainingHash || data.baselineModelHash !== soccerScenarioHash(ft)
        || data.halfTimeBaselineModelHash !== soccerScenarioHash(ht) || data.attempted !== artifact.protocol.replicatesPerLeague
        || !Array.isArray(data.replicates) || data.replicates.length !== data.attempted)
      throw Error('SOCCER_SCENARIO_TRAINING_SCOPE_INVALID');
    const seen = new Set();
    for (const replicate of data.replicates) {
      if (seen.has(replicate.id) || replicate.id !== `${league}-exp-likelihood-${String(replicate.index).padStart(2, '0')}`
          || !Number.isInteger(replicate.index) || replicate.index < 0 || replicate.index >= data.attempted
          || replicate.weight !== 1 / data.attempted || !sha(replicate.observationWeighting?.weightsHash)
          || replicate.observationWeighting.count !== ft.trainingCount)
        throw Error('SOCCER_SCENARIO_REPLICATE_SCOPE_INVALID');
      seen.add(replicate.id);
      for (const period of ['FT', 'HT']) {
        const fit = replicate[period], reference = period === 'FT' ? ft : ht;
        if (!['FITTED', 'FAILED'].includes(fit?.status) || fit.status === 'FAILED' && !fit.reason
            || fit.status === 'FITTED' && !fit.model) throw Error('SOCCER_SCENARIO_REPLICATE_STATUS_INVALID');
        if (fit.model && (soccerScenarioHash(fit.model) !== fit.modelHash || fit.model.league !== league
            || fit.model.version !== reference.version || fit.model.period !== reference.period
            || fit.model.cutoff !== data.cutoff || fit.model.trainingHash !== reference.trainingHash
            || fit.model.observationWeighting?.weightsHash !== replicate.observationWeighting.weightsHash
            || fit.model.executable !== false || fit.model.status !== 'RESEARCH_ONLY'))
          throw Error('SOCCER_SCENARIO_MODEL_SCOPE_INVALID');
      }
    }
  }
  return true;
}

function emptyPeriod(reason) {
  return { status: 'NOT_AVAILABLE', count: 0, attempted: 0, failed: 0, scenarios: [], scenariosHash: soccerScenarioHash([]),
    parameterRanges: null, failedReplicates: [], reason, formalEnabled: false };
}
function unavailable(reason, artifact = null) {
  return { status: 'NOT_AVAILABLE', version: SOCCER_SCENARIO_RESEARCH_VERSION,
    artifactHash: artifact?.contentHash || null, protocolHash: artifact?.protocolHash || null,
    periods: { FT: emptyPeriod(reason), HT: emptyPeriod(reason) }, reason, formalEnabled: false, executable: false,
    limitations: artifact?.limitations || ['Source-trained research scenarios are unavailable; no fallback scenarios or error margins are invented'] };
}
function gameValid(game, now) {
  return finite(now) && ['epl', 'ucl'].includes(game?.league) && /^\d{1,16}$/.test(game?.sourceId || '')
    && game.id === `soccer:${game.league}:${game.sourceId}` && validSoccerDate(game.date)
    && game.date === soccerDate(game.startTime) && Number.isFinite(Date.parse(game.startTime))
    && [game.home?.sourceId, game.away?.sourceId].every(id => typeof id === 'string' && /^\d{1,16}$/.test(id))
    && game.home.sourceId !== game.away.sourceId;
}
function ranges(scenarios) {
  if (!scenarios.length) return null;
  const fields = ['homeRate', 'awayRate', 'rho'];
  const result = Object.fromEntries(fields.map(field => {
    const values = scenarios.map(scenario => scenario.distribution[field]);
    return [field, { min: Math.min(...values), max: Math.max(...values) }];
  }));
  if (scenarios.every(scenario => scenario.distribution.shares))
    result.halfTimeShares = Object.fromEntries(['home', 'away'].map(side => {
      const values = scenarios.map(scenario => scenario.distribution.shares[side]);
      return [side, { min: Math.min(...values), max: Math.max(...values) }];
    }));
  return { ...result, interpretation: 'MIN_MAX_OF_SUCCESSFUL_FIXED_REPLICATES_NOT_A_CONFIDENCE_INTERVAL' };
}

// Only frozen, source-trained parameters are read here. No fitting, random draw,
// request-supplied model, empirical-error fallback or formal approval occurs.
export function buildSoccerScenarioResearch({ game, now = Date.now() } = {}) {
  let artifact;
  try { artifact = soccerScenarioArtifacts(); validateSoccerScenarioArtifact(artifact); }
  catch (error) { return unavailable(error.message); }
  if (!gameValid(game, now)) return unavailable('SOCCER_SCENARIO_GAME_IDENTITY_INVALID', artifact);
  if (game.status !== 'scheduled' || Date.parse(game.startTime) <= now)
    return unavailable('SOCCER_SCENARIO_NOT_PREMATCH', artifact);
  if (!(Date.parse(artifact.createdAt) <= now)) return unavailable('SOCCER_SCENARIO_ARTIFACT_NOT_AVAILABLE_AT_CUTOFF', artifact);
  const data = artifact.leagues[game.league];
  if (!(Date.parse(data.cutoff) <= now) || Date.parse(game.startTime) < Date.parse(data.cutoff))
    return unavailable('SOCCER_SCENARIO_MODEL_AFTER_CUTOFF', artifact);
  const periods = {};
  for (const period of ['FT', 'HT']) {
    const scenarios = [], failedReplicates = [];
    for (const replicate of data.replicates) {
      try {
        if (replicate.FT.status !== 'FITTED') throw Error(replicate.FT.reason || 'FT_REPLICATE_UNAVAILABLE');
        if (replicate[period].status !== 'FITTED') throw Error(replicate[period].reason || `${period}_REPLICATE_UNAVAILABLE`);
        const ft = { ...predictScoreModel(replicate.FT.model, { league: game.league, startTime: game.startTime,
          homeId: game.home.sourceId, awayId: game.away.sourceId, neutralSite: game.neutralSite }), league: game.league, gameId: game.id };
        const distribution = period === 'FT' ? ft : { ...predictHalfTimeDistribution(ft, replicate.HT.model,
          { league: game.league, startTime: game.startTime }), gameId: game.id };
        const source = data.sources[period];
        scenarios.push({ id: replicate.id, weight: replicate.weight, league: game.league, gameId: game.id, period,
          modelVersion: distribution.modelVersion, trainingHash: distribution.trainingHash,
          observationWeightsHash: replicate.observationWeighting.weightsHash, modelHash: replicate[period].modelHash,
          fullTimeModelHash: replicate.FT.modelHash, distribution,
          sourceEvidence: { status: 'ORIGINAL_RECEIPTS_RETAINED_PUBLICATION_UNVERIFIED', provider: 'ESPN', sourcePublishedAt: null,
            sourceManifestHash: soccerScenarioHash(source), file: source.file, fileSha256: source.fileSha256,
            sourceRowsHash: source.sourceRowsHash, sourceReceiptLocation: source.sourceReceiptLocation,
            originalSourceCount: source.originalSourceCount, missingPublicationTimeCount: source.missingPublicationTimeCount,
            missingSourceCount: source.missingSourceCount,
            fullTimeSourceManifestHash: soccerScenarioHash(data.sources.FT) },
          weightMeaning: 'EQUAL_ALGORITHMIC_MONTE_CARLO_WEIGHT_NOT_SOURCE_OBSERVED_SCENARIO_PROBABILITY',
          formalEnabled: false, executable: false });
      } catch (error) { failedReplicates.push({ id: replicate.id, weight: replicate.weight, reason: error.message }); }
    }
    periods[period] = { status: scenarios.length === data.attempted ? 'RESEARCH_SCENARIOS_AVAILABLE'
      : scenarios.length ? 'PARTIAL_RESEARCH_SCENARIOS' : 'NOT_APPLICABLE', count: scenarios.length,
      attempted: data.attempted, failed: failedReplicates.length, scenarios, scenariosHash: soccerScenarioHash(scenarios),
      successfulWeight: scenarios.reduce((sum, scenario) => sum + scenario.weight, 0),
      failedWeight: failedReplicates.reduce((sum, scenario) => sum + scenario.weight, 0),
      parameterRanges: ranges(scenarios), failedReplicates, weightsRenormalized: false, formalEnabled: false };
  }
  return { status: periods.FT.count || periods.HT.count ? 'RESEARCH_ONLY' : 'NOT_APPLICABLE',
    version: SOCCER_SCENARIO_RESEARCH_VERSION, artifactHash: artifact.contentHash, protocolHash: artifact.protocolHash,
    createdAt: artifact.createdAt, trainingCutoff: data.cutoff, baselineModelHash: data.baselineModelHash,
    periods, formalEnabled: false, pointInTimeAvailabilityVerified: false, executable: false, limitations: artifact.limitations };
}
