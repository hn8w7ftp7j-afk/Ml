import { createHash } from 'node:crypto';
import { resolveSoccerScoringBundle, soccerScoringBundleContext, soccerScoringBundleHash } from './scoring-bundle.js';
import { adaptSoccerReaderQuote } from './soccer-scoring.js';
import { analyzeSoccerConditionalQuote } from './conditional-analysis.js';
import { buildSoccerScenarioResearch } from './scenario-research.js';
import { soccerResearchArtifacts } from './research-frozen.js';
import { soccerHalfTimeArtifacts } from './half-time-frozen.js';
import { soccerCalibrationShadowArtifacts } from './calibration-frozen.js';
import { predictScoreModel } from './score-model.js';
import { predictHalfTimeDistribution } from './half-time-model.js';

export const SOCCER_SCORING_INPUT_PREPARATION_VERSION = 'SOCCER-BOUND-SCORING-INPUT-PREPARATION-v1';
const periodNames = { FT: 'REGULATION_FT', HT: 'REGULATION_HT' };
const hash = soccerScoringBundleHash;
const serializedHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const detach = value => value == null ? value : JSON.parse(JSON.stringify(value));
const emptyInputs = () => ({ scenarios: null, uncertainty: null, acceptance: null });
const restrictions = { formalEligible: false, formalScoringEnabled: false, executable: false, W: null, R: null, S: null };
const researchProofs = new WeakMap();
const step = (stage, status, reasons = []) => ({ stage, status, reasons });

// A research object is not authority. Rebuild its entire frozen source-trained
// result once per unchanged object/game/cutoff, then bind every quote to it.
// The WeakMap avoids duplicating all 16 distributions for every original quote;
// changing the public object invalidates its process-local preparation cache.
function sourceTrainedResearch(research, game, now) {
  if (!research || typeof research !== 'object') throw Error('SOCCER_INPUT_RESEARCH_SCENARIOS_MISSING');
  const gameHash = hash(game), researchHash = hash(research), cached = researchProofs.get(research);
  if (cached?.gameHash === gameHash && cached.researchHash === researchHash && cached.now === now) return cached;
  const expected = buildSoccerScenarioResearch({ game, now });
  if (expected.status !== 'RESEARCH_ONLY' || expected.formalEnabled !== false || expected.executable !== false
    || !sha(expected.artifactHash) || !sha(expected.protocolHash) || hash(expected) !== researchHash)
    throw Error('SOCCER_INPUT_RESEARCH_SOURCE_OR_SCOPE_MISMATCH');
  const full = soccerResearchArtifacts(), half = soccerHalfTimeArtifacts();
  const { contentHash: fullHash, ...fullBody } = full, { contentHash: halfHash, ...halfBody } = half;
  // These artifact families retain their original serialized hashing rule.
  // Their canonical source reconstruction is also compared below; never accept
  // caller-supplied parameters merely because a public artifact ID matches.
  if (!sha(fullHash) || !sha(halfHash) || serializedHash(fullBody) !== fullHash || serializedHash(halfBody) !== halfHash
    || full.formalScoringEnabled !== false || half.formalScoringEnabled !== false
    || !full.leagues?.[game.league]?.liveModel || !half.leagues?.[game.league]?.liveModel)
    throw Error('SOCCER_INPUT_BASELINE_ARTIFACT_INVALID');
  const model = full.leagues[game.league].liveModel, halfModel = half.leagues[game.league].liveModel;
  const ft = { ...predictScoreModel(model, { league: game.league, startTime: game.startTime,
    homeId: game.home.sourceId, awayId: game.away.sourceId, neutralSite: game.neutralSite }), league: game.league, gameId: game.id };
  const ht = { ...predictHalfTimeDistribution(ft, halfModel, { league: game.league, startTime: game.startTime }),
    league: game.league, gameId: game.id };
  const result = { gameHash, researchHash, now, research, baselineHashes: { FT: hash(ft), HT: hash(ht) },
    modelArtifactHash: fullHash, halfTimeArtifactHash: halfHash, baselineParametersHash: hash(model),
    halfTimeParametersHash: hash(halfModel) };
  researchProofs.set(research, result);
  return result;
}

function originalContextValid({ game, quote, distribution, evidence, now }) {
  return finite(now) && evidence?.ok === true && evidence?.game?.id === game?.id
    && evidence.game.league === game.league && evidence.game.startTime === game.startTime
    && ['home', 'away'].every(side => evidence.game[side]?.sourceId === game?.[side]?.sourceId)
    && evidence.phase === 'PREMATCH_OBSERVATION' && Number.isFinite(instant(evidence.source?.fetchedAt))
    && instant(evidence.source.fetchedAt) <= now && now - instant(evidence.source.fetchedAt) < 180000
    && distribution?.league === game.league && distribution?.gameId === game.id
    && distribution?.period === periodNames[quote?.period] && sha(distribution?.trainingHash)
    && typeof distribution.modelVersion === 'string' && distribution.modelVersion.length > 0
    && Number.isFinite(instant(distribution.trainedThrough)) && instant(distribution.trainedThrough) < now;
}

function validationEvidenceBasis(proof, game, now) {
  let calibration;
  try {
    const frozen = soccerCalibrationShadowArtifacts(game.league), { candidate, plan } = frozen;
    if (!Number.isFinite(instant(candidate.createdAt)) || instant(candidate.createdAt) > now)
      throw Error('SOCCER_INPUT_CALIBRATION_CANDIDATE_UNAVAILABLE_AT_CUTOFF');
    calibration = { status: 'FROZEN_DEVELOPMENT_CANDIDATE_ONLY', candidateHash: candidate.contentHash,
      planHash: plan.contentHash, registryHash: frozen.registryHash, createdAt: candidate.createdAt,
      sourceArchiveHashes: frozen.sourceArchives, modelHash: candidate.modelHash, halfTimeModelHash: candidate.halfTimeModelHash,
      baselineModelBound: candidate.modelHash === proof.baselineParametersHash && candidate.halfTimeModelHash === proof.halfTimeParametersHash,
      developmentGames: candidate.totals.games, developmentWindow: candidate.window,
      prospectiveBeginsStrictlyAfter: plan.beginsStrictlyAfter, excludedDevelopmentAndTrainingGames: plan.usedGamesExcluded.length,
      accepted: false, currentProspectiveValidation: 'NOT_QUERIED_STATIC_ARTIFACT_IS_NOT_CURRENT_DB_EVIDENCE',
      requiredEvidence: ['REPLAYED_IMMUTABLE_PREGAME_AND_OFFICIAL_RESULT_DOCUMENTS_FOR_EXACT_MODEL',
        'UNTOUCHED_WHOLE_GAME_OOS_LOG_LOSS_AND_CALIBRATION_COMPARISON', 'REVIEWED_CALIBRATION_ACCEPTANCE'] };
  } catch {
    calibration = { status: 'NO_SOURCE_BOUND_CALIBRATION_CANDIDATE_AT_CUTOFF', accepted: false };
  }
  return { calibration, totalModelError: { status: 'NO_ACCEPTED_TOTAL_ERROR_VALIDATION_ARTIFACT', value: null,
    unit: 'NET_PROFIT_PER_1_STAKE', validationArtifactHash: null, validationSamples: null,
    scenarioProtocolHash: proof.research.protocolHash, scenarioArtifactHash: proof.research.artifactHash,
    requiredEvidence: ['EXPLICIT_TOTAL_MODEL_ERROR_METHOD_AND_VALIDATION_SOURCE',
      'INDEPENDENT_GAMES_AND_FROZEN_SCOPE_CUTOFF_WITH_TARGET_GAME_APPLICABILITY', 'REVIEWED_UNCERTAINTY_ACCEPTANCE'],
    inadmissibleSubstitutes: ['REALIZED_RETURN_RESIDUAL_OR_SAMPLING_NOISE', 'MODEL_FAMILY_RATE_CONFIDENCE_ONLY'] } };
}

/** Prepare the exact existing scorer arguments at one original quote's cutoff.
 * Only the server registry resolver can supply acceptance or total modelError.
 * Private source-bound research preparation is useful evidence for independent
 * validation, but cannot adopt a model, publish a score, or populate a registry.
 */
export function prepareSoccerScoringInputs({ quote, game, distribution, evidence, scenarioResearch = null,
  now = Date.now() } = {}) {
  const context = soccerScoringBundleContext({ quote, game, distribution, evidence });
  const stages = [], blockers = [], base = { version: SOCCER_SCORING_INPUT_PREPARATION_VERSION,
    ...context, calculatedAt: finite(now) && Math.abs(now) <= 8.64e15 ? new Date(now).toISOString() : null, ...restrictions };
  const adapted = adaptSoccerReaderQuote({ quote, game, now });
  stages.push(step('ORIGINAL_READER_QUOTE', adapted.ok ? 'ADAPTER_VALIDATED' : 'BLOCKED', adapted.reasons || []));
  const contextValid = adapted.ok && originalContextValid({ game, quote, distribution, evidence, now });
  stages.push(step('GAME_MODEL_CUTOFF', contextValid ? 'BOUND' : 'BLOCKED', contextValid ? [] : ['SOCCER_INPUT_CONTEXT_INVALID']));
  // The same resolver is used again by the unchanged scorer. A candidate,
  // serialized receipt, or caller's VERIFIED fields cannot replace that lookup.
  const resolved = resolveSoccerScoringBundle({ quote, game, distribution, evidence, now });
  const inputBundle = resolved.receipt || { version: resolved.version, status: resolved.status,
    code: resolved.code, reasons: [...resolved.reasons] };
  if (!contextValid) {
    blockers.push(...(adapted.reasons || []), 'SOCCER_INPUT_CONTEXT_INVALID');
    return { runtimeInputs: emptyInputs(), inputBundle, preparation: { ...base, status: 'INPUTS_UNAVAILABLE',
      runtimeAuthorityResolved: false, stages, blockers: [...new Set(blockers)], research: null } };
  }
  if (resolved.status === 'AVAILABLE' && resolved.inputs) {
    stages.push(step('SERVER_RUNTIME_INPUTS', 'AUTHORITY_RESOLVED'));
    return { runtimeInputs: detach(resolved.inputs), inputBundle, preparation: { ...base,
      status: 'TRUSTED_RUNTIME_INPUTS_AVAILABLE', runtimeAuthorityResolved: true, stages, blockers: [], research: null,
      inputsHash: resolved.receipt.inputsHash, interpretation: 'REGISTERED_INPUTS_ONLY_FORMAL_EVIDENCE_AND_PUBLICATION_GATES_STILL_APPLY' } };
  }
  stages.push(step('SERVER_RUNTIME_INPUTS', 'BLOCKED', resolved.reasons));
  blockers.push(...resolved.reasons, 'SOCCER_INPUT_MODEL_ACCEPTANCE_REQUIRED', 'SOCCER_INPUT_CALIBRATION_ACCEPTANCE_REQUIRED',
    'SOCCER_INPUT_TOTAL_MODEL_ERROR_VALIDATION_REQUIRED');
  let proof, research, period;
  try {
    research = scenarioResearch || buildSoccerScenarioResearch({ game, now });
    proof = sourceTrainedResearch(research, game, now);
    if (proof.baselineHashes[quote.period] !== hash(distribution)) throw Error('SOCCER_INPUT_BASELINE_DISTRIBUTION_MISMATCH');
    period = research.periods[quote.period];
    if (period?.status !== 'RESEARCH_SCENARIOS_AVAILABLE' || period.failed !== 0 || period.weightsRenormalized !== false
      || !Number.isSafeInteger(period.attempted) || period.attempted < 1 || period.attempted > 1000
      || period.scenarios.length !== period.attempted || period.count !== period.attempted
      || hash(period.scenarios) !== period.scenariosHash) throw Error('SOCCER_INPUT_COMPLETE_SCENARIOS_REQUIRED');
  } catch (error) {
    const code = /^SOCCER_[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'SOCCER_INPUT_RESEARCH_PREPARATION_UNAVAILABLE';
    stages.push(step('SOURCE_TRAINED_CANDIDATE', 'BLOCKED', [code])); blockers.push(code);
    return { runtimeInputs: emptyInputs(), inputBundle, preparation: { ...base, status: 'INPUTS_UNAVAILABLE',
      runtimeAuthorityResolved: false, stages, blockers: [...new Set(blockers)], research: null } };
  }
  const baseline = analyzeSoccerConditionalQuote({ quote, distribution, game, now }), rows = [];
  if (baseline.status !== 'CONDITIONAL_RESEARCH') blockers.push(baseline.reason || 'SOCCER_INPUT_BASELINE_PAYOFF_UNAVAILABLE');
  for (const scenario of period.scenarios) {
    const value = analyzeSoccerConditionalQuote({ quote, distribution: scenario.distribution, game, now });
    rows.push({ id: scenario.id, weight: scenario.weight, distributionHash: hash(scenario.distribution), status: value.status,
      expectedNetReturn: value.status === 'CONDITIONAL_RESEARCH' ? value.exactNetReturn : null,
      netReturnBounds: value.status === 'CONDITIONAL_RESEARCH' ? value.netReturnBounds : null, reason: value.reason || null });
  }
  const payoffComplete = baseline.status === 'CONDITIONAL_RESEARCH' && rows.every(row => row.status === 'CONDITIONAL_RESEARCH'
    && [row.netReturnBounds?.lower, row.netReturnBounds?.upper].every(finite) && row.netReturnBounds.lower <= row.netReturnBounds.upper);
  if (!payoffComplete) blockers.push('SOCCER_INPUT_SCENARIO_PAYOFF_INCOMPLETE');
  stages.push(step('SOURCE_TRAINED_CANDIDATE', 'RESEARCH_BOUND'));
  stages.push(step('PER_SCENARIO_PAYOFF', payoffComplete ? 'CONDITIONALLY_CALCULATED' : 'BLOCKED',
    payoffComplete ? [] : ['SOCCER_INPUT_SCENARIO_PAYOFF_INCOMPLETE']));
  const candidate = { artifactHash: research.artifactHash, protocolHash: research.protocolHash,
    modelArtifactHash: proof.modelArtifactHash, halfTimeArtifactHash: proof.halfTimeArtifactHash,
    baselineParametersHash: quote.period === 'FT' ? proof.baselineParametersHash : proof.halfTimeParametersHash,
    baselineDistributionHash: hash(distribution), scenariosHash: period.scenariosHash, attempted: period.attempted,
    count: period.count, failed: period.failed, weightsRenormalized: false, baseline: baseline.status === 'CONDITIONAL_RESEARCH'
      ? { expectedNetReturn: baseline.exactNetReturn, netReturnBounds: baseline.netReturnBounds } : null,
    rows, rowsHash: hash(rows), modelError: null, validationEvidence: validationEvidenceBasis(proof, game, now),
    sourceStatus: 'RECOMPUTED_FROZEN_RESEARCH_PARAMETERS_PUBLICATION_AND_APPLICABILITY_UNVERIFIED',
    errorStatus: 'TOTAL_MODEL_ERROR_NOT_VALIDATED', ...restrictions };
  return { runtimeInputs: { scenarios: payoffComplete ? period.scenarios : null, uncertainty: null, acceptance: null }, inputBundle,
    preparation: { ...base, status: payoffComplete ? 'RESEARCH_INPUTS_PREPARED' : 'INPUTS_UNAVAILABLE',
      runtimeAuthorityResolved: false, stages, blockers: [...new Set(blockers)], research: candidate,
      interpretation: 'BOUND_CANDIDATE_FOR_INDEPENDENT_VALIDATION_NOT_ADOPTED_MODEL_OR_FORMAL_SCORING_AUTHORITY' } };
}
