import Decimal from 'decimal.js';
import { analyzeSoccerConditionalQuote } from './conditional-analysis.js';
import { adaptSoccerReaderQuote, soccerScoringHash } from './soccer-scoring.js';
import { buildSoccerScenarioResearch } from './scenario-research.js';
import { soccerResearchArtifacts } from './research-frozen.js';
import { soccerHalfTimeArtifacts } from './half-time-frozen.js';
import { predictScoreModel } from './score-model.js';
import { predictHalfTimeDistribution } from './half-time-model.js';
import { deterministicScore, scoreBoundaryAudit, SCORE_FORMULA_VERSION } from '../deterministic-score.js';

export const SOCCER_PREDICTION_SCORE_VERSION = 'SOCCER-MODEL-PREDICTION-SCORE-v1';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const hash = soccerScoringHash;
const Quantile = Decimal.clone({ precision: 400 });
const restrictions = Object.freeze({ mode: 'PREDICTION', accepted: false, formalEligible: false, formalScoringEnabled: false,
  executable: false, totalModelError: null, modelErrorMargin: null, modelValidation: 'UNVERIFIED',
  RInterpretation: 'MODEL_PARAMETER_Q10_STRESS_NOT_TOTAL_ERROR_ADJUSTED_R' });
const proofs = new WeakMap();
const computedRowCache = new Map();
const outward = (value, upper) => {
  if (!finite(value)) return NaN;
  if (value === 0) return upper ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + ((value > 0) === upper ? 1n : -1n));
  return view.getFloat64(0);
};
const interval = value => finite(value?.lower) && finite(value?.upper) && value.lower <= value.upper;
const fail = reason => ({ version: SOCCER_PREDICTION_SCORE_VERSION, ...restrictions,
  ok: false, status: 'PREDICTION_SCORE_UNAVAILABLE', reason, score: null, S: null,
  W: null, R: null, R_model: null, eligiblePrediction: false });

function quantile(rows, endpoint) {
  const threshold = rows.reduce((sum, row) => sum.plus(row.weight), new Quantile(0)).times('.1');
  let mass = new Quantile(0);
  for (const row of [...rows].sort((a, b) => a[endpoint] - b[endpoint] || a.id.localeCompare(b.id))) {
    mass = mass.plus(row.weight);
    if (mass.gte(threshold)) return row[endpoint];
  }
  return NaN;
}

/** Pure forecast arithmetic, NOT quote/identity/publication authority. Manual
 * hypotheses may reuse this calculation, but cannot become Reader candidates.
 * No unknown total-error margin is replaced by zero. R_model is only the
 * existing fixed-parameter-family q10 stress return, as explicitly authorized
 * for the prediction mode. It is not a validated total-model-error bound. */
export function summarizeSoccerPredictionReturns({ rows, expectedCount = rows?.length } = {}) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 1000
    || rows.length !== expectedCount) return fail('PREDICTION_COMPLETE_SCENARIOS_REQUIRED');
  const ids = new Set(); let mass = new Quantile(0);
  for (const row of rows) {
    if (typeof row?.id !== 'string' || !row.id || ids.has(row.id) || !finite(row.weight) || row.weight <= 0
      || !interval(row)) return fail('PREDICTION_SCENARIO_INTERVAL_OR_WEIGHT_INVALID');
    ids.add(row.id); mass = mass.plus(row.weight);
  }
  // Frozen scenarios have exactly sixteen weights of 1/16. Do not normalize a
  // missing or corrupted scenario set, or invent the absent scenario returns.
  if (!mass.eq(1)) return fail('PREDICTION_SCENARIO_WEIGHT_MASS_INVALID');
  const endpoint = key => rows.reduce((sum, row) =>
    outward(sum + outward(row.weight * row[key], key === 'upper'), key === 'upper'), 0);
  const WBounds = { lower: endpoint('lower'), upper: endpoint('upper') };
  const q10Bounds = { lower: quantile(rows, 'lower'), upper: quantile(rows, 'upper') };
  const RBounds = { lower: Math.min(WBounds.lower, q10Bounds.lower), upper: Math.min(WBounds.upper, q10Bounds.upper) };
  if (![WBounds, q10Bounds, RBounds].every(interval)) return fail('PREDICTION_BOUND_ARITHMETIC_INVALID');
  const formula = (W, R) => deterministicScore({ weightedEV: W, robustEV: R,
    actualWater: true, qaPassed: true, executable: false });
  const lower = formula(WBounds.lower, RBounds.lower), upper = formula(WBounds.upper, RBounds.upper);
  if (![lower, upper].every(value => finite(value.score))
    || !scoreBoundaryAudit(lower, { weightedEV: WBounds.lower, robustEV: RBounds.lower }).ok
    || !scoreBoundaryAudit(upper, { weightedEV: WBounds.upper, robustEV: RBounds.upper }).ok)
    return fail('PREDICTION_FIXED_FORMULA_INTEGRITY_FAILED');
  const W = WBounds.lower, R = RBounds.lower, score = lower.score;
  return { version: SOCCER_PREDICTION_SCORE_VERSION, ...restrictions, ok: true,
    status: 'PREDICTION_RETURN_SUMMARY_AVAILABLE', score, S: score, W, R, R_model: R,
    WPercent: W * 100, RPercent: R * 100, WBounds, RBounds, q10Bounds,
    scoreBounds: { lower: lower.score, upper: upper.score }, scoreFormulaVersion: SCORE_FORMULA_VERSION,
    scoreBasis: 'LOWER_ENDPOINT_OF_PAYOFF_ENCLOSURE_NOT_MIDPOINT',
    eligiblePrediction: score >= 7.2 && W > 0 && R > 0, scenarioCount: rows.length,
    weightSum: mass.toNumber(), weightsRenormalized: false,
    aggregation: 'WEIGHTED_MEAN_AND_WEIGHTED_CDF_GE_0_10_MODEL_STRESS',
    formula: { version: lower.formulaVersion, policyVersion: lower.policyVersion, band: lower.band, caps: lower.caps },
  };
}

function trustedResearch(research, game, now) {
  if (!research || typeof research !== 'object') throw Error('PREDICTION_SCENARIOS_UNAVAILABLE');
  const gameHash = hash(game), researchHash = hash(research), cached = proofs.get(research);
  if (cached?.gameHash === gameHash && cached.now === now && cached.researchHash === researchHash) return cached;
  const expected = buildSoccerScenarioResearch({ game, now });
  if (expected.status !== 'RESEARCH_ONLY' || !sha(expected.artifactHash) || !sha(expected.protocolHash)
    || hash(expected) !== researchHash) throw Error('PREDICTION_FROZEN_SCENARIOS_MISMATCH');
  const full = soccerResearchArtifacts(), half = soccerHalfTimeArtifacts();
  const model = full.leagues?.[game.league]?.liveModel, halfModel = half.leagues?.[game.league]?.liveModel;
  const ft = { ...predictScoreModel(model, { league: game.league, startTime: game.startTime,
    homeId: game.home.sourceId, awayId: game.away.sourceId, neutralSite: game.neutralSite }), league: game.league, gameId: game.id };
  const ht = { ...predictHalfTimeDistribution(ft, halfModel, { league: game.league, startTime: game.startTime }),
    league: game.league, gameId: game.id };
  const result = { gameHash, now, researchHash, research: expected, baselineHashes: { FT: hash(ft), HT: hash(ht) },
    modelArtifactHash: full.contentHash, halfTimeArtifactHash: half.contentHash };
  proofs.set(research, result); return result;
}

function sourceContextValid(evidence, game, now) {
  return evidence?.ok === true && evidence.phase === 'PREMATCH_OBSERVATION'
    && evidence.game?.id === game?.id && evidence.game.league === game.league
    && evidence.game.startTime === game.startTime
    && ['home', 'away'].every(side => evidence.game[side]?.sourceId === game[side]?.sourceId)
    && sha(evidence.source?.contentHash) && finite(instant(evidence.source?.fetchedAt))
    && instant(evidence.source.fetchedAt) <= now && now - instant(evidence.source.fetchedAt) <= 180000;
}
const quoteDescriptor = quote => ({ period: quote.period, kind: quote.kind, direction: quote.side.toUpperCase(),
  sourceLine: quote.line, lineSide: quote.lineSide ?? null, water: quote.water, unit: 'GOALS' });
const unappliedInputs = ['MATCH_NPXG', 'PERSONNEL_GOAL_EFFECT', 'WEATHER_TRAVEL_GOAL_EFFECT', 'ACCEPTED_PROBABILITY_CALIBRATION', 'VALIDATED_TOTAL_MODEL_ERROR'];
const inputMetadata = ({ distribution, game, quote, research, proof }) => [
  { kind: 'HISTORICAL_SCORE_MODEL', modelVersion: distribution.modelVersion, trainingHash: distribution.trainingHash,
    artifactHash: proof.modelArtifactHash, halfTimeArtifactHash: quote.period === 'HT' ? proof.halfTimeArtifactHash : null },
  { kind: 'HOME_AWAY_TEAM_IDENTITY', homeId: game.home.sourceId, awayId: game.away.sourceId, neutralSite: game.neutralSite ?? false },
  { kind: 'ORIGINAL_READER_QUOTE', quoteKey: quote.key, observedAt: quote.provenance.observedAt },
  { kind: 'FROZEN_PARAMETER_SCENARIOS', count: 16, artifactHash: research.artifactHash, protocolHash: research.protocolHash },
];

function sourceRecomputedRows({ quote, game, evidence, distribution, research, proof, ruleBinding, now }) {
  const cacheKey = hash({ version: SOCCER_PREDICTION_SCORE_VERSION, gameHash: proof.gameHash,
    researchHash: proof.researchHash, distributionHash: hash(distribution), quoteKey: quote.key,
    evidenceHash: evidence.source.contentHash, evidenceFetchedAt: evidence.source.fetchedAt,
    ruleBindingHash: ruleBinding.bindingHash, now });
  const cached = computedRowCache.get(cacheKey);
  if (cached) return cached.map(row => ({ ...row }));
  const rows = [];
  for (const scenario of research.periods[quote.period].scenarios) {
    const result = analyzeSoccerConditionalQuote({ quote, distribution: scenario.distribution, game, now });
    if (result.status !== 'CONDITIONAL_RESEARCH') throw Error(result.reason || 'PREDICTION_SCENARIO_RETURN_UNAVAILABLE');
    const certificate = result.certifiedDifferencePayoff;
    const certified = quote.kind === 'HANDICAP' && certificate?.status === 'CERTIFIED_NUMERICAL_MODEL_LAW_INTERVAL'
      && certificate.sourceVerification === 'RECOMPUTED_GENERATOR_PMF_AND_COMPLETE_RECTANGLE'
      && certificate.infiniteSeriesRemainderIncluded === true && certificate.arithmeticRoundingIncluded === true;
    const bounds = certified ? certificate.evBounds?.net : result.netReturnBounds;
    if (!interval(bounds)) throw Error('PREDICTION_SCENARIO_RETURN_BOUNDS_INVALID');
    rows.push({ id: scenario.id, weight: scenario.weight, lower: bounds.lower, upper: bounds.upper,
      distributionHash: result.distributionHash, sourceManifestHash: scenario.sourceEvidence.sourceManifestHash,
      arithmetic: certified ? 'CERTIFIED_INFINITE_SCORE_DIFFERENCE_ENCLOSURE' : 'FULL_GRID_AND_OMITTED_SCORE_PAYOFF_BOUNDS',
      unresolvedTailMass: result.unresolvedTailMass,
      certificateHash: certified ? hash(certificate) : null });
  }
  // Only source-recomputed data can populate this bounded private cache. A
  // returned DTO never aliases the cached objects and cannot poison later
  // validation by changing a displayed payoff or recalculating public hashes.
  const frozen = Object.freeze(rows.map(row => Object.freeze({ ...row })));
  computedRowCache.set(cacheKey, frozen);
  while (computedRowCache.size > 256) computedRowCache.delete(computedRowCache.keys().next().value);
  return rows;
}

/** Fresh Reader forecasts. All source/scope/mathematical gates remain in place;
 * npxG, personnel-effect, calibration and empirical total-error acceptance are
 * disclosed omissions rather than mandatory forecast-admission gates. */
export function calculateSoccerPredictionScore({ quote, distribution, game, evidence, research,
  now = Date.now() } = {}) {
  const adapted = adaptSoccerReaderQuote({ quote, game, now });
  if (!adapted.ok) return fail(adapted.code);
  if (!sourceContextValid(evidence, game, now)) return fail('PREDICTION_SOURCE_CONTEXT_INVALID');
  let proof;
  try { proof = trustedResearch(research, game, now); }
  catch (error) { return fail(error.message); }
  if (proof.baselineHashes[quote.period] !== hash(distribution)) return fail('PREDICTION_BASELINE_DISTRIBUTION_MISMATCH');
  const period = research.periods?.[quote.period];
  if (period?.status !== 'RESEARCH_SCENARIOS_AVAILABLE' || period.failed !== 0 || period.weightsRenormalized !== false
    || !Array.isArray(period.scenarios) || period.scenarios.length !== period.attempted
    || period.count !== period.attempted || period.attempted !== 16)
    return fail('PREDICTION_COMPLETE_SCENARIOS_REQUIRED');
  const baseline = analyzeSoccerConditionalQuote({ quote, distribution, game, now });
  if (baseline.status !== 'CONDITIONAL_RESEARCH' || baseline.ruleBinding?.status !== 'ARITHMETIC_BOUND')
    return fail(baseline.reason || baseline.ruleBinding?.reason || 'PREDICTION_CALCULATION_RULE_UNBOUND');
  let rows;
  try { rows = sourceRecomputedRows({ quote, distribution, game, evidence, research, proof, ruleBinding: baseline.ruleBinding, now }); }
  catch (error) { return fail(error.message); }
  const summary = summarizeSoccerPredictionReturns({ rows, expectedCount: period.attempted });
  if (!summary.ok) return summary;
  const validUntil = Math.min(instant(quote.provenance.observedAt) + 180000,
    instant(evidence.source.fetchedAt) + 180000, instant(game.startTime));
  if (!(now < validUntil)) return fail('PREDICTION_SOURCE_OR_QUOTE_EXPIRED');
  const body = { ...summary, status: 'PREDICTION_SCORE_AVAILABLE', reason: null,
    gameId: game.id, league: game.league, period: quote.period, sourceQuoteKey: quote.key,
    quote: quoteDescriptor(quote), calculatedAt: new Date(now).toISOString(),
    scenarioRows: rows, scenariosHash: hash(rows),
    inputsUsed: inputMetadata({ distribution, game, quote, research, proof }),
    inputsNotApplied: [...unappliedInputs],
    provenance: { distributionHash: hash(distribution), quoteHash: quote.key,
      scenarioArtifactHash: research.artifactHash, protocolHash: research.protocolHash,
      researchHash: proof.researchHash, evidenceHash: evidence.source.contentHash,
      evidenceFetchedAt: evidence.source.fetchedAt, calculatedAt: new Date(now).toISOString(),
      validUntil: new Date(validUntil).toISOString(),
      ruleBindingHash: baseline.ruleBinding.bindingHash, modelValidation: 'UNVERIFIED',
      source: 'READER', identityAuthority: 'REQUIRES_SERVER_PERSISTED_CURRENT_READER_PUBLICATION' },
    limitations: ['This is a model-only prediction using available historical scores and frozen parameter scenarios.',
      'R_model is q10 parameter stress, not a calibrated total conditional expected-return error bound.',
      'No missing npxG, personnel impact, conditions effect or full error margin is imputed as zero or accepted.',
      'Prediction ranking requires independent current server publication and fresh original Reader evidence.'],
  };
  return { ...body, contentHash: hash(body) };
}

/** Integrity/context check only, not database/source/publication authority.
 * Rehashed caller JSON is not a server saved-analysis receipt. The publishing
 * service must separately authenticate immutable DB payload and current Reader
 * identity/head/source versions. Use the saved cutoff when validating history,
 * then independently apply current freshness and kickoff checks. */
export function validateSoccerPredictionScore(prediction, { quote, distribution, game, evidence, research,
  now = Date.now() } = {}) {
  const bad = reason => ({ ok: false, reason, authority: 'MATH_CONTEXT_ONLY_REQUIRES_IMMUTABLE_SERVER_PAYLOAD' });
  if (!prediction || prediction.version !== SOCCER_PREDICTION_SCORE_VERSION || prediction.status !== 'PREDICTION_SCORE_AVAILABLE'
    || prediction.mode !== 'PREDICTION' || prediction.formalEligible !== false || prediction.formalScoringEnabled !== false
    || prediction.executable !== false || prediction.accepted !== false || prediction.totalModelError !== null || prediction.modelErrorMargin !== null
    || prediction.modelValidation !== 'UNVERIFIED' || prediction.RInterpretation !== restrictions.RInterpretation)
    return bad('PREDICTION_METADATA_INVALID');
  const { contentHash, ...body } = prediction;
  if (!sha(contentHash) || hash(body) !== contentHash) return bad('PREDICTION_CONTENT_HASH_INVALID');
  const adapted = adaptSoccerReaderQuote({ quote, game, now });
  if (!adapted.ok || !sourceContextValid(evidence, game, now)) return bad(adapted.code || 'PREDICTION_SOURCE_CONTEXT_INVALID');
  const clock = instant(prediction.provenance?.calculatedAt), until = instant(prediction.provenance?.validUntil);
  if (!finite(clock) || !finite(until) || clock > now || now >= until
    || prediction.calculatedAt !== prediction.provenance.calculatedAt || prediction.gameId !== game.id
    || prediction.league !== game.league || prediction.period !== quote.period || prediction.sourceQuoteKey !== quote.key
    || hash(prediction.quote) !== hash(quoteDescriptor(quote)) || prediction.provenance.quoteHash !== quote.key
    || prediction.provenance.distributionHash !== hash(distribution) || prediction.provenance.evidenceHash !== evidence.source.contentHash
    || prediction.provenance.evidenceFetchedAt !== evidence.source.fetchedAt
    || until !== Math.min(instant(quote.provenance.observedAt) + 180000, instant(evidence.source.fetchedAt) + 180000, instant(game.startTime)))
    return bad('PREDICTION_CONTEXT_OR_FRESHNESS_INVALID');
  let proof;
  try { proof = trustedResearch(research || buildSoccerScenarioResearch({ game, now: clock }), game, clock); }
  catch { return bad('PREDICTION_FROZEN_SCENARIOS_MISMATCH'); }
  if (proof.baselineHashes[quote.period] !== hash(distribution) || prediction.provenance.researchHash !== proof.researchHash)
    return bad('PREDICTION_BASELINE_DISTRIBUTION_MISMATCH');
  const rule = analyzeSoccerConditionalQuote({ quote, distribution, game, now: clock }).ruleBinding;
  if (rule?.status !== 'ARITHMETIC_BOUND' || prediction.provenance.ruleBindingHash !== rule.bindingHash)
    return bad('PREDICTION_CALCULATION_RULE_BINDING_CHANGED');
  if (prediction.provenance.scenarioArtifactHash !== proof.research.artifactHash
    || prediction.provenance.protocolHash !== proof.research.protocolHash
    || hash(prediction.inputsUsed) !== hash(inputMetadata({ distribution, game, quote, research: proof.research, proof }))
    || hash(prediction.inputsNotApplied) !== hash(unappliedInputs)) return bad('PREDICTION_INPUT_DISCLOSURE_OR_ARTIFACT_INVALID');
  const expectedRows = new Map(proof.research.periods[quote.period].scenarios.map(row => [row.id, row]));
  if (!Array.isArray(prediction.scenarioRows) || prediction.scenarioRows.length !== 16 || prediction.scenarioRows.some(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
    const expected = expectedRows.get(row.id);
    return !expected || row.weight !== expected.weight || row.distributionHash !== hash(expected.distribution)
      || row.sourceManifestHash !== expected.sourceEvidence.sourceManifestHash;
  })) return bad('PREDICTION_SCENARIO_SOURCE_BINDING_CHANGED');
  let recomputed;
  try { recomputed = sourceRecomputedRows({ quote, distribution, game, evidence, research: proof.research,
    proof, ruleBinding: rule, now: clock }); }
  catch { return bad('PREDICTION_SCENARIO_RETURN_RECOMPUTE_FAILED'); }
  if (hash(prediction.scenarioRows) !== hash(recomputed)) return bad('PREDICTION_SCENARIO_PAYOFF_CHANGED');
  const summary = summarizeSoccerPredictionReturns({ rows: prediction.scenarioRows, expectedCount: 16 });
  if (!summary.ok || prediction.scenariosHash !== hash(prediction.scenarioRows)
    || ['score', 'S', 'W', 'R', 'R_model', 'WPercent', 'RPercent', 'eligiblePrediction', 'scenarioCount', 'scoreFormulaVersion']
      .some(key => prediction[key] !== summary[key])
    || ['WBounds', 'RBounds', 'q10Bounds', 'scoreBounds', 'formula'].some(key => hash(prediction[key]) !== hash(summary[key]))
    || prediction.weightsRenormalized !== false || prediction.weightSum !== summary.weightSum
    || prediction.aggregation !== summary.aggregation || prediction.scoreBasis !== summary.scoreBasis)
    return bad('PREDICTION_FIXED_FORMULA_OR_RETURNS_INVALID');
  return { ok: true, reason: null, authority: 'MATH_CONTEXT_ONLY_REQUIRES_IMMUTABLE_SERVER_PAYLOAD' };
}
